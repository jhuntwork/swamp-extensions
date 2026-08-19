# GitHub Draft-PR Adapter Design

Status: local design contract; no model, credential, or network operation exists yet.

## Purpose

`@jeremy/github-draft-pr` will consume Change Packet Protocol v1 and provide a
narrow GitHub.com draft-pull-request boundary. It is intentionally not a GitHub
management model.

## Bound model identity

A model instance must require:

- `repository`: exact `owner/name` target repository;
- `baseBranch`: exact permitted target branch;
- `expectedActor`: exact authenticated GitHub login expected from `/user`;
- `token`: sensitive vault-backed token.

The API origin is fixed to `https://api.github.com`; callers cannot configure an
alternate base URL. The token must not be logged or returned. Documentation will
recommend a fine-grained token limited to the one repository, with only the
minimum Pull requests/Contents/Metadata permissions necessary for the tested
operations.

## Initial fork policy

V1 supports only same-repository changes:

```text
packet.sourceRepository == packet.targetRepository == model.repository
```

A source/target mismatch is rejected before any GitHub mutation. Fork support
is a later, explicit extension requiring source-owner identity and a verified
GitHub `head` representation; it must not be inferred from a branch name.

## Methods

### `preflight`

Read-only. It must:

1. call `GET /user` and require `login == expectedActor`;
2. call `GET /repos/{repository}` and require `full_name == repository`;
3. call `GET /repos/{repository}/git/ref/heads/{baseBranch}`;
4. write the actor, immutable repository ID, default branch, configured base
   branch, and resolved base SHA as evidence.

### `planDraft`

Read-only. Given a packet, it must:

1. validate packet protocol version, canonical digest, and readiness;
2. apply the same-repository policy;
3. require target repository and base ref to match the bound model;
4. re-read target base and source head refs and require their SHAs to match the
   packet;
5. require `submission.draft == true` for this adapter;
6. list matching open pull requests for the exact head/base pair;
7. write an immutable plan containing packet ID/digest, observed ref SHAs,
   requested title/body digest/draft state, and either no existing PR or its
   identity.

Planning performs no GitHub write.

### `applyDraft`

Mutating and intended to run only after a native Swamp `manual_approval` step.
It must accept the packet and immutable plan, revalidate both, re-read both
refs, and re-check matching open PRs. It then either:

- verifies and returns an already matching open draft PR; or
- sends exactly one `POST /repos/{repository}/pulls` with `draft: true`, the
  packet title/body, exact head branch, and exact base branch.

A concurrent already-exists response must cause one read-back attempt rather
than an automatic retry loop. The method must never merge, update a PR, label,
review, create a release, or mutate a repository.

### `verifyDraft`

Read-only. It must fetch the identified PR and prove its target repository,
base ref/SHA, head ref/SHA, draft state, title, and body digest exactly match
the packet and applied plan. Its resource is the durable submission receipt.

## Required tests

All HTTP tests use a fetch mock; no test uses a real token or GitHub request.
Cover successful same-repository preflight/plan/apply/verify; token actor
mismatch; repository/base mismatch; stale base or head SHA; invalid/unready or
tampered packet; fork rejection; pre-existing matching PR; mismatching existing
PR; POST payload always retaining `draft: true`; read-back verification failure;
and an already-exists race response.

## Non-goals

No `merge`, `update`, `ready_for_review`, repository administration, release,
issue, label, workflow, or arbitrary endpoint operation. Hosted CI observation
is a separate concern and does not become a side effect of draft creation.
