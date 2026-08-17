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
| `useHostStore` | `false` | If true, symlinks host `/mere/store` into the dedicated root for cache hits |

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
