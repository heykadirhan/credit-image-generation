/* eslint-disable */
/**
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import type * as generations from "../generations.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_errors from "../lib/errors.js";
import type * as runner from "../runner.js";

declare const fullApi: ApiFromModules<{
  generations: typeof generations;
  "lib/auth": typeof lib_auth;
  "lib/errors": typeof lib_errors;
  runner: typeof runner;
}>;
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
