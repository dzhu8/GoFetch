@echo off
echo === GoFetch Development Setup ===

REM ── 1. GitHub CLI authentication ──────────────────────────────────────────
echo Checking GitHub CLI authentication...
gh auth status >nul 2>&1
if errorlevel 1 (
    echo Not authenticated — launching gh auth login...
    gh auth login
    if errorlevel 1 (
        echo gh auth login failed. Exiting.
        exit /b 1
    )
)
echo GitHub CLI: authenticated.

REM ── 2. Register MCP server with GitHub Copilot ────────────────────────────
REM NOTE: /model (Copilot model selection) is an interactive IDE feature and
REM       cannot be scripted here. Select your model in the IDE Copilot panel.
echo Registering GoFetch MCP server with GitHub Copilot...
gh copilot mcp add --name gofetch --url http://localhost:3001/mcp 2>nul

REM ── 3. Launch Next.js + MCP server concurrently ───────────────────────────
echo Starting Next.js dev server + MCP server...
npx concurrently --names "next,mcp" --prefix-colors "blue,green" "next dev" "tsx src/server/mcp/index.ts"
