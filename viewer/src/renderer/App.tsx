import { useDeferredValue, useEffect, useRef, useState } from "react";
import {
  Aperture,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Inbox,
  Library,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Video,
  X,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Maximize,
} from "lucide-react";
import type {
  BatchResult,
  Media,
  MediaPatch,
  Settings,
  SortBy,
  Snapshot,
  View,
} from "../shared/types";
import { MotionPlayer } from "./MotionPlayer";

const api = window.camviewer;
const bytes = (value: number) =>
  value > 1e6
    ? `${(value / 1e6).toFixed(1)} MB`
    : `${Math.round(value / 1024)} KB`;
const dateLabel = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Date needs review";

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>("gallery");
  const [folder, setFolder] = useState("root");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sort, setSort] = useState<SortBy>("date");
  const [viewerOpen, setViewerOpen] = useState(false);
  const [kind, setKind] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filters, setFilters] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(180);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [modal, setModal] = useState<{
    type: "folder" | "rename" | "renameFolder";
    value: string;
  } | null>(null);
  const [editor, setEditor] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const anchor = useRef<string | null>(null);
  const ribbonRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    if (api) {
      const next = await api.snapshot();
      setSnapshot(next);
    }
  };
  useEffect(() => {
    if (!api) {
      setError(
        "Open CamViewer in the desktop application to access your library.",
      );
      return;
    }
    void api
      .snapshot()
      .then((next) => {
        setSnapshot(next);
        setSize(next.settings.thumbnailSize);
        setSort(next.settings.defaultSort);
      })
      .catch((failure) => setError(String(failure)));
    return api.onChange(() => {
      void refresh();
    });
  }, []);
  useEffect(() => {
    setPage(0);
  }, [view, folder, deferredQuery, sort, kind, from, to]);

  const all = snapshot?.media ?? [];
  const matches = all
    .filter(
      (item) =>
        item.state === view &&
        (view === "review" || folder === "root" || item.folderId === folder) &&
        (kind === "all" || item.kind === kind) &&
        (!from ||
          (item.captureDate && item.captureDate.slice(0, 10) >= from)) &&
        (!to || (item.captureDate && item.captureDate.slice(0, 10) <= to)) &&
        `${item.name} ${item.tags.join(" ")} ${JSON.stringify(item.metadata)} ${item.captureDate ?? ""}`
          .toLocaleLowerCase()
          .includes(deferredQuery.toLocaleLowerCase()),
    )
    .sort((first, second) => {
      const value =
        sort === "name"
          ? first.name.localeCompare(second.name, undefined, { numeric: true })
          : sort === "tag"
            ? (first.tags.slice().sort()[0] ?? "\uffff").localeCompare(
                second.tags.slice().sort()[0] ?? "\uffff",
              )
            : sort === "imported"
              ? second.importedAt.localeCompare(first.importedAt)
              : (second.captureDate ?? "").localeCompare(
                  first.captureDate ?? "",
                );
      return value || first.id.localeCompare(second.id);
    });
  const pageSize = snapshot?.settings.pageSize ?? 60;
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  const actualPage = Math.min(page, pages - 1);
  const visible = matches.slice(
    actualPage * pageSize,
    (actualPage + 1) * pageSize,
  );
  const selectedIds = selection.filter((id) =>
    matches.some((item) => item.id === id),
  );
  const current =
    all.find((item) => item.id === focused && item.state === view) ?? null;
  const viewing = viewerOpen && !!current;
  const display = snapshot?.settings.display ?? {
    pageHeading: true,
    toolbar: true,
    statusbar: true,
  };
  const ribbonFiles = all
    .filter(
      (item) =>
        item.state === view &&
        (view === "review" || item.folderId === current?.folderId),
    )
    .sort((first, second) => {
      const value =
        sort === "name"
          ? first.name.localeCompare(second.name, undefined, { numeric: true })
          : sort === "tag"
            ? (first.tags.slice().sort()[0] ?? "\uffff").localeCompare(
                second.tags.slice().sort()[0] ?? "\uffff",
              )
            : sort === "imported"
              ? second.importedAt.localeCompare(first.importedAt)
              : (second.captureDate ?? "").localeCompare(
                  first.captureDate ?? "",
                );
      return value || first.id.localeCompare(second.id);
    });
  const editorIds = viewing && current ? [current.id] : selectedIds;
  useEffect(() => {
    if (viewerOpen && !current) setViewerOpen(false);
    if (viewerOpen && focused)
      ribbonRef.current
        ?.querySelector(`[data-media-id="${focused}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [viewerOpen, focused, current?.id]);
  const activeFolder = snapshot?.folders.find((item) => item.id === folder);
  const counts = {
    gallery: all.filter((item) => item.state === "gallery").length,
    review: all.filter((item) => item.state === "review").length,
  };
  const running =
    snapshot?.jobs.some((job) => job.state === "running") ?? false;

  async function perform(task: () => Promise<unknown>, success = "") {
    if (!api) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = (await task()) as BatchResult | undefined;
      if (result?.errors?.length)
        setError(result.errors.map((item) => item.message).join("\n"));
      else if (success) setNotice(success);
      await refresh();
    } catch (failure) {
      setError(String(failure instanceof Error ? failure.message : failure));
    } finally {
      setBusy(false);
    }
  }
  function changeView(next: View) {
    setViewerOpen(false);
    setView(next);
    setSelection([]);
    setFocused(null);
    setNavOpen(false);
  }
  function choose(item: Media, event: React.MouseEvent | React.KeyboardEvent) {
    setFocused(item.id);
    setInspectorOpen(true);
    if (event.shiftKey && anchor.current) {
      const start = matches.findIndex((row) => row.id === anchor.current);
      const end = matches.findIndex((row) => row.id === item.id);
      setSelection(
        matches
          .slice(Math.max(0, Math.min(start, end)), Math.max(start, end) + 1)
          .map((row) => row.id),
      );
    } else if (event.metaKey || event.ctrlKey)
      setSelection((previous) =>
        previous.includes(item.id)
          ? previous.filter((id) => id !== item.id)
          : [...previous, item.id],
      );
    else {
      setSelection([item.id]);
      anchor.current = item.id;
    }
  }
  async function submitName(event: React.FormEvent) {
    event.preventDefault();
    if (!modal || !api) return;
    const target = modal;
    setModal(null);
    await perform(() =>
      target.type === "folder"
        ? api.createFolder(target.value, folder)
        : target.type === "renameFolder"
          ? api.renameFolder(folder, target.value)
          : api.rename(current!.id, target.value),
    );
  }
  const clearSelection = () => {
    setSelection([]);
    setFocused(null);
  };

  return (
    <div className="app">
      <header className="app-header">
        <button
          className="icon mobile-nav"
          title="Open navigation"
          onClick={() => setNavOpen(!navOpen)}
        >
          <Menu size={20} />
        </button>
        <div className="brand">
          <Aperture size={26} strokeWidth={1.7} />
          <span>
            CamViewer<span className="brand-dot">.</span>
          </span>
        </div>
        <span className="workspace-label">LOCAL LIBRARY</span>
        <div className="header-actions">
          {!display.pageHeading && (
            <button
              className="icon"
              title="Import files"
              disabled={busy || running || !api}
              onClick={() => void perform(() => api!.importFiles())}
            >
              <Plus size={19} />
            </button>
          )}
          <button
            className={`icon ${activityOpen ? "active" : ""}`}
            title="Activity"
            onClick={() => setActivityOpen(!activityOpen)}
          >
            <span className={running ? "status-dot working" : "status-dot"} />
          </button>
          <button
            className="icon"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={19} />
          </button>
          <div className="avatar">CV</div>
        </div>
      </header>
      <div className="workspace">
        <aside className={`sidebar ${navOpen ? "nav-open" : ""}`}>
          <div className="sidebar-top">
            <span className="section-label">WORKSPACE</span>
            <button
              className="icon small"
              title="Refresh library"
              disabled={busy}
              onClick={() => void perform(refresh)}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <nav>
            <button
              className={`nav-item ${view === "gallery" ? "selected" : ""}`}
              onClick={() => changeView("gallery")}
            >
              <Library size={18} />
              <span>Local gallery</span>
              <span className="count">{counts.gallery}</span>
            </button>
            <button
              className={`nav-item ${view === "review" ? "selected" : ""}`}
              onClick={() => changeView("review")}
            >
              <Inbox size={18} />
              <span>Review imports</span>
              <span className={`count ${counts.review ? "count-accent" : ""}`}>
                {counts.review}
              </span>
            </button>
          </nav>
          <div className="sidebar-top folder-heading">
            <span className="section-label">FOLDERS</span>
            <button
              className="icon small"
              title="New folder"
              disabled={busy}
              onClick={() => setModal({ type: "folder", value: "" })}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="folder-list">
            {(
              snapshot?.folders ?? [
                { id: "root", name: "All files", relativePath: "" },
              ]
            ).map((item) => (
              <button
                key={item.id}
                className={`folder-item ${folder === item.id && view === "gallery" ? "chosen" : ""}`}
                style={{
                  paddingLeft:
                    12 +
                    item.relativePath.split(/[/\\]/).filter(Boolean).length * 9,
                }}
                onClick={() => {
                  setFolder(item.id);
                  changeView("gallery");
                }}
              >
                <Folder size={16} />
                <span>{item.name}</span>
                {item.id === "root" && (
                  <span className="muted">{counts.gallery}</span>
                )}
              </button>
            ))}
          </div>
          {folder !== "root" && view === "gallery" && (
            <div className="folder-tools">
              <button
                className="icon small"
                title="Rename folder"
                onClick={() =>
                  setModal({
                    type: "renameFolder",
                    value: activeFolder?.name ?? "",
                  })
                }
              >
                <Pencil size={14} />
              </button>
              <button
                className="icon small danger"
                title="Delete folder and contents"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await api!.removeFolder(folder);
                    setFolder("root");
                  })
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          )}
          <div className="sidebar-bottom">
            <div className="local-mark">
              <span className="status-dot" />
              Stored on this computer
            </div>
            <button
              className="secondary import-sidebar"
              disabled={busy}
              onClick={() =>
                void perform(() => api!.scan(), "Import folder scanned.")
              }
            >
              <FolderOpen size={16} />
              Scan import folder
            </button>
            <span
              className="storage-path"
              title={snapshot?.settings.importPath}
            >
              {snapshot?.settings.importPath ?? "No workspace connected"}
            </span>
          </div>
        </aside>
        <main
          className={viewing ? "viewer-screen" : "main-panel"}
          aria-label={viewing ? "File viewer" : undefined}
        >
          <div
            className="page-heading"
            hidden={viewing || !display.pageHeading}
          >
            <div>
              <div className="eyebrow">
                YOUR COLLECTION / {view === "review" ? "INCOMING" : "LIBRARY"}
              </div>
              <h1>
                {view === "review"
                  ? "Review imports"
                  : folder === "root"
                    ? "Local gallery"
                    : (activeFolder?.name ?? "Local gallery")}
              </h1>
              <p>
                {view === "review"
                  ? `${counts.review} files awaiting your review`
                  : `${counts.gallery} files in your library`}
              </p>
            </div>
            <button
              className="primary"
              disabled={busy || running || !api}
              onClick={() => void perform(() => api!.importFiles())}
            >
              {busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <Plus size={18} />
              )}
              Import files
            </button>
          </div>
          {(error || notice) && (
            <div
              className={`notice ${error ? "error" : ""}`}
              role={error ? "alert" : "status"}
            >
              <CircleAlert size={16} />
              <span>{error || notice}</span>
              <button
                className="icon small"
                title="Dismiss message"
                onClick={() => {
                  setError("");
                  setNotice("");
                }}
              >
                <X size={14} />
              </button>
            </div>
          )}
          <div className="toolbar" hidden={viewing || !display.toolbar}>
            <label className="search">
              <Search size={17} />
              <input
                placeholder="Search files, tags, metadata…"
                aria-label="Search library"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button
                  className="icon small"
                  title="Clear search"
                  onClick={() => setQuery("")}
                >
                  <X size={14} />
                </button>
              )}
            </label>
            <button
              className={`icon bordered ${filters ? "active" : ""}`}
              title="Filters"
              onClick={() => setFilters(!filters)}
            >
              <SlidersHorizontal size={17} />
            </button>
            <label className="sort-select">
              <span>Sort by</span>
              <select
                aria-label="Sort files"
                value={sort}
                onChange={(event) => setSort(event.target.value as SortBy)}
              >
                <option value="date">Capture date</option>
                <option value="name">Filename</option>
                <option value="tag">Tag</option>
                <option value="imported">Import date</option>
              </select>
            </label>
            <div className="size-control">
              <ImageIcon size={15} />
              <input
                type="range"
                min="100"
                max="320"
                step="10"
                aria-label="Thumbnail size"
                value={size}
                onChange={(event) => setSize(Number(event.target.value))}
              />
              <ImageIcon size={21} />
            </div>
            <button
              className={`icon bordered ${inspectorOpen ? "active" : ""}`}
              title="Toggle inspector"
              onClick={() => setInspectorOpen(!inspectorOpen)}
            >
              <MoreHorizontal size={18} />
            </button>
          </div>
          {filters && !viewing && display.toolbar && (
            <div className="filter-bar">
              <select
                aria-label="Media type"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                <option value="all">All media</option>
                <option value="image">Images</option>
                <option value="video">Videos</option>
              </select>
              <label>
                From
                <input
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              </label>
              <button
                className="text-button"
                onClick={() => {
                  setKind("all");
                  setFrom("");
                  setTo("");
                }}
              >
                Clear filters
              </button>
            </div>
          )}
          <div className="selection-bar" hidden={viewing}>
            <span>
              {selectedIds.length
                ? `${selectedIds.length} selected${selectedIds.length === matches.length && matches.length > visible.length ? " across all pages" : ""}`
                : `${matches.length} ${matches.length === 1 ? "file" : "files"}`}
            </span>
            <div>
              <button
                className="text-button"
                onClick={() => setSelection(visible.map((item) => item.id))}
              >
                Select page
              </button>
              <button
                className="text-button"
                onClick={() => setSelection(matches.map((item) => item.id))}
              >
                Select all matching
              </button>
              {selectedIds.length > 0 && (
                <button className="text-button" onClick={clearSelection}>
                  Clear
                </button>
              )}
            </div>
          </div>
          <div
            className={`collection ${viewing ? "viewer-top" : inspectorOpen ? "" : "inspector-hidden"}`}
          >
            <section
              className={viewing ? "viewer-media" : "grid-area"}
              aria-label={
                view === "review" ? "Processed files" : "Gallery files"
              }
            >
              {viewing && current ? (
                <FilePreview
                  key={current.id}
                  media={current}
                  reportError={setError}
                />
              ) : visible.length ? (
                <div
                  className="media-grid"
                  style={{
                    gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${size}px), 1fr))`,
                  }}
                >
                  {visible.map((item) => (
                    <button
                      key={item.id}
                      className={`media-card ${selectedIds.includes(item.id) ? "is-selected" : ""}`}
                      onClick={(event) => choose(item, event)}
                      onDoubleClick={() => {
                        setFocused(item.id);
                        setSelection([item.id]);
                        setViewerOpen(true);
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key === "ArrowRight" ||
                          event.key === "ArrowLeft"
                        ) {
                          event.preventDefault();
                          const next =
                            matches[
                              matches.indexOf(item) +
                                (event.key === "ArrowRight" ? 1 : -1)
                            ];
                          if (next) choose(next, event);
                        }
                      }}
                      aria-pressed={selectedIds.includes(item.id)}
                      title={item.name}
                    >
                      <span className="thumb">
                        <img
                          src={item.thumbnail}
                          alt=""
                          loading="lazy"
                          onError={(event) => {
                            event.currentTarget.style.visibility = "hidden";
                          }}
                        />
                        <span className="selection-check">
                          {selectedIds.includes(item.id) && <Check size={13} />}
                        </span>
                        {item.kind === "video" && (
                          <span className="video-badge">
                            <Video size={12} />
                            {Math.floor(item.duration / 60)}:
                            {String(Math.floor(item.duration % 60)).padStart(
                              2,
                              "0",
                            )}
                          </span>
                        )}
                        {item.warnings.length > 0 && (
                          <span
                            className="warning-badge"
                            title="Review metadata warnings"
                          >
                            <CircleAlert size={13} />
                          </span>
                        )}
                      </span>
                      <span className="card-name">{item.name}</span>
                      <span className="card-meta">
                        {item.captureDate
                          ? new Date(item.captureDate).toLocaleDateString(
                              undefined,
                              {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              },
                            )
                          : "Date unknown"}
                        <span>{item.kind === "image" ? "IMAGE" : "VIDEO"}</span>
                      </span>
                      <span className="card-tags">
                        {item.tags.slice(0, 2).map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                        {item.tags.length > 2 && (
                          <small>+{item.tags.length - 2}</small>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <div className="empty-mark">
                    {view === "review" ? (
                      <Inbox size={34} strokeWidth={1.3} />
                    ) : (
                      <Aperture size={38} strokeWidth={1.3} />
                    )}
                  </div>
                  <h2>
                    {query || from || to || kind !== "all"
                      ? "No matching files"
                      : view === "review"
                        ? "Your review queue is clear"
                        : "Your collection starts here"}
                  </h2>
                  <p>
                    {view === "review"
                      ? "Imported files will appear here before joining your gallery."
                      : "Import images and videos to begin your local collection."}
                  </p>
                  <button
                    className="secondary"
                    disabled={busy || !api}
                    onClick={() => void perform(() => api!.importFiles())}
                  >
                    <Plus size={16} />
                    Import files
                  </button>
                </div>
              )}
            </section>
            {(inspectorOpen || viewing) && (
              <aside
                className={`inspector ${current ? "has-current" : ""} ${viewing ? "viewer-inspector" : ""}`}
              >
                <div className="inspector-heading">
                  <span className="section-label">
                    {current ? "FILE INSPECTOR" : "INSPECTOR"}
                  </span>
                  <button
                    hidden={viewing}
                    className="icon small"
                    title="Close inspector"
                    onClick={() => setInspectorOpen(false)}
                  >
                    <X size={15} />
                  </button>
                </div>
                {current ? (
                  <>
                    {!viewing && (
                      <FilePreview
                        key={current.id}
                        media={current}
                        reportError={setError}
                      />
                    )}
                    <div className="inspector-content">
                      <div className="file-title">
                        <h2>{current.name}</h2>
                        <button
                          className="icon small"
                          title="Rename file"
                          disabled={busy}
                          onClick={() =>
                            setModal({ type: "rename", value: current.name })
                          }
                        >
                          <Pencil size={15} />
                        </button>
                      </div>
                      <p className="file-type">
                        {current.kind.toUpperCase()} · {bytes(current.size)}
                      </p>
                      <dl className="facts">
                        <div>
                          <dt>Captured</dt>
                          <dd>{dateLabel(current.captureDate)}</dd>
                        </div>
                        <div>
                          <dt>Date source</dt>
                          <dd>{current.dateSource}</dd>
                        </div>
                        <div>
                          <dt>Dimensions</dt>
                          <dd>
                            {current.width} × {current.height}
                          </dd>
                        </div>
                        {current.kind === "video" && (
                          <div>
                            <dt>Duration</dt>
                            <dd>{current.duration.toFixed(1)} seconds</dd>
                          </div>
                        )}
                        <div>
                          <dt>Imported</dt>
                          <dd>{dateLabel(current.importedAt)}</dd>
                        </div>
                      </dl>
                      <div className="inspector-section">
                        <div className="section-line">
                          <span className="section-label">TAGS & METADATA</span>
                          <button
                            className="icon small"
                            title="Edit selected metadata"
                            onClick={() => {
                              if (current) setSelection([current.id]);
                              setEditor(true);
                            }}
                          >
                            <Pencil size={14} />
                          </button>
                        </div>
                        <div className="tag-list">
                          {current.tags.length ? (
                            current.tags.map((tag) => (
                              <span className="tag" key={tag}>
                                {tag}
                              </span>
                            ))
                          ) : (
                            <span className="muted">No tags added</span>
                          )}
                        </div>
                      </div>
                      {current.warnings.length > 0 && (
                        <div className="warnings">
                          {current.warnings.map((warning, index) => (
                            <p key={index}>
                              <CircleAlert size={13} />
                              {warning}
                            </p>
                          ))}
                        </div>
                      )}
                      <details className="raw-metadata">
                        <summary>
                          Extracted metadata <ChevronDown size={14} />
                        </summary>
                        <pre>{JSON.stringify(current.metadata, null, 2)}</pre>
                      </details>
                    </div>
                  </>
                ) : (
                  <div className="inspector-empty">
                    <ImageIcon size={29} strokeWidth={1.2} />
                    <p>Select a file</p>
                    <span>Preview and metadata</span>
                  </div>
                )}
              </aside>
            )}
          </div>
          {viewing && current && (
            <div className="viewer-bottom">
              <button
                className="icon bordered"
                title="Scroll ribbon left"
                onClick={() =>
                  ribbonRef.current?.scrollBy({
                    left: -360,
                    behavior: "smooth",
                  })
                }
              >
                <ChevronLeft size={19} />
              </button>
              <div
                className="file-ribbon"
                ref={ribbonRef}
                role="navigation"
                aria-label="Files in folder"
              >
                {ribbonFiles.map((item) => (
                  <button
                    key={item.id}
                    data-media-id={item.id}
                    className={`ribbon-item ${current.id === item.id ? "is-current" : ""}`}
                    aria-current={current.id === item.id ? "true" : undefined}
                    title={item.name}
                    onClick={() => {
                      setFocused(item.id);
                      setSelection([item.id]);
                    }}
                  >
                    <span className="ribbon-thumb">
                      <img src={item.thumbnail} alt="" loading="lazy" />
                      {item.kind === "video" && <Video size={14} />}
                    </span>
                    <span>{item.name}</span>
                  </button>
                ))}
              </div>
              <button
                className="icon bordered"
                title="Scroll ribbon right"
                onClick={() =>
                  ribbonRef.current?.scrollBy({ left: 360, behavior: "smooth" })
                }
              >
                <ChevronRight size={19} />
              </button>
              <button
                className="icon bordered"
                title="Close viewer"
                onClick={() => setViewerOpen(false)}
              >
                <X size={19} />
              </button>
            </div>
          )}
          <footer className="collection-footer" hidden={viewing}>
            <span>
              {matches.length ? actualPage * pageSize + 1 : 0}–
              {Math.min((actualPage + 1) * pageSize, matches.length)} of{" "}
              {matches.length}
            </span>
            <div className="pagination">
              <button
                className="icon small"
                title="Previous page"
                disabled={actualPage === 0}
                onClick={() => setPage(actualPage - 1)}
              >
                <ChevronLeft size={17} />
              </button>
              <span>
                Page {actualPage + 1} of {pages}
              </span>
              <button
                className="icon small"
                title="Next page"
                disabled={actualPage + 1 >= pages}
                onClick={() => setPage(actualPage + 1)}
              >
                <ChevronRight size={17} />
              </button>
            </div>
          </footer>
          {!viewing && selectedIds.length > 0 && (
            <div className="batch-bar">
              <span>
                <CheckCheck size={17} />
                {selectedIds.length} selected
              </span>
              <div className="batch-actions">
                {view === "review" && (
                  <>
                    <select
                      aria-label="Accept into folder"
                      value={folder}
                      onChange={(event) => setFolder(event.target.value)}
                    >
                      {snapshot?.folders.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void perform(
                          () => api!.accept([...selectedIds], folder),
                          "Selected files accepted into the gallery.",
                        )
                      }
                    >
                      <Check size={16} />
                      Accept
                    </button>
                  </>
                )}
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => setEditor(true)}
                >
                  <Pencil size={15} />
                  <span>Edit metadata</span>
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void perform(() => api!.exportFiles([...selectedIds]))
                  }
                >
                  <ArrowDownToLine size={16} />
                  <span>Save copies</span>
                </button>
                <button
                  className="icon danger"
                  title="Permanently delete selected files"
                  disabled={busy}
                  onClick={() =>
                    void perform(() => api!.remove([...selectedIds]))
                  }
                >
                  <Trash2 size={17} />
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
      <div className="statusbar" hidden={!display.statusbar}>
        <span>
          <span className={`status-dot ${running ? "working" : ""}`} />
          {busy || running
            ? (snapshot?.jobs.find((job) => job.state === "running")?.message ??
              "Working…")
            : "Library up to date"}
        </span>
        <button onClick={() => setActivityOpen(!activityOpen)}>
          Activity <ArrowRight size={12} />
        </button>
        <span className="status-right">CamViewer / Local-first</span>
      </div>
      {activityOpen && (
        <aside className="activity">
          <div className="section-line">
            <h2>Activity</h2>
            <button
              className="icon"
              title="Close activity"
              onClick={() => setActivityOpen(false)}
            >
              <X size={17} />
            </button>
          </div>
          {snapshot?.jobs.length ? (
            snapshot.jobs.map((job) => (
              <div className={`job ${job.state}`} key={job.id}>
                <span>
                  {job.state === "running" ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : job.state === "failed" ? (
                    <CircleAlert size={15} />
                  ) : (
                    <Check size={15} />
                  )}
                </span>
                <div>
                  <p>{job.message}</p>
                  <small>{dateLabel(job.createdAt)}</small>
                </div>
              </div>
            ))
          ) : (
            <p className="muted">No recent activity</p>
          )}
        </aside>
      )}
      {settingsOpen && snapshot && (
        <SettingsDialog
          settings={snapshot.settings}
          close={() => setSettingsOpen(false)}
          save={(value) =>
            perform(async () => {
              await api!.saveSettings(value);
              setSize(value.thumbnailSize);
              setSort(value.defaultSort);
              setSettingsOpen(false);
            })
          }
        />
      )}
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <form
            className="dialog compact"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => void submitName(event)}
          >
            <div className="dialog-heading">
              <h2>
                {modal.type === "folder"
                  ? "New folder"
                  : modal.type === "renameFolder"
                    ? "Rename folder"
                    : "Rename file"}
              </h2>
              <button
                className="icon"
                type="button"
                title="Close dialog"
                onClick={() => setModal(null)}
              >
                <X size={18} />
              </button>
            </div>
            <label>
              Name
              <input
                autoFocus
                required
                value={modal.value}
                onChange={(event) =>
                  setModal({ ...modal, value: event.target.value })
                }
              />
            </label>
            <div className="dialog-actions">
              <button
                className="secondary"
                type="button"
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button className="primary" type="submit">
                Save
              </button>
            </div>
          </form>
        </div>
      )}
      {editor && editorIds.length > 0 && (
        <MetadataDialog
          media={all.filter((item) => editorIds.includes(item.id))}
          close={() => setEditor(false)}
          save={(patch) =>
            perform(async () => {
              await api!.update([...editorIds], patch);
              setEditor(false);
            })
          }
        />
      )}
    </div>
  );
}

