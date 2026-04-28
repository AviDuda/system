# Windows Virtual Machines

Scripted Windows 11 ARM64 VM creation in UTM.

## Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `mise windows-utm -- [options]` | `mise nwu` | Download ISO + create UTM VM |
| `mise windows-utm -- --clean` | | Remove cached downloads (~7GB) |
| `mise windows-test` | `mise nwt` | Clone template for disposable testing |
| `mise windows-test-cleanup` | `mise nwtc` | Stop + delete test clones |

## Quick Start

```bash
# 1. Create the template VM (~15 min first time, ISO cached after)
mise nwu -- --username avi --password hunter2

# 2. Start it in UTM, press any key at the boot prompt
#    Windows installs unattended (~10 min), then reboots into desktop

# 3. Verify SSH works (firstlogin.ps1 sets it up automatically)
ssh user@windows-11.local

# 4. (Optional) Install personal tools
mise wr -- config/windows/personalize.ps1

# 5. Shut down the VM -- this is now your pristine template
```

After step 1, the script will:
1. Download the Windows 11 ARM64 ISO (~7GB, cached with ETag)
2. Download VirtIO ARM64 drivers (~7MB)
3. Download UTM guest tools (~75MB)
4. Build an unattended installation ISO
5. Create a UTM VM with ISOs bundled

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--name NAME` | `windows-11` | VM name in UTM |
| `--username USER` | `user` | Windows local account |
| `--password PASS` | `password` | Account password |
| `--disk SIZE` | `64` | Disk size in GB |
| `--memory SIZE` | `8192` | RAM in MB |
| `--cores N` | `6` | CPU cores |
| `--iso PATH` | | Use existing ISO instead of downloading |
| `--emulate` | | QEMU emulation instead of Apple Hypervisor |
| `--clean` | | Remove cached downloads and exit |

## How It Works

### ISO Download

The script resolves the latest Windows 11 ARM64 ISO URL from [massgrave.dev](https://massgrave.dev/windows_arm_links)'s GitHub-hosted link list. It parses the **default (recommended) tab**, so when massgrave updates to a newer build, the script automatically follows. These are direct Microsoft CDN links — genuine files, no scraping of Microsoft's download page required.

Downloads use **aria2c** (16 parallel connections) for much faster downloads than single-connection curl. Falls back to curl if aria2 isn't installed. Cached ISOs are reused automatically via ETag checking -- if the cached file matches the current server version, it skips the ~7GB download entirely.

After download, the script automatically looks up the expected **SHA-256 hash** from [files.rg-adguard.net](https://files.rg-adguard.net/search) (the canonical third-party database of Microsoft file hashes) and verifies the downloaded file matches. If the hash doesn't match, it warns that the file may be corrupted or tampered. If the lookup fails (network issues, unknown build), it prints the computed hash with a manual verification link.

### Unattended Installation

The script builds an ISO containing:
- **`autounattend.xml`** — selects Windows 11 Pro, creates a local account, bypasses TPM/SecureBoot checks, loads VirtIO drivers
- **VirtIO ARM64 drivers** — storage, network, GPU, input (from [qemus/virtiso-arm](https://github.com/qemus/virtiso-arm))
- **UTM guest tools** — SPICE agent for clipboard/resolution, VirtIO display driver
- **`firstlogin.ps1`** — post-install setup (driver install, OpenSSH server, RDP, telemetry reduction)

The unattended ISO is a data payload only -- no bootloader. UEFI boots from the Windows install ISO (which has its own bootloader), and Windows Setup discovers `autounattend.xml` on the second CD drive automatically.

**Driver loading:** Windows 11 24H2+ broke the `DriverPaths` mechanism in autounattend.xml (Microsoft regression, error `0x80070103`; [Spiceworks discussion](https://community.spiceworks.com/t/autounattend-xml-driver-path-issue-for-windows-11-24h2-and-25h2/1244985)). Drivers are loaded via `drvload` commands in `RunSynchronousCommand` instead, which explicitly loads viostor, vioscsi, and NetKVM into WinPE before DiskConfiguration runs. The `DriverPaths` entries are kept as fallback for older ISOs.

**Note:** The VirtIO GPU DOD driver (viogpudo) is intentionally not installed. On ARM64 it causes a phantom second monitor and breaks resolution changes ([virtio-win#969](https://github.com/virtio-win/kvm-guest-drivers-windows/issues/969)). The ramfb framebuffer alone handles display correctly, including dynamic resizing and clipboard sharing via SPICE.

**Display card:** VMs use `virtio-ramfb` (not `virtio-ramfb-gl`). The GL variant enables a host-side OpenGL compositor for slightly smoother rendering, but blocks VM suspend ("Suspend is not supported when GPU acceleration is enabled"). There are no guest-side 3D acceleration drivers for Windows on this display adapter anyway. Suspend is more valuable.

**Sound:** VMs are configured with an `intel-hda` audio device (Intel HD Audio). UTM's AppleScript dictionary doesn't expose the Sound configuration property, so the script adds it to the VM's `config.plist` via PlistBuddy after creation. UTM must be restarted to pick up the change (it caches config in memory at launch). After restart, the sound device appears in UTM's settings UI. Audio is routed through the SPICE backend to the host.

### Post-Install (firstlogin.ps1)

Runs automatically on first login:
- Installs remaining VirtIO drivers via `pnputil`
- Installs UTM guest tools (SPICE agent + display driver)
- Installs QEMU Guest Agent (for time sync and host communication)
- Enables persistent auto-logon (reboots go straight to desktop)
- Configures Windows Defender exclusions for dev paths and processes
- Installs PowerShell 7 via winget
- Sets Windows Terminal as default terminal (via `HKCU\Console\%%Startup` delegation CLSIDs)
- Configures Windows Terminal to use PS7 as default profile
- Enables OpenSSH server with PS5.1 as default shell (PS7 AppX not on SYSTEM PATH)
- Enables NTP time sync (`w32time` service, supplements qemu-ga)
- Enables Remote Desktop, allows ICMP ping
- Enables Developer Mode
- Enables dark mode (system + apps)
- Sets High Performance power plan
- Enables clipboard history (`Win+V`)
- Disables lock screen and screen timeout
- Enables long paths (removes 260-char limit)
- Reduces telemetry
- Explorer: shows file extensions, hidden files, full path in title bar, launches to This PC
- Disables taskbar widgets, search icon-only, OneDrive autostart disabled

### Timezone

The VM's timezone is automatically set to match the host's. `windows-utm.sh` detects the host's IANA timezone from `/etc/localtime`, converts it to a Windows timezone name using the CLDR `windowsZones.xml` mapping (cached for 30 days at `~/.cache/windows-utm/tz-map.tsv`), and injects it into `autounattend.xml`.

## SSH Access

The VM is accessible via the vmnet shared network (192.168.64.x). SSH key is automatically deployed from `~/.ssh/vm.pub` during first login via `firstlogin.ps1`. The SSH config in nix matches `192.168.64.*` so you can connect with:

```bash
ssh user@192.168.64.x
```

Note: on macOS Sequoia+, the terminal app needs **Local Network** access (System Settings → Privacy & Security → Local Network) to reach vmnet interfaces. Without this, SSH will fail with "No route to host" even though the guest can reach the host.

### Interactive Session

SSH runs in session 0 (no desktop). UI Automation, screen capture, and OCR require the interactive desktop session (session 1). Use `winrun -i` to execute scripts there:

```bash
# Run a script in the interactive session
WINRUN_HOST=user@IP mise wr -- -i -- myscript.ps1
# or directly:
WINRUN_HOST=user@IP ~/system/scripts/winrun.sh -i myscript.ps1
# stdin also works:
WINRUN_HOST=user@IP ~/system/scripts/winrun.sh -i - << 'PS1'
Write-Host "hello from the desktop"
PS1
```

The `-i` flag wraps the script in a scheduled task that runs in the user's interactive session. Output is captured via temp file polling (60s timeout). Note: this briefly spawns a visible window on the desktop.

## Running Scripts on the VM

`mise wr` (`scripts/winrun`) runs PowerShell scripts on the VM with reliable output:

```bash
# Run a local PS1 file
mise wr -- config/windows/personalize.ps1

