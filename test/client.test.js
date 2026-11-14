// -----------------------------------------------------------------------------
// The session: the key in the Authorization header, what is a refusal and
// what is not, one request at a time, bounded answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PstrykError, PstrykSession, retryAfterMs } from '../src/pstryk/client.js';
import { createPstryk, json } from './helpers/app.js';
import * as P from './fixtures/pstryk.js';

const FROM = Date.parse('2026-11-10T23:00:00Z');
const TO = FROM + 24 * P.HOUR;

function session(pstryk, { clock = { now: 0 }, gap = 0 } = {}) {
  return new PstrykSession({
    apiKey: P.API_KEY,
    fetchImpl: pstryk.fetch,
    monotonic: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    gap,
  });
}

const rejects = (promise, code) =>
  assert.rejects(promise, (err) => err instanceof PstrykError && err.code === code);

test('Retry-After: seconds or a date against the Date header, never the local clock', () => {
  assert.equal(retryAfterMs('120'), 120_000);
  assert.equal(
    retryAfterMs('Wed, 11 Nov 2026 10:05:00 GMT', 'Wed, 11 Nov 2026 10:00:00 GMT'),
    300_000,
  );
  assert.equal(retryAfterMs('Wed, 11 Nov 2026 10:05:00 GMT'), undefined);
  assert.equal(retryAfterMs(''), undefined);
});

test('the request: the key alone in Authorization, UTC instants without milliseconds, hourly', async () => {
  const pstryk = createPstryk();
  const body = await session(pstryk).metrics('pricing', FROM, TO);
  assert.equal(body.frames.length, 24);
  const [call] = pstryk.calls;
  assert.equal(call.auth, P.API_KEY);
  assert.equal(call.headers.Accept, 'application/json');
  assert.equal(call.headers['Accept-Language'], 'en');
  assert.match(
    call.headers['User-Agent'],
    /^gladys-pstryk\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-pstryk\)$/,
  );
  assert.equal(call.method, 'GET');
  assert.deepEqual(call.query, {
    metrics: 'pricing',
    resolution: 'hour',
    window_start: '2026-11-10T23:00:00Z',
    window_end: '2026-11-11T23:00:00Z',
  });
  assert.ok(!call.url.includes(P.API_KEY), 'the key never in the URL');
});

test('refusal: only a 401/403 whose detail says the key is wrong', async () => {
  for (const [answer, code] of [
    [() => json(P.REFUSED_BODY, 403), 'refused'],
    [() => json({ detail: 'Invalid token.' }, 401), 'refused'],
    [() => json({ detail: 'Błędne dane uwierzytelniające.' }, 403), 'refused'],
    [() => json({ detail: 'Authentication credentials were not provided.' }, 403), 'unauthorized'],
    [
      () => json({ detail: 'You do not have permission to perform this action.' }, 403),
      'unauthorized',
    ],
    [() => json({}, 401), 'unauthorized'],
    [() => new Response('<html>Forbidden</html>', { status: 403 }), 'unauthorized'],
    [() => json(P.REFUSED_BODY, 400), 'http'],
    [() => json({ detail: 'Not found.' }, 404), 'not_found'],
    [() => json(P.REFUSED_BODY, 503), 'server'],
    [() => json({}, 429, { 'retry-after': '60' }), 'rate_limited'],
    [() => new Response('not json', { status: 200 }), 'bad_response'],
    [() => new Response('[1,2]', { status: 200 }), 'bad_response'],
    [() => 'network', 'network'],
    [() => 'timeout', 'network'],
  ]) {
    await rejects(session(createPstryk({ pricing: answer })).metrics('pricing', FROM, TO), code);
  }
});

test('a 429 carries its Retry-After', async () => {
  const pstryk = createPstryk({ pricing: () => json({}, 429, { 'retry-after': '90' }) });
  await assert.rejects(session(pstryk).metrics('pricing', FROM, TO), (err) => {
    assert.equal(err.code, 'rate_limited');
    assert.equal(err.retryAfter, 90_000);
    return true;
  });
});

test('one request at a time, REQUEST_GAP apart from the end of the previous one', async () => {
  const clock = { now: 0 };
  let inFlight = 0;
  let peak = 0;
  const pstryk = createPstryk({
    pricing: async (call, now) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      return P.pricing({ from: FROM, to: TO, now });
    },
  });
  const s = session(pstryk, { clock, gap: 2000 });
  await Promise.all([1, 2, 3].map(() => s.metrics('pricing', FROM, TO)));
  assert.equal(peak, 1);
  assert.equal(pstryk.count('pricing'), 3);
  assert.equal(clock.now, 4000);
});

test('a body too large is refused before being read whole; a declared length is enough', async () => {
  const declared = createPstryk({
    pricing: () =>
      new Response('{}', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } }),
  });
  await rejects(session(declared).metrics('pricing', FROM, TO), 'too_large');
  let pulled = 0;
  const streamed = createPstryk({
    pricing: () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled += 1;
            // 16 MB in all (bounded even if the cut fails): cut past the bound.
            if (pulled > 64) controller.close();
            else controller.enqueue(new Uint8Array(256 * 1024).fill(32));
          },
        }),
        { status: 200 },
      ),
  });
  await rejects(session(streamed).metrics('pricing', FROM, TO), 'too_large');
  assert.ok(pulled <= 12, `${pulled} chunks read`);
});

test('close(): the request in flight is aborted, nothing more sent', async () => {
  const pstryk = createPstryk({
    pricing: (call) =>
      new Promise((_, reject) =>
        call.signal.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))),
      ),
  });
  const s = session(pstryk);
  const pending = s.metrics('pricing', FROM, TO);
  await new Promise((r) => setImmediate(r));
  s.close();
  await rejects(pending, 'stopped');
  await rejects(s.metrics('pricing', FROM, TO), 'stopped');
  assert.equal(pstryk.count('pricing'), 1);
});

test('no secret and no answer text in an error message', async () => {
  const pstryk = createPstryk({
    pricing: () => json({ detail: `bad key ${P.API_KEY}` }, 403),
  });
  await assert.rejects(session(pstryk).metrics('pricing', FROM, TO), (err) => {
    assert.ok(!String(err.message).includes(P.API_KEY));
    assert.ok(!String(err.message).includes('bad key'));
    return true;
  });
});
