#!/usr/bin/env bash
# Everything that has to pass before this repo's work is called done.
#
# It exists mostly for one line: the release profile. `cargo test --workspace`
# runs with `debug_assertions` on, so it never compiles the build the E2E
# harness must NOT exist in — only `--release` does, and only there does the
# "a release build cannot even parse an e2e_eval line" test compile and run.
#
# Run from anywhere; paths are resolved from this script.
set -euo pipefail

CORE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHELL_DIR="$(dirname "$CORE_DIR")"

step() { echo; echo "── $* ──"; }

step "cargo test --workspace"
cargo test --manifest-path "$CORE_DIR/Cargo.toml" --workspace

step "cargo test -p skypie-ipc --release (the harness must be absent here)"
cargo test --manifest-path "$CORE_DIR/Cargo.toml" -p skypie-ipc --release

step "cargo check --target aarch64-apple-ios (the phone builds the same code)"
cargo check --manifest-path "$CORE_DIR/Cargo.toml" -p skypie-app --target aarch64-apple-ios

step "cargo build (the desktop shell)"
cargo build --manifest-path "$SHELL_DIR/src-tauri/Cargo.toml"

step "pnpm test && pnpm build"
pnpm -C "$CORE_DIR/ui" test
pnpm -C "$CORE_DIR/ui" build

step "tsc --noEmit (the E2E harness is not in the app's tsconfig)"
(cd "$CORE_DIR/ui" && npx tsc --noEmit -p e2e/tsconfig.json)

echo
echo "ALL GREEN"
