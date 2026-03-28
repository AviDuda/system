# at-mentions

Inlines file and directory contents when you `@`-mention them in a prompt.

- `@file.ts` -- reads the file and injects its contents as context
- `@dir/` -- injects a directory listing

Each mention is resolved once per session (deduplicated). Notifications confirm what was loaded.

Uses `shared/at-mentions.ts` for path parsing (shared with agents-loader).
