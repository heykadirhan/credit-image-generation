import type { QueryCtx } from "../_generated/server";
import { fail } from "./errors";

export async function requireUser(ctx: Pick<QueryCtx, "auth" | "db">) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) fail("UNAUTHENTICATED");
  const user = await ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
  if (!user) fail("UNAUTHENTICATED");
  return user;
}
