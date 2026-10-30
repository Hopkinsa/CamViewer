import { app, BrowserWindow, dialog, ipcMain, protocol } from "electron";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import { Library } from "./library.ts";
import type { MediaPatch, Settings } from "../shared/types.ts";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "cammedia",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
const here = dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow;
let library: Library;
let watcher: ReturnType<typeof chokidar.watch>;
let quitting = false;
const queue = new Set<string>();
let draining = false;

function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100_000 ||
    value.some((id) => typeof id !== "string" || !/^[\da-f-]{36}$/i.test(id))
  )
    throw new Error("Invalid media selection.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 1000)
    throw new Error("Invalid text input.");
  return value;
}
async function drain() {
  if (draining || library.busy || !queue.size) return;
  draining = true;
  const paths = [...queue];
  queue.clear();
  try {
    await library.importPaths(paths);
  } finally {
    draining = false;
    if (queue.size) void drain();
  }
}
function watchInput() {
  void watcher?.close();
  watcher = chokidar.watch(library.settings().importPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2500, pollInterval: 250 },
    ignored: (path) => /(^|[/\\])\.|\.part$/i.test(path),
  });
  watcher.on("add", (path) => {
    queue.add(path);
    void drain();
  });
  watcher.on("error", (error) => {
    const id = library.job("watch", {}, "Import watcher error");
    library.finish(id, "failed", String(error));
  });
}

async function registerMedia() {
  protocol.handle("cammedia", async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.pathname.slice(1);
      ids([id]);
      const row = library.get(id);
      const path =
        url.hostname === "thumbnail"
          ? join(library.cache, `${id}.jpg`)
          : url.hostname === "file"
            ? await library.authorizedPath(id)
            : null;
      if (!path) return new Response("Not found", { status: 404 });
      const info = await stat(path);
      const range = request.headers.get("range");
      const contentType =
        url.hostname === "thumbnail"
          ? "image/jpeg"
          : String(
              row.metadata.MIMEType ??
                (row.kind === "image" ? "image/jpeg" : "video/mp4"),
            );
      let start = 0;
      let end = info.size - 1;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2]))
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${info.size}` },
          });
        start = match[1]
          ? Number(match[1])
          : Math.max(0, info.size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= info.size
        )
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${info.size}` },
          });
      }
      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
      };
      if (range)
        headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
      const stream = Readable.toWeb(
        createReadStream(path, { start, end }),
      ) as ReadableStream<Uint8Array>;
      return new Response(stream as unknown as BodyInit, {
        status: range ? 206 : 200,
        headers,
      });
    } catch {
      return new Response(
        "Media unavailable. Rescan or relink the original file.",
        { status: 404 },
      );
    }
  });
}

