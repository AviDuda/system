# iTerm2 settings management (macOS only)
#
# Uses iTerm2's built-in "Load preferences from custom folder" feature.
# The plist at config/iterm2/ is the source of truth. iTerm2 reads it on
# launch and writes changes back on quit (with prompt or automatic).
#
# Volatile keys (NS*, SU*, NoSync*) are excluded from sync by iTerm2 itself.
# See iTermRemotePreferences.m in the iTerm2 source for the full filter logic.
#
# Preference key names are defined in iTermPreferences.m:
# https://github.com/gnachman/iTerm2/blob/master/sources/Settings/iTermPreferences.m
{
  config,
  lib,
  pkgs,
  ...
}:
let
  isDarwin = pkgs.stdenvNoCC.isDarwin;
  cfgDir = "${config.xdg.configHome}/iterm2";
  managedPlist = ../../config/iterm2/com.googlecode.iterm2.plist;
in
{
  home.activation.iterm2Settings = lib.hm.dag.entryAfter [ "writeBoundary" ] (
    if isDarwin then
      ''
        $DRY_RUN_CMD mkdir -p "${cfgDir}"

        plist="${cfgDir}/com.googlecode.iterm2.plist"

        if [[ -f "$plist" ]]; then
          # Compare managed vs deployed, ignoring volatile keys iTerm2 adds at runtime.
          # These keys (NS*, SU*, Apple*, NoSync*) are system/session state -- not our config.
          # Plist format is <key>Name</key> followed by a single-line value, so we can
          # filter diff output by skipping the key line and the next line.
          filter_volatile() {
            ${pkgs.gawk}/bin/awk '
              /^[<>].*<key>(NS|SU|Apple|NoSync)/ { skip=1; next }
              skip { skip=0; next }
              { print }
            '
          }
          if ! diff <(${pkgs.gnused}/bin/sed '/<key>\(NS\|SU\|Apple\|NoSync\)/,+1d' "${managedPlist}") \
                    <(${pkgs.gnused}/bin/sed '/<key>\(NS\|SU\|Apple\|NoSync\)/,+1d' "$plist") \
                    > /dev/null 2>&1; then
            echo "WARNING: iTerm2 settings differ from Nix-managed version"
            echo "Diff (deployed vs new, volatile keys hidden):"
            diff "$plist" "${managedPlist}" | filter_volatile || true
            echo ""
            echo "Overwriting with Nix-managed version..."
          fi
        fi

        $DRY_RUN_CMD cp -f "${managedPlist}" "$plist"
      ''
    else
      ""
  );

  home.activation.iterm2CustomFolder = lib.hm.dag.entryAfter [ "writeBoundary" ] (
    if isDarwin then
      ''
        if pgrep -f "iTerm\\.app" > /dev/null 2>&1; then
          echo "NOTE: iTerm2 is running. Settings will take effect on next launch."
        fi

        $DRY_RUN_CMD /usr/bin/defaults write com.googlecode.iterm2 LoadPrefsFromCustomFolder -bool true
        $DRY_RUN_CMD /usr/bin/defaults write com.googlecode.iterm2 PrefsCustomFolder -string "${cfgDir}"
      ''
    else
      ""
  );
}
