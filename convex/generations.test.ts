import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

function createHarness() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof createHarness>;

async function signUp(t: Harness, credits: number, subject = "alice") {
  const tokenIdentifier = `https://auth.test|${subject}`;
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { tokenIdentifier, creditBalance: credits });
    await ctx.db.insert("creditLedger", {
      userId: id,
      amount: credits,
      kind: "purchase",
      ref: `seed:${subject}`,
    });
    return id;
  });
  const as = t.withIdentity({ subject, issuer: "https://auth.test", tokenIdentifier });
  return { userId, as };
}

type Caller = Awaited<ReturnType<typeof signUp>>["as"];

let requestCounter = 0;

function submit(as: Caller, overrides: Partial<Parameters<typeof submitArgs>[0]> = {}) {
  return as.mutation(api.generations.submitGeneration, submitArgs(overrides));
}

function submitArgs(overrides: {
  clientRequestId?: string;
  modelId?: string;
  params?: Record<string, string | number | boolean>;
  prompt?: string;
  inputUploadIds?: Id<"uploads">[];
  expectedPriceCredits?: number;
}) {
  return {
    clientRequestId: `req-${++requestCounter}`,
    modelId: "photoreal",
    params: {},
    prompt: "Timber house on a hill at dusk",
    inputUploadIds: [],
    expectedPriceCredits: 4,
    ...overrides,
  };
}

async function errorOf(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    if (error instanceof ConvexError) return error.data as Record<string, unknown>;
    throw error;
  }
  throw new Error("expected the call to fail");
}

async function balanceAndLedger(t: Harness, userId: Id<"users">) {
  return t.run(async (ctx) => {
    const user = await ctx.db.get(userId);
    const entries = await ctx.db
      .query("creditLedger")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return {
      balance: user!.creditBalance,
      ledgerSum: entries.reduce((sum, entry) => sum + entry.amount, 0),
      entries: entries.length,
    };
  });
}