app
  .whenReady()
  .then(async () => {
    const root =
      process.env.CAMVIEWER_WORKSPACE ??
      (app.isPackaged
        ? join(app.getPath("userData"), "workspace")
        : resolve(app.getAppPath(), ".."));
    library = new Library(root, join(here, "..", "dist", "ocr"), () => {
      if (window && !window.isDestroyed())
        window.webContents.send("camviewer:changed");
      if (!library?.busy) void drain();
    });
    await library.initialize();
    await registerMedia();
    window = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 680,
      minHeight: 560,
      title: "CamViewer",
      backgroundColor: "#f4f5f4",
      webPreferences: {
        preload: join(here, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );

    ipcMain.handle(
      "camviewer:call",
      async (event, method: unknown, args: unknown[]) => {
        if (
          event.senderFrame !== window.webContents.mainFrame ||
          !Array.isArray(args)
        )
          throw new Error("Unauthorized request.");
        switch (method) {
          case "snapshot":
            return library.snapshot();
          case "importFiles": {
            const result = await dialog.showOpenDialog(window, {
              title: "Import images and videos",
              properties: ["openFile", "multiSelections"],
              filters: [
                {
                  name: "Images and videos",
                  extensions: [
                    "jpg",
                    "jpeg",
                    "png",
                    "webp",
                    "tif",
                    "tiff",
                    "heic",
                    "mp4",
                    "mov",
                    "m4v",
                    "avi",
                    "webm",
                    "mkv",
                  ],
                },
              ],
            });
            if (!result.canceled) {
              const batch = await library.importPaths(result.filePaths);
              if (batch.errors.length)
                throw new Error(
                  batch.errors.map((item) => item.message).join("\n"),
                );
            }
            return;
          }
          case "scan":
            return library.scan();
          case "accept":
            return library.accept(ids(args[0]), text(args[1]));
          case "remove": {
            const selected = ids(args[0]);
            const rows = selected.map((id) => library.get(id));
            const confirmed = await dialog.showMessageBox(window, {
              type: "warning",
              title: "Permanently delete files?",
              message: `Delete ${rows.length} selected file(s) from disk?`,
              detail:
                rows
                  .slice(0, 12)
                  .map((row) => row.name)
                  .join("\n") +
                (rows.length > 12
                  ? "\nAdditional selected files are included."
                  : ""),
              buttons: ["Cancel", "Delete permanently"],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            });
            return confirmed.response === 1
              ? library.remove(selected)
              : { succeeded: [], errors: [] };
          }
          case "exportFiles": {
            const selected = ids(args[0]);
            const result = await dialog.showOpenDialog(window, {
              title: "Save selected files to",
              properties: ["openDirectory", "createDirectory"],
            });
            return !result.canceled
              ? library.exportFiles(selected, result.filePaths[0])
              : { succeeded: [], errors: [] };
          }
          case "rename":
            ids([args[0]]);
            return library.rename(text(args[0]), text(args[1]));
          case "update": {
            const patch = args[1];
            if (!patch || typeof patch !== "object" || Array.isArray(patch))
              throw new Error("Invalid metadata patch.");
            return library.update(ids(args[0]), patch as MediaPatch);
          }
          case "createFolder":
            return library.createFolder(text(args[0]), text(args[1]));
          case "renameFolder":
            return library.renameFolder(text(args[0]), text(args[1]));
          case "removeFolder": {
            const id = text(args[0]);
            const folder = library.folders().find((item) => item.id === id);
            if (!folder || id === "root")
              throw new Error("Select a removable folder.");
            const confirmed = await dialog.showMessageBox(window, {
              type: "warning",
              message: `Permanently delete “${folder.name}” and all its contents?`,
              detail:
                "This deletes the folder, all files and subfolders from disk, including unindexed contents, and their gallery records.",
              buttons: ["Cancel", "Delete folder and contents"],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            });
            if (confirmed.response === 1) await library.removeFolder(id);
            return;
          }
          case "saveSettings": {
            if (!args[0] || typeof args[0] !== "object")
              throw new Error("Invalid settings.");
            const previous = library.settings().importPath;
            await library.saveSettings(args[0] as Settings);
            if (previous !== library.settings().importPath) watchInput();
            return;
          }
          case "chooseDirectory": {
            const result = await dialog.showOpenDialog(window, {
              properties: ["openDirectory", "createDirectory"],
            });
            return result.canceled ? null : result.filePaths[0];
          }
          default:
            throw new Error("Unknown application operation.");
        }
      },
    );
    watchInput();
    if (process.env.CAMVIEWER_DEV_URL) {
      const url = new URL(process.env.CAMVIEWER_DEV_URL);
      if (url.hostname !== "127.0.0.1" || url.protocol !== "http:")
        throw new Error("Development URL must be local.");
      await window.loadURL(url.href);
    } else await window.loadFile(join(here, "..", "dist", "index.html"));
  })
  .catch((error) => {
    dialog.showErrorBox("CamViewer could not start", String(error));
    app.exit(1);
  });

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (quitting || !library) return;
  event.preventDefault();
  if (library.busy) {
    dialog.showMessageBoxSync({
      message:
        "A file operation is still running. Please wait for it to finish before quitting.",
      buttons: ["OK"],
    });
    return;
  }
  quitting = true;
  void Promise.resolve(watcher?.close())
    .then(() => library.close())
    .finally(() => app.quit());
});
