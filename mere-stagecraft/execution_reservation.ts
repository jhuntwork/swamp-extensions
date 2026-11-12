/** Execution reservation for one Stagecraft work item. @module */
import { z } from "npm:zod@4.6.7";

const Identity = z.object({
  owner: z.string().min(1),
  era: z.string().min(1),
  stage: z.string().min(1),
  cycle: z.number().int().positive(),
});
const Reservation = Identity.extend({
  epoch: z.number().int().positive(),
  held: z.boolean(),
});
type Identity = z.infer<typeof Identity>;
type Reservation = z.infer<typeof Reservation>;
type Context = {
  readResource(name: string): Promise<unknown>;
  writeResource(
    spec: string,
    name: string,
    value: unknown,
  ): Promise<{ name: string }>;
};

function sameIdentity(a: Identity, b: Identity) {
  return a.owner === b.owner && a.era === b.era && a.stage === b.stage &&
    a.cycle === b.cycle;
}

/** Pure state transitions; Swamp's per-instance lock serializes their writes. */
export function acquire(
  previous: Reservation | null,
  identity: Identity,
): Reservation {
  if (previous?.held) {
    if (sameIdentity(previous, identity)) return previous;
    throw new Error("reservation-held");
  }
  return { ...identity, epoch: (previous?.epoch ?? 0) + 1, held: true };
}

/** Release the reservation for the matching identity and epoch; refused otherwise. */
export function release(
  previous: Reservation | null,
  identity: Identity,
  epoch: number,
): Reservation {
  if (
    !previous || previous.epoch !== epoch || !sameIdentity(previous, identity)
  ) {
    throw new Error("reservation-fenced");
  }
  return { ...previous, held: false };
}

/**
 * One execution reservation per work item, so two overlapping workflow runs
 * cannot both do the same stage's work. Create one instance per item, named
 * `<item>-reservation`. Swamp's per-instance lock serializes the writes.
 *
 * The identity is the owner (a workflow run id), the Stagecraft era, stage and
 * cycle. Acquiring is idempotent for the same identity and refused for any other
 * while held. Release needs the matching identity and the epoch, so a stale
 * holder cannot release a later owner's reservation. There is no age-based
 * takeover and no force release: a reservation held by a dead run is recovered
 * by resuming that run, never by stealing it.
 */
export const model = {
  type: "@jeremy/mere-stagecraft/execution-reservation",
  version: "2026.11.12.3",
  globalArguments: z.object({}),
  resources: {
    reservation: {
      schema: Reservation,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    acquire: {
      description:
        "Reserve an item execution, or return the same owner's reservation",
      arguments: Identity,
      execute: async (args: Identity, ctx: Context) => {
        const raw = await ctx.readResource("reservation");
        const previous = raw == null ? null : Reservation.parse(raw);
        const next = acquire(previous, args);
        if (next === previous) return { dataHandles: [] };
        const handle = await ctx.writeResource(
          "reservation",
          "reservation",
          next,
        );
        return { dataHandles: [handle] };
      },
    },
    release: {
      description: "Release only the matching owner's fenced reservation",
      arguments: Identity.extend({ epoch: z.number().int().positive() }),
      execute: async (args: Identity & { epoch: number }, ctx: Context) => {
        const raw = await ctx.readResource("reservation");
        const previous = raw == null ? null : Reservation.parse(raw);
        const next = release(previous, args, args.epoch);
        if (!previous?.held) return { dataHandles: [] };
        const handle = await ctx.writeResource(
          "reservation",
          "reservation",
          next,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
