# Local setup and runtime configuration

Use Bun 1.4.3 and Node 22 or newer. From the repository root:

```sh
bun install --frozen-lockfile
bun run dev
```

Local development binds loopback, generates fresh synthetic signing keys at
startup and stores SQLite state under `.local/dev`. It requires no cloud account,
credentials, environment file or external identity. Never use this test entrypoint
for deployment. Restarting local development keeps its records; remove only that
local state directory to reset it. Build and default startup never seed data.
Explicit `bun run dev -- --sample` validates `examples/sample-records.json` with
the MCP write schema and seeds local records through authenticated MCP writes.
Existing IDs retain their revisions; stale sample writes must not overwrite them.

Run `bun run test`, `bun run typecheck`, `bun run build`, `bun run bundle:check`
and `bun run dev -- --smoke`. Install the local E2E browser with
`bunx --no-install playwright install chromium`, then run `bun run test:e2e`.
`bun run clean:proof -- <scratch-parent>` exports tracked shared source into a
credential-free directory, with a fresh home and no private files or Git history,
and records every verification exit code. It preserves an externally supplied
`BUN_INSTALL_CACHE_DIR` unchanged. Browser installation needs network access.

## Required deployed runtime inputs

The clean-account graph supplies the following bindings. There are no owner,
host, audience, principal or account defaults:

| Binding | Required value and validation |
| --- | --- |
| `STORE` | New SQLite Durable Object namespace exporting `SupervisorStore`, with its SQLite migration. Each namespace uses the stable singleton key `supervisor-store-v1`. It starts empty. No existing namespace is imported or migrated. |
| `ACCESS_TEAM_DOMAIN` | Trusted team hostname ending in `.cloudflareaccess.com`, without scheme/path. Issuer is `https://` plus this hostname; JWKS is the issuer's `/cdn-cgi/access/certs`. |
| `ACCESS_AUDS` | JSON object mapping each exact request hostname to a nonempty array of nonempty Access audience strings. Obtain each value from its own new Access application. Both dashboard and MCP hosts must be explicitly configured. An absent, malformed or unknown host mapping fails closed; forwarded host headers are ignored. |
| `ALLOWED_EMAILS` | Private JSON object mapping lowercase, validated human email addresses to arrays containing `supervisor:read` and/or `supervisor:write`. Read and write capabilities are independent. Unknown principals are denied, and JWT scope claims do not grant capabilities. Match the edge Access policy to these configured humans. |

Keep principal configuration and credentials out of tracked files, assets and
logs. There are no built-in agents, account identifiers, service-token import
credentials, private repository links or automatic legacy people mappings.
No repository link is displayed. Metadata defaults to Supervisor and UTC;
the optional `DISPLAY_TIMEZONE` binding selects an Intl timezone (for example
`Europe/Prague`). Invalid or absent values fall back to UTC. Stored timestamps
remain UTC.

Cloudflare Access must protect every path on each hostname. The Worker validates
RS256 signatures, issuer, per-host audience, expiration and issued-at claims;
human sessions require a nonempty subject and validated email. Service assertions
are rejected as human viewers. Configure the trusted edge to supply
`Cf-Access-Jwt-Assertion`; browser email headers, query parameters, local storage
and unsigned JWT payloads cannot select a viewer. Tests generate signing keys at
runtime; the production bundle excludes test/local assertion injection.

## Interface language

The EN / CZ control uses locale codes `en` and `cs`. A valid saved
`localStorage['supervisor.locale']` wins over the server-negotiated request
`Accept-Language`, then English is the default. The server recognizes `en`/`cs`
and their subtags, ranks positive quality weights, and breaks ties by header
order. Unsupported languages, wildcards and malformed/zero weights do not win.
The authenticated private/no-store shell embeds only the supported resolved code;
the original header is never returned. Static/file shells without that bootstrap
use the first supported `navigator.languages` entry, then English.

Switching updates text, accessibility labels, dialogs, state filters, generated
labels, Intl dates and `<html lang>` immediately without reloading. Blocked reads
or writes are caught; the selection remains in memory until navigation. Source
record/evidence text, including explicitly stored custom state/kind/action labels,
is retained verbatim. Default state/kind and client-check labels are generated
from shared dictionaries; server projection keys let the browser change their
language without changing records. Language never participates in identity checks.

