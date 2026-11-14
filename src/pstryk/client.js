// -----------------------------------------------------------------------------
// The only place that talks to the network: GET requests of the customer's own
// data on the Pstryk integration API, with the API key the customer created in
// the Pstryk app, a timeout, a bounded body and an identifiable User-Agent.
//
// The session (one per key) sends one request at a time, at least REQUEST_GAP
// apart. The key is sent in the Authorization header only (never logged, never
// in /data, never in a URL). A 401/403 whose `detail` is the API's own "wrong
// credentials" text is the ONLY refusal: every other error (another 401/403,
// an unreadable answer, a 404, a 5xx) is passing.
//
// Error messages carry a code and a status at most, never the text of the
// answer.
// -----------------------------------------------------------------------------

import {
  API_URL,
  MAX_BODY_BYTES,
  METRICS_PATH,
  REQUEST_GAP,
  REQUEST_TIMEOUT,
  USER_AGENT,
} from '../constants.js';

export class PstrykError extends Error {
  constructor(code, { status, retryAfter } = {}) {
    super(`Pstryk: ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'PstrykError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * The `detail` of the API (Django REST framework) when the key itself is
 * wrong, in English (asked with Accept-Language) and in Polish (its default).
 * "Authentication credentials were not provided." is not one: the key is
 * always sent, so that answer means the header was lost on the way.
 */
const REFUSED = new Set([
  'Incorrect authentication credentials.',
  'Invalid token.',
  'Błędne dane uwierzytelniające.',
  'Niepoprawny token.',
]);

/** Retry-After (seconds or an HTTP date, against the Date header) -> ms; undefined otherwise. */
export function retryAfterMs(value, dateHeader) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  const ref = Date.parse(dateHeader ?? '');
  // Without a readable Date of the server, a date cannot be measured.
  return Number.isFinite(at) && Number.isFinite(ref) ? Math.max(0, at - ref) : undefined;
}

/** The body as text, never more than `max` bytes (cut and refused beyond). */
export async function boundedText(response, max) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel?.().catch(() => {});
    throw new PstrykError('too_large');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > max) throw new PstrykError('too_large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new PstrykError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** The JSON object of a body; undefined when it is not one. */
function parseObject(text) {
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

/** One HTTP exchange: `{ status, body }` (body: a JSON object or undefined), or an PstrykError. */
export async function exchange({
  fetchImpl,
  url,
  method = 'GET',
  headers = {},
  body,
  signal,
  timeout = REQUEST_TIMEOUT,
  maxBytes = MAX_BODY_BYTES,
}) {
  const timer = AbortSignal.timeout(timeout);
  const both = signal ? AbortSignal.any([signal, timer]) : timer;
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Accept-Language': 'en',
        ...headers,
      },
      ...(body !== undefined ? { body } : {}),
      signal: both,
      redirect: 'error',
    });
    text = await boundedText(response, maxBytes);
  } catch (err) {
    if (err instanceof PstrykError) throw err;
    if (signal?.aborted) throw new PstrykError('stopped');
    throw new PstrykError(timer.aborted ? 'timeout' : 'network');
  }
  const status = response.status;
  if (status === 429) {
    throw new PstrykError('rate_limited', {
      status,
      retryAfter: retryAfterMs(
        response.headers?.get?.('retry-after'),
        response.headers?.get?.('date'),
      ),
    });
  }
  if (status >= 500) throw new PstrykError('server', { status });
  return { status, body: parseObject(text) };
}

/** Whether a 401/403 answer says the key itself is wrong. */
export const isRefusal = (status, body) =>
  (status === 401 || status === 403) &&
  typeof body?.detail === 'string' &&
  REFUSED.has(body.detail);

export class PstrykSession {
  constructor({
    apiKey,
    fetchImpl = globalThis.fetch,
    api = API_URL,
    monotonic = () => performance.now(),
    sleep,
    timeout,
    gap = REQUEST_GAP,
  }) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.api = api;
    this.monotonic = monotonic;
    this.sleep = sleep;
    this.timeout = timeout;
    this.gap = gap;
    this.lane = Promise.resolve();
    this.lastSent = -Infinity;
    this.abort = new AbortController();
    this.closed = false;
    /** Requests sent (tests). */
    this.sent = 0;
  }

  /** Stops the session: the request in flight is aborted, nothing more is sent. */
  close() {
    this.closed = true;
    this.abort.abort();
  }

  /** One request at a time, REQUEST_GAP apart. */
  exclusive(fn) {
    const job = this.lane.then(fn, fn);
    this.lane = job.catch(() => {});
    return job;
  }

  async send(options) {
    if (this.closed) throw new PstrykError('stopped');
    const wait = this.lastSent + this.gap - this.monotonic();
    if (wait > 0 && this.sleep) await this.sleep(wait);
    if (this.closed) throw new PstrykError('stopped');
    this.lastSent = this.monotonic();
    this.sent += 1;
    try {
      return await exchange({
        fetchImpl: this.fetchImpl,
        signal: this.abort.signal,
        ...(this.timeout ? { timeout: this.timeout } : {}),
        ...options,
      });
    } finally {
      // The gap counts from the end of a request: a slow answer never shortens it.
      this.lastSent = this.monotonic();
    }
  }

  /**
   * One read of the unified metrics endpoint: `metrics` (e.g. "pricing"),
   * hourly frames from `from` to `to` (ms, whole hours, UTC). Resolves the
   * JSON object.
   */
  metrics(metrics, from, to) {
    const query = new URLSearchParams({
      metrics,
      resolution: 'hour',
      window_start: iso(from),
      window_end: iso(to),
    });
    return this.exclusive(async () => {
      const { status, body } = await this.send({
        url: `${this.api}${METRICS_PATH}?${query}`,
        headers: { Authorization: this.apiKey },
      });
      if (isRefusal(status, body)) throw new PstrykError('refused', { status });
      if (status === 401 || status === 403) throw new PstrykError('unauthorized', { status });
      if (status === 404) throw new PstrykError('not_found', { status });
      if (status !== 200) throw new PstrykError('http', { status });
      if (!body) throw new PstrykError('bad_response', { status });
      return body;
    });
  }
}

/** "2026-11-11T10:00:00Z": the only form of instant the API accepts (UTC, no milliseconds). */
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
