// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted Pstryk API and a virtual
// clock: pace, refusal, pauses, /data, Discovery, consumption, prices,
// delegated pricing, secrets.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagOf } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { createMemoryStore } from '../src/store.js';
import { addDays, fromLocal, local } from '../src/time.js';
import { DAY, HOUR, MINUTE, createPstryk, json, setup, written } from './helpers/app.js';
import * as P from './fixtures/pstryk.js';

const statusText = (env) => env.fake.connectionStatus?.message?.en ?? '';
const DEVICE = 'ext:pstryk:meter:pstryk';
const F = (feature) => `${DEVICE}:${feature}`;
const window = (c) => [Date.parse(c.query.window_start), Date.parse(c.query.window_end)];
const calls = (env, op) => env.pstryk.calls.filter((c) => c.op === op);

const deviceOf = (env) =>
  structuredClone(env.fake.discoveredDevices.find((d) => d.external_id === DEVICE));

async function started(options = {}) {
  const env = await setup(options);
  registerHandlers(env.gladys, env.app, env.app.log);
  await env.start(options.config);
  return env;
}

/** Started, then the device created by the user from Discovery. */
async function withDevice(options = {}) {
  const env = await started(options);
  await env.fake.deviceCreated(deviceOf(env));
  return env;
}

const contract = () => ({
  id: 'c1',
  template_key: 'pstryk-dynamic',
  inputs: { monthly_fees: 60 },
  currency: 'PLN',
  timezone: 'Europe/Warsaw',
  billing_period_start_day: 1,
});

const priceRequest = (env, starts, kwh = 1) =>
  env.fake.energyPrice({
    contract: contract(),
    billing_period: {},
    cumulative_before: {},
    intervals: starts.map((at) => ({
      starts_at: new Date(at).toISOString(),
      kwh,
      max_power_kw: 1,
    })),
  });

const stateOf = (env, feature) =>
  env.fake.states.filter((s) => s.device_feature_external_id === F(feature)).at(-1)?.state;

/** Prices of every hour but the ones from `from` on (not published yet). */
const until = (limit) => ({
  pricing: ({ query }, now) =>
    P.pricing({
      from: Date.parse(query.window_start),
      to: Date.parse(query.window_end),
      now,
      price: (h) => (h >= limit() ? undefined : P.priceOf(h)),
    }),
});

test('start: the recent prices, then the past ones by windows; Discovery, status; nothing secret written out', async (t) => {
  const env = await started();
  t.after(() => env.app.stop());
  assert.deepEqual(
    env.pstryk.calls.map((c) => c.op),
    ['pricing', 'pricing', 'pricing'],
  );
  const [recent, past1, past2] = env.pstryk.calls;
  assert.match(
    recent.url,
    /^https:\/\/api\.pstryk\.pl\/integrations\/meter-data\/unified-metrics\/\?/,
  );
  assert.equal(recent.auth, P.API_KEY);
  // Yesterday to the end of tomorrow first (Polish days), then the past the
  // core may ask (31 days) by windows of 16 days at most.
  assert.deepEqual(window(recent), [fromLocal(2026, 11, 10), fromLocal(2026, 11, 13)]);
  assert.deepEqual(window(past1), [fromLocal(2026, 10, 11), fromLocal(2026, 10, 27)]);
  assert.deepEqual(window(past2), [fromLocal(2026, 10, 27), fromLocal(2026, 11, 10)]);
  const [device] = env.fake.discoveredDevices;
  assert.equal(device.name, 'Pstryk');
  assert.equal(device.external_id, DEVICE);
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').at(-1)),
    ['price', 'next_price', 'sell_price', 'consumption'],
  );
  assert.equal(statusText(env), 'Connected: prices read at 11:00.');
  assert.equal(env.fake.connectionStatus.connected, true);
  const out = written(env);
  assert.ok(!out.includes(P.API_KEY), 'the key written out');
  assert.ok(!out.includes('Gl4dys'), 'part of the key written out');
  // 31 days back to the end of tomorrow, every hour.
  assert.equal(
    Object.keys(env.store.data.prices).length,
    (fromLocal(2026, 11, 13) - fromLocal(2026, 10, 11)) / HOUR,
  );
});

test('a key Pstryk never answered: no device offered', async (t) => {
  const pstryk = createPstryk({ pricing: () => 'network' });
  const env = await started({ pstryk });
  t.after(() => env.app.stop());
  assert.deepEqual(env.fake.discoveredDevices, []);
  await env.fake.scanRequest();
  assert.deepEqual(env.fake.discoveredDevices, []);
  assert.match(statusText(env), /^Pstryk not read \(network\): next try at 11:05\.$/);
  assert.equal(env.fake.connectionStatus.connected, false);
});

