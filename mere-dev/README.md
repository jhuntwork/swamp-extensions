# @jeremy/mere-dev

Mere recipe development workflow: build recipes, hash sources, and read build logs.
Invokes `mere` directly without a shell wrapper — separate from `@jeremy/mere-shell`
which is for ad-hoc commands in a namespace.

## Why separate from mere-shell?

`mere dev build` manages its own user namespace and build profile internally.
Wrapping it inside `mere shell` (which creates its own namespace) produces nested
namespaces that conflict. This extension calls the mere binary directly for
development commands.

## Methods

### build

Build a recipe. Returns exit code, stdout/stderr, and the resolved `mereRoot` path
for post-mortem inspection.

```sh
swamp model method run mere-dev build \
  --arg recipe="/path/to/recipes/core/dinit/recipe.kdl"
```

### hash

Compute the blake3 hash of a local file or URL. Downloads URLs automatically.

```sh
swamp model method run mere-dev hash \
  --arg source="https://github.com/davmac314/dinit/releases/download/v0.22.1/dinit-0.22.1.tar.xz"
```

### devLog

Read the most recent build log from the dev workspace. Useful after a failed build.

```sh
swamp model method run mere-dev devLog --arg recipe="dinit" --arg tail=50
```

## Global arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `mereVersion` | `"latest"` | Mere version to use. Resolves from Codeberg releases API. |
| `mereBinaryPath` | `""` | Optional existing Mere binary; when set, skips download and runs that exact binary. |
| `mereRoot` | auto | Dedicated root path. Defaults to `$SWAMP_REPO_DIR/.swamp/mere-dev/root`. |

## How it works

1. Downloads the mere binary (cached by version)
2. Initializes a dedicated root with store, config, and signing keys
3. Runs `mere --root <root> dev build <recipe>` directly
4. Captures stdout/stderr and returns structured results
