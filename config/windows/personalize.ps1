# personalize.ps1 -- Personal tools and apps for Windows VM
# Run after firstlogin.ps1 (which handles system defaults).
# Not baked into the unattended ISO -- run via winrun:
#   mise wr -- config/windows/personalize.ps1

$ErrorActionPreference = "Continue"

# Timestamp helper
function ts { Get-Date -Format "HH:mm:ss" }

function Install-Winget($id) {
    winget install --id $id --source winget --accept-package-agreements --accept-source-agreements --silent 2>&1 | Write-Host
}

# --- Verify Developer Mode (required for mise symlinks) ---
Write-Host "[$(ts)] === Checking Developer Mode ==="
$devMode = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -Name 'AllowDevelopmentWithoutDevLicense' -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense
if ($devMode -ne 1) {
    Write-Host "[$(ts)] WARNING: Developer Mode not enabled. mise (symlinks) and some tools may fail."
    Write-Host "[$(ts)] Enable it in Settings > Privacy & Security > For developers, then re-run."
}

# --- Upgrade existing apps before installing new ones ---
Write-Host "[$(ts)] === Upgrading installed apps (winget) ==="
winget upgrade --all --accept-package-agreements --accept-source-agreements --silent 2>&1 | Write-Host

# --- GUI apps (winget is better for these) ---
Write-Host "[$(ts)] === Installing GUI apps ==="
Install-Winget "Mozilla.Firefox"
Install-Winget "ZedIndustries.Zed"
Install-Winget "DEVCOM.JetBrainsMonoNerdFont"

# --- Git (needed by gh, lazygit, delta, and most CLI tools) ---
Write-Host "[$(ts)] === Installing Git ==="
Install-Winget "Git.Git"

# --- mise (CLI tool manager) ---
Write-Host "[$(ts)] === Installing mise ==="
Install-Winget "jdx.mise"

# Refresh PATH so git and mise are available in this session
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# Resolve mise to its real path (winget installs a symlink shim at WinGet\Links\ that
# SSH sessions can't follow due to Windows symlink execution policy).
$miseExe = (Get-Command mise -ErrorAction SilentlyContinue).Source
if ($miseExe) {
    $miseItem = Get-Item $miseExe
    if ($miseItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        $miseExe = $miseItem.Target
        Write-Host "[$(ts)] Resolved mise symlink -> $miseExe"
    }
} else {
    Write-Host "[$(ts)] ERROR: mise not found in PATH"
}

# --- CLI tools via mise ---
Write-Host "[$(ts)] === Installing CLI tools via mise ==="
# Mimics the tool selection from modules/home-manager/default.nix.
# mise downloads x86_64 binaries which work on ARM64 via Windows emulation.
$tools = @(
    "ripgrep",
    "fd",
    "bat",
    "delta",
    "jq",
    "yq",
    "fzf",
    "hexyl",
    "duf",
    "dust",
    "glow",
    "zoxide",
    "gh",
    "lazygit",
    "neovim",
    "pandoc",
    "shellcheck",
    "biome",
    "bun",
    "node",
    "go",
    "typst",
    "xh",
    "sd",
    "just"
)
# eza: no prebuilt Windows binary (cargo only). Skip unless Rust is installed.
# Also skipped (no native Windows ARM64 builds): hyperfine, tokei, procs, tealdeer.
# Install Rust via `mise use -g rust@latest` if you need any of these.
foreach ($tool in $tools) {
    Write-Host "  mise use -g $tool@latest"
    & $miseExe use -g "$tool@latest" 2>&1 | Write-Host
}

# Refresh PATH again so delta is available for git config
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# --- Git config ---
Write-Host "[$(ts)] === Configuring git ==="
git config --global core.autocrlf input
git config --global init.defaultBranch main
git config --global core.longpaths true
git config --global core.pager delta
git config --global interactive.diffFilter "delta --color-only"
git config --global delta.navigate true
git config --global delta.side-by-side true
git config --global merge.conflictstyle diff3
git config --global diff.colorMoved default
Write-Host "[$(ts)] Git configured."

# --- Windows Terminal settings ---
Write-Host "[$(ts)] === Configuring Windows Terminal ==="
$wtSettingsDir = "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState"
$wtSettingsFile = Join-Path $wtSettingsDir "settings.json"
if (Test-Path $wtSettingsFile) {
    $json = Get-Content $wtSettingsFile -Raw
    # PS5.1 ConvertFrom-Json loses property order and mangles types.
    # Use simple string replacement to inject defaults instead.
    $defaultsBlock = @'
        "defaults": {
            "font": {
                "face": "JetBrainsMono Nerd Font",
                "size": 12
            },
            "colorScheme": "One Half Dark"
        },
'@
    # Replace empty defaults block, or add one if missing
    if ($json -match '"defaults"\s*:\s*\{\s*\}') {
        $json = $json -replace '"defaults"\s*:\s*\{\s*\}', $defaultsBlock.TrimEnd(',')
    } elseif ($json -notmatch '"defaults"') {
        $json = $json -replace '"profiles"\s*:\s*\{', ("`"profiles`" : {`n" + $defaultsBlock)
    }
    $json | Set-Content $wtSettingsFile -Encoding UTF8
    Write-Host "[$(ts)] Terminal settings updated."
}

Write-Host "[$(ts)] === Personalization complete ==="