test('prices: published as features every hour; tomorrow looked for from 14:00, then hourly until there', async (t) => {
  let tomorrowOut = false;
  const tomorrow = fromLocal(2026, 11, 12);
  const pstryk = createPstryk(until(() => (tomorrowOut ? Infinity : tomorrow)));
  const env = await withDevice({ pstryk });
  t.after(() => env.app.stop());
  const now = env.clock.now;
  assert.equal(stateOf(env, 'price'), P.priceOf(now));
  assert.equal(stateOf(env, 'next_price'), P.priceOf(now + HOUR));
  assert.equal(stateOf(env, 'sell_price'), P.sellOf(now));
  assert.equal(calls(env, 'pricing').length, 3);
  // Today is held: nothing before 14:00 (13:00 UTC).
  await env.wait(3 * HOUR - MINUTE);
  assert.equal(calls(env, 'pricing').length, 3);
  // The features follow the hour without any request.
  assert.equal(stateOf(env, 'price'), P.priceOf(now + 2 * HOUR));
  await env.wait(2 * MINUTE);
  assert.equal(calls(env, 'pricing').length, 4);
  await env.wait(HOUR);
  assert.equal(calls(env, 'pricing').length, 5);
  // Tomorrow out at 16:00: kept, then read once more 3 hours later to confirm it.
  tomorrowOut = true;
  await env.wait(HOUR);
  assert.equal(calls(env, 'pricing').length, 6);
  await env.wait(3 * HOUR - 2 * MINUTE);
  assert.equal(calls(env, 'pricing').length, 6);
  await env.wait(3 * MINUTE);
  assert.equal(calls(env, 'pricing').length, 7);
  assert.equal(env.store.data.confirmed, '2026-11-12');
  // All held and confirmed: nothing until tomorrow 14:00.
  await env.wait(19 * HOUR - 4 * MINUTE);
  assert.equal(calls(env, 'pricing').length, 7);
  await env.wait(3 * MINUTE);
  assert.equal(calls(env, 'pricing').length, 8);
});

test('the next hour unknown: its feature is left out, never 0; no price now: said in the status', async (t) => {
  const pstryk = createPstryk(until(() => fromLocal(2026, 11, 12)));
  const env = await withDevice({ pstryk, now: fromLocal(2026, 11, 11, 23, 10) });
  t.after(() => env.app.stop());
  assert.equal(stateOf(env, 'price'), P.priceOf(fromLocal(2026, 11, 11, 23)));
  assert.equal(stateOf(env, 'next_price'), undefined);
  assert.ok(!env.fake.states.some((s) => s.state === 0));
  // Past midnight, no price of the new day: nothing published, said.
  await env.wait(HOUR);
  assert.match(statusText(env), /No price of today is known yet/);
  const current = await env.fake.energyCurrent({ contract: contract(), cumulative: {} });
  assert.equal(current.data.price, null);
});

test('a flat day (placeholder prices) is never kept: asked again hourly', async (t) => {
  const tomorrow = fromLocal(2026, 11, 12);
  const pstryk = createPstryk({
    pricing: ({ query }, now) =>
      P.pricing({
        from: Date.parse(query.window_start),
        to: Date.parse(query.window_end),
        now,
        price: (h) => (h >= tomorrow ? 0.62 : P.priceOf(h)),
      }),
  });
  const env = await started({ pstryk, now: fromLocal(2026, 11, 11, 15) });
  t.after(() => env.app.stop());
  assert.equal(env.app.priceAt(tomorrow), undefined);
  const n = calls(env, 'pricing').length;
  await env.wait(HOUR + MINUTE);
  assert.equal(calls(env, 'pricing').length, n + 1);
});

test('pace: a restart waits for the rest of the interval; a time of /data in the future is ignored', async (t) => {
  const store = createMemoryStore();
  const pstryk = createPstryk(until(() => fromLocal(2026, 11, 12)));
  const env = await started({ store, pstryk, now: fromLocal(2026, 11, 11, 15) });
  await env.app.stop();
  const again = createPstryk(until(() => fromLocal(2026, 11, 12)));
  const later = await started({ store, pstryk: again, now: fromLocal(2026, 11, 11, 15, 20) });
  t.after(() => later.app.stop());
  assert.equal(again.calls.length, 0);
  assert.match(statusText(later), /^Connected: prices read at 15:00\./);
  await later.wait(39 * MINUTE);
  assert.equal(again.calls.length, 0);
  await later.wait(2 * MINUTE);
  assert.equal(again.count('pricing'), 1);
  await later.app.stop();
  // A last read dated in the future: invalid, read at once.
  const future = createMemoryStore({ lastPrices: P.NOW + DAY, version: 1 });
  const third = await started({ store: future });
  t.after(() => third.app.stop());
  assert.ok(third.pstryk.count('pricing') >= 1);
  // A success dated in the future is not a success.
  const fake = createMemoryStore({ lastPricesOk: P.NOW + DAY, version: 1 });
  const fourth = await started({ store: fake, pstryk: createPstryk({ pricing: () => 'network' }) });
  t.after(() => fourth.app.stop());
  assert.match(statusText(fourth), /^Pstryk not read \(network\)/);
});

test('the failed reads in a row are kept across a restart: their spacing, never the full interval', async (t) => {
  const store = createMemoryStore();
  const pstryk = createPstryk({ pricing: () => 'network' });
  const env = await started({ store, pstryk });
  await env.wait(5 * MINUTE + 1000);
  assert.equal(pstryk.count('pricing'), 2);
  await env.app.stop();
  const later = await started({ store, pstryk, now: env.clock.now + MINUTE });
  t.after(() => later.app.stop());
  assert.equal(pstryk.count('pricing'), 2);
  // Two failures: 10 minutes after the last attempt.
  await later.wait(10 * MINUTE);
  assert.equal(pstryk.count('pricing'), 3);
});

/** Another key whose 8-bit tag under the test salt is the refused key's one. */
const SALT = Buffer.alloc(16, 7).toString('hex');
let COLLIDING;
for (let i = 0; !COLLIDING; i += 1) {
  const key = `sk-another-key-${String(i).padStart(10, '0')}`;
  if (tagOf(SALT, key) === tagOf(SALT, P.API_KEY)) COLLIDING = key;
}