## Requesting a viewer's attention

Write `requestedFrom` through `upsert_record` with the current `expectedRev`:

```json
{
  "id": "sample:review",
  "expectedRev": 0,
  "patch": {
    "name": "Review example",
    "state": "review",
    "agent": "Sample agent",
    "requestedFrom": [
      { "issuer": "https://team-example.cloudflareaccess.com", "sub": "sample-subject-001" },
      { "email": "reviewer@example.invalid" }
    ]
  }
}
```

Use the actual issuer/subject from the verified identity in private operator
configuration, or a validated email. Subject entries require the exact issuer and
case-sensitive subject, even if an optional email conflicts. Email-only entries
match case-insensitively. Invalid lists are rejected on write; old missing or
invalid lists match nobody. Legacy waiting text can be displayed but never
creates an identity match. Any legacy mapping must be an explicit operator task.
Completed (`done`), paused, deferred and backlog states suppress current requests.
The authenticated private/no-store response computes `waitingOnYou` for each
viewer, and WebSocket invalidations make each viewer refetch that projection.
The projection is never a stored field and never grants write access.

## Clean-account configuration (deploy-free implementation)

The resource graph is implemented and checked offline. No real account, minimal
permission token or OAuth client flow has been validated yet. That is separate
account-validation work. Use an independent account with Workers, SQLite Durable
Objects and R2 enabled, a delegated DNS zone in that account, and an enrolled Zero
Trust team. Zone/team creation and external IdP setup are prerequisites outside
this graph. Do not point this installation at an existing deployment.

Copy `examples/deploy.config.example.json` to the ignored `deploy.config.json`
and replace every reserved example value privately. Set `SUPERVISOR_CONFIG` to
that file's path, `CLOUDFLARE_DEFAULT_ACCOUNT_ID` to the selected account's 32-digit
lowercase hex ID, and `CLOUDFLARE_API_TOKEN` through a secret manager or private
process environment. Never commit or print these values. Do not use global API
keys. Account selection is mandatory, so SST does not discover accounts.

| Config field | Rules / default |
| --- | --- |
| `appName`, `stage` | Required lowercase names matching `[a-z][a-z0-9-]{0,19}`. Stage must equal the explicit SST CLI stage. Each app/stage has separate state and Worker namespace. `production` retains resources and enables SST removal protection. |
| `zoneId`, `zoneName` | Required selected zone ID (32 lowercase hex digits) and DNS name. Both hosts must be strict subdomains of this zone. Account/zone ownership and absence of conflicts require the later account check. |
| `dashboardHostname`, `mcpHostname` | Required distinct, exact lowercase DNS hostnames, without scheme, port, path, credentials or wildcard. Each Access app covers its entire hostname. |
| `accessTeamDomain` | Required trusted team hostname ending in `.cloudflareaccess.com`; no scheme or path. |
| `principals` | Required nonempty list of `{email, capabilities}`. Emails are validated and lowercased; duplicates are rejected. Capabilities are unique nonempty lists of `supervisor:read` and/or `supervisor:write`. These are independent. Subject-only authorization is not implemented by the current email-based runtime; issuer/subject remains available for attention matching. |
| `policy.requires`, `policy.excludes` | Optional arrays (default empty). Each condition has exactly one selector: `{email:{email}}`, `{ip:{ip}}` (IP or CIDR), `{geo:{countryCode}}` (two uppercase letters), or `{loginMethod:{id}}` (OTP or IdP UUID). Requires are AND, excludes are NOT. Both new allow policies include exactly the configured principal emails (OR); a separate includes list, Everyone, bypass and service-token rules are rejected. |
| `allowedIdps` | Nonempty unique list of `onetimepin` or UUIDs for IdPs already configured in the new team. Default `['onetimepin']`. No IdPs are created or copied. |
| `sessionDuration` | Dashboard/MCP Access session, default `24h`, maximum 744h. |
| `oauthSessionDuration` | MCP OAuth grant session, default `336h`, maximum 744h. |
| `oauthAccessTokenLifetime` | Default `15m`, maximum 24h and no longer than the grant session. All durations use positive integer `m` or `h` units. |
| `mcpClients` | Required nonempty unique list of enabled `{client, callbackUris}` entries; rules below. Disabled clients are omitted. |
| `allowLocalProbe` | Default false. Explicitly opt in to the exact local-probe exception only while using a matching listener. Never enables broad localhost/loopback permission. |
| `storeKey` | Optional fixed value `supervisor-store-v1`; any other value is rejected. Matches the unchanged runtime singleton within each new namespace. |
| `displayTimezone` | Optional Intl timezone, default `UTC`. |

