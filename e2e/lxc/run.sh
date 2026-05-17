#!/bin/sh
set -eu
: "${CLAUDEV_ACCESS_CODE:?CLAUDEV_ACCESS_CODE required — mint via tools/mint-claudev-code.sh or admin.makscee.ru}"
: "${TOWER_HOST:=tower}"
export TOWER_HOST
export VOS_E2E_LIVE=1
cd "$(dirname "$0")/../.."
exec bun test e2e/lxc/init-non-interactive.spec.ts --timeout 300000
