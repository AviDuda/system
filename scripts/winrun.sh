#!/usr/bin/env bash
# shellcheck disable=SC2029
set -euo pipefail

# winrun.sh -- Run a PowerShell script on the Windows VM with reliable output.
#
# Usage:
#   winrun <script.ps1> [args...]       Run a local PS1 file on the VM
#   winrun -                            Read PS1 from stdin
#   winrun --log                        Print the firstlogin log
#
# Copies the script to the VM via scp, executes it, and prints all output.
# This avoids the output-swallowing issue with 'ssh ... powershell -File - <<heredoc'.
#
# Automatically handles known_hosts churn from VM rebuilds -- removes stale
# host keys before connecting and accepts new ones automatically.
#
# Environment:
#   WINRUN_HOST  -- VM SSH target (default: avi@windows-11.local)
#   WINRUN_KEY   -- SSH key path (default: ~/.ssh/vm)

VM_HOST="${WINRUN_HOST:-avi@windows-11.local}"
SSH_KEY="${WINRUN_KEY:-$HOME/.ssh/vm}"

# Extract hostname (strip user@ prefix if present)
VM_NAME="${VM_HOST##*@}"

# Remove stale host key (VM rebuilds change it every time)
ssh-keygen -R "$VM_NAME" 2>/dev/null || true
# Also try the .local variant or bare hostname
ssh-keygen -R "$VM_NAME.local" 2>/dev/null || true

ssh_opts=(-o IdentitiesOnly=yes -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)
scp_opts=(-o IdentitiesOnly=yes -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)

case "${1:-}" in
    --log)
        REMOTE_PS1="C:/Users/avi/AppData/Local/Temp/winrun-log.ps1"
        local_ps1=$(mktemp)
        cat > "$local_ps1" << 'PS1'
$logFile = Join-Path $env:USERPROFILE "Desktop\firstlogin.log"
if (Test-Path $logFile) {
    Get-Content $logFile
} else {
    Write-Host "No firstlogin.log found on desktop."
}
PS1
        scp "${scp_opts[@]}" "$local_ps1" "$VM_HOST:$REMOTE_PS1" >/dev/null 2>&1
        rm -f "$local_ps1"
        ssh "${ssh_opts[@]}" "$VM_HOST" "powershell -ExecutionPolicy Bypass -File \"$REMOTE_PS1\""
        ssh "${ssh_opts[@]}" "$VM_HOST" "del /q \"$REMOTE_PS1\"" 2>/dev/null || true
        ;;
    -)
        # Read stdin to temp file BEFORE any SSH calls (they would consume stdin)
        local_ps1=$(mktemp)
        cat > "$local_ps1"
        REMOTE_PS1="C:/Users/avi/AppData/Local/Temp/winrun-$(date +%s).ps1"
        scp "${scp_opts[@]}" "$local_ps1" "$VM_HOST:$REMOTE_PS1" >/dev/null 2>&1
        rm -f "$local_ps1"
        ssh "${ssh_opts[@]}" "$VM_HOST" "powershell -ExecutionPolicy Bypass -File \"$REMOTE_PS1\""
        ssh "${ssh_opts[@]}" "$VM_HOST" "del /q \"$REMOTE_PS1\"" 2>/dev/null || true
        ;;
    -h|--help)
        sed -n '/^# Usage:/,/^[^#]/p' "$0" | head -n -1 | sed 's/^# \?//'
        ;;
    *)
        SCRIPT="$(realpath "$1")"
        shift
        REMOTE_PS1="C:/Users/avi/AppData/Local/Temp/winrun-$(date +%s).ps1"
        scp "${scp_opts[@]}" "$SCRIPT" "$VM_HOST:$REMOTE_PS1" >/dev/null 2>&1
        ssh "${ssh_opts[@]}" "$VM_HOST" "powershell -ExecutionPolicy Bypass -File \"$REMOTE_PS1\" $*"
        ssh "${ssh_opts[@]}" "$VM_HOST" "del /q \"$REMOTE_PS1\"" 2>/dev/null || true
        ;;
esac
