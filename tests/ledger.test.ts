import { afterEach, beforeEach, expect, test } from "vitest";
import { applyLedgerEntryOnce } from "../convex/lib/credits";
import {
  balanceOf,
  createHarness,
  createWorkspace,
  expectLedgerInvariants,
  ledgerOf,
  type Harness,
} from "./harness";

let t: Harness;

beforeEach(() => {
  t = createHarness();
});

afterEach(async () => {
  await expectLedgerInvariants(t);
});

test("a redelivered Stripe invoice grants its credits once", async () => {
  const workspaceId = await createWorkspace(t, { plan: "pro" });
  const renewal = {
    workspaceId,
    amount: 1500,
    kind: "plan_renewal" as const,
    ref: "stripe:invoice:in_1Q2w3E",
  };

  const results = await t.run(async (ctx) => [
    await applyLedgerEntryOnce(ctx, renewal),
    await applyLedgerEntryOnce(ctx, renewal),
  ]);

  expect(results.map((result) => result.applied)).toEqual([true, false]);
  expect(await balanceOf(t, workspaceId)).toBe(1500);
  expect(await ledgerOf(t, workspaceId)).toHaveLength(1);
});

test("renewals add to what is left, so unused credits carry over", async () => {
  const workspaceId = await createWorkspace(t, { plan: "starter", credits: 120 });

  await t.run((ctx) =>
    applyLedgerEntryOnce(ctx, {
      workspaceId,
      amount: 500,
      kind: "plan_renewal",
      ref: "stripe:invoice:in_next",
    }),
  );

  expect(await balanceOf(t, workspaceId)).toBe(620);
});
