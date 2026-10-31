export type View = "gallery" | "review";
export type SortBy = "date" | "name" | "tag" | "imported";
export interface Settings {
  importPath: string;
  processedPath: string;
  galleryPath: string;
  thumbnailSize: number;
  defaultSort: SortBy;
  display: { pageHeading: boolean; toolbar: boolean; statusbar: boolean };
  pageSize: number;
  overlayEnabled: boolean;
  dateOrder: "DMY" | "MDY" | "YMD";
  utcOffsetMinutes: number;
  crop: { x: number; y: number; width: number; height: number };
  motion: {
    sensitivity: number;
    padding: number;
    border: number;
    color: string;
    fill: string;
    opacity: number;
  };
}
export interface Media {
  id: string;
  name: string;
  kind: "image" | "video";
  state: View;
  folderId: string;
  size: number;
  width: number;
  height: number;
  duration: number;
  captureDate: string | null;
  dateSource: string;
  tags: string[];
  metadata: Record<string, unknown>;
  warnings: string[];
  importedAt: string;
  thumbnail: string;
  url: string;
}
export interface Folder {
  id: string;
  name: string;
  relativePath: string;
}
export interface Job {
  id: string;
  kind: string;
  state: string;
  message: string;
  createdAt: string;
}
export interface Snapshot {
  media: MediaSummary[];
  total: number;
  offset: number;
  counts: Record<View, number>;
  folders: Folder[];
  jobs: Job[];
  settings: Settings;
  workspace: string;
}
export type MediaSummary = Omit<Media, "metadata" | "warnings"> & {
  hasWarnings: boolean;
};
export interface MediaQuery {
  state?: View;
  folderId?: string;
  exactFolder?: boolean;
  kind?: "all" | "image" | "video";
  search?: string;
  from?: string;
  to?: string;
  sort?: SortBy;
  offset?: number;
  limit?: number;
  anchorId?: string;
}
export interface MediaPage {
  media: MediaSummary[];
  total: number;
  offset: number;
}
export interface BatchResult {
  succeeded: string[];
  errors: { id: string; message: string }[];
}
export interface MediaPatch {
  tags?: string[];
  metadata?: Record<string, unknown>;
  captureDate?: string | null;
  clear?: boolean;
}
export interface API {
  snapshot(query?: MediaQuery): Promise<Snapshot>;
  query(query: MediaQuery): Promise<MediaPage>;
  matchingIds(query: MediaQuery, selectedIds?: string[]): Promise<string[]>;
  getMedia(id: string): Promise<Media>;
  settings(): Promise<Settings>;
  importFiles(): Promise<void>;
  scan(): Promise<BatchResult>;
  accept(ids: string[], folderId: string): Promise<BatchResult>;
  remove(ids: string[]): Promise<BatchResult>;
  exportFiles(ids: string[]): Promise<BatchResult>;
  rename(id: string, name: string): Promise<void>;
  update(ids: string[], patch: MediaPatch): Promise<void>;
  createFolder(name: string, parentId: string): Promise<void>;
  renameFolder(id: string, name: string): Promise<void>;
  removeFolder(id: string): Promise<void>;
  saveSettings(settings: Settings): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  onChange(callback: () => void): () => void;
}
declare global {
  interface Window {
    camviewer?: API;
  }
}
