---
name: jj
description: Use jj (Jujutsu) for version control in repositories with a `.jj/` directory — status and inspection, creating and describing changes, selective commits, splitting/squashing, bookmarks, push/fetch, conflicts, and recovery. jj is the local change layer while git stays the canonical remote/PR/CI interface in colocated repos. Use when running version-control operations inside a jj repo instead of raw git.
---

# Jujutsu (jj) Workflow

## Detect and gate

- `.jj/` present → operate with jj; `jj root` confirms.
- `.jj/` + `.git/` (colocated) → mutate with jj, keep git read-only. Never git add/stage/commit: jj ignores the git index and mixing the two desyncs.
- Only `.git/` → plain git repo: convert with `jj git init` (colocated; git untouched, `.jj/` gitignored, revert with `rm -rf .jj`) and proceed with jj — the global instructions make jj the default.

## Agent safety (non-negotiable)

- Always pass `-m "<msg>"` to `describe`/`commit`/`squash`/`new`. Never run bare interactive forms (`jj describe`, `jj commit`, `jj squash`, `jj split`, `jj resolve`, `jj diffedit`) — they open an editor or TUI and hang non-interactive agents.
- Use `--no-pager` on output commands (user config sets `ui.paginate = never`, but belt-and-braces).
- jj snapshots the working copy when a jj command runs, not on every file write. To capture file state, run any jj command.
- After history mutations (squash/rebase/abandon/split/restore), run `jj status` to verify state.

## Inspect first

- `jj status` — current change and working-copy state
- `jj log -n 10` — the change graph (bare `jj` = log); `-p` shows patches, `--no-graph` for flat, parsable output
- `jj show` — diff of the current change
- `jj diff` / `jj diff -r <rev>`
- `jj file search <pattern>` and `jj file annotate <path>` — content search and blame across revisions
- `jj interdiff <from-change> <to-change>` — show what changed *between* two versions of a change (e.g. before/after review feedback)

## Daily loop (squash workflow)

1. `jj new` — new change on top of the current one
2. `jj describe -m "<message>"` — name the change (message is a plan, written before the code)
3. Edit files (auto-snapshotted on the next jj command)
4. `jj new` again — one change per logical unit; keep unrelated work out of the current change
5. Navigate without revision IDs: `jj prev` / `jj next` (with `-e` edits the target in place; without it creates a new working-copy change on top), `jj edit <rev>`

## Commit selectively (replaces git add -p)

jj has no staging area — the working-copy change holds every change. Select what gets committed:

- `jj commit <paths>... -m "<msg>"` — selected paths stay in the commit, the rest move to a new working-copy change on top (non-interactive, agent-safe)
- `jj commit -i` — interactive hunk selection (human use; the default diff editor is rougher than `git add -p`)
- `jj squash --into @-` — fold the working copy into its parent ("stage into the previous change" pattern)
- `jj split <paths>... -m "<msg>"` — carve paths out of a change without interactive UI
- `jj absorb` — move hunks into the nearest mutable ancestor that introduced those lines; leaves unrelated changes alone

## History editing (reversible)

**Restructure and combine**
- `jj squash` — fold changes into another change (`--into @-` folds the working copy into its parent; `-i` interactive)
- `jj split <paths>... -m` — carve a change apart (`-i` interactive hunks, `-p` splits into siblings)
- `jj absorb` — move hunks into the nearest mutable ancestor that introduced those lines
- `jj rebase -r <rev> -d <dest>` — re-parent changes (`--skip-emptied` drops changes the rebase emptied; `-A`/`-B` insert after/before)
- `jj duplicate <rev> --destination <target>` — cherry-pick style
- `jj parallelize` — turn a stack into sibling changes

