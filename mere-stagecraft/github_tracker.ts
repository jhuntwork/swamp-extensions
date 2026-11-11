/**
 * GitHub Issues adapter for the Mere Stagecraft tracker contract.
 *
 * The adapter stores tracker configuration and relation state in Swamp data,
 * and delegates GitHub API operations to the authenticated `gh` executable.
 */
import { z } from "npm:zod@4.6.7";

const repoSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const operationSchema = z.enum([
  "fetch_issue",
  "create",
  "comment",
  "set_status",
  "relate",
  "unrelate",
  "set_type",
  "enumerate_issues",
]);
const answerNameSchema = z.string().min(1).regex(/^[A-Za-z0-9._:-]+$/);
const issueTypes = new Set(["bug", "feature", "package", "task"]);
const issueStatuses = new Set([
  "open",
  "status:in-progress",
  "status:done",
  "closed",
]);

type Resource = Record<string, unknown>;
type Context = {
  signal?: AbortSignal;
  readResource: (name: string) => Promise<Resource | null>;
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    warning: (message: string, properties?: Record<string, unknown>) => void;
  };
};

type Issue = {
  number: number;
  title: string;
  body: string;
  state: string;
  url?: string;
  labels?: Array<{ name: string }>;
  author?: unknown;
  assignees?: unknown[];
  createdAt?: string;
  updatedAt?: string;
  comments?: Array<{
    id?: unknown;
    body?: string;
    url?: string;
    createdAt?: string;
  }>;
};

type Relation = {
  issue: string;
  type: "parent_of" | "blocked_by" | "related_to" | "duplicate_of";
  to: string;
};

type RelationStore = {
  repo: string;
  relations: Relation[];
};

