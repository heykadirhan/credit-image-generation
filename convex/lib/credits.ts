import type { Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ledgerKind } from "../schema";

export interface LedgerEntry {
  workspaceId: Id<"workspaces">;
  userId?: Id<"users">;
  amount: number;
  kind: Infer<typeof ledgerKind>;
  generationId?: Id<"generations">;
  ref: string;
}

export async function applyLedgerEntryOnce(ctx: MutationCtx, entry: LedgerEntry) {
  const existing = await ctx.db
    .query("creditLedger")
    .withIndex("by_ref", (q) => q.eq("ref", entry.ref))
    .first();
  if (existing) return { applied: false as const };

  const workspace = await ctx.db.get(entry.workspaceId);
  if (!workspace) throw new Error(`Workspace ${entry.workspaceId} not found`);
  const balanceAfter = workspace.creditBalance + entry.amount;
  await ctx.db.insert("creditLedger", entry);
  await ctx.db.patch(entry.workspaceId, { creditBalance: balanceAfter });
  return { applied: true as const, balanceAfter };
}
