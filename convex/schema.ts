import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { generationErrorCodes } from "../shared/providers/errors";

export const paramsValidator = v.record(v.string(), v.union(v.string(), v.number(), v.boolean()));

export const planId = v.union(
  v.literal("free"),
  v.literal("starter"),
  v.literal("pro"),
  v.literal("studio_pro"),
  v.literal("enterprise"),
);

export const generationStatus = v.union(
  v.literal("waiting"),
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("partial"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const ledgerKind = v.union(
  v.literal("plan_renewal"),
  v.literal("seat_grant"),
  v.literal("top_up"),
  v.literal("generation_debit"),
  v.literal("generation_refund"),
  v.literal("chargeback"),
  v.literal("adjustment"),
);

export const generationErrorCode = v.union(...generationErrorCodes.map((code) => v.literal(code)));

export const outputImage = v.object({ r2Key: v.string(), width: v.number(), height: v.number() });

export default defineSchema({
  workspaces: defineTable({
    name: v.string(),
    plan: planId,
    creditBalance: v.number(),
    isInternal: v.optional(v.boolean()),
    limitOverrides: v.optional(
      v.object({ atOnce: v.optional(v.number()), inBackground: v.optional(v.number()) }),
    ),
  }),

  users: defineTable({
    tokenIdentifier: v.string(),
    workspaceId: v.id("workspaces"),
  }).index("by_token", ["tokenIdentifier"]),

  creditLedger: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.optional(v.id("users")),
    amount: v.number(),
    kind: ledgerKind,
    generationId: v.optional(v.id("generations")),
    ref: v.string(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_ref", ["ref"]),

  uploads: defineTable({
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    r2Key: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  generations: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    clientRequestId: v.string(),
    modelId: v.string(),
    pricingVersion: v.number(),
    params: paramsValidator,
    prompt: v.string(),
    inputUploadIds: v.array(v.id("uploads")),
    imagesRequested: v.number(),
    priceCredits: v.number(),
    priority: v.boolean(),
    status: generationStatus,
    attempt: v.number(),
    provider: v.optional(v.string()),
    externalJobId: v.optional(v.string()),
    error: v.optional(v.object({ code: generationErrorCode, message: v.string() })),
    outputs: v.array(outputImage),
    costUsd: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    deadlineAt: v.optional(v.number()),
  })
    .index("by_user_request", ["userId", "clientRequestId"])
    .index("by_workspace_status", ["workspaceId", "status"])
    .index("by_status_deadline", ["status", "deadlineAt"]),

  modelFlags: defineTable({
    key: v.string(),
    state: v.union(v.literal("on"), v.literal("internal"), v.literal("off")),
    reason: v.optional(v.string()),
  }).index("by_key", ["key"]),
});
