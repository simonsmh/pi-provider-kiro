// ABOUTME: Stream recovery helpers and Kiro-specific error classification.
// ABOUTME: Keeps provider-local retry logic limited to auth refresh and stream quirks.

// kiro-cli uses 5-minute read/operation timeouts (DEFAULT_TIMEOUT_DURATION)
// and 5-minute stalled stream grace period. 90s matches the TUI's
// INITIAL_RESPONSE_TIMEOUT_MS for the first event from the backend.
export const FIRST_TOKEN_TIMEOUT = 90_000;

// Configurable via environment variables for users on flaky networks
const ENV_FIRST_TOKEN_TIMEOUT = process.env.KIRO_FIRST_TOKEN_TIMEOUT_MS;
const ENV_MAX_RETRY_DELAY = process.env.KIRO_MAX_RETRY_DELAY_MS;
const ENV_CAPACITY_MAX_RETRIES = process.env.KIRO_CAPACITY_MAX_RETRIES;
const ENV_CAPACITY_BASE_DELAY_MS = process.env.KIRO_CAPACITY_BASE_DELAY_MS;

export function firstTokenTimeoutForModel(modelId: string): number {
  // Allow test overrides via retryConfig.firstTokenTimeoutMs
  if (retryConfig.firstTokenTimeoutMs !== FIRST_TOKEN_TIMEOUT) {
    return retryConfig.firstTokenTimeoutMs;
  }
  // Env var overrides for user configuration
  if (ENV_FIRST_TOKEN_TIMEOUT) {
    const parsed = parseInt(ENV_FIRST_TOKEN_TIMEOUT, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  // Opus models need more time for initial reasoning
  return modelId.includes("opus") ? 180_000 : FIRST_TOKEN_TIMEOUT;
}

// Mutable config for values that tests need to override
export const retryConfig = {
  firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT,
};

export function exponentialBackoff(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

export const MAX_RETRY_DELAY = ENV_MAX_RETRY_DELAY ? parseInt(ENV_MAX_RETRY_DELAY, 10) || 10_000 : 10_000;

export const TOO_BIG_PATTERNS = ["CONTENT_LENGTH_EXCEEDS_THRESHOLD", "Input is too long", "Improperly formed"];
const NON_RETRYABLE_BODY_PATTERNS = ["MONTHLY_REQUEST_COUNT"];
const CAPACITY_PATTERN = "INSUFFICIENT_MODEL_CAPACITY";

export const CAPACITY_MAX_RETRIES = ENV_CAPACITY_MAX_RETRIES ? parseInt(ENV_CAPACITY_MAX_RETRIES, 10) || 3 : 3;
export const CAPACITY_BASE_DELAY_MS = ENV_CAPACITY_BASE_DELAY_MS
  ? parseInt(ENV_CAPACITY_BASE_DELAY_MS, 10) || 5_000
  : 5_000;

// Mutable capacity config for testing
export const capacityRetryConfig = {
  maxRetries: CAPACITY_MAX_RETRIES,
  baseDelayMs: CAPACITY_BASE_DELAY_MS,
};

/** Check whether an HTTP error represents a "request too large" condition. */
export function isTooBigError(status: number, errorText: string): boolean {
  return status === 413 || (status === 400 && TOO_BIG_PATTERNS.some((p) => errorText.includes(p)));
}

/** Check whether the response body contains a Kiro-specific non-retryable marker. */
export function isNonRetryableBodyError(errorText: string): boolean {
  return NON_RETRYABLE_BODY_PATTERNS.some((p) => errorText.includes(p));
}

/** Check whether the error is a transient capacity issue worth retrying. */
export function isCapacityError(errorText: string): boolean {
  return errorText.includes(CAPACITY_PATTERN);
}
