import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const paramsValidator = v.record(v.string(), v.union(v.string(), v.number(), v.boolean()));

export const generationStatus = v.union(
  v.literal("waiting"),
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("partial"),
  v.literal("failed"),
);

export const ledgerKind = v.union(
  v.literal("purchase"),
  v.literal("generation_debit"),
  v.literal("generation_refund"),
  v.literal("adjustment"),
);

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    creditBalance: v.number(),
  }).index("by_token", ["tokenIdentifier"]),

  creditLedger: defineTable({
    userId: v.id("users"),
    amount: v.number(),
    kind: ledgerKind,
    generationId: v.optional(v.id("generations")),
    ref: v.string(),
  })
    .index("by_user", ["userId"])
    .index("by_generation_kind", ["generationId", "kind"]),

  uploads: defineTable({
    userId: v.id("users"),
    r2Key: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
  }).index("by_user", ["userId"]),

  generations: defineTable({
    userId: v.id("users"),
    clientRequestId: v.string(),
    modelId: v.string(),
    pricingVersion: v.number(),
    params: paramsValidator,
    prompt: v.string(),
    inputUploadIds: v.array(v.id("uploads")),
    imagesRequested: v.number(),
    priceCredits: v.number(),
    status: generationStatus,
    attempt: v.number(),
    provider: v.optional(v.string()),
    externalJobId: v.optional(v.string()),
    error: v.optional(
      v.object({ code: v.string(), message: v.string(), retryable: v.boolean() }),
    ),
    outputs: v.array(v.object({ r2Key: v.string(), width: v.number(), height: v.number() })),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    deadlineAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_request", ["userId", "clientRequestId"])
    .index("by_user_status", ["userId", "status"])
    .index("by_external", ["provider", "externalJobId"])
    .index("by_status_deadline", ["status", "deadlineAt"]),

  modelFlags: defineTable({
    key: v.string(),
    enabled: v.boolean(),
    reason: v.optional(v.string()),
  }).index("by_key", ["key"]),
});
