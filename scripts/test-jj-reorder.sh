#!/usr/bin/env bash
# Validate `jj reorder` across stack topologies.
#
# Each scenario builds a throwaway jj repo (fresh temp dir, bare origin so
# trunk() resolves) with commits named after the given descriptions, pins master
# to the first, runs `jj reorder`, then asserts:
#   - every public commit is in ::master
#   - no LOCAL/wip/private commit leaks into ::master
#   - the local commits still exist on the stack (::@)
#
# Exits non-zero if any scenario fails. Override the command under test with
# REORDER="..." (defaults to `jj reorder`, the installed alias).
set -u
REORDER="${REORDER:-jj reorder}"
FAIL=0
TMP_ROOT=$(mktemp -d /tmp/jj-reorder-test.XXXXXX) || { echo "mktemp failed"; exit 1; }
trap 'if [ -n "${TMP_ROOT:-}" ]; then rm -rf -- "$TMP_ROOT"; fi' EXIT

# run_scenario <name> <comma-list-of-public-desc> <desc> [<desc> ...]
# <desc> list: first must be "base", the rest the stack above it (all become commits).
run_scenario() {
  local name="$1" expect_public="$2"; shift 2
  local dir org
  dir="$TMP_ROOT/$name"; org="$TMP_ROOT/$name-origin.git"
  mkdir -p "$dir"
  git init -q --bare "$org"
  (
    cd "$dir" || exit 1
    git init -q -b master
    git commit -q --allow-empty -m seed
    jj git init >/dev/null 2>&1
    jj git remote add origin "$org" >/dev/null 2>&1
    local i=0 base=""
    for desc in "$@"; do
      i=$((i+1)); printf 'x' > "f$i.txt"
      jj commit -m "$desc" >/dev/null 2>&1
      if [ "$i" -eq 1 ]; then
        base=$(jj log -r '@-' --no-graph -T change_id | tr -d ' ')
      fi
    done
    jj bookmark set master -r "$base" >/dev/null 2>&1
    jj git push --bookmark master >/dev/null 2>&1
    IFS=',' read -r -a pub <<<"$expect_public"
    $REORDER >/dev/null 2>&1
    # every expected public must be in ::master
    for d in "${pub[@]}"; do
      if ! jj log -r '::master' --no-graph --no-pager -T 'description.first_line() ++ "\n"' 2>/dev/null | grep -q "^$d$"; then
        echo "FAIL[$name]: public '$d' missing from ::master"; return 1
      fi
    done
    # locals must not leak into ::master, but must survive on the stack
    for d in "$@"; do
      case "$d" in
        LOCAL:*|wip:*|private:*)
          if jj log -r '::master' --no-graph --no-pager -T 'description.first_line() ++ "\n"' 2>/dev/null | grep -q "^$d$"; then
            echo "FAIL[$name]: local '$d' leaked into ::master"; return 1
          fi
          if ! jj log -r '::@' --no-graph --no-pager -T 'description.first_line() ++ "\n"' 2>/dev/null | grep -q "^$d$"; then
            echo "FAIL[$name]: local '$d' absent from stack"; return 1
          fi
          ;;
      esac
    done
    echo "ok[$name]"
    return 0
  ) || return $?
}

# scenario name, public list, stack (first = base)
run_scenario sc-bug "public one,public two" \
  "base" "LOCAL: local change" "public one" "public two" || FAIL=1
run_scenario sc-good "public a,public b" \
  "base" "public a" "public b" "LOCAL: l1" "LOCAL: l2" || FAIL=1
run_scenario sc-public-only "public a,public b" \
  "base" "public a" "public b" || FAIL=1
run_scenario sc-single "public single" \
  "base" "LOCAL: only" "public single" || FAIL=1

if [ "$FAIL" -ne 0 ]; then
  echo "jj-reorder: FAILURES"; exit 1
fi
echo "jj-reorder: all scenarios passed"
