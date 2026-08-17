#!/bin/sh
# package-extensions.sh
#
# Package Lite Monkey for Chrome Web Store and Firefox AMO.
#
# Usage:
#   ./package-extensions.sh
#
# Output:
#   build/lite-monkey-chrome-vX.Y.Z.zip
#   build/lite-monkey-firefox-vX.Y.Z.zip

set -eu


# ============================================================
# Configuration
# ============================================================

BUILD_DIR="./build"

SOURCE_ITEMS="
_locales
css
html
icons
js
README.md
LICENSE
"


# ============================================================
# Helpers
# ============================================================

get_version() {
    version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -n 1)

    if [ -z "$version" ]; then
        version="1.0.0"
    fi

    printf '%s\n' "$version"
}


require_file() {
    if [ ! -f "$1" ]; then
        echo "ERROR: Required file not found: $1" >&2
        exit 1
    fi
}


require_dir() {
    if [ ! -d "$1" ]; then
        echo "ERROR: Required directory not found: $1" >&2
        exit 1
    fi
}


copy_extension_files() {
    destination="$1"
    manifest="$2"

    mkdir -p "$destination"

    for item in $SOURCE_ITEMS; do
        if [ ! -e "$item" ]; then
            echo "ERROR: Required source item not found: $item" >&2
            exit 1
        fi

        cp -R "$item" "$destination/"
    done

    require_file "$manifest"

    cp "$manifest" "$destination/manifest.json"


    # --------------------------------------------------------
    # Remove developer scratch/test files whose names
    # start with "-".
    # --------------------------------------------------------

    find "$destination" -depth -name '-*' -exec rm -rf -- {} + 2>/dev/null || true
}


create_zip() {
    source_dir="$1"
    output_zip="$2"

    rm -f "$output_zip"

    (
        cd "$source_dir"

        # ZIP paths are created relative to the extension root.
        # zip stores archive paths using "/" separators.
        zip -q -r "$OLDPWD/$output_zip" .
    )
}


validate_zip() {
    zip_path="$1"

    if [ ! -f "$zip_path" ]; then
        echo "ERROR: ZIP was not created: $zip_path" >&2
        exit 1
    fi

    # --------------------------------------------------------
    # manifest.json must be at the archive root.
    # --------------------------------------------------------

    if ! unzip -Z1 "$zip_path" | grep -qx 'manifest.json'; then
        echo "ERROR: manifest.json is missing from ZIP root: $zip_path" >&2
        exit 1
    fi


    # --------------------------------------------------------
    # ZIP must not contain Windows-style backslash paths.
    # --------------------------------------------------------

    if unzip -Z1 "$zip_path" | grep -q '\\'; then
        echo "ERROR: ZIP contains Windows-style backslash paths:" >&2
        unzip -Z1 "$zip_path" | grep '\\' >&2
        exit 1
    fi


    # --------------------------------------------------------
    # ZIP must not contain path traversal.
    # --------------------------------------------------------

    if unzip -Z1 "$zip_path" | grep -Eq '(^|/)\.\.(/|$)'; then
        echo "ERROR: ZIP contains path traversal entries:" >&2
        unzip -Z1 "$zip_path" | grep -E '(^|/)\.\.(/|$)' >&2
        exit 1
    fi


    entries=$(unzip -Z1 "$zip_path" | wc -l | tr -d ' ')

    echo "  ZIP validation: OK"
    echo "  Entries: ${entries}"
}


package_extension() {
    browser="$1"
    manifest="$2"
    output_zip="$3"
    temp_dir="$4"

    echo ""
    echo "Packaging ${browser}..."

    rm -rf "$temp_dir"
    mkdir -p "$temp_dir"

    copy_extension_files "$temp_dir" "$manifest"

    create_zip "$temp_dir" "$output_zip"

    validate_zip "$output_zip"

    rm -rf "$temp_dir"

    size=$(wc -c < "$output_zip" | tr -d ' ')

    echo "  ${browser} package ready:"
    echo "  ${output_zip}"
    echo "  Size: ${size} bytes"
}


# ============================================================
# Checks
# ============================================================

require_file "manifest.json"
require_file "manifest.chrome.json"
require_file "manifest.firefox.json"

for item in $SOURCE_ITEMS; do
    if [ ! -e "$item" ]; then
        echo "ERROR: Required source item not found: $item" >&2
        exit 1
    fi
done


# ============================================================
# Version
# ============================================================

VER="$(get_version)"


# ============================================================
# Build directory
# ============================================================

mkdir -p "$BUILD_DIR"


# ============================================================
# Package names
# ============================================================

CHROME_ZIP="${BUILD_DIR}/lite-monkey-chrome-v${VER}.zip"
FIREFOX_ZIP="${BUILD_DIR}/lite-monkey-firefox-v${VER}.zip"

TMP_CHROME="./tmp_chrome"
TMP_FIREFOX="./tmp_firefox"


# ============================================================
# Header
# ============================================================

echo ""
echo "=============================================="
echo " Lite Monkey Extension Packager"
echo "=============================================="
echo "Version: ${VER}"


# ============================================================
# Chrome
# ============================================================

package_extension \
    "Chrome" \
    "manifest.chrome.json" \
    "$CHROME_ZIP" \
    "$TMP_CHROME"


# ============================================================
# Firefox
# ============================================================

package_extension \
    "Firefox" \
    "manifest.firefox.json" \
    "$FIREFOX_ZIP" \
    "$TMP_FIREFOX"


# ============================================================
# Done
# ============================================================

echo ""
echo "=============================================="
echo " Packaging completed successfully!"
echo "=============================================="
echo ""
echo "Chrome:"
echo "  ${CHROME_ZIP}"
echo ""
echo "Firefox:"
echo "  ${FIREFOX_ZIP}"
echo ""
