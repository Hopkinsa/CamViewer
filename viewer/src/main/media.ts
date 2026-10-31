import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  rename,
  utimes,
  access,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import sharp from "sharp";
import ffmpeg from "ffmpeg-static";
import ffprobe from "@ffprobe-installer/ffprobe";
import { ExifTool } from "exiftool-vendored";
import type { Settings } from "../shared/types.ts";

const ocrWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { createWorker, PSM } = require(workerData.modulePath);
let worker;
parentPort.on("message", async (message) => {
  try {
    if (message.initialize) {
      worker = await createWorker("eng", 1, {
        langPath: workerData.langPath,
        gzip: false,
        cachePath: workerData.cachePath,
        errorHandler: (error) => parentPort.postMessage({ error: String(error) }),
      });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
      parentPort.postMessage({ result: { text: "", confidence: 0 } });
    } else {
      const result = await worker.recognize(message.image);
      parentPort.postMessage({ result: { text: result.data.text, confidence: result.data.confidence } });
    }
  } catch (error) {
    parentPort.postMessage({ error: String(error.message || error) });
  }
});
`;

type OcrResult = { text: string; confidence: number };
export interface OverlayEvidence {
  offset: number;
  variant?: string;
  text: string;
  confidence: number;
  date: string | null;
}

export function agreeOverlay(
  evidence: OverlayEvidence[],
  kind: Inspection["kind"],
): string | null {
  const valid = evidence.filter(
    (item) =>
      item.date &&
      Number.isFinite(Date.parse(item.date)) &&
      Number.isFinite(item.confidence) &&
      item.confidence >= 60 &&
      Date.parse(item.date) <= Date.now() + 86_400_000,
  );
  if (kind === "image") {
    if (new Set(valid.map((item) => item.date)).size !== 1) return null;
    const variants = new Set(
      valid.filter((item) => item.variant).map((item) => item.variant),
    );
    return variants.size >= 2 ? valid[0].date : null;
  }
  const agreed = valid.find(
    (item) =>
      new Set(
        valid
          .filter(
            (other) =>
              Math.abs(Date.parse(other.date!) - Date.parse(item.date!)) <=
              1000,
          )
          .map((other) => other.offset),
      ).size >= 2,
  );
  return agreed?.date ?? null;
}

class OcrSession {
  private thread: Worker;
  private failure?: Error;
  private pending?: {
    resolve: (result: OcrResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  constructor(langPath: string, cachePath: string) {
    this.thread = new Worker(ocrWorkerSource, {
      eval: true,
      workerData: {
        modulePath: createRequire(import.meta.url).resolve("tesseract.js"),
        langPath,
        cachePath,
      },
    });
    this.thread.on(
      "message",
      (message: { error?: string; result?: OcrResult }) => {
        if (message.error !== undefined) this.fail(new Error(message.error));
        else if (message.result) this.settle(message.result);
      },
    );
    this.thread.on("error", (error) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    );
    this.thread.on("exit", (code) =>
      this.fail(new Error(`OCR worker exited with ${code}.`)),
    );
  }
  private fail(error: Error) {
    this.failure ??= error;
    this.settle(undefined, this.failure);
  }
  private settle(result?: OcrResult, error?: Error) {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(result!);
  }
  request(
    message: { initialize?: boolean; image?: Buffer },
    timeout: number,
  ): Promise<OcrResult> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending)
      return Promise.reject(new Error("Another OCR task is running."));
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        timer: setTimeout(
          () => this.fail(new Error("OCR operation timed out.")),
          timeout,
        ),
      };
      try {
        this.thread.postMessage(message);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  async close() {
    try {
      await this.thread.terminate();
    } finally {
      this.thread.removeAllListeners();
    }
  }
}

export interface Inspection {
  kind: "image" | "video";
  size: number;
  width: number;
  height: number;
  duration: number;
  captureDate: string | null;
  dateSource: string;
  metadata: Record<string, unknown>;
  warnings: string[];
}

export async function checksum(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function run(
  binary: string,
  args: string[],
  timeout = 120_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    let bytes = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: Error) => {
      if (failure) return;
      failure = reason;
      clearTimeout(timer);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timer = setTimeout(() => {
      stop(new Error("Media operation timed out."));
    }, timeout);
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > 8_000_000)
        stop(new Error("Media tool output exceeded its limit."));
      else output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      error = (error + chunk).slice(-6000);
    });
    child.once("error", (reason) => {
      failure ??= reason;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      failure
        ? reject(failure)
        : code === 0
          ? resolve(output)
          : reject(new Error(error || `Media tool exited with ${code}.`));
    });
  });
}

export function parseOverlay(
  text: string,
  order: Settings["dateOrder"],
  offset: number,
): string | null {
  const match = text.match(
    /(\d{1,4})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{1,4})\s+(\d{1,2})\s*[:.]\s*(\d{2})\s*[:.]\s*(\d{2})/,
  );
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  const [year, month, day] =
    order === "YMD"
      ? parts
      : order === "DMY"
        ? [parts[2], parts[1], parts[0]]
        : [parts[2], parts[0], parts[1]];
  const [, , , hour, minute, second] = parts;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    year < 1970
  )
    return null;
  return new Date(date.getTime() - offset * 60_000).toISOString();
}

function embeddedDate(value: unknown): string | null {
  if (!value) return null;
  const candidate =
    typeof value === "object" && "toISOString" in value
      ? (value as { toISOString(): string }).toISOString()
      : String(value);
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(candidate)) return null;
  const date = new Date(candidate);
  return Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() >= 1970 &&
    date.getTime() <= Date.now() + 86_400_000
    ? date.toISOString()
    : null;
}

export class MediaTools {
  exif = new ExifTool({ maxProcs: 1, taskTimeoutMillis: 30_000 });
  ocrPath: string;
  ocrTimeoutMillis: number;
  temporaryPath: string;
  constructor(
    ocrPath: string,
    options: { ocrTimeoutMillis?: number; temporaryPath?: string } = {},
  ) {
    this.ocrPath = ocrPath;
    this.ocrTimeoutMillis = options.ocrTimeoutMillis ?? 30_000;
    this.temporaryPath = options.temporaryPath ?? tmpdir();
  }
  async close() {
    await this.exif.end();
  }

  async inspect(
    path: string,
    thumbnailPath: string,
    settings: Settings,
  ): Promise<Inspection> {
    const file = await stat(path);
    const raw = await this.exif.read(path);
    const metadata = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    for (const key of ["SourceFile", "Directory", "FileName"])
      delete metadata[key];
    const mime = String(raw.MIMEType ?? "");
    const kind = mime.startsWith("image/")
      ? "image"
      : mime.startsWith("video/")
        ? "video"
        : null;
    if (!kind) throw new Error("Unsupported or unrecognized media type.");
    let width = 0;
    let height = 0;
    let duration = 0;
    let captureDate =
      embeddedDate(raw.DateTimeOriginal) ??
      embeddedDate(raw.CreateDate) ??
      embeddedDate(raw.MediaCreateDate);
    let dateSource = captureDate ? "embedded" : "unknown";
    const warnings: string[] = [];
    if (kind === "image") {
      const info = await sharp(path, {
        limitInputPixels: 100_000_000,
      }).metadata();
      width = info.width ?? 0;
      height = info.height ?? 0;
      await sharp(path)
        .rotate()
        .resize(480, 360, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toFile(thumbnailPath);
    } else {
      const probe = JSON.parse(
        await run(ffprobe.path, [
          "-v",
          "error",
          "-show_format",
          "-show_streams",
          "-of",
          "json",
          path,
        ]),
      );
      const stream = probe.streams?.find(
        (item: { codec_type: string }) => item.codec_type === "video",
      );
      if (!stream) throw new Error("The file has no video stream.");
      width = Number(stream.width);
      height = Number(stream.height);
      duration = Number(probe.format?.duration ?? 0);
      metadata.probe = probe;
      captureDate ??= embeddedDate(probe.format?.tags?.creation_time);
      if (captureDate) dateSource = "embedded";
      if (!ffmpeg) throw new Error("FFmpeg is unavailable on this platform.");
      await run(ffmpeg, [
        "-v",
        "error",
        "-i",
        path,
        "-frames:v",
        "1",
        "-vf",
        "scale=480:-2",
        "-y",
        thumbnailPath,
      ]);
    }
    const modifiedDate =
      embeddedDate(raw.ModifyDate) ?? embeddedDate(raw.MediaModifyDate);
    const validFilesystemDate = (date: Date) =>
      date.getTime() > 0 && date.getTime() <= Date.now() + 86_400_000;
    const needsRepair =
      !captureDate ||
      !modifiedDate ||
      !validFilesystemDate(file.birthtime) ||
      !validFilesystemDate(file.mtime);
    metadata.timestampAssessment = {
      embeddedCreated: captureDate,
      embeddedModified: modifiedDate,
      filesystemCreated: file.birthtime.toISOString(),
      filesystemModified: file.mtime.toISOString(),
      needsRepair,
    };
    if (!modifiedDate)
      warnings.push(
        "Original embedded modification timestamp was missing or invalid.",
      );
    if (
      !validFilesystemDate(file.birthtime) ||
      !validFilesystemDate(file.mtime)
    )
      warnings.push(
        "Original filesystem timestamps are missing or outside the valid range.",
      );
    const metadataCreated = captureDate ?? modifiedDate;
    if (metadataCreated) {
      const metadataModified = modifiedDate ?? metadataCreated;
      if (!captureDate)
        warnings.push(
          "Created date inferred from the embedded modification date. Verify before accepting.",
        );
      if (!captureDate || !modifiedDate)
        await this.writeDate(path, kind, metadataCreated, metadataModified);
      captureDate = metadataCreated;
      dateSource = "embedded";
      warnings.push(
        await this.setFilesystemDates(path, metadataCreated, metadataModified),
      );
      metadata.timestampRepair = {
        source: "embedded",
        created: metadataCreated,
        modified: metadataModified,
      };
    } else if (settings.overlayEnabled) {
      const candidate = await this.ocr(path, kind, duration, settings);
      metadata.overlayEvidence = candidate.evidence;
      if (candidate.date) {
        captureDate = candidate.date;
        dateSource = "overlay";
        await this.writeDate(path, kind, captureDate);
        warnings.push(
          "Capture time repaired from the selected overlay profile. Verify before accepting.",
        );
        warnings.push(await this.setFilesystemDates(path, captureDate));
      } else
        warnings.push(
          "No consistent overlay timestamp found. Set a capture date during review.",
        );
    }
    if (captureDate) {
      const repaired = JSON.parse(
        JSON.stringify(await this.exif.read(path)),
      ) as Record<string, unknown>;
      for (const key of ["SourceFile", "Directory", "FileName"])
        delete repaired[key];
      Object.assign(metadata, repaired);
    }
    if (!captureDate)
      warnings.push(
        "No trustworthy capture timestamp with timezone. Review raw metadata or enter a date.",
      );
    return {
      kind,
      size: (await stat(path)).size,
      width,
      height,
      duration,
      captureDate,
      dateSource,
      metadata,
      warnings,
    };
  }

  async setFilesystemDates(
    path: string,
    date: string,
    modifiedDate = date,
  ): Promise<string> {
    const stamp = new Date(date);
    await utimes(path, stamp, new Date(modifiedDate));
    if (process.platform === "win32") {
      try {
        await this.exif.write(path, {}, [
          `-FileCreateDate=${date}`,
          "-overwrite_original",
        ]);
        return "Filesystem creation and modification dates updated.";
      } catch {
        return "Modification date updated; creation-time update was unavailable.";
      }
    }
    if (process.platform === "darwin") {
      try {
        await access("/usr/bin/SetFile");
        const pad = (value: number) => String(value).padStart(2, "0");
        const local = `${pad(stamp.getMonth() + 1)}/${pad(stamp.getDate())}/${stamp.getFullYear()} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}:${pad(stamp.getSeconds())}`;
        await run("/usr/bin/SetFile", ["-d", local, path]);
        return "Filesystem creation and modification dates updated.";
      } catch {
        return "Modification date updated; macOS creation-time tool unavailable.";
      }
    }
    return "Modification date updated; portable creation-time updates are not supported on this OS.";
  }

  async writeDate(
    path: string,
    kind: Inspection["kind"],
    date: string,
    modifiedDate = date,
  ) {
    if (kind === "image") {
      await this.exif.write(
        path,
        {
          DateTimeOriginal: date,
          CreateDate: date,
          ModifyDate: modifiedDate,
          OffsetTime: "+00:00",
          OffsetTimeOriginal: "+00:00",
        },
        ["-overwrite_original"],
      );
    } else {
      if (!ffmpeg) throw new Error("FFmpeg unavailable.");
      const temp = path.replace(/(\.[^.]+)$/, ".repair$1");
      try {
        await run(ffmpeg, [
          "-v",
          "error",
          "-i",
          path,
          "-map",
          "0",
          "-c",
          "copy",
          "-metadata",
          `creation_time=${date}`,
          "-y",
          temp,
        ]);
        await run(ffprobe.path, ["-v", "error", "-show_format", temp]);
        await rename(temp, path);
        await this.exif.write(path, { ModifyDate: modifiedDate }, [
          "-overwrite_original",
        ]);
      } finally {
        await rm(temp, { force: true });
      }
    }
  }

  async ocr(
    path: string,
    kind: Inspection["kind"],
    duration: number,
    settings: Settings,
  ) {
    const directory = await mkdtemp(join(this.temporaryPath, "camviewer-ocr-"));
    const evidence: OverlayEvidence[] = [];
    let worker: OcrSession | undefined;
    try {
      worker = new OcrSession(this.ocrPath, directory);
      await worker.request({ initialize: true }, this.ocrTimeoutMillis);
      for (const offset of kind === "image"
        ? [0]
        : [0, 1, 2].filter((value) => value < duration || value === 0)) {
        const frame = join(directory, `frame-${offset}.png`);
        if (kind === "video") {
          if (!ffmpeg) throw new Error("FFmpeg unavailable.");
          await run(ffmpeg, [
            "-v",
            "error",
            "-ss",
            String(offset),
            "-i",
            path,
            "-frames:v",
            "1",
            "-y",
            frame,
          ]);
        }
        const input = kind === "image" ? path : frame;
        const info = await sharp(input, {
          limitInputPixels: 100_000_000,
        }).metadata();
        const swapped =
          (info.orientation ?? 1) >= 5 && (info.orientation ?? 1) <= 8;
        const width = swapped ? info.height : info.width;
        const height = swapped ? info.width : info.height;
        if (!width || !height)
          throw new Error("OCR image dimensions are unavailable.");
        const crop = settings.crop;
        const cropWidth = Math.max(1, Math.floor(width * crop.width));
        const cropHeight = Math.max(1, Math.floor(height * crop.height));
        if (cropWidth * cropHeight > 8_000_000)
          throw new Error(
            "OCR crop is too large. Select a smaller timestamp region.",
          );
        const cropped = await sharp(input, { limitInputPixels: 100_000_000 })
          .rotate()
          .extract({
            left: Math.floor(width * crop.x),
            top: Math.floor(height * crop.y),
            width: cropWidth,
            height: cropHeight,
          })
          .png()
          .toBuffer();
        for (const variant of kind === "image"
          ? ["original", "grayscale", "contrast", "threshold", "inverted"]
          : ["grayscale"]) {
          let region = cropped;
          if (variant !== "original") {
            const pipeline = sharp(cropped)
              .resize({ width: 1800, height: 360, fit: "inside" })
              .grayscale();
            if (["contrast", "threshold", "inverted"].includes(variant))
              pipeline.normalise();
            if (variant === "threshold") pipeline.threshold(150);
            if (variant === "inverted") pipeline.negate();
            region = await pipeline.png().toBuffer();
          }
          const result = await worker.request(
            { image: region },
            this.ocrTimeoutMillis,
          );
          const parsed = parseOverlay(
            result.text,
            settings.dateOrder,
            settings.utcOffsetMinutes,
          );
          evidence.push({
            offset,
            variant,
            text: result.text.trim(),
            confidence: result.confidence,
            date: parsed
              ? new Date(
                  new Date(parsed).getTime() - offset * 1000,
                ).toISOString()
              : null,
          });
        }
      }
      return { date: agreeOverlay(evidence, kind), evidence };
    } finally {
      try {
        await worker?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
