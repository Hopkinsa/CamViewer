import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import executablePath from "electron";
import { Library } from "../src/main/library.ts";

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
  await page
    .getByRole("button", { name: "Select all matching", exact: true })
    .click();
  await expect(page.locator(".batch-bar")).toContainText("13 selected");
  await page.getByTitle("Next page", { exact: true }).click();
  await expect(page.locator(".media-card")).toHaveCount(1);
  await page.getByTitle("Previous page", { exact: true }).click();
  await page
    .locator(".media-card")
    .filter({ hasText: "IMAGE" })
    .first()
    .click();
  await expect(page.locator(".inspector.has-current")).toBeVisible();
  await page.screenshot({ path: "test-results/desktop.png" });
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
  console.log(
    "PASS: Electron gallery, full viewer/ribbon, inspector edits, persisted display preferences, selection, review, video/OpenCV, responsive screenshots, confirmations, byte ranges, native imports, OCR, and restart persistence.",
  );
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}
