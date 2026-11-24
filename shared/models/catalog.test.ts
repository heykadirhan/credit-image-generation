import { describe, expect, test } from "vitest";
import { models, render, upscale } from "./catalog";

describe("render pricing", () => {
  test.each([
    [{}, 1],
    [{ quality: "high" }, 2],
    [{ resolution: "2k" }, 2],
    [{ quality: "high", resolution: "4k" }, 5],
    [{ quality: "high", resolution: "4k", count: 4 }, 20],
  ])("%o costs %i credits", (params, credits) => {
    const quote = render.quote(params);
    expect(quote.ok && quote.priceCredits).toBe(credits);
  });

  test("fills defaults into the stored params", () => {
    const quote = render.quote({});
    expect(quote.ok && quote.params).toEqual({
      quality: "standard",
      resolution: "1k",
      aspectRatio: "4:3",
      count: 1,
    });
  });
});

describe("upscale pricing", () => {
  test.each([
    [{}, 5],
    [{ factor: "4x" }, 10],
  ])("%o costs %i credits", (params, credits) => {
    const quote = upscale.quote(params);
    expect(quote.ok && quote.priceCredits).toBe(credits);
  });

  test("always makes one image", () => {
    expect(upscale.quote({ count: 2 }).ok).toBe(false);
  });
});

describe("params validation", () => {
  test.each([
    ["a param from another model", { factor: "2x" }],
    ["a value outside the enum", { resolution: "8k" }],
    ["too many images", { count: 5 }],
    ["a fractional count", { count: 1.5 }],
  ])("render rejects %s", (_, params) => {
    expect(render.quote(params).ok).toBe(false);
  });

  test("every model's default price is a whole number", () => {
    for (const model of models) {
      const quote = model.quote({});
      expect(quote.ok && Number.isInteger(quote.priceCredits)).toBe(true);
    }
  });
});
