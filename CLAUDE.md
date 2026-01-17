# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TokenPass Desktop is an Electron-based system tray application that bundles and runs the TokenPass identity server locally. Like the old starfish-desktop, it packages the server and runs it when the app starts.

## Commands

```bash
bun install          # Install dependencies
bun start            # Run the app
bun run build        # Build distributable packages (macOS, Windows, Linux)
```

## Architecture

- **index.js** - Main Electron process:
  - Spawns the bundled Next.js standalone server (`node server.js`)
  - Creates system tray with Dashboard/Exit menu
  - Handles deep links (`sigmaauth://`, `tokenpass://`) for OAuth callbacks
  - Opens browser to http://localhost:21000 after server starts
  - Kills server process on app quit

- **server/** - Bundled Next.js standalone server (from tokenpass-server)
- **extraResources/icon.png** - Tray icon

Key behaviors:
- Singleton lock ensures only one instance runs
- Hides from dock on macOS (tray-only app)
- Server runs on port 21000

## Updating the Bundled Server

When tokenpass-server changes, rebuild and copy it:

```bash
# In tokenpass-server/web (must have output: "standalone" in next.config.ts)
bun run build

# In tokenpass-desktop
rm -rf server && mkdir -p server
cp -r ~/code/tokenpass-server/web/.next/standalone/* server/
cp -r ~/code/tokenpass-server/web/.next/static server/web/.next/
cp -r ~/code/tokenpass-server/web/public server/web/
```

## BSV Protocols

- **Type42 (BRC-42/BRC-43)** - Key derivation
- **BAP** - Bitcoin Attestation Protocol
- **BSM** - Bitcoin Signed Message
- **ECIES** - Encryption
