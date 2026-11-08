# `@jeremy/mere-stagecraft`

`@jeremy/mere-stagecraft` adapts GitHub Issues to the Mere Stagecraft tracker
contract. It supplies idempotent issue fetch, create, comment, status, type,
and relation operations, plus a read-only preflight check. The adapter is an
extension of the `@webframp/github` behavior type.

The adapter invokes the authenticated `gh` executable for GitHub API access.
Authenticate with `gh auth login` before running it. Each subprocess is limited
to 2 MiB of output and 30 seconds, and an aborted operation terminates the
subprocess. Relation state is stored as Swamp data. GitHub labels are projected
into Stagecraft status names, while issue types and relation constraints are
kept in the adapter's contract.

## Install and configure

Pull the extension, create a named GitHub tracker behavior, configure its
repository, and run the read-only checks. `preflight` verifies repository access
and reports available status labels; `describe` writes the contract metadata
that Stagecraft uses for validation.

```sh
swamp extension pull @jeremy/mere-stagecraft
swamp behavior run @webframp/github configure merelinux-github \
  --input repo=merelinux/mere
swamp behavior run merelinux-github preflight \
  --input repo=merelinux/mere
swamp behavior run merelinux-github describe
```

The tracker behavior accepts an explicit `repo` in each operation request or
uses the repository saved by `configure`. The `operate` method accepts
`fetch_issue`, `create`, `comment`, `set_status`, `set_type`, `relate`, and
`unrelate`; create and comment requests receive deterministic idempotency keys
when the caller does not provide one.

## Bind it to Stagecraft

Stagecraft's publisher binds a publisher behavior to the configured tracker
instance. In the Mere operations repository, the checked-in binding is
`models/@swamp/stagecraft/publisher/github-publisher.yaml`:

```yaml
type: '@swamp/stagecraft/publisher'
typeVersion: 2026.10.12.1
id: dc91ca51-eaeb-4e8f-b004-add3b1cad74e
name: github-publisher
version: 1
tags: {}
globalArguments:
  tracker: merelinux-github
  statuses: >-
    {"open":"open","in_progress":"status:in-progress","shipped":"status:done","closed":"closed"}
methods: {}
```

Run `describe` on the tracker before validating the publisher. The publisher's
`tracker` global argument names `merelinux-github`, and `statuses` maps each
Stagecraft status key to the GitHub status label returned by this adapter.
Point a Stagecraft factory at `github-publisher`, then validate the factory
before running its workflows. Keep GitHub credentials in `gh`'s credential
store rather than in the behavior definition or this README.

## Development

The package includes unit tests for the adapter contract and idempotent answer
handling. Run them with the Deno executable supplied by your Swamp install:

```sh
deno fmt --check github_tracker.ts github_tracker_test.ts
deno lint github_tracker.ts github_tracker_test.ts
deno test --allow-read --allow-write --allow-run --allow-env \
  github_tracker_test.ts
```

The package is source-controlled here and is not published by this repository
change. A fresh tracker conformance run against a running Mere operations
server remains an integration check outside the package's unit tests.
