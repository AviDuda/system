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
- Never pipe jj output through `head`/`tail`/`grep` — SIGPIPE kills the process mid-operation (Rust `SIG_IGN` issue) and can abort the op after partial output. Dump full output.
- jj snapshots the working copy when a jj command runs, not on every file write. To capture file state, run any jj command.
- After history mutations (squash/rebase/abandon/split/restore), run `jj status` to verify state.

## Inspect first

- `jj status` — current change and working-copy state
- `jj log -n 10` — the change graph (bare `jj` = log); `-p` shows patches, `--no-graph` for flat, parsable output
- **`jj log` default: working copy + 30 newest commits in its ancestry** (`revsets.log = "@ | latest(::@, 30)"` in jj.nix) — full history incl. teammates' pushed work, no elision, no unrelated branches; works on any branch (`::@` is HEAD's ancestry, like `git log`).
- **`-n` only shrinks, never grows** — it can't exceed the 30-commit revset. More: `jj log -r '::@' -n 100`, or `-r '::@'` for the whole ancestry.
- `jj show` — diff of the current change
- `jj diff` / `jj diff -r <rev>`
- `jj file search <pattern>` and `jj file annotate <path>` — content search and blame across revisions
- `jj interdiff <from-change> <to-change>` — show what changed *between* two versions of a change (e.g. before/after review feedback)
- **`jj log -T <template>`: joined fields need explicit separators.** `-T 'change_id'` (single field) works, but concatenating fields is a parse error unless joined with `++`: `-T 'commit_id.short(6) ++ " " ++ author.name() ++ " " ++ description.first_line()'`. Missing the `++ " "` between fields → "Failed to parse template: Syntax error" with a caret at the gap.
- **`author` (and `committer`) is a `Signature`, not a string.** `author.name()`, `author.email()`, `author.timestamp().ago()` work; `author.short()`/`author.shortest()` do not ("Method `short` doesn't exist for type `Signature`"). For a short author label use `author.name()`.
- **`jj show` is not `jj log`.** It takes a revset positional; it has no `--no-graph` (log-only) and no `-p`/`--patch` flag ("unexpected argument '-p'"). Use `jj show -s`/`--stat`/`-T` instead of patch flags.
- **Revset functions need `()` in `-r`/revsets too, and must be quoted against the shell** (`-r 'trunk()'` for a function; `-r @` works bare, but `jj show trunk()` unquoted is a shell error, and bare `trunk` without parens is a literal-revision lookup that fails "Revision `trunk` doesn't exist").

## Daily loop (squash workflow)

**Start of work — check the working copy first** (`jj status`; `jj log -n 3` if unclear). What's in `@`?

**Repo has other developers? Run `jj sync` before anything** (fetch + rebase existing work onto the fresh trunk). Starting from a stale base wastes a cycle.

- Empty + undescribed (`no changes ... (empty) (no description set)`) → an auto-created placeholder; claim it: `jj describe -m "<plan>"` and work in it directly (skip the `jj new` below).
- Has edits → someone's in-flight work. `jj new` on top, keep your change separate, and never squash into / commit paths out of / abandon the pre-existing change. Say the split when reporting back.
- Described (even if empty) → a claimed change; if its description is the task, work in it directly.

Describing a change early also protects it: jj auto-abandons empty + undescribed changes when the working copy moves away.

1. `jj new` — new change on top of the current one (skip if you claimed an empty placeholder above)
2. `jj describe -m "<message>"` — name the change (message is a plan, written before the code). Multi-line messages: repeat `-m` for subject + body (git-style blank line between), or embed literal newlines.
3. Record its change ID: `CHANGE_ID=$(jj log -r @ --no-graph -T 'change_id')` — stable across amend/rebase/squash/split while commit IDs and `@` move. Reference it (never `@`-assumptions) to find the change later: `jj show $CHANGE_ID`, `jj edit $CHANGE_ID`.
4. Edit files (auto-snapshotted on the next jj command)
5. `jj new` again — one change per logical unit; keep unrelated work out of the current change
6. Navigate without revision IDs: `jj prev` / `jj next` (with `-e` edits the target in place; without it creates a new working-copy change on top), `jj edit <rev>`
7. Quick moves: `jj new @-` — clean slate on the parent of the current change, your current edits stay behind as a visible change (no stash, no branch naming); `jj new -B <rev>` — insert a new change before `<rev>` (work below the current change)

