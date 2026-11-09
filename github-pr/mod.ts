import { z } from "npm:zod@4.4.3";
import { applyPr, ApplyResultSchema } from "./apply.ts";
import { planPr, PlanSchema } from "./plan.ts";
import { ChangeSchema, PacketSchema } from "./packet.ts";
import {
  preflight,
  PreflightConfigSchema,
  PreflightResultSchema,
} from "./preflight.ts";
import { VerificationSchema, verifyPr } from "./verify.ts";

const Globals = PreflightConfigSchema;
const ChangeInputSchema = z.union([ChangeSchema, PacketSchema]);

type ChangeInput = z.infer<typeof ChangeInputSchema>;

function requireChangeInput(
  change: ChangeInput | undefined,
  packet: ChangeInput | undefined,
): ChangeInput {
  const value = change ?? packet;
  if (!value) throw new Error("change is required");
  return value;
}

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
 * releases. Authentication can come from a vault-backed token or the active
 * GitHub CLI login.
 *
 * Draft is a property of the packet, not of this adapter: a packet requesting
 * `submission.draft` gets a draft, and one that does not gets an ordinary pull
 * request. The plan records which was asked for and apply refuses a plan that
 * disagrees with its packet, so the reviewed state is the created state.
 */
export const model = {
  type: "@jeremy/github-pr",
  version: "2026.11.08.3",
  globalArguments: Globals,
  upgrades: [{
    toVersion: "2026.08.21.1",
    description:
      "Permit candidate-base provenance to remain valid when the remote base branch advances before PR planning.",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => old,
  }, {
    toVersion: "2026.11.03.1",
    description:
      "Allow GitHub API calls through the authenticated gh CLI while preserving token authentication.",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => old,
  }, {
    toVersion: "2026.11.08.1",
    description:
      "Accept slim change facts and compute integrity and readiness inside the adapter while retaining legacy packet input.",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => old,
  }, {
    toVersion: "2026.11.08.2",
    description:
      "Keep slim change facts applicable to the reviewed plan without requiring a regenerated random packet identity.",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => old,
  }, {
    toVersion: "2026.11.08.3",
    description:
      "Require concise maintainer-facing PR descriptions and reject automation or pipeline boilerplate.",
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
      description:
        "Read-only plan for a ready same-repository change; integrity and readiness are computed here",
      arguments: z.object({
        change: ChangeInputSchema.optional(),
        packet: ChangeInputSchema.optional(),
      }),
      execute: async (
        { change, packet }: { change?: ChangeInput; packet?: ChangeInput },
        ctx: Context,
      ) => {
        const data = await planPr(
          ctx.globalArgs,
          requireChangeInput(change, packet),
        );
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
        "Create or recognize a matching pull request from an approved plan; integrity is recomputed here",
      arguments: z.object({
        change: ChangeInputSchema.optional(),
        packet: ChangeInputSchema.optional(),
        plan: PlanSchema,
      }),
      execute: async (
        { change, packet, plan }: {
          change?: ChangeInput;
          packet?: ChangeInput;
          plan: z.infer<typeof PlanSchema>;
        },
        ctx: Context,
      ) => {
        const input = requireChangeInput(change, packet);
        const data = await applyPr(ctx.globalArgs, input, plan);
        ctx.logger?.info("Applied GitHub PR plan", {
          packetId: plan.packetId,
          number: data.number,
          created: data.created,
          draft: data.draft,
        });
        return {
          dataHandles: [
            await ctx.writeResource("applied", `packet-${plan.packetId}`, data),
          ],
        };
      },
    },
    verifyPr: {
      description: "Read back a pull request and prove it matches a change",
      arguments: z.object({
        change: ChangeInputSchema.optional(),
        packet: ChangeInputSchema.optional(),
        result: ApplyResultSchema,
      }),
      execute: async (
        { change, packet, result }: {
          change?: ChangeInput;
          packet?: ChangeInput;
          result: z.infer<typeof ApplyResultSchema>;
        },
        ctx: Context,
      ) => {
        const data = await verifyPr(
          ctx.globalArgs,
          requireChangeInput(change, packet),
          result,
        );
        ctx.logger?.info("Verified GitHub PR read-back", {
          number: data.number,
          draft: data.draft,
        });
        return {
          dataHandles: [
            await ctx.writeResource(
              "verification",
              `pr-${result.number}`,
              data,
            ),
          ],
        };
      },
    },
  },
};
