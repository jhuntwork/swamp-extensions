# @jeremy/github-draft-pr

A deliberately narrow GitHub.com model for one bound repository and base branch.
It verifies a Change Packet Protocol v1 proposal, produces a draft-PR plan,
creates or recognizes a matching draft PR after workflow approval, and reads it
back to verify its identity.

It does not merge, release, update PRs, mark them ready, administer repositories,
or call arbitrary GitHub endpoints.

## Workflow role

Use this model at the end of a repository-owned workflow:

```text
proposal → branch → implementation → validation → scoped commit → push
→ packet → planDraft → manual approval → applyDraft → verifyDraft
```

V1 supports only a same-repository branch. Fork packets are rejected explicitly.
A model instance is bound to exact `repository`, `baseBranch`, and
`expectedActor` values; its token is sensitive and should be retrieved from a
vault.

```bash
swamp model create @jeremy/github-draft-pr mere-draft-pr \
  --global-arg repository=jhuntwork/mere \
  --global-arg baseBranch=main \
  --global-arg expectedActor=delivery-bot \
  --global-arg 'token=${{ vault.get("github", "MERE_DRAFT_PR") }}'

swamp model method run mere-draft-pr planDraft --input 'packet:json={...}'
```

Run `applyDraft` only from the post-approval workflow segment, then pass its
`applied` resource together with the packet to `verifyDraft`. The adapter does
not replace Mere's GitHub Actions: those continue to run hosted CI and publish
only after a human merges the reviewed release PR.

## License

MIT; see [LICENSE.txt](LICENSE.txt).
