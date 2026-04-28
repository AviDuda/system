# fix-ssh-auth.ps1 -- Diagnose and fix SSH public key authentication.
#
# When sshd rejects a key that's in ~/.ssh/authorized_keys, the usual
# causes on Windows are:
#   1. ACLs on authorized_keys (must be user+SYSTEM only, no inheritance)
#   2. sshd_config Match Group block overriding the key location
#   3. Wrong line endings or encoding in authorized_keys
#   4. sshd didn't re-read config after changes
#
# Run this on the VM console (not via SSH -- you can't SSH in if auth is broken):
#   powershell -ExecutionPolicy Bypass -File fix-ssh-auth.ps1
#
# Optionally pass a public key to deploy:
#   powershell -ExecutionPolicy Bypass -File fix-ssh-auth.ps1 -PublicKey "ssh-ed25519 AAAA... user@host"

param(
    [string]$PublicKey = "",
    [switch]$FixOwner,
    [switch]$EnableDebugLog,
    [switch]$ShowLog
)

$ErrorActionPreference = "Continue"

# Timestamp helper
function ts { Get-Date -Format "HH:mm:ss" }

Write-Host "[$(ts)] === SSH Auth Diagnosis ==="
Write-Host ""

# 1. Check sshd service
Write-Host "[$(ts)] --- sshd service ---"
$sshd = Get-Service sshd -ErrorAction SilentlyContinue
if ($sshd) {
    Write-Host "Status: $($sshd.Status)"
    Write-Host "StartType: $($sshd.StartType)"
} else {
    Write-Host "sshd service not found!"
}

# 2. Check default shell
Write-Host ""
Write-Host "[$(ts)] --- Default shell ---"
$shell = (Get-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -ErrorAction SilentlyContinue).DefaultShell
Write-Host "DefaultShell: $shell"
if ($shell -and $shell -match '_\d+\.\d+\.\d+\.\d+_') {
    Write-Host "WARNING: Shell path contains version-specific AppX directory. PS7 updates will break this."
    Write-Host "Fix: Set-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'pwsh.exe'"
}
if ($shell -and -not (Test-Path $shell) -and $shell -notmatch '\.exe$' -and -not (Get-Command $shell -ErrorAction SilentlyContinue)) {
    Write-Host "WARNING: Shell path does not exist and command not found on PATH. SSH will fail with NOUSER."
}

# 3. Check sshd_config for Match Group block
Write-Host ""
Write-Host "[$(ts)] --- sshd_config Match block ---"
$config = "C:\ProgramData\ssh\sshd_config"
if (Test-Path $config) {
    $lines = Get-Content $config
    $inMatch = $false
    foreach ($line in $lines) {
        if ($line -match "Match Group") { $inMatch = $true }
        if ($inMatch) {
            Write-Host "  $line"
            if ($line -eq "" -and -not $line.StartsWith("#")) { $inMatch = $false }
        }
    }
} else {
    Write-Host "sshd_config not found at $config"
}

# 4. Check authorized_keys locations
Write-Host ""
Write-Host "[$(ts)] --- ~/.ssh/authorized_keys ---"
$userAuthKeys = Join-Path $env:USERPROFILE ".ssh\authorized_keys"
if (Test-Path $userAuthKeys) {
    Write-Host "Path: $userAuthKeys"
    $content = Get-Content $userAuthKeys -Raw
    Write-Host "Content: $($content.Trim())"
    Write-Host "Size: $($content.Length) bytes"

    # Check encoding
    $bytes = [System.IO.File]::ReadAllBytes($userAuthKeys)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        Write-Host "Encoding: UTF-8 with BOM (PROBLEM - sshd expects no BOM)"
    } else {
        Write-Host "Encoding: no BOM (good)"
    }

    # Check line endings
    if ($content -match "`r`n") {
        Write-Host "Line endings: CRLF"
    } elseif ($content -match "`n") {
        Write-Host "Line endings: LF (good)"
    }

    # Check ACLs
    Write-Host ""
    Write-Host "ACLs:"
    $acl = Get-Acl $userAuthKeys
    Write-Host "  Owner: $($acl.Owner)"
    Write-Host "  Access:"
    foreach ($rule in $acl.Access) {
        Write-Host "    $($rule.IdentityReference) -> $($rule.FileSystemRights) ($($rule.AccessControlType))"
    }
    Write-Host "  AreAccessRulesProtected: $($acl.AreAccessRulesProtected) (should be True)"

    # Check parent dir ACLs too
    Write-Host ""
    $sshDir = Join-Path $env:USERPROFILE ".ssh"
    Write-Host ".ssh dir ACLs:"
    $dirAcl = Get-Acl $sshDir
    foreach ($rule in $dirAcl.Access) {
        Write-Host "    $($rule.IdentityReference) -> $($rule.FileSystemRights) ($($rule.AccessControlType))"
    }
} else {
    Write-Host "NOT FOUND: $userAuthKeys"
}

# 5. Check administrators_authorized_keys (used when Match Group is active)
Write-Host ""
Write-Host "[$(ts)] --- administrators_authorized_keys ---"
$adminAuthKeys = "C:\ProgramData\ssh\administrators_authorized_keys"
if (Test-Path $adminAuthKeys) {
    Write-Host "Path: $adminAuthKeys"
    Write-Host "Content: $((Get-Content $adminAuthKeys -Raw).Trim())"
} else {
    Write-Host "Not present (OK if Match Group is commented out)"
}

