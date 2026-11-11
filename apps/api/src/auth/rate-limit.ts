import { ApiError } from '../lib/errors.js';

type Attempt = { failures: number; inFlight: number; resetAt: number };
type Outcome = 'success' | 'failure' | 'cancel';

export function createAttemptLimiter(limit: number, windowMs: number, message: string, clock = Date.now) {
  const attempts = new Map<string, Attempt>();
  let nextSweepAt = 0;

  return function begin(key: string): (outcome: Outcome) => void {
    const now = clock();
    if (now >= nextSweepAt) {
      for (const [source, attempt] of attempts) {
        if (attempt.resetAt <= now) attempts.delete(source);
      }
      nextSweepAt = now + windowMs;
    }
    let attempt = attempts.get(key);
    if (!attempt || attempt.resetAt <= now) {
      if (attempts.size >= 10_000 && !attempt) throw new ApiError(429, 'RATE_LIMITED', message);
      attempt = { failures: 0, inFlight: 0, resetAt: now + windowMs };
      attempts.set(key, attempt);
    }
    if (attempt.failures + attempt.inFlight >= limit) throw new ApiError(429, 'RATE_LIMITED', message);
    attempt.inFlight += 1;
    let completed = false;
    return (outcome) => {
      if (completed) return;
      completed = true;
      attempt.inFlight -= 1;
      if (outcome === 'success') attempt.failures = 0;
      if (outcome === 'failure') attempt.failures += 1;
      if (attempt.failures === 0 && attempt.inFlight === 0 && attempts.get(key) === attempt) attempts.delete(key);
    };
  };
}