test('refusal: kept, nothing sent until another key or Test succeeds; a restart keeps it', async (t) => {
  const store = createMemoryStore();
  const pstryk = createPstryk({ pricing: () => json(P.REFUSED_BODY, 403) });
  const random = (n) => Buffer.alloc(n, 7);
  const env = await started({ store, pstryk, random });
  assert.equal(pstryk.count('pricing'), 1);
  assert.match(statusText(env), /^Pstryk refused the API key \(HTTP 403\)/);
  // No round left waiting at all.
  assert.equal(env.app.roundTimer, null);
  await env.wait(DAY);
  assert.equal(pstryk.count('pricing'), 1);
  assert.equal(store.data.refused.tag >= 0 && store.data.refused.tag < 256, true);
  assert.ok(!JSON.stringify(store.data).includes(P.API_KEY));
  await env.app.stop();
  const again = await started({ store, pstryk, random });
  t.after(() => again.app.stop());
  assert.equal(pstryk.count('pricing'), 1);
  assert.match(statusText(again), /refused the API key/);
  // Test with the same key: one request, refused again.
  const refused = await again.fake.action('test_connection');
  assert.match(refused.message?.en ?? JSON.stringify(refused), /refused/);
  assert.equal(pstryk.count('pricing'), 2);
  // Another key: always tried (never sooner than a minute), even if its tag matched.
  pstryk.answers.pricing = undefined;
  Object.assign(pstryk.answers, createPstryk().answers);
  await again.fake.configUpdated({ api_key: COLLIDING });
  assert.equal(pstryk.count('pricing'), 2);
  await again.wait(MINUTE + 1000);
  assert.ok(pstryk.count('pricing') >= 3);
  assert.equal(pstryk.calls.at(-1).auth, COLLIDING);
  assert.match(statusText(again), /^Connected/);
});