Unknown fields fail closed. Config/file errors redact supplied values. The schema
is `infra/config.ts`; the example is tested against it. Build, local dev and tests
do not load private config. Only `scripts/prepare-sst.ts` sets the internal
`SUPERVISOR_SDK_INSTALL=1` metadata mode while running credential-free `sst install`;
it is not a deployment option. Normal SST app evaluation requires valid config
before state bootstrap, and `run()` always requires it even in SDK mode.

For a later authorized deployment, export `SUPERVISOR_CONFIG`,
`CLOUDFLARE_DEFAULT_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` privately as described
above, then run from the repository root. `STAGE` must equal the `stage` field in
private config; the root lockfile pins SST 4.17.1 and `--no-install` refuses any
other CLI.

```sh
STAGE='stage-from-private-config'   # replace with config.stage
bun install --frozen-lockfile
bun run test
bun run typecheck            # also prepares the checksum-verified local SST SDK
bun run build
bunx --no-install sst version
bunx --no-install sst deploy --stage "$STAGE"
```

`sst version` must report 4.17.1 before deploying. Never omit `--stage`; a
mismatching stage fails before state bootstrap. No automated deployment is included.
The UI assets must be generated before SST builds the production Worker entrypoint.
Keep app name, stage and account stable afterwards; changing them creates a
separate installation. The graph does not adopt resources; resolve conflicting
names/hosts before deployment instead of importing or replacing existing ownership.

## Resource and state boundary

