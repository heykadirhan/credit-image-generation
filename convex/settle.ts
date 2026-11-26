import { v, type Infer } from "convex/values";
import { MAX_ATTEMPTS } from "../shared/limits";
import { generationErrors } from "../shared/providers/errors";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { applyLedgerEntryOnce } from "./lib/credits";
import { promoteWaiting } from "./lib/queue";
import { generationErrorCode, outputImage } from "./schema";

const outcomeValidator = v.union(
  v.object({
    kind: v.literal("succeeded"),
    attempt: v.number(),
    outputs: v.array(outputImage),
    costUsd: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal("failed"),
    attempt: v.number(),
    code: generationErrorCode,
    message: v.string(),
    costUsd: v.optional(v.number()),
  }),
  v.object({ kind: v.literal("timed_out") }),
);

type Outcome = Infer<typeof outcomeValidator>;

const finalStatuses = new Set(["succeeded", "partial", "failed", "cancelled"]);

export const settleGeneration = internalMutation({
  args: { generationId: v.id("generations"), outcome: outcomeValidator },
  returns: v.union(v.literal("settled"), v.literal("retrying"), v.literal("ignored")),
  handler: async (ctx, { generationId, outcome: reported }) => {
    const outcome = failIfEmpty(reported);
    const generation = await ctx.db.get(generationId);
    if (!generation || finalStatuses.has(generation.status)) return "ignored";

    const now = Date.now();
    if (outcome.kind === "timed_out") {
      if (generation.deadlineAt === undefined || now < generation.deadlineAt) return "ignored";
    } else if (generation.status === "waiting" || outcome.attempt !== generation.attempt) {
      return "ignored";
    }

    if (shouldRetry(generation, outcome, now)) {
      await ctx.db.patch(generationId, {
        status: "queued",
        attempt: generation.attempt + 1,
        provider: undefined,
        externalJobId: undefined,
      });
      await ctx.scheduler.runAfter(0, internal.runner.start, { generationId });
      return "retrying";
    }

    const outputs =
      outcome.kind === "succeeded" ? outcome.outputs.slice(0, generation.imagesRequested) : [];
    const missing = generation.imagesRequested - outputs.length;
    const status =
      missing === 0 ? "succeeded" : outputs.length > 0 ? "partial" : "failed";

    await ctx.db.patch(generationId, {
      status,
      outputs,
      finishedAt: now,
      costUsd: outcome.kind === "timed_out" ? generation.costUsd : outcome.costUsd,
      error: errorFor(outcome),
    });

    if (missing > 0 && generation.priceCredits > 0) {
      await applyLedgerEntryOnce(ctx, {
        workspaceId: generation.workspaceId,
        userId: generation.userId,
        amount: (generation.priceCredits / generation.imagesRequested) * missing,
        kind: "generation_refund",
        generationId,
        ref: `generation:${generationId}:refund`,
      });
    }

    await promoteWaitingFor(ctx, generation);
    return "settled";
  },
});

function failIfEmpty(outcome: Outcome): Outcome {
  if (outcome.kind !== "succeeded" || outcome.outputs.length > 0) return outcome;
  return {
    kind: "failed",
    attempt: outcome.attempt,
    code: "NO_OUTPUT",
    message: generationErrors.NO_OUTPUT.message,
    costUsd: outcome.costUsd,
  };
}

function shouldRetry(generation: Doc<"generations">, outcome: Outcome, now: number) {
  if (outcome.kind !== "failed" || !generationErrors[outcome.code].retryable) return false;
  if (generation.attempt + 1 >= MAX_ATTEMPTS) return false;
  return generation.deadlineAt !== undefined && now < generation.deadlineAt;
}

function errorFor(outcome: Outcome) {
  if (outcome.kind === "failed") return { code: outcome.code, message: outcome.message };
  if (outcome.kind === "timed_out") {
    return { code: "TIMED_OUT" as const, message: generationErrors.TIMED_OUT.message };
  }
  return undefined;
}

async function promoteWaitingFor(ctx: MutationCtx, generation: Doc<"generations">) {
  const workspace = await ctx.db.get(generation.workspaceId);
  if (workspace) await promoteWaiting(ctx, workspace);
}
