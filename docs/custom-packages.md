# Custom Packages

For software not in nixpkgs or Homebrew, create custom package derivations in `packages/`.

## When to create custom packages

- App not in nixpkgs or Homebrew
- Need a specific version not available upstream
- Private/internal software

## Package structure

```
packages/
├── applaymidi.nix      # macOS app from GitHub releases
├── some-cli.nix        # CLI tool from direct URL
└── internal-tool.nix   # Private software
```

## Creating a package

### 1. Get the source hash

```bash
# From URL (zip, tar.gz, dmg, etc.)
nix-prefetch-url --type sha256 https://example.com/app-1.0.zip

# From GitHub release
nix-prefetch-url --type sha256 https://github.com/owner/repo/releases/download/v1.0/app.zip

# From GitHub tarball (source code)
nix-prefetch-url --unpack --type sha256 https://github.com/owner/repo/archive/refs/tags/v1.0.tar.gz
```

### 2. Create the derivation

#### macOS .app from zip (GitHub releases)

```nix
# packages/myapp.nix
{ lib, stdenvNoCC, fetchurl, unzip }:

stdenvNoCC.mkDerivation rec {
  pname = "myapp";
  version = "1.0";

  src = fetchurl {
    url = "https://github.com/owner/repo/releases/download/v${version}/MyApp.app.zip";
    sha256 = "0abc123...";  # from nix-prefetch-url
  };

  nativeBuildInputs = [ unzip ];
  sourceRoot = ".";

  installPhase = ''
    runHook preInstall
    mkdir -p $out/Applications
    cp -r MyApp.app $out/Applications/
    runHook postInstall
  '';

  meta = with lib; {
    description = "My application";
    homepage = "https://github.com/owner/repo";
    license = licenses.mit;
    platforms = platforms.darwin;
  };
}
```

#### macOS .app from DMG

```nix
# packages/myapp.nix
{ lib, stdenvNoCC, fetchurl, undmg }:

stdenvNoCC.mkDerivation rec {
  pname = "myapp";
  version = "1.0";

  src = fetchurl {
    url = "https://example.com/MyApp-${version}.dmg";
    sha256 = "0abc123...";
  };

  nativeBuildInputs = [ undmg ];
  sourceRoot = ".";

  installPhase = ''
    runHook preInstall
    mkdir -p $out/Applications
    cp -r MyApp.app $out/Applications/
    runHook postInstall
  '';

  meta = with lib; {
    description = "My application";
    homepage = "https://example.com";
    platforms = platforms.darwin;
  };
}
```

#### CLI tool (prebuilt binary)

```nix
# packages/mycli.nix
{ lib, stdenvNoCC, fetchurl, autoPatchelfHook }:

stdenvNoCC.mkDerivation rec {
  pname = "mycli";
  version = "1.0";

  src = fetchurl {
    url = "https://example.com/mycli-${version}-${
      if stdenvNoCC.isDarwin then "darwin-arm64" else "linux-amd64"
    }.tar.gz";
    sha256 = if stdenvNoCC.isDarwin
      then "0darwin-hash..."
      else "0linux-hash...";
  };

  # For Linux binaries that need library patching
  nativeBuildInputs = lib.optionals stdenvNoCC.isLinux [ autoPatchelfHook ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    cp mycli $out/bin/
    chmod +x $out/bin/mycli
    runHook postInstall
  '';

  meta = with lib; {
    description = "My CLI tool";
    homepage = "https://example.com";
    platforms = platforms.unix;
  };
}
```

#### From source (with build step)

```nix
# packages/mytool.nix
{ lib, stdenv, fetchFromGitHub, cmake, pkg-config }:

stdenv.mkDerivation rec {
  pname = "mytool";
  version = "1.0";

  src = fetchFromGitHub {
    owner = "owner";
    repo = "repo";
    rev = "v${version}";
    sha256 = "0abc123...";  # use nix-prefetch-url --unpack
  };

  nativeBuildInputs = [ cmake pkg-config ];

  meta = with lib; {
    description = "My tool built from source";
    homepage = "https://github.com/owner/repo";
    license = licenses.mit;
    platforms = platforms.unix;
  };
}
```

### 3. Add to home-manager

In `modules/home-manager/default.nix`:

```nix
let
  isDarwin = pkgs.stdenvNoCC.isDarwin;

  # Custom packages (conditional on platform if needed)
  myapp = if isDarwin then pkgs.callPackage ../../packages/myapp.nix { } else null;
  mycli = pkgs.callPackage ../../packages/mycli.nix { };
in
{
  # CLI tools go in home.packages
  home.packages = [
    mycli
  ];

  # macOS apps get symlinked to ~/Applications
  home.file = {
    # ...existing entries...
  } // lib.optionalAttrs isDarwin {
    "Applications/MyApp.app".source = "${myapp}/Applications/MyApp.app";
  };
}
```

## Source types reference

| Source | Fetcher | Hash command |
|--------|---------|--------------|
| Direct URL (zip/tar/dmg) | `fetchurl` | `nix-prefetch-url --type sha256 URL` |
| GitHub release asset | `fetchurl` | `nix-prefetch-url --type sha256 URL` |
| GitHub source tarball | `fetchFromGitHub` | `nix-prefetch-url --unpack --type sha256 URL` |
| Git repo (specific rev) | `fetchgit` | `nix-prefetch-git URL --rev REV` |

## Upgrading custom packages

### Check for updates

```bash
# GitHub releases - get latest version
curl -s https://api.github.com/repos/owner/repo/releases/latest | jq -r '.tag_name'

# List recent releases
curl -s https://api.github.com/repos/owner/repo/releases | jq -r '.[].tag_name' | head -5
```

### Update process

1. Find the new version and download URL
2. Get the new hash:
   ```bash
   nix-prefetch-url --type sha256 NEW_URL
   ```
3. Update `version` and `sha256` in the package file
4. Rebuild:
   ```bash
   nix-switch  # or: mise switch
   ```

### Automating update checks

Add a shell function to `modules/home-manager/shell.nix`:

```bash
# Check custom package versions
custom-pkg-updates() {
  echo "APPlayMIDI:"
  echo "  current: 1.12"
  echo "  latest:  $(curl -s https://api.github.com/repos/benwiggy/applaymidi/releases/latest | jq -r '.tag_name')"
}
```

Or create a script that parses your package files and checks upstream.

## Troubleshooting

### Hash mismatch

If you get a hash mismatch error, the download URL may have changed or the file was updated. Re-run `nix-prefetch-url` to get the current hash.

### macOS app won't open ("damaged" error)

The app may need to clear quarantine:
```bash
xattr -cr ~/Applications/MyApp.app
```

### App not in Spotlight

Spotlight indexes `/Applications` but may be slow to pick up `~/Applications`. Rebuild the index:
```bash
mdutil -E ~/Applications
```

### Linux binary won't run

Use `autoPatchelfHook` to automatically fix library paths, or manually specify `buildInputs` with required libraries.
