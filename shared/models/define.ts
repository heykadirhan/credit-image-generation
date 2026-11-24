import type { z } from "zod";

export type ParamValue = string | number | boolean;
export type Params = Record<string, ParamValue>;
export type Provider = "fal" | "replicate" | "own-gpu";

export type Quote =
  | { ok: true; params: Params; images: number; priceCredits: number }
  | { ok: false; issues: string[] };

export interface Model {
  id: string;
  label: string;
  pricingVersion: number;
  providers: readonly Provider[];
  promptRequired: boolean;
  minInputImages: number;
  maxInputImages: number;
  medianSeconds: number;
  paramsSchema: z.ZodType;
  quote(raw: unknown): Quote;
}

type CountedParams = Params & { count: number };

interface ModelSpec<S extends z.ZodType<CountedParams>>
  extends Omit<Model, "paramsSchema" | "quote"> {
  params: S;
  pricePerImage(params: z.output<S>): number;
}

export function defineModel<S extends z.ZodType<CountedParams>>({
  params,
  pricePerImage,
  ...meta
}: ModelSpec<S>): Model {
  return {
    ...meta,
    paramsSchema: params,
    quote(raw) {
      const parsed = params.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.join(".") || "params"}: ${issue.message}`,
          ),
        };
      }
      const images = parsed.data.count;
      return {
        ok: true,
        params: parsed.data,
        images,
        priceCredits: pricePerImage(parsed.data) * images,
      };
    },
  };
}
