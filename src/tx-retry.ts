export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isRetryableTxError(error: unknown): boolean {
  const text = stringifyError(error);
  return (
    text.includes('Gateway Timeout') ||
    text.includes('Account_nonce_precondition_unsatisfied') ||
    text.includes('Failed to fetch') ||
    text.includes('fetch failed')
  );
}

export async function withTxRetry<T>(
  operation: (attempt: number) => Promise<T>,
  opts?: { attempts?: number; initialDelayMs?: number; label?: string }
): Promise<T> {
  const attempts = opts?.attempts ?? 4;
  const initialDelayMs = opts?.initialDelayMs ?? 4000;
  const label = opts?.label ?? 'tx';
  let delay = initialDelayMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryableTxError(error) || attempt === attempts) {
        throw error;
      }
      console.warn(`[${label}] retryable failure on attempt ${attempt}/${attempts}: ${String(error)}`);
      console.warn(`[${label}] sleeping ${delay}ms before retry`);
      await sleep(delay);
      delay *= 2;
    }
  }

  throw lastError ?? new Error(`[${label}] failed with unknown error`);
}
