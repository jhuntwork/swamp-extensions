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

Not implemented: toolchain provisioning, recipe parsing/editing/building,
upstream version discovery, workflows, reports, signing-key handling, bindings,
serve deployment, and registry publication. This package is not ready for use.

## Validation

Run with Deno 2:

```sh
deno fmt --check mere
deno lint mere/models
deno test --allow-read --allow-write --allow-run mere/models
```

Tests cover digest correctness, saved bytes, partial-download cleanup, URL
policy, bounded simultaneous subprocess output, literal argv, and cancellation.
Swamp extension loading and full workflow validation require authenticated CLI
access and have not been performed.

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
