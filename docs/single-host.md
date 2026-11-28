# Single-host deployment: design and remaining verification

The resource graph, route-class assertion checks and local tests are implemented.
A real isolated test stage of this exact single-host graph was deployed and
probed anonymously, with provider configuration read back. The observations below
record that stage's path-scoped discovery behavior. Signed-in browser and real
client OAuth flows remain pending; anonymous results do not verify those flows.

## Target shape

Supply one `hostname`, for example `supervisor.example.com`, in private config.
The graph derives the dashboard and MCP URLs:

| Path | Handler | Access app | Accepted Worker AUD |
| --- | --- | --- | --- |
| `/`, `/api/data.json`, `/api/ws`, assets | Worker | Whole-host dashboard, Managed OAuth off | Dashboard only |
| Exact `/mcp` | Worker | Path-scoped MCP, Managed OAuth on | MCP only |
| `/.well-known/*` | Access edge (discovery paths observed below) | MCP public destination | Worker never emits OAuth metadata |

There is one Worker, one custom domain, the same SQLite Durable Object namespace
and stable `supervisor-store-v1` singleton, and the unchanged `/api/ws` route.
Two independent applications and audiences remain. No provider, storage system,
OAuth implementation or data flow is added. Access handles OAuth and human login;
the Worker checks signed assertions and application capabilities, and the Durable
Object stores records and audit history. SST state remains in R2.

`ACCESS_AUDS` is generated as:

```json
{
  "supervisor.example.com": {
    "dashboard": ["dashboard-aud"],
    "mcp": ["mcp-aud"]
  },
  "legacy-mcp.example.com": {
    "mcp": ["legacy-mcp-aud"]
  }
}
```

The legacy entry exists only when configured. Unknown hosts and missing route
classes fail closed with 403 for supplied assertions; missing assertions return
401. Dashboard assertions fail on `/mcp`; MCP assertions fail on dashboard,
API, WebSocket and asset paths. Only exact `/mcp` selects MCP, so `/mcp/` is not
an alternate MCP endpoint. Identity allowlisting and capabilities still apply.
Old array-per-host bindings are removed. Split mode uses the same new format,
assigning each host's original AUD to **both** classes: historically every path
on either split host accepted that host's AUD, and that behavior is preserved.

## Discovery ownership and evidence

The pinned provider's `destinations` field accepts public entries with `uri`.
The MCP app has both `<host>/mcp` and `<host>/.well-known/*`. The dashboard app
keeps a host-wide `domain`, with Managed OAuth disabled. Anonymous probes observed
the more-specific Access match serving discovery through the MCP application.
A path-only `/mcp` destination would leave root discovery under the dashboard app.
The Worker never supplies substitute metadata: authenticated discovery requests
that reach it return 404 or 403, with no OAuth endpoints or challenge header.

### A) Anonymous (no cookie, no token) — observed

These results came from the isolated test stage, not the earlier host-wide
Managed OAuth assessment. Hostnames and audience values are placeholders.

| Probe or readback | Observed result |
| --- | --- |
| `/`, `/api/state`, `/api/ws`; `/api/ws` also with WebSocket upgrade headers | 302 to Access login. The login URL's `kid` is the dashboard application's AUD. Response header: `WWW-Authenticate: Cloudflare-Access resource_metadata="https://<host>/.well-known/cloudflare-access-protected-resource/<path>"`, scoped to the requested path. |
| Exact `/mcp` and `/mcp/x` | 401 from the MCP Access application, with `WWW-Authenticate: Bearer realm="OAuth", error="invalid_token", ... resource_metadata="https://<host>/.well-known/cloudflare-access-protected-resource/mcp"`. No redirect to browser login. |
| Root metadata: `/.well-known/oauth-protected-resource` and `/.well-known/cloudflare-access-protected-resource` (no suffix) | 200 from Access. `resource` is the host root `https://<host>`, not the MCP endpoint. Do not use these documents for the MCP client. |
| Scoped metadata: `/.well-known/oauth-protected-resource/mcp` and `/.well-known/cloudflare-access-protected-resource/mcp` | 200 from Access. `resource` is exactly `https://<host>/mcp`; `authorization_servers` is an array containing only the configured Access team domain. The 401 challenge on `/mcp` advertises the `cloudflare-access-protected-resource/mcp` document. |
| `/.well-known/oauth-authorization-server` | 200 from Access. |
| Provider readback: Access applications | Two independent applications with distinct AUDs. Dashboard: `domain=<host>`, Managed OAuth disabled. MCP: destinations `<host>/mcp` and `<host>/.well-known/*`, Managed OAuth enabled. |
| Provider readback: MCP DCR | `allowed_uris` contains only the configured callbacks; localhost and loopback are both false. This is configuration evidence, not a completed client registration. |
| Provider readback: dashboard DCR | Provider defaults keep localhost and loopback true. These settings are inert while dashboard Managed OAuth is disabled. |
| Worker binding readback | `ACCESS_AUDS = {"<host>": {"dashboard": ["<dashboard AUD>"], "mcp": ["<mcp AUD>"]}}`. |