test('the Test button lifts a refusal on success, at most once a minute', async (t) => {
  const pstryk = createPstryk({ pricing: () => json(P.REFUSED_BODY, 403) });
  const env = await started({ pstryk });
  t.after(() => env.app.stop());
  Object.assign(pstryk.answers, createPstryk().answers);
  const ok = await env.fake.action('test_connection');
  assert.match(JSON.stringify(ok), /the API key works \(1 hourly price/);
  assert.equal(pstryk.count('pricing'), 2);
  const soon = await env.fake.action('test_connection');
  assert.match(JSON.stringify(soon), /one test a minute/);
  assert.equal(pstryk.count('pricing'), 2);
  // Read soon after, never at once.
  await env.wait(30 * 1000);
  assert.equal(pstryk.count('pricing'), 2);
  await env.wait(MINUTE);
  assert.ok(pstryk.count('pricing') >= 3);
  assert.match(statusText(env), /^Connected/);
});

for (const [name, answer] of [
  ['a 403 without the wrong-key text', () => json({ detail: 'You do not have permission.' }, 403)],
  ['a 401 without body', () => new Response('', { status: 401 })],
  ['an HTML 403', () => new Response('<html>403</html>', { status: 403 })],
  ['a 404', () => json({ detail: 'Not found.' }, 404)],
  ['an answer that is not JSON', () => new Response('<html>', { status: 200 })],
  ['frames that are not a list', () => json({ frames: 'x', summary: {} })],
]) {
  test(`not a refusal: ${name}; tried again after 5, then 10 minutes`, async (t) => {
    const pstryk = createPstryk({ pricing: answer });
    const env = await started({ pstryk });
    t.after(() => env.app.stop());
    assert.equal(pstryk.count('pricing'), 1);
    assert.doesNotMatch(statusText(env), /refused/);
    assert.equal(env.store.data.refused, null);
    await env.wait(5 * MINUTE + 1000);
    assert.equal(pstryk.count('pricing'), 2);
    await env.wait(9 * MINUTE);
    assert.equal(pstryk.count('pricing'), 2);
    await env.wait(MINUTE + 1000);
    assert.equal(pstryk.count('pricing'), 3);
  });
}

test('429: paused as long as asked (persisted, capped to 6 hours), the Test button refused meanwhile', async (t) => {
  const store = createMemoryStore();
  const pstryk = createPstryk({
    pricing: () => json({ detail: 'Throttled.' }, 429, { 'retry-after': '7200' }),
  });
  const env = await started({ store, pstryk });
  assert.equal(pstryk.count('pricing'), 1);
  assert.match(statusText(env), /asked to slow down \(HTTP 429\): no request until 13:00/);
  const test1 = await env.fake.action('test_connection');
  assert.match(JSON.stringify(test1), /asked to wait until 13:00/);
  assert.equal(pstryk.count('pricing'), 1);
  await env.app.stop();
  // A restart within the pause: still paused.
  const again = await started({ store, pstryk, now: P.NOW + HOUR });
  t.after(() => again.app.stop());
  assert.equal(pstryk.count('pricing'), 1);
  Object.assign(pstryk.answers, createPstryk().answers);
  await again.wait(HOUR - MINUTE);
  assert.equal(pstryk.count('pricing'), 1);
  await again.wait(2 * MINUTE);
  assert.ok(pstryk.count('pricing') >= 2);
  assert.match(statusText(again), /^Connected/);
  // A huge Retry-After: 6 hours at most.
  const huge = createPstryk({ pricing: () => json({}, 429, { 'retry-after': '999999' }) });
  const third = await started({ pstryk: huge });
  t.after(() => third.app.stop());
  assert.equal(third.store.data.pause.until - third.clock.now, 6 * HOUR);
});

test('5xx: paused 5 minutes, doubled; never on every request', async (t) => {
  const pstryk = createPstryk({ pricing: () => json({}, 502) });
  const env = await started({ pstryk });
  t.after(() => env.app.stop());
  assert.equal(pstryk.count('pricing'), 1);
  assert.match(statusText(env), /unavailable \(HTTP 502\)/);
  await env.wait(5 * MINUTE + 1000);
  assert.equal(pstryk.count('pricing'), 2);
  await env.wait(9 * MINUTE);
  assert.equal(pstryk.count('pricing'), 2);
  await env.wait(MINUTE + 1000);
  assert.equal(pstryk.count('pricing'), 3);
});

test('an answer too large is cut, never read whole; a passing error', async (t) => {
  let pulled = 0;
  const pstryk = createPstryk({
    pricing: () =>
      new Response(
        new ReadableStream({
          pull(c) {
            pulled += 1;
            // 16 MB in all (bounded even if the cut fails), far past the bound.
            if (pulled > 32) c.close();
            else c.enqueue(new Uint8Array(512 * 1024).fill(32));
          },
        }),
      ),
  });
  const env = await started({ pstryk });
  t.after(() => env.app.stop());
  assert.ok(pulled <= 6, `${pulled} chunks`);
  assert.match(statusText(env), /too_large/);
});

test('consumption: a new device gets 7 days in half hours; then 3 days every 3 hours', async (t) => {
  const env = await withDevice();
  t.after(() => env.app.stop());
  await env.wait(2 * MINUTE);
  assert.equal(env.pstryk.count('meter_values'), 1);
  const [call] = calls(env, 'meter_values');
  assert.equal(call.query.resolution, 'hour');
  assert.deepEqual(window(call), [fromLocal(2026, 11, 4), P.NOW]);
  const [batch] = env.fake.publishedEnergyConsumption;
  assert.equal(batch.device_feature_external_id, F('consumption'));
  assert.equal(batch.intervals[0].kwh, P.KWH / 2);
  assert.equal(batch.intervals.length, 2 * ((P.NOW - fromLocal(2026, 11, 4)) / HOUR));
  // Only ended hours: the last interval ends at or before now.
  const last = Date.parse(batch.intervals.at(-1).starts_at) + 30 * MINUTE;
  assert.ok(last <= env.clock.now);
  await env.wait(3 * HOUR);
  assert.equal(env.pstryk.count('meter_values'), 2);
  const second = calls(env, 'meter_values')[1];
  assert.equal(window(second)[0], fromLocal(2026, 11, 8));
  // The first read after 06:00 of a new day: 7 days again.
  await env.wait(18 * HOUR);
  const after6 = calls(env, 'meter_values').find((c) => c.at >= fromLocal(2026, 11, 12, 6));
  assert.equal(window(after6)[0], fromLocal(2026, 11, 5));
});

test('consumption: a value unreadable is left out, never 0; a 404 does not stop the prices', async (t) => {
  const pstryk = createPstryk({
    meter_values: ({ query }, now) => {
      const body = P.meterValues({
        from: Date.parse(query.window_start),
        to: Date.parse(query.window_end),
        now,
      });
      body.frames[0].metrics.meter_values.energy_active_import_register = null;
      body.frames[1].metrics.meter_values.energy_active_import_register = 'x';
      body.frames[2].metrics.meter_values.energy_active_import_register = -1;
      return body;
    },
  });
  const env = await withDevice({ pstryk });
  t.after(() => env.app.stop());
  await env.wait(2 * MINUTE);
  const [batch] = env.fake.publishedEnergyConsumption;
  assert.ok(batch.intervals.every((i) => i.kwh === P.KWH / 2));
  assert.equal(Date.parse(batch.intervals[0].starts_at), fromLocal(2026, 11, 4) + 3 * HOUR);
  pstryk.answers.meter_values = () => json({ detail: 'Not found.' }, 404);
  await env.wait(3 * HOUR);
  assert.match(statusText(env), /Consumption not read \(not_found 404\)/);
  assert.equal(env.fake.connectionStatus.connected, true);
  // The prices still read when due.
  const n = env.pstryk.count('pricing');
  pstryk.answers.pricing = createPstryk().answers.pricing;
  await env.wait(DAY);
  assert.ok(env.pstryk.count('pricing') > n);
});

test('delegated pricing: each half hour at the price of its hour, a negative price costs 0, unknown fails', async (t) => {
  const negative = fromLocal(2026, 11, 10, 13);
  const pstryk = createPstryk({
    pricing: ({ query }, now) =>
      P.pricing({
        from: Date.parse(query.window_start),
        to: Date.parse(query.window_end),
        now,
        price: (h) => (h === negative ? -0.25 : P.priceOf(h)),
      }),
  });
  const env = await started({ pstryk });
  t.after(() => env.app.stop());
  const t0 = fromLocal(2026, 11, 10, 8);
  const ack = await priceRequest(env, [t0, t0 + 30 * MINUTE, t0 + HOUR], 2);
  assert.equal(ack.success, true, JSON.stringify(ack));
  const [a, b, c] = ack.data.costs;
  assert.equal(a.cost, Math.round(2 * P.priceOf(t0) * 1e8) / 1e8);
  assert.equal(b.cost, a.cost);
  assert.equal(c.cost, Math.round(2 * P.priceOf(t0 + HOUR) * 1e8) / 1e8);
  assert.equal(a.label, 'Pstryk');
  const zero = await priceRequest(env, [negative, negative + 30 * MINUTE]);
  assert.equal(zero.success, true, JSON.stringify(zero));
  assert.deepEqual(
    zero.data.costs.map((x) => x.cost),
    [0, 0],
  );
  // Before the prices held: no cost (never a silent zero), the whole request.
  const missing = await priceRequest(env, [t0, t0 - 35 * DAY]);
  assert.equal(missing.success, false);
  // Not on a half hour: not priced.
  const odd = await priceRequest(env, [t0 + 10 * MINUTE]);
  assert.equal(odd.success, false);
});

test('delegated pricing and the current price answer from /data after a restart, without any request', async (t) => {
  const store = createMemoryStore();
  const env = await started({ store });
  await env.app.stop();
  const pstryk = createPstryk({ pricing: () => 'network' });
  const later = await started({ store, pstryk, now: P.NOW + 10 * MINUTE });
  t.after(() => later.app.stop());
  assert.equal(pstryk.calls.length, 0);
  const t0 = fromLocal(2026, 11, 11, 9);
  const ack = await priceRequest(later, [t0]);
  assert.equal(ack.success, true);
  assert.ok(Math.abs(ack.data.costs[0].cost - P.priceOf(t0)) < 1e-9);
  const current = await later.fake.energyCurrent({ contract: contract(), cumulative: {} });
  assert.equal(current.success, true);
  const now = later.clock.now;
  const h = now - (now % HOUR);
  assert.equal(current.data.price, P.priceOf(h));
  assert.equal(current.data.next_price, P.priceOf(h + HOUR));
  assert.equal(Date.parse(current.data.valid_until), h + HOUR);
});

test('an hour already started keeps the price first kept (a retry gets the same answer)', async (t) => {
  const env = await started();
  t.after(() => env.app.stop());
  const now = env.clock.now;
  const past = now - (now % HOUR) - HOUR;
  const future = now - (now % HOUR) + 4 * HOUR;
  env.app.record({
    buy: new Map([
      [past, 9],
      [future, 8],
    ]),
    sell: new Map(),
  });
  assert.equal(env.app.priceAt(past), P.priceOf(past));
  assert.equal(env.app.priceAt(future), 8);
});

test('the autumn change of time: 25 hours priced, the repeated hour twice with its own prices', async (t) => {
  const env = await started({ now: fromLocal(2026, 10, 25, 12) });
  t.after(() => env.app.stop());
  const day = fromLocal(2026, 10, 25);
  const starts = [];
  for (let at = day; at < addDays(day, 1); at += 30 * MINUTE) starts.push(at);
  assert.equal(starts.length, 50);
  const ack = await priceRequest(env, starts);
  assert.equal(ack.success, true, JSON.stringify(ack));
  // 02:00 CEST (00:00Z) and 02:00 CET (01:00Z): two hours, two prices.
  const at = (iso) => ack.data.costs.find((c) => c.starts_at === iso).cost;
  assert.equal(at('2026-10-25T00:00:00.000Z'), P.priceOf(Date.parse('2026-10-25T00:00:00Z')));
  assert.equal(at('2026-10-25T01:00:00.000Z'), P.priceOf(Date.parse('2026-10-25T01:00:00Z')));
});

test('midnight in Poland is not midnight UTC: the days read are Polish days', async (t) => {
  // 00:30 in Poland on the 12th, still the 11th in UTC.
  const env = await started({ now: Date.parse('2026-11-11T23:30:00Z') });
  t.after(() => env.app.stop());
  const [recent] = env.pstryk.calls;
  assert.deepEqual(window(recent), [fromLocal(2026, 11, 11), fromLocal(2026, 11, 14)]);
});

test('after a stop of 4 days: the missing prices read again, the whole backfill priced', async (t) => {
  const store = createMemoryStore();
  const env = await started({ store });
  await env.app.stop();
  const restartAt = env.clock.now + 4 * DAY;
  const pstryk = createPstryk();
  const later = await started({ store, pstryk, now: restartAt });
  t.after(() => later.app.stop());
  const windows = pstryk.calls.filter((c) => c.op === 'pricing');
  // Yesterday to tomorrow first, then from the first day missing (held up to the 13th).
  assert.equal(windows.length, 2);
  assert.deepEqual(window(windows[0]), [fromLocal(2026, 11, 14), fromLocal(2026, 11, 17)]);
  assert.deepEqual(window(windows[1]), [fromLocal(2026, 11, 13), fromLocal(2026, 11, 14)]);
  const starts = [];
  for (let at = fromLocal(2026, 11, 8); at + 30 * MINUTE <= restartAt; at += 30 * MINUTE) {
    starts.push(at);
  }
  const ack = await priceRequest(later, starts, 0.2);
  assert.equal(ack.success, true, JSON.stringify(ack).slice(0, 200));
  assert.match(statusText(later), /^Connected: prices read at 11:00\.$/);
});

test('a past hole Pstryk cannot fill is asked again every 6 hours, never more often; said, then gone', async (t) => {
  const hole = fromLocal(2026, 10, 20, 5);
  let fill = false;
  const pstryk = createPstryk({
    pricing: ({ query }, now) =>
      P.pricing({
        from: Date.parse(query.window_start),
        to: Date.parse(query.window_end),
        now,
        price: (h) => (h === hole && !fill ? undefined : P.priceOf(h)),
      }),
  });
  const env = await started({ pstryk });
  t.after(() => env.app.stop());
  assert.equal(pstryk.count('pricing'), 3);
  assert.match(statusText(env), /no complete prices for some past days/);
  // The whole day of the hole is missing, never part of it.
  assert.equal(env.app.priceAt(hole + HOUR), undefined);
  // 14:00: the confirmation of tomorrow only; the past not before 6 hours.
  await env.wait(6 * HOUR - MINUTE);
  assert.equal(pstryk.count('pricing'), 4);
  fill = true;
  await env.wait(2 * MINUTE);
  // From the day of the hole: 2 windows.
  assert.equal(pstryk.count('pricing'), 6);
  assert.equal(env.app.priceAt(hole), P.priceOf(hole));
  assert.doesNotMatch(statusText(env), /past days/);
});

test('another API key: the prices of the old one are forgotten and read again', async (t) => {
  const env = await started();
  t.after(() => env.app.stop());
  const n = env.pstryk.count('pricing');
  await env.fake.configUpdated({ api_key: 'sk-other-account-key-000' });
  assert.equal(Object.keys(env.store.data.prices).length, 0);
  const ack = await priceRequest(env, [fromLocal(2026, 11, 11, 9)]);
  assert.equal(ack.success, false);
  await env.wait(MINUTE + 1000);
  assert.ok(env.pstryk.count('pricing') > n);
  assert.equal(env.pstryk.calls.at(-1).auth, 'sk-other-account-key-000');
  assert.ok(env.app.priceAt(fromLocal(2026, 11, 11, 9)) !== undefined);
});

test('/data unreadable: never overwritten, read again, then used', async (t) => {
  const store = createMemoryStore({ lastPrices: P.NOW - HOUR + MINUTE, version: 1 });
  store.unreadable = true;
  const env = await started({ store });
  t.after(() => env.app.stop());
  assert.equal(store.saves, 0);
  assert.match(statusText(env), /\/data cannot be read/);
  // Unknown last read: a whole interval waited, never a read at once.
  assert.equal(env.pstryk.count('pricing'), 0);
  store.unreadable = false;
  await env.wait(11 * 1000);
  assert.ok(store.loads >= 2);
  assert.ok(store.saves >= 1);
  assert.doesNotMatch(statusText(env), /\/data/);
  assert.equal(env.pstryk.count('pricing'), 0);
  await env.wait(MINUTE);
  assert.ok(env.pstryk.count('pricing') >= 1);
});

test('/data that hangs: the start is not held, nothing saved over it', async (t) => {
  const store = createMemoryStore({ version: 1 });
  store.hang = true;
  const env = await setup({ store });
  registerHandlers(env.gladys, env.app, env.app.log);
  t.after(() => env.app.stop());
  const done = env.app.connected();
  await env.wait(4000);
  await done;
  assert.equal(store.saves, 0);
  assert.match(statusText(env), /\/data cannot be read/);
});

test('getConfig failing in connected: retried, spaced, then the integration starts', async (t) => {
  const env = await setup();
  registerHandlers(env.gladys, env.app, env.app.log);
  t.after(() => env.app.stop());
  const real = env.gladys.getConfig.bind(env.gladys);
  let fails = 2;
  env.gladys.getConfig = async () => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('down');
    }
    return real();
  };
  await env.app.connected();
  assert.match(statusText(env), /configuration could not be read/);
  assert.equal(env.pstryk.calls.length, 0);
  await env.wait(5000);
  assert.equal(env.pstryk.calls.length, 0);
  await env.wait(10_000);
  assert.ok(env.pstryk.count('pricing') >= 1);
  assert.match(statusText(env), /^Connected/);
});

