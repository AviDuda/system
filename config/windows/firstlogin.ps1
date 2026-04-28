# firstlogin.ps1 -- Post-install setup for Windows VM
# Runs once on first login via autounattend.xml FirstLogonCommands.
#
# Goals:
# - Install remaining VirtIO drivers (network, balloon, etc.)
# - Install SPICE guest tools (clipboard sharing, dynamic resolution)
# - Install PowerShell 7 via winget (retries if not yet provisioned)
# - Set Windows Terminal as default terminal with PS7 profile
# - Enable Remote Desktop
# - Reduce telemetry, disable widgets, dark mode
# - Explorer: file extensions, hidden files, This PC view
# - Set up for forepaw accessibility testing

param(
    [string]$Password  # Optional. Auto-detected from autounattend.xml on the unattended drive.
)

$ErrorActionPreference = "Continue"

# Timestamp helper for log output
function ts { Get-Date -Format "HH:mm:ss" }

# Log everything
$logFile = "$env:USERPROFILE\Desktop\firstlogin.log"
Start-Transcript -Path $logFile -Append

Write-Host "[$(ts)] === Windows VM post-install setup ==="

# --- Find the VirtIO/unattended drive ---
# The unattended ISO is mounted as a USB CD-ROM; find it by looking for autounattend.xml
$virtioDir = $null
foreach ($drive in (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -ne "C:\" })) {
    $testPath = Join-Path $drive.Root "autounattend.xml"
    if (Test-Path $testPath) {
        $virtioDir = $drive.Root
        break
    }
}

if (-not $virtioDir) {
    Write-Host "WARNING: Could not find unattended drive. Skipping driver install."
} else {
    Write-Host "Found unattended drive at: $virtioDir"

    # --- Install remaining VirtIO drivers via pnputil ---
    Write-Host "[$(ts)] === Installing VirtIO drivers ==="
    $driverDirs = Get-ChildItem -Path $virtioDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(Balloon|vioinput|vioser|NetKVM|viostor|viofs)$' }
    # Note: viogpudo (VirtIO GPU DOD) is intentionally excluded.
    # On ARM64, virtio-gpu-pci non-VGA mode doesn't properly report EDID to Windows
    # (virtio-win#969), causing a phantom second monitor and making the login screen
    # render on the wrong display. The ramfb framebuffer alone works fine for display.

    foreach ($dir in $driverDirs) {
        $arm64Dir = Join-Path $dir.FullName "w11\ARM64"
        if (-not (Test-Path $arm64Dir)) {
            $arm64Dir = Join-Path $dir.FullName "ARM64"
        }
        if (Test-Path $arm64Dir) {
            $infFiles = Get-ChildItem -Path $arm64Dir -Filter "*.inf"
            foreach ($inf in $infFiles) {
                Write-Host "Installing driver: $($inf.FullName)"
                pnputil /add-driver $inf.FullName /install 2>&1 | Write-Host
            }
        }
    }

    # --- Install UTM guest tools (VirtIO drivers + SPICE agent) ---
    # Prefer UTM guest tools over standalone SPICE tools -- UTM tools include
    # the display driver for dynamic resolution + clipboard sharing.
    # Note: on Windows 11 24H2/25H2, the display driver may cause a black screen
    # on first reboot. If that happens, reboot again and it should recover.
    $utmInstaller = Join-Path $virtioDir "utm-guest-tools.exe"
    if (Test-Path $utmInstaller) {
        Write-Host "[$(ts)] === Installing UTM guest tools ==="
        Start-Process -FilePath $utmInstaller -ArgumentList "/S" -Wait
        Write-Host "UTM guest tools installed."
    }

    # --- Start SPICE VDAgent service (clipboard + dynamic resolution) ---
    if (Get-Service vdservice -ErrorAction SilentlyContinue) {
        Write-Host "[$(ts)] === Starting SPICE VDAgent ==="
        Set-Service vdservice -StartupType Automatic
        Start-Service vdservice -ErrorAction SilentlyContinue
        Write-Host "SPICE VDAgent started."
    }

    # --- Install QEMU Guest Agent if present ---
    $qemuGA = Join-Path $virtioDir "guest-agent\qemu-ga-x86_64.msi"
    if (Test-Path $qemuGA) {
        Write-Host "[$(ts)] === Installing QEMU Guest Agent ==="
        Start-Process msiexec.exe -ArgumentList "/i `"$qemuGA`" /quiet /norestart" -Wait
        Write-Host "QEMU Guest Agent installed."
    }
}

# --- Enable Remote Desktop ---
Write-Host "[$(ts)] === Enabling Remote Desktop ==="
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name "fDenyTSConnections" -Value 0 -Type DWord
Enable-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction SilentlyContinue

# Allow ICMP (ping) for diagnostics
New-NetFirewallRule -Name 'Allow ICMPv4' -DisplayName 'Allow ICMPv4' -Enabled True -Direction Inbound -Protocol ICMPv4 -Action Allow -Profile Any -ErrorAction SilentlyContinue

# --- Enable Developer Mode ---
Write-Host "[$(ts)] === Enabling Developer Mode ==="
# Allows symlinks without admin, device portal, and other dev features
New-Item -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -Name "AllowDevelopmentWithoutDevLicense" -Value 1 -Type DWord

# --- Enable Windows sudo (inline mode) ---
Write-Host "[$(ts)] === Enabling sudo ==="
# Windows 11 24H2+ has built-in sudo.
# Values: 0=disabled, 1=forceNewWindow, 2=disableInput, 3=normal (inline).
# Note: sudo requires an interactive desktop -- it does NOT work from SSH.
New-Item -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Sudo' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Sudo' -Name "Enabled" -Value 3 -Type DWord

# --- Disable UAC consent prompt for disposable VMs ---
Write-Host "[$(ts)] === Disabling UAC consent ==="
# Disables the UAC consent prompt for admin operations. Safe for disposable VMs.
# Note: this does NOT fix Windows Update COM API E_ACCESSDENIED over SSH --
# that's a separate issue where recent Windows builds block remote logon sessions
# from using the Update COM API regardless of token elevation. See mgajda83/PSWindowsUpdate#60.
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name "ConsentPromptBehaviorAdmin" -Value 0 -Type DWord

# --- Reduce telemetry ---
Write-Host "[$(ts)] === Reducing telemetry ==="
# Set telemetry to Security level (minimum)
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DataCollection' -Name "AllowTelemetry" -Value 0 -Type DWord -Force
# Disable Cortana
New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search' -Name "AllowCortana" -Value 0 -Type DWord

# --- Enable persistent auto-logon ---
Write-Host "[$(ts)] === Enabling persistent auto-logon ==="
# autounattend.xml AutoLogon only fires LogonCount times (set to 1).
# For disposable VMs, set AutoAdminLogon=1 permanently so reboots go straight to desktop.
$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty -Path $winlogon -Name "AutoAdminLogon" -Value "1" -Type String
Set-ItemProperty -Path $winlogon -Name "ForceAutoLogon" -Value "1" -Type String
Set-ItemProperty -Path $winlogon -Name "DefaultUserName" -Value $env:USERNAME -Type String

# Disable ARSO (Automatic Restart Sign-On). Without this, LogonUI.exe clears
# AutoAdminLogon and DefaultPassword after a reboot, breaking persistent auto-logon.
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name "DisableAutomaticRestartSignOn" -Value 1 -Type DWord

# Get the password. Try in order:
# 1. -Password parameter (passed from autounattend.xml CommandLine)
# 2. Parse autounattend.xml on the unattended ISO drive
# 3. Registry DefaultPassword (set by Windows AutoLogon, but may be cleared)
if (-not $Password) {
    foreach ($d in 'D','E','F','G') {
        $answerFile = "${d}:\autounattend.xml"
        if (Test-Path $answerFile) {
            try {
                [xml]$xml = Get-Content $answerFile
                $autoPwdNode = $xml.SelectSingleNode(
                    '//*[local-name()="AutoLogon"]/*[local-name()="Password"]/*[local-name()="Value"]'
                )
                if ($autoPwdNode) { $Password = $autoPwdNode.'#text' }
            } catch {
                Write-Host "  WARNING: Could not parse $answerFile"
            }
            break
        }
    }
}
if (-not $Password) {
    $Password = (Get-ItemProperty -Path $winlogon -Name "DefaultPassword" -ErrorAction SilentlyContinue).DefaultPassword
}

if ($Password) {
    Set-ItemProperty -Path $winlogon -Name "DefaultPassword" -Value $Password -Type String
    Write-Host "  Persistent auto-logon enabled for $env:USERNAME"
} else {
    Write-Host "  WARNING: Could not determine password. Auto-logon not fully configured."
}

# --- Windows Defender exclusions ---
Write-Host "[$(ts)] === Configuring Windows Defender exclusions ==="
# Real-time scanning slows down git, npm, cargo, mise significantly.
# Exclude common dev paths and processes. Acceptable tradeoff for isolated VMs.
# (Can't fully disable Defender -- tamper protection blocks it from any scripted context.)
$exclusions = @(
    $env:USERPROFILE                    # Home dir (mise, git repos, etc.)
    "$env:USERPROFILE\.local"
    "$env:USERPROFILE\AppData\Local\mise"
    "$env:USERPROFILE\AppData\Local\Temp"
    'C:\tmp'
    'C:\temp'
    'C:\dev'
)
foreach ($path in $exclusions) {
    if (Test-Path $path) {
        Add-MpPreference -ExclusionPath $path -ErrorAction SilentlyContinue
        Write-Host "  Excluded: $path"
    }
}
$processExclusions = @('git.exe', 'node.exe', 'cargo.exe', 'rustc.exe', 'go.exe', 'java.exe', 'python.exe', 'uv.exe')
foreach ($proc in $processExclusions) {
    Add-MpPreference -ExclusionProcess $proc -ErrorAction SilentlyContinue
}
Write-Host "  Process exclusions: $($processExclusions -join ', ')"

# --- Disable lock screen ---
Write-Host "[$(ts)] === Disabling lock screen ==="
New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' -Name "NoLockScreen" -Value 1 -Type DWord
# Disable screen timeout on AC power
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0

# --- Set power plan to High Performance ---
Write-Host "[$(ts)] === Setting High Performance power plan ==="
powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c 2>$null

# --- Enable Windows Time service (NTP) ---
Write-Host "[$(ts)] === Enabling NTP time sync ==="
# qemu-ga handles initial sync with host, but NTP provides reliable ongoing sync
# and recovers from clock drift after host sleep/wake cycles.
# time.windows.com is reachable from vmnet (verified).
Set-Service -Name w32time -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service w32time -ErrorAction SilentlyContinue
# Force sync now rather than waiting for the default poll interval
w32tm /resync /force 2>&1 | Write-Host
Write-Host "NTP time sync enabled."

# --- Disable Windows Update auto-restart ---
Write-Host "[$(ts)] === Disabling auto-restart for updates ==="
New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -Name "NoAutoRebootWithLoggedOnUsers" -Value 1 -Type DWord

# --- Explorer settings ---
Write-Host "[$(ts)] === Configuring Explorer ==="
$advPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced'
# Show file extensions
Set-ItemProperty -Path $advPath -Name "HideFileExt" -Value 0 -Type DWord
# Show hidden files
Set-ItemProperty -Path $advPath -Name "Hidden" -Value 1 -Type DWord
# Show full path in title bar
Set-ItemProperty -Path $advPath -Name "ShowFullPathInTitleBar" -Value 1 -Type DWord
# Launch Explorer to This PC instead of Quick Access
Set-ItemProperty -Path $advPath -Name "LaunchTo" -Value 1 -Type DWord

# --- Dark mode ---
Write-Host "[$(ts)] === Enabling dark mode ==="
$themePath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
Set-ItemProperty -Path $themePath -Name "AppsUseLightTheme" -Value 0 -Type DWord
Set-ItemProperty -Path $themePath -Name "SystemUsesLightTheme" -Value 0 -Type DWord

# --- Quality of life settings ---
Write-Host "[$(ts)] === Applying quality of life settings ==="
# Enable long paths (remove 260-char limit)
New-Item -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name "LongPathsEnabled" -Value 1 -Type DWord
Write-Host "  Long paths enabled"
# Enable clipboard history (Win+V)
New-Item -Path 'HKCU:\Software\Microsoft\Clipboard' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Clipboard' -Name "EnableClipboardHistory" -Value 1 -Type DWord
# Disable taskbar widgets (weather/news)
# TaskbarDa is ACL-protected when set from a non-elevated session, but works fine
# during firstlogin (elevated OOBE context). Value is 0=hidden, 1=visible.
Set-ItemProperty -Path $advPath -Name "TaskbarDa" -Value 0 -Type DWord -ErrorAction SilentlyContinue
# Taskbar search: icon only (0=hidden, 1=icon, 2=search box)
Set-ItemProperty -Path $advPath -Name "SearchboxTaskbarMode" -Value 1 -Type DWord
# Disable OneDrive autostart
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name "OneDrive" -ErrorAction SilentlyContinue

# --- Install PowerShell 7 ---
# winget on ARM64 installs PS7 as an AppX package.
# It may not be available during FirstLogonCommands (App Installer not
# provisioned yet) or network may not be ready. Retry with backoff.
Write-Host "[$(ts)] === Installing PowerShell 7 ==="
$pwshPath = $null
try {
    $installed = $false
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
        if ($null -ne $wingetCmd) {
            Write-Host "  [$(ts)] Installing via winget (attempt $attempt)..."
            winget install --id Microsoft.PowerShell --source winget --accept-package-agreements --accept-source-agreements --silent 2>&1 | Write-Host
            $installed = $true
            break
        }
        Write-Host "  [$(ts)] winget not available yet, waiting ($attempt/5)..."
        Start-Sleep -Seconds (10 * $attempt)
    }
    if (-not $installed) {
        Write-Host "  [$(ts)] WARNING: winget never became available."
    }

    # Find pwsh.exe -- check MSI path first, then AppX (winget on ARM64 uses AppX)
    if (Test-Path "C:\Program Files\PowerShell\7\pwsh.exe") {
        $pwshPath = "C:\Program Files\PowerShell\7\pwsh.exe"
    } else {
        $appx = Get-AppxPackage Microsoft.PowerShell -ErrorAction SilentlyContinue
        if ($appx) {
            $candidate = Join-Path $appx.InstallLocation "pwsh.exe"
            if (Test-Path $candidate) { $pwshPath = $candidate }
        }
    }
    if ($pwshPath) {
        Write-Host "  [$(ts)] PowerShell 7 installed at: $pwshPath"
    } else {
        Write-Host "  [$(ts)] WARNING: pwsh.exe not found."
    }
} catch {
    Write-Host "  [$(ts)] WARNING: Failed to install PowerShell 7: $($_.Exception.Message)"
}

# --- Set Windows Terminal as default terminal ---
Write-Host "[$(ts)] === Setting Windows Terminal as default terminal ==="
# Registry keys in HKCU:\Console\%%Startup control the default terminal app.
# These CLSIDs are from Windows Terminal's AppxManifest.xml and are stable across versions:
#   DelegationConsole (OpenConsole): {2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69}
#   DelegationTerminal (Terminal):   {E12CFF52-A866-4C77-9A90-F570A7AA2C6B}
New-Item -Path 'HKCU:\Console\%%Startup' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Console\%%Startup' -Name "DelegationConsole" -Value "{2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69}" -Type String
Set-ItemProperty -Path 'HKCU:\Console\%%Startup' -Name "DelegationTerminal" -Value "{E12CFF52-A866-4C77-9A90-F570A7AA2C6B}" -Type String

# --- Configure Windows Terminal: PS7 as default profile ---
$wtSettingsDir = "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState"
$wtSettingsFile = Join-Path $wtSettingsDir "settings.json"
if (-not (Test-Path $wtSettingsFile) -and (Test-Path $wtSettingsDir)) {
    # PowerShell Core profile GUID is stable across Terminal versions
    '{"defaultProfile": "{574e775e-4f2a-5b96-ac1e-a2962a402336}"}' | Set-Content $wtSettingsFile
    Write-Host "Windows Terminal configured with PS7 as default profile."
}

# --- Enable OpenSSH Server (done last -- Add-WindowsCapability takes several minutes) ---
Write-Host "[$(ts)] === Installing OpenSSH Server (this may take several minutes) ==="
# Add-WindowsCapability contacts Windows Update even for locally-available
# capabilities. Retry up to 3 times with 10s delay in case of network issues.
$sshInstalled = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
        Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 -ErrorAction Stop
        $sshInstalled = $true
        break
    } catch {
        Write-Host "  Attempt $attempt failed: $($_.Exception.Message)"
        if ($attempt -lt 3) { Start-Sleep -Seconds 10 }
    }
}
if (-not $sshInstalled) {
    Write-Host "  WARNING: Failed to install OpenSSH Server after 3 attempts. SSH will not be available."
}
Set-Service -Name sshd -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service sshd -ErrorAction SilentlyContinue

# Fix sshd_config: comment out the Match Group administrators block
# that forces admin users to use administrators_authorized_keys.
# This lets admin users use their own ~/.ssh/authorized_keys instead.
$sshdConfig = "C:\ProgramData\ssh\sshd_config"
if (Test-Path $sshdConfig) {
    $content = Get-Content $sshdConfig -Raw
    $content = $content -replace '(?m)^(Match Group administrators)', '#$1'
    $content = $content -replace '(?m)^(\s+AuthorizedKeysFile __PROGRAMDATA__)', '#$1'
    Set-Content -Path $sshdConfig -Value $content
}

# Allow SSH through Windows Firewall
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH SSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -ErrorAction SilentlyContinue

# Set PowerShell as default shell for SSH.
# Always use PS5.1 at its stable full path. PS7 via AppX install puts pwsh.exe
# in the user PATH but NOT the system PATH -- sshd runs as SYSTEM and can't see it.
# A bare "pwsh.exe" or version-specific AppX path will break when PS7 updates
# or after service restarts. PS5.1 is always available at a known location.
$defaultShell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $defaultShell -PropertyType String -Force -ErrorAction SilentlyContinue

# --- Deploy SSH authorized key from unattended ISO ---
if ($virtioDir) {
    $pubKey = Join-Path $virtioDir "vm.pub"
    if (Test-Path $pubKey) {
        Write-Host "[$(ts)] === Deploying SSH authorized key ==="
        $key = (Get-Content $pubKey -Raw).Trim()
        $sshDir = Join-Path $env:USERPROFILE ".ssh"
        New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
        $authKeys = Join-Path $sshDir "authorized_keys"
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($authKeys, $key, $utf8)

        # Set ACLs: user + SYSTEM only
        $acl = Get-Acl $authKeys
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($env:USERNAME, "FullControl", "Allow")))
        $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM", "FullControl", "Allow")))
        Set-Acl -Path $authKeys -AclObject $acl
        Write-Host "SSH key deployed to $authKeys"
    }
}

Restart-Service sshd -ErrorAction SilentlyContinue

# --- Disable fast startup (hibernate-on-shutdown causes issues after host sleep) ---
Write-Host "[$(ts)] === Disabling fast startup ==="
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name "HiberbootEnabled" -Value 0 -Type DWord -ErrorAction SilentlyContinue

# --- Enable End Task on taskbar right-click ---
Write-Host "[$(ts)] === Enabling End Task on taskbar ==="
$taskbarDev = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced\TaskbarDeveloperSettings'
New-Item -Path $taskbarDev -Force | Out-Null
Set-ItemProperty -Path $taskbarDev -Name "TaskbarEndTask" -Value 1 -Type DWord

Write-Host "[$(ts)] === Post-install setup complete ==="
Write-Host "Log saved to: $logFile"

Stop-Transcript