Access matching `/mcp/x` to the MCP application does not make it a Worker MCP
endpoint: only exact `/mcp` selects the Worker's MCP route class.

### B) Signed in — pending (not yet verified)

| Check | Status |
| --- | --- |
| Browser Access login and live WebSocket updates | **Pending** |
| Real ChatGPT OAuth: DCR using the exact callback and token `resource` | **Pending** |
| Authenticated MCP read/write | **Pending** |
| Cross-audience token rejection using real assertions in both directions | **Pending**; currently covered by unit tests only. |

**Unverified:** the two apps share the `CF_Authorization` cookie name. Visiting
`/mcp` in a browser may replace the dashboard cookie and require login again.
Route-specific audience validation prevents token crossover even if that occurs.

### Verify your deployment

- [ ] Replace the example host below with your deployment host. Run without
  cookies or tokens; do not follow redirects. `-q` ignores local curl config.
  Compare statuses, `Location` (including `kid`) and `WWW-Authenticate` with A.

  ```sh
  DEPLOY_HOST='supervisor.example.com'
  for path in / /api/state /api/ws /mcp /mcp/x; do
    curl -q --http1.1 --max-time 15 -sS -D - -o /dev/null \
      -H 'Cookie:' -H 'Authorization:' "https://$DEPLOY_HOST$path"
  done
  curl -q --http1.1 --max-time 15 -sS -D - -o /dev/null \
    -H 'Cookie:' -H 'Authorization:' -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" "https://$DEPLOY_HOST/api/ws"
  ```

- [ ] Inspect discovery status and JSON. Root and scoped metadata differ: the
  documents without a suffix identify the host root `https://$DEPLOY_HOST`; the
  `/mcp`-suffixed documents identify exactly `https://$DEPLOY_HOST/mcp` with the
  configured team domain in `authorization_servers`. For MCP, take the exact
  `resource_metadata` URL from the `/mcp` 401 challenge and fetch it with the same
  anonymous curl options; its `resource` must be `https://$DEPLOY_HOST/mcp`.

  ```sh
  for path in /.well-known/oauth-protected-resource \
    /.well-known/oauth-protected-resource/mcp \
    /.well-known/cloudflare-access-protected-resource \
    /.well-known/cloudflare-access-protected-resource/mcp \
    /.well-known/oauth-authorization-server; do
    curl -q --max-time 15 -sS -i -H 'Cookie:' -H 'Authorization:' "https://$DEPLOY_HOST$path"
  done
  ```

- [ ] Read back both Access applications, DCR settings and Worker `ACCESS_AUDS`;
  compare them with A. Anonymous probes alone cannot verify configuration or any
  pending signed-in check in B.

## Migration from split mode

Use the **same** app name, stage, account, zone, SST state and Worker component.
Set `hostname` to the existing `dashboardHostname`, set `legacyMcpHostname` to
the existing `mcpHostname`, then remove both split fields. Keep all other config
unchanged. Example transition (reserved values only):

```json
{ "dashboardHostname": "dashboard.example.com", "mcpHostname": "mcp.example.com" }
```

becomes:

```json
{ "hostname": "dashboard.example.com", "legacyMcpHostname": "mcp.example.com" }
```

These snippets show only the host fields; the other required settings remain.
Do not change the dashboard hostname as part of this migration. A different host
would change the existing domain/application arguments and defeat the safe plan.

