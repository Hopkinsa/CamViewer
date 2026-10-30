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
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Library, inside, safeName } from "./library.ts";
import { parseOverlay } from "./media.ts";

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
