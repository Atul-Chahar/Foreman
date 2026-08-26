// Rate limiting for GitHub tool calls. Eight agents hammering the GitHub API
// in parallel will hit primary and secondary rate limits; this wrapper makes
// the swarm back off and queue instead of fail.
//
// - token bucket: steady rate, small burst
// - on a rate-limit indication: honor Retry-After when present, else
//   exponential backoff, max 3 attempts

export class RateLimiter {
  constructor({ capacity = 30, refillPerSec = 5, maxAttempts = 3 } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.maxAttempts = maxAttempts;
    this._tokens = capacity;
    this._last = Date.now();
    this._inFlight = 0;
  }

  async acquire() {
    for (;;) {
      this._refill();
      if (this._tokens >= 1 && this._inFlight < this.capacity) {
        this._tokens -= 1;
        this._inFlight++;
        return;
      }
      await sleep(25);
    }
  }

  _release() {
    this._inFlight = Math.max(0, this._inFlight - 1);
  }

  _refill() {
    const now = Date.now();
    this._tokens = Math.min(this.capacity, this._tokens + ((now - this._last) / 1000) * this.refillPerSec);
    this._last = now;
  }

  /**
   * Run fn with a token; retry on rate-limit indications and transient
   * transport failures. The concurrency slot is released between attempts —
   * sleeping callers must not count as in-flight work.
   */
  async run(fn) {
    let lastErr;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      await this.acquire();
      let outcome;
      try {
        outcome = { ok: true, value: await fn(attempt) };
      } catch (err) {
        outcome = { ok: false, err };
      } finally {
        this._release();
      }
      if (outcome.ok) return outcome.value;
      lastErr = outcome.err;
      if (!this._shouldRetry(outcome.err)) throw outcome.err;
      // backoff happens OUTSIDE the slot
      const waitMs = this._retryAfterMs(outcome.err) ?? 2 ** attempt * 1000;
      await sleep(waitMs);
    }
    throw lastErr;
  }

  _shouldRetry(err) {
    return this._isRateLimit(err) || err?.code === 'MCP_TRANSPORT';
  }

  _isRateLimit(err) {
    return /rate.?limit|too many requests|429|403.*abuse/i.test(String(err?.message ?? ''));
  }

  _retryAfterMs(err) {
    const m = /retry.?after[:\s]+(\d+)/i.exec(String(err?.message ?? ''));
    return m ? Number(m[1]) * 1000 : null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
