#!/bin/sh
# Lint: type-check the mod and validate its manifest.
set -e
cd "$(dirname "$0")/.."
npx -y -p typescript@5.6.3 tsc -p . --noUnusedLocals
claude plugin validate .
