# Worker workspace

The Worker authenticates Access JWTs, serves UI assets, handles MCP tool calls and
forwards authenticated WebSocket upgrades to one SQLite Durable Object. Root
commands build assets before tests and typechecking. The deployment entrypoint is
`src/worker.ts`; `test/entry.ts` injects local JWT verification only for tests/dev.

The runtime starts empty. Neutral samples require explicit local `--sample`.
Host audiences and human capability allowlists are required configuration;
see [setup](../../docs/setup.md) and [the MCP contract](../../docs/mcp-contract.md).
