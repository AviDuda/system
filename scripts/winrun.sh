#!/usr/bin/env bash
# shellcheck disable=SC2029
set -euo pipefail

# winrun.sh -- Run a PowerShell script on the Windows VM with reliable output.
#
# Usage:
#   winrun <script.ps1> [args...]       Run a local PS1 file on the VM
#   winrun -                            Read PS1 from stdin
#   winrun --log                        Print the firstlogin log
#   winrun -i <script.ps1>              Run in interactive (desktop) session
#   winrun -i -                         Read stdin, run in interactive session
#   winrun -v <script.ps1>              Verbose SSH output (debug)
#   winrun -iv <script.ps1>             Interactive + verbose
#
# Copies the script to the VM via scp, executes it, and prints all output.
# This avoids the output-swallowing issue with 'ssh ... powershell -File - <<heredoc'.
#
# The -i / --interactive flag runs the script in the user's interactive desktop
# session (session 1) instead of the SSH session (session 0). This is required for
# UI Automation, screen capture, OCR, and any API that needs desktop access.
# Implementation: wraps the script in a scheduled task, polls for output file.
#
# Automatically handles known_hosts churn from VM rebuilds -- removes stale
# host keys before connecting and accepts new ones automatically.
#
# Environment:
#   WINRUN_HOST  -- VM SSH target (default: user@windows-11.local)
#   WINRUN_KEY   -- SSH key path (default: ~/.ssh/vm)

VM_HOST="${WINRUN_HOST:-user@windows-11.local}"
SSH_KEY="${WINRUN_KEY:-$HOME/.ssh/vm}"
INTERACTIVE=false
VERBOSE=false

# Parse flags (-i, -v, --interactive, --verbose; combinable: -iv)
while [[ ${1:-} =~ ^-[iv]+$ || ${1:-} == --interactive || ${1:-} == --verbose ]]; do
    [[ "$1" == *i* || "$1" == --interactive ]] && INTERACTIVE=true
    [[ "$1" == *v* || "$1" == --verbose ]] && VERBOSE=true
    shift
done
# Skip -- separator after flags
[[ "${1:-}" == "--" ]] && shift

# Extract hostname (strip user@ prefix if present)
VM_USER="${VM_HOST%%@*}"

# Skip host key checking entirely. VMs rebuild frequently and change keys each time,
# so strict checking just causes noise. UserKnownHostsFile=/dev/null avoids both
# writing to known_hosts and the "Host X found" / "known_hosts updated" messages.
ssh_opts=(-o IdentitiesOnly=yes -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5)
scp_opts=(-o IdentitiesOnly=yes -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5)

if $VERBOSE; then
    ssh_opts+=(-v)
    scp_opts+=(-v)
fi

# Connectivity check -- fail early with a useful message
if $VERBOSE; then
    ssh -n "${ssh_opts[@]}" "$VM_HOST" "echo connection ok" || {
        echo "winrun: Cannot connect to $VM_HOST via SSH" >&2
        exit 1
    }
else
    if ! ssh -n "${ssh_opts[@]}" "$VM_HOST" "echo ok" >/dev/null 2>&1; then
        echo "winrun: Cannot connect to $VM_HOST via SSH" >&2
        echo "  Key: $SSH_KEY" >&2
        echo "  Run with -v for detailed SSH diagnostics." >&2
        exit 1
    fi
fi

# Helper: scp with quiet mode in non-verbose, errors always visible
do_scp() {
    local quiet=()
    $VERBOSE || quiet=(-q)
    scp "${scp_opts[@]}" "${quiet[@]}" "$@"
}

