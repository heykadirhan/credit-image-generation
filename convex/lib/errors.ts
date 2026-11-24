import { ConvexError, type Value } from "convex/values";

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "UNKNOWN_MODEL"
  | "MODEL_UNAVAILABLE"
  | "INVALID_PARAMS"
  | "INVALID_PROMPT"
  | "INVALID_INPUT_IMAGES"
  | "PRICE_CHANGED"
  | "INSUFFICIENT_CREDITS"
  | "TOO_MANY_PENDING";

export function fail(code: ErrorCode, details: Record<string, Value> = {}): never {
  throw new ConvexError({ code, ...details });
}
