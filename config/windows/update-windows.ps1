# update-windows.ps1 -- Install all pending Windows Updates with automatic reboots
#
# Usage (from host):
#   ssh -i ~/.ssh/vm avi@windows-11.local 'powershell -ExecutionPolicy Bypass -File -' < config/windows/update-windows.ps1
#
# Uses the Windows Update COM API directly (no PSWindowsUpdate module needed).
# Loops: search → download → install → reboot → repeat until no pending updates.
# Based on the approach used by packer-plugin-windows-update.

$ErrorActionPreference = "Stop"

function Install-PendingUpdates {
    $session = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()

    Write-Host "Searching for pending updates..."
    $result = $searcher.Search("IsInstalled=0 and Type='Software'")

    if ($result.Updates.Count -eq 0) {
        Write-Host "No pending updates found."
        return $false
    }

    Write-Host "Found $($result.Updates.Count) pending update(s):"
    foreach ($u in $result.Updates) {
        Write-Host "  - $($u.Title)"
    }

    # Collect updates into an update collection
    $updatesToInstall = New-Object -ComObject Microsoft.Update.UpdateColl
    $downloadedCount = 0
    $skippedCount = 0

    foreach ($u in $result.Updates) {
        # Skip updates that require user interaction (EULA not accepted)
        if ($u.EulaAccepted -eq $false -and $u.IsHidden -eq $false) {
            $u.AcceptEula()
        }
        if (-not $u.IsHidden) {
            $updatesToInstall.Add($u) | Out-Null
            $downloadedCount++
        } else {
            $skippedCount++
        }
    }

    if ($downloadedCount -eq 0) {
        Write-Host "All updates are hidden, nothing to install."
        return $false
    }

    if ($skippedCount -gt 0) {
        Write-Host "Skipping $skippedCount hidden update(s)."
    }

    # Download
    Write-Host "Downloading $($updatesToInstall.Count) update(s)..."
    $downloader = $session.CreateUpdateDownloader()
    $downloader.Updates = $updatesToInstall
    $downloadResult = $downloader.Download()

    if ($downloadResult.ResultCode -ne 2) {  # 2 = succeeded
        Write-Host "ERROR: Download failed with result code $($downloadResult.ResultCode)"
        return $false
    }

    # Install
    Write-Host "Installing $($updatesToInstall.Count) update(s)..."
    $installer = $session.CreateUpdateInstaller()
    $installer.Updates = $updatesToInstall
    $installResult = $installer.Install()

    # Result codes: 0=not started, 1=in progress, 2=succeeded, 3=succeeded with errors,
    # 4=failed, 5=aborted
    if ($installResult.ResultCode -eq 2 -or $installResult.ResultCode -eq 3) {
        $succeeded = ($installResult.GetUpdateResult(0).ResultCode -eq 2)
        if ($installResult.ResultCode -eq 3) {
            Write-Host "WARNING: Some updates completed with errors."
        }
        if ($installResult.RebootRequired) {
            Write-Host "Reboot required. Restarting in 5 seconds..."
            return $true  # signal: reboot needed
        }
        Write-Host "Updates installed. No reboot required."
        return $false
    } else {
        Write-Host "ERROR: Install failed with result code $($installResult.ResultCode)"
        return $false
    }
}

# Main loop: install updates until none remain or no reboot is needed
$iteration = 0
$maxIterations = 10  # safety limit

while ($iteration -lt $maxIterations) {
    $iteration++
    Write-Host "`n=== Update pass $iteration ==="

    try {
        $needsReboot = Install-PendingUpdates
    } catch {
        Write-Host "ERROR: $($_.Exception.Message)"
        Write-Host "Windows Update API sometimes fails on first try. Retries may help."
        break
    }

    if ($needsReboot) {
        Write-Host "Rebooting to apply updates..."
        # Schedule reboot and exit -- re-run this script after reboot
        shutdown /r /t 5 /c "Rebooting for Windows Updates"
        Write-Host "Run this script again after reboot to check for more updates."
        return
    } else {
        break  # no more updates or no reboot needed
    }
}

Write-Host "`n=== Update complete ==="
