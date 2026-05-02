#!/usr/bin/env bash
set -euo pipefail
pnpm -r typecheck
pnpm --filter @agent-ide/server test
printf 'smoke ok\n'
