#!/usr/bin/env bash
# Seed (or reseed) the demo target repo: a toy TODO API plus a backlog of
# issues that exercise Foreman end to end. Idempotent; --reset wipes first.
#
#   ./scripts/seed_demo_repo.sh [--reset]
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/seed.mjs "$@"