async function generationsOf(t: Harness, userId: Id<"users">) {
  return t.run((ctx) =>
    ctx.db
      .query("generations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
  );
}

async function scheduledRuns(t: Harness) {
  return t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
}

let t: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  t = createHarness();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("submitGeneration", () => {
  test("debits the quoted price once, records it, and schedules the run", async () => {
    const { userId, as } = await signUp(t, 20);

    const result = await submit(as, {
      params: { quality: "high", resolution: "2k" },
      expectedPriceCredits: 10,
    });

    expect(result).toMatchObject({ status: "queued", priceCredits: 10, balanceAfter: 10 });
    expect(await balanceAndLedger(t, userId)).toEqual({ balance: 10, ledgerSum: 10, entries: 2 });
    const [generation] = await generationsOf(t, userId);
    expect(generation).toMatchObject({
      status: "queued",
      priceCredits: 10,
      imagesRequested: 1,
      params: { quality: "high", resolution: "2k", aspectRatio: "4:3", count: 1 },
    });
    expect(generation!.deadlineAt).toBeGreaterThan(Date.now());
    expect(await scheduledRuns(t)).toHaveLength(1);
  });

  test("a repeated clientRequestId returns the first generation without charging again", async () => {
    const { userId, as } = await signUp(t, 20);

    const first = await submit(as, { clientRequestId: "double-click" });
    const second = await submit(as, { clientRequestId: "double-click" });

    expect(second.generationId).toBe(first.generationId);
    expect(await balanceAndLedger(t, userId)).toEqual({ balance: 16, ledgerSum: 16, entries: 2 });
    expect(await generationsOf(t, userId)).toHaveLength(1);
    expect(await scheduledRuns(t)).toHaveLength(1);
  });

  test("rejects a stale price and reports the current one, writing nothing", async () => {
    const { userId, as } = await signUp(t, 20);

    const error = await errorOf(submit(as, { expectedPriceCredits: 3 }));

    expect(error).toEqual({ code: "PRICE_CHANGED", priceCredits: 4 });
    expect(await balanceAndLedger(t, userId)).toEqual({ balance: 20, ledgerSum: 20, entries: 1 });
    expect(await generationsOf(t, userId)).toHaveLength(0);
  });

  test("rejects when the balance doesn't cover the price", async () => {
    const { userId, as } = await signUp(t, 3);

    const error = await errorOf(submit(as));

    expect(error).toEqual({ code: "INSUFFICIENT_CREDITS", priceCredits: 4, balance: 3 });
    expect(await balanceAndLedger(t, userId)).toEqual({ balance: 3, ledgerSum: 3, entries: 1 });
  });

  test("spending down to zero works and the next submit is refused", async () => {
    const { userId, as } = await signUp(t, 8);

    await submit(as);
    await submit(as);
    const error = await errorOf(submit(as));

    expect(error.code).toBe("INSUFFICIENT_CREDITS");
    expect(await balanceAndLedger(t, userId)).toEqual({ balance: 0, ledgerSum: 0, entries: 3 });
  });

  test("runs four at once, makes the rest wait, and caps the open total", async () => {
    const { userId, as } = await signUp(t, 1000);

    const statuses = [];
    for (let i = 0; i < 24; i++) statuses.push((await submit(as)).status);
    const error = await errorOf(submit(as));

    expect(statuses.slice(0, 4)).toEqual(["queued", "queued", "queued", "queued"]);
    expect(new Set(statuses.slice(4))).toEqual(new Set(["waiting"]));
    expect(error).toEqual({ code: "TOO_MANY_PENDING", limit: 24 });
    expect(await scheduledRuns(t)).toHaveLength(4);
    expect(await balanceAndLedger(t, userId)).toEqual({
      balance: 1000 - 24 * 4,
      ledgerSum: 1000 - 24 * 4,
      entries: 25,
    });
  });

  test("a new submit waits behind earlier waiting ones even if a slot is free", async () => {
    const { userId, as } = await signUp(t, 100);
    for (let i = 0; i < 5; i++) await submit(as);
    const [running] = await generationsOf(t, userId);
    await t.run((ctx) => ctx.db.patch(running!._id, { status: "succeeded" }));

    const result = await submit(as);

    expect(result.status).toBe("waiting");
  });

  test("refuses another user's upload", async () => {
    const alice = await signUp(t, 20, "alice");
    const bob = await signUp(t, 20, "bob");
    const bobsUpload = await t.run((ctx) =>
      ctx.db.insert("uploads", {
        userId: bob.userId,
        r2Key: "uploads/bob/sketch.png",
        contentType: "image/png",
        sizeBytes: 1000,
      }),
    );

    const error = await errorOf(
      submit(alice.as, {
        modelId: "sketch-render",
        expectedPriceCredits: 3,
        inputUploadIds: [bobsUpload],
      }),
    );

    expect(error.code).toBe("INVALID_INPUT_IMAGES");
    expect(await balanceAndLedger(t, alice.userId)).toMatchObject({ balance: 20 });
  });

  test("requires the input image a model needs", async () => {
    const { as } = await signUp(t, 20);

    const error = await errorOf(submit(as, { modelId: "sketch-render", expectedPriceCredits: 3 }));

    expect(error).toEqual({ code: "INVALID_INPUT_IMAGES", min: 1, max: 1 });
  });

  test("rejects params the model doesn't have", async () => {
    const { as } = await signUp(t, 20);

    const error = await errorOf(submit(as, { params: { style: "clay" } }));

    expect(error.code).toBe("INVALID_PARAMS");
  });

  test("refuses a switched-off model, and a model whose providers are all off", async () => {
    const { userId, as } = await signUp(t, 20);
    await t.run((ctx) => ctx.db.insert("modelFlags", { key: "model:photoreal", enabled: false }));
    expect((await errorOf(submit(as))).code).toBe("MODEL_UNAVAILABLE");

    await t.run(async (ctx) => {
      await ctx.db.insert("modelFlags", { key: "provider:own-gpu", enabled: false });
    });
    const upload = await t.run((ctx) =>
      ctx.db.insert("uploads", {
        userId,
        r2Key: "uploads/alice/sketch.png",
        contentType: "image/png",
        sizeBytes: 1000,
      }),
    );
    const error = await errorOf(
      submit(as, { modelId: "sketch-render", expectedPriceCredits: 3, inputUploadIds: [upload] }),
    );

    expect(error.code).toBe("MODEL_UNAVAILABLE");
    expect(await balanceAndLedger(t, userId)).toMatchObject({ balance: 20 });
  });

  test("refuses an empty prompt and a caller without an account", async () => {
    const { as } = await signUp(t, 20);

    expect((await errorOf(submit(as, { prompt: "   " }))).code).toBe("INVALID_PROMPT");
    expect((await errorOf(t.mutation(api.generations.submitGeneration, submitArgs({})))).code).toBe(
      "UNAUTHENTICATED",
    );
  });
});
