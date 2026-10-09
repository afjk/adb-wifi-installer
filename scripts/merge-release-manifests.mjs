import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function mergeManifests(manifests) {
  assert.ok(manifests.length, "Manifest required");
  const result = { ...manifests[0], platforms: {} };
  for (const manifest of manifests) {
    assert.equal(manifest.version, result.version, "Manifest versions differ");
    assert.equal(manifest.pub_date, result.pub_date, "Release dates differ");
    for (const [platform, value] of Object.entries(manifest.platforms)) {
      assert.ok(!Object.hasOwn(result.platforms, platform), "Duplicate platform");
      result.platforms[platform] = value;
    }
  }
  assert.ok(result.platforms["windows-x86_64"], "Windows platform must be preserved");
  if (manifests.length > 1) result.notes = `Release v${result.version}`;
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  const files = readdirSync(directory).filter(n => /^manifest-.*\.json$/.test(n)).sort();
  const manifests = ["latest.json", ...files].map(n => JSON.parse(readFileSync(join(directory, n), "utf8")));
  const merged = mergeManifests(manifests);
  if (process.env.EXPECT_MACOS === "true") {
    for (const arch of ["aarch64", "x86_64"]) assert.ok(merged.platforms[`darwin-${arch}`], "Required Mac platform missing");
  }
  writeFileSync(join(directory, "latest.json"), JSON.stringify(merged, null, 2) + "\n");
}
