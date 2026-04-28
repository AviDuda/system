# Windows VM Scripts

See [docs/windows-vms.md](../../docs/windows-vms.md) for the full guide.

| File | Purpose |
|------|---------|
| `autounattend.xml` | Unattended answer file (template with `__USERNAME__`/`__PASSWORD__` placeholders) |
| `firstlogin.ps1` | Post-install setup (drivers, SSH, RDP, auto-logon, dark mode, Explorer tweaks) |
| `debloat.ps1` | Disable Windows annoyances (ads, Copilot, Bing, SCOOBE, Game Bar) |
| `personalize.ps1` | Personal tools (browsers, git, mise, CLI tools, Terminal config) |
| `update-windows.ps1` | Windows Update installer (search, download, install, reboot loop) |
| `fix-ssh-auth.ps1` | SSH auth diagnostics and ACL fixes |
