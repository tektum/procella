#!/usr/bin/env bash
set -euo pipefail

mkdir -p .build/cli-api .build/web-api .build/gc .build/migrate

(
	cd esc-eval
	make build
)

bun build --compile --target=bun-linux-x64 --production --sourcemap --compile-exec-argv="--smol" apps/server/src/lambda-cli.ts --outfile .build/cli-api/bootstrap
bun build --compile --target=bun-linux-x64 --production --sourcemap --compile-exec-argv="--smol" apps/server/src/lambda-web.ts --outfile .build/web-api/bootstrap
bun build --compile --target=bun-linux-x64 --production --sourcemap --compile-exec-argv="--smol" apps/server/src/gc-bootstrap.ts --outfile .build/gc/bootstrap
bun build --compile --target=bun-linux-x64 --production --sourcemap --compile-exec-argv="--smol" apps/server/src/migrate-bootstrap.ts --outfile .build/migrate/bootstrap
cp -rf packages/db/drizzle .build/migrate/drizzle

for binary in \
	.build/esc-eval/bootstrap \
	.build/cli-api/bootstrap \
	.build/web-api/bootstrap \
	.build/gc/bootstrap \
	.build/migrate/bootstrap; do
	test -x "$binary"
done
