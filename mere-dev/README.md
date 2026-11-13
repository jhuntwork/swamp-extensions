# @jeremy/mere-dev

Everything for working on MereLinux recipes. One extension, three behaviors:

| Behavior | What it does |
| --- | --- |
| `@jeremy/mere-dev` | Runs `mere dev` on a recipe: `validate`, `build`, `importOutputs`, `hash`, and the signing-key and build-log helpers. Downloads and checksums `mere` itself. |
| `@jeremy/mere-dev/recipes` | Reads the recipe tree: `scan`, `read`, and the edits a version bump needs (`setVersion`, `bumpRelease`, `workspace`, `cleanWorktree`, `dependents`, `recordReviewNotes`, `summarize`). It never runs `mere`. |
| `@jeremy/mere-dev/source` | Looks up the newest upstream version of each recipe (GitHub tags and releases, then Anitya), and downloads and hashes sources for a bump. |

Four workflows use them: `recipe-scan` (parse every recipe and report which are
behind upstream), `recipe-bump` and `recipe-rebuild` (change one recipe, build it,
and hand the change to `@jeremy/mere-delivery`), and `merelinux-change` (the
same path for a change you implemented yourself).

`@jeremy/mere-shell` runs the installed-package smoke test. `mere dev build`
manages its own namespace, so building inside `mere shell` would nest namespaces
and conflict; that is why the build commands here run `mere` directly.

## Failure behavior

`validate`, `build`, and `importOutputs` record their result and then **fail the
method** when `mere` fails, so a workflow step stops at the first problem and no
separate assert step is needed. The record is kept either way. `build` also
fails when it succeeds but exports no packages, and it clears earlier exports
of the same recipe first so a stale export cannot pass for this one.

A failed build records `failingPhase` and `errorLine` (mere's first error), the
last 60 lines of output, and the build log as a file.

## Methods

### build

Build a recipe from a checkout or per-run worktree. `recipe` is
`<category>/<name>` and `checkoutPath` is the absolute path of the tree that
holds `recipes/<category>/<name>/recipe.kdl`.

```sh
swamp model method run mere-dev build \
  --input recipe=core/dinit \
  --input checkoutPath=/home/user/work/merelinux
```

The `build-result` record holds the package archives (file name, package,
content id, sha256, size), the exported directory's arch suffix (`x86_64`,
`any`, or `unknown` for a recipe with no `archs` line), the duration, and on
failure the failing phase and error line. `noCache` (default true) passes
`--no-cache`, as CI does.

### validate and importOutputs

`validate` runs `mere dev validate` against a recipe without building it (same `recipe` and `checkoutPath` arguments as `build`). `importOutputs` explicitly signs and imports archives already produced in this workflow's dedicated root into its named local development repository. Together with `@jeremy/mere-shell` pointed at the same root, they support the Mere recipe contribution path without installing anything into the host profile.

```sh
swamp model method run mere-dev validate \
  --input recipe=extra/fd --input checkoutPath=/home/user/work/merelinux
swamp model method run mere-dev importOutputs --input repository=local
```

### hash

`hash` returns the canonical BLAKE3 digest separately from the source path. It accepts either the normal `digest  path` output or digest-only output from `mere dev hash`.

```sh
swamp model method run mere-dev hash \
  --arg source="https://github.com/davmac314/dinit/releases/download/v0.22.1/dinit-0.22.1.tar.xz"
```

### keyStatus and generateSigningKey

`keyStatus` checks the standard development signing-key path (`~/.mere/keys/mere.key`) without reading or exposing key material. `build` performs this same preflight before starting a costly recipe build. If absent, it returns the path and the exact `mere dev key generate` remediation instead of misreporting a package-cache filesystem failure.

`generateSigningKey` is deliberately separate and explicit: it creates an Ed25519 private key at that standard path only when it is absent. Use it only after approving creation of local signing material.

```sh
swamp model method run mere-dev keyStatus
swamp model method run mere-dev generateSigningKey
```

### devLog

Read the most recent build log from the dev workspace. Useful after a failed build.

```sh
swamp model method run mere-dev devLog --arg recipe="dinit" --arg tail=50
```

`mereBinaryPath` is useful when the exact Mere version is a local build that has not been released yet:

