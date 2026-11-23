import { z } from "zod";
import { defineModel, type Model } from "./define";

const count = z.number().int().min(1).max(4).default(1);

const photorealQualityCredits = { draft: 2, standard: 4, high: 8 } as const;
const photorealResolutionCredits = { "1k": 0, "2k": 2, "4k": 6 } as const;
const sketchResolutionCredits = { "1k": 3, "2k": 5 } as const;

export const photoreal = defineModel({
  id: "photoreal",
  label: "Photoreal",
  pricingVersion: 1,
  providers: ["fal", "replicate"],
  minInputImages: 0,
  maxInputImages: 4,
  medianSeconds: 25,
  params: z.strictObject({
    quality: z.enum(["draft", "standard", "high"]).default("standard"),
    resolution: z.enum(["1k", "2k", "4k"]).default("1k"),
    aspectRatio: z.enum(["1:1", "4:3", "3:2", "16:9"]).default("4:3"),
    count,
  }),
  pricePerImage: ({ quality, resolution }) =>
    photorealQualityCredits[quality] + photorealResolutionCredits[resolution],
});

export const sketchRender = defineModel({
  id: "sketch-render",
  label: "Sketch to render",
  pricingVersion: 1,
  providers: ["own-gpu"],
  minInputImages: 1,
  maxInputImages: 1,
  medianSeconds: 12,
  params: z.strictObject({
    style: z.enum(["photoreal", "watercolor", "clay", "line"]).default("photoreal"),
    sketchStrength: z.number().min(0).max(1).default(0.6),
    resolution: z.enum(["1k", "2k"]).default("1k"),
    count,
  }),
  pricePerImage: ({ resolution }) => sketchResolutionCredits[resolution],
});

export const models: readonly Model[] = [photoreal, sketchRender];

export function findModel(id: string): Model | undefined {
  return models.find((model) => model.id === id);
}
