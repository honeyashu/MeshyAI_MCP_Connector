# Meshy AI Claude Connector

An MCP (Model Context Protocol) server that brings [Meshy AI](https://www.meshy.ai)'s text-to-3D and image-to-3D generation into Claude Desktop, Claude Code, and Cowork — as native tools Claude can call directly.

Ask Claude for a 3D model, and it can generate a preview, refine it with textures, rig it, animate it, and download the finished GLB/FBX/OBJ/USDZ files to your machine — no separate app, no manual API calls.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](tsconfig.json)

## Why this exists

Meshy AI has a solid REST API for text/image-to-3D generation, but no first-class way to drive it from an AI assistant's own tool-calling loop. This project wraps that API as an MCP server, and — more importantly — wraps it behind a **provider-agnostic architecture** (`IAI3DProvider`), so other 3D-generation APIs (Tripo, Rodin, Luma, Trellis, ...) can be added later without touching the orchestration logic, credential handling, download pipeline, or MCP tool surface.

It was built for [AttrangiToys](https://github.com/honeyashu), a toy design studio using AI-generated 3D assets, but it's intentionally decoupled from that project — anyone integrating Meshy AI with Claude can use it as-is.

## What it can do

- **Generate** — text-to-3D (preview → refine with textures) and image-to-3D (single or up to 4 multi-view images)
- **Rig & animate** — humanoid auto-rigging, then apply animations from Meshy's action library
- **Track jobs** — poll status/progress, cancel, list active jobs, with optional SQLite-backed persistence across restarts
- **Download** — concurrent multi-format downloads (GLB/FBX/OBJ/USDZ/STL/3MF), disk layout per-job, optional Draco GLB compression and ZIP packaging
- **Manage credentials safely** — API keys encrypted at rest (AES-256-GCM), never logged in plaintext

All of the above is exposed as 14 MCP tools — see [MESHY_CONNECTOR.md](./MESHY_CONNECTOR.md) for the full API reference and architecture deep-dive.

## Quick start

```bash
git clone https://github.com/honeyashu/MeshyAI_MCP_Connector.git
cd MeshyAI_MCP_Connector/meshy-ai-connector
npm install
npm run build
```

Add it to your MCP client config. For Claude Desktop, edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "meshy-ai": {
      "command": "node",
      "args": ["/absolute/path/to/MeshyAI_MCP_Connector/meshy-ai-connector/dist/server/mcpServer.js"]
    }
  }
}
```

Restart your client, then ask Claude to call the `save_credentials` tool with your [Meshy API key](https://www.meshy.ai/api-keys) (starts with `msy_`). That's a one-time step — the key is encrypted and stored locally. From there, just ask Claude to generate something: "generate a 3D model of a ceramic toy car, then download it to ~/Desktop/models."

Full setup, configuration options (download directory, size budgets, compression, logging), and troubleshooting are in [MESHY_CONNECTOR.md](./MESHY_CONNECTOR.md).

## Project layout

```
meshy-ai-connector/
├── src/
│   ├── core/          # Provider-agnostic orchestration (GenerationManager, DownloadManager, CredentialManager, RetryPolicy, Logger, types)
│   ├── providers/meshy/  # Meshy AI implementation of IAI3DProvider
│   ├── store/          # Encrypted credential store + optional SQLite job store
│   └── server/          # mcpServer.ts — the MCP entry point, 14 registered tools
├── MESHY_CONNECTOR.md  # Full developer guide: API reference, config, architecture, known gaps
└── README.md           # You are here
```

## Status

All core phases are complete: 142/142 tests passing, strict TypeScript with zero `tsc`/`eslint` errors, MCP server verified against the real `@modelcontextprotocol/sdk`. Two known, documented gaps remain — see [Known Gaps & Limitations](./MESHY_CONNECTOR.md#known-gaps--limitations) in the developer guide (neither blocks normal use).

## Contributing

Contributions are welcome — bug fixes, a second provider implementation, better test coverage, docs improvements, all of it. See [CONTRIBUTING.md](./CONTRIBUTING.md) for how the codebase is organized and what a good PR looks like. The short version: fork it, branch off `main`, run `npm run typecheck && npm run lint && npm test` before opening a PR.

If you're adding a new 3D-generation provider (Tripo, Rodin, Luma, etc.), [MESHY_CONNECTOR.md](./MESHY_CONNECTOR.md#adding-a-new-provider) walks through the exact pattern to follow.

## License

[MIT](./LICENSE) — do what you want with it, forks and commercial use included.
