import { v } from "convex/values";
import type { Model } from "../shared/models/define";
import { findModel } from "../shared/models/catalog";
import {
  GENERATION_DEADLINE_MS,
  MAX_ACTIVE_PER_USER,
  MAX_OPEN_PER_USER,
  MAX_PROMPT_LENGTH,
} from "../shared/limits";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mutation, type QueryCtx } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { fail } from "./lib/errors";
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
    const user = await requireUser(ctx);

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
        balanceAfter: user.creditBalance,
      };
    }

    const model = findModel(args.modelId);
    if (!model) fail("UNKNOWN_MODEL");
    if (!(await isAvailable(ctx, model))) fail("MODEL_UNAVAILABLE");

    const quote = model.quote(args.params);
    if (!quote.ok) fail("INVALID_PARAMS", { issues: quote.issues });

    const prompt = args.prompt.trim();
    if (prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH) fail("INVALID_PROMPT");

    await assertUsableUploads(ctx, user._id, args.inputUploadIds, model);

    if (quote.priceCredits !== args.expectedPriceCredits) {
      fail("PRICE_CHANGED", { priceCredits: quote.priceCredits });
    }
    // A parallel submit reads this same balance, so Convex reruns one of them against the new value.
    if (user.creditBalance < quote.priceCredits) {
      fail("INSUFFICIENT_CREDITS", {
        priceCredits: quote.priceCredits,
        balance: user.creditBalance,
      });
    }

    const status = await admissionStatus(ctx, user._id);
    const now = Date.now();

    const generationId = await ctx.db.insert("generations", {
      userId: user._id,
      clientRequestId: args.clientRequestId,
      modelId: model.id,
      pricingVersion: model.pricingVersion,
      params: quote.params,
      prompt,
      inputUploadIds: args.inputUploadIds,
      imagesRequested: quote.images,
      priceCredits: quote.priceCredits,
      status,
      attempt: 0,
      outputs: [],
      deadlineAt: status === "queued" ? now + GENERATION_DEADLINE_MS : undefined,
    });

    const balanceAfter = user.creditBalance - quote.priceCredits;
    await ctx.db.patch(user._id, { creditBalance: balanceAfter });
    await ctx.db.insert("creditLedger", {
      userId: user._id,
      amount: -quote.priceCredits,
      kind: "generation_debit",
      generationId,
      ref: `generation:${generationId}:debit`,
    });

    if (status === "queued") {
      await ctx.scheduler.runAfter(0, internal.runner.start, { generationId });
    }

    return { generationId, status, priceCredits: quote.priceCredits, balanceAfter };
  },
});

async function isAvailable(ctx: Reader, model: Model) {
  if (await isSwitchedOff(ctx, `model:${model.id}`)) return false;
  for (const provider of model.providers) {
    if (!(await isSwitchedOff(ctx, `provider:${provider}`))) return true;
  }
  return false;
}

async function isSwitchedOff(ctx: Reader, key: string) {
  const flag = await ctx.db
    .query("modelFlags")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  return flag?.enabled === false;
}

async function assertUsableUploads(
  ctx: Reader,
  userId: Id<"users">,
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
    if (!upload || upload.userId !== userId) fail("INVALID_INPUT_IMAGES");
  }
}

async function admissionStatus(
  ctx: Reader,
  userId: Id<"users">,
): Promise<"queued" | "waiting"> {
  const active =
    (await countWithStatus(ctx, userId, "queued", MAX_ACTIVE_PER_USER)) +
    (await countWithStatus(ctx, userId, "running", MAX_ACTIVE_PER_USER));
  const waiting = await countWithStatus(ctx, userId, "waiting", MAX_OPEN_PER_USER);

  if (active < MAX_ACTIVE_PER_USER && waiting === 0) return "queued";
  if (active + waiting < MAX_OPEN_PER_USER) return "waiting";
  fail("TOO_MANY_PENDING", { limit: MAX_OPEN_PER_USER });
}

async function countWithStatus(
  ctx: Reader,
  userId: Id<"users">,
  status: "waiting" | "queued" | "running",
  cap: number,
) {
  const rows = await ctx.db
    .query("generations")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", status))
    .take(cap);
  return rows.length;
}
