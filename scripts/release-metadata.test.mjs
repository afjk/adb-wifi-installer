import { test } from "node:test";
import assert from "node:assert/strict";
import { checkVersions, makeManifest } from "./release-metadata.mjs";

test("all release version files and tag agree", () => {
  assert.equal(checkVersions(process.cwd(), "v0.3.4"), "0.3.4");
  assert.throws(() => checkVersions(process.cwd(), "v0.3.3"));
});
test("manifest uses exact release version, asset name and signature", () => {
  const manifest = makeManifest("0.3.4", "ADB.WiFi.Installer_0.3.4_x64-setup.exe", "synthetic-test-signature\n", "2026-10-08T00:00:00Z");
  assert.equal(manifest.version, "0.3.4");
  assert.equal(manifest.platforms["windows-x86_64"].signature, "synthetic-test-signature");
  assert.equal(manifest.platforms["windows-x86_64"].url, "https://github.com/afjk/adb-wifi-installer/releases/download/v0.3.4/ADB.WiFi.Installer_0.3.4_x64-setup.exe");
});
test("empty signatures and stale installer versions are rejected", () => {
  assert.throws(() => makeManifest("0.3.4", "ADB.WiFi.Installer_0.3.4_x64-setup.exe", " \n"));
  assert.throws(() => makeManifest("0.3.4", "ADB.WiFi.Installer_0.3.2_x64-setup.exe", "synthetic-test-signature"));
});

test("asset staging rejects missing signatures and produces matching output for valid fixtures", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "adb-release-test-"));
  const installer = "ADB WiFi Installer_0.3.4_x64-setup.exe";
  const output = join(dir, "output");
  writeFileSync(join(dir, installer), "synthetic installer fixture; never executed");
  const args = ["scripts/release-metadata.mjs", "v0.3.4", dir, output];
  assert.throws(() => execFileSync(process.execPath, args, { stdio: "pipe" }));
  writeFileSync(join(dir, installer + ".sig"), "synthetic-test-signature");
  execFileSync(process.execPath, args, { stdio: "pipe" });
  const manifest = JSON.parse(readFileSync(join(output, "latest.json"), "utf8"));
  assert.equal(manifest.platforms["windows-x86_64"].signature, "synthetic-test-signature");
  assert.equal(readFileSync(join(output, installer.replaceAll(" ", ".")), "utf8"), "synthetic installer fixture; never executed");
});