# run_interactive wraps a script in a scheduled task to execute in the
# interactive desktop session. Captures output via temp file polling.
run_interactive() {
    local remote_ps1="$1"
    local timestamp
    timestamp=$(date +%s)
    local task_name="winrun-$timestamp"
    local output_file="C:/Users/$VM_USER/AppData/Local/Temp/winrun-out-$timestamp.txt"
    local wrapper_ps1="C:/Users/$VM_USER/AppData/Local/Temp/winrun-wrapper-$timestamp.ps1"
    local launcher_vbs="C:/Users/$VM_USER/AppData/Local/Temp/winrun-launcher-$timestamp.vbs"

    # Generate wrapper locally and scp it (avoids remote quoting hell)
    local local_wrapper
    local_wrapper=$(mktemp)
    echo "powershell -ExecutionPolicy Bypass -File \"$remote_ps1\" 2>&1 | Out-File -Encoding utf8 \"$output_file\"" > "$local_wrapper"
    do_scp "$local_wrapper" "$VM_HOST:$wrapper_ps1" || exit 1
    rm -f "$local_wrapper"

    # Generate a VBS launcher that runs the wrapper hidden (no console window flash).
    # PowerShell -WindowStyle Hidden still flashes briefly; VBScript Run with 0
    # (hidden window) is the reliable way on Windows.
    local local_vbs
    local_vbs=$(mktemp)
    echo "Set objShell = CreateObject(\"WScript.Shell\")" > "$local_vbs"
    echo "objShell.Run \"powershell -ExecutionPolicy Bypass -File $wrapper_ps1\", 0, True" >> "$local_vbs"
    do_scp "$local_vbs" "$VM_HOST:$launcher_vbs" || exit 1
    rm -f "$local_vbs"

    # Delete stale output from previous runs
    ssh "${ssh_opts[@]}" "$VM_HOST" "del /q '$output_file'" 2>/dev/null || true

    # Create and run scheduled task via VBS launcher (hidden window)
    if ! ssh "${ssh_opts[@]}" "$VM_HOST" "schtasks /Create /TN $task_name /TR \"wscript.exe //nologo $launcher_vbs\" /SC ONCE /ST 00:00 /RU $VM_USER /IT /F" >/dev/null; then
        echo "winrun: Failed to create scheduled task for interactive session" >&2
        exit 1
    fi
    if ! ssh "${ssh_opts[@]}" "$VM_HOST" "schtasks /Run /TN $task_name" >/dev/null; then
        echo "winrun: Failed to run scheduled task" >&2
        exit 1
    fi

    # Poll for output file (timeout 120s)
    local elapsed=0
    local timed_out=false
    while (( elapsed < 120 )); do
        sleep 2
        (( elapsed += 2 )) || true
        # Check if output file exists and has content
        if ssh "${ssh_opts[@]}" "$VM_HOST" "powershell -Command \"if (Test-Path '$output_file') { (Get-Item '$output_file').Length -gt 0 }\"" 2>/dev/null | grep -q True; then
            break
        fi
    done
    if (( elapsed >= 120 )); then
        echo "winrun: Timed out waiting for interactive script output (120s)" >&2
        timed_out=true
    fi

    # Retrieve output
    if ! $timed_out; then
        ssh "${ssh_opts[@]}" "$VM_HOST" "type '$output_file'" 2>/dev/null || true
    fi

    # Cleanup
    ssh "${ssh_opts[@]}" "$VM_HOST" "schtasks /Delete /TN $task_name /F" 2>/dev/null || true
    ssh "${ssh_opts[@]}" "$VM_HOST" "del /q '$remote_ps1' '$wrapper_ps1' '$launcher_vbs' '$output_file'" 2>/dev/null || true
}

run_script() {
    local remote_ps1="$1"
    shift
    if $INTERACTIVE; then
        run_interactive "$remote_ps1"
    else
        ssh "${ssh_opts[@]}" "$VM_HOST" "powershell -ExecutionPolicy Bypass -File \"$remote_ps1\" $*"
        ssh "${ssh_opts[@]}" "$VM_HOST" "del /q \"$remote_ps1\"" 2>/dev/null || true
    fi
}

case "${1:-}" in
    --log)
        REMOTE_PS1="C:/Users/$VM_USER/AppData/Local/Temp/winrun-log.ps1"
        local_ps1=$(mktemp)
        cat > "$local_ps1" << 'PS1'
$logFile = Join-Path $env:USERPROFILE "Desktop\firstlogin.log"
if (Test-Path $logFile) {
    Get-Content $logFile
} else {
    Write-Host "No firstlogin.log found on desktop."
}
PS1
        do_scp "$local_ps1" "$VM_HOST:$REMOTE_PS1" || exit 1
        rm -f "$local_ps1"
        run_script "$REMOTE_PS1"
        ;;
    -)
        # Read stdin to temp file BEFORE any SSH calls (they would consume stdin)
        local_ps1=$(mktemp)
        cat > "$local_ps1"
        REMOTE_PS1="C:/Users/$VM_USER/AppData/Local/Temp/winrun-$(date +%s).ps1"
        do_scp "$local_ps1" "$VM_HOST:$REMOTE_PS1" || exit 1
        rm -f "$local_ps1"
        run_script "$REMOTE_PS1"
        ;;
    -h|--help)
        sed -n '/^# Usage:/,/^[^#]/p' "$0" | head -n -1 | sed 's/^# \?//'
        ;;
    *)
        SCRIPT="$(realpath "$1")"
        shift
        REMOTE_PS1="C:/Users/$VM_USER/AppData/Local/Temp/winrun-$(date +%s).ps1"
        do_scp "$SCRIPT" "$VM_HOST:$REMOTE_PS1" || exit 1
        run_script "$REMOTE_PS1" "$@"
        ;;
esac
