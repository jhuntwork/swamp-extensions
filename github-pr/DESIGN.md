# GitHub PR Adapter Design

`@jeremy/github-pr` consumes Change Packet Protocol v1 and provides a narrow
GitHub.com pull-request boundary. It is intentionally not a GitHub management
model.

It supersedes `@jeremy/github-draft-pr`, whose only substantive difference was
requiring every submission to be a draft. That constraint encoded a habit rather
than a requirement: a pull request is already gated by human review before merge,
so draft state adds nothing to that gate and belongs to the packet instead.

## Bound model identity

A model instance must require:

- `repository`: exact `owner/name` target repository;
- `baseBranch`: exact permitted target branch;
- `expectedActor`: exact authenticated GitHub login expected from `/user`;
- `token`: sensitive vault-backed token.

The API origin is fixed to `https://api.github.com`; callers cannot configure an
alternate base URL. The token must not be logged or returned. Documentation
recommends a fine-grained token limited to the one repository, with only the
minimum Pull requests/Contents/Metadata permissions necessary for the tested
operations.

## Draft handling

`submission.draft` is a packet field, defaulting to false in practice because an
ordinary pull request is the normal case. The adapter carries that state through
the whole chain rather than fixing it:

- `planPr` records the requested draft state in the plan a human reviews;
- `applyPr` rejects a plan whose draft state disagrees with its packet, then
  sends exactly that state to GitHub;
- `verifyPr` reads the created PR's draft state back and requires it to match.

The invariant is that the reviewed state is the created state, in either
direction. Nothing silently upgrades or downgrades a submission.

## Initial fork policy

V1 supports only same-repository changes:

```text
packet.sourceRepository == packet.targetRepository == model.repository
```

A source/target mismatch is rejected before any GitHub mutation. Fork support is
a later, explicit extension requiring source-owner identity and a verified
GitHub `head` representation; it must not be inferred from a branch name.

## Methods

### `preflight`

Read-only. It must:

1. call `GET /user` and require `login == expectedActor`;
2. call `GET /repos/{repository}` and require `full_name == repository`;
3. call `GET /repos/{repository}/git/ref/heads/{baseBranch}`;
4. write the actor, immutable repository ID, default branch, configured base
   branch, and resolved base SHA as evidence.

### `planPr`

Read-only. Given a packet, it must:

1. validate packet protocol version, canonical digest, and readiness;
2. apply the same-repository policy;
3. require target repository and base ref to match the bound model;
4. re-read target base and source head refs and require their SHAs to match the
   packet;
5. list matching open pull requests for the exact head/base pair;
6. write an immutable plan containing packet ID/digest, observed ref SHAs,
   requested title/body digest, requested draft state, and either no existing PR
   or its identity.

Planning performs no GitHub write.

### `applyPr`

Mutating and intended to run only after a native Swamp `manual_approval` step.
It must accept the packet and immutable plan, revalidate both, re-read both refs,
and re-check matching open PRs. It then either:

- verifies and returns an already matching open pull request; or
- sends exactly one `POST /repos/{repository}/pulls` with the plan's draft state,
  the packet title/body, exact head branch, and exact base branch.

A concurrent already-exists response must cause one read-back attempt rather than
an automatic retry loop. The method must never merge, update a PR, label, review,
create a release, or mutate a repository.

### `verifyPr`

Read-only. It must fetch the identified PR and prove its target repository, base
ref/SHA, head ref/SHA, draft state, title, and body exactly match the packet and
applied plan. Its resource is the durable submission receipt.

## Required tests

All HTTP tests use a fetch mock; no test uses a real token or GitHub request.
Cover successful same-repository preflight/plan/apply/verify; token actor
mismatch; repository/base mismatch; stale base or head SHA; invalid/unready or
tampered packet; fork rejection; pre-existing matching PR; POST payload carrying
the requested draft state in both directions; a plan whose draft state disagrees
with its packet; read-back verification failure including draft-state drift; and
an already-exists race response.

## Non-goals

No `merge`, `update`, `ready_for_review`, repository administration, release,
issue, label, workflow, or arbitrary endpoint operation. Hosted CI observation is
a separate concern and does not become a side effect of PR creation.
