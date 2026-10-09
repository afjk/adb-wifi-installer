import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkVersions } from "./release-metadata.mjs";

const repository = "afjk/adb-wifi-installer";
export function validateRelease(release, { id, tag, sha, tagSha, checkoutSha }) {
  assert.equal(release.id, Number(id), "Release ID changed");
  assert.equal(release.tag_name, tag, "Release tag changed");
  assert.equal(release.draft, false, "Release must already be published");
  assert.ok(release.published_at, "Release is not published");
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(tagSha, sha, "Tag commit differs from the triggering commit");
  assert.equal(checkoutSha, sha, "Checkout differs from the triggering commit");
}

export function assetAction(existing, expected) {
  if (existing === null) return "upload";
  assert.ok(existing.equals(expected), "Existing asset differs; refusing to overwrite it");
  return "skip";
}

export function validateAssets(manifest, version, readAsset) {
  assert.equal(manifest.version, version, "Manifest version mismatch");
  const files = [];
  assert.ok(manifest.platforms?.["windows-x86_64"], "Windows platform missing");
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    assert.ok(["windows-x86_64", "darwin-aarch64", "darwin-x86_64"].includes(platform), "Unsupported platform");
    assert.ok(entry?.signature?.trim(), "Updater signature missing");
    const suffix = platform === "windows-x86_64" ? "x64-setup.exe" : `${platform.slice(7)}.app.tar.gz`;
    const file = `ADB.WiFi.Installer_${version}_${suffix}`;
    assert.equal(entry.url, `https://github.com/${repository}/releases/download/v${version}/${file}`);
    assert.ok(readAsset(file).length, "Installer is empty");
    assert.equal(readAsset(`${file}.sig`).toString("utf8").trim(), entry.signature.trim(), "Manifest signature mismatch");
    files.push(file, `${file}.sig`);
    if (platform.startsWith("darwin-")) {
      const dmg = `ADB.WiFi.Installer_${version}_${platform.slice(7)}.dmg`;
      assert.ok(readAsset(dmg).length, "DMG is empty");
      files.push(dmg);
    }
  }
  return [...files, "latest.json"];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_EVENT_NAME, "release");
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  assert.equal(event.action, "published");
  const id = process.env.RELEASE_ID;
  assert.match(id, /^\d+$/);
  const tag = process.env.RELEASE_TAG;
  const sha = process.env.GITHUB_SHA;
  const version = checkVersions(process.cwd(), tag);
  const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const currentRelease = () => JSON.parse(gh("api", `repos/${repository}/releases/${id}`));
  const context = { id, tag, sha, tagSha: git("rev-parse", `refs/tags/${tag}^{commit}`), checkoutSha: git("rev-parse", "HEAD") };
  validateRelease(event.release, context);
  validateRelease(currentRelease(), context);
  // Only build a release from a commit already present on the trusted main branch.
  git("merge-base", "--is-ancestor", sha, "refs/remotes/origin/main");
  if (process.argv[2] === "--check") {
    console.log(`Validated published release ${id}, ${tag}, ${sha}`);
  } else {
    const directory = process.argv[2];
    assert.ok(directory, "Asset directory required");
    const read = name => readFileSync(join(directory, name));
    const files = validateAssets(JSON.parse(read("latest.json")), version, read);
    const downloaded = mkdtempSync(join(tmpdir(), "adb-release-verify-"));
    const pending = [];
    for (const name of files) {
      assert.equal(basename(name), name);
      const release = currentRelease();
      validateRelease(release, context);
      const existing = release.assets.find(asset => asset.name === name);
      let bytes = null;
      if (existing) {
        gh("release", "download", tag, "--repo", repository, "--pattern", name, "--dir", downloaded);
        bytes = readFileSync(join(downloaded, name));
      }
      if (assetAction(bytes, read(name)) === "upload") pending.push(name);
    }
    for (const name of pending) {
        validateRelease(currentRelease(), context);
        gh("release", "upload", tag, join(directory, name), "--repo", repository);
        gh("release", "download", tag, "--repo", repository, "--pattern", name, "--dir", downloaded);
        assert.ok(readFileSync(join(downloaded, name)).equals(read(name)), "Uploaded asset verification failed");
      console.log(`Verified ${name}`);
    }
    validateRelease(currentRelease(), context);
    console.log(`Verified assets attached to existing release ${id}: ${tag}`);
  }
}
