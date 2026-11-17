# @jeremy/mere-delivery

Commit and branch standards for the Mere repositories, and the single workflow
that turns a finished change in a worktree into a verified pull request.

## Profiles

The rules live in `profiles.ts` as plain data, one profile per repository. To
change a rule, edit the profile, bump the extension version, and publish; every
delivery that names the profile follows the new rule.

| Rule | `mere` (package manager) | `merelinux` (recipes) |
| --- | --- | --- |
| Subject length | 80 | 69 |
| PR description | Exact commit body, including an empty body | Exact commit body, including an empty body |
| Bare subject required | None | None |
| Trailers (`Co-authored-by`, ...) | Refused | Refused |
| Status claims | Refused | Refused |
| Branch name | lowercase words joined by `-` | lowercase, digits, `.`, `_`, `-` |

Both profiles also require the pull request title to equal the commit subject.

The delivery workflow derives the pull-request body from the commit message. The
body must match exactly, including an empty body and Markdown formatting. Put
rationale in the commit body when the change needs it; the pull request receives
that same body automatically.

Status claims are checked in commit messages because the pipeline reports
execution evidence better than a commit body. Trailers remain refused.

The values come from each repository's own history. Run against the last 286
non-merge commits of `mere` and 400 of `merelinux`, the profiles flag one `mere`
subject (104 characters) and four `merelinux` commits (three bumps that carry a
body, one "Built and tested locally" line).

## Check a commit

```sh
swamp model create @jeremy/mere-delivery policy
swamp model method run policy checkCommit \
  --input profile=mere \
  --input 'message=Fix a leak in the repo cache' \
  --input branch=fix-repo-cache-leak
```

`checkCommit` records every violation and then fails if there are any. It can
also check a commit that already exists (`rawCommit`, the output of
`git log -1 --format='%an <%ae>%n%B'`) and, with `issue` and `prBody`, that the
pull request body cites the issue.

## Deliver a change

The pull request body is derived from the commit body and must match it exactly,
including an empty body. The workflow does not manufacture rationale or rewrite
Markdown. Write any explanation needed for review in the commit body.

`@jeremy/mere-delivery/deliver-change` takes a worktree that already holds the
implementation and a baseSha it was cut from:

1. check the message, title and branch against the profile;
2. derive the pull-request body from the commit message and check exact equality;
3. commit only `allowedPaths`, unless they have no uncommitted changes, which is
   the case when an earlier run already made the commit;
4. read the commit at the branch tip back and check it again, including the
   author and body rules;
5. check the branch's diff is non-empty and only touches `allowedPaths`;
6. push without force;
7. plan, create and read back the pull request with `@jeremy/github-pr`.

Everything that can refuse a change runs before the push, so a rejected change
leaves no branch on the remote. Running the workflow again on a branch that
already holds its commit skips the commit step and carries on.

```sh
swamp workflow run @jeremy/mere-delivery/deliver-change \
  --input worktreePath=/path/to/mere-worktree \
  --input branch=fix-repo-cache-leak \
  --input baseSha=<40-character commit the branch was cut from> \
  --input 'allowedPaths:json=["src/repo_sources.zig"]' \
  --input 'commitMessage=Fix a leak in the repo cache' \
  --input 'title=Fix a leak in the repo cache' \
  --input 'body=' \
  --input profile=mere \
  --input repository=jhuntwork/mere \
  --input prBinding=mere-pr \
  --input issue=42 \
  --input issueAction=fixes \
  --input checkName=repository-validation \
  --input 'checkDetail=Format check, tests, and build covered the change.'
```

When `issue` is set, include the issue reference in the commit body. With
`issueAction: reference`, the body must cite the issue without a closing keyword.
With `issueAction: fixes`, the body must contain the canonical `Fixes #N`
reference. The default is `reference`; an issue number alone never closes an
issue.

The workflow never merges. It carries no credentials; the caller supplies a
vault-backed `@jeremy/github-pr` binding as `prBinding`.
