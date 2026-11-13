# @jeremy/github-pr

A deliberately narrow GitHub.com model for one bound repository and base branch.
It verifies a slim change description (or reads a legacy Change Packet Protocol
v1 packet during migration), produces a PR plan, creates or recognizes a
matching pull request after workflow approval, and reads it back to verify its
identity. The slim path computes the canonical digest and readiness inside this
adapter.

It does not merge, release, update PRs, mark them ready, administer
repositories, or call arbitrary GitHub endpoints.

## Authentication

The adapter supports two authentication modes:

- `token` is the default and uses a sensitive vault-backed GitHub token. This
  preserves the original behavior for existing definitions.
- `gh` uses the active `gh` CLI login. The CLI token is never copied into Swamp
  arguments or data. The `gh` binary is invoked directly with an argument array,
  without a shell.

The model still checks `expectedActor` against GitHub's authenticated `/user`
result in either mode. Run `gh auth status` first and bind the model to the
active account's login when using `authMode=gh`.

## Draft is requested per change

An ordinary reviewable pull request is the default. A change may set
`submission.draft` when a draft is genuinely wanted, and the plan records which
was asked for, so the state a human approved is the state that gets created.
`applyPr` refuses a plan whose draft state disagrees with the change, and
`verifyPr` reads the state back rather than assuming either value.

This replaces `@jeremy/github-draft-pr`, which required every submission to be a
draft.

## PR description contract

By default every submission must have one concise, maintainer-facing paragraph
of at most 2,000 characters. The adapter rejects empty or multi-paragraph
bodies, headings, lists, code fences, and pipeline, automation, or test-status
boilerplate. The diff and pipeline results remain the source of truth for
implementation details and checks.

A delivery profile may opt into `submission.descriptionStyle: markdown`. That
style also allows blank lines and lists, up to 4,000 characters, so quoted
upstream release notes stay readable. Headings and code fences are refused in
both styles, and so is the boilerplate. A packet that does not set the field
gets the default.

`checkDescription` applies the same rule to a body on its own, with no GitHub
access, so a workflow can reject a bad body before it commits or pushes.


Use this model at the end of a repository-owned workflow:

```text
proposal → branch → implementation → validation → scoped commit → push
→ change facts → planPr (digest/readiness) → manual approval → applyPr → verifyPr
```

V1 supports only a same-repository branch. Fork changes are rejected explicitly.
The preferred input is a slim change description containing the base/head refs,
changed paths, completed checks and submission. `planPr` computes its integrity
receipt and readiness internally. The legacy `packet` input remains accepted
while older workflows migrate.

```bash
# Vault-backed token mode (the default, retained for existing definitions).
swamp behavior create @jeremy/github-pr mere-pr \\
  --global-arg repository=jhuntwork/mere \\
  --global-arg baseBranch=main \\
  --global-arg expectedActor=delivery-bot \\
  --global-arg 'token=${{ vault.get("github", "MERE_PR") }}'

# Authenticated gh CLI mode.
swamp behavior create @jeremy/github-pr mere-pr-gh \\
  --global-arg repository=jhuntwork/mere \\
  --global-arg baseBranch=main \\
  --global-arg expectedActor=jhuntwork \\
  --global-arg authMode=gh

swamp behavior run mere-pr-gh preflight
swamp behavior run mere-pr-gh planPr --input 'change:json={...}'
```

The legacy spelling `--input 'packet:json={...}'` is accepted during migration.

Run `applyPr` only from the post-approval workflow segment, then pass its
`applied` resource together with the change to `verifyPr`. The adapter does not
replace Mere's GitHub Actions: those continue to run hosted CI and publish only
after a human merges the reviewed release PR.

## License

MIT; see [LICENSE.txt](LICENSE.txt).
