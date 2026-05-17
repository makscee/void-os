#!/bin/sh
# Mint a one-shot claudev access code for VOS-121 LXC E2E via void-auth admin API.
#
# Endpoint (verified against workspace/void-auth/src/routes/admin.ts T0a probe 2026-05-18):
#   POST /v1/admin/users/{userId}/access-codes
#
# Auth: NONE at app level. Trust boundary = tailnet membership. As of
# 2026-05-18, Caddy serves /v1/admin/* ONLY on the mcow tailnet listener
# (http://100.101.0.9:8446); public auth.makscee.ru returns 403 for admin
# paths. Caller must reach this script on the tailnet (operator mac, runner
# LXC with tailscale up, etc.).
#
# Request body: empty. The endpoint takes no JSON body — userId is in the path,
# TTL is server-side fixed at 3600s, and there is no purpose/label field.
#
# Response 201: { "code": "XXXX-XXXX", "expiresAt": <unix-seconds> }
#   - code format: 8 chars from alphabet ABCDEFGHJKLMNPQRSTUVWXYZ23456789,
#     formatted as 4-dash-4 (excludes I/O/0/1).
#   - TTL: hardcoded server-side at 3600s.
#
# Errors:
#   - 404 user_not_found
#   - 400 active-grant-missing (target user has no active claudev grant)
#
# Preconditions on userId: must exist AND have an active (non-revoked) claudev
# grant, else void-auth returns 400. One-time setup per operator user:
#   POST /v1/admin/users                              (create user)
#   POST /v1/admin/users/{userId}/grants/claudev      (issue grant)
#
# Env:
#   VOID_AUTH_URL      (default: http://100.101.0.9:8446 — mcow tailnet admin)
#   VOID_AUTH_USER_ID  (required — operator user id with active claudev grant)
#
# Output: the minted code (XXXX-XXXX) on stdout, single line.
set -eu

: "${VOID_AUTH_URL:=http://100.101.0.9:8446}"
: "${VOID_AUTH_USER_ID:?required — user id of the operator account that owns the e2e code; must have an active claudev grant}"

resp=$(curl -fsSL -X POST \
  "$VOID_AUTH_URL/v1/admin/users/$VOID_AUTH_USER_ID/access-codes" \
  -H "content-type: application/json")

if command -v jq >/dev/null 2>&1; then
  code=$(printf '%s' "$resp" | jq -r '.code')
else
  code=$(printf '%s' "$resp" | python3 -c 'import sys,json; print(json.load(sys.stdin)["code"])')
fi

if [ -z "$code" ] || [ "$code" = "null" ]; then
  printf 'mint-claudev-code: empty/invalid code in response: %s\n' "$resp" >&2
  exit 1
fi

printf '%s\n' "$code"
