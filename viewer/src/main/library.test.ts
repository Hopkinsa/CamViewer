import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  mkdir,
  copyFile,
  symlink,
  stat,
  access,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { Library, inside, safeName } from "./library.ts";
import { parseOverlay, run, MediaTools, agreeOverlay } from "./media.ts";
import type { OverlayEvidence } from "./media.ts";

test("image OCR requires confident distinct variants without conflicting dates", () => {
  const date = "2026-10-16T17:37:29.000Z";
  const original = {
    offset: 0,
    variant: "original",
    text: "16/10/2026 17:37:29",
    confidence: 80,
    date,
  };
  const contrast = { ...original, variant: "contrast", confidence: 70 };
  assert.equal(agreeOverlay([original], "image"), null);
  assert.equal(agreeOverlay([original, original], "image"), null);
  assert.equal(agreeOverlay([original, contrast], "image"), date);
  assert.equal(
    agreeOverlay([original, { ...contrast, confidence: 59 }], "image"),
    null,
  );
  assert.equal(
    agreeOverlay(
      [
        original,
        contrast,
        { ...contrast, variant: "threshold", date: "2026-10-16T17:37:28.000Z" },
      ],
      "image",
    ),
    null,
  );
  assert.equal(
    agreeOverlay(
      [original, contrast, { ...contrast, confidence: 10, date: null }],
      "image",
    ),
    date,
  );
  assert.equal(
    agreeOverlay(
      [
        { ...original, date: "invalid" },
        { ...contrast, date: "invalid" },
      ],
      "image",
    ),
    null,
  );
  const future = new Date(Date.now() + 172800000).toISOString();
  assert.equal(
    agreeOverlay(
      [
        { ...original, date: future },
        { ...contrast, date: future },
      ],
      "image",
    ),
    null,
  );
  assert.equal(agreeOverlay([original, contrast], "video"), null);
  assert.equal(
    agreeOverlay([original, { ...contrast, offset: 1 }], "video"),
    date,
  );
});