function SettingsDialog({
  settings,
  close,
  save,
}: {
  settings: Settings;
  close: () => void;
  save: (value: Settings) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [tab, setTab] = useState<"library" | "display">("library");
  return (
    <div className="modal-backdrop">
      <form
        className="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void save(draft);
        }}
      >
        <div className="dialog-heading">
          <div>
            <div className="eyebrow">PREFERENCES</div>
            <h2>Library settings</h2>
          </div>
          <button
            className="icon"
            type="button"
            title="Close settings"
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        <div
          className="preferences-tabs"
          role="tablist"
          aria-label="Preferences sections"
        >
          <button
            type="button"
            role="tab"
            id="library-tab"
            aria-selected={tab === "library"}
            aria-controls="library-settings"
            onClick={() => setTab("library")}
          >
            <FolderOpen size={16} />
            Library
          </button>
          <button
            type="button"
            role="tab"
            id="display-tab"
            aria-selected={tab === "display"}
            aria-controls="display-settings"
            onClick={() => setTab("display")}
          >
            <SlidersHorizontal size={16} />
            Display Settings
          </button>
        </div>
        <div
          role="tabpanel"
          id="library-settings"
          aria-labelledby="library-tab"
          hidden={tab !== "library"}
        >
          <h3>Storage locations</h3>
          {(["importPath", "processedPath", "galleryPath"] as const).map(
            (key) => (
              <label key={key}>
                {key === "importPath"
                  ? "Import folder"
                  : key === "processedPath"
                    ? "Processed review folder"
                    : "Local gallery folder"}
                <div className="path-input">
                  <input
                    required
                    value={draft[key]}
                    onChange={(event) =>
                      setDraft({ ...draft, [key]: event.target.value })
                    }
                  />
                  <button
                    className="icon bordered"
                    type="button"
                    title="Choose directory"
                    onClick={async () => {
                      const path = await api!.chooseDirectory();
                      if (path) setDraft({ ...draft, [key]: path });
                    }}
                  >
                    <FolderOpen size={17} />
                  </button>
                </div>
              </label>
            ),
          )}
          <div className="form-row">
            <label>
              Files per page
              <select
                value={draft.pageSize}
                onChange={(event) =>
                  setDraft({ ...draft, pageSize: Number(event.target.value) })
                }
              >
                {[12, 24, 60, 120, 240].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          </div>
          <h3>Import overlay profile</h3>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.overlayEnabled}
              onChange={(event) =>
                setDraft({ ...draft, overlayEnabled: event.target.checked })
              }
            />
            Imported files contain a date/time overlay
          </label>
          <div className="form-row">
            <label>
              Date order
              <select
                value={draft.dateOrder}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    dateOrder: event.target.value as Settings["dateOrder"],
                  })
                }
              >
                <option>DMY</option>
                <option>MDY</option>
                <option>YMD</option>
              </select>
            </label>
            <label>
              UTC offset in minutes
              <input
                type="number"
                min="-840"
                max="840"
                value={draft.utcOffsetMinutes}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    utcOffsetMinutes: Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
          <div className="crop-fields">
            {(["x", "y", "width", "height"] as const).map((key) => (
              <label key={key}>
                Crop {key}
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.001"
                  value={draft.crop[key]}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      crop: {
                        ...draft.crop,
                        [key]: Number(event.target.value),
                      },
                    })
                  }
                />
              </label>
            ))}
          </div>
        </div>
        <div
          role="tabpanel"
          id="display-settings"
          aria-labelledby="display-tab"
          hidden={tab !== "display"}
        >
          <label>
            Default thumbnail size
            <input
              type="number"
              min="100"
              max="320"
              step="10"
              value={draft.thumbnailSize}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  thumbnailSize: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            Default sort by
            <select
              value={draft.defaultSort}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  defaultSort: event.target.value as SortBy,
                })
              }
            >
              <option value="date">Capture date</option>
              <option value="name">Filename</option>
              <option value="tag">Tag</option>
              <option value="imported">Import date</option>
            </select>
          </label>
          <h3>Visible sections</h3>
          {(
            [
              ["pageHeading", "Page heading"],
              ["toolbar", "Toolbar"],
              ["statusbar", "Status bar"],
            ] as const
          ).map(([key, label]) => (
            <label className="checkbox-row" key={key}>
              <input
                type="checkbox"
                checked={draft.display[key]}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    display: { ...draft.display, [key]: event.target.checked },
                  })
                }
              />
              {label}
            </label>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="secondary" type="button" onClick={close}>
            Cancel
          </button>
          <button className="primary" type="submit">
            <Check size={16} />
            Save settings
          </button>
        </div>
      </form>
    </div>
  );
}

