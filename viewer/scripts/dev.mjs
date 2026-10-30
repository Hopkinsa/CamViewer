import { createServer } from "vite";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import electron from "electron";
import "./assets.mjs";

await build({
  entryPoints: ["src/main/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: "dist-electron/main.js",
});
await build({
  entryPoints: ["src/main/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: "dist-electron/preload.cjs",
});
const server = await createServer({
  server: { port: 5173, strictPort: false },
});
await server.listen();
server.printUrls();
const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, CAMVIEWER_DEV_URL: server.resolvedUrls.local[0] },
});
child.once("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
