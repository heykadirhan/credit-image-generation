export type PlanId = "free" | "starter" | "pro" | "studio_pro" | "enterprise";

export interface PlanLimits {
  atOnce: number;
  inBackground: number;
  priority: boolean;
}

export const planLimits: Record<PlanId, PlanLimits> = {
  free: { atOnce: 1, inBackground: 4, priority: false },
  starter: { atOnce: 1, inBackground: 4, priority: false },
  pro: { atOnce: 4, inBackground: 8, priority: true },
  studio_pro: { atOnce: 4, inBackground: 12, priority: true },
  enterprise: { atOnce: 4, inBackground: 12, priority: true },
};
