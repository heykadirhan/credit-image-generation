import { describe, expect, test } from "vitest";
import { findModel, photoreal, sketchRender } from "./catalog";

describe("photoreal pricing", () => {
  test.each([
    [{}, 4],
    [{ quality: "draft" }, 2],
    [{ quality: "high" }, 8],
    [{ resolution: "2k" }, 6],
    [{ quality: "high", resolution: "4k" }, 14],
    [{ quality: "high", resolution: "4k", count: 4 }, 56],
  ])("%o costs %i credits", (params, credits) => {
    const quote = photoreal.quote(params);
    expect(quote.ok && quote.priceCredits).toBe(credits);
  });

  test("fills defaults into the stored params", () => {
    const quote = photoreal.quote({});
    expect(quote.ok && quote.params).toEqual({
      quality: "standard",
      resolution: "1k",
      aspectRatio: "4:3",
      count: 1,
    });
  });
});

describe("sketch-render pricing", () => {
  test.each([
    [{}, 3],
    [{ resolution: "2k" }, 5],
    [{ resolution: "2k", count: 3 }, 15],
  ])("%o costs %i credits", (params, credits) => {
    const quote = sketchRender.quote(params);
    expect(quote.ok && quote.priceCredits).toBe(credits);
  });
});

describe("params validation", () => {
  test.each([
    ["an unknown param", { style: "clay" }],
    ["a value outside the enum", { resolution: "8k" }],
    ["too many images", { count: 5 }],
    ["a fractional count", { count: 1.5 }],
  ])("rejects %s", (_, params) => {
    expect(photoreal.quote(params).ok).toBe(false);
  });

  test("every model's prices are whole numbers", () => {
    for (const id of ["photoreal", "sketch-render"]) {
      const quote = findModel(id)!.quote({});
      expect(quote.ok && Number.isInteger(quote.priceCredits)).toBe(true);
    }
  });
});
