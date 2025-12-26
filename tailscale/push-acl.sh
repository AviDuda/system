#!/usr/bin/env bash
# Push Tailscale ACL policy to the admin console
set -euo pipefail

cd "$(dirname "$0")/.."

api_key=$(sops --decrypt --extract '["api_key"]' secrets/tailscale.yaml)

# Validate first
echo "Validating ACL..."
validate_response=$(curl -s -X POST "https://api.tailscale.com/api/v2/tailnet/-/acl/validate" \
  -H "Authorization: Bearer $api_key" \
  -H "Content-Type: application/hujson" \
  --data-binary @tailscale/policy.hujson)
if echo "$validate_response" | jq -e '.message' >/dev/null 2>&1; then
  echo "Validation error: $(echo "$validate_response" | jq -r '.message')"
  echo "$validate_response" | jq -r '.data[]? | "  \(.user // "unknown"): \(.errors | join(", "))"'
  exit 1
fi

# Update timestamp in policy file
timestamp=$(date -u +"%Y-%m-%d %H:%M UTC")
sed -i '' "s|// Last updated: .*|// Last updated: $timestamp|" tailscale/policy.hujson

# Push the policy
echo "Pushing ACL..."
response=$(curl -s -X POST "https://api.tailscale.com/api/v2/tailnet/-/acl" \
  -H "Authorization: Bearer $api_key" \
  -H "Content-Type: application/hujson" \
  --data-binary @tailscale/policy.hujson)
if echo "$response" | jq -e '.message' >/dev/null 2>&1; then
  echo "Error: $(echo "$response" | jq -r '.message')"
  echo "$response" | jq -r '.data[]? | "  \(.user // "unknown"): \(.errors | join(", "))"'
  exit 1
else
  echo "✓ ACL updated successfully"
fi
