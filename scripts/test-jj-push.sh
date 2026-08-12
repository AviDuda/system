#!/usr/bin/env bash
# Test jj-push: with a LOCAL commit above public work, push must advance the
# trunk bookmark to the PUBLIC head (not the LOCAL head), sign the pushed
# commit, and leave the LOCAL commit unpushed. The exported git commit (the
# layer GitHub renders) must be signed. Runs in a throwaway /tmp repo with a
# bare remote.
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
# The exported GIT commit (the layer GitHub renders) must carry a signature.
# (Dates are git-normal: sign-on-push sets the committer to the push instant.
# The jj-model signature check would be a weaker substitute.)
git -C "$REMOTE" cat-file commit "refs/heads/master" | grep -q "^gpgsig" \
  || { echo "FAIL: exported git commit not signed"; exit 1; }

echo "PASS: master at public head, LOCAL unpushed, origin=P, git-signed"
