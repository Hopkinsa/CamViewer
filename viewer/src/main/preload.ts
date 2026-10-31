import { contextBridge, ipcRenderer } from "electron";
import type { API } from "../shared/types.ts";

const invoke = (method: string, ...args: unknown[]) =>
  ipcRenderer.invoke("camviewer:call", method, args);
const api: API = {
  snapshot: (query) => invoke("snapshot", query),
  query: (query) => invoke("query", query),
  matchingIds: (query, selectedIds) =>
    invoke("matchingIds", query, selectedIds),
  getMedia: (id) => invoke("getMedia", id),
  settings: () => invoke("settings"),
  importFiles: () => invoke("importFiles"),
  scan: () => invoke("scan"),
  accept: (ids, folderId) => invoke("accept", ids, folderId),
  remove: (ids) => invoke("remove", ids),
  exportFiles: (ids) => invoke("exportFiles", ids),
  rename: (id, name) => invoke("rename", id, name),
  update: (ids, patch) => invoke("update", ids, patch),
  createFolder: (name, parentId) => invoke("createFolder", name, parentId),
  renameFolder: (id, name) => invoke("renameFolder", id, name),
  removeFolder: (id) => invoke("removeFolder", id),
  saveSettings: (settings) => invoke("saveSettings", settings),
  chooseDirectory: () => invoke("chooseDirectory"),
  onChange: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("camviewer:changed", listener);
    return () => {
      ipcRenderer.removeListener("camviewer:changed", listener);
    };
  },
};
contextBridge.exposeInMainWorld("camviewer", api);
