import { copyFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MediaTools } from "../src/main/media.ts";
import type { Settings } from "../src/shared/types.ts";

async function main() {
  const file = process.argv[2];

  if (!file) {
    console.error("Usage: npm run date -- <image-or-video-path>");
    process.exitCode = 1;
    return;
  }

  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const sourcePath = resolve(file);
  const savePath = resolve(scriptDirectory, '../../tmp');
  const tempMediaPath = join(savePath, basename(sourcePath));
  const thumbnailPath = join(savePath, `${basename(sourcePath, extname(sourcePath))}-thumbnail.jpg`);

  const ocrPath = resolve(scriptDirectory, "../../include");
  const tools = new MediaTools(ocrPath);

  const settings: Settings = {
    importPath: "",
    processedPath: "",
    galleryPath: "",
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

  try {

    if (!existsSync(savePath)) {
      await mkdir(savePath);
    }
    await copyFile(sourcePath, tempMediaPath);

    const result = await tools.inspect(
      tempMediaPath,
      thumbnailPath,
      settings,
      savePath,
    );

    console.log(result.captureDate ?? "Date not found");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await tools.close();
  }
}

await main();