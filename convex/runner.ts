import { v } from "convex/values";
import { internalAction } from "./_generated/server";

export const start = internalAction({
  args: { generationId: v.id("generations") },
  handler: async () => {
    throw new Error("The runner is planned in README section 5 and is not part of this case's code.");
  },
});
