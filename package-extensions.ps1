# package-extensions.ps1
#
# Package Lite Monkey for Chrome Web Store and Firefox AMO.
#
# Usage:
#   .\package-extensions.ps1
#
# Output:
#   build\lite-monkey-chrome-vX.Y.Z.zip
#   build\lite-monkey-firefox-vX.Y.Z.zip

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem


# ============================================================
# Configuration
# ============================================================

$buildDir = "build"

$sourceItems = @(
    "_locales",
    "css",
    "html",
    "icons",
    "js",
    "README.md",
    "LICENSE"
)


# ============================================================
# Helpers
# ============================================================

function Get-ManifestVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Manifest not found: $Path"
    }

    $manifest = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json

    if ([string]::IsNullOrWhiteSpace($manifest.version)) {
        return "1.0.0"
    }

    return $manifest.version
}


function Remove-PreviousBuild {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}


function Copy-ExtensionFiles {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Destination,

        [Parameter(Mandatory = $true)]
        [string]$ManifestPath
    )

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null

    foreach ($item in $sourceItems) {
        if (-not (Test-Path -LiteralPath $item)) {
            throw "Required source item not found: $item"
        }

        Copy-Item `
            -LiteralPath $item `
            -Destination $Destination `
            -Recurse `
            -Force
    }

    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        throw "Manifest not found: $ManifestPath"
    }

    Copy-Item `
        -LiteralPath $ManifestPath `
        -Destination (Join-Path $Destination "manifest.json") `
        -Force


    # Remove developer scratch/test files and directories
    # whose names start with "-".
    Get-ChildItem -LiteralPath $Destination -Recurse |
        Where-Object { $_.Name.StartsWith("-") } |
        Sort-Object FullName -Descending |
        Remove-Item -Recurse -Force
}


function New-ExtensionZip {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceDir,

        [Parameter(Mandatory = $true)]
        [string]$DestinationZip
    )

    $sourceFullPath = (Resolve-Path -LiteralPath $SourceDir).Path.TrimEnd('\')

    if (Test-Path -LiteralPath $DestinationZip) {
        Remove-Item -LiteralPath $DestinationZip -Force
    }

    $destinationFullPath = [System.IO.Path]::GetFullPath($DestinationZip)

    $fileStream = $null
    $archive = $null

    try {
        $fileStream = [System.IO.File]::Open(
            $destinationFullPath,
            [System.IO.FileMode]::Create,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )

        $archive = [System.IO.Compression.ZipArchive]::new(
            $fileStream,
            [System.IO.Compression.ZipArchiveMode]::Create,
            $false
        )

        Get-ChildItem -LiteralPath $sourceFullPath -Recurse -File |
            ForEach-Object {

                $relativePath = $_.FullName.Substring(
                    $sourceFullPath.Length + 1
                )

                # ZIP/XPI paths must use "/" even on Windows.
                $zipPath = $relativePath -replace '\\', '/'

                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $archive,
                    $_.FullName,
                    $zipPath,
                    [System.IO.Compression.CompressionLevel]::Optimal
                ) | Out-Null
            }
    }
    finally {
        if ($null -ne $archive) {
            $archive.Dispose()
        }

        if ($null -ne $fileStream) {
            $fileStream.Dispose()
        }
    }
}


function Test-ExtensionZip {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ZipPath
    )

    if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
        throw "ZIP was not created: $ZipPath"
    }

    $fileStream = $null
    $archive = $null

    try {
        $fileStream = [System.IO.File]::OpenRead($ZipPath)

        $archive = [System.IO.Compression.ZipArchive]::new(
            $fileStream,
            [System.IO.Compression.ZipArchiveMode]::Read,
            $false
        )

        $entries = @($archive.Entries)

        if ($entries.Count -eq 0) {
            throw "ZIP archive is empty: $ZipPath"
        }


        # --------------------------------------------------------
        # Check for invalid Windows separators.
        # --------------------------------------------------------

        $invalidSeparators = @(
            $entries |
                Where-Object { $_.FullName.Contains('\') }
        )

        if ($invalidSeparators.Count -gt 0) {
            $names = $invalidSeparators |
                ForEach-Object { $_.FullName }

            throw (
                "ZIP contains Windows-style paths:`n" +
                ($names -join "`n")
            )
        }


        # --------------------------------------------------------
        # Check for absolute paths / path traversal.
        # --------------------------------------------------------

        foreach ($entry in $entries) {
            $name = $entry.FullName

            if ($name.StartsWith("/")) {
                throw "ZIP contains an absolute path: $name"
            }

            if ($name -match '(^|/)\.\.(/|$)') {
                throw "ZIP contains path traversal: $name"
            }
        }


        # --------------------------------------------------------
        # manifest.json must exist at archive root.
        # --------------------------------------------------------

        $manifestEntry = $entries |
            Where-Object { $_.FullName -eq "manifest.json" }

        if ($null -eq $manifestEntry) {
            throw "manifest.json is missing from ZIP root: $ZipPath"
        }


        # --------------------------------------------------------
        # Report result.
        # --------------------------------------------------------

        Write-Host "  ZIP validation: OK" -ForegroundColor Green
        Write-Host "  Entries: $($entries.Count)" -ForegroundColor DarkGray
    }
    finally {
        if ($null -ne $archive) {
            $archive.Dispose()
        }

        if ($null -ne $fileStream) {
            $fileStream.Dispose()
        }
    }
}