type OperationResult = {
  result: unknown;
  internalHandles?: { name: string }[];
};

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function issueNumber(value: unknown): number {
  const number = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Number(value.replace(/^.*[.#]/, ""))
    : NaN;
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("issue must be a positive GitHub issue number");
  }
  return number;
}

function requestRepo(request: Resource, defaultRepo?: string): string {
  if (typeof request.repo === "string" && request.repo.length > 0) {
    return repoSchema.parse(request.repo);
  }
  if (defaultRepo) return defaultRepo;
  if (typeof request.issue === "string") {
    const hashMatch = /^(.*)#(\d+)$/.exec(request.issue);
    if (hashMatch?.[1]) return hashMatch[1];
    const stableMatch = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\.(\d+)$/.exec(
      request.issue,
    );
    if (stableMatch) return `${stableMatch[1]}/${stableMatch[2]}`;
  }
  throw new Error("request.repo must be a non-empty string");
}

function stableId(repo: string, number: number): string {
  return `${repo.replace("/", ".")}.${number}`;
}

function marker(name: string, value: string): string {
  return `<!-- stagecraft:${name}:${value} -->`;
}

function typeMarker(type: string): string {
  return marker("type", type);
}

function parseType(body: string): string | undefined {
  return /<!-- stagecraft:type:([^\s>]+) -->/.exec(body)?.[1];
}

function labelNames(issue: Issue): string[] {
  return Array.isArray(issue.labels)
    ? issue.labels.flatMap((label) =>
      typeof label?.name === "string" ? [label.name] : []
    )
    : [];
}

const ownedStatusLabels = new Set(["status:in-progress", "status:done"]);

function statusName(issue: Issue): string {
  const state = (issue.state || "").toUpperCase();
  const owned = labelNames(issue).filter((name) => ownedStatusLabels.has(name));
  if (owned.length > 1) {
    throw new Error("status-conflict: more than one owned status label");
  }
  const label = owned[0];
  if (label === "status:in-progress") {
    if (state !== "OPEN") {
      throw new Error("status-conflict: status:in-progress requires OPEN");
    }
    return label;
  }
  if (label === "status:done") {
    if (state !== "CLOSED") {
      throw new Error("status-conflict: status:done requires CLOSED");
    }
    return label;
  }
  if (state === "OPEN") return "open";
  if (state === "CLOSED") return "closed";
  throw new Error(
    `status-conflict: unsupported GitHub issue state '${issue.state}'`,
  );
}

type IntakeLink = { stableId: string; nodeId: string; key: string };

type IntakeDecision =
  | { kind: "noop" }
  | {
    kind: "write";
    state: {
      repo: string;
      after: string;
      emitted: string[];
      links: IntakeLink[];
    };
  };

/**
 * Compare-and-set for an intake page. The stored checkpoint is compared by
 * equality only: cursors are opaque and are never decoded or ordered. A
 * redelivery of an already-committed page is a no-op; any other mismatch is
 * rejected so the caller retries from the stored checkpoint.
 */
function decideIntakePromotion(
  stored: Resource | null,
  args: {
    repo: string;
    expectedAfter: string | null;
    nextAfter: string;
    emitted: string[];
    links: IntakeLink[];
  },
): IntakeDecision {
  const currentAfter = stored === null
    ? null
    : typeof stored.after === "string"
    ? stored.after
    : null;
  if (currentAfter === args.nextAfter && args.expectedAfter !== currentAfter) {
    return { kind: "noop" };
  }
  if (currentAfter !== args.expectedAfter) {
    throw new Error(
      "checkpoint-conflict: stored intake checkpoint does not match the page predecessor",
    );
  }
  const existing = stored !== null && Array.isArray(stored.links)
    ? stored.links as IntakeLink[]
    : [];
  const byNode = new Map(existing.map((link) => [link.nodeId, link]));
  for (const link of args.links) byNode.set(link.nodeId, link);
  return {
    kind: "write",
    state: {
      repo: args.repo,
      after: args.nextAfter,
      emitted: args.emitted,
      links: [...byNode.values()],
    },
  };
}

type IntakeCheck = "fresh" | "committed";

/**
 * Read-only counterpart of decideIntakePromotion. "fresh" means the stored
 * checkpoint is this page's predecessor, so its issues may be claimed.
 * "committed" means the page already landed, so nothing is claimed again. Any
 * other stored checkpoint is a stale page and is rejected before a claim can
 * write a reservation for it.
 */
function checkIntakePage(
  stored: Resource | null,
  args: { expectedAfter: string | null; nextAfter: string },
): IntakeCheck {
  const currentAfter = stored === null
    ? null
    : typeof stored.after === "string"
    ? stored.after
    : null;
  if (currentAfter === args.nextAfter && args.expectedAfter !== currentAfter) {
    return "committed";
  }
  if (currentAfter !== args.expectedAfter) {
    throw new Error(
      "checkpoint-conflict: stored intake checkpoint does not match the page predecessor",
    );
  }
  return "fresh";
}

// ---------------------------------------------------------------------------
// Scheduling state: priority, a fenced WIP lease, pause provenance and the
// delivery-unit schema. Everything below is a pure decision over the stored
// record, as intake promotion is, so each method is a single read and at most
// one conditional write. All of it runs against one model instance, so Swamp's
// per-model lock serializes concurrent callers.
// ---------------------------------------------------------------------------

type Priority = "P0" | "P1" | "P2" | "P3";
const priorities: Priority[] = ["P0", "P1", "P2", "P3"];

type PriorityFacts = {
  securityConfirmed?: boolean;
  releaseBlockingRegression?: boolean;
  supportedUserRegression?: boolean;
  requiredUpdate?: boolean;
  reproducibleBug?: boolean;
  acceptedMaintenance?: boolean;
};

/**
 * Typed triage facts to a priority band. Confirmed security or release-blocking
 * regressions are P0; supported-user regressions and required security or
 * dependency updates are P1; reproducible ordinary bugs and accepted
 * maintenance are P2; everything else is P3.
 */
function computePriority(facts: PriorityFacts): Priority {
  if (facts.securityConfirmed || facts.releaseBlockingRegression) return "P0";
  if (facts.supportedUserRegression || facts.requiredUpdate) return "P1";
  if (facts.reproducibleBug || facts.acceptedMaintenance) return "P2";
  return "P3";
}

type OverrideEntry = {
  item: string;
  by: string;
  reason: string;
  from: Priority;
  to: Priority;
  at: string;
};

function lastOverride(
  journal: OverrideEntry[],
  item: string,
): OverrideEntry | undefined {
  for (let i = journal.length - 1; i >= 0; i -= 1) {
    if (journal[i].item === item) return journal[i];
  }
  return undefined;
}

/** A recorded override wins. Triage may recommend a value but never replaces it. */
function effectivePriority(
  computed: Priority,
  journal: OverrideEntry[],
  item: string,
): Priority {
  return lastOverride(journal, item)?.to ?? computed;
}

/**
 * The journal's old value is never taken from the caller. It is the item's last
 * override when there is one, and otherwise the computed priority. Overriding to
 * the value already in effect records nothing and is refused.
 */
function decideOverride(
  journal: OverrideEntry[],
  args: {
    item: string;
    by: string;
    reason: string;
    computed: Priority;
    to: Priority;
  },
  at: string,
): OverrideEntry {
  const from = effectivePriority(args.computed, journal, args.item);
  if (from === args.to) {
    throw new Error(
      `override-noop: ${args.item} already has effective priority ${from}`,
    );
  }
  return {
    item: args.item,
    by: args.by,
    reason: args.reason,
    from,
    to: args.to,
    at,
  };
}

type QueueEntry = {
  item: string;
  stableId: string;
  createdAt: string;
  priority: Priority;
};

/** Effective priority, then age (oldest first), then stable issue ID. */
function pickNext(queue: QueueEntry[]): QueueEntry | null {
  const ranked = [...queue].sort((a, b) =>
    priorities.indexOf(a.priority) - priorities.indexOf(b.priority) ||
    (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
    (a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : 0)
  );
  return ranked[0] ?? null;
}

type ReadyEntry = {
  item: string;
  stableId: string;
  createdAt: string;
  computed: Priority;
};

/**
 * Enqueueing an item that is already queued changes nothing, so a repeated
 * enqueue, such as one after a resume, is safe. The priority stored is the
 * computed one: overrides are applied when the queue is read, so an override
 * set after an item was enqueued still reorders it.
 */
function decideEnqueue(
  queue: ReadyEntry[],
  entry: ReadyEntry,
): ReadyEntry[] | null {
  if (queue.some((queued) => queued.item === entry.item)) return null;
  return [...queue, entry];
}

/** Removing an item that is not queued changes nothing. */
function decideDequeue(
  queue: ReadyEntry[],
  item: string,
): ReadyEntry[] | null {
  if (!queue.some((queued) => queued.item === item)) return null;
  return queue.filter((queued) => queued.item !== item);
}

/** The next item by effective priority, then age, then stable issue ID. */
function nextReady(
  queue: ReadyEntry[],
  journal: OverrideEntry[],
): { entry: ReadyEntry; priority: Priority } | null {
  const picked = pickNext(
    queue.map((entry) => ({
      item: entry.item,
      stableId: entry.stableId,
      createdAt: entry.createdAt,
      priority: effectivePriority(entry.computed, journal, entry.item),
    })),
  );
  if (picked === null) return null;
  return {
    entry: queue.find((entry) => entry.item === picked.item)!,
    priority: picked.priority,
  };
}

type Intervention = {
  key: string;
  stableId: string;
  kind: string;
  detail: string;
  recordedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
};

/**
 * Reconcile records what it will not repair. The same condition found again on
 * the next run must not add a second record, so an unresolved record with the
 * same issue, kind and detail makes a repeat a no-op. Once a person resolves a
 * record, the same condition recurring is recorded again.
 */
function decideIntervention(
  journal: Intervention[],
  args: { stableId: string; kind: string; detail: string },
  at: string,
): Intervention[] | null {
  const key = `${args.stableId}|${args.kind}|${args.detail}`;
  if (journal.some((entry) => entry.key === key && !entry.resolvedAt)) {
    return null;
  }
  return [...journal, { key, ...args, recordedAt: at }];
}

/** Resolving a record that is not open changes nothing. */
function decideResolve(
  journal: Intervention[],
  key: string,
  by: string,
  at: string,
): Intervention[] | null {
  if (!journal.some((entry) => entry.key === key && !entry.resolvedAt)) {
    return null;
  }
  return journal.map((entry) =>
    entry.key === key && !entry.resolvedAt
      ? { ...entry, resolvedAt: at, resolvedBy: by }
      : entry
  );
}

type WipLease = {
  epoch: number;
  holder: string | null;
  acquiredAt: string | null;
  reason: string | null;
};

function readLease(stored: Resource | null): WipLease {
  return {
    epoch: typeof stored?.epoch === "number" ? stored.epoch : 0,
    holder: typeof stored?.holder === "string" ? stored.holder : null,
    acquiredAt: typeof stored?.acquiredAt === "string"
      ? stored.acquiredAt
      : null,
    reason: typeof stored?.reason === "string" ? stored.reason : null,
  };
}

/** Acquire only when free. The new epoch is always the stored epoch plus one. */
function decideAcquire(
  stored: Resource | null,
  holder: string,
  at: string,
): WipLease {
  const lease = readLease(stored);
  if (lease.holder !== null) {
    throw new Error(`lease-held: the WIP lease is held by ${lease.holder}`);
  }
  return {
    epoch: lease.epoch + 1,
    holder,
    acquiredAt: at,
    reason: null,
  };
}

/** Release needs the matching holder and epoch. The epoch is never lowered. */
function decideRelease(
  stored: Resource | null,
  holder: string,
  epoch: number,
  reason: string,
): WipLease {
  const lease = readLease(stored);
  if (lease.holder !== holder || lease.epoch !== epoch) {
    throw new Error(
      "lease-fenced: holder or epoch does not match the current lease",
    );
  }
  return { epoch: lease.epoch, holder: null, acquiredAt: null, reason };
}

/**
 * Pausing an item that holds the WIP lease releases it, so the item can return
 * to ready and acquire it again. Returns the released lease, or null when the
 * item does not hold it. The holder is the work item's key.
 */
function releaseLeaseForPause(
  lease: Resource | null,
  item: string,
): WipLease | null {
  const current = readLease(lease);
  if (current.holder !== item) return null;
  return {
    epoch: current.epoch,
    holder: null,
    acquiredAt: null,
    reason: `interrupted: paused ${item}`,
  };
}

const lifecycleStates = [
  "new",
  "triage",
  "needs-info",
  "ready",
  "in-progress",
  "in-review",
  "verifying",
  "blocked",
] as const;
type LifecycleState = typeof lifecycleStates[number];

type PauseRecord = {
  id: string;
  item: string;
  pausedBy: string;
  reason: string;
  priorState: LifecycleState;
  pausedAt: string;
  resumedAt?: string;
  resumedBy?: string;
  restoredState?: LifecycleState;
};

async function pauseDigest(fields: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(fields.join("\u0000"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("").slice(0, 32);
}

function activePause(stored: Resource | null): PauseRecord | null {
  if (stored === null || typeof stored.id !== "string") return null;
  return typeof stored.resumedAt === "string" ? null : stored as PauseRecord;
}

/**
 * Resume needs the pause it was approved for. A paused in-progress item
 * resumes as ready: pausing released its lease, so it must acquire it again
 * and the WIP-of-one invariant holds. Every other state is restored as recorded.
 */
function decideResume(
  stored: Resource | null,
  pauseId: string,
  resumedBy: string,
  at: string,
): PauseRecord {
  const pause = activePause(stored);
  if (pause === null) {
    throw new Error("not-paused: the item has no active pause");
  }
  if (pause.id !== pauseId) {
    throw new Error("pause-mismatch: the approval names a different pause");
  }
  if (resumedBy.length === 0) throw new Error("resumedBy must not be empty");
  return {
    ...pause,
    resumedAt: at,
    resumedBy,
    restoredState: pause.priorState === "in-progress"
      ? "ready"
      : pause.priorState,
  };
}

type DeliveryChild = {
  id: string;
  repository: string;
  baseRef: string;
  allowedPaths: string[];
  workflow: string;
  dependencies: string[];
  branch?: string;
  pr?: string;
  testAttestation?: string;
  ciConclusion?: string;
};

/** Children are unique, depend only on each other, and contain no cycle. */
function validateDeliveryUnits(children: DeliveryChild[]): void {
  const ids = new Set<string>();
  for (const child of children) {
    if (ids.has(child.id)) {
      throw new Error(`invalid delivery units: duplicate child ${child.id}`);
    }
    ids.add(child.id);
  }
  const byId = new Map(children.map((child) => [child.id, child]));
  for (const child of children) {
    for (const dep of child.dependencies) {
      if (dep === child.id) {
        throw new Error(
          `invalid delivery units: ${child.id} depends on itself`,
        );
      }
      if (!byId.has(dep)) {
        throw new Error(
          `invalid delivery units: ${child.id} depends on unknown ${dep}`,
        );
      }
    }
  }
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      throw new Error(`invalid delivery units: dependency cycle at ${id}`);
    }
    state.set(id, 1);
    for (const dep of byId.get(id)!.dependencies) visit(dep);
    state.set(id, 2);
  };
  for (const child of children) visit(child.id);
}

const leaseName = "wip-lease";
const overridesName = "priority-overrides";
const queueName = "ready-queue";
const interventionsName = "interventions";
const nextReadyName = "next-ready";
const pauseName = (item: string) => `pause-${encodeURIComponent(item)}`;
const deliveryName = (parent: string) =>
  `delivery-${encodeURIComponent(parent)}`;

export const testing = {
  statusOrConflict,
  computePriority,
  effectivePriority,
  pickNext,
  decideAcquire,
  decideRelease,
  decideResume,
  decideOverride,
  decideEnqueue,
  decideIntervention,
  decideResolve,
  decideDequeue,
  nextReady,
  releaseLeaseForPause,
  validateDeliveryUnits,
  pauseDigest,
  checkIntakePage,
  decideIntakePromotion,
  statusName,
  setGhForTest: (
    runner: (args: string[], signal?: AbortSignal) => Promise<unknown>,
  ) => {
    gh = runner;
  },
  resetGhForTest: () => {
    gh = commandGh;
  },
};

function commentBody(body: string | undefined): string | undefined {
  return body?.replace(/\n+<!-- stagecraft:comment:[^>]+ -->\s*$/, "");
}

function cleanDescription(body: string): string {
  return body.replace(
    /\n+<!-- stagecraft:(?:type|create):[^>]+ -->/g,
    "",
  ).trimEnd();
}

/**
 * The status of an issue, or a conflict marker. Enumeration uses this so one
 * issue whose labels and state disagree is reported and does not stop a whole
 * page. fetch_issue and set_status stay strict and still throw.
 */
function statusOrConflict(
  issue: Issue,
): { id: string; name: string; conflict?: string } {
  try {
    const name = statusName(issue);
    return { id: name, name };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!detail.startsWith("status-conflict")) throw error;
    return { id: "conflict", name: "conflict", conflict: detail };
  }
}

function ticket(
  repo: string,
  issue: Issue,
  relations: Relation[],
  tolerateConflict = false,
): Resource {
  const stable = stableId(repo, issue.number);
  const related = relations.flatMap((relation) => {
    if (relation.issue === stable) {
      return [{
        type: relation.type,
        direction: "outgoing",
        issue: relation.to,
        display: relation.to,
      }];
    }
    if (relation.to === stable) {
      return [{
        type: relation.type,
        direction: "incoming",
        issue: relation.issue,
        display: relation.issue,
      }];
    }
    return [];
  });
  return {
    id: stable,
    display: `#${issue.number}`,
    title: issue.title,
    url: issue.url,
    status: tolerateConflict
      ? statusOrConflict(issue)
      : { id: statusName(issue), name: statusName(issue) },
    relations: related,
    description: cleanDescription(issue.body),
    labels: labelNames(issue),
    assignees: issue.assignees ?? [],
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    activity: (issue.comments ?? []).map((comment) => ({
      kind: "comment",
      id: comment.id === undefined ? undefined : String(comment.id),
      body: commentBody(comment.body),
      at: comment.createdAt ?? issue.updatedAt ?? issue.createdAt,
    })),
    type: parseType(issue.body),
  };
}

const MAX_GH_OUTPUT_BYTES = 2 * 1024 * 1024;
const GH_TIMEOUT_MS = 30_000;

async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_GH_OUTPUT_BYTES) {
        throw new Error(`gh output exceeded ${MAX_GH_OUTPUT_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

async function commandGh(
  args: string[],
  signal?: AbortSignal,
): Promise<unknown> {
  // swamp-quality-ignore deno-command
  const child = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const terminate = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may have exited between the abort and kill calls.
    }
  };
  const timeout = setTimeout(terminate, GH_TIMEOUT_MS);
  signal?.addEventListener("abort", terminate, { once: true });
  try {
    if (signal?.aborted) terminate();
    let stdout: string;
    let stderr: string;
    try {
      [stdout, stderr] = await Promise.all([
        readBounded(child.stdout),
        readBounded(child.stderr),
      ]);
    } catch (error) {
      terminate();
      throw error;
    }
    const status = await child.status;
    const error = stderr.trim();
    if (!status.success) throw new Error(error || `gh exited ${status.code}`);
    const value = stdout.trim();
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", terminate);
  }
}

let gh = commandGh;

async function fetchIssue(
  repo: string,
  number: number,
  signal?: AbortSignal,
): Promise<Issue> {
  return await gh([
    "issue",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "number,title,body,state,author,createdAt,updatedAt,labels,comments,url,assignees",
  ], signal) as Issue;
}

async function enumerateIssues(
  repo: string,
  after: string | undefined,
  limit: number,
  signal?: AbortSignal,
): Promise<{ issues: Issue[]; checkpoint: Resource }> {
  const [owner, name] = repo.split("/");
  const query =
    `query($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(first: $first, after: $after, states: [OPEN, CLOSED], orderBy: {field: UPDATED_AT, direction: ASC}) {
        nodes { id number title body state url createdAt updatedAt labels(first: 100) { nodes { name } } }
        pageInfo { endCursor hasNextPage }
      }
    }
  }`;
  const output = await gh([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `first=${limit}`,
    ...(after === undefined ? [] : ["-F", `after=${after}`]),
  ], signal) as Resource;
  const connection =
    ((output.data as Resource | undefined)?.repository as Resource | undefined)
      ?.issues as Resource | undefined;
  if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
    throw new Error(
      "GitHub GraphQL response did not contain repository issues",
    );
  }
  const pageInfo = connection.pageInfo as Resource;
  const issues = connection.nodes.map((node) => {
    const value = node as Resource;
    const labels = (value.labels as Resource | undefined)?.nodes;
    return { ...value, labels: Array.isArray(labels) ? labels : [] } as Issue;
  });
  const endCursor = typeof pageInfo.endCursor === "string"
    ? pageInfo.endCursor
    : after;
  const exhausted = pageInfo.hasNextPage === false;
  return {
    issues,
    checkpoint: {
      after: issues.length === 0 && exhausted
        ? after ?? null
        : endCursor ?? null,
      emitted: issues.map((issue) => String((issue as Resource).id)),
      watermark: issues.reduce<Resource | null>((latest, issue) => {
        const candidate = {
          updatedAt: issue.updatedAt ?? "",
          nodeId: String((issue as Resource).id),
        };
        return latest === null ||
            `${candidate.updatedAt}\u0000${candidate.nodeId}` >
              `${latest.updatedAt}\u0000${latest.nodeId}`
          ? candidate
          : latest;
      }, null),
      exhausted,
    },
  };
}

async function fetchRelations(
  repo: string,
  context: Context,
): Promise<{ store: RelationStore; name: string }> {
  const name = `relations-${encodeURIComponent(repo)}`;
  const existing = await context.readResource(name);
  if (existing && existing.repo === repo && Array.isArray(existing.relations)) {
    return {
      name,
      store: { repo, relations: existing.relations as Relation[] },
    };
  }
  return { name, store: { repo, relations: [] } };
}

function parseRequest(value: string | Record<string, unknown>): Resource {
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("request must be a JSON object");
    }
    return parsed as Resource;
  }
  return value;
}

function failureKind(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("not found") || lower.includes("could not resolve")) {
    return "not_found";
  }
  if (
    lower.includes("authentication") || lower.includes("unauthorized") ||
    lower.includes("permission")
  ) return "auth";
  if (lower.includes("rate limit") || lower.includes("secondary rate")) {
    return "rate_limited";
  }
  if (
    lower.includes("must be") || lower.includes("invalid") ||
    lower.includes("cannot") || lower.includes("may have") ||
    lower.includes("cycle") || lower.includes("duplicate")
  ) return "invalid";
  return "upstream";
}

async function existingAnswer(
  context: Context,
  name: string,
  answer: Resource,
): Promise<{ dataHandles: { name: string }[] }> {
  return { dataHandles: [await context.writeResource("answer", name, answer)] };
}

async function ensureStatusLabel(
  repo: string,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  await gh([
    "label",
    "create",
    label,
    "--repo",
    repo,
    "--color",
    "1f6feb",
    "--description",
    "Stagecraft status projection",
    "--force",
  ], signal);
}

async function replaceBodyMarker(
  repo: string,
  issue: Issue,
  replacement: string,
  signal?: AbortSignal,
): Promise<void> {
  const body = issue.body ?? "";
  const pattern = /<!-- stagecraft:type:[^\s>]+ -->/;
  const next = pattern.test(body)
    ? body.replace(pattern, replacement)
    : `${body.trim()}\n\n${replacement}\n`;
  await gh([
    "issue",
    "edit",
    String(issue.number),
    "--repo",
    repo,
    "--body",
    next,
  ], signal);
}

function assertRelationRules(
  relations: Relation[],
  relation: Relation,
): void {
  if (relation.issue === relation.to) {
    throw new Error("an issue cannot relate to itself");
  }
  if (
    relations.some((entry) =>
      entry.issue === relation.issue && entry.type === relation.type &&
      entry.to === relation.to
    )
  ) return;
  if (relation.type === "parent_of") {
    const existingParent = relations.find((entry) =>
      entry.type === "parent_of" && entry.to === relation.to &&
      entry.issue !== relation.issue
    );
    if (existingParent) throw new Error("an issue may have only one parent");
  }
  let current = relation.issue;
  for (let depth = 0; depth < 10; depth += 1) {
    if (current === relation.to) {
      throw new Error("relation would create a parent cycle");
    }
    const parent = relations.find((entry) =>
      entry.type === "parent_of" && entry.to === current
    );
    if (!parent) break;
    current = parent.issue;
  }
  if (relation.type === "duplicate_of") {
    if (
      relations.some((entry) =>
        entry.type === "duplicate_of" && entry.issue === relation.issue
      )
    ) {
      throw new Error("an issue may have only one duplicate primary");
    }
    if (
      relations.some((entry) =>
        entry.type === "duplicate_of" && entry.issue === relation.to
      )
    ) {
      throw new Error("a duplicate's primary cannot itself be a duplicate");
    }
    if (
      relations.some((entry) =>
        entry.type === "duplicate_of" && entry.to === relation.issue
      )
    ) {
      throw new Error("a ticket with duplicates cannot become one");
    }
  }
}

async function operateOne(
  operation: string,
  request: Resource,
  context: Context,
): Promise<OperationResult> {
  const configured = await context.readResource("configuration");
  const configuredRepo = typeof configured?.repo === "string"
    ? configured.repo
    : undefined;
  const repo = requestRepo(request, configuredRepo);
  const relations = await fetchRelations(repo, context);
  switch (operation) {
    case "fetch_issue": {
      const issue = await fetchIssue(repo, issueNumber(request.issue));
      return { result: ticket(repo, issue, relations.store.relations) };
    }
    case "enumerate_issues": {
      const after = request.after === undefined || request.after === null
        ? undefined
        : text(request.after, "request.after");
      const limit = request.limit;
      if (
        !Number.isInteger(limit) || typeof limit !== "number" || limit <= 0 ||
        limit > 100
      ) {
        throw new Error("request.limit must be an integer from 1 through 100");
      }
      const page = await enumerateIssues(repo, after, limit);
      return {
        result: {
          // The immutable node ID rides on each ticket so a caller can build
          // links without matching a flat list to the tickets by position.
          issues: page.issues.map((issue) => ({
            ...ticket(repo, issue, relations.store.relations, true),
            nodeId: String((issue as Resource).id),
          })),
          checkpoint: page.checkpoint,
        },
      };
    }
    case "create": {
      const title = text(request.title, "request.title");
      const body = text(request.body, "request.body");
      const issueType = text(request.type, "request.type");
      if (!issueTypes.has(issueType)) {
        throw new Error(
          `invalid issue type '${issueType}': bug, feature, package, task`,
        );
      }
      const idempotency = marker(
        "create",
        text(request.idempotencyKey, "request.idempotencyKey"),
      );
      const existing = await gh([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--search",
        idempotency,
        "--json",
        "number,title,body,state,labels,comments,url,createdAt,updatedAt,assignees",
      ]) as Issue[];
      if (existing.length > 0) {
        return { result: ticket(repo, existing[0], relations.store.relations) };
      }
      const created = await gh([
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        title,
        "--body",
        `${body.trim()}\n\n${typeMarker(issueType)}\n${idempotency}`,
      ]);
      const url = String(created);
      const match = /\/issues\/(\d+)\s*$/.exec(url);
      if (!match) throw new Error(`could not parse created issue URL: ${url}`);
      const issue = await fetchIssue(repo, Number(match[1]));
      return { result: ticket(repo, issue, relations.store.relations) };
    }
    case "comment": {
      const number = issueNumber(request.issue);
      const body = text(request.body, "request.body");
      const idempotencyKey = text(
        request.idempotencyKey,
        "request.idempotencyKey",
      );
      const issue = await fetchIssue(repo, number);
      const idempotency = marker("comment", idempotencyKey);
      const prior = (issue.comments ?? []).find((comment) =>
        comment.body?.includes(idempotency)
      );
      if (prior) {
        return { result: { id: prior.id, url: prior.url, changed: false } };
      }
      const result = await gh([
        "issue",
        "comment",
        String(number),
        "--repo",
        repo,
        "--body",
        `${body}\n\n${idempotency}`,
      ]);
      const updated = await fetchIssue(repo, number);
      const posted = (updated.comments ?? []).find((comment) =>
        comment.body?.includes(idempotency)
      );
      if (posted?.id === undefined) {
        throw new Error(
          `GitHub did not return the created comment: ${String(result)}`,
        );
      }
      return {
        result: {
          id: String(posted.id),
          url: posted.url,
          changed: true,
        },
      };
    }
    case "set_status": {
      const number = issueNumber(request.issue);
      const status = text(request.status, "request.status");
      if (!issueStatuses.has(status)) {
        throw new Error(
          `invalid status '${status}': open, status:in-progress, status:done, closed`,
        );
      }
      const issue = await fetchIssue(repo, number);
      const current = statusName(issue);
      if (current === status) {
        return {
          result: { changed: false, status: { id: status, name: status } },
        };
      }
      const label = status.startsWith("status:") ? status : undefined;
      const desiredState = status === "open" || status === "status:in-progress"
        ? "OPEN"
        : "CLOSED";
      for (
        const old of labelNames(issue).filter((name) =>
          ownedStatusLabels.has(name) && name !== label
        )
      ) {
        await gh([
          "issue",
          "edit",
          String(number),
          "--repo",
          repo,
          "--remove-label",
          old,
        ]);
      }
      if ((issue.state || "").toUpperCase() !== desiredState) {
        await gh([
          "issue",
          desiredState === "OPEN" ? "reopen" : "close",
          String(number),
          "--repo",
          repo,
        ]);
      }
      if (label !== undefined) {
        await ensureStatusLabel(repo, label);
        await gh([
          "issue",
          "edit",
          String(number),
          "--repo",
          repo,
          "--add-label",
          label,
        ]);
      }
      return {
        result: { changed: true, status: { id: status, name: status } },
      };
    }
    case "set_type": {
      const number = issueNumber(request.issue);
      const issueType = text(request.type, "request.type");
      if (!issueTypes.has(issueType)) {
        throw new Error(
          `invalid issue type '${issueType}': bug, feature, package, task`,
        );
      }
      const issue = await fetchIssue(repo, number);
      if (parseType(issue.body ?? "") === issueType) {
        return { result: { changed: false, type: issueType } };
      }
      await replaceBodyMarker(repo, issue, typeMarker(issueType));
      return { result: { changed: true, type: issueType } };
    }
    case "relate":
    case "unrelate": {
      const relationType = request.type;
      if (
        ![
          "parent_of",
          "blocked_by",
          "related_to",
          "duplicate_of",
        ].includes(String(relationType))
      ) throw new Error("invalid relation type");
      const relation: Relation = {
        issue: stableId(repo, issueNumber(request.issue)),
        type: relationType as Relation["type"],
        to: stableId(repo, issueNumber(request.to)),
      };
      await fetchIssue(repo, issueNumber(request.issue));
      await fetchIssue(repo, issueNumber(request.to));
      const existingIndex = relations.store.relations.findIndex((entry) =>
        entry.issue === relation.issue && entry.type === relation.type &&
        entry.to === relation.to
      );
      if (operation === "relate") {
        if (existingIndex >= 0) return { result: { changed: false } };
        assertRelationRules(relations.store.relations, relation);
        relations.store.relations.push(relation);
      } else {
        if (existingIndex < 0) return { result: { changed: false } };
        relations.store.relations.splice(existingIndex, 1);
      }
      const handle = await context.writeResource(
        "githubRelations",
        relations.name,
        relations.store,
      );
      return { result: { changed: true }, internalHandles: [handle] };
    }
    default:
      throw new Error(`unsupported operation: ${operation}`);
  }
}

/**
 * Stagecraft-compatible GitHub Issues tracker extension.
 *
 * Use `configure` to set a default repository, `preflight` to check access,
 * `describe` to publish the tracker contract, and `operate` for idempotent
 * issue and relation operations.
 */
export const extension = {
  type: "@webframp/github",
  resources: {
    description: {
      description: "Stagecraft tracker contract description for GitHub Issues.",
      schema: z.object({
        tracker: z.string(),
        contract: z.literal(1),
        origin: z.literal("snapshot"),
        capabilities: z.object({
          history: z.boolean(),
          assign: z.boolean(),
          pullRequests: z.boolean(),
        }),
        closesDuplicates: z.boolean(),
      }),
      lifetime: "infinite",
      garbageCollection: 1,
    },
    configuration: {
      description:
        "Default repository for operations without an issue reference.",
      schema: z.object({
        repo: repoSchema,
      }),
      lifetime: "infinite",
      garbageCollection: 1,
    },
    preflight: {
      description: "Read-only authentication and repository capability check.",
      schema: z.object({
        repo: repoSchema,
        repository: z.string(),
        viewerPermission: z.string(),
        supportedStatuses: z.array(z.string()),
        existingStatusLabels: z.array(z.string()),
        supportedIssueTypes: z.array(z.string()),
        checkedAt: z.string(),
      }),
      lifetime: "15m",
      garbageCollection: 5,
    },
    githubRelations: {
      description: "Local relation state for GitHub issues.",
      schema: z.object({
        repo: repoSchema,
        relations: z.array(z.object({
          issue: z.string(),
          type: z.enum([
            "parent_of",
            "blocked_by",
            "related_to",
            "duplicate_of",
          ]),
          to: z.string(),
        })),
      }),
      lifetime: "infinite",
      garbageCollection: 100,
    },
    intakeState: {
      description:
        "Committed GitHub intake checkpoint and issue links for one repository.",
      schema: z.object({
        repo: repoSchema,
        after: z.string().nullable(),
        emitted: z.array(z.string()),
        links: z.array(z.object({
          stableId: z.string().min(1),
          nodeId: z.string().min(1),
          key: z.string().min(1),
        })),
      }),
      lifetime: "infinite",
      garbageCollection: 100,
    },
    intakeCheck: {
      description: "Result of the latest read-only intake page check.",
      schema: z.object({
        repo: repoSchema,
        status: z.enum(["fresh", "committed"]),
        nextAfter: z.string().min(1),
      }),
      lifetime: "1h",
      garbageCollection: 5,
    },
    wipLease: {
      description:
        "The global implementation WIP lease. The epoch only ever increases.",
      schema: z.object({
        epoch: z.number().int().nonnegative(),
        holder: z.string().nullable(),
        acquiredAt: z.string().nullable(),
        reason: z.string().nullable(),
      }),
      lifetime: "infinite",
      garbageCollection: 100,
    },
    priorityOverrides: {
      description: "Append-only journal of maintainer priority overrides.",
      schema: z.object({
        entries: z.array(z.object({
          item: z.string().min(1),
          by: z.string().min(1),
          reason: z.string().min(1),
          from: z.enum(["P0", "P1", "P2", "P3"]),
          to: z.enum(["P0", "P1", "P2", "P3"]),
          at: z.string(),
        })),
      }),
      lifetime: "infinite",
      garbageCollection: 100,
    },
    pauseRecord: {
      description: "Why and from where an item was paused, and how it resumed.",
      schema: z.object({
        id: z.string().min(1),
        item: z.string().min(1),
        pausedBy: z.string().min(1),
        reason: z.string().min(1),
        priorState: z.enum(lifecycleStates),
        pausedAt: z.string(),
        resumedAt: z.string().optional(),
        resumedBy: z.string().optional(),
        restoredState: z.enum(lifecycleStates).optional(),
      }),
      lifetime: "infinite",
      garbageCollection: 100,
    },
    deliveryUnits: {
      description:
        "A parent work item and its repository-specific child delivery units.",
      schema: z.object({
        parent: z.string().min(1),
        children: z.array(z.object({
          id: z.string().min(1),
          repository: repoSchema,
          baseRef: z.string().min(1),
          allowedPaths: z.array(z.string().min(1)),
          workflow: z.string().min(1),
          dependencies: z.array(z.string().min(1)),
          branch: z.string().optional(),
          pr: z.string().optional(),
          testAttestation: z.string().optional(),
          ciConclusion: z.string().optional(),
        })),
      }),
      lifetime: "infinite",
      garbageCollection: 100,
    },
    readyQueue: {
      description:
        "Items whose plan is approved and that are waiting for the WIP lease.",
      schema: z.object({
        entries: z.array(z.object({
          item: z.string().min(1),
          stableId: z.string().min(1),
          createdAt: z.string().min(1),
          computed: z.enum(["P0", "P1", "P2", "P3"]),
        })),
      }),
      lifetime: "infinite",
      garbageCollection: 100,
    },
    nextReady: {
      description:
        "The item the scheduler should lease next. Written by the read-only next_ready.",
      schema: z.object({
        item: z.string().nullable(),
        stableId: z.string().nullable(),
        priority: z.enum(["P0", "P1", "P2", "P3"]).nullable(),
        queued: z.number().int().nonnegative(),
      }),
      lifetime: "1h",
      garbageCollection: 5,
    },
    interventions: {
      description:
        "Discrepancies reconcile found and will not repair, for a person to resolve.",
      schema: z.object({
        entries: z.array(z.object({
          key: z.string().min(1),
          stableId: z.string().min(1),
          kind: z.string().min(1),
          detail: z.string().min(1),
          recordedAt: z.string(),
          resolvedAt: z.string().optional(),
          resolvedBy: z.string().optional(),
        })),
      }),
      lifetime: "infinite",
      garbageCollection: 100,
    },
    answer: {
      description: "Idempotent stagecraft tracker operation answer.",
      schema: z.object({
        operation: z.string(),
        run: z.string(),
        ok: z.boolean(),
        result: z.unknown(),
        kind: z.string().optional(),
        detail: z.string().optional(),
      }),
      lifetime: "infinite",
      garbageCollection: 200,
    },
  },
  methods: [{
    preflight: {
      description:
        "Check GitHub authentication, repository access, and tracker capabilities.",
      arguments: z.object({ repo: repoSchema }).strict(),
      execute: async (args: { repo: string }, context: Context) => {
        const repository = await gh([
          "repo",
          "view",
          args.repo,
          "--json",
          "name,viewerPermission",
        ], context.signal) as Resource;
        const labels = await gh([
          "label",
          "list",
          "--repo",
          args.repo,
          "--limit",
          "100",
          "--json",
          "name",
        ], context.signal) as unknown;
        const existingStatusLabels = Array.isArray(labels)
          ? labels.flatMap((label) =>
            typeof label === "object" && label !== null &&
              typeof (label as Resource).name === "string"
              ? [(label as Resource).name as string]
              : []
          ).filter((name) => name.startsWith("status:"))
          : [];
        const viewerPermission = typeof repository.viewerPermission === "string"
          ? repository.viewerPermission
          : "unknown";
        const handle = await context.writeResource(
          "preflight",
          "preflight",
          {
            repo: args.repo,
            repository: typeof repository.name === "string"
              ? repository.name
              : args.repo,
            viewerPermission,
            supportedStatuses: [...issueStatuses],
            existingStatusLabels,
            supportedIssueTypes: [...issueTypes],
            checkedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    configure: {
      description:
        "Configure the default GitHub repository for this tracker instance.",
      arguments: z.object({ repo: repoSchema }).strict(),
      execute: async (args: { repo: string }, context: Context) => {
        const handle = await context.writeResource(
          "configuration",
          "configuration",
          { repo: args.repo },
        );
        return { dataHandles: [handle] };
      },
    },
    acquire_lease: {
      description:
        "Acquire the global WIP lease if it is free. Returns the new, higher epoch.",
      arguments: z.object({ holder: z.string().min(1) }).strict(),
      execute: async (args: { holder: string }, context: Context) => {
        const next = decideAcquire(
          await context.readResource(leaseName),
          args.holder,
          new Date().toISOString(),
        );
        return {
          dataHandles: [
            await context.writeResource("wipLease", leaseName, next),
          ],
        };
      },
    },
    release_lease: {
      description:
        "Release the WIP lease. Requires the matching holder and epoch.",
      arguments: z.object({
        holder: z.string().min(1),
        epoch: z.number().int().positive(),
        reason: z.string().min(1),
      }).strict(),
      execute: async (
        args: { holder: string; epoch: number; reason: string },
        context: Context,
      ) => {
        const next = decideRelease(
          await context.readResource(leaseName),
          args.holder,
          args.epoch,
          args.reason,
        );
        return {
          dataHandles: [
            await context.writeResource("wipLease", leaseName, next),
          ],
        };
      },
    },
    interrupt_lease: {
      description:
        "Release the WIP lease because work was interrupted, recording why.",
      arguments: z.object({
        holder: z.string().min(1),
        epoch: z.number().int().positive(),
        reason: z.string().min(1),
      }).strict(),
      execute: async (
        args: { holder: string; epoch: number; reason: string },
        context: Context,
      ) => {
        const next = decideRelease(
          await context.readResource(leaseName),
          args.holder,
          args.epoch,
          `interrupted: ${args.reason}`,
        );
        return {
          dataHandles: [
            await context.writeResource("wipLease", leaseName, next),
          ],
        };
      },
    },
    check_lease: {
      description:
        "Fail with lease-fenced unless the holder and epoch are the current lease.",
      arguments: z.object({
        holder: z.string().min(1),
        epoch: z.number().int().positive(),
      }).strict(),
      execute: async (
        args: { holder: string; epoch: number },
        context: Context,
      ) => {
        const lease = readLease(await context.readResource(leaseName));
        if (lease.holder !== args.holder || lease.epoch !== args.epoch) {
          throw new Error(
            "lease-fenced: holder or epoch does not match the current lease",
          );
        }
        return {
          dataHandles: [
            await context.writeResource("wipLease", leaseName, lease),
          ],
        };
      },
    },
    set_override: {
      description:
        "Record a maintainer priority override. The journal is append-only. The old value is the item's last override, or the priority the caller supplies as computed when there is none.",
      arguments: z.object({
        item: z.string().min(1),
        by: z.string().min(1),
        reason: z.string().min(1),
        computed: z.enum(["P0", "P1", "P2", "P3"]),
        to: z.enum(["P0", "P1", "P2", "P3"]),
      }).strict(),
      execute: async (
        args: {
          item: string;
          by: string;
          reason: string;
          computed: Priority;
          to: Priority;
        },
        context: Context,
      ) => {
        const stored = await context.readResource(overridesName);
        const entries = Array.isArray(stored?.entries)
          ? stored.entries as OverrideEntry[]
          : [];
        const entry = decideOverride(entries, args, new Date().toISOString());
        return {
          dataHandles: [
            await context.writeResource("priorityOverrides", overridesName, {
              entries: [...entries, entry],
            }),
          ],
        };
      },
    },
    pause_item: {
      description:
        "Pause an item, recording who, why and the state it was paused from. Releases the WIP lease if the item holds it. Calling it again for an already paused item only repairs a stuck lease.",
      arguments: z.object({
        item: z.string().min(1),
        pausedBy: z.string().min(1),
        reason: z.string().min(1),
        priorState: z.enum(lifecycleStates),
      }).strict(),
      execute: async (
        args: {
          item: string;
          pausedBy: string;
          reason: string;
          priorState: LifecycleState;
        },
        context: Context,
      ) => {
        const name = pauseName(args.item);
        const existing = activePause(await context.readResource(name));
        // The pause record is written first. If releasing the lease then fails,
        // the item is paused and the lease is stuck, which keeps the WIP limit
        // and is repaired by calling pause_item again. The other order could
        // leave a working item with no lease.
        let handle: { name: string };
        if (existing !== null) {
          handle = { name };
        } else {
          const at = new Date().toISOString();
          const record: PauseRecord = {
            id: await pauseDigest([
              args.item,
              args.pausedBy,
              args.reason,
              args.priorState,
              at,
            ]),
            item: args.item,
            pausedBy: args.pausedBy,
            reason: args.reason,
            priorState: args.priorState,
            pausedAt: at,
          };
          handle = await context.writeResource("pauseRecord", name, record);
        }
        const released = releaseLeaseForPause(
          await context.readResource(leaseName),
          args.item,
        );
        const handles = [handle];
        if (released !== null) {
          handles.push(
            await context.writeResource("wipLease", leaseName, released),
          );
        }
        return { dataHandles: handles };
      },
    },
    resume_item: {
      description:
        "Resume a paused item. Needs the pause id the approval was given for.",
      arguments: z.object({
        item: z.string().min(1),
        pauseId: z.string().min(1),
        resumedBy: z.string().min(1),
      }).strict(),
      execute: async (
        args: { item: string; pauseId: string; resumedBy: string },
        context: Context,
      ) => {
        const name = pauseName(args.item);
        const next = decideResume(
          await context.readResource(name),
          args.pauseId,
          args.resumedBy,
          new Date().toISOString(),
        );
        return {
          dataHandles: [
            await context.writeResource("pauseRecord", name, next),
          ],
        };
      },
    },
    set_delivery_units: {
      description:
        "Store and validate a parent's repository-specific delivery units.",
      arguments: z.object({
        parent: z.string().min(1),
        children: z.array(z.object({
          id: z.string().min(1),
          repository: repoSchema,
          baseRef: z.string().min(1),
          allowedPaths: z.array(z.string().min(1)),
          workflow: z.string().min(1),
          dependencies: z.array(z.string().min(1)),
          branch: z.string().optional(),
          pr: z.string().optional(),
          testAttestation: z.string().optional(),
          ciConclusion: z.string().optional(),
        })),
      }).strict(),
      execute: async (
        args: { parent: string; children: DeliveryChild[] },
        context: Context,
      ) => {
        validateDeliveryUnits(args.children);
        return {
          dataHandles: [
            await context.writeResource(
              "deliveryUnits",
              deliveryName(args.parent),
              args,
            ),
          ],
        };
      },
    },
    enqueue_item: {
      description:
        "Queue an item whose plan is approved. Idempotent for an item already queued.",
      arguments: z.object({
        item: z.string().min(1),
        stableId: z.string().min(1),
        createdAt: z.string().min(1),
        facts: z.object({
          securityConfirmed: z.boolean().optional(),
          releaseBlockingRegression: z.boolean().optional(),
          supportedUserRegression: z.boolean().optional(),
          requiredUpdate: z.boolean().optional(),
          reproducibleBug: z.boolean().optional(),
          acceptedMaintenance: z.boolean().optional(),
        }).strict(),
      }).strict(),
      execute: async (
        args: {
          item: string;
          stableId: string;
          createdAt: string;
          facts: PriorityFacts;
        },
        context: Context,
      ) => {
        const stored = await context.readResource(queueName);
        const queue = Array.isArray(stored?.entries)
          ? stored.entries as ReadyEntry[]
          : [];
        const next = decideEnqueue(queue, {
          item: args.item,
          stableId: args.stableId,
          createdAt: args.createdAt,
          computed: computePriority(args.facts),
        });
        return {
          dataHandles: [
            await context.writeResource("readyQueue", queueName, {
              entries: next ?? queue,
            }),
          ],
        };
      },
    },
    dequeue_item: {
      description:
        "Remove an item from the ready queue. Idempotent for an item that is not queued.",
      arguments: z.object({ item: z.string().min(1) }).strict(),
      execute: async (args: { item: string }, context: Context) => {
        const stored = await context.readResource(queueName);
        const queue = Array.isArray(stored?.entries)
          ? stored.entries as ReadyEntry[]
          : [];
        const next = decideDequeue(queue, args.item);
        return {
          dataHandles: [
            await context.writeResource("readyQueue", queueName, {
              entries: next ?? queue,
            }),
          ],
        };
      },
    },
    next_ready: {
      description:
        "Report the item to lease next, by effective priority, then age, then stable issue ID. Does not change the queue.",
      arguments: z.object({}).strict(),
      execute: async (_args: Record<string, never>, context: Context) => {
        const stored = await context.readResource(queueName);
        const queue = Array.isArray(stored?.entries)
          ? stored.entries as ReadyEntry[]
          : [];
        const overrides = await context.readResource(overridesName);
        const journal = Array.isArray(overrides?.entries)
          ? overrides.entries as OverrideEntry[]
          : [];
        const picked = nextReady(queue, journal);
        return {
          dataHandles: [
            await context.writeResource("nextReady", nextReadyName, {
              item: picked?.entry.item ?? null,
              stableId: picked?.entry.stableId ?? null,
              priority: picked?.priority ?? null,
              queued: queue.length,
            }),
          ],
        };
      },
    },
    record_intervention: {
      description:
        "Record a discrepancy for a person. Idempotent while an identical record is unresolved.",
      arguments: z.object({
        stableId: z.string().min(1),
        kind: z.string().min(1),
        detail: z.string().min(1),
      }).strict(),
      execute: async (
        args: { stableId: string; kind: string; detail: string },
        context: Context,
      ) => {
        const stored = await context.readResource(interventionsName);
        const journal = Array.isArray(stored?.entries)
          ? stored.entries as Intervention[]
          : [];
        const next = decideIntervention(
          journal,
          args,
          new Date().toISOString(),
        );
        return {
          dataHandles: [
            await context.writeResource("interventions", interventionsName, {
              entries: next ?? journal,
            }),
          ],
        };
      },
    },
    resolve_intervention: {
      description:
        "Mark an open intervention resolved, recording who. Idempotent for one that is not open.",
      arguments: z.object({
        key: z.string().min(1),
        by: z.string().min(1),
      }).strict(),
      execute: async (args: { key: string; by: string }, context: Context) => {
        const stored = await context.readResource(interventionsName);
        const journal = Array.isArray(stored?.entries)
          ? stored.entries as Intervention[]
          : [];
        const next = decideResolve(
          journal,
          args.key,
          args.by,
          new Date().toISOString(),
        );
        return {
          dataHandles: [
            await context.writeResource("interventions", interventionsName, {
              entries: next ?? journal,
            }),
          ],
        };
      },
    },
    check_intake: {
      description:
        "Read-only. Report whether a page is fresh, already committed, or stale, before any claim writes a reservation.",
      arguments: z.object({
        repo: repoSchema,
        expectedAfter: z.string().nullable(),
        nextAfter: z.string().min(1),
      }).strict(),
      execute: async (
        args: { repo: string; expectedAfter: string | null; nextAfter: string },
        context: Context,
      ) => {
        const stored = await context.readResource(
          `intake-${encodeURIComponent(args.repo)}`,
        );
        const status = checkIntakePage(stored, args);
        const handle = await context.writeResource(
          "intakeCheck",
          // A fixed name, so a workflow can read the result without having to
          // build a repo-specific name, which its expression language cannot.
          "intake-check",
          { repo: args.repo, status, nextAfter: args.nextAfter },
        );
        return { dataHandles: [handle] };
      },
    },
    promote_intake: {
      description:
        "Atomically commit one enumerated page's links and opaque checkpoint, only if the stored checkpoint equals the page's predecessor.",
      arguments: z.object({
        repo: repoSchema,
        expectedAfter: z.string().nullable(),
        nextAfter: z.string().min(1),
        emitted: z.array(z.string().min(1)),
        links: z.array(z.object({
          stableId: z.string().min(1),
          nodeId: z.string().min(1),
          key: z.string().min(1),
        })),
      }).strict(),
      execute: async (
        args: {
          repo: string;
          expectedAfter: string | null;
          nextAfter: string;
          emitted: string[];
          links: IntakeLink[];
        },
        context: Context,
      ) => {
        const name = `intake-${encodeURIComponent(args.repo)}`;
        const stored = await context.readResource(name);
        const decision = decideIntakePromotion(stored, args);
        // A redelivered page changes nothing. Rewrite the stored state as is so
        // the runtime gets a real resource handle rather than a bare name.
        const handle = await context.writeResource(
          "intakeState",
          name,
          decision.kind === "noop" ? stored : decision.state,
        );
        return { dataHandles: [handle] };
      },
    },
    describe: {
      description:
        "Describe the GitHub Issues tracker contract for stagecraft.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Context) => {
        const handle = await context.writeResource(
          "description",
          "description",
          {
            tracker: "github",
            contract: 1,
            origin: "snapshot",
            capabilities: {
              history: false,
              assign: false,
              pullRequests: false,
            },
            closesDuplicates: false,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    operate: {
      description:
        "Perform one idempotent stagecraft operation against GitHub Issues.",
      arguments: z.object({
        operation: operationSchema,
        request: z.union([z.string(), z.record(z.string(), z.unknown())]),
        answer: answerNameSchema,
        run: z.string().min(1),
      }).strict(),
      execute: async (
        args: {
          operation: z.infer<typeof operationSchema>;
          request: string | Record<string, unknown>;
          answer: string;
          run: string;
        },
        context: Context,
      ) => {
        const existing = await context.readResource(args.answer);
        // A successful answer is an idempotency receipt. A failed upstream
        // request is not: retaining it would make a transient GitHub failure
        // permanently unretryable under the same publisher delivery key.
        if (existing?.ok === true) {
          return await existingAnswer(context, args.answer, existing);
        }
        let answer: Resource;
        let internalHandles: { name: string }[] = [];
        try {
          const request = parseRequest(args.request);
          if (
            (args.operation === "create" || args.operation === "comment") &&
            typeof request.idempotencyKey !== "string"
          ) {
            request.idempotencyKey = `run-${args.run}-${args.answer}`;
          }
          const result = await operateOne(args.operation, request, context);
          internalHandles = result.internalHandles ?? [];
          answer = {
            operation: args.operation,
            run: args.run,
            ok: true,
            result: result.result,
          };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          answer = {
            operation: args.operation,
            run: args.run,
            ok: false,
            kind: failureKind(error),
            detail,
            result: null,
          };
          context.logger.warning("GitHub tracker operation failed: {detail}", {
            detail,
          });
        }
        return {
          dataHandles: [
            ...internalHandles,
            await context.writeResource("answer", args.answer, answer),
          ],
        };
      },
    },
  }],
};
