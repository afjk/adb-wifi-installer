#!/bin/bash
set -e

echo "🔨 ADB WiFi Installer - リリースビルド"
echo "======================================="

# バージョンをtauri.conf.jsonから取得
VERSION=$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')
echo "Version: $VERSION"

# --- 署名・Notarization設定 ---
export APPLE_SIGNING_IDENTITY="Developer ID Application: AKIHIRO FUJII (N886Z5453R)"
export APPLE_API_ISSUER="69a6de7a-2f45-47e3-e053-5b8c7c11a4d1"
export APPLE_API_KEY="494MLF67D5"
export APPLE_API_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_494MLF67D5.p8"

# --- Tauri更新署名キー（環境変数で渡すとパスワードプロンプトが出るため直接渡す） ---
TAURI_PRIVATE_KEY=$(cat "$HOME/.tauri/adb-wifi-installer.key")

# --- ビルド ---
echo ""
echo "📦 ビルド中..."
source "$HOME/.cargo/env"
npm run tauri build -- --target aarch64-apple-darwin

APP_PATH="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/ADB WiFi Installer.app"
DMG_DIR="src-tauri/target/aarch64-apple-darwin/release/bundle/dmg"
DMG_NAME="ADB WiFi Installer_${VERSION}_aarch64.dmg"
DMG_PATH="$DMG_DIR/$DMG_NAME"
SIG_PATH="${DMG_PATH}.sig"

# --- 署名確認 ---
echo ""
echo "🔏 署名確認..."
codesign -dv --verbose=4 "$APP_PATH" 2>&1 | grep -E "Authority|TeamIdentifier" | head -5

# --- DMG作成 ---
echo ""
echo "💿 DMG作成中..."
mkdir -p "$DMG_DIR"
rm -f "$DMG_PATH"
STAGING=$(mktemp -d)
cp -r "$APP_PATH" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
hdiutil create \
  -volname "ADB WiFi Installer" \
  -srcfolder "$STAGING" \
  -ov -format UDZO \
  "$DMG_PATH"
rm -rf "$STAGING"

# --- DMGに署名 ---
echo ""
echo "🔏 DMGに署名中..."
codesign --sign "$APPLE_SIGNING_IDENTITY" \
  --timestamp \
  --options runtime \
  "$DMG_PATH"

# --- Notarization ---
echo ""
echo "📨 Apple Notarization送信中（数分かかります）..."
xcrun notarytool submit "$DMG_PATH" \
  --issuer "$APPLE_API_ISSUER" \
  --key-id "$APPLE_API_KEY" \
  --key "$APPLE_API_KEY_PATH" \
  --wait

# --- Staple ---
echo ""
echo "📎 Staple中..."
xcrun stapler staple "$DMG_PATH"
xcrun stapler staple "$APP_PATH"

# --- .app.tar.gz 作成（updater用）---
echo ""
echo "📦 .app.tar.gz 作成中（updater用）..."
TARBALL_NAME="ADB WiFi Installer_${VERSION}_aarch64.app.tar.gz"
TARBALL_PATH="$DMG_DIR/$TARBALL_NAME"
cd "$(dirname "$APP_PATH")"
tar czf "$OLDPWD/$TARBALL_PATH" "$(basename "$APP_PATH")"
cd - > /dev/null

# --- .app.tar.gz に Tauri署名（updater用）---
echo ""
echo "✍️  .app.tar.gz Tauri署名（updater用）..."
npm run tauri signer sign -- "$TARBALL_PATH" \
  --private-key "$TAURI_PRIVATE_KEY" --password ""
TARBALL_SIG_PATH="${TARBALL_PATH}.sig"

# --- GitHub Releaseにアップロード ---
TAG="v${VERSION}"
echo ""
echo "☁️  GitHub Release ($TAG) にアップロード中..."
gh release view "$TAG" 2>/dev/null || gh release create "$TAG" --title "$TAG" --notes "Release $TAG"
gh release upload "$TAG" "$DMG_PATH" --clobber
echo "Uploaded: $DMG_NAME"
gh release upload "$TAG" "$TARBALL_PATH" --clobber
echo "Uploaded: $TARBALL_NAME"

# --- latest.jsonにmacOSエントリを追加 ---
echo ""
echo "📋 latest.json を更新中..."
TARBALL_FILENAME="$TARBALL_NAME"
TARBALL_URL="https://github.com/afjk/adb-wifi-installer/releases/download/${TAG}/${TARBALL_FILENAME// /%20}"
SIG_CONTENT=""
if [ -f "$TARBALL_SIG_PATH" ]; then
  SIG_CONTENT=$(cat "$TARBALL_SIG_PATH")
fi

# 既存のlatest.jsonを取得、なければ新規作成
if gh release download "$TAG" --pattern "latest.json" --output /tmp/latest_current.json 2>/dev/null; then
  echo "Existing latest.json fetched"
else
  echo '{"version":"'"$VERSION"'","notes":"Release '"$TAG"'","pub_date":"'"$(date -u +"%Y-%m-%dT%H:%M:%SZ")"'","platforms":{}}' > /tmp/latest_current.json
fi

# macOSエントリを追加（updaterは .app.tar.gz が必要）
SIG_CONTENT="$SIG_CONTENT" TARBALL_URL="$TARBALL_URL" node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/tmp/latest_current.json', 'utf8'));
data.platforms['darwin-aarch64'] = {
  signature: process.env.SIG_CONTENT || '',
  url: process.env.TARBALL_URL
};
fs.writeFileSync('/tmp/latest_updated.json', JSON.stringify(data, null, 2));
console.log('Updated platforms:', Object.keys(data.platforms).join(', '));
"

cp /tmp/latest_updated.json /tmp/latest.json
gh release upload "$TAG" /tmp/latest.json --clobber
echo "Updated latest.json with darwin-aarch64 (.app.tar.gz)"

echo ""
echo "✅ 完了！"
echo "   DMG:     $DMG_PATH"
echo "   Updater: $TARBALL_PATH"
