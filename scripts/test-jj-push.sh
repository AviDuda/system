#!/usr/bin/env bash
# Test jj-push: with a LOCAL commit above public work, push must advance the
# trunk bookmark to the PUBLIC head (not the LOCAL head), sign+stamp the pushed
# commit so its committer equals its author, and leave the LOCAL commit
# unpushed. Runs in a throwaway /tmp repo with a bare remote.
#
# Override the command under test with PUSH="..." (defaults to `jj push`,
# the installed alias).
set -euo pipefail

PUSH=${PUSH:-jj push}

R=""; REMOTE=""
trap 'if [ -n "${R:-}" ]; then rm -rf -- "$R"; fi; if [ -n "${REMOTE:-}" ]; then rm -rf -- "$REMOTE"; fi' EXIT
R=$(mktemp -d /tmp/jj-push-test.XXXXXX) || { echo "mktemp failed"; exit 1; }
REMOTE=$(mktemp -d /tmp/jj-push-remote.XXXXXX) || { echo "mktemp failed"; exit 1; }

git init -q --bare "$REMOTE"
cd "$R"
jj git init >/dev/null
jj git remote add origin "$REMOTE"
jj config set --repo git.private-commits 'description("LOCAL:*") | description("wip:*") | description("private:*")'

# trunk on origin (immutable); keep a mutable WC commit above it
jj describe -r @ -m root
printf 't' > t.txt
jj new -m trunk
jj file track t.txt
jj new
jj bookmark create master -r @-
jj git push --bookmark master >/dev/null

# public P (the mutable WC) then a LOCAL commit on top
printf 'p' > p.txt
jj file track p.txt
jj describe -m "public P"
printf 'l' > l.txt
jj new -m "LOCAL: L"
jj file track l.txt

$PUSH 2>/dev/null

[ "$(jj log -r 'master' -T 'description.first_line()' --no-graph)" = "public P" ] \
  || { echo "FAIL: master not at public head"; exit 1; }
[ "$(jj log -r 'master..@' -T 'description.first_line()' --no-graph)" = "LOCAL: L" ] \
  || { echo "FAIL: LOCAL commit not preserved unpushed"; exit 1; }
[ "$(jj log -r 'master@origin' -T 'description.first_line()' --no-graph)" = "public P" ] \
  || { echo "FAIL: origin head not public P"; exit 1; }
[ "$(jj log -r 'master' -T 'if(signature, "Y", "N")' --no-graph | tr -d ' ')" = "Y" ] \
  || { echo "FAIL: pushed commit not signed"; exit 1; }
[ "$(jj log -r 'master' -T 'author.timestamp().format("%H:%M:%S") == committer.timestamp().format("%H:%M:%S")' --no-graph | tr -d ' ')" = "true" ] \
  || { echo "FAIL: committer != author time"; exit 1; }

echo "PASS: master at public head, LOCAL unpushed, origin=P, signed, committer==author"
