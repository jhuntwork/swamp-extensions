# @jeremy/github-pr

A deliberately narrow GitHub.com model for one bound repository and base branch.
It verifies a Change Packet Protocol v1 proposal, produces a PR plan, creates or
recognizes a matching pull request after workflow approval, and reads it back to
verify its identity.

It does not merge, release, update PRs, mark them ready, administer
repositories, or call arbitrary GitHub endpoints.

## Draft is requested per packet

An ordinary reviewable pull request is the default. A packet may set
`submission.draft` when a draft is genuinely wanted, and the plan records which
was asked for, so the state a human approved is the state that gets created.
`applyPr` refuses a plan whose draft state disagrees with its packet, and
`verifyPr` reads the state back rather than assuming either value.

This replaces `@jeremy/github-draft-pr`, which required every submission to be a
draft.

## Workflow role

Use this model at the end of a repository-owned workflow:

```text
proposal → branch → implementation → validation → scoped commit → push
→ packet → planPr → manual approval → applyPr → verifyPr
```

V1 supports only a same-repository branch. Fork packets are rejected explicitly.
A model instance is bound to exact `repository`, `baseBranch`, and
`expectedActor` values; its token is sensitive and should be retrieved from a
vault.

```bash
swamp model create @jeremy/github-pr mere-pr \
  --global-arg repository=jhuntwork/mere \
  --global-arg baseBranch=main \
  --global-arg expectedActor=delivery-bot \
  --global-arg 'token=${{ vault.get("github", "MERE_PR") }}'

swamp model method run mere-pr planPr --input 'packet:json={...}'
```

Run `applyPr` only from the post-approval workflow segment, then pass its
`applied` resource together with the packet to `verifyPr`. The adapter does not
replace Mere's GitHub Actions: those continue to run hosted CI and publish only
after a human merges the reviewed release PR.

## License

MIT; see [LICENSE.txt](LICENSE.txt).
