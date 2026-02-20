#!/usr/bin/env bash
# Wrapper for darwin-rebuild switch that shows which running apps were updated
set -euo pipefail

# Capture current system for diff after switch
old_system=$(readlink /run/current-system)

# Refresh Homebrew formulae so brew bundle can find packages (skip with SKIP_BREW=1)
if [[ "${SKIP_BREW:-}" != "1" ]]; then
    echo "Updating Homebrew formulae..."
    brew update
fi

# Run the switch (installs new packages, removes unlisted, no upgrade)
sudo darwin-rebuild --flake ".#${FLAKE_HOST:-$(hostname)}" switch

# Upgrade Homebrew packages after bundle has synced the package list
upgraded=""
if [[ "${SKIP_BREW:-}" != "1" ]]; then
    echo ""
    echo "Upgrading Homebrew packages..."
    # Capture outdated list before and after to determine what actually upgraded
    outdated_before=$(brew outdated --greedy --quiet 2>/dev/null || true)
    if ! brew upgrade --greedy; then
        echo "⚠️  brew upgrade had errors (nix switch succeeded, continuing)"
    fi
    if [[ -n "$outdated_before" ]]; then
        outdated_after=$(brew outdated --greedy --quiet 2>/dev/null || true)
        # Actually upgraded = was outdated before but not after
        upgraded=$(comm -23 <(echo "$outdated_before" | sort) <(echo "$outdated_after" | sort))
        failed=$(comm -12 <(echo "$outdated_before" | sort) <(echo "$outdated_after" | sort))
    fi
fi

if [[ -n "$upgraded" || -n "${failed:-}" ]]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [[ -n "$upgraded" ]]; then
        echo "📦 Upgraded Homebrew packages:"
        # shellcheck disable=SC2086 # Word splitting intentional - one package per line
        printf "   %s\n" $upgraded
    fi
    if [[ -n "${failed:-}" ]]; then
        echo "⚠️  Failed to upgrade:"
        # shellcheck disable=SC2086
        printf "   %s\n" $failed
    fi

    # Auto-restart apps after upgrade. These have no unsaved state.
    # Format: "cask-name:ProcessName:BundleName"
    # BundleName is optional - defaults to ProcessName if omitted.
    # To find process name: pgrep -l <pattern> while app is running
    auto_restart_apps=(
        # REQUIRED: These hook into system input events. Running stale processes
        # after .app bundle replacement causes system-wide issues.
        "hammerspoon:Hammerspoon"

        # OPTIONAL: Menu bar utilities - nice to restart for consistency
        "alcove:Alcove"
        "aldente:AlDente"
        "clop:Clop"
        "jordanbaird-ice:Ice"
        "music-presence:Music Presence"
        "raycast:Raycast"
        "shottr:Shottr"
        "stats:Stats"
        "pallotron-yubiswitch:yubiswitch"
        "yubico-authenticator:Yubico Authenticator"
        "yubico-yubikey-manager:ykman-gui:YubiKey Manager"
    )

    restarted_casks=""
    for entry in "${auto_restart_apps[@]}"; do
        cask="${entry%%:*}"
        rest="${entry#*:}"
        process="${rest%%:*}"
        # Bundle name defaults to process name if not specified
        if [[ "$rest" == *:* ]]; then
            bundle="${rest#*:}"
        else
            bundle="$process"
        fi
        if echo "$upgraded" | grep -q "$cask"; then
            if pgrep -x "$process" > /dev/null; then
                echo ""
                echo "🔄 Restarting $bundle..."
                killall "$process" 2>/dev/null
                sleep 1
                # Use direct path to bypass Launch Services (stale after cask upgrade)
                open "/Applications/$bundle.app"
                echo "✓ $bundle restarted"
                restarted_casks+="$cask"$'\n'
            fi
        fi
    done

    # Check which running apps need manual restart (updated but not auto-restarted)
    # Capture process list once. IMPORTANT: do not use `grep -q` on the live
    # `ps -eo comm` pipe -- under pipefail, grep -q exits early on match,
    # ps gets SIGPIPE (exit 141), and the pipeline returns non-zero.
    ps_output=$(ps -eo comm)
    needs_manual=""
    while IFS= read -r cask; do
        [[ -z "$cask" ]] && continue
        # Skip if this cask was auto-restarted
        if echo "$restarted_casks" | grep -q "^${cask}$"; then
            continue
        fi
        # Strip tap prefix (e.g., anomalyco/tap/opencode -> opencode)
        cask_name="${cask##*/}"
        # Find the .app bundle and check if its executable is running
        pattern="${cask_name//-/ }"
        app_path=$(find /Applications -maxdepth 1 -iname "*$pattern*.app" 2>/dev/null | head -1)
        # Fallback: try last word (e.g., jordanbaird-ice -> ice)
        if [[ -z "$app_path" ]]; then
            last_word="${cask_name##*-}"
            app_path=$(find /Applications -maxdepth 1 -iname "*$last_word*.app" 2>/dev/null | head -1)
        fi
        if [[ -n "$app_path" ]]; then
            executable=$(defaults read "$app_path/Contents/Info" CFBundleExecutable 2>/dev/null)
            if [[ -n "$executable" ]] && echo "$ps_output" | grep -q "$app_path/Contents/MacOS/$executable"; then
                needs_manual+="   $cask"$'\n'
            fi
        fi
    done <<< "$upgraded"

    if [[ -n "$needs_manual" ]]; then
        echo ""
        echo "⚠️  Needs manual restart:"
        echo -n "$needs_manual"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi

# Show what changed in Nix packages
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📦 Nix package changes:"
nvd --color always diff "$old_system" /run/current-system
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