# Pipe a script via stdin
mise wr -- - << 'EOF'
Write-Host "Hello from winrun"
EOF

# Read the firstlogin transcript log
mise wr -- --log

# Verbose mode (full SSH debug output, useful for connection issues)
mise wr -v -- config/windows/personalize.ps1

# Interactive + verbose
mise wr -iv -- myscript.ps1
```

It copies the script to the VM via scp, executes it, and prints all output. This avoids the output-swallowing issue with `ssh ... powershell -File - << heredoc`. Environment variables `WINRUN_HOST` and `WINRUN_KEY` override the default SSH target.

Flags:
- `-v` / `--verbose` -- full SSH debug output (connection negotiation, auth, etc.)
- `-i` / `--interactive` -- run in the interactive desktop session (see below)
- Both combinable: `-iv`

Connection failures fail fast (~5s timeout) with a clear error message suggesting `-v` for diagnostics.

## Disposable Test Clones

UTM cloning uses APFS copy-on-write, so cloning the template is instant (~0.25s)
regardless of disk image size. This gives a snapshot-like workflow without Parallels.

The template VM must be stopped before cloning.

### Basic usage

```bash
# Clone the template, boot, wait for SSH (random hostname, ~60s for rename reboot)
windows-test.sh

# Named clone (hostname = FOREPAW)
windows-test.sh --name forepaw

