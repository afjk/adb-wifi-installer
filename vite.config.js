import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const host = process.env.TAURI_DEV_HOST;
const isMockMode = process.env.VITE_MOCK === "true";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // In mock/test mode, alias Tauri APIs to mock implementations
  resolve: isMockMode ? {
    alias: {
      "@tauri-apps/api/core": resolve(__dirname, "src/__mocks__/@tauri-apps/api/core-vite.js"),
      "@tauri-apps/api/event": resolve(__dirname, "src/__mocks__/@tauri-apps/api/event-vite.js"),
      "@tauri-apps/api/webview": resolve(__dirname, "src/__mocks__/@tauri-apps/api/webview-vite.js"),
      "@tauri-apps/plugin-dialog": resolve(__dirname, "src/__mocks__/@tauri-apps/plugin-dialog-vite.js"),
      "@tauri-apps/plugin-opener": resolve(__dirname, "src/__mocks__/@tauri-apps/plugin-opener-vite.js"),
    },
  } : undefined,

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: isMockMode ? 3334 : 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
