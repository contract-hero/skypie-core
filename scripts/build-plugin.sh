#!/usr/bin/env bash
# Build the Claude Code plugin bundle: the manifest, the hooks, and the one
# binary that is both the MCP server and the hook runner.
#
# The bundle is what a marketplace repository serves. It carries a PREBUILT
# binary on purpose — `claude plugin install` has to stay the single install
# step, and asking a user to have a Rust toolchain to read their own comments
# would lose most of them at the first screen.
#
# Universal (arm64 + x86_64) because Launch Services will hand the plugin to
# whichever Mac the user has, and a wrong-arch binary fails as "hook timed
# out", which is the least debuggable error this design can produce.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/dist/plugin"

TARGETS=(aarch64-apple-darwin x86_64-apple-darwin)

echo "==> building skypie-mcp for ${TARGETS[*]}"
for target in "${TARGETS[@]}"; do
  # `rustup target add` is idempotent; a missing target is the usual reason a
  # fresh checkout cannot build the universal binary.
  rustup target add "${target}" >/dev/null 2>&1 || true
  cargo build --release -p skypie-mcp --target "${target}"
done

echo "==> assembling ${OUT}"
rm -rf "${OUT}"
mkdir -p "${OUT}/bin"
cp -R "${ROOT}/plugin/.claude-plugin" "${OUT}/"
cp -R "${ROOT}/plugin/hooks" "${OUT}/"

lipo -create -output "${OUT}/bin/skypie-mcp" \
  "${ROOT}/target/aarch64-apple-darwin/release/skypie-mcp" \
  "${ROOT}/target/x86_64-apple-darwin/release/skypie-mcp"
chmod +x "${OUT}/bin/skypie-mcp"

# The hook must be silent when the app is not running — that is the whole
# contract with Claude Code, and it is cheap to assert here rather than
# discover as noise in somebody's session.
echo "==> checking the hook is silent with no app running"
probe="$(SKYPIE_STATE_DIR="$(mktemp -d)" \
  "${OUT}/bin/skypie-mcp" hook read <<<'{"tool_input":{"file_path":"/tmp/nope.md"}}')"
if [[ -n "${probe}" ]]; then
  echo "FAIL: the hook spoke with no app running:" >&2
  echo "${probe}" >&2
  exit 1
fi

echo "==> ok"
lipo -info "${OUT}/bin/skypie-mcp"
du -sh "${OUT}"
echo
echo "Bundle at ${OUT}"
echo "Install locally with:  claude plugin install ${OUT}"
