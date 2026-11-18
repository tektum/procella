#!/usr/bin/env sh
# Regenerate TypeScript types from the Pulumi Go SDK apitype package.
# Usage: sh packages/types/tygo/generate.sh (or: bun run types:generate)
set -eu

# Ensure GOPATH/bin is on PATH so `go install`'d tools (tygo) are found
export PATH="${PATH}:$(go env GOPATH)/bin"

# Install tygo if not already available
if ! command -v tygo >/dev/null 2>&1; then
  echo "Installing tygo..."
  go install github.com/gzuidhof/tygo@v0.2.21
fi

TYGO_DIR="$(cd "$(dirname "$0")" && pwd)"
GEN_FILE="$TYGO_DIR/../src/pulumi.gen.ts"

# Resolve dependencies and generate TypeScript types
cd "$TYGO_DIR"
go mod tidy
tygo generate

# Extract SDK version from go.mod for the header comment
SDK_VERSION=$(cd "$TYGO_DIR" && go list -m -f '{{.Version}}' github.com/pulumi/pulumi/sdk/v3)

# Inject SDK version into the generated header
sed -i.bak "s|// Pulumi SDK version is read from packages/types/tygo/go.mod|// Pulumi SDK ${SDK_VERSION}|" "$GEN_FILE"

# Drop const re-exports of pulumi-cloud-sdk values (sdk >= v3.276.0 aliases policy
# enums to cloudapitype); tygo emits `export const X = any`, which is invalid TS.
sed -i.bak '/^export const [A-Za-z]* = any \/\* cloudapitype\./d' "$GEN_FILE"

# Fix UpdateStatus type — tygo generates a narrow union but the protocol uses arbitrary strings
sed -i.bak 's/export type UpdateStatus = typeof UpdateStatusSucceeded | typeof UpdateStatusFailed | typeof UpdateStatusCancelled;/export type UpdateStatus = string;/' "$GEN_FILE"

# Clean up sed backup files (needed for cross-platform compat: macOS + GNU sed)
rm -f "$GEN_FILE.bak"

echo "✓ Generated $GEN_FILE from Pulumi SDK $SDK_VERSION"

# Generate route table from api_endpoints.go
bun run "$TYGO_DIR/generate-routes.ts"
