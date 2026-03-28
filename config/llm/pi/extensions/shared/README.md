# shared

Shared modules used by multiple extensions. Not an extension itself (no `index.ts`, so pi doesn't try to load it).

Extensions import from here via `../shared/module-name`. Pi symlinks this directory alongside extension directories, and Node resolves symlinks to real paths before resolving relative imports.
