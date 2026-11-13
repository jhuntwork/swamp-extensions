# @jeremy/mere-shell

Execute typed commands inside a [Mere Linux](https://merelinux.org) shell namespace
with isolated package sets. The extension verifies a downloaded Mere binary
against its release `SHA256SUMS` manifest (or an explicit SHA-256 pin),
propagates model cancellation to every subprocess, and captures structured
output.

Useful for reproducible build verification, recipe testing, and running tools
that require Mere's package ecosystem without polluting the host system.

## Install

```bash
swamp extension pull @jeremy/mere-shell
```

## Create a model instance

```bash
swamp model create @jeremy/mere-shell my-mere-shell
```

With a pinned version:

```bash
swamp model create @jeremy/mere-shell my-mere-shell \
  --global-arg 'mereVersion=0.15.2'
```

## Run a command

```bash
swamp model method run my-mere-shell run \
  --input 'packages=["zig","cmake"]' \
  --input 'argv=["zig","build","test","--summary","all"]' \
  --input 'workdir=/home/user/project'
```

`workdir` must be an absolute path under `/home`, `/var`, or `/run`. Those are the
host directories `mere shell` shares into the namespace; `/tmp` inside it is a
fresh private tmpfs, so a worktree in `/tmp` does not exist there. The run is
refused before any download, naming the directories that work. Symlinks are
resolved first, so a link into `/tmp` is refused too.

## Upgrading from command strings

Version `2026.08.17.1` replaces the required `command` string with exact
`argv`. This is intentional: a string cannot preserve argument boundaries and
made quoted arguments, paths containing spaces, and cancellation behavior
ambiguous. Replace, for example:

```text
command="zig build test --summary all"
```

with:

```text
argv=["zig", "build", "test", "--summary", "all"]
```

Older callers that continue to send `command` will be rejected by this version.

## Output

The `result` resource contains:

| Field | Type | Description |
|-------|------|-------------|
| `exitCode` | number | Process exit code |
| `stdout` | string | Standard output (truncated at 1MB) |
| `stderr` | string | Standard error (truncated at 1MB) |
| `durationMs` | number | Wall-clock execution time |
| `mereVersion` | string | Actual mere version used |
| `packages` | string[] | Packages installed in the shell |
| `argv` | string[] | Exact argv to run; `argv[0]` is the executable. |
| `success` | boolean | True when the command exits successfully. |
| `error` | string? | Error message if setup failed |

## Global arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `mereVersion` | `"latest"` | Mere version to use (`latest` or a pin such as `0.18.2`) |
| `mereSHA256` | `""` | Optional 64-character SHA-256 pin for the selected architecture binary; otherwise release `SHA256SUMS` is used. |
| `mereRoot` | `""` | Dedicated root path (empty = auto: `$SWAMP_REPO_DIR/.swamp/mere-shell/root`) |
| `useHostStore` | `false` | Use the host Mere root (`/`) and share its `/mere/store`; `mereRoot` must be empty or `/`. |

`useHostStore=true` selects `mereRoot=/` and does not create a symlink. Mere 0.23 defines
`--root PATH` as the physical location of `PATH/mere`, then bind-mounts that directory
as `/mere` inside `mere shell`. Therefore `--root /` exposes the existing host
`/mere/store` directly at `/mere/store`. The host root must already be initialized
and accessible to the invoking user. Do not combine `useHostStore=true` with a
separate `mereRoot` path. The default (`useHostStore=false`) keeps a real,
repo-local `${mereRoot}/mere/store`; legacy roots containing the old self-referential
store symlink are repaired on the next run.

## Use in workflows

```yaml
steps:
  - name: build-test
    task:
      type: model_method
      modelIdOrName: my-mere-shell
      methodName: run
      inputs:
        packages: '["zig"]'
        argv: '["zig", "build", "test", "--summary", "all"]'
        workdir: "/home/user/project"
```

## License

MIT