test("OCR failures terminate owned workers and remove temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "camviewer-ocr-failure-"));
  const model = join(root, "model");
  const cache = join(root, "cache");
  await mkdir(model);
  await mkdir(cache);
  const library = new Library(join(root, "workspace"), model);
  const settings = library.settings();
  const ports = () =>
    process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "MessagePort").length;
  const baseline = ports();
  const tools = new MediaTools(model, {
    temporaryPath: cache,
    ocrTimeoutMillis: 5000,
  });
  const source = resolve("../Requirements/example_files/IMG_5587.JPG");
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(tools.ocr(source, "image", 0, settings), /ENOENT/);
      assert.deepEqual(await readdir(cache), []);
      assert.equal(ports(), baseline);
    }
    await library.initialize();
    await library.saveSettings({ ...settings, overlayEnabled: true });
    library.tools.temporaryPath = cache;
    const input = join(library.settings().importPath, "original.JPG");
    await copyFile(source, input);
    const imported = await library.importPaths([input]);
    assert.equal(imported.errors.length, 1);
    assert.deepEqual(imported.succeeded, []);
    await access(input);
    assert.deepEqual(await readFile(input), await readFile(source));
    assert.equal(library.snapshot().jobs[0].state, "failed");
    assert.deepEqual(await readdir(cache), []);
    assert.equal(ports(), baseline);
    await writeFile(join(model, "eng.traineddata"), Buffer.alloc(16));
    await assert.rejects(
      tools.ocr(source, "image", 0, settings),
      /initializ|language|load|traineddata/i,
    );
    assert.deepEqual(await readdir(cache), []);
    assert.equal(ports(), baseline);
    const validModel = resolve("../Requirements/application_src/camDate");
    tools.ocrPath = validModel;
    tools.ocrTimeoutMillis = 1;
    await assert.rejects(tools.ocr(source, "image", 0, settings), /timed out/);
    assert.deepEqual(await readdir(cache), []);
    assert.equal(ports(), baseline);
    tools.ocrTimeoutMillis = 5000;
    await assert.rejects(
      tools.ocr(join(root, "missing.jpg"), "image", 0, settings),
      /Input file is missing|ENOENT/,
    );
    assert.deepEqual(await readdir(cache), []);
    assert.equal(ports(), baseline);
  } finally {
    await tools.close();
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("media subprocess failures settle only after cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "camviewer-process-test-"));
  const pidPath = join(root, "pid");
  try {
    await assert.rejects(
      run(
        process.execPath,
        ["-e", "process.stderr.write('failed'); process.exit(2)"],
        1000,
      ),
      /failed/,
    );
    await assert.rejects(run(join(root, "missing-binary"), [], 1000), /ENOENT/);
    const stubborn = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
    const pending = run(process.execPath, ["-e", stubborn, pidPath], 1000);
    await assert.rejects(pending, /timed out/);
    const pid = Number(await readFile(pidPath, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    const excessive = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(process.argv[1], String(process.pid)); process.stdout.write(Buffer.alloc(8_100_000)); setInterval(() => {}, 1000);`;
    await assert.rejects(
      run(process.execPath, ["-e", excessive, pidPath], 10000),
      /output exceeded/,
    );
    const excessivePid = Number(await readFile(pidPath, "utf8"));
    assert.throws(() => process.kill(excessivePid, 0), { code: "ESRCH" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overlay parser validates dates, date order and explicit offset", () => {
  assert.equal(
    parseOverlay("28/10/2026 15:00:41", "DMY", 60),
    "2026-10-28T14:00:41.000Z",
  );
  assert.equal(parseOverlay("02/30/2026 15:00:41", "MDY", 0), null);
  assert.equal(
    parseOverlay("2026-10-28 15:00:41", "YMD", 0),
    "2026-10-28T15:00:41.000Z",
  );
  assert.equal(parseOverlay("31/12/2026 24:00:00", "DMY", 0), null);
});

test("path and filename boundaries reject traversal and reserved names", () => {
  for (const name of ["../file.jpg", "CON.jpg", "file.", "a/b", "a\\b", ""])
    assert.throws(() => safeName(name));
  assert.equal(safeName("deer-01.jpg"), "deer-01.jpg");
  assert.equal(inside("/gallery", "/gallery/sub/a.jpg"), true);
  assert.equal(inside("/gallery", "/gallery-elsewhere/a.jpg"), false);
});

test("large library queries bound payloads and search metadata without returning it", async () => {
  const root = await mkdtemp(join(tmpdir(), "camviewer-scale-"));
  const library = new Library(root, root);
  try {
    library.db.exec("BEGIN");
    for (let index = 0; index < 1500; index++)
      library.put({
        id: `id-${String(index).padStart(4, "0")}`,
        name: `Photo ${String(index).padStart(4, "0")}.jpg`,
        kind: "image",
        state: "review",
        folderId: "root",
        path: join(root, `${index}.jpg`),
        hash: "hash",
        size: 1,
        width: 1,
        height: 1,
        duration: 0,
        captureDate: null,
        dateSource: "unknown",
        tags: index % 2 ? ["Night"] : [],
        warnings: [],
        importedAt: "2026-10-31T00:00:00Z",
        metadata: { note: index === 1499 ? "Unique deer" : "x".repeat(8192) },
      });
    library.db.exec("COMMIT");
    const snapshot = library.snapshot({
      state: "review",
      sort: "name",
      offset: 60,
      limit: 60,
    });
    assert.equal(snapshot.total, 1500);
    assert.equal(snapshot.counts.review, 1500);
    assert.equal(snapshot.media.length, 60);
    assert.equal(snapshot.media[0].id, "id-0060");
    assert.ok(!("metadata" in snapshot.media[0]));
    assert.ok(JSON.stringify(snapshot).length < 40_000);
    assert.equal(
      library.query({ search: "unique DEER" }).media[0].id,
      "id-1499",
    );
    assert.equal(library.matchingIds({ search: "Night" }).length, 750);
    assert.equal(library.query({ limit: 10000 }).media.length, 240);
    assert.equal(library.query({ state: "gallery" }).total, 0);
    assert.equal(library.getMedia("id-1499").metadata.note, "Unique deer");
    const ribbon = library.query({
      anchorId: "id-1499",
      sort: "name",
      limit: 60,
    });
    assert.ok(ribbon.media.some((row) => row.id === "id-1499"));
    assert.ok(ribbon.media.length <= 60);
    assert.deepEqual(
      library.matchingIds({ state: "review" }, ["id-0001", "missing"]),
      ["id-0001"],
    );
    const row = library.get("id-0000");
    library.put({
      ...row,
      name: "Photo 10.jpg",
      tags: ["Élan", "Trail"],
      captureDate: "2026-10-30T00:00:00Z",
    });
    library.put({
      ...library.get("id-0001"),
      name: "Photo 2.jpg",
      folderId: "other",
    });
    assert.deepEqual(
      library
        .query({ search: "Photo", sort: "name", limit: 2 })
        .media.map((row) => row.name),
      ["Photo 2.jpg", "Photo 0002.jpg"],
    );
    assert.equal(library.query({ search: "élan trail" }).total, 1);
    assert.equal(
      library.query({ from: "2026-10-30", to: "2026-10-30" }).total,
      1,
    );
    assert.equal(
      library.query({ folderId: "root", exactFolder: true }).total,
      1499,
    );
    assert.equal(library.query({ offset: 999999 }).offset, 1440);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("real image import, review, accept, metadata, export, folders and delete persist", async () => {
  const root = await mkdtemp(join(tmpdir(), "camviewer-test-"));
  const source = resolve("../Requirements/example_files/IMG_5587.JPG");
  const original = await readFile(source);
  const library = new Library(
    root,
    resolve("../Requirements/application_src/camDate"),
  );
  try {
    await library.initialize();
    const imported = await library.importPaths([source]);
    assert.deepEqual(imported.errors, []);
    const id = imported.succeeded[0];
    assert.equal(library.get(id).state, "review");
    assert.equal(library.get(id).kind, "image");
    await library.createFolder("Trail", "root");
    const folder = library.folders().find((item) => item.name === "Trail")!;
    assert.deepEqual((await library.accept([id], folder.id)).errors, []);
    await library.update([id], {
      tags: ["Night", "Night"],
      metadata: { title: "Test" },
      captureDate: "2026-10-28T15:00:41Z",
    });
    assert.deepEqual(library.get(id).tags, ["Night"]);
    await library.rename(id, "test.JPG");
    await library.renameFolder(folder.id, "Renamed");
    assert.equal(library.get(id).path.includes("Renamed"), true);
    assert.equal(library.get(id).metadata.title, "Test");
    const exported = join(root, "exported");
    await mkdir(exported);
    assert.deepEqual((await library.exportFiles([id], exported)).errors, []);
    assert.deepEqual(await readFile(join(exported, "test.JPG")), original);
    assert.deepEqual(await readFile(source), original);
    assert.equal(library.snapshot().media.length, 1);
    await library.removeFolder(folder.id);
    assert.equal(library.snapshot().media.length, 0);
    assert.equal(library.folders().length, 1);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("real video import extracts a thumbnail and keeps the original intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "camviewer-video-"));
  const library = new Library(
    root,
    resolve("../Requirements/application_src/camDate"),
  );
  try {
    await library.initialize();
    const result = await library.importPaths([
      resolve("../Requirements/example_files/20261028-150041.mp4"),
    ]);
    assert.deepEqual(result.errors, []);
    const row = library.get(result.succeeded[0]);
    assert.equal(row.kind, "video");
    assert.ok(row.width > 0);
    assert.ok(row.duration > 0);
    assert.ok((await stat(join(library.cache, `${row.id}.jpg`))).size > 0);
    assert.deepEqual((await library.remove([row.id])).errors, []);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("collisions, nested storage and escaping symlinks are rejected without data loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "camviewer-safety-"));
  const library = new Library(
    root,
    resolve("../Requirements/application_src/camDate"),
  );
  try {
    await library.initialize();
    const source = resolve("../Requirements/example_files/IMG_5587.JPG");
    const first = (await library.importPaths([source])).succeeded[0];
    const second = (await library.importPaths([source])).succeeded[0];
    await assert.rejects(
      () => library.rename(second, library.get(first).name),
      /already exists/,
    );
    assert.equal(
      library.snapshot().jobs.filter((job) => job.state === "running").length,
      0,
    );
    assert.equal(library.snapshot().media.length, 2);
    await assert.rejects(
      () =>
        library.saveSettings({
          ...library.settings(),
          galleryPath: join(library.settings().importPath, "nested"),
        }),
      /nested/,
    );
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(
      outside,
      join(library.settings().galleryPath, "escape"),
      "dir",
    );
    const fakeFolder = { id: "escape", name: "escape", relativePath: "escape" };
    library.db
      .prepare("INSERT INTO folders VALUES (?,?)")
      .run(fakeFolder.id, JSON.stringify(fakeFolder));
    const result = await library.accept([first], fakeFolder.id);
    assert.ok(result.errors.length);
    assert.equal(library.get(first).state, "review");
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("real overlay OCR repairs an imported image and agrees across video frames", async () => {
  const root = await mkdtemp(join(tmpdir(), "camviewer-ocr-"));
  const source = resolve("../Requirements/example_files/IMG_5587.JPG");
  const original = await readFile(source);
  const library = new Library(
    root,
    resolve("../Requirements/application_src/camDate"),
  );
  try {
    await library.initialize();
    await library.saveSettings({ ...library.settings(), overlayEnabled: true });
    const result = await library.importPaths([source]);
    assert.deepEqual(result.errors, []);
    const row = library.get(result.succeeded[0]);
    assert.equal(row.dateSource, "overlay");
    assert.equal(row.captureDate, "2026-10-16T17:37:29.000Z");
    const evidence = row.metadata.overlayEvidence as OverlayEvidence[];
    assert.deepEqual(
      evidence.map((item) => item.variant),
      ["original", "grayscale", "contrast", "threshold", "inverted"],
    );
    assert.ok(evidence.every((item) => item.offset === 0));
    assert.equal(agreeOverlay(evidence, "image"), row.captureDate);
    assert.equal((await stat(row.path)).mtime.toISOString(), row.captureDate);
    const embedded = await library.tools.exif.read(row.path);
    assert.equal(
      typeof embedded.DateTimeOriginal === "object"
        ? embedded.DateTimeOriginal.year
        : null,
      2026,
    );
    assert.deepEqual(await readFile(source), original);
    const video = await library.tools.ocr(
      resolve("../Requirements/example_files/20261028-150041.mp4"),
      "video",
      10,
      library.settings(),
    );
    assert.equal(video.date, "2026-10-28T15:00:41.000Z");
    assert.ok(
      video.evidence.filter((item) => item.date && item.confidence >= 60)
        .length >= 2,
    );
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("image OCR crops after EXIF orientation and rejects oversized regions", async () => {
  const root = await mkdtemp(join(tmpdir(), "camviewer-ocr-orientation-"));
  const library = new Library(
    root,
    resolve("../Requirements/application_src/camDate"),
  );
  const cache = join(root, "ocr-cache");
  await mkdir(cache);
  library.tools.temporaryPath = cache;
  try {
    const rotated = join(root, "rotated.png");
    await sharp(resolve("../Requirements/example_files/IMG_5587.JPG"))
      .rotate(270)
      .withMetadata({ orientation: 6 })
      .png()
      .toFile(rotated);
    const result = await library.tools.ocr(
      rotated,
      "image",
      0,
      library.settings(),
    );
    assert.equal(result.date, "2026-10-16T17:37:29.000Z");
    assert.equal(result.evidence.length, 5);
    assert.deepEqual(await readdir(cache), []);
    const oversized = join(root, "oversized.png");
    await sharp({
      create: { width: 3200, height: 3000, channels: 3, background: "white" },
    })
      .png()
      .toFile(oversized);
    await assert.rejects(
      library.tools.ocr(oversized, "image", 0, {
        ...library.settings(),
        crop: { x: 0, y: 0, width: 1, height: 1 },
      }),
      /OCR crop is too large/,
    );
    assert.deepEqual(await readdir(cache), []);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata dates repair filesystem timestamps before overlay recognition", async () => {
  const root = await mkdtemp(join(tmpdir(), "camviewer-metadata-"));
  const library = new Library(
    root,
    resolve("../Requirements/application_src/camDate"),
  );
  try {
    await library.initialize();
    await library.saveSettings({ ...library.settings(), overlayEnabled: true });
    const source = join(root, "dated.JPG");
    await copyFile(
      resolve("../Requirements/example_files/IMG_5587.JPG"),
      source,
    );
    const created = "2025-03-04T10:20:30.000Z";
    const modified = "2025-03-05T11:21:31.000Z";
    await library.tools.writeDate(source, "image", created, modified);
    const original = await readFile(source);
    library.tools.ocr = async () => {
      throw new Error("OCR must not run when metadata dates are available.");
    };
    const imported = await library.importPaths([source]);
    assert.deepEqual(imported.errors, []);
    const row = library.get(imported.succeeded[0]);
    assert.equal(row.captureDate, created);
    assert.equal(row.dateSource, "embedded");
    assert.equal((await stat(row.path)).mtime.toISOString(), modified);
    assert.equal(row.metadata.overlayEvidence, undefined);
    assert.deepEqual(await readFile(source), original);
    const partialSource = join(root, "partial.JPG");
    await copyFile(
      resolve("../Requirements/example_files/IMG_5587.JPG"),
      partialSource,
    );
    await library.tools.exif.write(
      partialSource,
      { DateTimeOriginal: created, OffsetTimeOriginal: "+00:00" },
      ["-overwrite_original"],
    );
    const partial = await library.importPaths([partialSource]);
    assert.deepEqual(partial.errors, []);
    const repaired = library.get(partial.succeeded[0]);
    assert.equal(repaired.dateSource, "embedded");
    assert.equal((await stat(repaired.path)).mtime.toISOString(), created);
    assert.ok(repaired.metadata.ModifyDate);
    const videoSource = join(root, "dated.mp4");
    await copyFile(
      resolve("../Requirements/example_files/20261028-150041.mp4"),
      videoSource,
    );
    await library.tools.writeDate(videoSource, "video", created, modified);
    const videoOriginal = await readFile(videoSource);
    const video = await library.importPaths([videoSource]);
    assert.deepEqual(video.errors, []);
    const videoRow = library.get(video.succeeded[0]);
    assert.equal(videoRow.captureDate, created);
    assert.equal(videoRow.dateSource, "embedded");
    assert.equal((await stat(videoRow.path)).mtime.toISOString(), modified);
    assert.deepEqual(await readFile(videoSource), videoOriginal);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy preferences receive display defaults and validate persisted choices", async () => {
  const root = await mkdtemp(join(tmpdir(), "camviewer-display-"));
  const library = new Library(
    root,
    resolve("../Requirements/application_src/camDate"),
  );
  try {
    const legacy = { ...library.settings() } as Partial<
      ReturnType<Library["settings"]>
    >;
    delete legacy.display;
    delete legacy.defaultSort;
    library.db
      .prepare("UPDATE settings SET data=? WHERE id=1")
      .run(JSON.stringify(legacy));
    await library.initialize();
    assert.deepEqual(library.settings().display, {
      pageHeading: true,
      toolbar: true,
      statusbar: true,
    });
    await library.saveSettings({
      ...library.settings(),
      defaultSort: "name",
      thumbnailSize: 110,
      display: { pageHeading: false, toolbar: false, statusbar: false },
    });
    assert.equal(library.settings().defaultSort, "name");
    assert.equal(library.settings().display.toolbar, false);
    await assert.rejects(
      () =>
        library.saveSettings({
          ...library.settings(),
          defaultSort: "invalid" as "date",
        }),
      /Invalid settings/,
    );
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted acceptance is recovered after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "camviewer-recovery-"));
  let library = new Library(
    root,
    resolve("../Requirements/application_src/camDate"),
  );
  try {
    await library.initialize();
    const id = (
      await library.importPaths([
        resolve("../Requirements/example_files/IMG_5587.JPG"),
      ])
    ).succeeded[0];
    const row = library.get(id);
    const destination = join(library.settings().galleryPath, row.name);
    library.job(
      "move",
      {
        source: row.path,
        destination,
        updated: { ...row, path: destination, state: "gallery" },
      },
      "Simulated interruption",
    );
    await copyFile(row.path, destination);
    await library.close();
    library = new Library(
      root,
      resolve("../Requirements/application_src/camDate"),
    );
    await library.initialize();
    assert.equal(library.get(id).state, "gallery");
    await assert.rejects(() => stat(row.path), /ENOENT/);
    assert.equal(library.snapshot().jobs[0].state, "completed");
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});
