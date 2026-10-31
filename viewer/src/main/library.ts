import { DatabaseSync } from "node:sqlite";
import { mkdirSync, realpathSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { constants } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { randomUUID } from "node:crypto";
import { checksum, MediaTools } from "./media.ts";
import type {
  BatchResult,
  Folder,
  Media,
  MediaQuery,
  MediaPage,
  MediaSummary,
  MediaPatch,
  Settings,
  Snapshot,
} from "../shared/types.ts";

type Stored = Omit<Media, "url" | "thumbnail"> & { path: string; hash: string };
type Pending = { id: string; kind: string; payload: string };
export const safeName = (name: string) => {
  if (
    !name ||
    name.length > 180 ||
    name !== basename(name) ||
    /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(name) ||
    name === "." ||
    name === ".."
  )
    throw new Error(
      "Choose a valid filename without path separators or reserved characters.",
    );
  return name;
};
export const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return (
    part === "" ||
    (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part))
  );
};

export class Library {
  db: DatabaseSync;
  root: string;
  cache: string;
  tools: MediaTools;
  changed: () => void;
  busy = false;
  constructor(root: string, ocrPath: string, changed = () => {}) {
    mkdirSync(resolve(root), { recursive: true });
    this.root = realpathSync(resolve(root));
    this.cache = join(this.root, "data", "thumbnails");
    this.changed = changed;
    mkdirSync(this.cache, { recursive: true });
    this.tools = new MediaTools(ocrPath);
    this.db = new DatabaseSync(join(this.root, "data", "camviewer.sqlite"));
    this.db.function("text_fold", { deterministic: true }, (value) =>
      String(value ?? "").toLocaleLowerCase(),
    );
    this.db.function("name_key", { deterministic: true }, (value) =>
      String(value ?? "")
        .toLocaleLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\d+/g, (digits) =>
          digits.replace(/^0+(?=\d)/, "").padStart(24, "0"),
        ),
    );
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, message TEXT NOT NULL, payload TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS media_state ON media(json_extract(data,'$.state'));
      CREATE INDEX IF NOT EXISTS media_folder ON media(json_extract(data,'$.state'),json_extract(data,'$.folderId'));
      CREATE INDEX IF NOT EXISTS media_date ON media(json_extract(data,'$.state'),json_extract(data,'$.captureDate'),id);
      CREATE INDEX IF NOT EXISTS media_imported ON media(json_extract(data,'$.state'),json_extract(data,'$.importedAt'),id);
      CREATE INDEX IF NOT EXISTS media_name ON media(json_extract(data,'$.state'),name_key(json_extract(data,'$.name')),id);
      PRAGMA user_version=1;`);
    const defaults: Settings = {
      importPath: join(this.root, "in"),
      processedPath: join(this.root, "out"),
      galleryPath: join(this.root, "files"),
      thumbnailSize: 180,
      defaultSort: "date",
      display: { pageHeading: true, toolbar: true, statusbar: true },
      pageSize: 60,
      overlayEnabled: false,
      dateOrder: "DMY",
      utcOffsetMinutes: 0,
      crop: { x: 0.53, y: 0.925, width: 0.42, height: 0.075 },
      motion: {
        sensitivity: 55,
        padding: 10,
        border: 2,
        color: "#e64b45",
        fill: "#e64b45",
        opacity: 0.1,
      },
    };
    this.db
      .prepare("INSERT OR IGNORE INTO settings VALUES (1, ?)")
      .run(JSON.stringify(defaults));
    this.db
      .prepare("INSERT OR IGNORE INTO folders VALUES (?, ?)")
      .run(
        "root",
        JSON.stringify({ id: "root", name: "All files", relativePath: "" }),
      );
  }
  settings(): Settings {
    const stored = JSON.parse(
      (
        this.db.prepare("SELECT data FROM settings WHERE id=1").get() as {
          data: string;
        }
      ).data,
    ) as Settings;
    return {
      ...stored,
      defaultSort: stored.defaultSort ?? "date",
      display: {
        pageHeading: stored.display?.pageHeading ?? true,
        toolbar: stored.display?.toolbar ?? true,
        statusbar: stored.display?.statusbar ?? true,
      },
    };
  }
  rows(): Stored[] {
    return (
      this.db.prepare("SELECT data FROM media").all() as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  folders(): Folder[] {
    return (
      this.db.prepare("SELECT data FROM folders").all() as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  get(id: string): Stored {
    const row = this.db.prepare("SELECT data FROM media WHERE id=?").get(id) as
      { data: string } | undefined;
    if (!row) throw new Error("File no longer exists in the library.");
    return JSON.parse(row.data);
  }
  put(row: Stored) {
    this.db
      .prepare("INSERT OR REPLACE INTO media VALUES (?, ?)")
      .run(row.id, JSON.stringify(row));
  }
  queryParts(query: MediaQuery) {
    const filters: string[] = [];
    const values: string[] = [];
    const field = (name: string) => `json_extract(data,'$.${name}')`;
    if (query.state) {
      filters.push(`${field("state")}=?`);
      values.push(query.state);
    }
    if (query.folderId && (query.folderId !== "root" || query.exactFolder)) {
      filters.push(`${field("folderId")}=?`);
      values.push(query.folderId);
    }
    if (query.kind && query.kind !== "all") {
      filters.push(`${field("kind")}=?`);
      values.push(query.kind);
    }
    for (const [date, operator] of [
      [query.from, ">="],
      [query.to, "<="],
    ]) {
      if (date) {
        filters.push(`substr(${field("captureDate")},1,10)${operator}?`);
        values.push(date);
      }
    }
    if (query.search) {
      filters.push(
        `instr(text_fold(${field("name")} || ' ' || coalesce((SELECT group_concat(value,' ') FROM json_each(data,'$.tags')),'') || ' ' || ${field("metadata")} || ' ' || coalesce(${field("captureDate")},'')),text_fold(?))>0`,
      );
      values.push(query.search);
    }
    const order =
      query.sort === "name"
        ? `name_key(${field("name")}) ASC`
        : query.sort === "tag"
          ? `coalesce((SELECT value FROM json_each(data,'$.tags') ORDER BY value COLLATE NOCASE LIMIT 1),char(65535)) COLLATE NOCASE ASC`
          : query.sort === "imported"
            ? `${field("importedAt")} DESC`
            : `coalesce(${field("captureDate")},'') DESC`;
    return {
      where: filters.length ? `WHERE ${filters.join(" AND ")}` : "",
      values,
      order: `${order},id ASC`,
    };
  }
  query(query: MediaQuery = {}): MediaPage {
    const { where, values, order } = this.queryParts(query);
    const limit = Math.max(1, Math.min(240, Math.trunc(query.limit ?? 60)));
    const total = Number(
      this.db
        .prepare(`SELECT count(*) AS total FROM media ${where}`)
        .get(...values)!.total,
    );
    let offset = Math.min(
      Math.max(0, Math.trunc(query.offset ?? 0)),
      Math.max(0, Math.ceil(total / limit) - 1) * limit,
    );
    if (query.anchorId) {
      const anchor = this.db
        .prepare(
          `SELECT position FROM (SELECT id,row_number() OVER (ORDER BY ${order})-1 AS position FROM media ${where}) WHERE id=?`,
        )
        .get(...values, query.anchorId);
      if (anchor)
        offset = Math.max(0, Number(anchor.position) - Math.floor(limit / 2));
    }
    const rows = this.db
      .prepare(
        `SELECT json_object(
      'id',id,'name',json_extract(data,'$.name'),'kind',json_extract(data,'$.kind'),
      'state',json_extract(data,'$.state'),'folderId',json_extract(data,'$.folderId'),
      'size',json_extract(data,'$.size'),'width',json_extract(data,'$.width'),
      'height',json_extract(data,'$.height'),'duration',json_extract(data,'$.duration'),
      'captureDate',json_extract(data,'$.captureDate'),'dateSource',json_extract(data,'$.dateSource'),
      'tags',json_extract(data,'$.tags'),'importedAt',json_extract(data,'$.importedAt'),
      'hasWarnings',json_array_length(data,'$.warnings')>0) AS summary
      FROM media ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset) as { summary: string }[];
    return {
      total,
      offset,
      media: rows.map(({ summary }) => {
        const row = JSON.parse(summary) as MediaSummary;
        return {
          ...row,
          hasWarnings: !!row.hasWarnings,
          thumbnail: `cammedia://thumbnail/${row.id}`,
          url: `cammedia://file/${row.id}`,
        };
      }),
    };
  }
  matchingIds(query: MediaQuery, selectedIds?: string[]): string[] {
    const { where, values, order } = this.queryParts(query);
    const selection = selectedIds
      ? `${where ? " AND" : "WHERE"} id IN (SELECT value FROM json_each(?))`
      : "";
    return (
      this.db
        .prepare(`SELECT id FROM media ${where} ${selection} ORDER BY ${order}`)
        .all(
          ...values,
          ...(selectedIds ? [JSON.stringify(selectedIds)] : []),
        ) as { id: string }[]
    ).map((row) => row.id);
  }
  getMedia(id: string): Media {
    const { path, hash, ...row } = this.get(id);
    return {
      ...row,
      thumbnail: `cammedia://thumbnail/${id}`,
      url: `cammedia://file/${id}`,
    };
  }
  snapshot(query: MediaQuery = {}): Snapshot {
    return {
      ...this.query(query),
      counts: {
        gallery: Number(
          this.db
            .prepare(
              "SELECT count(*) AS total FROM media WHERE json_extract(data,'$.state')='gallery'",
            )
            .get()!.total,
        ),
        review: Number(
          this.db
            .prepare(
              "SELECT count(*) AS total FROM media WHERE json_extract(data,'$.state')='review'",
            )
            .get()!.total,
        ),
      },
      workspace: this.root,
      settings: this.settings(),
      folders: this.folders(),
      jobs: this.db
        .prepare(
          "SELECT id,kind,state,message,createdAt FROM jobs ORDER BY createdAt DESC LIMIT 50",
        )
        .all() as unknown as Snapshot["jobs"],
    };
  }
  async initialize() {
    const settings = this.settings();
    await this.validateRoots(settings);
    this.db
      .prepare("UPDATE settings SET data=? WHERE id=1")
      .run(JSON.stringify(settings));
    await this.recover();
  }
  async validateRoots(settings: Settings) {
    const paths = [
      settings.importPath,
      settings.processedPath,
      settings.galleryPath,
    ];
    const canonical: string[] = [];
    for (const path of paths) {
      if (!isAbsolute(path))
        throw new Error("Storage directories must be absolute paths.");
      await mkdir(path, { recursive: true });
      canonical.push(await realpath(path));
    }
    for (let index = 0; index < canonical.length; index++) {
      const path = canonical[index];
      if (
        inside(path, join(this.root, "data")) ||
        inside(join(this.root, "data"), path) ||
        inside(path, join(this.root, "viewer"))
      )
        throw new Error(
          "Storage must not contain application code or the database.",
        );
      for (let other = index + 1; other < canonical.length; other++)
        if (inside(path, canonical[other]) || inside(canonical[other], path))
          throw new Error(
            "Import, processed and gallery directories must be separate, not nested.",
          );
    }
    [settings.importPath, settings.processedPath, settings.galleryPath] =
      canonical;
  }
  async saveSettings(value: Settings) {
    if (this.busy)
      throw new Error(
        "Wait for the current operation before changing storage.",
      );
    if (
      !Number.isFinite(value.thumbnailSize) ||
      !["date", "name", "tag", "imported"].includes(value.defaultSort) ||
      !value.display ||
      ![
        value.display.pageHeading,
        value.display.toolbar,
        value.display.statusbar,
      ].every((flag) => typeof flag === "boolean") ||
      value.thumbnailSize < 100 ||
      value.thumbnailSize > 320 ||
      !Number.isInteger(value.pageSize) ||
      value.pageSize < 12 ||
      value.pageSize > 240 ||
      typeof value.overlayEnabled !== "boolean" ||
      !["DMY", "MDY", "YMD"].includes(value.dateOrder) ||
      !Number.isInteger(value.utcOffsetMinutes) ||
      Math.abs(value.utcOffsetMinutes) > 840
    )
      throw new Error("Invalid settings values.");
    const crop = value.crop;
    if (
      ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) ||
      crop.x < 0 ||
      crop.y < 0 ||
      crop.width <= 0 ||
      crop.height <= 0 ||
      crop.x + crop.width > 1 ||
      crop.y + crop.height > 1
    )
      throw new Error("Overlay crop must fit within the image.");
    const motion = value.motion;
    if (
      !motion ||
      !Number.isFinite(motion.sensitivity) ||
      motion.sensitivity < 0 ||
      motion.sensitivity > 100 ||
      !Number.isFinite(motion.padding) ||
      motion.padding < 0 ||
      motion.padding > 40 ||
      !Number.isFinite(motion.border) ||
      motion.border < 1 ||
      motion.border > 8 ||
      !Number.isFinite(motion.opacity) ||
      motion.opacity < 0 ||
      motion.opacity > 0.5 ||
      !/^#[\da-f]{6}$/i.test(motion.color) ||
      !/^#[\da-f]{6}$/i.test(motion.fill)
    )
      throw new Error("Invalid motion settings.");
    await this.validateRoots(value);
    const before = this.settings();
    if (
      this.rows().length &&
      (before.galleryPath !== value.galleryPath ||
        before.processedPath !== value.processedPath)
    )
      throw new Error(
        "Move or remove library/review files before changing those storage roots. Existing media will not be migrated silently.",
      );
    this.db
      .prepare("UPDATE settings SET data=? WHERE id=1")
      .run(JSON.stringify(value));
    this.changed();
  }
  job(kind: string, payload: unknown, message: string) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?)")
      .run(
        id,
        kind,
        "running",
        message,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
    this.changed();
    return id;
  }
  finish(id: string, state: string, message: string) {
    this.db
      .prepare("UPDATE jobs SET state=?,message=? WHERE id=?")
      .run(state, message, id);
    this.changed();
  }
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy)
      throw new Error("Another file operation is running. Please wait.");
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async unique(directory: string, name: string) {
    safeName(name);
    await mkdir(directory, { recursive: true });
    const extension = extname(name);
    const stem = basename(name, extension);
    let candidate = join(directory, name);
    let suffix = 2;
    while (
      await stat(candidate).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      )
    )
      candidate = join(directory, `${stem}-${suffix++}${extension}`);
    return candidate;
  }
  async copyVerified(source: string, destination: string) {
    const sourceInfo = await stat(source);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    try {
      if ((await checksum(source)) !== (await checksum(destination)))
        throw new Error("Copied file failed integrity verification.");
      await utimes(destination, sourceInfo.atime, sourceInfo.mtime);
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
  }
  async authorizedPath(id: string): Promise<string> {
    const row = this.get(id);
    const settings = this.settings();
    const root =
      row.state === "gallery" ? settings.galleryPath : settings.processedPath;
    const path = await realpath(row.path);
    if (!inside(await realpath(root), path))
      throw new Error("File is outside its authorized storage root.");
    return path;
  }
  async importPaths(paths: string[]): Promise<BatchResult> {
    return this.exclusive(async () => {
      const result: BatchResult = { succeeded: [], errors: [] };
      for (const source of paths) {
        let jobId = "";
        let staged = "";
        const id = randomUUID();
        try {
          if (!(await stat(source)).isFile())
            throw new Error("Only regular files can be imported.");
          const settings = this.settings();
          const actual = await realpath(source);
          if (
            inside(await realpath(settings.galleryPath), actual) ||
            inside(await realpath(settings.processedPath), actual)
          )
            throw new Error(
              "Files already in gallery/review storage cannot be reimported.",
            );
          staged = await this.unique(settings.processedPath, basename(source));
          jobId = this.job(
            "import",
            { source, staged, id },
            `Processing ${basename(source)}`,
          );
          await this.copyVerified(actual, staged);
          const originalHash = await checksum(staged);
          const info = await this.tools.inspect(
            staged,
            join(this.cache, `${id}.jpg`),
            settings,
          );
          info.metadata.originalSha256 = originalHash;
          const row: Stored = {
            ...info,
            id,
            path: staged,
            hash: await checksum(staged),
            state: "review",
            folderId: "root",
            name: basename(staged),
            tags: [],
            importedAt: new Date().toISOString(),
          };
          this.put(row);
          if (inside(await realpath(settings.importPath), actual))
            await unlink(actual);
          this.finish(jobId, "completed", `Ready for review: ${row.name}`);
          result.succeeded.push(id);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (
            staged &&
            !this.db
              .prepare(
                "SELECT id FROM media WHERE json_extract(data,'$.path')=? LIMIT 1",
              )
              .get(staged)
          )
            await rm(staged, { force: true });
          if (jobId)
            this.finish(jobId, "failed", `${basename(source)}: ${message}`);
          result.errors.push({ id: source, message });
        }
      }
      return result;
    });
  }
  async scan() {
    const files: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (
          entry.isFile() &&
          !entry.name.startsWith(".") &&
          !/\.part$|\.md$/i.test(entry.name)
        )
          files.push(path);
      }
    };
    await walk(this.settings().importPath);
    return this.importPaths(files);
  }
  async batch(
    ids: string[],
    action: (id: string) => Promise<void>,
  ): Promise<BatchResult> {
    return this.exclusive(async () => {
      const result: BatchResult = { succeeded: [], errors: [] };
      for (const id of [...new Set(ids)]) {
        try {
          await action(id);
          result.succeeded.push(id);
        } catch (error) {
          result.errors.push({
            id,
            message: String(error instanceof Error ? error.message : error),
          });
        }
      }
      return result;
    });
  }
  async move(
    id: string,
    destination: string,
    state: Media["state"],
    folderId: string,
  ) {
    const row = this.get(id);
    const source = await this.authorizedPath(id);
    const root =
      state === "gallery"
        ? this.settings().galleryPath
        : this.settings().processedPath;
    if (!inside(await realpath(root), await realpath(dirname(destination))))
      throw new Error("Destination escapes authorized storage.");
    if (
      await stat(destination).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      )
    )
      throw new Error("A file with that name already exists.");
    const updated = {
      ...row,
      name: basename(destination),
      path: destination,
      state,
      folderId,
    };
    const jobId = this.job(
      "move",
      { source, destination, updated },
      `Moving ${row.name}`,
    );
    try {
      await this.copyVerified(source, destination);
    } catch (error) {
      this.finish(jobId, "failed", String(error));
      throw error;
    }
    this.put(updated);
    await unlink(source);
    this.finish(jobId, "completed", `Moved ${updated.name}`);
  }
  async accept(ids: string[], folderId: string) {
    const folder = this.folders().find((item) => item.id === folderId);
    if (!folder) throw new Error("Destination folder not found.");
    return this.batch(ids, async (id) => {
      const row = this.get(id);
      if (row.state !== "review")
        throw new Error("Only reviewed files can be accepted.");
      const destination = await this.unique(
        join(this.settings().galleryPath, folder.relativePath),
        row.name,
      );
      await this.move(id, destination, "gallery", folderId);
    });
  }
  async rename(id: string, name: string) {
    return this.exclusive(async () => {
      const row = this.get(id);
      safeName(name);
      if (extname(name).toLowerCase() !== extname(row.name).toLowerCase())
        throw new Error("Keep the original file extension.");
      if (name === row.name) return;
      await this.move(
        id,
        join(dirname(await this.authorizedPath(id)), name),
        row.state,
        row.folderId,
      );
    });
  }
  async removeOne(id: string) {
    const row = this.get(id);
    await this.authorizedPath(id);
    const jobId = this.job(
      "delete",
      { id, path: row.path },
      `Deleting ${row.name}`,
    );
    await this.executeDelete(id, row.path);
    this.finish(jobId, "completed", `Deleted ${row.name}`);
  }
  async executeDelete(id: string, path: string) {
    await rm(path, { force: true });
    this.db.prepare("DELETE FROM media WHERE id=?").run(id);
    await rm(join(this.cache, `${id}.jpg`), { force: true });
  }
  async remove(ids: string[]) {
    return this.batch(ids, (id) => this.removeOne(id));
  }
  async exportFiles(ids: string[], directory: string) {
    const actual = await realpath(directory);
    const settings = this.settings();
    if (
      [
        settings.importPath,
        settings.processedPath,
        settings.galleryPath,
        join(this.root, "data"),
      ].some((root) => inside(root, actual) || inside(actual, root))
    )
      throw new Error(
        "Export to a separate directory outside application storage.",
      );
    return this.batch(ids, async (id) => {
      const row = this.get(id);
      const destination = await this.unique(actual, row.name);
      await this.copyVerified(await this.authorizedPath(id), destination);
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(
          `${destination}.camviewer.json`,
          JSON.stringify(
            {
              tags: row.tags,
              captureDate: row.captureDate,
              metadata: row.metadata,
            },
            null,
            2,
          ),
          { flag: "wx" },
        ),
      );
    });
  }
  async update(ids: string[], patch: MediaPatch) {
    if (this.busy) throw new Error("Wait for the current file operation.");
    if (
      patch.tags &&
      (!Array.isArray(patch.tags) ||
        patch.tags.length > 100 ||
        patch.tags.some((tag) => typeof tag !== "string" || tag.length > 100))
    )
      throw new Error("Invalid tag list.");
    if (
      patch.metadata &&
      (typeof patch.metadata !== "object" ||
        Array.isArray(patch.metadata) ||
        JSON.stringify(patch.metadata).length > 100_000)
    )
      throw new Error("Metadata must be a JSON object smaller than 100KB.");
    if (
      patch.captureDate !== undefined &&
      patch.captureDate !== null &&
      (typeof patch.captureDate !== "string" ||
        !Number.isFinite(Date.parse(patch.captureDate)))
    )
      throw new Error("Invalid capture date.");
    const rows = ids.map((id) => this.get(id));
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        if (patch.clear) {
          row.tags = [];
          row.captureDate = null;
          row.dateSource = "unknown";
          row.metadata = {};
        }
        if (patch.tags)
          row.tags = [
            ...new Set(patch.tags.map((tag) => tag.trim()).filter(Boolean)),
          ];
        if (patch.metadata) row.metadata = patch.metadata;
        if (patch.captureDate !== undefined) {
          row.captureDate = patch.captureDate;
          row.dateSource = patch.captureDate ? "manual" : "unknown";
        }
        this.put(row);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.changed();
  }
  async createFolder(name: string, parentId: string) {
    return this.exclusive(async () => {
      safeName(name);
      const parent = this.folders().find((folder) => folder.id === parentId);
      if (!parent) throw new Error("Parent folder not found.");
      const relativePath = join(parent.relativePath, name);
      const directory = join(this.settings().galleryPath, relativePath);
      if (
        !inside(
          await realpath(this.settings().galleryPath),
          await realpath(dirname(directory)),
        )
      )
        throw new Error("Folder destination escapes gallery storage.");
      await mkdir(directory);
      const folder: Folder = { id: randomUUID(), name, relativePath };
      this.db
        .prepare("INSERT INTO folders VALUES (?,?)")
        .run(folder.id, JSON.stringify(folder));
      this.changed();
    });
  }
  async renameFolder(id: string, name: string) {
    return this.exclusive(async () => {
      if (id === "root") throw new Error("The gallery root cannot be renamed.");
      safeName(name);
      const folders = this.folders();
      const folder = folders.find((item) => item.id === id);
      if (!folder) throw new Error("Folder not found.");
      const before = folder.relativePath;
      const after = join(dirname(before) === "." ? "" : dirname(before), name);
      const source = join(this.settings().galleryPath, before);
      const destination = join(this.settings().galleryPath, after);
      if (
        !inside(
          await realpath(this.settings().galleryPath),
          await realpath(source),
        ) ||
        !inside(
          await realpath(this.settings().galleryPath),
          await realpath(dirname(destination)),
        )
      )
        throw new Error("Folder escapes gallery storage.");
      if (source === destination) return;
      const payload = { source, destination, before, after, id, name };
      const jobId = this.job(
        "folder-rename",
        payload,
        `Renaming ${folder.name}`,
      );
      if (
        await stat(destination).then(
          () => true,
          () => false,
        )
      ) {
        this.finish(jobId, "failed", "A folder with that name already exists.");
        throw new Error("A folder with that name already exists.");
      }
      const fs = await import("node:fs/promises");
      await fs.rename(source, destination);
      this.finishFolderRename(payload);
      this.finish(jobId, "completed", `Renamed ${name}`);
    });
  }
  finishFolderRename(payload: {
    before: string;
    after: string;
    id: string;
    name: string;
  }) {
    const root = this.settings().galleryPath;
    this.db.exec("BEGIN");
    try {
      for (const folder of this.folders())
        if (inside(payload.before, folder.relativePath)) {
          folder.relativePath = join(
            payload.after,
            relative(payload.before, folder.relativePath),
          );
          if (folder.id === payload.id) folder.name = payload.name;
          this.db
            .prepare("UPDATE folders SET data=? WHERE id=?")
            .run(JSON.stringify(folder), folder.id);
        }
      for (const row of this.rows())
        if (
          row.state === "gallery" &&
          inside(join(root, payload.before), row.path)
        )
          this.put({
            ...row,
            path: join(
              root,
              payload.after,
              relative(join(root, payload.before), row.path),
            ),
          });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async removeFolder(id: string) {
    return this.exclusive(async () => {
      if (id === "root") throw new Error("The gallery root cannot be removed.");
      const folder = this.folders().find((item) => item.id === id);
      if (!folder) throw new Error("Folder not found.");
      const path = join(this.settings().galleryPath, folder.relativePath);
      if (
        !inside(
          await realpath(this.settings().galleryPath),
          await realpath(path),
        )
      )
        throw new Error("Folder escapes gallery storage.");
      const jobId = this.job(
        "folder-delete",
        { id, path, relativePath: folder.relativePath },
        `Deleting folder ${folder.name}`,
      );
      await this.finishFolderDelete(path, folder.relativePath);
      this.finish(jobId, "completed", `Deleted folder ${folder.name}`);
    });
  }
  async finishFolderDelete(path: string, relativePath: string) {
    await rm(path, { recursive: true, force: true });
    for (const row of this.rows())
      if (row.state === "gallery" && inside(path, row.path)) {
        this.db.prepare("DELETE FROM media WHERE id=?").run(row.id);
        await rm(join(this.cache, `${row.id}.jpg`), { force: true });
      }
    for (const folder of this.folders())
      if (folder.id !== "root" && inside(relativePath, folder.relativePath))
        this.db.prepare("DELETE FROM folders WHERE id=?").run(folder.id);
  }
  async recover() {
    for (const job of this.db
      .prepare("SELECT id,kind,payload FROM jobs WHERE state='running'")
      .all() as unknown as Pending[]) {
      const payload = JSON.parse(job.payload);
      try {
        if (job.kind === "move") {
          const valid = await stat(payload.destination).then(
            () => true,
            () => false,
          );
          if (!valid) {
            this.finish(
              job.id,
              "failed",
              "Interrupted move: original retained. Retry the operation.",
            );
            continue;
          }
          if ((await checksum(payload.destination)) !== payload.updated.hash)
            throw new Error(
              "Recovery destination checksum mismatch; original retained.",
            );
          this.put(payload.updated);
          await rm(payload.source, { force: true });
        } else if (job.kind === "delete")
          await this.executeDelete(payload.id, payload.path);
        else if (job.kind === "folder-delete")
          await this.finishFolderDelete(payload.path, payload.relativePath);
        else if (job.kind === "folder-rename") {
          if (
            await stat(payload.destination).then(
              () => true,
              () => false,
            )
          )
            this.finishFolderRename(payload);
          else
            throw new Error(
              "Folder rename interrupted before filesystem change.",
            );
        } else {
          if (!this.rows().some((row) => row.id === payload.id))
            await rm(payload.staged, { force: true });
          this.finish(
            job.id,
            "failed",
            "Import interrupted. Original retained; scan or import again.",
          );
          continue;
        }
        this.finish(job.id, "completed", "Recovered interrupted operation.");
      } catch (error) {
        this.finish(job.id, "failed", String(error));
      }
    }
  }
  async close() {
    await this.tools.close();
    this.db.close();
  }
}
