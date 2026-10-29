#!/bin/sh
# Runs test suites inside a Linux container on the Compose network — for POSIX-signal tests
# (SIGTERM) when developing on Windows. Usage, from the repository root, inside WSL:
#   docker run --rm --network jungle-wagering_default -v "$PWD:/src:ro" oven/bun:1.4.4 \
#     sh /src/scripts/test-in-linux.sh ./test/concurrency
set -e
mkdir -p /w
cd /src && tar --exclude=node_modules --exclude=.git --exclude=.env -cf - . | tar -xf - -C /w
cd /w && bun install --frozen-lockfile >/dev/null
export TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@postgres:5432/postgres
export MIGRATION_DATABASE_URL=postgres://wallet_owner:wallet_owner@postgres:5432/wagering
export DATABASE_URL=postgres://wallet_app:wallet_app@postgres:5432/wagering
export AWS_ENDPOINT_URL=http://localstack:4566 AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
exec bun test --preload ./test/support/integration-preload.ts "$@"
