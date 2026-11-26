import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { MAX_PROMPT_LENGTH } from "../shared/limits";
import {
  addMember,
  addUpload,
  balanceOf,
  createHarness,
  createWorkspace,
  errorOf,
  expectLedgerInvariants,
  generationsOf,
  getGeneration,
  ledgerOf,
  scheduledNames,
  signUp,
  submit,
  submitArgs,
  type Harness,
} from "./harness";

let t: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  t = createHarness();
});

afterEach(async () => {
  await expectLedgerInvariants(t);
  vi.useRealTimers();
});

describe("submitGeneration: credits", () => {
  test("debits the quoted price once and schedules the run and its deadline", async () => {
    const member = await signUp(t, { credits: 20 });

    const result = await submit(member, {
      params: { quality: "high", resolution: "2k" },
      expectedPriceCredits: 3,
    });

    expect(result).toMatchObject({ status: "queued", priceCredits: 3, balanceAfter: 17 });
    expect(await balanceOf(t, member.workspaceId)).toBe(17);
    const generation = await getGeneration(t, result.generationId);
    expect(generation).toMatchObject({
      status: "queued",
      priceCredits: 3,
      priority: true,
      params: { quality: "high", resolution: "2k", aspectRatio: "4:3", count: 1 },
    });
    expect(generation.deadlineAt).toBeGreaterThan(Date.now());
    expect((await scheduledNames(t)).sort()).toEqual(["runner:start", "settle:settleGeneration"]);
  });

  test("a repeated clientRequestId returns the first generation without charging again", async () => {
    const member = await signUp(t, { credits: 20 });

    const first = await submit(member, { clientRequestId: "double-click" });
    const second = await submit(member, { clientRequestId: "double-click" });

    expect(second.generationId).toBe(first.generationId);
    expect(await balanceOf(t, member.workspaceId)).toBe(19);
    expect(await generationsOf(t, member.workspaceId)).toHaveLength(1);
    expect(await scheduledNames(t)).toHaveLength(2);
  });

  test("rejects a stale price and reports the current one, writing nothing", async () => {
    const member = await signUp(t, { credits: 20 });

    const error = await errorOf(submit(member, { expectedPriceCredits: 3 }));

    expect(error).toEqual({ code: "PRICE_CHANGED", priceCredits: 1 });
    expect(await balanceOf(t, member.workspaceId)).toBe(20);
    expect(await generationsOf(t, member.workspaceId)).toHaveLength(0);
  });

  test("rejects when the balance doesn't cover the price", async () => {
    const member = await signUp(t, { credits: 4 });

    const error = await errorOf(
      submit(member, { params: { quality: "high", resolution: "4k" }, expectedPriceCredits: 5 }),
    );

    expect(error).toEqual({ code: "INSUFFICIENT_CREDITS", priceCredits: 5, balance: 4 });
    expect(await ledgerOf(t, member.workspaceId)).toHaveLength(1);
  });

  test("members of a workspace spend from one shared pool", async () => {
    const workspaceId = await createWorkspace(t, { credits: 2 });
    const anna = await addMember(t, workspaceId);
    const ben = await addMember(t, workspaceId);

    await submit(anna);
    await submit(ben);
    const error = await errorOf(submit(anna));

    expect(error.code).toBe("INSUFFICIENT_CREDITS");
    expect(await balanceOf(t, workspaceId)).toBe(0);
  });

  test("a free model takes a render slot but writes no ledger entry", async () => {
    const member = await signUp(t, { plan: "starter" });
    const free = { modelId: "text-to-image", expectedPriceCredits: 0 };

    const first = await submit(member, free);
    const second = await submit(member, free);

    expect(first).toMatchObject({ status: "queued", priceCredits: 0, balanceAfter: 0 });
    expect(second.status).toBe("waiting");
    expect(await ledgerOf(t, member.workspaceId)).toHaveLength(0);
  });
});

describe("submitGeneration: plan limits", () => {
  async function fill(plan: "starter" | "pro" | "enterprise", count: number, overrides = {}) {
    const member = await signUp(t, { plan, credits: 100, limitOverrides: overrides });
    const statuses = [];
    for (let i = 0; i < count; i++) statuses.push((await submit(member)).status);
    return { member, statuses };
  }

  test("starter renders one at a time and holds four in the background", async () => {
    const { member, statuses } = await fill("starter", 4);

    expect(statuses).toEqual(["queued", "waiting", "waiting", "waiting"]);
    expect(await errorOf(submit(member))).toEqual({ code: "TOO_MANY_PENDING", limit: 4 });
    expect((await getGeneration(t, (await generationsOf(t, member.workspaceId))[0]!._id)).priority).toBe(false);
  });

  test("pro renders four at once and holds eight in the background", async () => {
    const { member, statuses } = await fill("pro", 8);

    expect(statuses.filter((status) => status === "queued")).toHaveLength(4);
    expect(statuses.slice(4)).toEqual(["waiting", "waiting", "waiting", "waiting"]);
    expect(await errorOf(submit(member))).toEqual({ code: "TOO_MANY_PENDING", limit: 8 });
    expect(await scheduledNames(t)).toHaveLength(8);
  });

  test("enterprise limits come from the workspace's overrides", async () => {
    const { statuses } = await fill("enterprise", 7, { atOnce: 6, inBackground: 20 });

    expect(statuses).toEqual(["queued", "queued", "queued", "queued", "queued", "queued", "waiting"]);
  });

  test("a free slot left by a missed promotion goes to the oldest waiting job first", async () => {
    const { member } = await fill("pro", 5);
    const [first, , , , fifth] = await generationsOf(t, member.workspaceId);
    await t.run((ctx) => ctx.db.patch(first!._id, { status: "succeeded" }));

    const sixth = await submit(member);

    expect((await getGeneration(t, fifth!._id)).status).toBe("queued");
    expect(sixth.status).toBe("waiting");
  });
});

