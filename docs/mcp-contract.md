# MCP runtime contract

Cloudflare Access owns OAuth. The Worker verifies signed RS256 Access assertions
against the configured team JWKS and exact hostname/audience map. Application
capabilities are enforced independently of JWT scope claims. Every UI/API/WS path
uses the same authentication boundary. The production entrypoint never reads test
JWKS or accepts local synthetic assertions.

The streamable HTTP endpoint is `/mcp`. Tools are `list_records`, `get_record`,
`upsert_record`, `check_record` and `get_audit`. There is no delete tool. Writes
require `supervisor:write`; reads require `supervisor:read`.

A new record requires `expectedRev: 0`; subsequent writes require the current
revision. A conflict returns `rev_conflict` and `currentRev` without mutation or
audit. `upsert_record` shallow-merges the patch and cannot set `checkedAt` or
`lastCheck`. Only `check_record` records a source, result, server timestamp and
verified actor. Audit rows retain from/to revision, source and changed fields.
Client-supplied client IDs never substitute for a verified claim.

Committed mutations increment the store version and send `{type: "changed",
version, ids}` over `/api/ws`. Failed writes send nothing. Clients refetch a full
authenticated snapshot; initial subscription/reconnect invalidation closes the
snapshot/subscription race. Ping/pong uses DO WebSocket auto-response. Reconnect
backoff and stale-version handling are covered by client tests.

Records accept optional `requestedFrom`, an array of `{issuer, sub, email?}` or
`{email}` principals. Subject entries require exact issuer and case-sensitive sub;
their email never overrides a subject mismatch. Email-only entries use validated,
case-normalized email from the verified JWT. Missing/invalid lists never match.
`done`, `paused`, `deferred` and `backlog` suppress current requests.

`/api/data.json` computes `waitingOnYou` for the authenticated viewer and uses
`Cache-Control: private, no-store`. It never stores this projection. The client
uses it for every attention highlight, badge, count, ordering and filter; free
text, headers, URL parameters and local storage cannot select the viewer. Writes
cannot set `waitingOnYou`; read/write capabilities remain independent.

The store starts empty, accepts arbitrary record IDs and uses the stable singleton
key `supervisor-store-v1` in a new namespace. There is no legacy import endpoint,
service-token importer, automatic migration or private register dependency.
