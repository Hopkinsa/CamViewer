# CamViewer

An Electron desktop image and video library with an import-review queue, tags,
metadata editing, folders, search, pagination, and optional motion highlighting.

See the [Full README](viewer/README.md) for more detailed information.

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
them. For this macOS ARM64 development environment:

```sh
npm --prefix viewer install-scripts approve electron esbuild ffmpeg-static @ffprobe-installer/darwin-arm64
npm --prefix viewer rebuild electron esbuild ffmpeg-static @ffprobe-installer/darwin-arm64
```

On other platforms use the installed `@ffprobe-installer` platform package shown
by npm, not the macOS example above. Native tools must match the target CPU.
Use normal TLS certificate verification when downloading dependencies; do not
disable it to work around certificate errors.
