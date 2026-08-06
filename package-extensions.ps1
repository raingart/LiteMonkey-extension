# PowerShell script to package Lite Monkey for Chrome and Firefox store submission on Windows.
# Usage: .\package-extensions.ps1

$ErrorActionPreference = "Stop"

# Extract version from manifest.json
$manifestJson = Get-Content -Raw -Path "manifest.json" | ConvertFrom-Json
$ver = $manifestJson.version
if (-not $ver) { $ver = "1.0.0" }

$buildDir = "build"
if (-not (Test-Path $buildDir)) {
    New-Item -ItemType Directory -Path $buildDir | Out-Null
}

Write-Host "Packaging Lite Monkey v$ver for Windows..." -ForegroundColor Cyan

# 1. Package Chrome Extension ZIP
$chromeZip = Join-Path $buildDir "lite-monkey-chrome-v$ver.zip"
$tmpChrome = "tmp_chrome"

if (Test-Path $tmpChrome) { Remove-Item -Recurse -Force $tmpChrome }
if (Test-Path $chromeZip) { Remove-Item -Force $chromeZip }

New-Item -ItemType Directory -Path $tmpChrome | Out-Null
Copy-Item -Recurse -Force _locales, css, html, icons, js, README.md, LICENSE $tmpChrome\
Copy-Item -Force manifest.chrome.json "$tmpChrome\manifest.json"

# Remove developer scratch/test files starting with '-'
Get-ChildItem -Path $tmpChrome -Recurse -Filter "-*" | Remove-Item -Recurse -Force

Compress-Archive -Path "$tmpChrome\*" -DestinationPath $chromeZip -Force
Remove-Item -Recurse -Force $tmpChrome
Write-Host "Chrome package created: $chromeZip" -ForegroundColor Green

# 2. Package Firefox Extension ZIP
$firefoxZip = Join-Path $buildDir "lite-monkey-firefox-v$ver.zip"
$tmpFirefox = "tmp_firefox"

if (Test-Path $tmpFirefox) { Remove-Item -Recurse -Force $tmpFirefox }
if (Test-Path $firefoxZip) { Remove-Item -Force $firefoxZip }

New-Item -ItemType Directory -Path $tmpFirefox | Out-Null
Copy-Item -Recurse -Force _locales, css, html, icons, js, README.md, LICENSE $tmpFirefox\
Copy-Item -Force manifest.firefox.json "$tmpFirefox\manifest.json"

Get-ChildItem -Path $tmpFirefox -Recurse -Filter "-*" | Remove-Item -Recurse -Force

Compress-Archive -Path "$tmpFirefox\*" -DestinationPath $firefoxZip -Force
Remove-Item -Recurse -Force $tmpFirefox
Write-Host "Firefox package created: $firefoxZip" -ForegroundColor Green

Write-Host "All release packages created successfully in $buildDir\" -ForegroundColor Cyan