## Commit selectively (replaces git add -p)

jj has no staging area — the working-copy change holds every change. Select what gets committed:

- `jj commit <paths>... -m "<msg>"` — selected paths stay in the commit, the rest move to a new working-copy change on top (non-interactive, agent-safe)
- `jj commit -i` — interactive hunk selection (human use; the default diff editor is rougher than `git add -p`)
- `jj squash --into @-` — fold the working copy into its parent ("stage into the previous change" pattern)
- `jj split <paths>... -m "<msg>"` — carve paths out of a change without interactive UI
- `jj absorb` — move hunks into the nearest mutable ancestor that introduced those lines; leaves unrelated changes alone

## Signing

- `jj sign -r <rev>` signs a commit (SSH key; one approval per sign).
- After `jj commit`, the working copy is a fresh empty change on top — the commit you just made is `@-`, not `@`. Sign it with `jj sign -r @-`.
- Signing rewrites the commit and rebases descendants; sign immediately after commit while `@-` still points at it.

## History editing (reversible)

**Restructure and combine**
- `jj squash` — fold changes into another change (`--into @-` folds the working copy into its parent; `-i` interactive). `jj squash --from <range> --into <dest> -m "<msg>"` folds a whole range at once; `-u` keeps the destination's description instead of prompting for a combined one — verify with `jj log` between chained range-squashes; running two back-to-back can create divergent duplicates
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
- New files >1MiB are refused at snapshot time (`snapshot.max-new-file-size`, default 1MiB) with a warning + hint listing the fixes. To track one deliberately: `jj file track --include-ignored <path>`. To raise the limit: `jj config set --repo snapshot.max-new-file-size <bytes>` (per-repo) or `jj --config snapshot.max-new-file-size=<bytes>` for one command.

## Push, fetch, and sync (git stays canonical)

