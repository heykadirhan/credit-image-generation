import { v } from "convex/values";
import type { Model } from "../shared/models/define";
import { findModel } from "../shared/models/catalog";
import { GENERATION_DEADLINE_MS, MAX_PROMPT_LENGTH } from "../shared/limits";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type QueryCtx } from "./_generated/server";
import { requireMember } from "./lib/auth";
import { applyLedgerEntryOnce } from "./lib/credits";
import { fail } from "./lib/errors";
import { limitsFor, openGenerations, promoteWaiting, scheduleRun } from "./lib/queue";
import { generationStatus, paramsValidator } from "./schema";

type Reader = Pick<QueryCtx, "db">;

export const submitGeneration = mutation({
  args: {
    clientRequestId: v.string(),
    modelId: v.string(),
    params: paramsValidator,
    prompt: v.string(),
    inputUploadIds: v.array(v.id("uploads")),
    expectedPriceCredits: v.number(),
  },
  returns: v.object({
    generationId: v.id("generations"),
    status: generationStatus,
    priceCredits: v.number(),
    balanceAfter: v.number(),
  }),
  handler: async (ctx, args) => {
    const { user, workspace } = await requireMember(ctx);

    const previous = await ctx.db
      .query("generations")
      .withIndex("by_user_request", (q) =>
        q.eq("userId", user._id).eq("clientRequestId", args.clientRequestId),
      )
      .unique();
    if (previous) {
      return {
        generationId: previous._id,
        status: previous.status,
        priceCredits: previous.priceCredits,
        balanceAfter: workspace.creditBalance,
      };
    }

    const model = findModel(args.modelId);
    if (!model) fail("UNKNOWN_MODEL");
    if (!(await isAvailable(ctx, model, workspace))) fail("MODEL_UNAVAILABLE");

    const quote = model.quote(args.params);
    if (!quote.ok) fail("INVALID_PARAMS", { issues: quote.issues });

    const prompt = args.prompt.trim();
    if ((model.promptRequired && prompt.length === 0) || prompt.length > MAX_PROMPT_LENGTH) {
      fail("INVALID_PROMPT");
    }

    await assertUsableUploads(ctx, workspace._id, args.inputUploadIds, model);

    if (quote.priceCredits !== args.expectedPriceCredits) {
      fail("PRICE_CHANGED", { priceCredits: quote.priceCredits });
    }
    // A parallel submit from the same workspace reads this same balance, so Convex reruns one of them.
    if (workspace.creditBalance < quote.priceCredits) {
      fail("INSUFFICIENT_CREDITS", {
        priceCredits: quote.priceCredits,
        balance: workspace.creditBalance,
      });
    }

    await promoteWaiting(ctx, workspace);
    const status = await admissionStatus(ctx, workspace);
    const deadlineAt = status === "queued" ? Date.now() + GENERATION_DEADLINE_MS : undefined;

    const generationId = await ctx.db.insert("generations", {
      workspaceId: workspace._id,
      userId: user._id,
      clientRequestId: args.clientRequestId,
      modelId: model.id,
      pricingVersion: model.pricingVersion,
      params: quote.params,
      prompt,
      inputUploadIds: args.inputUploadIds,
      imagesRequested: quote.images,
      priceCredits: quote.priceCredits,
      priority: limitsFor(workspace).priority,
      status,
      attempt: 0,
      outputs: [],
      deadlineAt,
    });

    let balanceAfter = workspace.creditBalance;
    if (quote.priceCredits > 0) {
      const debit = await applyLedgerEntryOnce(ctx, {
        workspaceId: workspace._id,
        userId: user._id,
        amount: -quote.priceCredits,
        kind: "generation_debit",
        generationId,
        ref: `generation:${generationId}:debit`,
      });
      if (debit.applied) balanceAfter = debit.balanceAfter;
    }

    if (deadlineAt !== undefined) await scheduleRun(ctx, generationId, deadlineAt);

    return { generationId, status, priceCredits: quote.priceCredits, balanceAfter };
  },
});

export const cancelGeneration = mutation({
  args: { generationId: v.id("generations") },
  returns: v.union(v.literal("cancelled"), v.literal("too_late")),
  handler: async (ctx, { generationId }) => {
    const { workspace } = await requireMember(ctx);
    const generation = await ctx.db.get(generationId);
    if (!generation || generation.workspaceId !== workspace._id) fail("NOT_FOUND");
    if (generation.status !== "waiting") return "too_late";

    await ctx.db.patch(generationId, { status: "cancelled", finishedAt: Date.now() });
    if (generation.priceCredits > 0) {
      await applyLedgerEntryOnce(ctx, {
        workspaceId: workspace._id,
        userId: generation.userId,
        amount: generation.priceCredits,
        kind: "generation_refund",
        generationId,
        ref: `generation:${generationId}:refund`,
      });
    }
    return "cancelled";
  },
});

async function isAvailable(ctx: Reader, model: Model, workspace: Doc<"workspaces">) {
  if (!(await isSwitchedOn(ctx, `model:${model.id}`, workspace))) return false;
  for (const provider of model.providers) {
    if (await isSwitchedOn(ctx, `provider:${provider}`, workspace)) return true;
  }
  return false;
}

async function isSwitchedOn(ctx: Reader, key: string, workspace: Doc<"workspaces">) {
  const flag = await ctx.db
    .query("modelFlags")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (!flag || flag.state === "on") return true;
  return flag.state === "internal" && workspace.isInternal === true;
}

async function assertUsableUploads(
  ctx: Reader,
  workspaceId: Id<"workspaces">,
  uploadIds: Id<"uploads">[],
  model: Model,
) {
  const count = uploadIds.length;
  if (count < model.minInputImages || count > model.maxInputImages) {
    fail("INVALID_INPUT_IMAGES", { min: model.minInputImages, max: model.maxInputImages });
  }
  if (new Set(uploadIds).size !== count) fail("INVALID_INPUT_IMAGES");
  for (const uploadId of uploadIds) {
    const upload = await ctx.db.get(uploadId);
    if (!upload || upload.workspaceId !== workspaceId) fail("INVALID_INPUT_IMAGES");
  }
}

async function admissionStatus(
  ctx: Reader,
  workspace: Doc<"workspaces">,
): Promise<"queued" | "waiting"> {
  const { atOnce, inBackground } = limitsFor(workspace);
  const { active, waiting } = await openGenerations(ctx, workspace);
  if (active < atOnce && waiting === 0) return "queued";
  if (active + waiting < inBackground) return "waiting";
  fail("TOO_MANY_PENDING", { limit: inBackground });
}
