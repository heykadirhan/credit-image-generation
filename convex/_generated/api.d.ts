/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as generations from "../generations.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_credits from "../lib/credits.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_queue from "../lib/queue.js";
import type * as runner from "../runner.js";
import type * as settle from "../settle.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  generations: typeof generations;
  "lib/auth": typeof lib_auth;
  "lib/credits": typeof lib_credits;
  "lib/errors": typeof lib_errors;
  "lib/queue": typeof lib_queue;
  runner: typeof runner;
  settle: typeof settle;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