# Clean up when done
windows-test.sh cleanup
windows-test.sh cleanup --dry-run      # preview what would be deleted
windows-test.sh cleanup forepaw         # only delete windows-forepaw*
```

### Project base templates

You can create persistent base VMs with project-specific tooling, then
clone from those instead of the default `windows-11` template:

```bash
# 1. Create a base VM from the default template
windows-test.sh --name forepaw-base --no-stamp

# 2. Install project tools on it (SSH in, run setup scripts, etc.)
WINRUN_HOST=user@IP ~/system/scripts/winrun.sh scripts/windows/setup-dev.ps1

# 3. Stop the base VM (it becomes a template)
utmctl stop windows-forepaw-base

# 4. Clone from it for disposable testing
windows-test.sh --source forepaw-base --name test-1
windows-test.sh --source forepaw-base --name test-2

# 5. Clean up test clones (base stays intact)
windows-test.sh cleanup test-
```

Each `--source` clone gets the base VM's tools pre-installed. The base
stays pristine -- never boot it for testing, only clone from it.

### Flags

| Flag | Description |
|------|-------------|
| `--name NAME` | Clone name prefix + Windows hostname (uppercase, no hyphens) |
| `--no-stamp` | Omit timestamp from clone name (for base templates) |
| `--source VM` | Clone from a different VM instead of default `windows-11` |
| `--no-rename` | Skip hostname setting (no reboot, faster startup) |
| `cleanup [FILTER]` | Stop + delete clones (`--dry-run` to preview) |

### Hostnames

Every clone gets a unique hostname by default (prevents mDNS/SMB conflicts
when running multiple VMs). With `--name`, the hostname is derived from it.
Without `--name`, a random word pair is chosen from `/usr/share/dict/words`
(e.g. `swift-fox`, `bold-arch`). Hostname setting adds ~60s for a reboot.

Use `--no-rename` to skip the reboot if you don't need mDNS resolution.

The UTM clone name includes the `--source` (if set) and hostname for
traceability in `utmctl list`.

## Known Issues

- **"Press any key to boot from CD/DVD"** -- UEFI prompts for a keypress before booting the Windows ISO. Not yet bypassed automatically.
- **Retina mode is enabled by default** (`native resolution: true`). This passes the full Retina resolution to the guest for sharper text. Set display scaling manually in Windows Settings → System → Display → Scale (175% works well on 2x Retina). To disable for testing (e.g. checking OCR quality inside the VM):
  1. UTM: Edit VM → Display → uncheck HiDPI (Retina)
  2. Windows: Settings → System → Display → Scale → 100%
  Or via SSH: set `DpiValue` to `0` under `HKCU:\Control Panel\Desktop\PerMonitorSettings\<monitor-guid>`.

## Windows Updates

The ISO installs a point-in-time Windows build. To update the template (or any running VM):

```bash
mise wr -- config/windows/update-windows.ps1
```

The script uses the Windows Update COM API to search, download, and install pending updates. If a reboot is required, it restarts automatically and prints a reminder to re-run the script. Updates are not baked into `firstlogin.ps1` because they add 10-30+ minutes to first boot and are only needed when refreshing the template.

For disposable test clones, updates usually aren't worth running -- the clone is short-lived.

## Personalization

`config/windows/personalize.ps1` installs personal tools on top of the base system. Not baked into the ISO:

```bash
mise wr -- config/windows/personalize.ps1
```

Or run it locally on the VM (e.g. from Windows Terminal):

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\personalize.ps1"
```

Installs Git for Windows (winget), Firefox, Zed, JetBrainsMono Nerd Font (winget), mise, and 25 CLI tools via `mise use -g` (ripgrep, fd, bat, delta, jq, neovim, pandoc, etc.). Tool selection mirrors `modules/home-manager/default.nix`. Git is configured with autocrlf=input, defaultBranch=main, delta as pager with side-by-side, and conflictstyle=diff3.

After the initial run, add more tools via `mise wr`:

```bash
mise wr -- - <<< 'mise use -g <tool>@latest'
```

For project-specific setup (e.g. forepaw test apps), write a per-project script and run it via `mise wr`. The template gives you SSH + PS7 + drivers + RDP -- enough to bootstrap anything in seconds.

## Files

| File | Purpose |
|------|---------|
| `scripts/windows-utm.sh` | Main automation script |
| `scripts/winrun.sh` | Run PS1 scripts on VM via SSH |
| `scripts/windows-test.sh` | Clone/delete disposable test VMs |
| `config/windows/autounattend.xml` | Unattended answer file |
| `config/windows/firstlogin.ps1` | Post-install setup script |
| `config/windows/fix-ssh-auth.ps1` | SSH auth diagnostics and fixes |
| `config/windows/personalize.ps1` | Personal tools (browsers, CLI, Terminal config) |
| `config/windows/update-windows.ps1` | Windows Update installer (run via SSH) |
