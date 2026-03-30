import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.js"],
    globals: true,
    include: ["src/__tests__/**/*.{test,spec}.{js,jsx}"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    alias: {
      "@tauri-apps/api/core": resolve(__dirname, "src/__mocks__/@tauri-apps/api/core.js"),
      "@tauri-apps/api/event": resolve(__dirname, "src/__mocks__/@tauri-apps/api/event.js"),
      "@tauri-apps/api/webview": resolve(__dirname, "src/__mocks__/@tauri-apps/api/webview.js"),
      "@tauri-apps/plugin-dialog": resolve(__dirname, "src/__mocks__/@tauri-apps/plugin-dialog.js"),
      "@tauri-apps/plugin-opener": resolve(__dirname, "src/__mocks__/@tauri-apps/plugin-opener.js"),
    },
  },
});