test('a reconnection never reads sooner than the interval and publishes nothing stale', async (t) => {
  const env = await withDevice();
  t.after(() => env.app.stop());
  await env.wait(30 * MINUTE);
  const n = env.pstryk.calls.length;
  const states = env.fake.states.length;
  await env.app.connected();
  await env.wait(0);
  assert.equal(env.pstryk.calls.length, n);
  // The price of this hour again (Gladys may hold an older one), nothing else.
  const after = env.fake.states.slice(states);
  for (const s of after) {
    const h = env.clock.now - (env.clock.now % HOUR);
    if (s.device_feature_external_id === F('price')) assert.equal(s.state, P.priceOf(h));
  }
});

test('stop() during a read: the request aborted, nothing published nor sent after it', async (t) => {
  const pstryk = createPstryk({
    pricing: (call) =>
      new Promise((resolve, reject) =>
        call.signal.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))),
      ),
  });
  const env = await setup({ pstryk });
  registerHandlers(env.gladys, env.app, env.app.log);
  t.after(() => env.app.stop());
  await env.start();
  assert.equal(pstryk.count('pricing'), 1);
  const statuses = env.fake.connectionStatuses.length;
  await env.app.stop();
  await env.wait(DAY);
  assert.equal(pstryk.count('pricing'), 1);
  assert.equal(env.fake.connectionStatuses.length, statuses);
  assert.equal(env.pending.size, 0);
});