**Fetch / sync from upstream**
- The user config defines `jj sync` (fetch + rebase your work onto the repo's `trunk()`) and `jj push` (advance the nearest ancestor bookmark to the stack and push it — the trunk bookmark in direct-to-trunk repos, a feature bookmark in PR-based repos; create the feature bookmark before pushing there). Use those for the daily loop; the raw commands below are what they do.
- `jj fetch` (alias = `jj git fetch`) — download remote changes *only*; touches none of your stack. The daily loop is `jj sync`, not this — `sync` is fetch + rebase. Reach for `jj fetch` when you want refs updated without touching the working stack (rare).
- `jj git fetch` — import remote changes. Fast-forwards your local `<trunk>` bookmark when it's behind but an ancestor of the remote position (the common case); a divergent local bookmark (local commits on it) is left in place and marked `(conflicted)`.
- Resolve a divergent bookmark: `jj bookmark set <trunk> -r <trunk>@origin` to discard local bookmark movement, or resolve the conflict to keep local commits.
- Rebase your work onto the new position: `jj rebase -d <trunk>` (current change) or `jj rebase -s 'all:roots(trunk()..mutable())' -d <trunk>` for a whole stack; add `--skip-emptied` to drop changes the rebase emptied
- Resolve any conflicts (see Conflicts), then `jj status` until clean

**Fresh repos**
- `jj git remote add origin <url>` to attach a remote to a converted repo (also `jj git remote list/remove/rename/set-url`)

**Push**
- Use the flow the repo uses — branch + PR, or direct-to-trunk — detected from AGENTS.md / existing branches; don't assume either.
- Branch + PR: `jj bookmark create <name> -r @-`, then `jj git push --bookmark <name>` (new bookmarks push by default in 0.43); squash the stack into one commit first if that's the repo's convention. Never push to protected/default branches. Opening the PR is the user's call, not the agent's.
- Direct-to-trunk (repos that push straight to their mainline): `jj bookmark move <trunk> --to @-`, then `jj git push --bookmark <trunk>` — or the `jj sync` / `jj push` aliases.
- Never rewrite public history.
- History rewriting is safe by default: jj only moves a bookmark after safety checks (the `git push --force-with-lease` analog), so silent force-push accidents don't happen.
- Immutable by default: trunk, tags, and *untracked* remote bookmarks. A locally tracked remote (e.g. `main` after `jj bookmark track main`) is NOT auto-protected. To protect all pushed commits: `revset-aliases.'immutable_heads()' = 'builtin_immutable_heads() | remote_bookmarks()'` (changes nothing else; note it reshapes the default `jj log` view).

## Conflicts

- `jj status` lists conflicted files (`jj resolve --list` enumerates them); conflict content contains both sides marked with descriptions.
- Agent context: edit conflicted files directly, remove markers, then verify with `jj status` until clean. Interactive `jj resolve` hangs agents.
- "N-sided conflict including 1 deletion" can be a **rename**, not a deletion — the other side renamed the file (the deleting commit's diff stat shows `Modified (old => new)`). Before resolving "keep the deletion", check whether the file lives on under a new name with the same identity/purpose; if so, keep the deletion AND re-apply the change to the new path. Re-adding the deleted path silently drops the change's intent.
- Resolving the bottom conflicted commit clears inherited conflicts up the stack: `jj new <bottom>` (jj's own hint), edit the conflicted files (`jj status` flips to "Conflict in parent commit has been resolved in working copy"), then `jj squash --into <commit> -m "<msg>"` — jj auto-rebases descendants and reports "Existing conflicts were resolved or abandoned". `jj edit <top>` to put the working copy back.
- Conflicts are first-class data: rebases and merges never abort.

## Recovery

- `jj undo` — revert the last operation (repeated undo goes further back; `jj redo` moves forward again)
- `jj op log` → `jj op restore <op-id>` — recover an earlier repository state (distinct from `jj restore`, which is path-level). Divergent commits (same change id at two spots, shown with `(divergent)`) are recoverable the same way — restore the operation that created them
- `jj --at-op=<op-id> log` — read-only peek at repo state at an earlier operation, without changing anything
- Nothing is lost: abandon/restore/rebase are all reversible via the operation log.
- Accidental edits in a change you `jj edit`ed: `jj evolog <rev>` finds the pre-edit state (jj snapshotted it), `jj restore --from <old-commit-id>` reverts.
- Accidentally committed onto a pushed bookmark `<bm>`: `jj rebase --branch <bm> --destination <bm>@origin` splits your new edits off the pushed state, `jj new` gives a fresh working copy, `jj abandon <bm> --restore-descendants --retain-bookmarks` drops the accidental commit while keeping your edits — the bookmark returns to the remote position.

## Workspaces (parallel work, worktree-style)

- `jj workspace add <dir>` — a second working copy sharing the change graph (like a git worktree, but not tied to a branch or bookmark). Use one workspace per concurrent agent — never share a working copy. `jj workspace list`, `jj workspace forget <name>`.

## Version drift

- `jj --version`; the CLI moves fast. When a flag misbehaves, run `jj <cmd> --help`. This skill is written against jj 0.43.
- **Config keys: don't guess, dump the schema.** `jj util config-schema` prints the authoritative JSON schema of every config key (e.g. `revsets.log`, `ui.log-word-wrap`, `git.sign-on-push`). Use it to check whether a key exists before setting it — `log.revset` and `log.limit` are dead keys people reach for, and the schema is the only quick way to confirm a key's real name/scope. `jj config get <key>` only proves the value is stored, not that it's read.
- See `git-map.md` in this skill's references for the command-by-command git equivalence table.
