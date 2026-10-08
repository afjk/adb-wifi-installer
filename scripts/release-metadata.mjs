import { readFileSync, readdirSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

export function checkVersions(root, tag) {
  const read = p => readFileSync(join(root, p), "utf8");
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const cargo = read("src-tauri/Cargo.toml").match(/name = "adb-wifi-installer"\s+version = "([^"]+)"/)?.[1];
  const cargoLock = read("src-tauri/Cargo.lock").match(/name = "adb-wifi-installer"\s+version = "([^"]+)"/)?.[1];
  for (const version of [lock.version, lock.packages[""].version, tauri.version, cargo, cargoLock]) {
    assert.equal(version, pkg.version, "Release version files must agree");
  }
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  if (tag) assert.equal(tag, `v${pkg.version}`, "Tag must match the application version");
  return pkg.version;
}

export function makeManifest(version, fileName, signature, date = new Date().toISOString()) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(signature.trim(), "Updater signature must not be empty");
  assert.ok(fileName.endsWith(`_${version}_x64-setup.exe`), "Installer name must match release version");
  return {
    version,
    notes: "File deletion and file/folder drag-and-drop improvements. Windows x64 release.",
    pub_date: date,
    platforms: {
      "windows-x86_64": {
        signature: signature.trim(),
        url: `https://github.com/afjk/adb-wifi-installer/releases/download/v${version}/${encodeURIComponent(fileName)}`,
      },
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = checkVersions(process.cwd(), process.argv[2]);
  const bundleDir = process.argv[3];
  if (bundleDir) {
    const outputDir = process.argv[4];
    assert.ok(outputDir, "An output directory is required");
    const installers = readdirSync(bundleDir).filter(name => name.endsWith(`_${version}_x64-setup.exe`));
    assert.equal(installers.length, 1, "Expected exactly one version-matched NSIS installer");
    const sourceName = installers[0];
    const fileName = sourceName.replaceAll(" ", ".");
    const signature = readFileSync(join(bundleDir, `${sourceName}.sig`), "utf8");
    const manifest = makeManifest(version, fileName, signature);
    mkdirSync(outputDir, { recursive: true });
    copyFileSync(join(bundleDir, sourceName), join(outputDir, fileName));
    copyFileSync(join(bundleDir, `${sourceName}.sig`), join(outputDir, `${fileName}.sig`));
    writeFileSync(join(outputDir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
  }
  console.log(`Validated release v${version}`);
}
