# Offline build and compatibility

Install Bun 1.4.3 and Node 22 or newer, then run the root commands in README.
No Cloudflare credentials, Python, register, inventories or Git history are needed
by install/dev/test/typecheck/build. Installation and first SST SDK generation
can download pinned dependencies; "offline" here means no account/provisioning
operation. Development and verification use local Miniflare only.

## SST/provider evidence

The own root lockfile pins SST 4.17.1, `@pulumi/cloudflare` 6.24.0 and
`@pulumi/pulumi` 3.277.0. Root provider configuration pins Cloudflare 6.24.0 too.
A local unmodified-SDK typecheck with provider 6.19.0, 6.23.0 and 6.24.0 produced
three upstream diagnostics each: two `normalizeCompatibility` argument errors
(Worker and SSR site), and an optional bindings spread in StaticSite. The required
Worker migrations, Managed OAuth DCR callback options and alternate URL control
all typecheck with 6.24.0. Downgrading the provider does not fix those diagnostics.

`scripts/prepare-sst.ts` first generates the local SDK using `sst install`.
It then applies two narrow, checksum-verified local source corrections listed in
`scripts/sst-compatibility.json`: use the provider's actual optional compatibility
property types; treat absent StaticSite bindings as an empty list. Both old/new
whole-file SHA-256 hashes are checked, patches are idempotent, and an unexpected
SDK source fails closed. These changes affect only ignored `.sst/platform` files;
no shared package-cache file is changed. No provider or SST version floats.
`typecheck` then fails on any diagnostic in repository sources and checked upstream
SDK sources. Third-party declaration files (.d.ts) are not checked (`skipLibCheck`).
`infra/compatibility.ts` compiles the required API surface
against the actual SST/provider declarations. This is local compatibility evidence,
not a deployment/resource-graph proof. The root `run` refuses provisioning in this
slice. SST's [Worker API](https://sst.dev/docs/component/cloudflare/worker/) and
[configuration API](https://sst.dev/docs/reference/config/) describe the eventual
boundary; the installed exact versions are the local typecheck authority.

## Typecheck scope

`bun run typecheck` checks core/Worker, tooling and root/infra TypeScript sources
with `strict: true`, and browser JavaScript with `checkJs`. Browser ambient types
live in a type-only `.ts` module, so they are checked as source too; there are no
repository-owned `.d.ts` files. All diagnostics from these programs fail the gate.

`skipLibCheck` stays enabled for upstream declaration files only. The installed
dependencies contain duplicate `@types/node` trees at the root and under
`.sst/platform`, alongside SST-generated declarations and bun-types/TypeScript
library declarations that conflict when checked together. After the normal gate
has generated the pinned SDK, reproduce those upstream-only diagnostics with:

```sh
bunx --no-install tsc -p tsconfig.infra.json --skipLibCheck false
```

This declaration-checking limitation does not exclude repository sources or the
upstream SDK `.ts` sources reached by the infra program.

## Export proof

`bun run clean:proof` exports exact committed source using the reviewed file
manifest, creates fresh root history and a bundle, then runs all root checks in
a credential-free bundle clone. This explicit generic precheck does not certify
the private identity boundary. See [the export guide](export.md) for complete
protected checks, deterministic hashes, fixture proofs and owner-only commands.
The supplied shared `BUN_INSTALL_CACHE_DIR` is preserved unchanged.

The production bundle check verifies asset membership, esbuild source inputs and
forbidden test-auth/sample markers. Only UI source is embedded; even sample records
are excluded. Identity projections and complete English/Czech dictionaries are covered by
unit and desktop/mobile tests. Real provisioning/account validation and public readiness remain later owner steps.
