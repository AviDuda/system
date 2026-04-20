# firstlogin.ps1 -- Post-install setup for Windows VM
# Runs once on first login via autounattend.xml FirstLogonCommands.
#
# Goals:
# - Install remaining VirtIO drivers (network, balloon, etc.)
# - Install SPICE guest tools (clipboard sharing, dynamic resolution)
# - Enable Remote Desktop
# - Reduce telemetry
# - Set up for forepaw accessibility testing

$ErrorActionPreference = "Continue"

# Log everything
$logFile = "$env:USERPROFILE\Desktop\firstlogin.log"
Start-Transcript -Path $logFile -Append

Write-Host "=== Windows VM post-install setup ==="
Write-Host "Time: $(Get-Date)"

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
    Write-Host "`n=== Installing VirtIO drivers ==="
    $driverDirs = Get-ChildItem -Path $virtioDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(Balloon|vioinput|vioser|viogpudo|NetKVM|viostor|viofs)$' }

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
        Write-Host "`n=== Installing UTM guest tools ==="
        Start-Process -FilePath $utmInstaller -ArgumentList "/S" -Wait
        Write-Host "UTM guest tools installed."
    }

    # --- Start SPICE VDAgent service (clipboard + dynamic resolution) ---
    if (Get-Service vdservice -ErrorAction SilentlyContinue) {
        Write-Host "`n=== Starting SPICE VDAgent ==="
        Set-Service vdservice -StartupType Automatic
        Start-Service vdservice -ErrorAction SilentlyContinue
        Write-Host "SPICE VDAgent started."
    }

    # --- Install QEMU Guest Agent if present ---
    $qemuGA = Join-Path $virtioDir "guest-agent\qemu-ga-x86_64.msi"
    if (Test-Path $qemuGA) {
        Write-Host "`n=== Installing QEMU Guest Agent ==="
        Start-Process msiexec.exe -ArgumentList "/i `"$qemuGA`" /quiet /norestart" -Wait
        Write-Host "QEMU Guest Agent installed."
    }
}

# --- Enable Remote Desktop ---
Write-Host "`n=== Enabling Remote Desktop ==="
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name "fDenyTSConnections" -Value 0 -Type DWord
Enable-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction SilentlyContinue

# --- Enable OpenSSH Server ---
Write-Host "`n=== Installing OpenSSH Server ==="
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 -ErrorAction SilentlyContinue
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

# Allow ICMP (ping) for diagnostics
New-NetFirewallRule -Name 'Allow ICMPv4' -DisplayName 'Allow ICMPv4' -Enabled True -Direction Inbound -Protocol ICMPv4 -Action Allow -Profile Any -ErrorAction SilentlyContinue

# Set PowerShell as default shell for SSH
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force -ErrorAction SilentlyContinue

# --- Deploy SSH authorized key from unattended ISO ---
if ($virtioDir) {
    $pubKey = Join-Path $virtioDir "vm.pub"
    if (Test-Path $pubKey) {
        Write-Host "`n=== Deploying SSH authorized key ==="
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

# --- Reduce telemetry ---
Write-Host "`n=== Reducing telemetry ==="
# Set telemetry to Security level (minimum)
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DataCollection' -Name "AllowTelemetry" -Value 0 -Type DWord -Force
# Disable Cortana
New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search' -Name "AllowCortana" -Value 0 -Type DWord

# --- Disable lock screen ---
Write-Host "`n=== Disabling lock screen ==="
New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' -Name "NoLockScreen" -Value 1 -Type DWord
# Disable screen timeout on AC power
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0

# --- Set power plan to High Performance ---
Write-Host "`n=== Setting High Performance power plan ==="
powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c 2>$null

# --- Disable Windows Update auto-restart ---
Write-Host "`n=== Disabling auto-restart for updates ==="
New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -Name "NoAutoRebootWithLoggedOnUsers" -Value 1 -Type DWord

# --- Disable AutoLogon after first use ---
Write-Host "`n=== Disabling AutoLogon ==="
Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name "DefaultPassword" -ErrorAction SilentlyContinue
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name "AutoAdminLogon" -Value "0"

Write-Host "`n=== Post-install setup complete ==="
Write-Host "Log saved to: $logFile"

Stop-Transcript
