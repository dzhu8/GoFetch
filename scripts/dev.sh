#!/usr/bin/env bash
set -e

echo "=== GoFetch Development Setup ==="

# ── 1. GitHub CLI authentication ────────────────────────────────────────────
echo "Checking GitHub CLI authentication..."
if ! gh auth status &>/dev/null; then
    echo "Not authenticated — launching gh auth login..."
    gh auth login
fi
echo "GitHub CLI: authenticated."

# ── 2. Register MCP server with GitHub Copilot ──────────────────────────────
# NOTE: /model (Copilot model selection) is an interactive IDE feature and
#       cannot be scripted here. Select your model in the IDE Copilot panel.
echo "Registering GoFetch MCP server with GitHub Copilot..."
gh copilot mcp add --name gofetch --url http://localhost:3001/mcp 2>/dev/null || true

# ── 3. Launch Next.js + MCP server concurrently ─────────────────────────────
echo "Starting Next.js dev server + MCP server..."
npx concurrently \
    --names "next,mcp" \
    --prefix-colors "blue,green" \
    "next dev" \
    "tsx src/server/mcp/index.ts"