function New-BrowserPackage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BrowserName,

        [Parameter(Mandatory = $true)]
        [string]$ManifestPath,

        [Parameter(Mandatory = $true)]
        [string]$OutputPath,

        [Parameter(Mandatory = $true)]
        [string]$TempPath
    )

    Write-Host ""
    Write-Host "Packaging $BrowserName..." -ForegroundColor Yellow

    Remove-PreviousBuild -Path $TempPath

    if (Test-Path -LiteralPath $OutputPath) {
        Remove-Item -LiteralPath $OutputPath -Force
    }

    try {
        Copy-ExtensionFiles `
            -Destination $TempPath `
            -ManifestPath $ManifestPath

        Write-Host "  Files copied." -ForegroundColor DarkGray

        New-ExtensionZip `
            -SourceDir $TempPath `
            -DestinationZip $OutputPath

        Write-Host "  ZIP created." -ForegroundColor DarkGray

        Test-ExtensionZip -ZipPath $OutputPath

        $sizeKB = [math]::Round(
            (Get-Item -LiteralPath $OutputPath).Length / 1KB,
            1
        )

        Write-Host ""
        Write-Host "  $BrowserName package ready:" -ForegroundColor Green
        Write-Host "  $OutputPath" -ForegroundColor Green
        Write-Host "  Size: $sizeKB KB" -ForegroundColor DarkGray
    }
    finally {
        Remove-PreviousBuild -Path $TempPath
    }
}


# ============================================================
# Main
# ============================================================

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " Lite Monkey Extension Packager" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan


# ------------------------------------------------------------
# Read version
# ------------------------------------------------------------

$ver = Get-ManifestVersion -Path "manifest.json"

Write-Host "Version: $ver" -ForegroundColor Cyan


# ------------------------------------------------------------
# Prepare build directory
# ------------------------------------------------------------

New-Item -ItemType Directory -Path $buildDir -Force | Out-Null


# ------------------------------------------------------------
# Package names
# ------------------------------------------------------------

$chromeZip = Join-Path `
    $buildDir `
    "lite-monkey-chrome-v$ver.zip"

$firefoxZip = Join-Path `
    $buildDir `
    "lite-monkey-firefox-v$ver.zip"

$tmpChrome = "tmp_chrome"
$tmpFirefox = "tmp_firefox"


# ------------------------------------------------------------
# Chrome
# ------------------------------------------------------------

New-BrowserPackage `
    -BrowserName "Chrome" `
    -ManifestPath "manifest.chrome.json" `
    -OutputPath $chromeZip `
    -TempPath $tmpChrome


# ------------------------------------------------------------
# Firefox
# ------------------------------------------------------------

New-BrowserPackage `
    -BrowserName "Firefox" `
    -ManifestPath "manifest.firefox.json" `
    -OutputPath $firefoxZip `
    -TempPath $tmpFirefox


# ============================================================
# Done
# ============================================================

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host " Packaging completed successfully!" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Chrome:" -ForegroundColor Cyan
Write-Host "  $chromeZip"

Write-Host ""
Write-Host "Firefox:" -ForegroundColor Cyan
Write-Host "  $firefoxZip"

Write-Host ""
