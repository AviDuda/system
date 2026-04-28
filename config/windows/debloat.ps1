# debloat.ps1 -- Disable Windows annoyances for VM use
# Optional. Run after firstlogin.ps1 via winrun:
#   mise wr -- config/windows/debloat.ps1
#
# Disables ads, suggestions, telemetry, Copilot, Game Bar, Bing search,
# SCOOBE, and other noise that gets in the way on a dev/testing VM.
#
# Inspired by Win11Debloat (github.com/Raphire/Win11Debloat).

$ErrorActionPreference = "Continue"

# Timestamp helper
function ts { Get-Date -Format "HH:mm:ss" }

function Set-Reg($Path, $Name, $Value, $Type = "DWord") {
    if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
    Set-ItemProperty -Path $Path -Name $Name -Value $Value -Type $Type -ErrorAction SilentlyContinue
}

# --- SCOOBE / "finish setting up your device" ---
Write-Host "[$(ts)] === Disabling SCOOBE ===""
Set-Reg "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\UserProfileEngagement" "ScoobeSystemSettingEnabled" 0

# --- Tips, suggestions, ads ---
Write-Host "[$(ts)] === Disabling tips, suggestions, ads ===""
$cdm = "HKCU:\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager"
# "Show me the Windows welcome experience after updates"
Set-Reg $cdm "SubscribedContent-310093Enabled" 0
# "Get tips, tricks, and suggestions as you use Windows"
Set-Reg $cdm "SubscribedContent-338389Enabled" 0
Set-Reg $cdm "SoftLandingEnabled" 0
# "Occasionally show suggestions in Start"
Set-Reg $cdm "SubscribedContent-338388Enabled" 0
Set-Reg $cdm "SystemPaneSuggestionsEnabled" 0
# "Show suggested content in Settings app"
Set-Reg $cdm "SubscribedContent-338393Enabled" 0
Set-Reg $cdm "SubscribedContent-353694Enabled" 0
Set-Reg $cdm "SubscribedContent-353696Enabled" 0
Set-Reg $cdm "SubscribedContent-353698Enabled" 0
# Silent app installation
Set-Reg $cdm "SilentInstalledAppsEnabled" 0
# Lock screen tips / fun facts
Set-Reg $cdm "SubscribedContent-338387Enabled" 0
Set-Reg $cdm "RotatingLockScreenOverlayEnabled" 0
# Settings app notifications
Set-Reg "HKCU:\Software\Microsoft\Windows\CurrentVersion\SystemSettings\AccountNotifications" "EnableAccountNotifications" 0
# "Suggested" app notifications (ads for MS services)
Set-Reg "HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\Windows.SystemToast.Suggested" "Enabled" 0
# Windows Backup reminder notifications
Set-Reg "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\Windows.SystemToast.BackupReminder" "Enabled" 0
# Sync provider ads in Explorer
Set-Reg "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" "ShowSyncProviderNotifications" 0
# Start menu recommendations
Set-Reg "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" "Start_IrisRecommendations" 0
# Account notifications in Start
Set-Reg "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" "Start_AccountNotifications" 0
# Phone Link suggestions
Set-Reg "HKCU:\Software\Microsoft\Windows\CurrentVersion\Mobility" "OptedIn" 0

# --- Copilot ---
Write-Host "[$(ts)] === Disabling Copilot ===""
Set-Reg "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" "ShowCopilotButton" 0
Set-Reg "HKCU:\Software\Policies\Microsoft\Windows\WindowsCopilot" "TurnOffWindowsCopilot" 1
Set-Reg "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsCopilot" "TurnOffWindowsCopilot" 1

# --- Bing web search in Start ---
Write-Host "[$(ts)] === Disabling Bing in search ===""
Set-Reg "HKCU:\Software\Policies\Microsoft\Windows\Explorer" "DisableSearchBoxSuggestions" 1
# Cortana already disabled in firstlogin.ps1, but ensure search is clean
Set-Reg "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search" "AllowCortana" 0

# --- Search highlights (branded content in search box) ---
Write-Host "[$(ts)] === Disabling search highlights ===""
Set-Reg "HKCU:\Software\Microsoft\Windows\CurrentVersion\SearchSettings" "IsDynamicSearchBoxEnabled" 0

# --- Desktop Spotlight (Windows Spotlight as wallpaper) ---
Write-Host "[$(ts)] === Disabling Desktop Spotlight ===""
Set-Reg "HKCU:\Software\Policies\Microsoft\Windows\CloudContent" "DisableSpotlightCollectionOnDesktop" 1

# --- Widgets (taskbar + service) ---
Write-Host "[$(ts)] === Disabling widgets ===""
# firstlogin already hides the taskbar button (TaskbarDa=0), disable the service too
Set-Reg "HKLM:\SOFTWARE\Microsoft\PolicyManager\default\NewsAndInterests\AllowNewsAndInterests" "value" 0
Set-Reg "HKLM:\SOFTWARE\Policies\Microsoft\Dsh" "AllowNewsAndInterests" 0

# --- Chat / Meet Now on taskbar ---
Write-Host "[$(ts)] === Hiding Chat from taskbar ===""
Set-Reg "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" "TaskbarMn" 0

# --- Game Bar and Game DVR ---
Write-Host "[$(ts)] === Disabling Game Bar ===""
Set-Reg "HKCU:\SOFTWARE\Microsoft\GameBar" "UseNexusForGameBarEnabled" 0
Set-Reg "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\GameDVR" "AppCaptureEnabled" 0

Write-Host "[$(ts)] === Debloat complete ==="
