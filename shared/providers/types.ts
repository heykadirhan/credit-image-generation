import type { Params, Provider } from "../models/define";
import type { GenerationErrorCode } from "./errors";

export interface StartJob {
  generationId: string;
  attempt: number;
  modelId: string;
  params: Params;
  prompt: string;
  inputImageUrls: string[];
  webhookUrl: string;
}

export type ProviderResult =
  | { kind: "succeeded"; imageUrls: string[]; costUsd?: number }
  | { kind: "failed"; code: GenerationErrorCode; message: string; costUsd?: number }
  | { kind: "pending" };

export interface ProviderAdapter {
  id: Provider;
  maxConcurrentJobs: number;
  start(job: StartJob): Promise<{ externalJobId: string }>;
  parseWebhook(body: unknown): ProviderResult;
  poll(externalJobId: string): Promise<ProviderResult>;
  cancel?(externalJobId: string): Promise<void>;
}
