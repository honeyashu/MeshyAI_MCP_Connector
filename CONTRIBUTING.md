# Contributing

Thanks for considering a contribution. This project is a provider-agnostic MCP server for AI-driven 3D generation, currently with one provider implemented (Meshy AI). Here's how the codebase is organized and what's expected in a PR.

## Getting set up

```bash
git clone https://github.com/honeyashu/MeshyAI_MCP_Connector.git
cd MeshyAI_MCP_Connector/meshy-ai-connector
npm install
npm run build
npm test
```

You'll need a [Meshy API key](https://www.meshy.ai/api-keys) to exercise the live-API paths, but the test suite mocks HTTP and does not require one.

## Before opening a PR

```bash
npm run typecheck   # tsc --noEmit — must be clean
npm run lint         # eslint — must be clean (0 errors; pre-existing `any` warnings in test files are tolerated)
npm test             # node --test — all tests must pass
npm run format        # prettier --write, if you touched formatting-sensitive files
```

Keep PRs focused — one logical change per PR is easier to review than a large mixed diff.

## Where things live

- `src/core/` — provider-agnostic orchestration. If you're adding logic that's specific to one 3D-generation API, it does **not** belong here.
- `src/providers/<name>/` — one directory per provider, implementing the `IAI3DProvider` interface. See [MESHY_CONNECTOR.md § Adding a New Provider](./MESHY_CONNECTOR.md#adding-a-new-provider) for the exact pattern (provider class, HTTP client, status/enum mapping module, tests).
- `src/store/` — persistence (encrypted credentials, optional SQLite job store). Both degrade gracefully if their optional native dependency isn't installed — please preserve that behavior in any changes here.
- `src/server/mcpServer.ts` — the MCP tool surface. If you add a new capability to `GenerationManager`/`DownloadManager`, it should usually get a corresponding tool registered here.

## Adding a new provider

This is the contribution we'd most like to see. The short version:

1. Implement `IAI3DProvider` in `src/providers/<name>/<Name>Provider.ts`.
2. Write a status/enum mapping module translating the provider's raw API responses into the shared `JobState` enum.
3. Add tests with mocked HTTP (see `src/providers/meshy/*.test.ts` for the existing pattern).
4. Wire it into `mcpServer.ts` (or, once there's more than one provider, extract a small `ProviderFactory` — see the note in [MESHY_CONNECTOR.md](./MESHY_CONNECTOR.md#module-layout)).

Full walkthrough with code examples: [MESHY_CONNECTOR.md § Adding a New Provider](./MESHY_CONNECTOR.md#adding-a-new-provider).

## Code style

- TypeScript strict mode. No new `any` in `src/core/` or `src/providers/` — loosely-typed dynamic imports for optional dependencies are the one accepted exception, and even those should be typed against the real package's `.d.ts` where possible (see `DownloadManager.tryCompressGlb()` for the pattern).
- Never log raw API keys or bearer tokens — `Logger` redacts known patterns automatically; if you add a new kind of secret, extend the redaction regex rather than routing around it.
- Prefer explicit, narrow types over broad unions where the call site knows more than the function signature does.

## Reporting bugs / requesting features

Open a GitHub issue. For bugs, include: Node version, whether you're running the MCP server via a client (which one) or as a library, and — if possible — a minimal reproduction. For the optional Draco compression / SQLite persistence features specifically, note whether the corresponding optional dependency (`@gltf-transform/*`, `draco3d`, `better-sqlite3`) actually installed successfully on your platform, since both are designed to degrade gracefully rather than crash when unavailable.
