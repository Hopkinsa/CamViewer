import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { _electron as electron, expect } from "@playwright/test";
import executablePath from "electron";
import sharp from "sharp";
import ffmpeg from "ffmpeg-static";
import { Library } from "../src/main/library.ts";
import { run } from "../src/main/media.ts";

if (process.argv.includes("--ui-amendments")) {
  await testUIAmendments();
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), "camviewer-desktop-"));
const library = new Library(
  root,
  resolve("../Requirements/application_src/camDate"),
);
await library.initialize();
const inputs = Array.from({ length: 13 }, () =>
  resolve("../Requirements/example_files/IMG_5587.JPG"),
);
inputs.push(resolve("../Requirements/example_files/20261028-150041.mp4"));
const imported = await library.importPaths(inputs);
assert.deepEqual(imported.errors, []);
const accepted = [...imported.succeeded.slice(0, 12), imported.succeeded[13]];
await library.accept(accepted, "root");
await library.saveSettings({ ...library.settings(), pageSize: 12 });
const suppressedWarnings = [
  "Original embedded modification timestamp was missing or invalid.",
  "Capture time repaired from the selected overlay profile. Verify before accepting.",
  "Filesystem creation and modification dates updated.",
];
for (const [index, id] of accepted.entries()) {
  const media = library.rows().find((row) => row.id === id)!;
  library.put({
    ...media,
    captureDate:
      index === 0
        ? null
        : index === 1
          ? "invalid"
          : new Date(Date.UTC(2026, 0, index + 1, 14, 5)).toISOString(),
    warnings: [...suppressedWarnings, "Timestamp needs manual review."],
  });
}
const reviewMedia = library.rows().find((row) => row.state === "review")!;
library.put({
  ...reviewMedia,
  captureDate: null,
  warnings: suppressedWarnings,
});
const expectedRange = (offset: number) => {
  const dates = library
    .query({ state: "gallery", sort: "date", offset, limit: 12 })
    .media.map((media) => Date.parse(media.captureDate ?? ""))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const format = (value: number) =>
    new Date(value)
      .toLocaleString("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
      .replace(",", "");
  return dates.length ? `${format(dates[0])} - ${format(dates.at(-1)!)}` : "";
};
const firstPageRange = expectedRange(0);
const secondPageRange = expectedRange(12);
await library.close();
await mkdir("test-results", { recursive: true });
const packagedExecutable = process.env.CAMVIEWER_PACKAGED_EXECUTABLE;
const options = {
  executablePath: packagedExecutable || (executablePath as unknown as string),
  args: packagedExecutable ? [] : ["."],
  env: {
    ...process.env,
    CAMVIEWER_WORKSPACE: root,
    CAMVIEWER_DEV_URL: process.env.CAMVIEWER_TEST_DEV_URL || "",
  },
  timeout: 60_000,
};
let app = await electron.launch(options);
try {
  const page = await app.firstWindow();
  const failures: string[] = [];
  page.on("pageerror", (failure) => failures.push(failure.message));
  await expect(
    page.getByRole("heading", { name: "Local gallery", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".media-card")).toHaveCount(12);
  await expect(page.locator(".page-date-range")).toHaveText(firstPageRange);
  await expect(page.locator(".warning-badge")).toHaveCount(0);
  const footer = (await page.locator(".collection-footer").boundingBox())!;
  const dateRange = (await page.locator(".page-date-range").boundingBox())!;
  assert.ok(
    Math.abs(dateRange.x + dateRange.width / 2 - footer.x - footer.width / 2) <
      1,
  );
  await page
    .getByRole("button", { name: "Select all matching", exact: true })
    .click();
  await expect(page.locator(".batch-bar")).toContainText("13 selected");
  await page.getByTitle("Next page", { exact: true }).click();
  await expect(page.locator(".media-card")).toHaveCount(1);
  await expect(page.locator(".page-date-range")).toHaveText(secondPageRange);
  await page.getByTitle("Previous page", { exact: true }).click();
  await expect(page.locator(".page-date-range")).toHaveText(firstPageRange);
  await page
    .locator(".media-card")
    .filter({ hasText: "IMAGE" })
    .first()
    .click();
  await expect(page.locator(".inspector.has-current")).toBeVisible();
  await expect(page.locator(".warnings")).toHaveText(
    "Timestamp needs manual review.",
  );
  await page.screenshot({ path: "test-results/desktop.png" });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(360, 560);
    window.setContentSize(390, 780);
  });
  const narrowRange = (await page.locator(".page-date-range").boundingBox())!;
  const pagination = (await page.locator(".pagination").boundingBox())!;
  assert.ok(narrowRange.y >= pagination.y + pagination.height);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({ path: "test-results/footer-mobile.png" });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 920);
  });
  await page.getByTitle("Filters", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Media type" })
    .selectOption("image");
  const imageCard = page.locator(".media-card").first();
  const imageName = (await imageCard.getAttribute("title"))!;
  await imageCard.dblclick();
  await expect(page.locator(".viewer-screen")).toBeVisible();
  await expect(page.locator(".main-panel")).toHaveCount(0);
  await expect(page.locator(".viewer-inspector .preview")).toHaveCount(0);
  await expect(page.locator(".ribbon-item")).toHaveCount(13);
  await expect(
    page.locator('.ribbon-item[aria-current="true"]'),
  ).toHaveAttribute("title", imageName);
  assert.equal(
    (await page.locator(".ribbon-item").first().boundingBox())!.width,
    110,
  );
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>(".viewer-media img");
    return image && image.naturalWidth > 0;
  });
  await page.screenshot({ path: "test-results/viewer-desktop.png" });
  await page.getByTitle("Scroll ribbon right", { exact: true }).click();
  await expect
    .poll(() =>
      page.locator(".file-ribbon").evaluate((ribbon) => ribbon.scrollLeft),
    )
    .toBeGreaterThan(0);
  await page.locator('.ribbon-item[title="20261028-150041.mp4"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector(".viewer-media video") instanceof
        HTMLVideoElement &&
      (document.querySelector("video") as HTMLVideoElement).videoWidth > 0,
  );
  await page
    .locator(".ribbon-item")
    .filter({ hasText: imageName })
    .first()
    .click();
  await page.getByTitle("Rename file", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("viewer-selected.JPG");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".viewer-inspector h2")).toHaveText(
    "viewer-selected.JPG",
  );
  await page.getByTitle("Edit selected metadata", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "Tags separated by commas" })
    .fill("Viewer edit");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".viewer-inspector .tag")).toHaveText(
    "Viewer edit",
  );
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(760, 780);
  });
  await expect(page.locator(".viewer-inspector")).toBeVisible();
  await page.screenshot({ path: "test-results/viewer-narrow.png" });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(360, 560);
    window.setContentSize(390, 780);
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await expect(page.getByTitle("Close viewer", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/viewer-mobile.png" });
  await page.getByTitle("Close viewer", { exact: true }).click();
  await expect(page.locator(".main-panel")).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 920);
  });
  await page.getByRole("combobox", { name: "Media type" }).selectOption("all");
  await page.getByTitle("Filters", { exact: true }).click();
  await page
    .getByRole("button", { name: "Edit metadata", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Tags separated by commas" })
    .fill("Regression, Local");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search library" })
    .fill("Regression");
  await expect(page.locator(".media-card")).toHaveCount(1);
  await page.getByTitle("Clear search", { exact: true }).click();
  await page.getByRole("button", { name: /Review imports/ }).click();
  await expect(page.locator(".media-card")).toHaveCount(1);
  await expect(page.locator(".page-date-range")).toBeEmpty();
  await page.locator(".media-card").first().click();
  await expect(page.locator(".inspector.has-current")).toBeVisible();
  await expect(page.locator(".warnings")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Select all matching", exact: true })
    .click();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your review queue is clear" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Local gallery/ }).click();
  await page.getByRole("combobox", { name: "Sort files" }).selectOption("name");
  await page
    .locator(".media-card")
    .filter({ hasText: "20261028-150041.mp4" })
    .click();
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video && video.readyState >= 2 && video.videoWidth > 0;
  });
  await page.getByRole("checkbox", { name: "Motion", exact: true }).check();
  await page.locator("video").evaluate((video) => {
    (video as HTMLVideoElement).loop = true;
    return (video as HTMLVideoElement).play();
  });
  await page
    .waitForFunction(
      () => {
        const canvas = document.querySelector("canvas");
        if (!canvas || canvas.dataset.analyzed !== "true") return false;
        const pixels = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        return pixels.some((value, index) => index % 4 !== 3 && value > 0);
      },
      undefined,
      { timeout: 30_000 },
    )
    .catch(async (failure) => {
      console.error(
        await page.evaluate(() => ({
          hidden: document.hidden,
          video: {
            paused: document.querySelector("video")?.paused,
            time: document.querySelector("video")?.currentTime,
            ready: document.querySelector("video")?.readyState,
          },
          panel: document.querySelector(".motion-player")?.textContent,
        })),
      );
      console.error(failures);
      await page.screenshot({ path: "test-results/motion-error.png" });
      throw failure;
    });
  const pixels = await page.locator("canvas").evaluate((canvas) => {
    const context = (canvas as HTMLCanvasElement).getContext("2d")!;
    return Array.from(
      context.getImageData(0, 0, canvas.width, canvas.height).data,
    ).filter((value, index) => index % 4 !== 3 && value > 0).length;
  });
  assert.ok(
    pixels > 100,
    "Decoded video analysis canvas must contain image pixels.",
  );
  await expect(page.locator(".motion-layer span").first()).toBeVisible({
    timeout: 15_000,
  });
  const overlayBounds = await page.locator(".motion-layer").boundingBox();
  const videoBounds = await page.locator("video").boundingBox();
  assert.deepEqual(overlayBounds, videoBounds);
  await page.screenshot({ path: "test-results/motion.png" });
  await page
    .locator("video")
    .evaluate((video) => (video as HTMLVideoElement).pause());
  await page.getByRole("checkbox", { name: "Motion", exact: true }).uncheck();
  await page.getByTitle("Close inspector", { exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(760, 780);
  });
  await expect(page.locator(".app")).toBeVisible();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({ path: "test-results/narrow.png" });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(360, 560);
    window.setContentSize(390, 780);
  });
  await expect(
    page.getByTitle("Open navigation", { exact: true }),
  ).toBeVisible();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({ path: "test-results/mobile.png" });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1280, 900);
  });
  await page.getByTitle("Settings", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Library settings" }),
  ).toBeVisible();
  await page.getByTitle("Close settings", { exact: true }).click();
  await page.locator(".media-card").first().click();
  const countBefore = await page.evaluate(
    async () => (await window.camviewer!.snapshot()).media.length,
  );
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
  });
  await page
    .getByTitle("Permanently delete selected files", { exact: true })
    .click();
  assert.equal(
    await page.evaluate(
      async () => (await window.camviewer!.snapshot()).media.length,
    ),
    countBefore,
  );
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
  });
  await page
    .getByTitle("Permanently delete selected files", { exact: true })
    .click();
  await expect
    .poll(async () =>
      page.evaluate(
        async () => (await window.camviewer!.snapshot()).media.length,
      ),
    )
    .toBe(countBefore - 1);
  const range = await page.evaluate(async () => {
    const snapshot = await window.camviewer!.snapshot();
    const response = await fetch(snapshot.media[0].url, {
      headers: { Range: "bytes=0-63" },
    });
    return {
      status: response.status,
      bytes: (await response.arrayBuffer()).byteLength,
    };
  });
  assert.deepEqual(range, { status: 206, bytes: 64 });
  await page.evaluate(async () => {
    const snapshot = await window.camviewer!.snapshot();
    await window.camviewer!.saveSettings({
      ...snapshot.settings,
      overlayEnabled: true,
    });
  });
  await copyFile(
    resolve("../Requirements/example_files/IMG_5587.JPG"),
    join(root, "in", "packaged-image.JPG"),
  );
  await copyFile(
    resolve("../Requirements/example_files/20261028-150041.mp4"),
    join(root, "in", "packaged-video.mp4"),
  );
  const scan = await page.evaluate(() => window.camviewer!.scan());
  assert.deepEqual(scan.errors, []);
  assert.equal(scan.succeeded.length, 2);
  const processed = await page.evaluate(() => window.camviewer!.snapshot());
  assert.equal(
    processed.media.find((item) => item.name === "packaged-image.JPG")
      ?.dateSource,
    "overlay",
  );
  assert.ok(
    processed.media.find((item) => item.name === "packaged-video.mp4")!
      .duration > 0,
  );
  assert.deepEqual(failures, []);
  await page.getByTitle("Settings", { exact: true }).click();
  await page
    .getByRole("tab", { name: "Display Settings", exact: true })
    .click();
  await page
    .getByRole("spinbutton", { name: "Default thumbnail size" })
    .fill("110");
  await page
    .getByRole("combobox", { name: "Default sort by" })
    .selectOption("tag");
  await page
    .getByRole("checkbox", { name: "Page heading", exact: true })
    .uncheck();
  await page.getByRole("checkbox", { name: "Toolbar", exact: true }).uncheck();
  await page
    .getByRole("checkbox", { name: "Status bar", exact: true })
    .uncheck();
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.locator(".page-heading")).toBeHidden();
  await expect(page.locator(".toolbar")).toBeHidden();
  await expect(page.locator(".statusbar")).toBeHidden();
  await expect(page.locator(".media-grid")).toHaveAttribute("style", /110px/);
  await expect(page.getByTitle("Import files", { exact: true })).toBeVisible();
  await page.getByTitle("Settings", { exact: true }).click();
  await page
    .getByRole("tab", { name: "Display Settings", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Default sort by" }),
  ).toHaveValue("tag");
  await page.screenshot({ path: "test-results/display-settings.png" });
  await page.getByTitle("Close settings", { exact: true }).click();
  await app.close();
  app = await electron.launch(options);
  const restarted = await app.firstWindow();
  await expect(restarted.locator(".main-panel .media-grid")).toBeVisible();
  const persisted = await restarted.evaluate(() =>
    window.camviewer!.snapshot(),
  );
  assert.equal(persisted.media.length, countBefore + 1);
  assert.equal(persisted.settings.overlayEnabled, true);
  assert.equal(persisted.settings.thumbnailSize, 110);
  assert.equal(persisted.settings.defaultSort, "tag");
  assert.deepEqual(persisted.settings.display, {
    pageHeading: false,
    toolbar: false,
    statusbar: false,
  });
  await expect(restarted.locator(".page-heading")).toBeHidden();
  await expect(
    restarted.locator(".toolbar select[aria-label='Sort files']"),
  ).toHaveValue("tag");
  await expect(restarted.locator(".media-grid")).toHaveAttribute(
    "style",
    /110px/,
  );
  assert.ok(persisted.media.some((item) => item.tags.includes("Regression")));
  await app.close();
  const seed = new Library(
    root,
    resolve("../Requirements/application_src/camDate"),
  );
  try {
    const template = seed
      .rows()
      .find((row) => row.kind === "image" && row.state === "gallery")!;
    for (let index = 0; index < 1500; index++) {
      const id = randomUUID();
      seed.put({
        ...template,
        id,
        name: `Scale fixture ${index}.JPG`,
        tags: [],
        metadata: { note: "x".repeat(32768) },
      });
      await copyFile(
        join(seed.cache, `${template.id}.jpg`),
        join(seed.cache, `${id}.jpg`),
      );
    }
    await seed.saveSettings({
      ...seed.settings(),
      pageSize: 60,
      defaultSort: "name",
      display: { pageHeading: true, toolbar: true, statusbar: true },
    });
  } finally {
    await seed.close();
  }
  app = await electron.launch(options);
  const scalePage = await app.firstWindow();
  scalePage.on("pageerror", (failure) => failures.push(failure.message));
  await expect(scalePage.locator(".media-card")).toHaveCount(60);
  const cdp = await scalePage.context().newCDPSession(scalePage);
  await cdp.send("HeapProfiler.collectGarbage");
  const before = await cdp.send("Runtime.getHeapUsage");
  await app.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => unknown>;
      }
    )._invokeHandlers;
    const original = handlers.get("camviewer:call")!;
    const stats = { snapshots: 0, active: 0, maxActive: 0 };
    (
      globalThis as typeof globalThis & { queryStats?: typeof stats }
    ).queryStats = stats;
    handlers.set("camviewer:call", async (...args) => {
      if (args[1] !== "snapshot") return original(...args);
      stats.snapshots++;
      stats.active++;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return await original(...args);
      } finally {
        stats.active--;
      }
    });
  });
  await scalePage
    .getByRole("textbox", { name: "Search library" })
    .fill("No such fixture");
  await app.evaluate(({ BrowserWindow }) => {
    for (let index = 0; index < 3000; index++)
      BrowserWindow.getAllWindows()[0].webContents.send("camviewer:changed");
  });
  await scalePage
    .getByRole("textbox", { name: "Search library" })
    .fill("Scale fixture");
  await expect(scalePage.locator(".collection-footer")).toContainText(
    "of 1500",
  );
  await expect(scalePage.locator(".media-card")).toHaveCount(60);
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              queryStats: { snapshots: number; active: number };
            }
          ).queryStats,
      ),
    )
    .toMatchObject({ active: 0 });
  const stats = await app.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          queryStats: { snapshots: number; maxActive: number };
        }
      ).queryStats,
  );
  assert.equal(stats.maxActive, 1);
  assert.ok(
    stats.snapshots <= 8,
    `Notification burst triggered ${stats.snapshots} snapshots`,
  );
  const payload = await scalePage.evaluate(() =>
    window.camviewer!.snapshot({
      state: "gallery",
      search: "Scale fixture",
      limit: 60,
    }),
  );
  assert.equal(payload.total, 1500);
  assert.equal(payload.media.length, 60);
  assert.ok(payload.media.every((row) => !("metadata" in row)));
  assert.ok(JSON.stringify(payload).length < 60_000);
  await scalePage
    .getByRole("button", { name: "Select all matching", exact: true })
    .click();
  await expect(scalePage.locator(".batch-bar")).toContainText("1500 selected");
  await scalePage.getByTitle("Next page", { exact: true }).click();
  await expect(scalePage.locator(".collection-footer")).toContainText(
    "61–120 of 1500",
  );
  await expect(scalePage.locator(".batch-bar")).toContainText("1500 selected");
  await scalePage
    .getByRole("button", { name: "Edit metadata", exact: true })
    .click();
  await expect(scalePage.locator(".dialog .eyebrow")).toHaveText(
    "1500 SELECTED",
  );
  await scalePage.getByTitle("Close metadata editor", { exact: true }).click();
  await scalePage.locator(".media-card").first().dblclick();
  await expect(scalePage.locator(".ribbon-item")).toHaveCount(60);
  await expect(
    scalePage.locator('.ribbon-item[aria-current="true"]'),
  ).toHaveCount(1);
  await scalePage.waitForFunction(
    () =>
      !!document.querySelector<HTMLImageElement>(".viewer-media img")
        ?.naturalWidth,
  );
  const firstRibbon = await scalePage
    .locator(".ribbon-item")
    .first()
    .getAttribute("title");
  await scalePage.locator(".file-ribbon").evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect
    .poll(() =>
      scalePage
        .locator(".file-ribbon")
        .evaluate(
          (element) =>
            element.scrollLeft + element.clientWidth >= element.scrollWidth - 1,
        ),
    )
    .toBe(true);
  await scalePage.getByTitle("Scroll ribbon right", { exact: true }).click();
  await expect
    .poll(() => scalePage.locator(".ribbon-item").first().getAttribute("title"))
    .not.toBe(firstRibbon);
  await expect(scalePage.locator(".ribbon-item")).toHaveCount(60);
  await scalePage.screenshot({ path: "test-results/large-library.png" });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(360, 560);
    window.setContentSize(390, 780);
  });
  assert.ok(
    await scalePage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await scalePage.screenshot({ path: "test-results/large-library-mobile.png" });
  await cdp.send("HeapProfiler.collectGarbage");
  const after = await cdp.send("Runtime.getHeapUsage");
  assert.ok(
    after.usedSize < 128 * 1024 * 1024,
    `Renderer heap reached ${after.usedSize} bytes`,
  );
  assert.ok(after.usedSize - before.usedSize < 64 * 1024 * 1024);
  assert.deepEqual(failures, []);
  console.log(
    `PASS: 1500 metadata-heavy records, 3000 notifications, ${stats.snapshots} refreshes (max concurrent ${stats.maxActive}), bounded pages/ribbon, all-matching selection, renderer heap ${(after.usedSize / 1024 / 1024).toFixed(1)} MiB.`,
  );
  console.log(
    "PASS: Electron gallery, full viewer/ribbon, inspector edits, persisted display preferences, selection, review, video/OpenCV, responsive screenshots, confirmations, byte ranges, native imports, OCR, and restart persistence.",
  );
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}