| Mode | Dashboard app / policy / domain | Host-wide MCP app / policy / domain | Path MCP app / policy |
| --- | --- | --- | --- |
| Split | `DashboardAccess` / `DashboardPolicy` / `DashboardDomain` | `McpAccess` / `McpPolicy` / `McpDomain` | None |
| Single, fresh | `DashboardAccess` / `DashboardPolicy` / `DashboardDomain` | None | `McpAccess` / `McpPolicy` |
| Single + legacy | Original `Dashboard*`, same arguments | Original `Mcp*`, same arguments | New `McpPathAccess` / `McpPathPolicy` |

For split → single + legacy, the intended plan creates only the path app/policy
and updates the Worker binding/code. Existing Access apps, policies and custom
domains keep their logical names and arguments. No new domain is needed because
the dashboard host already routes to the same Worker. Offline tests compare those
resource arguments directly. **Unverified:** an actual provider/state `sst diff`;
review a later authorized plan and stop if any existing app, policy, domain or DO
would be replaced/deleted. Existing clients keep their original MCP URL and AUD;
on the legacy host the Worker now deliberately denies all non-`/mcp` paths.
Move clients to `https://<host>/mcp` only after real discovery/login acceptance.

Rollback: revert private config to split mode, remove the newly added path
app/policy through the reviewed stack plan and redeploy the previous Worker
version with its previous audience binding. Remove any newly created custom
domain only if an installation actually added one; this migration adds none.
Never remove the original `DashboardDomain` or `McpDomain`. The DO namespace,
class migration, store key and data remain untouched. Retiring the legacy host
later is a separate deliberate removal after all clients move, not part of this
creates-only migration.

## Setup, permissions and proposed installer

See [setup](setup.md) for the full configuration and permission table, including
Access Organizations Read and Identity Providers Read for proposed preflight.
The current implementation consumes private config; it does not implement an
interactive installer or make these preflight calls.

The proposed shortest flow asks for one hostname and the human's IdP login email,
reads the exact active zone, team `auth_domain`, existing IdPs, token permissions,
host conflicts and SST home, writes private config, shows a diff, then deploys
only with appropriate authorization. It should fail before writes for a missing
zone, organization, IdP, conflicting host or permissions outside the intended
scope. A migration must recognize resources already owned by its own stack.
An API IdP listing proves existence, never successful login.

Manual provider steps remain: activate/delegate the zone, enroll Zero Trust and
choose a plan, configure an IdP, create the narrow deployment token, identify the
actual IdP login email, log in to the dashboard, and approve client consent.
**Unverified:** Free-plan payment-method requirements and API creation of a new
organization. An optional broad token-minting bootstrap is only a proposal and
is not the default; it is unnecessary for this graph.

The schema allows the exact ChatGPT fixed callback
`https://chatgpt.com/connector_platform_oauth_redirect` and per-connector
`https://chatgpt.com/connector/oauth/<id>`. **Unverified:** which URI the current
client sends. Record the actual `redirect_uri` and allow only that exact URI.
Do not claim a fixed callback removes a temporary discovery-window/capture step
until verified. If a separate approved capture procedure is required for a
per-connector callback, keep it bounded, force it closed and narrow the allowlist
after capture; this change does not implement such a procedure. No wildcard or
open-registration mode is introduced. Exact loopback callback support also
remains unverified against the provider.

## Remaining deployment acceptance

Use only a separately authorized test account/zone, sample data and sanitized
evidence. The anonymous observations above cover only the isolated test stage.
These remaining steps are not run by local gates:

1. Review the actual plan; deploy one host and verify Access app destinations,
   OAuth configuration, exact DCR restrictions and disabled alternate Worker URLs.
2. Repeat the anonymous checklist for your deployment and test negative DCR
   requests; configuration readback alone does not prove DCR enforcement.
3. Log in through the IdP; read data and observe a WebSocket update. Measure the
   cookie behavior after visiting `/mcp`.
4. Connect ChatGPT at `https://<host>/mcp`; record client/version/date and callback,
   test consent, refresh/reconnect, read, revisioned write, audit and live update.
   Swap real assertions in both directions and verify denial.
5. Exercise the existing-stack migration plan and legacy client continuity, then
   rollback without changing DO data. Tear down only test resources and read back
   their removal. Record any enrollment/billing step and exact token sufficiency.

Anonymous Access routing and discovery were observed as recorded in A. Signed-in
cookie behavior, real connector compatibility, real cross-audience assertion
rejection and provider update/migration behavior remain pending.
