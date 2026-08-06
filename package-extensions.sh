#!/bin/sh
# Shell script to package Lite Monkey for Chrome and Firefox store submission.
# Usage: ./package-extensions.sh

ver="$(cat manifest.json | grep '"version"' | cut -d\" -f4)"
if [ -z "$ver" ]; then
   ver="0.0.1"
fi

BUILD_DIR="./build"
mkdir -p "$BUILD_DIR"

echo "Packaging Lite Monkey v${ver}..."

# 1. Package Chrome Extension ZIP
CHROME_ZIP="${BUILD_DIR}/lite-monkey-chrome-v${ver}.zip"
rm -f "$CHROME_ZIP"

TMP_CHROME="./tmp_chrome"
rm -rf "$TMP_CHROME"
mkdir -p "$TMP_CHROME"

cp -r _locales css html icons js README.md LICENSE "$TMP_CHROME/" 2>/dev/null
cp manifest.chrome.json "$TMP_CHROME/manifest.json"

# Remove developer scratch/test files starting with '-'
find "$TMP_CHROME" -name "-*" -exec rm -rf {} + 2>/dev/null

(cd "$TMP_CHROME" && zip -q -r "../${CHROME_ZIP}" .)
rm -rf "$TMP_CHROME"
echo "Chrome package created: ${CHROME_ZIP}"

# 2. Package Firefox Extension ZIP
FIREFOX_ZIP="${BUILD_DIR}/lite-monkey-firefox-v${ver}.zip"
rm -f "$FIREFOX_ZIP"

TMP_FF="./tmp_firefox"
rm -rf "$TMP_FF"
mkdir -p "$TMP_FF"

cp -r _locales css html icons js README.md LICENSE "$TMP_FF/" 2>/dev/null
cp manifest.firefox.json "$TMP_FF/manifest.json"

find "$TMP_FF" -name "-*" -exec rm -rf {} + 2>/dev/null

(cd "$TMP_FF" && zip -q -r "../${FIREFOX_ZIP}" .)
rm -rf "$TMP_FF"
echo "Firefox package created: ${FIREFOX_ZIP}"

echo "All release packages created successfully in ${BUILD_DIR}/"
