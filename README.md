# Supervisor

A dashboard and MCP server backed by a Cloudflare Worker and SQLite Durable Object.
The root Bun workspace supports local development, a config-driven clean-account
deployment graph, and sanitized exports with fresh history. See the
[export and boundary guide](docs/export.md) for verification and owner steps.

Use Bun **1.4.3** and Node **22 or newer** from the repository root:

```sh
bun install --frozen-lockfile
bun run dev                  # local-only, empty store and synthetic identity
bun run dev -- --sample      # explicitly seed neutral local sample records
bun run test
bun run test:e2e             # requires Playwright Chromium installed
bun run typecheck
bun run build
bun run clean:proof          # isolated credential-free bundle-clone proof
```

`bunx --no-install playwright install chromium` installs the browser for local E2E.
`bun run dev -- --smoke` checks startup and exits. Development listens only on
loopback, watches UI/runtime/core source and preserves its local SQLite data in
`.local/dev`. Source changes rebuild locally; refresh the browser afterwards.

The build reads only UI source, embeds five assets in the Worker and writes
`dist/worker.mjs`. It never reads a register, inventories, records, Git or local
configuration. `/api/data.json` and `/api/ws` load authenticated runtime data.
Sample data is optional, local-only and is never included in the production
bundle. No Python is required. Test JWT keys exist only in local/test entrypoints.

Workspaces: `apps/dashboard` (existing browser UI), `apps/worker` (MCP/DO/auth),
`packages/core` (record contracts and canonical JSON), and `infra` (clean-account SST graph).
The browser source remains JavaScript; its behavior is checked with TypeScript
checkJs and covered by client and desktop/mobile tests. Identity requests use
verified Access issuer/subject and validated email. Agent
filters derive from records. See [setup](docs/setup.md) for every runtime input
and [the MCP contract](docs/mcp-contract.md) for matching and revision rules.
The interface supports English and Czech, with an EN / CZ control that remembers
your choice. Record text stays in its original language.

SST is pinned to **4.17.1**, with exact provider pins. `typecheck` generates the
local SST SDK with `sst install` when absent, checks repository diagnostics strictly
and applies checksum-verified local SDK compatibility corrections before checking
upstream SDK sources. Third-party declaration files (.d.ts) are not checked
(`skipLibCheck`). See [the build guide](docs/build.md)
for compatibility evidence and verification boundaries. The root SST graph requires explicit private account/config inputs and creates new
resources only. See [setup](docs/setup.md) for its schema, token permissions and
OAuth callback rules. Real-account validation is a separate owner-authorized step.

## License

Apache-2.0. See [LICENSE](LICENSE).
