# @jeremy/change-packet

`@jeremy/change-packet` creates durable, forge-neutral proposals for a validated
Git change. It does **not** run Git commands, call a forge, read credentials,
open a pull/merge request, approve work, merge, publish, or release.

A packet binds:

- explicit target and source repository identities (equal for a same-repository change);
- exact base and head refs with full commit IDs;
- repository-relative changed paths;
- required and optional validation outcomes with durable evidence references;
- requested title, body, and draft state for a later hosted review;
- a canonical SHA-256 payload digest; and
- derived readiness: every required check must have passed.

The digest is over semantic proposal fields, excluding the generated packet ID
and timestamp. `verify` recomputes both the digest and readiness so a later
workflow or forge adapter can detect packet tampering. See [PROTOCOL.md](PROTOCOL.md)
for canonicalization rules, a fixed digest vector, and adapter obligations.

## Installation

```bash
swamp extension pull @jeremy/change-packet
swamp model create @jeremy/change-packet delivery-packets
```

## Create a packet

```bash
swamp model method run delivery-packets create --input ':json={
  "targetRepository": "github.com/example/project",
  "sourceRepository": "github.com/example/project",
  "base": {"ref": "main", "sha": "1111111111111111111111111111111111111111"},
  "head": {"ref": "feature/example", "sha": "2222222222222222222222222222222222222222"},
  "changedPaths": ["README.md", "src/main.ts"],
  "checks": [{
    "name": "unit-tests",
    "required": true,
    "outcome": "passed",
    "evidenceRef": "swamp-data://validation/unit-tests/123"
  }],
  "submission": {
    "title": "docs: explain delivery",
    "body": "Validation evidence is attached to the packet.",
    "draft": true
  }
}'
```

The model writes a `packet` resource. A packet with a required `failed`,
`skipped`, or `unavailable` check is retained for inspection, but has
`readiness.ready: false` and lists the blockers. Non-passing checks must include
a concise explanation; the model never converts gaps into a passed result.

## Verify a packet

Pass a previously recorded `packet` value to `verify`. It writes a
`verification` resource with the expected and actual digest, recomputed
readiness, and any mismatched fields.

```bash
swamp model method run delivery-packets verify --input 'packet:json={...packet data...}'
```

## Workflow role

A repository-specific proposal workflow should assemble validation evidence,
create this packet, and then present it for review. A separate workflow segment
uses Swamp's native manual-approval step before any forge adapter applies a
review request. Forge adapters must verify both the target base ref and source
head ref again; this model is evidence transport, not hosted-change authority.

## License

MIT; see [LICENSE.txt](LICENSE.txt).
