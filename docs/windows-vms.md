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
mise nwu -- --username avi --password hunter2
```

This will:
1. Download the Windows 11 ARM64 ISO (~7GB, cached with ETag)
2. Download VirtIO ARM64 drivers (~7MB)
3. Download UTM guest tools (~75MB)
4. Build an unattended installation ISO
5. Create a UTM VM with ISOs bundled

Then open UTM and start the VM. Press any key when prompted to boot from CD/DVD. Windows installs via `autounattend.xml`.

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

### Post-Install (firstlogin.ps1)

Runs automatically on first login:
- Installs remaining VirtIO drivers via `pnputil`
- Installs UTM guest tools (SPICE agent + display driver)
- Enables OpenSSH server with admin key auth fix
- Enables Remote Desktop
- Disables lock screen and screen timeout
- Reduces telemetry

## SSH Access

The VM is accessible via mDNS (UTM uses Apple's vmnet.framework):

```bash
ssh -i ~/.ssh/nixos-vm avi@WINDOWS-VM.local
```

No port forwarding needed — the guest gets a real IP on the virtual network.

Note: you need to deploy an SSH key to the VM. The `firstlogin.ps1` configures sshd but doesn't deploy keys. See the SSH key setup section below.

### SSH Key Setup

From the host, serve your public key and run the setup on the guest:

```bash
# On the host
python3 -m http.server 8888 --directory ~/.ssh &
```

Then in the Windows VM's PowerShell (admin):

```powershell
$key = (Invoke-WebRequest -Uri "http://192.168.64.1:8888/nixos-vm.pub" -UseBasicParsing).ToString()
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
mkdir -Force C:\Users\avi\.ssh | Out-Null
[System.IO.File]::WriteAllText("C:\Users\avi\.ssh\authorized_keys", $key, $Utf8NoBom)

$userRule = New-Object System.Security.AccessControl.FileSystemAccessRule("avi","FullControl","Allow")
$systemRule = New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM","FullControl","Allow")
$acl = Get-Acl "C:\Users\avi\.ssh\authorized_keys"
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule($userRule)
$acl.SetAccessRule($systemRule)
$acl | Set-Acl

Restart-Service sshd
```

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

1. Create the template once: `mise nwu -- --username avi --password hunter2`
2. Boot it, verify firstlogin.ps1 completed, deploy SSH key
3. Shut it down — this is now your pristine template
4. Before each test session: `mise nwt` → clone boots → SSH in → test → `mise nwtc`

## Known Issues

- **"Press any key to boot from CD/DVD"** — UEFI prompts for a keypress before booting the Windows ISO. Not yet bypassed automatically.
- **Clipboard sharing and dynamic resolution don't work** — UTM guest tools 0.1.271 has a display driver incompatibility with Windows 11 25H2. Upstream issue.

## Files

| File | Purpose |
|------|---------|
| `scripts/windows-utm.sh` | Main automation script |
| `scripts/windows-test.sh` | Clone/delete disposable test VMs |
| `config/windows/autounattend.xml` | Unattended answer file |
| `config/windows/firstlogin.ps1` | Post-install setup script |