**Remove, discard, or reverse content**
- `jj restore <paths>` — discard working-copy changes for paths (`--changes-in <rev>` brings only another change's changes into the working copy)
- `jj abandon <rev>` — remove a change (`--restore-descendants` reparents child changes instead of abandoning them too; `--retain-bookmarks` keeps bookmarks)
- `jj revert <rev>` — apply the inverse of a revision (the git-revert equivalent)
- `jj simplify-parents` — drop redundant merge parents left after rebases

**Operate across revisions**
- `jj evolog` — how a change has evolved over time (debug after mutations)
- `jj run -- <cmd>` — run a command in an isolated working copy of each revision in your stack (default `reachable(@, mutable())`) and amend file changes back into the revisions; `-j N` parallelizes, `--root` runs from each revision's root, `--clean` forces fresh checkouts (default reuses per-revision copies, so build caches persist). Per-revision failures are reported with the commit ID. Isolated copies contain only committed content: ignored files with local content (`.env`) and uncommitted local mods are absent — pass secrets via the invoking env or a wrapper that writes them, or run env-dependent tests in the real working copy. Fit: formatters/fixers/auto-fixes (`jj run -j 4 -- cargo fmt`); usable for per-change test runs, but any file changes the command makes are amended into the revisions. `jj fix` is the conflict-safe, deduped alternative when `fix.tools` are configured (review with `jj op show -p`).
- `jj bisect run -- <cmd>` — bisect the stack to find the first change that breaks a command (exit 0 = good, nonzero = bad; plain `jj bisect` for manual good/bad navigation).

## Keep machine-local changes out of pushes

The user config refuses to push changes whose descriptions start `LOCAL:` / `wip:` / `private:` (`git.private-commits`).

- Make the local change a **sibling**, not an ancestor: from the base bookmark, `jj new <bookmark>` → `jj describe -m "LOCAL: <what>"` → `jj new <bookmark>` again for real work. Pushing the work change pushes only its chain; the local change is not in it.
- To commit the local change later: `jj rebase -r <local-change> -d <bookmark>` (or onto the work change), drop the marker, push.
- Untracked new files: jj auto-tracks new files by default. Keep files out of snapshots via `.git/info/exclude` (per-repo, uncommitted) or `.gitignore`; opt back in with `jj file track <path>` (`--include-ignored` force-tracks an ignored file). `jj file untrack` only works on files that are already ignored.

## Push, pull, and sync (git stays canonical)

**Pull / sync from upstream**
- The user config defines `jj sync` (fetch + rebase your work onto the repo's `trunk()`) and `jj push` (publish the stack via `jj git push --change @-`); use those for the daily loop, the raw commands below are what they do.
- `jj git fetch` — import remote changes (updates `<trunk>@origin`; does NOT move your local `<trunk>` bookmark)
- Catch the bookmark up to the remote: `jj bookmark move <trunk> --to <trunk>@origin` (fast-forward; use `jj bookmark set <trunk> -r <trunk>@origin` to force when the remote rewrote history)
- Rebase your work onto the new position: `jj rebase -d <trunk>` (current change) or `jj rebase -s 'all:roots(trunk()..mutable())' -d <trunk>` for a whole stack; add `--skip-emptied` to drop changes the rebase emptied
- Resolve any conflicts (see Conflicts), then `jj status` until clean

**Fresh repos**
- `jj git remote add origin <url>` to attach a remote to a converted repo (also `jj git remote list/remove/rename/set-url`)

**Push**
- One-commit-per-PR convention: `jj squash --into <base-change>` or fold the stack before pushing
- PR flow: `jj bookmark create <name> -r @-`, then `jj git push --bookmark <name>` (new bookmarks push by default in 0.43). Bookmarkless: `jj git push --change <rev>`
- Direct-to-trunk: `jj bookmark move <trunk> --to @-`, then `jj git push --bookmark <trunk>`
- Never push to protected/default branches; never rewrite public history. Open PRs from the pushed bookmark with `gh`/`glab`.
- History rewriting is safe by default: jj only moves a bookmark after safety checks (the `git push --force-with-lease` analog), so silent force-push accidents don't happen.
- Immutable by default: trunk, tags, and *untracked* remote bookmarks. A locally tracked remote (e.g. `main` after `jj bookmark track main`) is NOT auto-protected. To protect all pushed commits: `revset-aliases.'immutable_heads()' = 'builtin_immutable_heads() | remote_bookmarks()'` (changes nothing else; note it reshapes the default `jj log` view).
- Pushes trigger a 1Password SSH-signing approval (sign-on-push). One approval per push is expected, not an error; a denied approval fails the push visibly — retry after the user approves.

## Conflicts

- `jj status` lists conflicted files (`jj resolve --list` enumerates them); conflict content contains both sides marked with descriptions.
- Agent context: edit conflicted files directly, remove markers, then verify with `jj status` until clean. Interactive `jj resolve` hangs agents.
- Conflicts are first-class data: rebases and merges never abort.

## Recovery

- `jj undo` — revert the last operation (repeated undo goes further back; `jj redo` moves forward again)
- `jj op log` → `jj op restore <op-id>` — recover an earlier repository state (distinct from `jj restore`, which is path-level)
- `jj --at-op=<op-id> log` — read-only peek at repo state at an earlier operation, without changing anything
- Nothing is lost: abandon/restore/rebase are all reversible via the operation log.

## Workspaces (parallel work, worktree-style)

- `jj workspace add <dir>` — a second working copy sharing the change graph (like a git worktree, but not tied to a branch or bookmark). Use one workspace per concurrent agent — never share a working copy. `jj workspace list`, `jj workspace forget <name>`.

## Version drift

- `jj --version`; the CLI moves fast. When a flag misbehaves, run `jj <cmd> --help`. This skill is written against jj 0.43.
- See `git-map.md` in this skill's references for the command-by-command git equivalence table.
