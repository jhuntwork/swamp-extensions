# @jeremy/mere-pm-dev

`@jeremy/mere-pm-dev` develops the **Mere package manager itself** from an
explicit source checkout or isolated worktree. It is separate from:

- `@jeremy/mere-dev`, which develops Mere recipes and package outputs;
- `@jeremy/mere-shell`, which executes typed commands inside a verified Mere
  shell namespace.

This model deliberately has no release acquisition, package-root management,
recipe build, signing, import, push, or publishing authority. It invokes only
fixed Zig command vectors in the configured source tree.

## Create a model

```sh
swamp model create @jeremy/mere-pm-dev mere-pm-validation
```

`sourcePath` is supplied to every method. It must name an explicit directory
containing both `build.zig` and `build.zig.zon`; this keeps validation bound to
the isolated worktree created for a workflow run.

## Methods

| Method         | Fixed argv                                         | Purpose                                            |
| -------------- | -------------------------------------------------- | -------------------------------------------------- |
| `build`        | `zig build`                                        | Build the package-manager executable.              |
| `test`         | `zig build test --summary all`                     | Run the full source-tree test suite.               |
| `releaseBuild` | `zig build -Doptimize=ReleaseSmall -Dcpu=baseline` | Build a portable release candidate.                |
| `smoke`        | `./zig-out/bin/mere describe`                      | Exercise the built CLI's machine-readable surface. |

Each result retains exact argv, source path, exit code, bounded stdout/stderr,
truncation state, duration, success state, and, for build methods, the expected
binary path. `releaseBuild` additionally records `baseline: true`.

## Suggested release validation

```sh
swamp model method run mere-pm-validation test \
  --input sourcePath=/path/to/mere-worktree
swamp model method run mere-pm-validation releaseBuild \
  --input sourcePath=/path/to/mere-worktree
swamp model method run mere-pm-validation smoke \
  --input sourcePath=/path/to/mere-worktree
```

A successful `releaseBuild` proves the candidate was compiled through the
portable baseline path; it does not publish an artifact or create a release.

## `@jeremy/mere-change` workflow

This package also distributes `mere-change.yaml`, the Mere-specific workflow
for a fresh `main` branch through a reviewable pull request. It creates an
isolated clone at the supplied `baseSha`, runs this model's full test, portable
baseline build, and `describe` smoke profile, stages only `allowedPaths`,
pushes a non-force branch, and creates/validates a change packet and matching
same-repository pull request.

The workflow carries **no credentials or model instances**. It creates disposable
`@jeremy/mere-pm-dev` validation and `@jeremy/change-packet` evidence models
for each run. A workspace supplies only `prModel`: a vault-backed
`@jeremy/github-pr` instance bound to `jhuntwork/mere`.

The pull request is the review gate. The workflow does not merge, release,
administer the repository, or edit a pull request. It is deliberately for a
new branch from `main`; a follow-up to an already-open pull request remains a
separate continuation task until that repeated need earns a second workflow.
