#!/bin/sh
# void-os one-command bootstrap: vc -> claude -> void-os -> init.
# Idempotent: safe to re-run on an already-installed machine.
set -eu

REPO_DIR="${VOID_OS_REPO:-$(cd "$(dirname "$0")" && pwd)}"

# Bun is required
command -v bun >/dev/null 2>&1 || {
  echo "bun is required: https://bun.sh"
  exit 1
}

# Install vc (void-relay client) if absent
if ! command -v vc >/dev/null 2>&1; then
  echo "installing vc..."
  curl -fsSL https://auth.makscee.ru/vc/install.sh | sh
fi

# Install claude (Anthropic Claude Code CLI) if absent
if ! command -v claude >/dev/null 2>&1; then
  echo "installing claude..."
  npm i -g @anthropic-ai/claude-code
fi

# Install void-os dependencies
echo "installing void-os..."
( cd "$REPO_DIR" && bun install )

# Link bin/void-os into ~/.local/bin
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
ln -sf "$REPO_DIR/bin/void-os" "$BIN_DIR/void-os"
chmod +x "$REPO_DIR/bin/void-os"

# Warn if ~/.local/bin is not on PATH
case ":${PATH}:" in
  *":$BIN_DIR:"*) ;;
  *) echo "NOTE: add $BIN_DIR to your PATH to use the void-os command" ;;
esac

# Run init (interactive if tty present, or pass VOID_OS_VAULT for non-interactive)
echo "running void-os init..."
if [ -n "${VOID_OS_VAULT:-}" ]; then
  "$BIN_DIR/void-os" init "$VOID_OS_VAULT"
else
  "$BIN_DIR/void-os" init
fi
