import { GENERATION_DEADLINE_MS } from "../../shared/limits";
import { planLimits, type PlanLimits } from "../../shared/plans";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type Reader = Pick<QueryCtx, "db">;
type OpenStatus = "waiting" | "queued" | "running";

export function limitsFor(workspace: Doc<"workspaces">): PlanLimits {
  return { ...planLimits[workspace.plan], ...workspace.limitOverrides };
}

async function countWithStatus(
  ctx: Reader,
  workspaceId: Id<"workspaces">,
  status: OpenStatus,
  cap: number,
) {
  const rows = await ctx.db
    .query("generations")
    .withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspaceId).eq("status", status))
    .take(cap);
  return rows.length;
}

export async function openGenerations(ctx: Reader, workspace: Doc<"workspaces">) {
  const { inBackground } = limitsFor(workspace);
  const active =
    (await countWithStatus(ctx, workspace._id, "queued", inBackground)) +
    (await countWithStatus(ctx, workspace._id, "running", inBackground));
  const waiting = await countWithStatus(ctx, workspace._id, "waiting", inBackground);
  return { active, waiting };
}

export async function scheduleRun(ctx: MutationCtx, generationId: Id<"generations">, deadlineAt: number) {
  await ctx.scheduler.runAfter(0, internal.runner.start, { generationId });
  await ctx.scheduler.runAt(deadlineAt, internal.settle.settleGeneration, {
    generationId,
    outcome: { kind: "timed_out" },
  });
}

export async function promoteWaiting(ctx: MutationCtx, workspace: Doc<"workspaces">) {
  const { atOnce } = limitsFor(workspace);
  let { active } = await openGenerations(ctx, workspace);
  while (active < atOnce) {
    const next = await ctx.db
      .query("generations")
      .withIndex("by_workspace_status", (q) =>
        q.eq("workspaceId", workspace._id).eq("status", "waiting"),
      )
      .first();
    if (!next) return;
    const deadlineAt = Date.now() + GENERATION_DEADLINE_MS;
    await ctx.db.patch(next._id, { status: "queued", deadlineAt });
    await scheduleRun(ctx, next._id, deadlineAt);
    active++;
  }
}
