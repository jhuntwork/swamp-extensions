# @jeremy/pi-package-validation

A typed Swamp behavior for validating a Pi package at one exact Git commit.
It records the package version, declared npm test result, npm pack file
manifest, deterministic package-content digest, and a bounded native Pi smoke.

The behavior owns validation evidence only. It does not commit, push, publish,
install, deploy, or invoke an arbitrary command supplied by a caller. Package
delivery remains a separate workflow.

## Methods

- `validate` checks the exact commit and clean working tree, runs the package's
  declared `npm test` script, reads `npm pack --dry-run --json`, and hashes the
  sorted packed file paths and bytes into a `sha256:` content digest.
- `native_smoke` checks the same commit and clean tree, then runs Pi with the
  package loaded and expects the fixed marker
  `PI-PACKAGE-NATIVE-SMOKE-OK`. It never stores the prompt or response.

The behavior bounds subprocess time, captured output, pack-file count, and
failure details. It redacts common token and credential forms in diagnostics.
The `npm` and `pi` executable settings accept only those executable identities,
not arbitrary shell commands or argument vectors.

## Example

```sh
swamp extension pull @jeremy/pi-package-validation
swamp behavior create @jeremy/pi-package-validation kiro-package \
  --global-arg packageRoot=/path/to/pi-kiro-native
swamp behavior run kiro-package validate \
  --input expectedCommit=<40-character-commit>
swamp behavior run kiro-package native_smoke \
  --input expectedCommit=<40-character-commit>
```

The expected commit must come from the typed Git operation that prepared the
attempt-owned checkout. The behavior refuses a dirty checkout or a mismatched
HEAD, so its evidence cannot be attached to another source tree accidentally.

## Evidence shape

The behavior records bounded, machine-readable evidence rather than command
transcripts:

```json
{
  "expectedCommit": "<40-character-commit>",
  "packageVersion": "1.2.3",
  "artifactDigest": "sha256:<64-hex-digits>",
  "status": "passed"
}
```

The native smoke records only the fixed marker, status, commit binding, timing,
and sanitized failure detail. It never stores the prompt or provider response.