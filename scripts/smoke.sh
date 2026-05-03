#!/usr/bin/env bash
set -euo pipefail
pnpm -r typecheck
pnpm --filter @aware/server test
printf 'smoke ok\n'