describe("submitGeneration: input checks", () => {
  test("refuses an upload from another workspace", async () => {
    const anna = await signUp(t, { credits: 20 });
    const bob = await signUp(t, { credits: 20 });
    const bobsUpload = await addUpload(t, bob);

    const error = await errorOf(submit(anna, { inputUploadIds: [bobsUpload] }));

    expect(error.code).toBe("INVALID_INPUT_IMAGES");
  });

  test("upscale needs exactly one image and no prompt", async () => {
    const member = await signUp(t, { credits: 20 });
    const upload = await addUpload(t, member);

    const missing = await errorOf(submit(member, { modelId: "upscale", prompt: "", expectedPriceCredits: 5 }));
    const result = await submit(member, {
      modelId: "upscale",
      prompt: "",
      inputUploadIds: [upload],
      expectedPriceCredits: 5,
    });

    expect(missing).toEqual({ code: "INVALID_INPUT_IMAGES", min: 1, max: 1 });
    expect(result).toMatchObject({ status: "queued", balanceAfter: 15 });
  });

  test("render takes one to four different images", async () => {
    const member = await signUp(t, { credits: 20 });

    const none = await errorOf(submit(member, { inputUploadIds: [] }));
    const twice = await errorOf(submit(member, { inputUploadIds: [member.sketchId, member.sketchId] }));

    expect(none).toEqual({ code: "INVALID_INPUT_IMAGES", min: 1, max: 4 });
    expect(twice.code).toBe("INVALID_INPUT_IMAGES");
  });

  test("rejects an unknown model, params the model doesn't have, and an empty or overlong prompt", async () => {
    const member = await signUp(t, { credits: 20 });
    const overlong = "x".repeat(MAX_PROMPT_LENGTH + 1);

    expect((await errorOf(submit(member, { modelId: "video" }))).code).toBe("UNKNOWN_MODEL");
    expect((await errorOf(submit(member, { params: { factor: "2x" } }))).code).toBe("INVALID_PARAMS");
    expect((await errorOf(submit(member, { prompt: "  " }))).code).toBe("INVALID_PROMPT");
    expect((await errorOf(submit(member, { prompt: overlong }))).code).toBe("INVALID_PROMPT");
  });

  test("refuses a caller without an account", async () => {
    const error = await errorOf(t.mutation(api.generations.submitGeneration, submitArgs()));

    expect(error.code).toBe("UNAUTHENTICATED");
  });
});

describe("cancelGeneration", () => {
  test("cancelling a waiting job refunds it at once; a started job can't be cancelled", async () => {
    const member = await signUp(t, { plan: "starter", credits: 20 });
    const started = await submit(member);
    const waiting = await submit(member);

    const cancel = (generationId: typeof started.generationId) =>
      member.as.mutation(api.generations.cancelGeneration, { generationId });

    expect(await cancel(waiting.generationId)).toBe("cancelled");
    expect(await cancel(waiting.generationId)).toBe("too_late");
    expect(await cancel(started.generationId)).toBe("too_late");
    expect((await getGeneration(t, waiting.generationId)).status).toBe("cancelled");
    expect(await balanceOf(t, member.workspaceId)).toBe(19);
  });

  test("a teammate can cancel a waiting job, and the refund goes to whoever submitted it", async () => {
    const workspaceId = await createWorkspace(t, { plan: "starter", credits: 20 });
    const anna = await addMember(t, workspaceId);
    const ben = await addMember(t, workspaceId);
    await submit(anna);
    const waiting = await submit(anna);

    const cancelled = await ben.as.mutation(api.generations.cancelGeneration, {
      generationId: waiting.generationId,
    });

    expect(cancelled).toBe("cancelled");
    const refunds = (await ledgerOf(t, workspaceId)).filter((entry) => entry.kind === "generation_refund");
    expect(refunds).toEqual([
      expect.objectContaining({ userId: anna.userId, generationId: waiting.generationId }),
    ]);
  });

  test("a member of another workspace can't see or cancel the job", async () => {
    const owner = await signUp(t, { plan: "starter", credits: 20 });
    const stranger = await signUp(t, { credits: 20 });
    await submit(owner);
    const waiting = await submit(owner);

    const error = await errorOf(
      stranger.as.mutation(api.generations.cancelGeneration, { generationId: waiting.generationId }),
    );

    expect(error.code).toBe("NOT_FOUND");
  });
});

describe("submitGeneration: rollout flags", () => {
  test("a model that is off is unavailable", async () => {
    const member = await signUp(t, { credits: 20 });
    await t.run((ctx) => ctx.db.insert("modelFlags", { key: "model:render", state: "off" }));

    expect((await errorOf(submit(member))).code).toBe("MODEL_UNAVAILABLE");
  });

  test("an internal-only provider serves internal workspaces and nobody else", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("modelFlags", { key: "provider:own-gpu", state: "internal" });
      await ctx.db.insert("modelFlags", { key: "provider:fal", state: "off" });
    });
    const customer = await signUp(t, { credits: 20 });
    const staff = await signUp(t, { credits: 20, isInternal: true });
    const upscaleArgs = { modelId: "upscale", prompt: "", expectedPriceCredits: 5 };

    const refused = await errorOf(
      submit(customer, { ...upscaleArgs, inputUploadIds: [await addUpload(t, customer)] }),
    );
    const accepted = await submit(staff, { ...upscaleArgs, inputUploadIds: [await addUpload(t, staff)] });

    expect(refused.code).toBe("MODEL_UNAVAILABLE");
    expect(accepted.status).toBe("queued");
  });
});
