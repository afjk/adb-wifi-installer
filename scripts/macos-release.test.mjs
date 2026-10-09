import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { mergeManifests } from "./merge-release-manifests.mjs";
import { validateAssets } from "./attach-release.mjs";
import { makeManifest } from "./release-metadata.mjs";

const date = "2026-10-08T00:00:00Z";
const winName = "ADB.WiFi.Installer_0.3.4_x64-setup.exe";
const win = makeManifest("0.3.4", winName, "fixture-windows", date);
const mac = arch => ({ version: "0.3.4", pub_date: date, platforms: { [`darwin-${arch}`]: {
  signature: `fixture-${arch}`, url: `https://github.com/afjk/adb-wifi-installer/releases/download/v0.3.4/ADB.WiFi.Installer_0.3.4_${arch}.app.tar.gz`,
} } });
test("merge preserves Windows and combines both Mac architectures", () => {
  const merged = mergeManifests([win, mac("aarch64"), mac("x86_64")]);
  assert.deepEqual(Object.keys(merged.platforms), ["windows-x86_64", "darwin-aarch64", "darwin-x86_64"]);
  assert.deepEqual(merged.platforms["windows-x86_64"], win.platforms["windows-x86_64"]);
  assert.deepEqual(mergeManifests([win]), win);
  assert.throws(() => mergeManifests([mac("aarch64")]));
  assert.throws(() => mergeManifests([win, win]));
  assert.throws(() => mergeManifests([win, { ...mac("aarch64"), version: "0.3.3" }]));
  assert.throws(() => mergeManifests([win, { ...mac("aarch64"), pub_date: "different" }]));
});
test("combined assets reject missing DMGs, unknown platforms and bad updater URLs", () => {
  const merged = mergeManifests([win, mac("aarch64"), mac("x86_64")]);
  const files = { [winName]: Buffer.from("fixture"), [`${winName}.sig`]: Buffer.from("fixture-windows") };
  for (const arch of ["aarch64", "x86_64"]) {
    const base = `ADB.WiFi.Installer_0.3.4_${arch}`;
    files[`${base}.app.tar.gz`] = Buffer.from("fixture");
    files[`${base}.app.tar.gz.sig`] = Buffer.from(`fixture-${arch}`);
    files[`${base}.dmg`] = Buffer.from("fixture");
  }
  const read = name => { assert.ok(files[name], "Missing asset"); return files[name]; };
  const names = validateAssets(merged, "0.3.4", read);
  assert.equal(names.length, 9);
  assert.equal(names.at(-1), "latest.json");
  delete files["ADB.WiFi.Installer_0.3.4_aarch64.dmg"];
  assert.throws(() => validateAssets(merged, "0.3.4", read));
  assert.throws(() => validateAssets({ ...win, platforms: { ...win.platforms, unknown: {} } }, "0.3.4", read));
  merged.platforms["darwin-aarch64"].url = "https://example.com/app";
  assert.throws(() => validateAssets(merged, "0.3.4", read));
});
for (const arch of ["aarch64", "x86_64"]) test(`Mac ${arch} staging renames Tauri archive, includes DMG, rejects absent updater signatures`, () => {
  const root = mkdtempSync(join(tmpdir(), "adb-mac-fixture-"));
  mkdirSync(join(root, "macos")); mkdirSync(join(root, "dmg"));
  const archive = join(root, "macos", "ADB WiFi Installer.app.tar.gz");
  writeFileSync(archive, "fixture archive");
  writeFileSync(join(root, "dmg", `ADB WiFi Installer_0.3.4_${arch === "x86_64" ? "x64" : arch}.dmg`), "fixture dmg");
  const event = join(root, "event.json");
  writeFileSync(event, JSON.stringify({ release: { published_at: date } }));
  const run = () => execFileSync(process.execPath, ["scripts/macos-release-metadata.mjs", "v0.3.4", arch, root, join(root, "out")], { env: { ...process.env, GITHUB_EVENT_PATH: event }, stdio: "pipe" });
  assert.throws(run);
  writeFileSync(`${archive}.sig`, `fixture-${arch}\n`);
  run();
  const manifest = JSON.parse(readFileSync(join(root, "out", `manifest-darwin-${arch}.json`)));
  assert.deepEqual(manifest.platforms, mac(arch).platforms);
});
test("Mac PRs need no secrets; release is opt-in, notarized, and published by a single writer", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  const pr = workflow.split("  macos-pr-build:")[1].split("  release-build:")[0];
  assert.doesNotMatch(pr, /secrets\.|contents: write|--no-sign/);
  assert.match(pr, /APPLE_SIGNING_IDENTITY: "-"/);
  assert.match(pr, /runner: macos-15\n/); assert.match(pr, /runner: macos-15-intel/);
  const release = workflow.split("  macos-release-build:")[1].split("  publish-release-assets:")[0];
  assert.match(release, /vars.MACOS_RELEASE_ENABLED == 'true'/);
  assert.match(release, /Missing required secret/);
  assert.match(release, /stapler validate/);
  assert.match(release, /spctl --assess/);
  assert.equal((workflow.match(/run: node scripts\/attach-release.mjs release-assets/g) || []).length, 1);
  assert.doesNotMatch(workflow, /--clobber|pull_request_target/);
});
