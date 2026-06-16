#!/usr/bin/env bash
# Check the age, yanked status, and freshness of Rust crate dependencies.
#
# Modes:
#   cargo-dep-age.sh [--proposed] [CARGO_UPDATE_ARGS...]
#     Check crates that `cargo update` would add or change.
#     Extra args are passed to cargo update. Default mode.
#     Example: cargo-dep-age.sh -p anyhow
#
#   cargo-dep-age.sh --safe
#     For each direct dependency in Cargo.toml, check whether updating it
#     would pull in any fresh or yanked transitive deps.
#
#   cargo-dep-age.sh --lockfile [/path/to/Cargo.lock]
#     Check all pinned versions in a lockfile. Slow.
#
# Output is sorted freshest-first. Exits 1 if any crate is yanked or
# younger than --min-age (default 14 days).
#
# Requires: curl, jq, date (GNU or BSD)
set -euo pipefail

MIN_AGE_DAYS=14
MODE=""
CARGO_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --min-age)
      MIN_AGE_DAYS="$2"
      shift 2
      ;;
    --proposed)
      if [[ "$MODE" == "safe" ]]; then
        echo "Error: --proposed and --safe are mutually exclusive" >&2
        exit 2
      fi
      MODE="dryrun"
      shift
      ;;
    --safe)
      if [[ -n "$MODE" ]]; then
        echo "Error: --safe and --proposed are mutually exclusive" >&2
        exit 2
      fi
      MODE="safe"
      shift
      ;;
    --lockfile)
      if [[ -n "$MODE" ]]; then
        echo "Error: --lockfile cannot be combined with other modes" >&2
        exit 2
      fi
      MODE="lockfile"
      shift
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        CARGO_ARGS+=("$1")
        shift
      done
      ;;
    -h|--help)
      cat <<'HELP'
Usage: cargo-dep-age.sh [OPTIONS]

Modes:
  cargo-dep-age.sh [--proposed] [CARGO_UPDATE_ARGS...]
    Check crates that `cargo update` would add or change. Fast: only
    queries changed crates. This is the default mode.
    Example: cargo-dep-age.sh -p anyhow

  cargo-dep-age.sh --safe
    For each direct dependency in Cargo.toml, check whether updating it
    (via `cargo update -p <dep>`) would pull in any fresh or yanked
    transitive deps. Reports safe vs blocked per dep.

  cargo-dep-age.sh --lockfile [/path/to/Cargo.lock]
    Check all pinned versions in a lockfile (default: Cargo.lock).
    Slow: one crates.io API call per dependency (~1 req/sec due to rate limits).
    For 200+ crates this takes several minutes.

Options:
  --min-age DAYS   Flag versions younger than DAYS (default: 14)
  --proposed       Check what cargo update would change (default)
  --safe           Per-direct-dep safety check
  --lockfile       Check all crates in lockfile
  -h, --help       Show this help

Requires: curl, jq, date (GNU or BSD)

Exit codes:
  0  All crates passed (no fresh or yanked versions)
  1  One or more crates are yanked or younger than --min-age
  2  Usage error (missing tools, file not found)
HELP
      exit 0
      ;;
    -*)
      echo "Error: unknown option: $1" >&2
      exit 2
      ;;
    *)
      # Cargo update args (e.g. -p crate) or lockfile path.
      # In proposed/safe mode, treat as cargo update args.
      if [[ "$MODE" != "lockfile" ]]; then
        CARGO_ARGS+=("$1")
      else
        LOCKFILE="$1"
      fi
      shift
      ;;
  esac
done

LOCKFILE="${LOCKFILE:-Cargo.lock}"

# Default mode: --proposed.
MODE="${MODE:-dryrun}"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required" >&2
  exit 2
fi

