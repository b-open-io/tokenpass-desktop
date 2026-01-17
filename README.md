# TokenPass Desktop

![TokenPass](https://tokenpass.app/banner.png)

TokenPass Desktop is your personal identity server. A cross-platform (macOS, Windows, Linux) desktop app that runs the Sigma Identity stack locally.

## What is TokenPass?

TokenPass lets you be your own OAuth provider with Bitcoin-backed authentication. No cloud accounts, no centralized dependencies.

- **Type42 (BRC-42/BRC-43)** - Key derivation for per-app isolation
- **BAP** - Bitcoin Attestation Protocol for identity
- **BSM** - Bitcoin Signed Message for authentication
- **ECIES** - End-to-end encryption using Bitcoin keys

## Download

Get the latest release: https://github.com/b-open-io/tokenpass-desktop/releases

- **macOS**: `.dmg` (Apple Silicon)
- **Windows**: `.exe` installer
- **Linux**: `.AppImage`

## How It Works

TokenPass runs as a background application (system tray) and provides a local identity server on port 21000. Web applications can request signatures and authentication through the REST API.

## Build from Source

```bash
bun install
bun run build
```

## Links

- Website: https://tokenpass.app
- Server: https://github.com/b-open-io/tokenpass-server

## License

MIT