Two new `ZeroTrustAccessPolicy` resources feed two new self-hosted
`ZeroTrustAccessApplication` resources. Each app's generated AUD feeds only its
own hostname in `ACCESS_AUDS`; neither app accepts the other's audience. Only the
MCP app enables Cloudflare Managed OAuth. Access owns discovery, registration,
authorization and refresh; the Worker continues to validate Access assertions.
See [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

One `sst.cloudflare.Worker` builds `apps/worker/src/worker.ts`, creates the SQLite
`SupervisorStore` class with migration `v1`, and binds `STORE` locally to that
class, without namespace/script IDs. `ALLOWED_EMAILS` is a `secret_text` binding;
principal policy inputs and the capability map are Pulumi secret outputs. No
records are seeded; new application state starts empty. Samples require explicit
authenticated MCP writes later. No old state, resource lookup or import is used.

Worker `url:false` disables workers.dev via SST. The explicit
`WorkersScriptSubdomain` disables both workers.dev and version previews after the
Worker component (including SST's URL control). Two `WorkersCustomDomain`
resources explicitly enable hostname routing and disable custom-domain previews,
and bind the configured zone/hosts to that Worker only after the Access
apps and alternate-URL controls. There are no duplicate SST domain declarations,
DNS record resources, tunnels, KV or D1. The only stack outputs are the two URLs.
Tests use Pulumi provider mocks plus an SST component double; they check our
transform and dependencies without invoking SST's cloud-reading migration/build
helpers. Strict typecheck separately checks actual pinned SST/provider types.

SST Cloudflare home stores infrastructure state in the selected account's R2
`sst-state` bootstrap bucket, partitioned by app/stage; this is separate from DO
application records. The pinned
[SST 4.17.1 home implementation](https://github.com/sst/sst/blob/v4.17.1/pkg/project/provider/cloudflare.go)
lists/creates that bucket and reads/writes/deletes state objects and locks. With
an explicit account ID it skips account-list discovery. SST's pinned Worker
migration helper reads the script list/settings, and its URL helper updates the
script subdomain flag. These calls fit the permissions below. Local `.sst/`,
`.local/`, environment files and private deploy config remain ignored. Treat
remote/local state as private even though sensitive resource inputs are marked
secret; keep state and its encryption material protected and backed up.

## Minimal deployment token

Scope account grants to the **new account only** and zone grants to the
**selected zone only**. The intended minimal set is:

| Scope | Permission | Used by |
| --- | --- | --- |
| Account | Workers Scripts Write (dashboard may say Edit), or Workers product Admin under the newer role model | New Worker creation/upload/read, SQLite DO binding/migration, secret binding, SST script migration reads and subdomain/preview controls. An existing-Worker editor cannot create a new Worker. |
| Account | Access: Apps and Policies Write (Edit) | Both new policies/apps, Managed OAuth and AUD readback. |
| Account | Workers R2 Storage Write (Edit) | SST home bucket bootstrap, state objects, locks and encryption metadata. |
| Zone | Workers Routes Write (Edit) | Both custom domains. |
| Zone | Zone Read | Selected-zone validation/provider resolution. |

This list follows Cloudflare's
[token permission definitions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
and [Workers creation/domain permissions](https://developers.cloudflare.com/workers/authorization/workers/).
The graph creates custom domains without explicit DNS records, so DNS Write is
not requested. No Account Settings Read, D1, KV, Tail, global Zero Trust Write,
User Details, Memberships, token creation or IdP creation grant is needed by the
intended calls. Exact token sufficiency still requires the separate-account
validation; if a pinned tool makes an additional call, record it and scope the
permission before claiming validation. Do not start with a broad Workers template.

## Exact MCP callbacks

Each enabled entry supplies its exact observed callback URI; nothing is guessed
or auto-discovered. The API exposes one DCR allowlist, so the graph flattens the
validated per-client lists into that exact union. This constrains redirects, not
client identity; it does not implement a second OAuth server or promise a tested
client integration. Unknown config client names and duplicate clients/URIs fail.

| `client` | Allowed exact URI form |
| --- | --- |
| `chatgpt` | `https://chatgpt.com/connector/oauth/<callback-id>` with a nonempty alphanumeric/underscore/hyphen ID shown by the actual connector, or `https://chatgpt.com/connector_platform_oauth_redirect` only when shown by that flow. |
| `claude` | `https://claude.ai/api/mcp/auth_callback`. |
| `local-probe` | Only with `allowLocalProbe:true`: `http://127.0.0.1:<explicit-port>/callback` with a matching running listener. Port changes require an exact config update. |

All other callbacks fail validation, including wildcard/encoded wildcard paths,
localhost/IPv6 loopback, credentials, queries, fragments and unexpected hosts or
paths. Local probe callbacks fail by default. Both
`allowAnyOnLocalhost` and `allowAnyOnLoopback` are always false, including when the
exact local listener is enabled. No broad opt-out exists. The provider declaration
currently describes HTTPS URIs; the explicitly opted-in exact HTTP loopback case
is retained from the design and must be confirmed against the actual service in
separate-account validation before claiming local-probe support.

Before advertising a client, inspect its actual `redirect_uri` and sanitized
Access readback, complete login/consent, authorization code/PKCE as applicable,
refresh/reconnect and MCP read/write. Record client/version/date and exact
nonsecret callback. Negatively test wrong paths, hosts, ports and unlisted
redirects; wrong issuer/AUD/expired assertions; and no exposed alternate URL.
Use sample data only: independently read back a revisioned write, `check_record`
and audit attribution, then observe desktop/mobile WS updates without reload.
Keep token/code/cookie values out of evidence. Provider readback and observed
browser updates are separate proof. These checks remain for the authorized
independent-account slice.

Optional remote probes require an explicit HTTPS sample-account URL via their
first argument or `SAMPLE_ACCOUNT_URL`; `scripts/e2e-authorized.mjs` additionally
requires the interactively obtained opaque token in `SUPERVISOR_ACCESS_TOKEN`.
These probes can write synthetic records or register a test OAuth client. Run
them only against an explicitly authorized separate sample account, never as part
of offline tests. Do not print or commit tokens. No remote probe is required for
local development or the clean-export proof.
