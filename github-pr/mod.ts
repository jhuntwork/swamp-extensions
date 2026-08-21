import { z } from "npm:zod@4.4.3";
import { applyPr, ApplyResultSchema } from "./apply.ts";
import { planPr, PlanSchema } from "./plan.ts";
import { PacketSchema } from "./packet.ts";
import {
  preflight,
  PreflightConfigSchema,
  PreflightResultSchema,
} from "./preflight.ts";
import { VerificationSchema, verifyPr } from "./verify.ts";

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

/**
 * Narrow GitHub.com same-repository pull-request model. It never merges or
 * releases.
 *
 * Draft is a property of the packet, not of this adapter: a packet requesting
 * `submission.draft` gets a draft, and one that does not gets an ordinary pull
 * request. The plan records which was asked for and apply refuses a plan that
 * disagrees with its packet, so the reviewed state is the created state.
 */
export const model = {
  type: "@jeremy/github-pr",
  version: "2026.08.21.1",
  globalArguments: Globals,
  upgrades: [{
    toVersion: "2026.08.21.1",
    description:
      "Permit candidate-base provenance to remain valid when the remote base branch advances before PR planning.",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => old,
  }],
  resources: {
    preflight: {
      description: "Bound actor, repository, and base-ref evidence",
      schema: PreflightResultSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    plan: {
      description: "Read-only PR plan bound to packet and remote refs",
      schema: PlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    applied: {
      description: "Existing or newly created pull request identity",
      schema: ApplyResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    verification: {
      description: "Read-back proof that a pull request matches a packet",
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
        ctx.logger?.info("Starting GitHub PR preflight", {
          repository: ctx.globalArgs.repository,
          baseBranch: ctx.globalArgs.baseBranch,
        });
        const data = await preflight(ctx.globalArgs);
        ctx.logger?.info("Completed GitHub PR preflight", {
          repository: data.repository,
          baseSha: data.baseSha,
        });
        return {
          dataHandles: [await ctx.writeResource("preflight", "current", data)],
        };
      },
    },
    planPr: {
      description: "Read-only plan for a ready same-repository packet",
      arguments: z.object({ packet: PacketSchema }),
      execute: async (
        { packet }: { packet: z.infer<typeof PacketSchema> },
        ctx: Context,
      ) => {
        ctx.logger?.info("Planning GitHub pull request", {
          packetId: packet.id,
        });
        const data = await planPr(ctx.globalArgs, packet);
        ctx.logger?.info("Planned GitHub pull request", {
          packetId: data.packetId,
          draft: data.draft,
          existing: data.existingPullRequest !== null,
        });
        return {
          dataHandles: [
            await ctx.writeResource("plan", `packet-${data.packetId}`, data),
          ],
        };
      },
    },
    applyPr: {
      description:
        "Create or recognize a matching pull request from an approved plan; gate with workflow approval",
      arguments: z.object({ packet: PacketSchema, plan: PlanSchema }),
      execute: async (
        { packet, plan }: {
          packet: z.infer<typeof PacketSchema>;
          plan: z.infer<typeof PlanSchema>;
        },
        ctx: Context,
      ) => {
        ctx.logger?.info("Applying approved GitHub PR plan", {
          packetId: packet.id,
          draft: plan.draft,
        });
        const data = await applyPr(ctx.globalArgs, packet, plan);
        ctx.logger?.info("Applied GitHub PR plan", {
          packetId: packet.id,
          number: data.number,
          created: data.created,
          draft: data.draft,
        });
        return {
          dataHandles: [
            await ctx.writeResource("applied", `packet-${packet.id}`, data),
          ],
        };
      },
    },
    verifyPr: {
      description: "Read back a pull request and prove it matches a packet",
      arguments: z.object({ packet: PacketSchema, result: ApplyResultSchema }),
      execute: async (
        { packet, result }: {
          packet: z.infer<typeof PacketSchema>;
          result: z.infer<typeof ApplyResultSchema>;
        },
        ctx: Context,
      ) => {
        ctx.logger?.info("Verifying GitHub PR read-back", {
          packetId: packet.id,
          number: result.number,
        });
        const data = await verifyPr(ctx.globalArgs, packet, result);
        ctx.logger?.info("Verified GitHub PR read-back", {
          packetId: packet.id,
          number: data.number,
          draft: data.draft,
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
