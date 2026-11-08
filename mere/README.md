# Mere domain behaviors (phase 2)

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
  `swamp report get @jeremy/mere/upstream-drift --workflow @jeremy/mere/recipe-scan --markdown`.

- `@jeremy/mere/ci`: observe GitHub Actions runs for an exact commit, wait until
  a run completes, and dispatch the Merelinux build workflow. It uses the
  authenticated `gh` CLI without copying a token into data or arguments; final
  non-success conclusions are recorded before the method throws.

- `@jeremy/mere/recipe-rebuild` increments one recipe's release number in an
  isolated worktree, validates and rebuilds it with mere, then delegates scoped
  delivery to `deliver-change`. It never changes the source version or source
  hashes.

- `@jeremy/mere/tree`: fixed-argv `fmtCheck`, `build`, `test`, `releaseBuild`,
  and `smoke` methods for an isolated Mere source tree. Every source path is
  realpath-checked under the repository's `.swamp/mere` directory, subprocess
  output is bounded, and unsuccessful commands fail the method.

- `@jeremy/mere/build-summary`: workflow report for recipe build outcomes,
  package outputs, durations, and failure phases.

- `@jeremy/mere/model-cost`: workflow report for `@swamp/agent-runner` `run` and
  `review` steps. It preserves missing provider usage as "not reported", records
  model, provider, effort, outcome, tokens, cost and durations, and aggregates
  totals by model within the workflow.

- `@jeremy/mere/mere-change`: source-tree validation followed by the shared
  delivery workflow. The pull request is the review surface; merge remains
  manual. `deliver-change` computes its GitHub change digest and readiness
  inside `@jeremy/github-pr`; the obsolete `@jeremy/change-packet` path is no
  longer required.

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
deno lint mere
deno test --allow-read --allow-write --allow-run --allow-env mere/models
# real engine, in throwaway swamp repos (needs `swamp` on PATH):
deno test --allow-read --allow-write --allow-run --allow-env mere/integration
# add the network test (downloads mere 0.23.0, provisions it):
MERE_INTEGRATION_NET=1 deno test --allow-read --allow-write --allow-run --allow-env --allow-net mere/integration
```

The extension manifest and registry archive can be checked from the package
directory:

```sh
cd mere
swamp extension fmt manifest.yaml --check --json
swamp extension push manifest.yaml --dry-run --json
```

The integration suite loads the extension on the real engine and runs methods
through the swamp CLI. The `mere-change` workflow has also run against a real
Mere checkout and delivered PR #88. The CI behavior's parsing and cancellation
boundaries have unit coverage; the GitHub Actions calls remain live-environment
checks.

## Remaining follow-up

- Keep the post-merge CI workflow available for manual exact-commit runs;
  webhook ingress remains dormant until an endpoint is chosen.
- Complete persistent `swamp serve` deployment and restart behavior.
- Preserve active per-run worktrees across methods; do not reset edits before
  validation/build.

- The current cross-behavior API documents `runModel` as unavailable on remote
  workers. Provisioning through nested behavior calls cannot simply move to a
  worker unchanged. See Swamp's extension behavior API, Cross-Behavior Access.
- Preflight checks cannot provision other behaviors; provisioning belongs in
  method execution or an earlier workflow step.
- Add `importOutputs`, signing-key handling, CI observation, and serve
  deployment in the next phase.
