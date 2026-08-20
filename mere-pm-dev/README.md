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
