# @jeremy/mere-shell

Execute commands inside a [Mere Linux](https://merelinux.org) shell namespace
with isolated package sets. Downloads a fresh `mere` binary per version,
operates in a dedicated root (separate from the host's `/mere`), and captures
structured output.

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
  --input 'command=zig build test --summary all' \
  --input 'workdir=/home/user/project'
```

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
| `command` | string | Command that was executed |
| `success` | boolean | True if exitCode === 0 |
| `error` | string? | Error message if setup failed |

## Global arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `mereVersion` | `"latest"` | Mere version to use (`latest` or pinned like `0.15.2`) |
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
        command: "zig build test --summary all"
        workdir: "/home/user/project"
```

## License

MIT
