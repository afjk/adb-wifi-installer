import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateRelease, assetAction, validateAssets } from "./attach-release.mjs";
import { makeManifest } from "./release-metadata.mjs";

const sha = "a".repeat(40);
const release = { id: 42, tag_name: "v0.3.4", draft: false, published_at: "2026-10-08T00:00:00Z" };
const context = { id: "42", tag: "v0.3.4", sha, tagSha: sha, checkoutSha: sha };
test("published release identity and exact tag/checkout are required", () => {
  validateRelease(release, context);
  for (const change of [{ id: 43 }, { tag_name: "v0.3.3" }, { draft: true }, { published_at: null }]) {
    assert.throws(() => validateRelease({ ...release, ...change }, context));
  }
  assert.throws(() => validateRelease(release, { ...context, tagSha: "b".repeat(40) }));
  assert.throws(() => validateRelease(release, { ...context, checkoutSha: "b".repeat(40) }));
});
test("asset replay is idempotent and mismatches are never overwritten", () => {
  const content = Buffer.from("synthetic fixture");
  assert.equal(assetAction(null, content), "upload");
  assert.equal(assetAction(Buffer.from(content), content), "skip");
  assert.throws(() => assetAction(Buffer.from("different content"), content), /refusing to overwrite/);
});
test("release assets require exact URL/version, nonempty installer and matching signature", () => {
  const name = "ADB.WiFi.Installer_0.3.4_x64-setup.exe";
  const manifest = makeManifest("0.3.4", name, "synthetic-signature");
  const files = { [name]: Buffer.from("synthetic installer; not executable"), [`${name}.sig`]: Buffer.from("synthetic-signature\n") };
  const read = path => { assert.ok(files[path], "Missing asset"); return files[path]; };
  assert.deepEqual(validateAssets(manifest, "0.3.4", read), [name, `${name}.sig`, "latest.json"]);
  assert.throws(() => validateAssets(manifest, "0.3.3", read));
  files[`${name}.sig`] = Buffer.from("different-signature");
  assert.throws(() => validateAssets(manifest, "0.3.4", read));
  files[`${name}.sig`] = Buffer.from("synthetic-signature");
  files[name] = Buffer.alloc(0);
  assert.throws(() => validateAssets(manifest, "0.3.4", read));
});
test("workflow separates unsigned read-only PR builds from published release signing", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(workflow, /pull_request:\s+branches: \[main\]\s+types: \[opened, synchronize, reopened\]/);
  assert.match(workflow, /release:\s+types: \[published\]/);
  assert.doesNotMatch(workflow, /pull_request_target:|workflow_dispatch:|\n  push:/);
  assert.match(workflow, /permissions:\s+contents: read/);
  const pr = workflow.split("  pr-build:")[1].split("  release-build:")[0];
  assert.doesNotMatch(pr, /secrets\.|contents: write|release upload|attach-release/);
  assert.match(pr, /--no-sign/);
  assert.match(pr, /actions\/upload-artifact@v4/);
  assert.match(pr, /unsigned-pr-/);
  const publication = workflow.split("  release-build:")[1];
  assert.match(publication, /github.event.action == 'published'/);
  assert.match(publication, /ref: \$\{\{ github.sha \}\}/);
  assert.match(publication, /attach-release.mjs --check/);
  assert.match(publication, /secrets.TAURI_SIGNING_PRIVATE_KEY/);
  assert.doesNotMatch(workflow, /gh release create|gh release edit|--clobber/);
});
