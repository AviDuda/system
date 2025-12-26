# Tailscale Configuration

This directory contains the Tailscale ACL policy for the tailnet.

## Files

- `policy.hujson` - Access control policy (ACLs, SSH rules, node attributes)

## Usage

Edit the policy locally, then push to Tailscale:

```bash
mise ts-push  # or: mise tailscale:push-acl
```

## Auth key

A reusable auth key for provisioning new machines is stored in `secrets/tailscale.yaml` (encrypted with sops).

Usage on a new machine:

```bash
tailscale up --authkey $(sops --decrypt --extract '["auth_key"]' secrets/tailscale.yaml)
```

## Tags

| Tag | Purpose |
|-----|---------|
| `tag:nix-managed` | Devices provisioned via nix-system auth key |
| `tag:home` | Stationary home devices (Apple TV, etc.) |
| `tag:server` | Cloud servers (Hetzner, etc.) |
| `tag:service-host` | Can host Tailscale Services |
| `tag:mobile` | Portable devices (phones, laptops) |
| `tag:homelab` | Home infrastructure (Raspberry Pi, NAS, etc.) |