async function testUIAmendments() {
  const workspace = await mkdtemp(join(tmpdir(), "camviewer-ui-amendments-"));
  const fixture = new Library(
    workspace,
    resolve("../Requirements/application_src/camDate"),
  );
  let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await fixture.initialize();
    const source = join(workspace, "image-000.jpg");
    await sharp({
      create: { width: 640, height: 480, channels: 3, background: "#427b65" },
    })
      .jpeg()
      .toFile(source);
    const imported = await fixture.importPaths([source]);
    assert.deepEqual(imported.errors, []);
    const [firstId] = imported.succeeded;
    await fixture.accept([firstId], "root");
    const original = fixture.get(firstId);
    for (let index = 1; index < 75; index++) {
      const id = randomUUID();
      const name = `image-${String(index).padStart(3, "0")}.jpg`;
      const path = join(fixture.settings().galleryPath, name);
      await copyFile(original.path, path);
      await copyFile(
        join(fixture.cache, `${firstId}.jpg`),
        join(fixture.cache, `${id}.jpg`),
      );
      fixture.put({ ...original, id, name, path });
    }
    assert.ok(ffmpeg);
    const video = join(workspace, "video-075.mp4");
    await run(ffmpeg, [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=10",
      "-t",
      "1",
      "-pix_fmt",
      "yuv420p",
      video,
    ]);
    const videoImport = await fixture.importPaths([video]);
    assert.deepEqual(videoImport.errors, []);
    await fixture.accept(videoImport.succeeded, "root");
    await fixture.createFolder("Trail", "root");
    const parent = fixture.folders().find((item) => item.name === "Trail")!;
    await fixture.createFolder("Night", parent.id);
    const nested = fixture.folders().find((item) => item.name === "Night")!;
    await fixture.saveSettings({ ...fixture.settings(), defaultSort: "name" });
    await fixture.close();
    desktop = await electron.launch({
      executablePath: executablePath as unknown as string,
      args: ["."],
      env: {
        ...process.env,
        CAMVIEWER_WORKSPACE: workspace,
        CAMVIEWER_DEV_URL: "",
      },
      timeout: 60_000,
    });
    const page = await desktop.firstWindow();
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await mkdir("test-results", { recursive: true });
    await expect(page.locator(".media-card")).toHaveCount(60);
    await page.locator(".media-card").first().dblclick();
    await expect(page.locator(".ribbon-item")).toHaveCount(60);
    await expect(
      page.getByTitle("Previous file", { exact: true }),
    ).toBeDisabled();
    const initialIds = await page
      .locator(".ribbon-item")
      .evaluateAll((items) =>
        items.map((item) => item.getAttribute("data-media-id")),
      );
    await page.locator(".file-ribbon").evaluate((element) => {
      element.scrollLeft = 800;
    });
    const stable = await page.locator(".file-ribbon").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const item = [
        ...element.querySelectorAll<HTMLButtonElement>(".ribbon-item"),
      ].find((candidate) => {
        const box = candidate.getBoundingClientRect();
        return box.left >= bounds.left && box.right <= bounds.right;
      })!;
      return {
        id: item.dataset.mediaId!,
        name: item.title,
        left: element.scrollLeft,
        x: item.getBoundingClientRect().x,
      };
    });
    const target = page.locator(`.ribbon-item[data-media-id="${stable.id}"]`);
    await target.click();
    await expect(page.locator(".viewer-inspector h2")).toHaveText(stable.name);
    assert.deepEqual(
      await page
        .locator(".ribbon-item")
        .evaluateAll((items) =>
          items.map((item) => item.getAttribute("data-media-id")),
        ),
      initialIds,
    );
    assert.ok(
      Math.abs((await page
        .locator(".file-ribbon")
        .evaluate((element) => element.scrollLeft)) - stable.left) <= 1,
    );
    assert.ok(Math.abs((await target.boundingBox())!.x - stable.x) <= 1);
    await page.locator(".file-ribbon").evaluate((element) => {
      element.scrollLeft = 0;
    });
    const ribbonNodes = await page.locator(".file-ribbon").evaluateHandle(
      (element) => [...element.children],
    );
    await page.getByTitle("Next file", { exact: true }).click();
    await expect(
      page.locator('.ribbon-item[aria-current="true"]'),
    ).not.toHaveAttribute("data-media-id", stable.id);
    await page.getByTitle("Previous file", { exact: true }).click();
    await expect(
      page.locator('.ribbon-item[aria-current="true"]'),
    ).toHaveAttribute("data-media-id", stable.id);
    assert.equal(
      await page.locator(".file-ribbon").evaluate((element) => {
        return element.scrollLeft;
      }),
      0,
    );
    assert.ok(
      await page.locator(".file-ribbon").evaluate((element, nodes) =>
        [...element.children].every(
          (item, index) => item === nodes[index],
        ),
        ribbonNodes,
      ),
    );
    await ribbonNodes.dispose();
    await page.locator(".ribbon-item").last().click();
    await expect(page.locator(".viewer-inspector h2")).toHaveText(
      "image-059.jpg",
    );
    await page.getByTitle("Next file", { exact: true }).click();
    await expect(page.locator(".viewer-inspector h2")).toHaveText(
      "image-060.jpg",
    );
    await expect(
      page.locator('.ribbon-item[aria-current="true"]'),
    ).toHaveAttribute("title", "image-060.jpg");
    await page.screenshot({
      path: "test-results/amendments-ribbon-desktop.png",
    });
    await page.locator('.ribbon-item[title="video-075.mp4"]').click();
    await expect(page.locator(".viewer-media video")).toBeVisible();
    await page.waitForFunction(
      () => (document.querySelector("video")?.videoWidth ?? 0) > 0,
    );
    await expect(page.locator(".viewer-media .preview-controls")).toBeVisible();
    await expect(page.getByTitle("Next file", { exact: true })).toBeDisabled();
    await page.getByTitle("Previous file", { exact: true }).click();
    await expect(page.locator(".viewer-inspector h2")).toHaveText(
      "image-074.jpg",
    );
    await page.getByTitle("Next file", { exact: true }).click();
    await expect(
      page.locator('.ribbon-item[aria-current="true"]'),
    ).toHaveAttribute("title", "video-075.mp4");
    await page.screenshot({
      path: "test-results/amendments-video-desktop.png",
    });
    await page.getByTitle("Settings", { exact: true }).click();
    await page.getByRole("tab", { name: "Tags", exact: true }).click();
    await page
      .getByRole("textbox", { name: "New tag", exact: true })
      .fill("Night");
    await page.getByTitle("Create tag", { exact: true }).click();
    await expect(page.locator(".managed-tag")).toHaveCount(1);
    await page
      .getByRole("textbox", { name: "New tag", exact: true })
      .fill("Unused");
    await page.getByTitle("Create tag", { exact: true }).click();
    await expect(page.locator(".managed-tag")).toHaveCount(2);
    await page.getByTitle("Close settings", { exact: true }).click();
    await page.getByTitle("Add tags", { exact: true }).click();
    await page
      .getByRole("combobox", {
        name: "Add tags (comma-separated)",
        exact: true,
      })
      .fill("Night, Trail");
    await page.getByTitle("Apply tags", { exact: true }).click();
    await expect(page.locator(".viewer-inspector .tag")).toHaveText([
      "Night",
      "Trail",
    ]);
    await page.getByTitle("Remove tag Trail", { exact: true }).click();
    await expect(page.locator(".viewer-inspector .tag")).toHaveText(["Night"]);
    await page.getByTitle("Settings", { exact: true }).click();
    await page.getByRole("tab", { name: "Tags", exact: true }).click();
    await page.getByTitle("Rename tag Night", { exact: true }).click();
    await page
      .getByRole("textbox", { name: "Rename tag Night", exact: true })
      .fill("Nocturnal");
    await page.getByTitle("Save tag name", { exact: true }).click();
    await expect(
      page.getByTitle("Rename tag Nocturnal", { exact: true }),
    ).toBeVisible();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTitle("Delete tag Unused", { exact: true }).click();
    await expect(page.locator(".managed-tag")).toHaveCount(2);
    await page.screenshot({ path: "test-results/amendments-tags-desktop.png" });
    await page.getByTitle("Close settings", { exact: true }).click();
    await expect(page.locator(".viewer-inspector .tag")).toHaveText([
      "Nocturnal",
    ]);
    await page.getByTitle("Close viewer", { exact: true }).click();
    await page.evaluate(async () => {
      const { media } = await window.camviewer!.query({ state: "gallery", sort: "name", limit: 2 });
      await window.camviewer!.update([media[0].id], { tags: ["Night", "Trail"] });
      await window.camviewer!.update([media[1].id], { tags: ["Trail"] });
    });
    await page.getByTitle("Filters", { exact: true }).click();
    await page.getByRole("combobox", { name: "Tag filter", exact: true }).selectOption("none");
    await expect(page.locator(".selection-bar")).toContainText("73 files");
    await page.locator(".tag-filter-picker summary").click();
    await page.getByRole("checkbox", { name: "Night", exact: true }).check();
    await expect(page.getByRole("combobox", { name: "Tag filter", exact: true })).toHaveValue("selected");
    await expect(page.locator(".media-card")).toHaveCount(1);
    await page.getByRole("checkbox", { name: "Trail", exact: true }).check();
    await expect(page.locator(".media-card")).toHaveCount(2);
    await page.getByRole("checkbox", { name: "Trail", exact: true }).uncheck();
    await expect(page.locator(".media-card")).toHaveCount(1);
    await page.getByRole("checkbox", { name: "Trail", exact: true }).check();
    await expect(page.locator(".media-card")).toHaveCount(2);
    await page.locator(".tag-filter-picker summary").click();
    await page.getByRole("button", { name: "Select all matching", exact: true }).click();
    await expect(page.locator(".selection-bar")).toContainText("2 selected");
    await page.getByRole("combobox", { name: "Tag filter", exact: true }).selectOption("none");
    await expect(page.locator(".selection-bar")).toContainText("73 files");
    await page.getByRole("combobox", { name: "Tag filter", exact: true }).selectOption("all");
    await expect(page.locator(".selection-bar")).toContainText("76 files");
    await page.locator(".tag-filter-picker summary").click();
    await page.getByRole("checkbox", { name: "Night", exact: true }).check();
    await expect(page.locator(".tag-filter-picker summary")).toContainText("2 tags selected");
    await expect(page.locator(".media-card")).toHaveCount(2);
    await page.locator(".tag-filter-picker summary").click();
    await page.getByRole("combobox", { name: "Tag filter", exact: true }).selectOption("selected");
    await expect(page.locator(".media-card")).toHaveCount(2);
    await page.getByRole("textbox", { name: "Search library", exact: true }).fill("image-000");
    await expect(page.locator(".media-card")).toHaveCount(1);
    await page.screenshot({ path: "test-results/amendments-tag-filter-desktop.png" });
    await page.getByTitle("Clear search", { exact: true }).click();
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(page.locator(".media-card")).toHaveCount(60);
    await page.locator(".media-card").nth(0).click();
    await page
      .locator(".media-card")
      .nth(1)
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(page.locator(".batch-bar")).toContainText("2 selected");
    const selected = await page.locator(".media-card.is-selected").count();
    assert.equal(selected, 2);
    await page.getByTitle("Copy to folder", { exact: true }).click();
    const picker = page.getByRole("dialog", {
      name: "Copy to folder",
      exact: true,
    });
    await expect(picker.getByRole("radio")).toHaveCount(3);
    const parentBox = (await picker
      .getByRole("radio", { name: "Trail", exact: true })
      .boundingBox())!;
    const nestedPadding = await picker
      .getByRole("radio", { name: "Night", exact: true })
      .evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).paddingLeft),
      );
    const parentPadding = await picker
      .getByRole("radio", { name: "Trail", exact: true })
      .evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).paddingLeft),
      );
    assert.ok(parentBox.width > 0 && nestedPadding > parentPadding);
    await picker.getByRole("radio", { name: "Night", exact: true }).click();
    await page.screenshot({
      path: "test-results/amendments-folders-desktop.png",
    });
    await picker.getByRole("button", { name: "Copy", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          (folderId) =>
            window
              .camviewer!.query({
                state: "gallery",
                folderId,
                exactFolder: true,
              })
              .then((result) => result.total),
          nested.id,
        ),
      )
      .toBe(2);
    await page.getByTitle("Move to folder", { exact: true }).click();
    const movePicker = page.getByRole("dialog", {
      name: "Move to folder",
      exact: true,
    });
    await movePicker.getByRole("radio", { name: "Trail", exact: true }).click();
    await movePicker.getByRole("button", { name: "Move", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          (folderId) =>
            window
              .camviewer!.query({
                state: "gallery",
                folderId,
                exactFolder: true,
              })
              .then((result) => result.total),
          parent.id,
        ),
      )
      .toBe(2);
    await expect(page.locator(".notice.error")).toHaveCount(0);
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(360, 560);
      window.setContentSize(390, 780);
    });
    await page.getByRole("combobox", { name: "Tag filter", exact: true }).selectOption("selected");
    await page.locator(".tag-filter-picker summary").click();
    await page.getByRole("checkbox", { name: "Trail", exact: true }).check();
    await expect(page.locator(".media-card")).toHaveCount(4);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const tagOptions = await page.locator(".tag-filter-options").boundingBox();
    assert.ok(tagOptions && tagOptions.x >= 0 && tagOptions.x + tagOptions.width <= 390);
    await page.screenshot({ path: "test-results/amendments-tag-filter-mobile.png" });
    await page.locator(".tag-filter-picker summary").click();
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(page.locator(".media-card")).toHaveCount(60);
    await page.getByRole("button", { name: "Select page", exact: true }).click();
    await page.getByTitle("Copy to folder", { exact: true }).click();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.screenshot({
      path: "test-results/amendments-folders-mobile.png",
    });
    await page.getByTitle("Close folder picker", { exact: true }).click();
    await page.getByTitle("Settings", { exact: true }).click();
    await page.getByRole("tab", { name: "Tags", exact: true }).click();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.screenshot({ path: "test-results/amendments-tags-mobile.png" });
    await page.getByTitle("Close settings", { exact: true }).click();
    await expect(page.getByTitle("Next file", { exact: true })).toBeVisible();
    await page.screenshot({
      path: "test-results/amendments-preview-mobile.png",
    });
    assert.deepEqual(failures, []);
    console.log(
      "PASS: stable ribbon DOM and scroll position, image/video navigation, multi-tag/all/no-tag filtering and selection pruning, tag maintenance, nested-folder batch copy/move, desktop/mobile screenshots.",
    );
  } finally {
    if (desktop) await desktop.close();
    if (fixture.db.isOpen) await fixture.close();
    await rm(workspace, { recursive: true, force: true });
  }
}
