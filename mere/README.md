# Mere domain behaviors (draft)

This is the first implementation slice of the design in `jhuntwork/mere-ops`.
The existing `mere-dev`, `mere-shell`, and `mere-pm-dev` packages remain active.

Implemented:

- `@jeremy/mere/source.fetchHash`: stream an HTTPS source to a temporary file,
  compute BLAKE3, atomically publish the downloaded file under its digest, and
  emit a typed artifact resource. A failed stream removes its partial file.
  HTTPS redirects are followed by hand (at most 5, every hop must be HTTPS). A
  per-URL cache is reused only after its bytes are re-hashed and match; a
  corrupted or missing cache entry is downloaded again.
- `_lib/runner.ts`: direct argv subprocess execution with cancellation and a
  timeout, concurrent pipe draining, bounded tails, total byte counts, exit
  code, and elapsed time. `runCommand` returns nonzero exit codes so a method
  can save diagnostics first; `runChecked` throws on a nonzero exit, which is
  the default for methods (design rule: methods throw). Cancellation and
  timeouts reject. Cancellation controls the immediate child, not an entire
  process tree.

- `@jeremy/mere/toolchain`: `provision` installs a mere binary that a prior
  workflow step downloaded and checksum-verified
  (`@svendowideit/github-release-install`), re-verifies its SHA-256 and
  `--version`, and initialises an isolated root (store, config, public key)
  under `.swamp/mere/<name>/`. `status` re-verifies the digest. The version is
  pinned exactly; `latest` is rejected. Provisioning avoids `runModel`, so it
  also works on remote workers.

- `@jeremy/mere/recipe`: `read` parses one recipe, `scan` parses the whole tree
  in one fan-out call (one `recipe-<category>-<name>` resource each, plus a
  `scan` summary with the commit, recipes that needed normalisation, and any
  parse failures). Recipes are KDL v1; all 161 in merelinux parse. Two recipes
  (`bzip2`, `flex`) end a continued list with a backslash before `}`, which
  strict KDL rejects; the parser drops it and records `normalized: true`.
  `ensureCheckout` (default true) clones or updates the checkout through
  `@swamp/git` with `runModel`; set it false on workers and run an
  `ensure_checkout` step first. Nothing is edited yet.

- `@jeremy/mere/recipe-scan` (workflow) and `@jeremy/mere/upstream-drift`
  (report): the workflow parses the tree, then looks up every recipe's latest
  upstream version (inputs `recipeBinding`, default `merelinux`, and
  `sourceBinding`, default `merelinux-upstream`). The report lists recipes
  behind upstream, those that could not be checked and why, parse failures, and
  recipes that needed normalisation. Read-only and token-free; the schedule
  belongs in the ops repo's `serve.yaml`, since a bundled workflow cannot be
  edited. Read it with
  `swamp report get @jeremy/mere/upstream-drift --workflow recipe-scan --markdown`.

- `source.latest` and `source.scanLatest`: newest stable upstream version from
  GitHub tags and releases, else Anitya (matched on the recipe homepage).

Not implemented: recipe editing (`setVersion`), `validate`, `build`, per-recipe
upstream overrides (`upstream.kdl`), the `recipe-bump` workflow, signing-key
handling, serve deployment, and registry publication. This package is not ready
for use.

## Parser conformance

Our recipe parser is separate from mere's, so `integration/conformance_test.ts`
pins it to mere: every recipe in a real merelinux tree, and ~40 mutations of a
valid recipe (missing or repeated fields, unknown nodes, bad values, v2 syntax),
must be accepted or rejected by our parser exactly as `mere dev validate` does.
It already found six differences (optional `url`, required package, repeated
singleton fields, unknown nodes, and so on), now fixed. Run it with `MERE_BIN`
and `MERE_RECIPES_DIR`, or with `MERE_INTEGRATION_NET=1` to download a
checksum-verified mere and clone merelinux itself. It checks accept/reject only;
mere has no structured output for field values yet. Intentional differences go
in `KNOWN_DIVERGENCES`, with a reason.

## Validation

Run with Deno 2:

```sh
deno fmt --check mere
deno lint mere/models
deno test --allow-read --allow-write --allow-run --allow-env mere/models
# real engine, in throwaway swamp repos (needs `swamp` on PATH):
deno test --allow-read --allow-write --allow-run --allow-env mere/integration
# add the network test (downloads mere 0.23.0, provisions it):
MERE_INTEGRATION_NET=1 deno test --allow-read --allow-write --allow-run --allow-env --allow-net mere/integration
```

Tests cover digest correctness, saved bytes, partial-download cleanup, URL
policy, bounded simultaneous subprocess output, literal argv, and cancellation.
The integration suite loads the extension on the real engine and runs methods
through the swamp CLI. Workflow validation is not yet covered.

## Design details to resolve before workflow implementation

- Preserve active per-run worktrees across methods; do not reset edits before
  validation/build.
- Observe PR creation and post-merge CI publication as separate milestones.
- The current cross-behavior API documents `runModel` as unavailable on remote
  workers. Provisioning through nested behavior calls cannot simply move to a
  worker unchanged. See Swamp's extension behavior API, Cross-Behavior Access.
- Preflight checks cannot provision other behaviors; provisioning belongs in
  method execution or an earlier workflow step.
- Scaffold workflow IDs with `swamp workflow create` after authentication is
  available; this draft does not fabricate workflow IDs or YAML.