# 6. Check if user is in Administrators
Write-Host ""
Write-Host "[$(ts)] --- User groups ---"
$groups = net user $env:USERNAME 2>$null | Select-String "Local Group"
Write-Host $groups

# 7. Deploy key and fix everything if -PublicKey was provided
if ($PublicKey -ne "") {
    Write-Host ""
    Write-Host "[$(ts)] === Fixing SSH auth ==="

    # Write authorized_keys with no BOM, LF line endings
    $sshDir = Join-Path $env:USERPROFILE ".ssh"
    New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
    $authKeys = Join-Path $sshDir "authorized_keys"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($authKeys, $PublicKey.Trim() + "`n", $utf8NoBom)
    Write-Host "Wrote key to $authKeys"

    # Fix ACLs: remove inheritance, user + SYSTEM only
    $acl = Get-Acl $authKeys
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($env:USERNAME, "FullControl", "Allow")))
    $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM", "FullControl", "Allow")))
    Set-Acl -Path $authKeys -AclObject $acl
    Write-Host "Fixed ACLs on authorized_keys"

    # Also fix .ssh directory ACLs
    $dirAcl = Get-Acl $sshDir
    $dirAcl.SetAccessRuleProtection($true, $false)
    $dirAcl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($env:USERNAME, "FullControl", "Allow")))
    $dirAcl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM", "FullControl", "Allow")))
    Set-Acl -Path $sshDir -AclObject $dirAcl
    Write-Host "Fixed ACLs on .ssh directory"

    # Ensure Match Group is commented out
    if (Test-Path $config) {
        $content = Get-Content $config -Raw
        $original = $content
        $content = $content -replace '(?m)^(Match Group administrators)', '#$1'
        $content = $content -replace '(?m)^(\s+AuthorizedKeysFile __PROGRAMDATA__)', '#$1'
        if ($content -ne $original) {
            [System.IO.File]::WriteAllText($config, $content, $utf8NoBom)
            Write-Host "Commented out Match Group block in sshd_config"
        } else {
            Write-Host "sshd_config Match Group already commented out"
        }
    }

    # Restart sshd
    Restart-Service sshd
    Write-Host "Restarted sshd"
    Write-Host ""
    Write-Host "Done. Try SSH again."
}

# -FixOwner: fix file ownership on authorized_keys and .ssh dir
if ($FixOwner) {
    Write-Host ""
    Write-Host "[$(ts)] === Fixing file ownership ==="
    $authKeys = Join-Path $env:USERPROFILE ".ssh\authorized_keys"
    $sshDir = Join-Path $env:USERPROFILE ".ssh"
    if (Test-Path $authKeys) {
        icacls $authKeys /setowner $env:USERNAME
        Write-Host "Fixed owner on $authKeys"
    }
    if (Test-Path $sshDir) {
        icacls $sshDir /setowner $env:USERNAME
        Write-Host "Fixed owner on $sshDir"
    }
}

# -EnableDebugLog: set LogLevel DEBUG3 in sshd_config and restart
if ($EnableDebugLog) {
    Write-Host ""
    Write-Host "[$(ts)] === Enabling DEBUG3 logging ==="
    $config = "C:\ProgramData\ssh\sshd_config"
    if (Test-Path $config) {
        $content = Get-Content $config -Raw
        # Remove existing LogLevel line
        $content = $content -replace '(?m)^\s*LogLevel.*\r?\n', ''
        # Add LogLevel DEBUG3 after the first comment block
        $content = "LogLevel DEBUG3`n" + $content
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($config, $content, $utf8NoBom)
        Write-Host "Set LogLevel DEBUG3 in sshd_config"
        Restart-Service sshd
        Write-Host "Restarted sshd. Try connecting again, then run -ShowLog."
        Write-Host "To restore: edit C:\ProgramData\ssh\sshd_config, remove LogLevel line, restart sshd."
    } else {
        Write-Host "sshd_config not found"
    }
}

# -ShowLog: display recent sshd log entries
if ($ShowLog) {
    Write-Host ""
    Write-Host "[$(ts)] === sshd log ==="
    $logPath = "C:\ProgramData\ssh\logs\sshd.log"
    $since = (Get-Date).AddMinutes(-5)
    if (Test-Path $logPath) {
        Write-Host "Last 5 min of $logPath`:"
        Write-Host "---"
        # sshd log lines don't have timestamps, so just show last 80
        Get-Content $logPath -Tail 80
    } else {
        Write-Host "No log file at $logPath"
        Write-Host "Checking Windows event log for SSH logon failures (last 5 min)..."
        $events = Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625; StartTime=$since} -ErrorAction SilentlyContinue
        if ($events) {
            foreach ($evt in ($events | Sort-Object TimeCreated -Descending)) {
                $xml = [xml]$evt.ToXml()
                $target = ($xml.Event.EventData.Data | Where-Object { $_.Name -eq 'TargetUserName' }).'#text'
                $subStatus = ($xml.Event.EventData.Data | Where-Object { $_.Name -eq 'SubStatus' }).'#text'
                $caller = ($xml.Event.EventData.Data | Where-Object { $_.Name -eq 'CallerProcessName' }).'#text'
                Write-Host "[$($evt.TimeCreated.ToString('HH:mm:ss'))] user=$target substatus=$subStatus process=$caller"
            }
        } else {
            Write-Host "No 4625 events in last 5 minutes."
        }
        Write-Host ""
        Write-Host "Try -EnableDebugLog first, attempt a connection, then -ShowLog again."
    }
}
