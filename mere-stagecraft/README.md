# `@jeremy/mere-stagecraft`

`@jeremy/mere-stagecraft` adapts GitHub Issues to the Mere Stagecraft tracker
contract. It supplies idempotent issue fetch, create, comment, status, type, and
relation operations, plus a read-only preflight check. The adapter is an
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
`fetch_issue`, `create`, `comment`, `set_status`, `set_type`, `relate`,
`unrelate`, and `enumerate_issues`; create and comment requests receive
deterministic idempotency keys when the caller does not provide one.

`enumerate_issues` uses GitHub GraphQL to read both open and closed issues. It
returns immutable node IDs and opaque cursor checkpoints without mutating
GitHub. Status projection owns only `status:in-progress` and `status:done`:
`open` and `closed` have no owned label, and `in_progress` and `shipped` pair
those labels with GitHub OPEN and CLOSED respectively. Conflicting or mismatched
owned status state is rejected.

## Bind it to Stagecraft

Stagecraft's publisher binds a publisher behavior to the configured tracker
instance. In the Mere operations repository, the checked-in binding is
`models/@swamp/stagecraft/publisher/github-publisher.yaml`:

```yaml
type: "@swamp/stagecraft/publisher"
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
Stagecraft status key to the GitHub status label returned by this adapter. Point
a Stagecraft factory at `github-publisher`, then validate the factory before
running its workflows. Keep GitHub credentials in `gh`'s credential store rather
than in the behavior definition or this README.

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
change. A fresh tracker conformance run against a running Mere operations server
remains an integration check outside the package's unit tests.

## Intake promotion

`promote_intake` commits one enumerated page to the `intakeState` resource: the
opaque `after` checkpoint, the emitted node IDs and the stable-ID to work-item
links. It is a compare-and-set. The caller supplies `expectedAfter`, the
checkpoint the page was enumerated from, and the stored checkpoint must equal it
exactly. Cursors are opaque and are compared by equality only, never decoded or
ordered. Redelivering an already committed page is a no-op. Any other mismatch
fails with `checkpoint-conflict`, so a page that finishes out of order cannot
move the checkpoint backwards. Links are deduplicated by immutable node ID.

`check_intake` is the read-only counterpart. Called before a page is claimed, it
reports `fresh` when the stored checkpoint is the page's predecessor and
`committed` when the page already landed, and fails with `checkpoint-conflict`
for a stale page. This keeps a stale or redelivered page from writing ticket
reservations that the later compare-and-set cannot take back.

The result is written to `intake-check`, a fixed name, and carries the `repo` it
was computed for. Read it immediately after the call: a later call overwrites
it.

## Scheduling state

These methods hold the scheduler's state. Each is one read and at most one
write, and all of them must run against one model instance so Swamp's per-model
lock serializes concurrent callers.

- **Priority.** `set_override` appends a maintainer override to an append-only
  journal with who, why, the old value and the new value. The old value is never
  taken from the caller: it is the item's last override, or the computed
  priority the caller supplies when there is none. Overriding to the value
  already in effect fails with `override-noop`. A recorded override always wins
  over a later computed priority. Ready items are ordered by effective priority,
  then age, then stable issue ID.
- **WIP lease.** `acquire_lease` takes the one global lease only when it is free
  and returns an epoch one higher than any before it. The epoch and the holder
  are one record written once per acquire, so a failed write changes nothing and
  an epoch is never reused. `release_lease`, `interrupt_lease` and `check_lease`
  need the matching holder and epoch, and a stale one fails with `lease-fenced`.
  A held lease fails an acquire with `lease-held`. A lease is never released by
  elapsed time.
- **Pause and resume.** `pause_item` records who paused an item, why, and the
  state it was paused from, under an id that names that pause. If the item holds
  the WIP lease, the same call releases it, keeping the epoch. The pause is
  written first, so a failed release leaves the item paused with the lease still
  held, which keeps the WIP limit; calling `pause_item` again for that item
  repairs the lease without creating a second pause. `resume_item` needs the
  pause id and fails with `pause-mismatch` for any other. An item paused from
  `in-progress` resumes as `ready`, because pausing released its lease and it
  must acquire it again; every other state is restored as recorded.
- **Delivery units.** `set_delivery_units` stores a parent's repository-specific
  children and rejects duplicates, unknown dependencies and cycles. It stores
  and validates only.

## Ready queue

The scheduler leases items from a queue of those whose plan is approved. The
`mere-issue` factory has no ready stage, so an item becomes ready by being
queued.

- `enqueue_item` queues an item with its stable ID, creation time and triage
  facts, and stores the priority computed from those facts. Queueing an item
  that is already queued changes nothing, so a repeat, such as the one after a
  resume, is safe.
- `dequeue_item` removes an item. Removing one that is not queued changes
  nothing.
- `next_ready` is read-only. It reports the item to lease next, ordered by
  effective priority, then age, then stable issue ID, and does not change the
  queue. Recorded overrides are applied when the queue is read, so an override
  set after an item was queued still reorders it.

The scheduler dequeues an item after it acquires the lease, and acquires first,
so a failure cannot drop an item that has no lease. A paused item that resumes
as `ready` has to be queued again to be leased again.
