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
import sharp from "sharp";
import ffmpeg from "ffmpeg-static";
import ffprobe from "@ffprobe-installer/ffprobe";
import { ExifTool } from "exiftool-vendored";
import { createWorker, PSM } from "tesseract.js";
import type { Settings } from "../shared/types.ts";

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
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Media operation timed out."));
    }, timeout);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 8_000_000) child.kill();
      else output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      error = (error + chunk).slice(-6000);
    });
    child.once("error", (failure) => {
      clearTimeout(timer);
      reject(failure);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0
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
  constructor(ocrPath: string) {
    this.ocrPath = ocrPath;
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
    const directory = await mkdtemp(join(tmpdir(), "camviewer-ocr-"));
    const evidence: {
      offset: number;
      text: string;
      confidence: number;
      date: string | null;
    }[] = [];
    const worker = await createWorker("eng", 1, {
      langPath: this.ocrPath,
      gzip: false,
      cachePath: directory,
    });
    try {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
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
        const info = await sharp(input)
          .rotate()
          .toBuffer({ resolveWithObject: true });
        const crop = settings.crop;
        const region = await sharp(info.data)
          .extract({
            left: Math.floor(info.info.width * crop.x),
            top: Math.floor(info.info.height * crop.y),
            width: Math.max(1, Math.floor(info.info.width * crop.width)),
            height: Math.max(1, Math.floor(info.info.height * crop.height)),
          })
          .resize({ width: 1800 })
          .grayscale()
          .png()
          .toBuffer();
        const result = await worker.recognize(region);
        const parsed = parseOverlay(
          result.data.text,
          settings.dateOrder,
          settings.utcOffsetMinutes,
        );
        evidence.push({
          offset,
          text: result.data.text.trim(),
          confidence: result.data.confidence,
          date: parsed
            ? new Date(new Date(parsed).getTime() - offset * 1000).toISOString()
            : null,
        });
      }
      const valid = evidence.filter(
        (item) =>
          item.date &&
          item.confidence >= 60 &&
          new Date(item.date).getTime() <= Date.now() + 86_400_000,
      );
      const agreed = valid.find(
        (item) =>
          valid.filter(
            (other) =>
              Math.abs(Date.parse(other.date!) - Date.parse(item.date!)) <=
              1000,
          ).length >= (kind === "image" ? 1 : 2),
      );
      return { date: agreed?.date ?? null, evidence };
    } finally {
      await worker.terminate();
      await rm(directory, { recursive: true, force: true });
    }
  }
}
