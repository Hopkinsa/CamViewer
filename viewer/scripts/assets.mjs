import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";

await mkdir("dist/ocr", { recursive: true });
await copyFile(
  resolve("../include/eng.traineddata"),
  "dist/ocr/eng.traineddata",
);
