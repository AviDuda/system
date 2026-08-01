# Git → jj command map

| intent | git | jj |
|---|---|---|
| status | `git status` | `jj status` |
| commit everything | `git commit -am` | `jj describe -m` then `jj new` |
| selective commit (files) | `git add <paths> && git commit` | `jj commit <paths> -m` |
| selective commit (hunks) | `git add -p && git commit` | `jj commit -i` |
| amend | `git commit --amend` | edits just stay in the change; `jj describe` to reword |
| stage into previous commit | `git add -p` against HEAD | `jj squash --into @-` |
| new branch | `git checkout -b foo` | `jj bookmark create foo -r @-` |
| switch to branch/commit | `git checkout foo` | `jj edit <rev>` / `jj prev` / `jj next` |
| stash | `git stash` | describe the change and `jj new` to move on (nothing to stash — the change is preserved) |
| undo last action | `git reset --hard` (destructive) | `jj undo` |
| discard file changes | `git checkout -- <f>` | `jj restore <f>` |
| history rewrite | `git rebase -i` | `jj rebase` / `jj squash` / `jj split` / `jj absorb` |
| fix belongs in an earlier commit | `git commit --fixup && git rebase -i --autosquash` | `jj absorb` |
| cherry-pick | `git cherry-pick <rev>` | `jj duplicate <rev> --destination <target>` |
| log | `git log --oneline --graph` | `jj log` |
| show a commit | `git show <rev>` | `jj show -r <rev>` |
| diff | `git diff` | `jj diff` |
| push | `git push` | `jj git push --bookmark <name>` |
| pull | `git pull --rebase` | `jj git fetch` → `jj bookmark move <trunk> --to <trunk>@origin` → `jj rebase -d <trunk>` |
| squash before push | `git rebase -i` + squash | `jj squash` (fold into `@-`) |
| split a commit | `git reset HEAD^` + `git add -p` | `jj split<paths>` / `jj split -i` |
| revert a change | `git revert <rev>` | `jj revert <rev>` |
| undoing a pushed mistake | `git revert` / force-push | `jj revert <rev>`, or `jj undo`/`jj op restore` before the rewrite is pushed (no force-push dance) |
| clean worktree | `git clean -fd` | doesn't exist — jj snapshots everything; keep trash out via `.git/info/exclude` |
| merge | `git merge` | `jj merge` (or the change graph just merges; conflicts are first-class) |

## Key model differences

- **Working copy is a change** (`@`); `@-` is its parent. The change ID is stable; the underlying git commit can change as you rewrite.
- **No staging area** — the working-copy change holds everything; select with `jj commit <paths>` / `jj split` / `jj squash`.
- **Branches are bookmarks** — optional labels. jj works without them; push/fetch uses them.
- **Everything is reversible** — the operation log (`jj op log`) records every command; `jj undo` / `jj op restore` recover any state.
- **Colocated repos**: git sees your current jj change as detached HEAD and untracked-looking state; that's normal — trust `jj status`. Resync jj ↔ git refs with `jj git import` if they ever drift.
