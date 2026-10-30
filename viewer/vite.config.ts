import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  optimizeDeps: { include: ["@techstark/opencv-js"] },
  server: { host: "127.0.0.1", strictPort: true, port: 5173 },
});