test('a late answer of an older start (config saved meanwhile) publishes nothing of its own', async (t) => {
  let release;
  let first = true;
  const pstryk = createPstryk({
    pricing: async (call, now) => {
      if (first) {
        first = false;
        await new Promise((r) => (release = r));
        // The old account's prices: never kept once another key was saved.
        return P.pricing({
          from: Date.parse(call.query.window_start),
          to: Date.parse(call.query.window_end),
          now,
          price: (h) => P.priceOf(h) + 5,
        });
      }
      return createPstryk().answers.pricing(call, now);
    },
  });
  const env = await setup({ pstryk });
  registerHandlers(env.gladys, env.app, env.app.log);
  t.after(() => env.app.stop());
  await env.start();
  assert.equal(typeof release, 'function');
  await env.fake.configUpdated({ api_key: 'sk-second-key-0000000000' });
  const discovered = env.fake.discoveredDevices.length;
  release();
  await env.wait(2 * MINUTE);
  // The old answer changed nothing; the new key read its own.
  assert.ok(env.fake.discoveredDevices.length >= discovered);
  const h = env.clock.now - (env.clock.now % HOUR);
  assert.equal(env.app.priceAt(h), P.priceOf(h));
  assert.equal(env.app.priceAt(h - 2 * HOUR), P.priceOf(h - 2 * HOUR));
  assert.match(statusText(env), /^Connected/);
  assert.equal(pstryk.calls.at(-1).auth, 'sk-second-key-0000000000');
});

