# =============================================================================
# release-plexus.ps1
# -----------------------------------------------------------------------------
# Sync the Plexus tool source from this hub into the standalone plexus repo,
# commit, and push. Vercel auto-deploys the plexus repo on push.
#
# Usage:
#     pwsh ./scripts/release-plexus.ps1
#     pwsh ./scripts/release-plexus.ps1 -Version "v1.0.1" -Message "fix: LAG-pair render glitch"
#
# Expects the plexus repo to live alongside the hub:
#     C:\...\300 - Websites\MyHome\         <- hub
#     C:\...\300 - Websites\plexus\         <- standalone plexus repo
# =============================================================================

[CmdletBinding()]
param(
    [string]$Version = "",
    [string]$Message = ""
)

$ErrorActionPreference = "Stop"

# --- Resolve hub & plexus paths -------------------------------------------------
$HubRoot    = Split-Path -Parent $PSScriptRoot
$PlexusRoot = Join-Path (Split-Path -Parent $HubRoot) "plexus"

Write-Host ""
Write-Host "==================================" -ForegroundColor Cyan
Write-Host "  PLEXUS RELEASE" -ForegroundColor Cyan
Write-Host "==================================" -ForegroundColor Cyan
Write-Host "Hub:    $HubRoot"
Write-Host "Plexus: $PlexusRoot"
Write-Host ""

if (-not (Test-Path $PlexusRoot)) {
    Write-Host "ERROR: Plexus repo not found at $PlexusRoot" -ForegroundColor Red
    Write-Host ""
    Write-Host "Clone it next to MyHome with:" -ForegroundColor Yellow
    Write-Host "  cd `"$(Split-Path -Parent $HubRoot)`""
    Write-Host "  git clone https://github.com/nicolasiven-ops/plexus.git"
    exit 1
}

if (-not (Test-Path (Join-Path $PlexusRoot ".git"))) {
    Write-Host "ERROR: $PlexusRoot exists but is not a git repo." -ForegroundColor Red
    exit 1
}

# --- Files to sync ---------------------------------------------------------------
# Source-of-truth files that live in the hub root and get copied into plexus/lib/.
$LibFiles = @(
    "module-runtime.js",
    "mod_002_netmap.js",
    "mod_002_netmap.css",
    "mod_002_persistence.js",
    "mod_002_radial.js",
    "mod_002_utils.js"
)

$LibDir = Join-Path $PlexusRoot "lib"
if (-not (Test-Path $LibDir)) { New-Item -ItemType Directory -Path $LibDir | Out-Null }

Write-Host "Syncing tool source -> plexus/lib/" -ForegroundColor Cyan
foreach ($f in $LibFiles) {
    $src = Join-Path $HubRoot $f
    $dst = Join-Path $LibDir $f
    if (-not (Test-Path $src)) {
        Write-Host "  WARN  $f not found in hub root, skipping" -ForegroundColor Yellow
        continue
    }
    Copy-Item -LiteralPath $src -Destination $dst -Force
    Write-Host "  ok    $f"
}

# Favicon
$faviSrc = Join-Path $HubRoot "favicon.svg"
$faviDst = Join-Path $PlexusRoot "favicon.svg"
if (Test-Path $faviSrc) {
    Copy-Item -LiteralPath $faviSrc -Destination $faviDst -Force
    Write-Host "  ok    favicon.svg"
}

Write-Host ""

# --- Commit & push in plexus repo ------------------------------------------------
Push-Location $PlexusRoot
try {
    $status = git status --porcelain
    if (-not $status) {
        Write-Host "No changes to release. Plexus is already up to date." -ForegroundColor Green
        exit 0
    }

    Write-Host "Changed files:" -ForegroundColor Cyan
    $status -split "`n" | ForEach-Object { Write-Host "  $_" }
    Write-Host ""

    if (-not $Message) {
        if ($Version) {
            $Message = "PLEXUS $Version - sync from hub"
        } else {
            $Message = "PLEXUS - sync from hub"
        }
    }

    git add -A
    git commit -m $Message
    git push origin main

    Write-Host ""
    Write-Host "==================================" -ForegroundColor Green
    Write-Host "  RELEASED" -ForegroundColor Green
    Write-Host "==================================" -ForegroundColor Green
    Write-Host "Vercel auto-deploys in ~30s."
    Write-Host "Live: https://plexus.vercel.app/  (or your configured domain)"
} finally {
    Pop-Location
}