function FilePreview({
  media,
  reportError,
}: {
  media: Media;
  reportError: (message: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const preview = useRef<HTMLDivElement>(null);
  return (
    <div className="media-preview">
      <div className="preview" ref={preview}>
        {media.kind === "image" ? (
          <div className="image-viewport">
            <img
              src={media.url}
              alt={media.name}
              style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
              onError={() =>
                reportError(
                  "Original image unavailable. Check the configured storage location.",
                )
              }
            />
          </div>
        ) : (
          <MotionPlayer media={media} />
        )}
      </div>
      {media.kind === "image" && (
        <div className="preview-controls">
          <button
            className="icon small"
            title="Zoom out"
            onClick={() => setZoom(Math.max(0.25, zoom - 0.25))}
          >
            <ZoomOut size={16} />
          </button>
          <button
            className="zoom-label"
            title="Fit image"
            onClick={() => {
              setZoom(1);
              setRotation(0);
            }}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            className="icon small"
            title="Zoom in"
            onClick={() => setZoom(Math.min(5, zoom + 0.25))}
          >
            <ZoomIn size={16} />
          </button>
          <button
            className="icon small"
            title="Rotate clockwise"
            onClick={() => setRotation(rotation + 90)}
          >
            <RotateCw size={16} />
          </button>
          <button
            className="icon small"
            title="Fullscreen image"
            onClick={() => void preview.current?.requestFullscreen()}
          >
            <Maximize size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function MetadataDialog({
  media,
  close,
  save,
}: {
  media: Media[];
  close: () => void;
  save: (patch: MediaPatch) => Promise<void>;
}) {
  const [tags, setTags] = useState(
    media.length === 1 ? media[0].tags.join(", ") : "",
  );
  const [metadata, setMetadata] = useState(
    media.length === 1 ? JSON.stringify(media[0].metadata, null, 2) : "{}",
  );
  const [date, setDate] = useState(
    media.length === 1 ? (media[0].captureDate?.slice(0, 19) ?? "") : "",
  );
  const [applyTags, setApplyTags] = useState(media.length === 1);
  const [applyMetadata, setApplyMetadata] = useState(media.length === 1);
  const [applyDate, setApplyDate] = useState(false);
  const [error, setError] = useState("");
  function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      const patch: MediaPatch = {};
      if (applyTags)
        patch.tags = tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
      if (applyMetadata) {
        const value = JSON.parse(metadata);
        if (!value || Array.isArray(value) || typeof value !== "object")
          throw new Error("Metadata must be a JSON object.");
        patch.metadata = value;
      }
      if (applyDate)
        patch.captureDate = date ? new Date(`${date}Z`).toISOString() : null;
      void save(patch);
    } catch (failure) {
      setError(String(failure));
    }
  }
  return (
    <div className="modal-backdrop">
      <form className="dialog" onSubmit={submit}>
        <div className="dialog-heading">
          <div>
            <div className="eyebrow">{media.length} SELECTED</div>
            <h2>Edit metadata</h2>
          </div>
          <button
            className="icon"
            type="button"
            title="Close metadata editor"
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={applyTags}
            onChange={(event) => setApplyTags(event.target.checked)}
          />
          Replace tags
        </label>
        <input
          aria-label="Tags separated by commas"
          placeholder="Woodland, Night, Camera 1"
          value={tags}
          disabled={!applyTags}
          onChange={(event) => setTags(event.target.value)}
        />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={applyDate}
            onChange={(event) => setApplyDate(event.target.checked)}
          />
          Set capture date (UTC)
        </label>
        <input
          aria-label="Capture date UTC"
          type="datetime-local"
          step="1"
          value={date}
          disabled={!applyDate}
          onChange={(event) => setDate(event.target.value)}
        />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={applyMetadata}
            onChange={(event) => setApplyMetadata(event.target.checked)}
          />
          Replace database metadata
        </label>
        <textarea
          aria-label="Metadata JSON"
          spellCheck={false}
          rows={10}
          value={metadata}
          disabled={!applyMetadata}
          onChange={(event) => setMetadata(event.target.value)}
        />
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="text-button danger"
            onClick={() => {
              if (
                window.confirm(
                  "Clear database metadata, tags and capture dates for the selected files? Embedded file metadata will remain unchanged.",
                )
              )
                void save({ clear: true });
            }}
          >
            Clear metadata
          </button>
          <button className="primary" type="submit">
            <Check size={16} />
            Save changes
          </button>
        </div>
      </form>
    </div>
  );
}
