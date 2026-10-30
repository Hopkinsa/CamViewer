# CamViewer

An Electron desktop image and video library with an import-review queue, tags,
metadata editing, folders, search, pagination, and optional motion highlighting.

## Install and Run

Use Node.js 24.17 or newer and npm. From the repository root:

```sh
npm --prefix viewer ci
npm --prefix viewer run dev
```

The second command opens the Electron application and starts a local Vite server.
The browser URL alone is not the application: filesystem and database operations
require Electron's preload bridge. The English OCR model supplied in
`include/eng.traineddata` is bundled during builds.
Fonts and motion-analysis assets are local; no cloud service is required.

With npm 12, inspect blocked installation scripts using
`npm --prefix viewer install-scripts ls`. Approve the required packages and rebuild
them. For macOS ARM64 development environment:

```sh
npm --prefix viewer install-scripts approve electron esbuild ffmpeg-static @ffprobe-installer/darwin-arm64
npm --prefix viewer rebuild electron esbuild ffmpeg-static @ffprobe-installer/darwin-arm64
```

On other platforms use the installed `@ffprobe-installer` platform package shown
by npm, not the macOS example above. Native tools must match the target CPU.
Use normal TLS certificate verification when downloading dependencies; do not
disable it to work around certificate errors.

## Basic Usage

1. Choose **Import files**, or place completed media in the configured import
   directory. The watcher processes new files after they become stable; **Scan
   import folder** processes files already there.
2. Open **Review imports** to inspect dates, metadata, images, and videos.
   Valid embedded metadata repairs working-copy dates before any overlay OCR.
   Configure the overlay profile in Settings for files without usable metadata.
   Unknown or uncertain dates remain visible for manual review.
3. Select individual files, a page, or all matching results. Choose a destination
   folder and **Accept** to move reviewed files into the local gallery. Delete
   removes the selected working files only after native confirmation.
4. In **Local gallery**, search filenames, dates, tags, and metadata; filter by
   media type or date; sort results; and adjust thumbnail size. Selection can
   span pages. Changing the result set removes selections outside that set.
5. Use the inspector to rename a file, zoom or rotate an image, or play a video.
   Enable **Motion** for non-destructive movement boxes and their appearance
   controls. Playback speed and standard video controls are available.
   Double-click a file to replace the gallery panel with the full viewer and
   inspector. Its fixed 110px thumbnail ribbon contains the open file's folder,
   including files outside the current search/filter/page. Click a thumbnail to
   navigate, use the arrows or horizontal scrolling, and close with the X button.
6. **Edit metadata** changes selected database records. Tags are comma-separated;
   capture dates use UTC; the JSON editor replaces the metadata object when
   enabled. Clearing metadata clears the database fields, not embedded tags or
   the original media bytes.
7. **Save copies** exports the selected files and metadata sidecars to a native
   directory picker. Folder controls create, rename, or permanently delete
   folders and their contents. Folder deletion includes unindexed files and
   always requires confirmation.

In **Settings > Display Settings**, save the default gallery thumbnail size and
sort order, and toggle the page heading, toolbar, and status bar. These choices
persist in SQLite. Gallery thumbnail/sort controls make temporary adjustments;
they do not overwrite the saved defaults or resize the viewer ribbon. Settings
remains accessible in the header when sections are hidden.

Files imported through the picker from outside the import directory are copied;
their originals are retained. Successfully processed files inside the configured
import directory are consumed. Keep separate backups before bulk operations.

## Storage

When run from this source checkout, the workspace is the parent of `viewer/`:

| Directory | Contents                                                |
| --------- | ------------------------------------------------------- |
| `data/`   | SQLite settings/library/job journal and thumbnail cache |
| `in/`     | Incoming files, consumed after successful processing    |
| `out/`    | Processed files awaiting review                         |
| `files/`  | Accepted local gallery files and folders                |

These are workspace-relative paths, not filesystem-root paths. Packaged apps
default to a writable `workspace` inside Electron's user-data directory, never
inside the application bundle. `CAMVIEWER_WORKSPACE` overrides the workspace for
testing or a separate library. Media directories are configurable in Settings,
must be separate, and cannot contain one another or the database. Existing
gallery/review files prevent changing their roots without an explicit migration.

## Build and Check

```sh
npm --prefix viewer test
npm --prefix viewer run typecheck
npm --prefix viewer run build
npm --prefix viewer run test:desktop
npm --prefix viewer start
npm --prefix viewer run package
```

Desktop checks require a graphical session and use temporary copies of the
supplied fixtures. Screenshots are written to `viewer/test-results/`. Packaging
creates an unpacked application under `viewer/release/`. The macOS ARM64 bundle
was exercised with real imports, OCR, playback, motion analysis, and restart
persistence. It is unsigned and not notarized. Windows/Linux packaging and
creation-time behavior still require native platform verification; cross-platform
source support is not a claim that those distributions have been tested.

For a packaged-app regression, set `CAMVIEWER_PACKAGED_EXECUTABLE` to its actual
executable before running `test:desktop`. Build for each target OS/architecture
with the matching native tools rather than copying this machine's dependencies.

## Limits

Automatic date repair requires an explicit overlay flag, crop, date order, and
UTC offset. Plausible but incorrect clocks cannot be detected automatically.
macOS creation-time repair requires `SetFile`; Linux has no portable equivalent.
Unsupported Chromium codecs show an error, with no automatic transcoding.
Search and pagination currently operate on a full in-memory database snapshot;
very large libraries need indexed queries before production-scale use.
