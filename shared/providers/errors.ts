export const generationErrors = {
  PROVIDER_ERROR: { retryable: true, message: "The provider had an error." },
  PROVIDER_BUSY: { retryable: true, message: "The provider was out of capacity." },
  RATE_LIMITED: { retryable: true, message: "The provider asked us to slow down." },
  NO_OUTPUT: { retryable: true, message: "The provider returned no image." },
  STORAGE_FAILED: { retryable: true, message: "We couldn't save the result." },
  SAFETY_REFUSAL: { retryable: false, message: "The provider rejected this prompt." },
  INVALID_INPUT: { retryable: false, message: "The provider couldn't read the input image." },
  TIMED_OUT: { retryable: false, message: "This took too long and was stopped." },
} as const satisfies Record<string, { retryable: boolean; message: string }>;

export type GenerationErrorCode = keyof typeof generationErrors;

export const generationErrorCodes = Object.keys(generationErrors) as GenerationErrorCode[];