test('a missing or malformed key: nothing sent, said', async (t) => {
  const env = await started({ config: {} });
  t.after(() => env.app.stop());
  await env.wait(DAY);
  assert.equal(env.pstryk.calls.length, 0);
  assert.match(statusText(env), /Enter the API key/);
  const test1 = await env.fake.action('test_connection');
  assert.match(JSON.stringify(test1), /Enter the API key/);
  await env.fake.configUpdated({ api_key: 'sk-a\nb' });
  await env.wait(HOUR);
  assert.equal(env.pstryk.calls.length, 0);
  assert.match(statusText(env), /not valid/);
});

test('Discovery from a scan never sends a request; the device is offered again after a restart', async (t) => {
  const store = createMemoryStore();
  const env = await started({ store });
  await env.app.stop();
  const pstryk = createPstryk({ pricing: () => 'network' });
  const later = await started({ store, pstryk, now: P.NOW + 10 * MINUTE });
  t.after(() => later.app.stop());
  await later.fake.scanRequest();
  assert.equal(pstryk.calls.length, 0);
  assert.equal(deviceOf(later).external_id, DEVICE);
});

test('tomorrow kept once is read again 3 hours later: a provisional answer replaced in the hours to come', async (t) => {
  const tomorrow = fromLocal(2026, 11, 12);
  // Until 15:00, tomorrow comes as a provisional two-value answer (not flat).
  const provisional = (h) => (local(h).h >= 8 && local(h).h < 22 ? 0.95 : 0.55);
  const pstryk = createPstryk({
    pricing: ({ query }, now) =>
      P.pricing({
        from: Date.parse(query.window_start),
        to: Date.parse(query.window_end),
        now,
        price: (h) =>
          h >= tomorrow && now < fromLocal(2026, 11, 11, 15) ? provisional(h) : P.priceOf(h),
      }),
  });
  const env = await started({ pstryk, now: fromLocal(2026, 11, 11, 14) });
  t.after(() => env.app.stop());
  const eight = fromLocal(2026, 11, 12, 8);
  assert.equal(env.app.priceAt(eight), 0.95);
  const n = pstryk.count('pricing');
  await env.wait(3 * HOUR - MINUTE);
  assert.equal(pstryk.count('pricing'), n);
  await env.wait(2 * MINUTE);
  assert.equal(pstryk.count('pricing'), n + 1);
  for (let h = tomorrow; h < addDays(tomorrow, 1); h += HOUR) {
    assert.equal(env.app.priceAt(h), P.priceOf(h));
  }
  assert.ok(env.lines.some((l) => /changed the price of \d+ hour/.test(l)));
  // Confirmed once: nothing more before the next 14:00.
  await env.wait(20 * HOUR);
  assert.equal(pstryk.count('pricing'), n + 1);
});

test('the confirmation aims before 23:00; an hour already started is never repriced by it', async (t) => {
  let second = false;
  const pstryk = createPstryk({
    pricing: ({ query }, now) =>
      P.pricing({
        from: Date.parse(query.window_start),
        to: Date.parse(query.window_end),
        now,
        price: (h) => (second ? P.priceOf(h) + 1 : P.priceOf(h)),
      }),
  });
  const env = await started({ pstryk, now: fromLocal(2026, 11, 11, 21) });
  t.after(() => env.app.stop());
  assert.equal(env.store.data.confirm.due, fromLocal(2026, 11, 11, 23));
  second = true;
  await env.wait(2 * HOUR + MINUTE);
  // Read just before 23:00: the hour 22:00 (started) kept, the hours to come replaced.
  const read = pstryk.calls.at(-1).at;
  assert.ok(read < fromLocal(2026, 11, 11, 23) && read > fromLocal(2026, 11, 11, 22, 59));
  const h = fromLocal(2026, 11, 11, 22);
  assert.equal(env.app.priceAt(h), P.priceOf(h));
  assert.equal(env.app.priceAt(h + HOUR), P.priceOf(h + HOUR) + 1);
});

for (const [name, answer, gaps] of [
  ['5xx', () => json({}, 503), [5, 10, 20, 40, 80, 160, 320, 360]],
  ['429 without Retry-After', () => json({}, 429), [15, 30, 60, 120, 240, 360, 360]],
]) {
  test(`${name} for a day (today's prices held): the pause doubles up to 6 hours`, async (t) => {
    const pstryk = createPstryk();
    const env = await started({ pstryk });
    t.after(() => env.app.stop());
    pstryk.answers.pricing = answer;
    const first = pstryk.calls.length;
    await env.wait(DAY);
    const at = pstryk.calls.slice(first).map((c) => c.at);
    const seen = at.slice(1).map((x, i) => Math.round((x - at[i]) / MINUTE));
    assert.deepEqual(seen.slice(0, gaps.length), gaps);
  });
}

test('a 429 while reading the past days: no other window sent, the pause set', async (t) => {
  const yesterday = fromLocal(2026, 11, 10);
  const pstryk = createPstryk({
    pricing: (call, now) =>
      Date.parse(call.query.window_end) <= yesterday
        ? json({}, 429, { 'retry-after': '600' })
        : createPstryk().answers.pricing(call, now),
  });
  const env = await started({ pstryk });
  t.after(() => env.app.stop());
  assert.equal(pstryk.count('pricing'), 2);
  assert.equal(env.store.data.pause.code, 'rate_limited');
  assert.match(statusText(env), /slow down/);
  const test1 = await env.fake.action('test_connection');
  assert.match(JSON.stringify(test1), /asked to wait until 11:15/);
});