```sh
swamp model create @jeremy/mere-dev mere-local \
  --global-arg mereVersion=0.18.6 \
  --global-arg mereBinaryPath=/path/to/mere \
  --global-arg mereRoot=/tmp/mere-dev-root
```
## Global arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `mereVersion` | `"latest"` | Mere version to use. Resolves from the GitHub releases API. |
| `mereBinaryPath` | `""` | Optional existing Mere binary; when set, skips download and runs that exact binary. |
| `mereRoot` | auto | Dedicated root path. Defaults to `$SWAMP_REPO_DIR/.swamp/mere-dev/root`. |

## Scanning for updates

`recipe-scan` parses every recipe and looks up each one's newest upstream
version. It needs no token and changes nothing, so it can run on a schedule.

```sh
swamp model create @jeremy/mere-dev/recipes merelinux
swamp model create @jeremy/mere-dev/source merelinux-upstream
swamp workflow run @jeremy/mere-dev/recipe-scan
swamp report get @jeremy/mere-dev/upstream-drift \
  --workflow @jeremy/mere-dev/recipe-scan --markdown
```

## Bumping and rebuilding

`recipe-bump` picks the target version (the newest in the recipe's current
series unless you pass `version`), downloads and hashes the new sources, edits
the recipe in a per-run worktree, validates, builds, imports the outputs into an
isolated repository, runs an exact-argv smoke test in `@jeremy/mere-shell`,
pauses for review notes, writes the pull-request text from recorded data, and
calls
`@jeremy/mere-delivery/deliver-change`. Create a `@jeremy/mere-dev` binding
(`merelinux-recipe-validation`), an `@jeremy/mere-shell` binding
(`merelinux-recipe-smoke`) that shares its root and version, and a
`@jeremy/github-pr` binding (`merelinux-pr`).

```sh
swamp workflow run @jeremy/mere-dev/recipe-bump \
  --input recipe=core/inih \
  --input 'smokePackages:json=["inih"]' \
  --input 'smokeArgv:json=["true"]'
```

After the smoke test, `recipe-bump` suspends at `approve-review-notes`. Whoever
is driving the run reads the upstream changelog in the source archive (under
`.swamp/mere/downloads`, named by the `blake3After` of the recorded change) and
runs `recordReviewNotes` with the file's path in the archive and the entries a
reviewer needs. Each entry is a quote with the release it comes from. The
method extracts the file from the archive the build used and refuses an entry
that is not in it, comparing with whitespace collapsed and nothing else, so a
reworded entry fails. It also refuses an entry with an `@mention`, a `#number`
or a code fence, which would notify a stranger or link an unrelated issue.
`summarize` puts the entries, grouped by release, at the top of the pull request
body, followed by the release link. Approve the step and resume the run.
`--input reviewNotes=false` skips the pause for an unattended run, and the body
is then only the upstream release link. The markdown body needs a profile that
allows it; `merelinux` does.

`recipe-rebuild` increments a recipe's release number and rebuilds it; you must
give a `reason`, which becomes the pull-request body.

## Packaged `merelinux-change` workflow

The package includes the canonical end-to-end workflow for publishable changes
to `github.com/jhuntwork/merelinux`. It prepares a fresh branch from an explicit
main commit, suspends for scoped implementation, and then requires this complete
recipe contribution path before review delivery:

1. validate the selected `recipe.kdl`;
2. build it in Mere's isolated build environment;
3. import the built outputs into a named local repository;
4. install an explicit package set into an isolated `@jeremy/mere-shell` profile;
5. run an exact argv smoke check without shell interpretation;
6. commit only approved paths, push without force,
   and create and read back a pull request.

The workflow intentionally packages no model instances, repository credentials,
or vault values. Before running it, create:

- an `@jeremy/mere-dev` binding (default name `merelinux-recipe-validation`);
- an `@jeremy/mere-shell` binding (default name `merelinux-recipe-smoke`) using
  the same `mereRoot` and Mere version; pin both bindings when reproducibility is
  required, while `latest` resolves from the same hosted GitHub release source;
- an `@jeremy/github-pr` binding (default name `merelinux-pr`) scoped to
  `jhuntwork/merelinux` and the operator's vault credential.

The installed workflow verifies that the development and smoke bindings actually
reported the same root and Mere version. Alternative binding names can be passed
through `devModel`, `shellModel`, and `prModel` workflow inputs.

## How it works

1. Downloads the mere binary (cached by version)
2. Initializes a dedicated root with store, config, and repository public keys
3. Preflights the user-owned development signing key at `~/.mere/keys/mere.key` when signing is required
4. Validates/builds recipes and can import the resulting archives into an isolated local repository
5. Captures stdout/stderr and returns structured results

The build root is isolated, but Mere's development signing key is intentionally user-owned rather than silently generated by a build.
