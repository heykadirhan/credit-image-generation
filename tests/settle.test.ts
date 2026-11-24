import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GENERATION_DEADLINE_MS } from "../shared/limits";
import {
  balanceOf,
  createHarness,
  expectEveryBalanceMatchesItsLedger,
  getGeneration,
  ledgerOf,
  markRunning,
  outputs,
  scheduledNames,
  settle,
  signUp,
  submit,
  type Harness,
} from "./harness";

let t: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  t = createHarness();
});

afterEach(async () => {
  await expectEveryBalanceMatchesItsLedger(t);
  vi.useRealTimers();
});

async function runningGeneration(count = 1) {
  const member = await signUp(t, { credits: 20 });
  const { generationId } = await submit(member, { params: { count }, expectedPriceCredits: count });
  await markRunning(t, generationId);
  return { member, generationId };
}

function refundsIn(ledger: { kind: string }[]) {
  return ledger.filter((entry) => entry.kind === "generation_refund");
}

describe("settleGeneration", () => {
  test("a full result keeps the charge and stores the images and cost", async () => {
    const { member, generationId } = await runningGeneration(2);

    expect(await settle(t, generationId, { kind: "succeeded", attempt: 0, outputs: outputs(2), costUsd: 0.04 }))
      .toBe("settled");

    expect(await getGeneration(t, generationId)).toMatchObject({ status: "succeeded", costUsd: 0.04 });
    expect((await getGeneration(t, generationId)).outputs).toHaveLength(2);
    expect(await balanceOf(t, member.workspaceId)).toBe(18);
  });

  test("a partial result refunds the missing images", async () => {
    const { member, generationId } = await runningGeneration(4);

    await settle(t, generationId, { kind: "succeeded", attempt: 0, outputs: outputs(1) });

    expect((await getGeneration(t, generationId)).status).toBe("partial");
    expect(await balanceOf(t, member.workspaceId)).toBe(19);
  });

  test("a failure refunds once, however many times the webhook arrives", async () => {
    const { member, generationId } = await runningGeneration();
    const refusal = { kind: "failed" as const, attempt: 0, code: "SAFETY_REFUSAL" as const, message: "nsfw" };

    expect(await settle(t, generationId, refusal)).toBe("settled");
    expect(await settle(t, generationId, refusal)).toBe("ignored");

    expect(await getGeneration(t, generationId)).toMatchObject({
      status: "failed",
      error: { code: "SAFETY_REFUSAL" },
    });
    expect(refundsIn(await ledgerOf(t, member.workspaceId))).toHaveLength(1);
    expect(await balanceOf(t, member.workspaceId)).toBe(20);
  });

  test("a retryable failure goes to the next attempt, and stale webhooks are ignored", async () => {
    const { member, generationId } = await runningGeneration();
    const busy = (attempt: number) => ({
      kind: "failed" as const,
      attempt,
      code: "PROVIDER_BUSY" as const,
      message: "capacity",
    });

    expect(await settle(t, generationId, busy(0))).toBe("retrying");
    expect(await getGeneration(t, generationId)).toMatchObject({ status: "queued", attempt: 1 });
    expect(await settle(t, generationId, { kind: "succeeded", attempt: 0, outputs: outputs(1) })).toBe("ignored");

    await markRunning(t, generationId);
    expect(await settle(t, generationId, busy(1))).toBe("retrying");
    await markRunning(t, generationId);
    expect(await settle(t, generationId, busy(2))).toBe("settled");

    expect(await getGeneration(t, generationId)).toMatchObject({ status: "failed", attempt: 2 });
    expect(refundsIn(await ledgerOf(t, member.workspaceId))).toHaveLength(1);
    expect(await balanceOf(t, member.workspaceId)).toBe(20);
  });

  test("a run that never starts is failed and refunded at its deadline", async () => {
    const member = await signUp(t, { credits: 20 });
    const { generationId } = await submit(member);

    vi.advanceTimersByTime(GENERATION_DEADLINE_MS + 1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await getGeneration(t, generationId)).toMatchObject({
      status: "failed",
      error: { code: "TIMED_OUT" },
    });
    expect(await balanceOf(t, member.workspaceId)).toBe(20);
  });

  test("a result that arrives after the deadline is ignored", async () => {
    const { member, generationId } = await runningGeneration();
    vi.advanceTimersByTime(GENERATION_DEADLINE_MS + 1);
    await settle(t, generationId, { kind: "timed_out" });

    expect(await settle(t, generationId, { kind: "succeeded", attempt: 0, outputs: outputs(1) })).toBe("ignored");

    expect((await getGeneration(t, generationId)).outputs).toHaveLength(0);
    expect(refundsIn(await ledgerOf(t, member.workspaceId))).toHaveLength(1);
  });

  test("a deadline check that fires early changes nothing", async () => {
    const { generationId } = await runningGeneration();

    expect(await settle(t, generationId, { kind: "timed_out" })).toBe("ignored");
    expect((await getGeneration(t, generationId)).status).toBe("running");
  });

  test("finishing a job starts the oldest waiting one", async () => {
    const member = await signUp(t, { plan: "starter", credits: 20 });
    const first = await submit(member);
    const second = await submit(member);
    const third = await submit(member);
    await markRunning(t, first.generationId);
    const scheduledBefore = (await scheduledNames(t)).length;

    await settle(t, first.generationId, { kind: "succeeded", attempt: 0, outputs: outputs(1) });

    const promoted = await getGeneration(t, second.generationId);
    expect(promoted.status).toBe("queued");
    expect(promoted.deadlineAt).toBeGreaterThan(Date.now());
    expect((await getGeneration(t, third.generationId)).status).toBe("waiting");
    expect((await scheduledNames(t)).length).toBe(scheduledBefore + 2);
  });
});
