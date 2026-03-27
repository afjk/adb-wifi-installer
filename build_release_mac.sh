#!/bin/bash
set -e

echo "🔨 ADB WiFi Installer - リリースビルド"
echo "======================================="

# --- 署名・Notarization設定 ---
export APPLE_SIGNING_IDENTITY="Developer ID Application: AKIHIRO FUJII (N886Z5453R)"
export APPLE_API_ISSUER="69a6de7a-2f45-47e3-e053-5b8c7c11a4d1"
export APPLE_API_KEY="494MLF67D5"
export APPLE_API_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_494MLF67D5.p8"

# --- ビルド ---
echo ""
echo "📦 ビルド中..."
source "$HOME/.cargo/env"
npm run tauri build -- --target aarch64-apple-darwin

APP_PATH="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/ADB WiFi Installer.app"
DMG_DIR="src-tauri/target/aarch64-apple-darwin/release/bundle/dmg"
DMG_PATH="$DMG_DIR/ADB WiFi Installer_0.1.0_aarch64.dmg"

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

echo ""
echo "✅ 完了！"
echo "   $DMG_PATH"
