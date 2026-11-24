import { z } from "zod";
import { defineModel, type Model } from "./define";

const renderQualityCredits = { standard: 1, high: 2 } as const;
const renderResolutionCredits = { "1k": 0, "2k": 1, "4k": 3 } as const;
const upscaleFactorCredits = { "2x": 5, "4x": 10 } as const;

export const render = defineModel({
  id: "render",
  label: "Render",
  pricingVersion: 1,
  providers: ["fal", "replicate"],
  promptRequired: true,
  minInputImages: 0,
  maxInputImages: 4,
  medianSeconds: 25,
  params: z.strictObject({
    quality: z.enum(["standard", "high"]).default("standard"),
    resolution: z.enum(["1k", "2k", "4k"]).default("1k"),
    aspectRatio: z.enum(["1:1", "4:3", "3:2", "16:9"]).default("4:3"),
    count: z.number().int().min(1).max(4).default(1),
  }),
  pricePerImage: ({ quality, resolution }) =>
    renderQualityCredits[quality] + renderResolutionCredits[resolution],
});

export const upscale = defineModel({
  id: "upscale",
  label: "Upscale",
  pricingVersion: 1,
  providers: ["own-gpu", "fal"],
  promptRequired: false,
  minInputImages: 1,
  maxInputImages: 1,
  medianSeconds: 40,
  params: z.strictObject({
    factor: z.enum(["2x", "4x"]).default("2x"),
    count: z.literal(1).default(1),
  }),
  pricePerImage: ({ factor }) => upscaleFactorCredits[factor],
});

export const models: readonly Model[] = [render, upscale];

export function findModel(id: string): Model | undefined {
  return models.find((model) => model.id === id);
}
