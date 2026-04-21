# personalize.ps1 -- Personal tools and apps for Windows VM
# Run after firstlogin.ps1 (which handles system defaults).
# Not baked into the unattended ISO -- run via SSH:
#   ssh avi@windows-vm 'powershell -File -' < config/windows/personalize.ps1

$ErrorActionPreference = "Continue"

function Install-Winget($id) {
    winget install --id $id --source winget --accept-package-agreements --accept-source-agreements --silent 2>&1 | Write-Host
}

# --- GUI apps (winget is better for these) ---
Write-Host "=== Installing GUI apps ==="
Install-Winget "Mozilla.Firefox"
Install-Winget "ZedIndustries.Zed"
Install-Winget "DEVCOM.JetBrainsMonoNerdFont"

# --- mise (CLI tool manager) ---
Write-Host "`n=== Installing mise ==="
Install-Winget "jdx.mise"

# Refresh PATH so mise is available in this session
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# --- CLI tools via mise ---
Write-Host "`n=== Installing CLI tools via mise ==="
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
    mise use -g "$tool@latest" 2>&1 | Write-Host
}

# --- Windows Terminal settings ---
Write-Host "`n=== Configuring Windows Terminal ==="
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
    Write-Host "Terminal settings updated."
}

Write-Host "`n=== Personalization complete ==="
