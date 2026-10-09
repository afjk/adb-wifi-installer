import assert from "node:assert/strict";
import { readFileSync, readdirSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkVersions } from "./release-metadata.mjs";

const [tag, arch, bundle, output] = process.argv.slice(2);
assert.ok(["aarch64", "x86_64"].includes(arch), "Unsupported Mac architecture");
assert.ok(output, "Output directory required");
const version = checkVersions(process.cwd(), tag);
const one = (dir, suffix) => {
  const names = readdirSync(dir).filter(n => n.endsWith(suffix));
  assert.equal(names.length, 1, `Expected one ${suffix}`);
  return join(dir, names[0]);
};
const archive = one(join(bundle, "macos"), ".app.tar.gz");
const dmg = one(join(bundle, "dmg"), `_${version}_${arch === "x86_64" ? "x64" : arch}.dmg`);
const name = `ADB.WiFi.Installer_${version}_${arch}.app.tar.gz`;
const signature = readFileSync(`${archive}.sig`, "utf8").trim();
assert.ok(signature, "Updater signature missing");
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
mkdirSync(output, { recursive: true });
for (const [source, target] of [[archive, name], [`${archive}.sig`, `${name}.sig`], [dmg, `ADB.WiFi.Installer_${version}_${arch}.dmg`]]) {
  assert.ok(readFileSync(source).length, "Empty Mac asset");
  copyFileSync(source, join(output, target));
}
writeFileSync(join(output, `manifest-darwin-${arch}.json`), JSON.stringify({
  version, notes: `Release ${tag}`, pub_date: event.release.published_at,
  platforms: { [`darwin-${arch}`]: { signature, url: `https://github.com/afjk/adb-wifi-installer/releases/download/${tag}/${name}` } },
}, null, 2) + "\n");
