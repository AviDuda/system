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
ssh avi@windows-11.local

# 4. (Optional) Install personal tools
ssh avi@windows-11.local 'powershell -File -' < config/windows/personalize.ps1

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

### Post-Install (firstlogin.ps1)

Runs automatically on first login:
- Installs remaining VirtIO drivers via `pnputil`
- Installs UTM guest tools (SPICE agent + display driver)
- Installs PowerShell 7 via winget
- Sets Windows Terminal as default terminal (via `HKCU\Console\%%Startup` delegation CLSIDs)
- Configures Windows Terminal to use PS7 as default profile
- Enables OpenSSH server with PS7 as default shell
- Enables Remote Desktop
- Enables dark mode (system + apps)
- Enables clipboard history (`Win+V`)
- Disables lock screen and screen timeout
- Reduces telemetry
- Explorer: shows file extensions, hidden files, full path in title bar, launches to This PC
- Disables taskbar widgets, search icon-only, OneDrive autostart disabled

## SSH Access

The VM is accessible via the vmnet shared network (192.168.64.x). SSH key is automatically deployed from `~/.ssh/vm.pub` during first login via `firstlogin.ps1`. The SSH config in nix matches `192.168.64.*` so you can connect with:

```bash
ssh avi@192.168.64.x
```

Note: on macOS Sequoia+, the terminal app needs **Local Network** access (System Settings → Privacy & Security → Local Network) to reach vmnet interfaces. Without this, SSH will fail with "No route to host" even though the guest can reach the host.

## Disposable Test Clones

UTM cloning uses APFS copy-on-write, so cloning the template is instant (~0.25s)
regardless of disk image size. This gives a snapshot-like workflow without Parallels:

```bash
# Clone the template, boot, wait for SSH
mise nwt
# ... run your tests ... (template stays pristine)

# Clean up when done
mise nwtc
```

The clone gets a randomized MAC address (UTM copies the template's MAC verbatim,
so the script randomizes it via PlistBuddy post-clone) and a new IP via DHCP.
The template VM must be stopped before cloning.

### Workflow

The template stays pristine. Each test session gets a fresh clone:

```bash
# Clone the template (instant, APFS copy-on-write)
mise nwt
# Wait for SSH to come up, then do whatever you need
ssh avi@192.168.64.x 'powershell -File -' < my-setup.ps1
# ... run your tests ...
# Clean up
mise nwtc
```

SSH key is deployed automatically from `~/.ssh/vm.pub` during first login.
The clone gets a randomized MAC and new DHCP IP (printed by `mise nwt`).

## Known Issues

- **"Press any key to boot from CD/DVD"** -- UEFI prompts for a keypress before booting the Windows ISO. Not yet bypassed automatically.

## Personalization

`config/windows/personalize.ps1` installs personal tools on top of the base system. Not baked into the ISO. Run via SSH:

```bash
ssh avi@windows-11.local 'powershell -File -' < config/windows/personalize.ps1
```

Or copy it to the VM and run locally (e.g. from Windows Terminal):

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\personalize.ps1"
```

Installs Firefox, Zed, JetBrainsMono Nerd Font (winget), mise, and 25 CLI tools via `mise use -g` (ripgrep, fd, bat, delta, jq, neovim, pandoc, etc.). Tool selection mirrors `modules/home-manager/default.nix`.

After the initial run, add more tools with `mise use -g <tool>@latest` over SSH.

For project-specific setup (e.g. forepaw test apps), write a per-project script and pipe it the same way. The template gives you SSH + PS7 + drivers + RDP -- enough to bootstrap anything in seconds.

## Files

| File | Purpose |
|------|---------|
| `scripts/windows-utm.sh` | Main automation script |
| `scripts/windows-test.sh` | Clone/delete disposable test VMs |
| `config/windows/autounattend.xml` | Unattended answer file |
| `config/windows/firstlogin.ps1` | Post-install setup script |
| `config/windows/personalize.ps1` | Personal tools (browsers, CLI, Terminal config) |
