# Sanitized source export and boundary checks

The exporter extends the clean-build proof. It reads an exact Git commit's blobs,
not the index or working tree. `scripts/export-boundary.json` is the reviewed,
exhaustive source-to-destination manifest: sanitized workspace files are included
byte for byte; the generic workflow templates also become
`.github/workflows/ci.yml` and `.github/workflows/boundary.yml`. Legacy runtime, collector, private records,
reports, decisions, owner instructions and private design/runbooks are excluded.
New files require a reviewed manifest change. Only regular text blobs are allowed;
symlinks, submodules, binary artifacts and unknown paths fail the boundary check.
No transformations depend on local state, timestamps, credentials or machine paths.

## Export an exact reviewed revision

Install Bun 1.4.3, Node 22+ and gitleaks **8.30.1**. Use a scratch directory outside
this checkout. Replace the quoted example values with operator-selected absolute paths
and the exact full source commit SHA. Never point a package cache at scratch;
the existing `BUN_INSTALL_CACHE_DIR`, when supplied, passes through unchanged.

```sh
SOURCE_SHA='exact-40-character-reviewed-commit'
SCRATCH='/absolute/scratch/directory'
POLICY='/absolute/protected/policy-outside-the-repository.json'
bun scripts/clean-export.ts --commit "$SOURCE_SHA" --output "$SCRATCH" --policy "$POLICY"
```

The command creates `clean-export-*/repository`, `export.bundle`, `clone`,
`boundary.json` and `verification.json`. It initializes a separate repository with
one parentless commit, exactly `refs/heads/main`, no tags/remotes and fixed reserved
commit identity/date. Each destination blob and executable mode is checked against
the exact source object. The report records every mapping/blob, source SHA, tree,
root commit, file count, ref manifest and scan counts. Repeating the same input
produces the same tree and root commit. No source Git objects or refs are copied.
The bundle clone has its remote removed before commands run in an isolated HOME,
with no inherited credentials, env files or source Git configuration. Frozen
install, empty/sample dev smoke, test, strict typecheck, build, bundle check and
local browser E2E each record their command, output and exit code.

`--skip-proof` omits the build commands only; scanning and bundle clone validation
still run. `bun run clean:proof` selects explicit `--generic` mode for credential-free
CI: it proves structure/secrets/build behavior but **cannot certify the private
identity boundary**. Export defaults to requiring the protected policy. Do not
mistake a generic precheck or an unexecuted owner command for publication approval.

## Existing private repository: paired evidence for the same SHA

Preparation stays in the existing private source repository. The reviewed clean
export is published directly to its final repository (below); there is no
intermediate staging repository. Hosted integration CI checks out
`github.event.pull_request.head.sha` (or `github.sha` on push) and passes that exact
SHA to `clean:proof`. Its log records `Source <sha>`, `Tree <tree-hash>`,
`Root <root-commit>`, `Files <count>` and `Boundary GENERIC ONLY @ <sha>`.
It is a generic precheck only. Never provide a repository secret, protected input
or private policy to CI executing candidate code; do not use `pull_request_target`
for this purpose. The export-only trusted workflow template is inert in this
repository and is not the local protected evidence.

A trusted operator runs the complete check locally from the reviewed exact
revision, with the protected policy outside the repository:

```sh
SOURCE_SHA='exact-40-character-reviewed-commit'
POLICY='/absolute/protected/policy-outside-the-repository.json'
SCRATCH='/absolute/scratch/directory'
bun scripts/clean-export.ts --commit "$SOURCE_SHA" --policy "$POLICY" --output "$SCRATCH"
```

The local log must record `Source <sha>` (source commit), `Tree <tree-hash>`,
`Root <root-commit>`, `Files <count>` and `Boundary complete @ <sha>`.
`verification.json` retains the corresponding `sourceCommit`, `tree`, `rootCommit`,
`fileCount` and `scan.complete: true`, without policy values.

Publication requires **both** a successful hosted generic CI run and a successful
trusted local protected run on the **same source SHA**, with the **same exported
tree hash**. Record the hosted run URL and the local verification artifact; compare
`Source` and `Tree` before publication. Neither evidence substitutes for the other.
A later source change requires both evidences again. Real protected scans remain
operator-run; regression tests use synthetic policies only.

## Exact private policy

The release custodian prepares a JSON policy from the private identity audit and
its cited source files. Keep the policy outside Git and the exported tree. It must
cover every known private name (including substring/inflection roots), internal
domain, real email, account/zone/app/policy/AUD/plugin ID, Slack ID and private URL.
Use `{ "version": 1, "literals": { "A": [...], "D": [...], "C": [...],
"S": [...], "P": [...], "E": [...] } }`, with six nonempty arrays of exact
nonsecret literals. Matching is case insensitive and includes substrings. The
policy itself is scanned for secrets. Missing, malformed or empty-category policy
fails closed; policy values never appear in reports. Coverage/completeness against
the private audit is a custodian review responsibility, not inferred from counts.
No real policy or private source links are shipped in this package.

```sh
node scripts/scan-public-history.mjs --all-refs --policy "$POLICY" --scratch "$SCRATCH" --report "$SCRATCH/boundary.json"
```

