/**
 * E2E tests using Puppeteer against the Vite dev server with mocked Tauri APIs.
 *
 * Run:  npm run test:e2e
 */

import puppeteer from "puppeteer";
import { spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const PORT = 3334;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let browser;
let page;
let viteProcess;

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200) return;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

async function setup() {
  viteProcess = spawn(process.execPath, [resolve(ROOT, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(PORT), "--mode", "test"], {
    cwd: ROOT,
    stdio: "pipe",
    env: {
      ...process.env,
      VITE_MOCK: "true",
    },
  });

  viteProcess.stderr.on("data", d => process.stderr.write(d));

  await waitForServer(BASE_URL);

  // Ubuntu's AppArmor profile supports the runner's installed Chrome. Keep
  // its sandbox enabled instead of launching the unprofiled downloaded binary.
  const channel = process.env.GITHUB_ACTIONS === "true" && process.platform === "linux"
    ? "chrome" : undefined;
  console.log("Launching sandboxed browser", channel || "downloaded Chrome");
  browser = await puppeteer.launch({ headless: true, channel, timeout: 30000, protocolTimeout: 30000 });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on("pageerror", error => console.error("Browser error:", error.message));
  page.on("requestfailed", request => console.error("Request failed:", request.url(), request.failure()?.errorText));
  // Vite's development connections need not become idle for the UI to be ready.
  console.log("Browser version:", await browser.version());
  console.log("Navigating to", BASE_URL);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".app header", { timeout: 30000 });
}

async function teardown() {
  // A wedged browser must not keep a failed CI check running indefinitely.
  if (browser) {
    const process = browser.process();
    const timeout = setTimeout(() => process?.kill("SIGKILL"), 5000);
    try { await browser.close(); } finally { clearTimeout(timeout); }
  }
  if (viteProcess) {
    viteProcess.kill("SIGTERM");
    viteProcess.stdout.destroy();
    viteProcess.stderr.destroy();
    viteProcess.unref();
  }
}

async function run() {
  const results = { passed: 0, failed: 0, errors: [] };

  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      results.passed++;
    } catch (e) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
      results.failed++;
      results.errors.push({ name, error: e.message });
    }
  };

  console.log("\nE2E Tests:");

  await test("page title loads", async () => {
    const title = await page.title();
    if (!title) throw new Error("No page title");
  });

  await test("app root element is rendered", async () => {
    const root = await page.$("#root");
    if (!root) throw new Error("#root element not found");
  });

  await test("app container renders within 5 seconds", async () => {
    await page.waitForSelector(".app, #root > *", { timeout: 5000 });
  });

  await test("header element is present", async () => {
    const header = await page.$("header");
    if (!header) throw new Error("No <header> element found");
  });

  await test("sidebar is rendered", async () => {
    await page.waitForSelector("aside, .sidebar", { timeout: 5000 });
  });

  await test("ADB version text is present", async () => {
    await page.waitForSelector(".adb-version, header", { timeout: 5000 });
  });

  await test("main content area is rendered", async () => {
    await page.waitForSelector(".main-layout, .main-content, main", { timeout: 5000 });
  });

  return results;
}

(async () => {
  try {
    await setup();
    const results = await run();
    console.log(`\nResults: ${results.passed} passed, ${results.failed} failed`);
    if (results.failed > 0) {
      process.exitCode = 1;
    }
  } catch (e) {
    console.error("Fatal error:", e.message);
    process.exitCode = 1;
  } finally {
    await teardown();
  }
})();
