import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { ConvexError } from "convex/values";
import { expect } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { applyLedgerEntryOnce } from "../convex/lib/credits";
import schema from "../convex/schema";
import type { PlanId } from "../shared/plans";

const modules = import.meta.glob("../convex/**/*.*s");

export function createHarness() {
  return convexTest(schema, modules);
}

export type Harness = ReturnType<typeof createHarness>;

export async function createWorkspace(
  t: Harness,
  options: {
    plan?: PlanId;
    credits?: number;
    isInternal?: boolean;
    limitOverrides?: { atOnce?: number; inBackground?: number };
  } = {},
) {
  const { plan = "pro", credits = 0, isInternal, limitOverrides } = options;
  return t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Studio",
      plan,
      creditBalance: 0,
      isInternal,
      limitOverrides,
    });
    if (credits > 0) {
      await applyLedgerEntryOnce(ctx, {
        workspaceId,
        amount: credits,
        kind: "plan_renewal",
        ref: `seed:${workspaceId}`,
      });
    }
    return workspaceId;
  });
}

let memberCounter = 0;

export async function addMember(t: Harness, workspaceId: Id<"workspaces">) {
  const subject = `member-${++memberCounter}`;
  const tokenIdentifier = `https://auth.test|${subject}`;
  const userId = await t.run((ctx) => ctx.db.insert("users", { tokenIdentifier, workspaceId }));
  const as = t.withIdentity({ subject, issuer: "https://auth.test", tokenIdentifier });
  return { userId, workspaceId, as };
}

export type Member = Awaited<ReturnType<typeof addMember>>;

export async function signUp(t: Harness, options: Parameters<typeof createWorkspace>[1] = {}) {
  return addMember(t, await createWorkspace(t, options));
}

export async function addUpload(t: Harness, member: Member) {
  return t.run((ctx) =>
    ctx.db.insert("uploads", {
      userId: member.userId,
      workspaceId: member.workspaceId,
      r2Key: `uploads/${member.userId}/sketch.png`,
      contentType: "image/png",
      sizeBytes: 1000,
    }),
  );
}

let requestCounter = 0;

export interface SubmitOverrides {
  clientRequestId?: string;
  modelId?: string;
  params?: Record<string, string | number | boolean>;
  prompt?: string;
  inputUploadIds?: Id<"uploads">[];
  expectedPriceCredits?: number;
}

export function submitArgs(overrides: SubmitOverrides = {}) {
  return {
    clientRequestId: `request-${++requestCounter}`,
    modelId: "render",
    params: {},
    prompt: "Timber house on a hill at dusk",
    inputUploadIds: [],
    expectedPriceCredits: 1,
    ...overrides,
  };
}

export function submit(member: Member, overrides: SubmitOverrides = {}) {
  return member.as.mutation(api.generations.submitGeneration, submitArgs(overrides));
}

type Outcome = FunctionArgs<typeof internal.settle.settleGeneration>["outcome"];

export function settle(t: Harness, generationId: Id<"generations">, outcome: Outcome) {
  return t.mutation(internal.settle.settleGeneration, { generationId, outcome });
}

export function outputs(count: number) {
  return Array.from({ length: count }, (_, n) => ({
    r2Key: `outputs/${n}.png`,
    width: 1024,
    height: 768,
  }));
}

export async function markRunning(t: Harness, generationId: Id<"generations">) {
  await t.run((ctx) =>
    ctx.db.patch(generationId, {
      status: "running",
      provider: "fal",
      externalJobId: `job-${generationId}`,
      startedAt: Date.now(),
    }),
  );
}

export async function errorOf(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    if (error instanceof ConvexError) return error.data as Record<string, unknown>;
    throw error;
  }
  throw new Error("expected the call to fail");
}

export async function balanceOf(t: Harness, workspaceId: Id<"workspaces">) {
  return t.run(async (ctx) => (await ctx.db.get(workspaceId))!.creditBalance);
}

export async function ledgerOf(t: Harness, workspaceId: Id<"workspaces">) {
  return t.run((ctx) =>
    ctx.db
      .query("creditLedger")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect(),
  );
}

export async function generationsOf(t: Harness, workspaceId: Id<"workspaces">) {
  return t.run(async (ctx) => {
    const all = await ctx.db.query("generations").collect();
    return all.filter((generation) => generation.workspaceId === workspaceId);
  });
}

export async function getGeneration(t: Harness, generationId: Id<"generations">) {
  return t.run(async (ctx) => (await ctx.db.get(generationId))!);
}

export async function scheduledNames(t: Harness) {
  const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return scheduled.filter((job) => job.state.kind === "pending").map((job) => job.name);
}

export async function expectEveryBalanceMatchesItsLedger(t: Harness) {
  const rows = await t.run(async (ctx) => {
    const workspaces = await ctx.db.query("workspaces").collect();
    const entries = await ctx.db.query("creditLedger").collect();
    return workspaces.map((workspace) => ({
      balance: workspace.creditBalance,
      ledgerSum: entries
        .filter((entry) => entry.workspaceId === workspace._id)
        .reduce((sum, entry) => sum + entry.amount, 0),
    }));
  });
  for (const { balance, ledgerSum } of rows) {
    expect(balance).toBe(ledgerSum);
    expect(balance).toBeGreaterThanOrEqual(0);
  }
}
