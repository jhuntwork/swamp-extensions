import { z } from "npm:zod@4.4.3";
import { applyDraft, ApplyResultSchema } from "./apply.ts";
import { DraftPlanSchema, planDraft } from "./plan.ts";
import { PacketSchema } from "./packet.ts";
import {
  preflight,
  PreflightConfigSchema,
  PreflightResultSchema,
} from "./preflight.ts";
import { VerificationSchema, verifyDraft } from "./verify.ts";

const Globals = PreflightConfigSchema;
type Context = {
  globalArgs: z.infer<typeof Globals>;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger?: {
    info: (message: string, fields?: Record<string, unknown>) => void;
  };
};

/** Narrow GitHub.com same-repository draft-PR model. It never merges or releases. */
export const model = {
  type: "@jeremy/github-draft-pr",
  version: "2026.08.18.1",
  globalArguments: Globals,
  resources: {
    preflight: {
      description: "Bound actor, repository, and base-ref evidence",
      schema: PreflightResultSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    plan: {
      description: "Read-only draft PR plan bound to packet and remote refs",
      schema: DraftPlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    applied: {
      description: "Existing or newly created draft PR identity",
      schema: ApplyResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    verification: {
      description: "Read-back proof that a draft PR matches a packet",
      schema: VerificationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    preflight: {
      description: "Read-only actor/repository/base identity check",
      arguments: z.object({}),
      execute: async (_: object, ctx: Context) => {
        ctx.logger?.info("Starting GitHub draft-PR preflight", {
          repository: ctx.globalArgs.repository,
          baseBranch: ctx.globalArgs.baseBranch,
        });
        const data = await preflight(ctx.globalArgs);
        ctx.logger?.info("Completed GitHub draft-PR preflight", {
          repository: data.repository,
          baseSha: data.baseSha,
        });
        return {
          dataHandles: [await ctx.writeResource("preflight", "current", data)],
        };
      },
    },
    planDraft: {
      description: "Read-only plan for a ready same-repository draft packet",
      arguments: z.object({ packet: PacketSchema }),
      execute: async (
        { packet }: { packet: z.infer<typeof PacketSchema> },
        ctx: Context,
      ) => {
        ctx.logger?.info("Planning GitHub draft PR", { packetId: packet.id });
        const data = await planDraft(ctx.globalArgs, packet);
        ctx.logger?.info("Planned GitHub draft PR", {
          packetId: data.packetId,
          existing: data.existingPullRequest !== null,
        });
        return {
          dataHandles: [
            await ctx.writeResource("plan", `packet-${data.packetId}`, data),
          ],
        };
      },
    },
    applyDraft: {
      description:
        "Create or recognize a matching draft PR from an approved plan; gate with workflow approval",
      arguments: z.object({ packet: PacketSchema, plan: DraftPlanSchema }),
      execute: async (
        { packet, plan }: {
          packet: z.infer<typeof PacketSchema>;
          plan: z.infer<typeof DraftPlanSchema>;
        },
        ctx: Context,
      ) => {
        ctx.logger?.info("Applying approved GitHub draft-PR plan", {
          packetId: packet.id,
        });
        const data = await applyDraft(ctx.globalArgs, packet, plan);
        ctx.logger?.info("Applied GitHub draft-PR plan", {
          packetId: packet.id,
          number: data.number,
          created: data.created,
        });
        return {
          dataHandles: [
            await ctx.writeResource("applied", `packet-${packet.id}`, data),
          ],
        };
      },
    },
    verifyDraft: {
      description: "Read back a draft PR and prove it matches a packet",
      arguments: z.object({ packet: PacketSchema, result: ApplyResultSchema }),
      execute: async (
        { packet, result }: {
          packet: z.infer<typeof PacketSchema>;
          result: z.infer<typeof ApplyResultSchema>;
        },
        ctx: Context,
      ) => {
        ctx.logger?.info("Verifying GitHub draft-PR read-back", {
          packetId: packet.id,
          number: result.number,
        });
        const data = await verifyDraft(ctx.globalArgs, packet, result);
        ctx.logger?.info("Verified GitHub draft-PR read-back", {
          packetId: packet.id,
          number: data.number,
        });
        return {
          dataHandles: [
            await ctx.writeResource(
              "verification",
              `packet-${packet.id}`,
              data,
            ),
          ],
        };
      },
    },
  },
};
