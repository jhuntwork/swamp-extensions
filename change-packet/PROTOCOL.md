# Change Packet Protocol v1

This document defines the portable contract for a forge-neutral change packet.
An adapter may be written in any language, but it must validate this contract
before treating a packet as evidence for a hosted change.

## Scope

A packet records a proposed, already-pushed Git change and its local validation
evidence. It does not grant approval or authority to push, create a review,
merge, publish, or release. A forge adapter must separately re-read the remote
refs before applying a hosted review request.

## Required fields

```json
{
  "schemaVersion": 1,
  "id": "UUID",
  "createdAt": "RFC 3339 UTC timestamp",
  "payloadDigest": "lowercase SHA-256 hex",
  "targetRepository": "canonical destination repository identity",
  "sourceRepository": "canonical repository owning the head ref",
  "base": { "ref": "main", "sha": "full Git object ID" },
  "head": { "ref": "feature/example", "sha": "full Git object ID" },
  "changedPaths": ["repository-relative/path"],
  "checks": [{
    "name": "stable check name",
    "required": true,
    "outcome": "passed|failed|skipped|unavailable",
    "evidenceRef": "opaque durable evidence reference",
    "detail": "required when outcome is not passed"
  }],
  "submission": { "title": "...", "body": "...", "draft": true },
  "readiness": { "ready": true, "blockers": [] }
}
```

`targetRepository` is the destination of the hosted review. `sourceRepository`
owns `head.ref`; equality explicitly represents a same-repository branch, while
inequality represents a fork or cross-repository proposal. An adapter must have
an explicit policy for the latter; it must never silently assume same-repository
semantics.

`base.ref` and `head.ref`, and their full commit IDs, must differ. Changed paths
are normalized repository-relative paths: no leading slash, empty segment, `.`,
or `..`. Check names are unique. At least one check is required.

Defaults are materialized before hashing: omitted `required` is `true`, omitted
`detail` and submission `body` are `""`, and omitted submission `draft` is
`true`.

## Payload digest

The digest covers only this payload object:

```text
{
  schemaVersion,
  targetRepository,
  sourceRepository,
  base,
  head,
  changedPaths,
  checks,
  submission
}
```

It excludes the generated `id`, `createdAt`, `payloadDigest`, and derived
`readiness`. Serialize recursively as canonical JSON:

1. JSON primitive values use ECMAScript `JSON.stringify` semantics; strings are
   not Unicode-normalized.
2. Arrays preserve their supplied order.
3. Object keys are lexicographically sorted by Unicode code point at every
   object level; no whitespace is emitted.
4. UTF-8 encode the resulting JSON and calculate SHA-256; encode the bytes as
   lowercase hexadecimal.

A verifier recomputes the digest and rejects a mismatch. It also recomputes
readiness: it is `true` only when every `required` check has outcome `passed`.
The blocker list is ordered by the input check order and contains
`<name>: <outcome>` for each required non-passing check.

## Test vector

The following materialized same-repository payload has digest
`f7acaf4508644cf13806b6c9336e82c48e36a88efa8b84510e5d7353664ed80b`:

```json
{"schemaVersion":1,"targetRepository":"github.com/example/project","sourceRepository":"github.com/example/project","base":{"ref":"main","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"head":{"ref":"feature/change","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"changedPaths":["README.md","src/main.ts"],"checks":[{"name":"unit-tests","required":true,"outcome":"passed","evidenceRef":"swamp-data://validation/unit-tests/1","detail":""}],"submission":{"title":"docs: explain change packets","body":"Validated locally.","draft":true}}
```

## Adapter obligations

Before a hosted mutation, an adapter must at minimum:

- validate the packet and its digest;
- reject `readiness.ready: false` unless its own explicit policy says otherwise;
- prove the configured target repository and requested base branch match the packet;
- re-read the target base ref and prove it resolves to `base.sha`;
- re-read the source head ref and prove it resolves to `head.sha`;
- apply an explicit same-repository/fork policy based on the two repository identities;
- preserve requested draft state; and
- return enough hosted identity to permit independent read-back verification.

These are protocol obligations, not capabilities supplied by this packet model.