# --safe: per-direct-dep safety check (early exit).
if [[ "$MODE" == "safe" ]]; then
  if [[ ! -f Cargo.toml ]]; then
    echo "Error: Cargo.toml not found (needed for --safe mode)" >&2
    exit 2
  fi

  # Parse direct dependency names from Cargo.toml.
  direct_deps=$(awk '
    /^\[dependencies\]/ { in_deps=1; next }
    /^\[target\./ { if (/dependencies\]$/) in_deps=1; next }
    /^\[/ { in_deps=0 }
    in_deps && /^[a-zA-Z0-9_-]+\s*=/ {
      match($0, /^[a-zA-Z0-9_-]+/)
      print substr($0, RSTART, RLENGTH)
    }
  ' Cargo.toml | sort -u)

  dep_total=$(echo "$direct_deps" | wc -l | tr -d ' ')
  echo "Checking $dep_total direct dependencies for safe updates (min age: ${MIN_AGE_DAYS}d)..."
  echo ""

  now_epoch=$(date +%s)

  # Step 1: For each dep, collect proposed changes via cargo update --dry-run.
  declare -A dep_changes
  all_proposed=""

  dep_i=0
  for dep in $direct_deps; do
    dep_i=$((dep_i + 1))
    if [[ -t 2 ]]; then
      printf '\r[%d/%d] cargo update --dry-run -p %s ...\033[0K' "$dep_i" "$dep_total" "$dep" >&2
    fi
    dry_output=$(cargo update --dry-run -p "$dep" 2>&1) || true
    changes=$(echo "$dry_output" | awk '
      $1 == "Adding" { ver=$3; sub(/^v/, "", ver); print $2 "\t" ver }
      $1 == "Updating" && $4 == "->" { ver=$5; sub(/^v/, "", ver); print $2 "\t" ver }
    ')
    dep_changes["$dep"]="$changes"
    if [[ -n "$changes" ]]; then
      all_proposed="${all_proposed}${changes}"$'\n'
    fi
  done
  if [[ -t 2 ]]; then
    printf '\r\033[2K' >&2
  fi

  # Step 2: Deduplicate proposed crates.
  unique_proposed=$(echo "$all_proposed" | sort -u -t$'\t' -k1,1 | grep -v '^$' || true)

  if [[ -z "$unique_proposed" ]]; then
    echo "No updates available for any direct dependency."
    exit 0
  fi

  unique_total=$(echo "$unique_proposed" | wc -l | tr -d ' ')
  echo "Age-checking $unique_total unique proposed crate(s)..."
  echo ""

  # Step 3: Age-check each unique proposed crate.
  # Store: name -> "status|age_days"
  declare -A crate_status

  i=0
  while IFS=$'\t' read -r name version; do
    [[ -z "$name" ]] && continue
    i=$((i + 1))
    if [[ -t 2 ]]; then
      printf '\r[%d/%d] %s %s ...\033[0K' "$i" "$unique_total" "$name" "$version" >&2
    fi

    response=$(curl -s -f -S \
      -H "User-Agent: cargo-dep-age (system scripts)" \
      "https://crates.io/api/v1/crates/${name}/versions" 2>/dev/null) || {
      crate_status["$name"]="ERROR|?"
      sleep 1
      continue
    }

    created_at=$(echo "$response" | jq -r --arg v "$version" \
      '.versions[] | select(.num == $v) | .created_at' 2>/dev/null | head -1)

    if [[ -z "$created_at" || "$created_at" == "null" ]]; then
      crate_status["$name"]="MISSING|?"
      sleep 1
      continue
    fi

    is_yanked=$(echo "$response" | jq -r --arg v "$version" \
      '.versions[] | select(.num == $v) | .yanked' 2>/dev/null | head -1)

    pub_epoch=""
    if date --version &>/dev/null 2>&1; then
      pub_epoch=$(date -d "${created_at}" +%s 2>/dev/null) || pub_epoch=""
    else
      clean_date=$(echo "$created_at" | sed 's/\.[0-9].*//; s/T/ /')
      pub_epoch=$(date -j -f "%Y-%m-%d %H:%M:%S" "${clean_date}" +%s 2>/dev/null) || pub_epoch=""
    fi

    if [[ -z "$pub_epoch" ]]; then
      crate_status["$name"]="ERROR|?"
      sleep 1
      continue
    fi

    age_days=$(( (now_epoch - pub_epoch) / 86400 ))

    if [[ "$is_yanked" == "true" ]]; then
      crate_status["$name"]="YANKED|${age_days}d"
    elif [[ $age_days -lt $MIN_AGE_DAYS ]]; then
      crate_status["$name"]="FRESH|${age_days}d"
    else
      crate_status["$name"]="ok|${age_days}d"
    fi

    sleep 1
  done <<< "$unique_proposed"
  if [[ -t 2 ]]; then
    printf '\r\033[2K' >&2
  fi

  # Step 4: Report per-dep.
  printf "%-20s %-10s %-8s %s\n" "DIRECT DEP" "CHANGES" "STATUS" "BLOCKED BY"
  printf '%.0s-' {1..80}; echo ""

  safe_count=0
  blocked_count=0
  none_count=0

  for dep in $direct_deps; do
    changes="${dep_changes[$dep]}"
    if [[ -z "$changes" ]]; then
      printf "%-20s %-10s %-8s\n" "$dep" "-" "-"
      none_count=$((none_count + 1))
      continue
    fi

    blocked_crates=()
    change_count=0
    while IFS=$'\t' read -r name version; do
      [[ -z "$name" ]] && continue
      change_count=$((change_count + 1))
      IFS='|' read -r status age <<< "${crate_status[$name]}"
      if [[ "$status" != "ok" ]]; then
        blocked_crates+=("$name ($age, $status)")
      fi
    done <<< "$changes"

    if [[ ${#blocked_crates[@]} -eq 0 ]]; then
      printf "%-20s %-10s %-8s\n" "$dep" "$change_count" "SAFE"
      safe_count=$((safe_count + 1))
    else
      blocked_str=$(IFS=', '; echo "${blocked_crates[*]}")
      printf "%-20s %-10s %-8s %s\n" "$dep" "$change_count" "BLOCKED" "$blocked_str"
      blocked_count=$((blocked_count + 1))
    fi
  done

  echo ""
  echo "$safe_count safe, $blocked_count blocked, $none_count no updates"

  if [[ $blocked_count -gt 0 ]]; then
    exit 1
  fi
  exit 0
fi

# Extract (name, version) pairs depending on mode.
if [[ "$MODE" == "dryrun" ]]; then
  if ! command -v cargo &>/dev/null; then
    echo "Error: cargo is required for --proposed mode" >&2
    exit 2
  fi
  dry_output=$(cargo update --dry-run "${CARGO_ARGS[@]}" 2>&1) || {
    echo "Error: cargo update --dry-run failed" >&2
    echo "$dry_output" >&2
    exit 1
  }
  # Parse "Adding crate vX.Y.Z" and "Updating crate vOLD -> vX.Y.Z"
  # Skip non-package lines (e.g. "Updating crates.io index").
  # Three tab-separated fields: name, new_version, kind (add/update)
  deps=$(echo "$dry_output" | awk '
    $1 == "Adding" {
      ver = $3
      sub(/^v/, "", ver)
      print $2 "\t" ver "\tadd"
    }
    $1 == "Updating" && $4 == "->" {
      ver = $5
      sub(/^v/, "", ver)
      print $2 "\t" ver "\tupdate"
    }
  ')
  if [[ -z "$deps" ]]; then
    echo "No updates proposed."
    exit 0
  fi
else
  if [[ ! -f "$LOCKFILE" ]]; then
    echo "Error: $LOCKFILE not found" >&2
    exit 2
  fi
  deps=$(awk '
    BEGIN { name=""; version=""; source="" }
    /^\[\[package\]\]/ {
      if (name && version && source == "registry") print name "\t" version
      name=""; version=""; source=""
    }
    /^name = "/ { gsub(/^name = "/, ""); gsub(/"$/, ""); name=$0 }
    /^version = "/ { gsub(/^version = "/, ""); gsub(/"$/, ""); version=$0 }
    /^source = "registry/ { source="registry" }
    END { if (name && version && source == "registry") print name "\t" version }
  ' "$LOCKFILE")
fi

# Deduplicate and count.
deps=$(echo "$deps" | sort -u -t$'\t' -k1,1)
total=$(echo "$deps" | wc -l | tr -d ' ')

if [[ "$MODE" == "dryrun" ]]; then
  echo "Checking $total proposed updates (min age: ${MIN_AGE_DAYS}d)..."
else
  echo "Checking $total registry crates in $LOCKFILE (min age: ${MIN_AGE_DAYS}d)..."
fi

# Collect results
echo ""

# Collect results for sorting.
results=()
fresh=0
yanked_count=0
errors=0
now_epoch=$(date +%s)

check_crate() {
  local name="$1" version="$2" kind="${3:-unknown}"

  local response
  response=$(curl -s -f -S \
    -H "User-Agent: cargo-dep-age (system scripts)" \
    "https://crates.io/api/v1/crates/${name}/versions" 2>/dev/null) || {
    results+=("9999|${name}|${version}|?|ERROR|fetch failed")
    return
  }

  # Find the matching version entry.
  local created_at is_yanked latest_ver
  created_at=$(echo "$response" | jq -r --arg v "$version" \
    '.versions[] | select(.num == $v) | .created_at' 2>/dev/null | head -1)

  if [[ -z "$created_at" || "$created_at" == "null" ]]; then
    results+=("9999|${name}|${version}|?|MISSING|version not found on crates.io")
    return
  fi

  is_yanked=$(echo "$response" | jq -r --arg v "$version" \
    '.versions[] | select(.num == $v) | .yanked' 2>/dev/null | head -1)

  # Latest available version (highest semver, not just newest published).
  latest_ver=$(echo "$response" | jq -r '[.versions[] | select(.yanked == false) | .num] | sort_by(split(".") | map(tonumber)) | last // "unknown"' 2>/dev/null)

  # Newest version that passes the age threshold (for FRESH/YANKED suggestions).
  local last_ok_ver=""
  local cutoff_epoch=$(( now_epoch - MIN_AGE_DAYS * 86400 ))
  last_ok_ver=$(echo "$response" | jq -r --argjson cutoff "$cutoff_epoch" '
    [.versions[] | select(.yanked == false) | .created_at as $ts | .num as $ver |
     select(($ts | split(".")[0] | strptime("%Y-%m-%dT%H:%M:%S") | mktime) <= $cutoff)] |
    if length > 0 then
      sort_by(.num | split(".") | map(tonumber? // 0)) | last | .num
    else
      empty
    end
  ' 2>/dev/null) || last_ok_ver=""

  # Parse ISO 8601 date to epoch.
  local pub_epoch=""
  if date --version &>/dev/null 2>&1; then
    pub_epoch=$(date -d "${created_at}" +%s 2>/dev/null) || pub_epoch=""
  else
    # BSD date: strip fractional seconds and tz, convert T to space
    local clean_date
    clean_date=$(echo "$created_at" | sed 's/\.[0-9].*//; s/T/ /')
    pub_epoch=$(date -j -f "%Y-%m-%d %H:%M:%S" "${clean_date}" +%s 2>/dev/null) || pub_epoch=""
  fi

  if [[ -z "$pub_epoch" ]]; then
    results+=("9999|${name}|${version}|?|ERROR|date parse failed: ${created_at}")
    return
  fi

  local age_days=$(( (now_epoch - pub_epoch) / 86400 ))

  local status="ok"
  local note=""
  if [[ "$is_yanked" == "true" ]]; then
    status="YANKED"
    note="!!! version is yanked"
    if [[ -n "$last_ok_ver" ]]; then
      note="${note}, last ok: ${last_ok_ver}"
    fi
  elif [[ $age_days -lt $MIN_AGE_DAYS ]]; then
    status="FRESH"
    note="published ${age_days}d ago (under ${MIN_AGE_DAYS}d)"
    if [[ -n "$last_ok_ver" ]]; then
      note="${note}, last ok: ${last_ok_ver}"
    fi
  fi

  # Append latest version if different from pinned.
  if [[ -n "$latest_ver" && "$latest_ver" != "$version" ]]; then
    note="${note:+${note}, }latest: ${latest_ver}"
  fi

  # Prepend kind (add/update) to note.
  if [[ "$kind" == "add" ]]; then
    note="new dep${note:+, }${note}"
  elif [[ "$kind" == "update" ]]; then
    note="bump${note:+, }${note}"
  fi

  results+=("$(printf '%05d|%s|%s|%5dd|%s|%s' "$age_days" "$name" "$version" "$age_days" "$status" "$note")")
}

i=0
while IFS=$'\t' read -r name version kind; do
  i=$((i + 1))
  if [[ -t 2 ]]; then
    printf '\r[%d/%d] %s %s ...\033[0K' "$i" "$total" "$name" "$version" >&2
  fi
  check_crate "$name" "$version" "$kind" || true
  sleep 1
done <<< "$deps"
if [[ -t 2 ]]; then
  printf '\r\033[2K' >&2
fi

# Sort freshest first (ascending age, so FRESH/YANKED/errors float to top).
results_sorted=$(printf '%s\n' "${results[@]}" | sort -t'|' -k1,1n)

# Print header.
printf "%-30s %-12s %6s %8s %s\n" "CRATE" "VERSION" "AGE" "STATUS" "NOTE"
printf '%.0s-' {1..80}; echo ""

# Print results.
while IFS='|' read -r _sort name version age status note; do
  printf "%-30s %-12s %6s %8s %s\n" "$name" "$version" "$age" "$status" "$note"
  case "$status" in
    FRESH) fresh=$((fresh + 1)) ;;
    YANKED) yanked_count=$((yanked_count + 1)) ;;
  esac
done <<< "$results_sorted"

echo ""
echo "Summary: $total crates, $fresh fresh (<${MIN_AGE_DAYS}d), $yanked_count yanked, $errors errors"

if [[ $fresh -gt 0 || $yanked_count -gt 0 ]]; then
  exit 1
fi
