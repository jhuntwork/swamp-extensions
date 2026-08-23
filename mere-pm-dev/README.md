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

Results use distinct stable resource specs and matching instance identities:
`build-result`, `test-result`, `baseline-build-result`, and `smoke-result`.
Composed workflows should retrieve them by `specName` and read the payload under
`.attributes`; they must not infer result type from invocation order.

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

## Mere delivery workflows

This package distributes an explicit two-phase delivery path:

1. `@jeremy/mere-change-prepare` clones `main`, creates a fresh branch at the
   supplied immutable `baseSha`, and stops. Implement the agreed scoped change
   in that isolated candidate.
2. `@jeremy/mere-change` accepts that candidate, runs this model's full test,
   portable baseline build, and `describe` smoke profile, stages only
   `allowedPaths`, pushes a non-force branch, and creates/validates a change
   packet and matching same-repository pull request.

The separation is functional, not an approval pause: it gives implementation a
real candidate worktree while keeping the delivery run bound to its validation,
commit, push, evidence, and PR operations. `@jeremy/mere-change-prepare` has
no commit, push, pull-request, or credential-bearing binding.

Neither workflow carries credentials or local model instances. Each creates
disposable `@jeremy/mere-pm-dev` validation and `@jeremy/change-packet`
evidence models as needed. A workspace supplies only `prModel` to the delivery
workflow: a vault-backed `@jeremy/github-pr` instance bound to
`jhuntwork/mere`.

The pull request is the review gate. The delivery workflow does not merge,
release, administer the repository, or edit a pull request. It is deliberately
for a new branch from `main`; a follow-up to an already-open pull request
remains a separate continuation task until that repeated need earns a second
workflow.
