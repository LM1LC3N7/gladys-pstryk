// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, setTimeout) and a real local
// HTTP server playing the Pstryk API: today's prices never come, so the recent
// prices are really read at 0, the interval and twice the interval, with a
// bounded number of timers, and nothing is sent after stop(). The time is sped
// up 10000 times (1 hour lasts 0.36 s) but it is the real clock: it moves
// between any two reads.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PstrykApp } from '../src/app.js';
import { PRICES_INTERVAL } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { startOfDay } from '../src/time.js';
import { opOf } from './helpers/app.js';
import * as P from './fixtures/pstryk.js';

const SPEED = 10_000;

test('real clock: the recent prices read at 0, the interval and twice the interval; timers bounded', async (t) => {
  const reads = [];
  let requests = 0;
  let t0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests += 1;
      const url = new URL(`http://x${req.url}`);
      const now = P.NOW + (performance.now() - t0) * SPEED;
      const from = Date.parse(url.searchParams.get('window_start'));
      const to = Date.parse(url.searchParams.get('window_end'));
      const today = startOfDay(now);
      const body = P.pricing({
        from,
        to,
        now,
        price: (h) => (h >= today ? undefined : P.priceOf(h)),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / SPEED);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
  const gladys = createFakeGladys({ selector: 'pstryk', config: { api_key: P.API_KEY } });
  await gladys.connect();
  const quiet = () => {};
  t0 = performance.now();
  const app = new PstrykApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: () => P.NOW + (performance.now() - t0) * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: createMemoryStore(),
    api: `http://127.0.0.1:${server.address().port}`,
    // The time a request leaves (the first connection may take a while to be
    // set up: the period is the one of the attempts).
    fetchImpl: (url, init) => {
      const u = new URL(url);
      const now = P.NOW + (performance.now() - t0) * SPEED;
      if (opOf(url) === 'pricing' && Date.parse(u.searchParams.get('window_end')) > now) {
        reads.push(performance.now() * SPEED);
      }
      return fetch(url, init);
    },
  });
  // Stopped even when an assertion fails: no timer left behind.
  t.after(() => app.stop());
  const started = performance.now() * SPEED;
  await app.connected();
  const deadline = performance.now() + 20_000;
  const until = started + 2.5 * PRICES_INTERVAL;
  while (performance.now() * SPEED < until && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await app.stop();
  const sent = requests;
  await new Promise((resolve) => setTimeout(resolve, PRICES_INTERVAL / SPEED));
  assert.equal(requests, sent, 'nothing sent after stop()');
  const at = reads.map((x) => Math.round((x - started) / 60_000));
  assert.equal(reads.length, 3, `reads at ${at} min`);
  assert.ok(reads[0] - started < PRICES_INTERVAL / 4, `the first read at once: ${at}`);
  for (let i = 1; i < reads.length; i += 1) {
    const gap = reads[i] - reads[i - 1];
    assert.ok(gap >= 0.9 * PRICES_INTERVAL, `never sooner than the interval: ${at}`);
    assert.ok(gap < 1.5 * PRICES_INTERVAL, `on time: ${at}`);
  }
  assert.ok(timersSet <= 100, `${timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
