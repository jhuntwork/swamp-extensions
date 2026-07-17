# swamp-extensions

Personal [swamp](https://github.com/swamp-club/swamp) extensions.

## @jeremy/mere-pkgd-harness

A local integration-test harness for the [Mere Linux](https://codeberg.org/merelinux) `mere` <-> `pkgd` package-publish pipeline.

Builds `mere` and `pkgd` from local branch checkouts, runs `pkgd` as a real background process against scratch directories, publishes a real signed test package to it over its actual HTTP `/publish` endpoint, and verifies the result — all without touching the real `/mere/store` or `/mere/dev/repo` on the host.

### Methods

- `build` — compile `mere` (`zig build`) and `pkgd` (`go build`) from their local checkouts
- `start` — generate a throwaway signing key and start `pkgd` against fresh scratch directories
- `publish_test_package` — build one real signed test package via `mere dev build` and POST it to the running `pkgd` instance
- `verify_published` — confirm the package landed in the published `repo.db`
- `stop` — kill the `pkgd` instance and remove all scratch directories

### Usage

```bash
swamp extension pull @jeremy/mere-pkgd-harness
swamp model create @jeremy/mere-pkgd-harness dry-run \
  --global-arg mereRepoPath=/path/to/mere \
  --global-arg pkgdRepoPath=/path/to/pkgd \
  --global-arg scratchDir=/tmp/mere-pkgd-dry-run

swamp model method run dry-run build
swamp model method run dry-run start
swamp model method run dry-run publish_test_package --input '{"recipePath":"/path/to/some/recipe.kdl"}'
swamp model method run dry-run verify_published --input '{"packageName":"some-package"}'
swamp model method run dry-run stop
```

### Why this exists

`pkgd` is the Go service that receives new-package publishes for
[Mere Linux](https://codeberg.org/merelinux) and shells out to `mere` for
the actual (atomic, locked) repo-database mutation. Before trusting a
change to either binary, it's worth proving the whole chain still works
end to end — build, publish over real HTTP, and confirm the package
actually landed — without ever touching the real system's package store.
Running that by hand is a dozen fiddly steps (generate a throwaway key,
wire up scratch directories, start a background process, clean up after).
This extension turns it into five typed methods.

### As a workflow

Chain the five methods into one repeatable `swamp workflow run` instead of
five separate `swamp model method run` calls — re-run it any time `mere` or
`pkgd`'s publish path changes:

```yaml
jobs:
  - name: main
    steps:
      - name: build
        task: { type: model_method, modelIdOrName: dry-run, methodName: build }
      - name: start
        task: { type: model_method, modelIdOrName: dry-run, methodName: start }
        dependsOn: [{ step: build, condition: { type: succeeded } }]
      - name: publish
        task:
          type: model_method
          modelIdOrName: dry-run
          methodName: publish_test_package
          inputs: { recipePath: "/path/to/some/recipe.kdl" }
        dependsOn: [{ step: start, condition: { type: succeeded } }]
      - name: verify
        task:
          type: model_method
          modelIdOrName: dry-run
          methodName: verify_published
          inputs: { packageName: "some-package" }
        dependsOn: [{ step: publish, condition: { type: succeeded } }]
      - name: stop
        task: { type: model_method, modelIdOrName: dry-run, methodName: stop }
        dependsOn: [{ step: verify, condition: { type: always } }]
        allowFailure: true
```