test('a refusal kept in /data, a restart with another key: that key is tried', async (t) => {
  const store = createMemoryStore();
  const pstryk = createPstryk({ pricing: () => json(P.REFUSED_BODY, 403) });
  const env = await started({ store, pstryk });
  await env.app.stop();
  assert.ok(store.data.refused);
  Object.assign(pstryk.answers, createPstryk().answers);
  const later = await started({
    store,
    pstryk,
    now: P.NOW + MINUTE,
    config: { api_key: 'sk-restart-other-key-0001' },
  });
  t.after(() => later.app.stop());
  await later.wait(10 * MINUTE);
  assert.ok(pstryk.count('pricing') >= 2);
  assert.equal(pstryk.calls.at(-1).auth, 'sk-restart-other-key-0001');
  assert.match(statusText(later), /^Connected/);
});

test('a 5xx pause: the Test button says Pstryk is unavailable, not that it asked to wait', async (t) => {
  const env = await started({ pstryk: createPstryk({ pricing: () => json({}, 500) }) });
  t.after(() => env.app.stop());
  const answer = await env.fake.action('test_connection');
  assert.match(JSON.stringify(answer), /Pstryk is unavailable, no request until 11:05/);
});

test('nothing consumed costs 0 even without a price; a negative consumption is refused', async (t) => {
  const env = await started();
  t.after(() => env.app.stop());
  const old = fromLocal(2026, 9, 1);
  const zero = await priceRequest(env, [old], 0);
  assert.equal(zero.success, true, JSON.stringify(zero));
  assert.equal(zero.data.costs[0].cost, 0);
  const t0 = fromLocal(2026, 11, 11, 9);
  assert.equal((await priceRequest(env, [t0], -1)).success, false);
  assert.equal((await priceRequest(env, [old], 1)).success, false);
});

test('the current price: the next hour unknown gives its start and no next price', async (t) => {
  const pstryk = createPstryk(until(() => fromLocal(2026, 11, 12)));
  const env = await started({ pstryk, now: fromLocal(2026, 11, 11, 23, 10) });
  t.after(() => env.app.stop());
  const current = await env.fake.energyCurrent({ contract: contract(), cumulative: {} });
  assert.equal(current.data.price, P.priceOf(fromLocal(2026, 11, 11, 23)));
  assert.equal(Date.parse(current.data.valid_until), fromLocal(2026, 11, 12));
  assert.equal(current.data.next_price, null);
});

test('no consumption read without the device created', async (t) => {
  const env = await started();
  t.after(() => env.app.stop());
  await env.wait(DAY);
  assert.equal(env.pstryk.count('meter_values'), 0);
});

test('/data unreadable from the start: the first read after 5 minutes, not an hour', async (t) => {
  const store = createMemoryStore();
  store.unreadable = true;
  const env = await started({ store });
  t.after(() => env.app.stop());
  assert.equal(env.pstryk.count('pricing'), 0);
  await env.wait(4 * MINUTE);
  assert.equal(env.pstryk.count('pricing'), 0);
  await env.wait(2 * MINUTE);
  assert.ok(env.pstryk.count('pricing') >= 1);
  assert.equal(env.pstryk.calls[0].at - P.NOW, 5 * MINUTE);
  assert.equal(store.saves, 0);
});

test('/data read late after another key: the old prices are not taken back', async (t) => {
  const old = {};
  const h = fromLocal(2026, 11, 11, 9);
  old[h / HOUR] = 9.99;
  const store = createMemoryStore({ prices: old, refused: null, version: 1 });
  store.unreadable = true;
  const env = await started({ store });
  t.after(() => env.app.stop());
  await env.fake.configUpdated({ api_key: 'sk-other-account-key-111' });
  store.unreadable = false;
  await env.wait(11 * 1000);
  assert.ok(store.saves >= 1);
  assert.notEqual(env.app.priceAt(h), 9.99);
});

test('prices of /data beyond the bound or out of the window are not taken', async () => {
  const { validHours } = await import('../src/app.js');
  const h = Math.floor(P.NOW / HOUR);
  const kept = validHours(
    { [h]: 0.5, [h + 1]: 51, [h + 2]: -51, [h - 41 * 24]: 0.5, x: 1 },
    P.NOW,
    40 * DAY,
  );
  assert.deepEqual(kept, { [h]: 0.5 });
});

test('an outage lasting past midnight: today read again within the hour, not after a 6-hour pause', async (t) => {
  let down = false;
  const ok = createPstryk(until(() => (down ? fromLocal(2026, 11, 12) : fromLocal(2026, 11, 12))));
  const pstryk = createPstryk({
    pricing: (call, now) => (down ? json({}, 503) : ok.answers.pricing(call, now)),
  });
  const env = await started({ pstryk });
  t.after(() => env.app.stop());
  down = true;
  // 14:00 to 03:00: Pstryk down, tomorrow never read.
  await env.wait(fromLocal(2026, 11, 12, 3) - env.clock.now);
  assert.equal(env.app.priceAt(env.clock.now), undefined);
  assert.ok(env.store.data.pause.until - env.clock.now <= HOUR);
  down = false;
  ok.answers.pricing = createPstryk().answers.pricing;
  await env.wait(HOUR + MINUTE);
  assert.equal(env.app.priceAt(env.clock.now), P.priceOf(env.clock.now - (env.clock.now % HOUR)));
});