The scanner rejects dirty or untracked release content, and empty, shallow, partial, grafted, replaced or alternate-object
repositories. It enumerates all refs, commits and reachable objects (including
detached HEAD), visits every historical tree path/mode, inspects every blob once,
and checks commit/annotated-tag metadata and ref names. Removed content and
other-branch/tag-only objects remain in scope. Generic checks reject non-example
emails, Slack IDs and account-ID shapes, with only specific reserved sample-ID
and product-label exceptions. The exact private policy closes the name/domain/ID
boundary without embedding private values in source. Output contains only object
identity, line and category. Ref identities contain
the zero-based index in ref-name sort order, object SHA (`oid`) and SHA-256 of the
full ref name (`nameDigest`); findings reference that same identity. Reports never
include ref/tag names, paths, messages or content excerpts, including on rejection.
Gitleaks uses pinned defaults plus one synthetic regression
rule; no baseline, ignore file, inline suppression or environment config override
is accepted. It scans all-ref full history and a materialization of current tracked
content. Ignored dependencies, build output and local config are not distributed
inputs. A scanner error/nonzero exit always fails.

The synthetic value in `scripts/test/fixtures/synthetic-secret.txt` is allowed only
by the conjunction of that exact fixture path and exact synthetic pattern. Tests
copy it to an approved product path and prove nonzero gitleaks exits after deletion
from HEAD, on another branch, and from a tag-only commit. Additional tests plant
synthetic denylist markers in historical content, another branch, an annotated tag,
commit metadata and a ref name. No real secret is used.

## Future repository CI and trusted review

The exported checks workflow runs on every push (including tags) and PR. It quietly
initializes/fetches/checks out the exact candidate, suppressing both
Git output streams (including failure diagnostics) before scanning. It fetches all
branches/tags with full history and retains the exact candidate. Frozen root
install/test/typecheck/build/bundle checks, dev smoke, E2E, the fixture failures and
a generic all-ref scan run without the private policy. The source repository's
integration CI remains separate; export-only workflows are inert here as templates.

Before accepting changes, configure the new repository with a protected
`boundary-review` environment whose required reviewers approve only the reviewed
default-branch workflow, and an environment secret `BOUNDARY_POLICY` containing the
custodian policy. Require both `precheck` and the **public-boundary** commit status
in branch protection. The boundary workflow automatically follows every checks run through
`workflow_run`, using the trusted default-branch workflow and the triggering run's
exact head SHA (including fork PRs). Environment reviewers approve that trusted
scan before accepting a candidate. An owner can also run workflow_dispatch
**from the trusted default branch**, supplying an exact candidate SHA, to repeat
the scan before a later visibility review. The trusted job checks out default-branch
scanner/config/manifest code separately, fetches all candidate refs and scans the
candidate as data. It never installs or executes candidate code with the policy.
It posts pending then success/failure for that exact candidate SHA. A missing policy
fails the complete check; generic PR checks cannot satisfy it. Review workflow and
manifest changes on the trusted branch before using them for a candidate scan.

This two-workflow setup keeps untrusted PR code away from protected values.
The trusted job does not download or execute artifacts from the triggering run. Protect
the environment and default branch before storing the policy; a candidate-controlled
workflow must never receive environment approval. Repeat the complete scan with a
fresh recorded ref manifest immediately before any future visibility decision:
a successful scan is a statement about those refs at that time, not future refs.
CI configuration/branch protection and real account validation remain owner steps.

## Owner commands: publish the clean export

These commands are documentation only. Repository creation, credential setup and
the push are owner steps, not performed by the exporter. Publish only a bundle
whose source SHA and tree hash have both evidences above. The destination is the
final publication repository; there is no separate staging repository. Create it
empty, with no initial README, license or ignore file. Its initial private
visibility is only a state of that same repository until the licence decision and
the post-push scans below are complete.
Use only the bundle, never the source checkout, a mirror push or source tags/history.

```sh
NEW_OWNER='owner'
NEW_REPO='repository-name'
BUNDLE='/absolute/path/to/reviewed/export.bundle'
TARGET_PATH='/absolute/new-empty-local-directory'
gh repo create "$NEW_OWNER/$NEW_REPO" --private
git clone --single-branch --branch main "$BUNDLE" "$TARGET_PATH"
cd "$TARGET_PATH"
git remote remove origin
git remote add origin "https://github.com/$NEW_OWNER/$NEW_REPO.git"
git push --set-upstream origin main
```

After the push, install the protected CI policy and required checks as above,
fetch all remote refs and rerun both scans on the pushed `main`. Only then may
the owner change visibility of this same repository to public:

```sh
gh repo edit "$NEW_OWNER/$NEW_REPO" --visibility public --accept-visibility-change-consequences
```

Do not deploy as part of publication. The exported tree carries the root `LICENSE`
from the source; no other license file is generated.

## Provenance and licence

The generic dashboard/Worker and protocol behavior were adapted from an existing
private implementation by its maintainers. The workspace layout uses an external
project as a structural reference; its source, lockfile and history are not copied.
The export retains only reviewed sanitized source and creates fresh Git history.
Dependency names/versions are recorded in the root manifest/lockfile. Dependencies
keep their own licences; review required third-party notices before distribution.

**Repository name and owner** are chosen by the owner and are not recorded in
this package; publication goes directly to that repository as described above.

**Project licence: Apache-2.0.** The root `LICENSE` file holds the unmodified
Apache License 2.0 text, every workspace `package.json` declares
`"license": "Apache-2.0"`, and `LICENSE` is part of the export boundary. No
`NOTICE` file is shipped. The licence choice alone does not confirm source
ownership or approve publication; both remain owner decisions.

**OPEN: independent-account validation.** Login, Managed OAuth, MCP writes and
observed live updates in a separate authorized account belong to the next slice;
no offline test or clean export establishes that evidence.
