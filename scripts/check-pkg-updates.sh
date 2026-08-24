#!/usr/bin/env bash
# Check custom packages in packages/ for newer GitHub releases.
# Uses `gh` CLI for GitHub API (authenticated via 1Password plugin).
# Falls back to unauthenticated curl if gh is unavailable.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Registry: package_file:owner/repo:tag_prefix:prerelease:version_suffix
# tag_prefix: stripped from tag to get version (e.g., "v" means "v1.0" -> "1.0")
# prerelease: "true" to include pre-releases (GitHub /releases/latest skips them)
# version_suffix: stripped from tag after prefix (e.g., "-stable" for godot)
#
# Godot: version is a callPackage arg in home-manager/default.nix, not in godot.nix.
# The package is parameterized so multiple versions can coexist (Godot 4.6.app, etc.).
# An "update" here might mean adding a new version alongside, not replacing.
REGISTRY=(
  "applaymidi.nix:benwiggy/APPlayMIDI:v:false:"
  "ericw-tools.nix:ericwa/ericw-tools::true:"
  "forepaw.nix:aviraccoon/forepaw:v:false:"
  "godot.nix:godotengine/godot::false:-stable"
  "librequake.nix:MissLavender-LQ/LibreQuake:v:true:"
  "trenchbroom.nix:TrenchBroom/TrenchBroom:v:false:"
  "vkquake.nix:MacSourcePorts/MSPBuildSystem:vkQuake_:false:"
)

# Try gh, then curl
if command -v gh &>/dev/null && gh auth status &>/dev/null; then
  api() { gh api "$1" 2>/dev/null; }
else
  api() {
    local headers=()
    [[ -n "${GITHUB_TOKEN:-}" ]] && headers=(-H "Authorization: token $GITHUB_TOKEN")
    curl -sf "${headers[@]}" "https://api.github.com$1"
  }
fi

get_current_version() {
  local file="$1"
  local filepath="$REPO_DIR/packages/$file"
  local ver
  ver=$(grep -E '^\s*version\s*=' "$filepath" | head -1 | sed 's/.*"\(.*\)".*/\1/')
  if [[ -z "$ver" ]]; then
    # Version is a callPackage arg (e.g., godot) -- find it in home-manager config
    ver=$(grep -A2 "packages/$file" "$REPO_DIR/modules/home-manager/default.nix" \
      | grep 'version' | head -1 | sed 's/.*"\(.*\)".*/\1/')
  fi
  echo "$ver"
}

get_latest_release() {
  local repo="$1" prefix="$2" prerelease="$3" suffix="$4"
  local tag

  if [[ -n "$prefix" && "$prerelease" != "true" ]]; then
    # Filter by tag prefix (e.g., vkQuake_ in a multi-project repo)
    tag=$(api "/repos/$repo/releases?per_page=20" \
      | jq -r --arg p "$prefix" '[.[] | select(.tag_name | startswith($p)) | select(.prerelease | not)][0].tag_name // empty')
  elif [[ "$prerelease" == "true" ]]; then
    tag=$(api "/repos/$repo/releases?per_page=20" | jq -r '.[0].tag_name // empty')
  else
    tag=$(api "/repos/$repo/releases/latest" | jq -r '.tag_name // empty')
  fi

  if [[ -z "$tag" ]]; then
    echo ""
    return
  fi

  # Strip tag prefix and suffix
  if [[ -n "$prefix" && "$tag" == "$prefix"* ]]; then
    tag="${tag#"$prefix"}"
  fi
  if [[ -n "$suffix" && "$tag" == *"$suffix" ]]; then
    tag="${tag%"$suffix"}"
  fi
  echo "$tag"
}

# Header
printf "%-15s %-20s %-20s %s\n" "PACKAGE" "CURRENT" "LATEST" "STATUS"
printf "%-15s %-20s %-20s %s\n" "-------" "-------" "------" "------"

has_updates=false

for entry in "${REGISTRY[@]}"; do
  IFS=: read -r file repo prefix prerelease suffix <<< "$entry"
  pkg="${file%.nix}"

  current=$(get_current_version "$file")
  latest=$(get_latest_release "$repo" "$prefix" "$prerelease" "$suffix")

  if [[ -z "$latest" ]]; then
    status="? (API error)"
  elif [[ "$current" == "$latest" ]]; then
    status="up to date"
  else
    status="UPDATE AVAILABLE"
    has_updates=true
  fi

  printf "%-15s %-20s %-20s %s\n" "$pkg" "$current" "${latest:-?}" "$status"
done

if $has_updates; then
  echo ""
  echo "To update a package:"
  echo "  1. Update version (and sha256) in the package .nix file"
  echo "  2. Get new hash: nix-prefetch-url --type sha256 <new-url>"
  echo "  3. Run: mise nix-switch"
  exit 1
fi
