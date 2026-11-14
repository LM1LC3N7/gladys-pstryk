// -----------------------------------------------------------------------------
// Reading the Pstryk answers: prices (whole Polish days only, the changes of
// time, placeholders), consumption. A value that does not read is unknown,
// never 0.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberOf, parseConsumption, parsePricing } from '../src/pstryk/model.js';
import { addDays, fromLocal, startOfDay } from '../src/time.js';
import * as P from './fixtures/pstryk.js';

const { HOUR } = P;
const DAY0 = fromLocal(2026, 11, 11); // 2026-11-10T23:00Z

test('numbers: finite numbers and plain decimal texts only; null, empty, NaN unknown', () => {
  assert.equal(numberOf(0.85), 0.85);
  assert.equal(numberOf('0.85'), 0.85);
  assert.equal(numberOf('-0.12'), -0.12);
  assert.equal(numberOf(0), 0);
  for (const v of [null, undefined, '', ' ', '0,85', '1e3', NaN, Infinity, '0x10', true, {}, []]) {
    assert.equal(numberOf(v), undefined, String(v));
  }
});

test('prices: whole Polish days kept, hour by hour, buy and sale', () => {
  const parsed = parsePricing(P.pricing({ from: DAY0, to: addDays(DAY0, 2) }));
  assert.equal(parsed.buy.size, 48);
  assert.deepEqual([...parsed.days], ['2026-11-11', '2026-11-12']);
  assert.equal(parsed.buy.get(DAY0 + 10 * HOUR), P.priceOf(DAY0 + 10 * HOUR));
  assert.equal(parsed.sell.get(DAY0 + 10 * HOUR), P.sellOf(DAY0 + 10 * HOUR));
  // Decimal texts read like numbers.
  const text = parsePricing(
    P.pricing({ from: DAY0, to: addDays(DAY0, 1), price: (h) => String(P.priceOf(h)) }),
  );
  assert.equal(text.buy.get(DAY0), P.priceOf(DAY0));
});

test('prices: a day with one hour unknown is left out whole (never part of a day, never 0)', () => {
  const missing = DAY0 + 30 * HOUR; // in the second day
  for (const bad of [undefined, null, '', 'n/a', NaN]) {
    const parsed = parsePricing(
      P.pricing({
        from: DAY0,
        to: addDays(DAY0, 2),
        price: (h) => (h === missing ? bad : P.priceOf(h)),
      }),
    );
    assert.equal(parsed.buy.size, 24, String(bad));
    assert.deepEqual([...parsed.partial], ['2026-11-12']);
    assert.ok(![...parsed.buy.values()].includes(0));
  }
  // A window that starts in the middle of a day: that day is not whole.
  const cut = parsePricing(P.pricing({ from: DAY0 + 5 * HOUR, to: addDays(DAY0, 2) }));
  assert.deepEqual([...cut.days], ['2026-11-12']);
});

test('prices: a flat day (one value repeated, prices not published yet) is never kept', () => {
  const tomorrow = addDays(DAY0, 1);
  const parsed = parsePricing(
    P.pricing({
      from: DAY0,
      to: addDays(DAY0, 2),
      price: (h) => (h >= tomorrow ? 0.9 : P.priceOf(h)),
    }),
  );
  assert.deepEqual([...parsed.days], ['2026-11-11']);
  assert.equal(parsed.buy.has(tomorrow), false);
  // 22 equal hours of 24 (92 %): a placeholder, left out.
  const most = parsePricing(
    P.pricing({
      from: DAY0,
      to: addDays(DAY0, 1),
      price: (h) => (h < DAY0 + 2 * HOUR ? P.priceOf(h) + 1 : 0.9),
    }),
  );
  assert.equal(most.buy.size, 0);
  // 13 equal hours of 24: kept.
  const half = parsePricing(
    P.pricing({
      from: DAY0,
      to: addDays(DAY0, 1),
      price: (h) => (h < DAY0 + 11 * HOUR ? P.priceOf(h) + 1 : 0.9),
    }),
  );
  assert.equal(half.buy.size, 24);
  // 21 equal hours of 24 (87 %): a real day, kept.
  const mostly = parsePricing(
    P.pricing({
      from: DAY0,
      to: addDays(DAY0, 1),
      price: (h) => (h < DAY0 + 3 * HOUR ? P.priceOf(h) + 1 : 0.9),
    }),
  );
  assert.equal(mostly.buy.size, 24);
});

test('prices: the autumn change of time has 25 hours, the spring one 23', () => {
  const autumn = fromLocal(2026, 10, 25);
  const a = parsePricing(P.pricing({ from: autumn, to: addDays(autumn, 1) }));
  assert.equal(addDays(autumn, 1) - autumn, 25 * HOUR);
  assert.equal(a.buy.size, 25);
  assert.deepEqual([...a.days], ['2026-10-25']);
  const spring = fromLocal(2026, 3, 29);
  const s = parsePricing(P.pricing({ from: spring, to: addDays(spring, 1) }));
  assert.equal(s.buy.size, 23);
  // 24 hours from the spring midnight overlap the next day: it is not whole.
  const over = parsePricing(P.pricing({ from: spring, to: spring + 24 * HOUR }));
  assert.deepEqual([...over.days], ['2026-03-29']);
  assert.deepEqual([...over.partial], ['2026-03-30']);
  assert.equal(startOfDay(spring + 23 * HOUR), spring + 23 * HOUR);
});

test('prices: two prices for one hour: neither (its day left out); bounds; not an hour', () => {
  const body = P.pricing({ from: DAY0, to: addDays(DAY0, 1) });
  body.frames.push({ ...body.frames[3], metrics: { pricing: { price_gross: 9 } } });
  assert.equal(parsePricing(body).buy.size, 0);
  const huge = parsePricing(
    P.pricing({ from: DAY0, to: addDays(DAY0, 1), price: (h) => (h === DAY0 ? 51 : P.priceOf(h)) }),
  );
  assert.equal(huge.buy.size, 0);
  const odd = P.pricing({ from: DAY0, to: addDays(DAY0, 1) });
  odd.frames[0].end = odd.frames[0].start; // not an hour
  assert.equal(parsePricing(odd).buy.size, 0);
  assert.equal(parsePricing({}), undefined);
  assert.equal(parsePricing({ frames: {} }), undefined);
  assert.equal(parsePricing({ frames: new Array(2001).fill({}) }), undefined);
  assert.equal(parsePricing({ frames: [null, 3, 'x'] }).buy.size, 0);
});

test('prices: a negative price is a price (kept as such)', () => {
  const parsed = parsePricing(
    P.pricing({ from: DAY0, to: addDays(DAY0, 1), price: (h) => P.priceOf(h) - 0.6 }),
  );
  assert.equal(parsed.buy.get(DAY0), Math.round((P.priceOf(DAY0) - 0.6) * 1e6) / 1e6);
});

test('consumption: ended hours only, never the live one, split in two halves; bad values out', () => {
  const now = DAY0 + 5 * HOUR + 20 * 60_000;
  const out = parseConsumption(
    P.meterValues({
      from: DAY0,
      to: DAY0 + 6 * HOUR,
      now,
      kwh: (h) => (h === DAY0 + HOUR ? null : 0.5),
    }),
    now,
  );
  // Hours 0, 2, 3, 4 (hour 1 unknown, hour 5 still running).
  assert.equal(out.length, 8);
  assert.deepEqual(out[0], { starts_at: '2026-11-10T23:00:00.000Z', kwh: 0.25 });
  assert.deepEqual(out[1], { starts_at: '2026-11-10T23:30:00.000Z', kwh: 0.25 });
  assert.equal(out[2].starts_at, '2026-11-11T01:00:00.000Z');
  // A frame not ended is never taken, even without its live flag.
  const ahead = P.meterValues({ from: DAY0, to: DAY0 + 8 * HOUR, now });
  for (const f of ahead.frames) delete f.is_live;
  assert.equal(parseConsumption(ahead, now).length, 10);
  // A frame said live is never taken, even when its hour looks ended.
  const live = P.meterValues({ from: DAY0, to: DAY0 + HOUR, now });
  live.frames[0].is_live = true;
  assert.deepEqual(parseConsumption(live, now), []);
  // The example of the spec names them meterValues: read too.
  const camel = P.meterValues({ from: DAY0, to: DAY0 + HOUR, now });
  camel.frames[0].metrics = { meterValues: camel.frames[0].metrics.meter_values };
  assert.equal(parseConsumption(camel, now).length, 2);
  for (const bad of [-1, 251, '', 'x', NaN, undefined]) {
    const body = P.meterValues({ from: DAY0, to: DAY0 + HOUR, now, kwh: () => bad });
    assert.deepEqual(parseConsumption(body, now), [], String(bad));
  }
  assert.equal(parseConsumption({}, now), undefined);
});

test('an instant without its zone is never read (never the container time zone)', async () => {
  const { parseInstant } = await import('../src/time.js');
  assert.equal(parseInstant('2026-11-11T10:00:00'), undefined);
  assert.equal(parseInstant('2026-11-11T10:00:00Z'), Date.parse('2026-11-11T10:00:00Z'));
  assert.equal(parseInstant('2026-11-11T11:00:00+01:00'), Date.parse('2026-11-11T10:00:00Z'));
  const body = {
    frames: [{ start: '2026-11-11T10:00:00', end: '2026-11-11T11:00:00', metrics: {} }],
  };
  assert.deepEqual(parseConsumption(body, Date.parse('2026-11-12T00:00:00Z')), []);
});

test('a pause read back from /data is capped to 6 hours', async () => {
  const { validPause } = await import('../src/app.js');
  const now = P.NOW;
  const pause = validPause({ until: now + 30 * 24 * HOUR, count: 1, code: 'server' }, now, 0);
  assert.equal(pause.until - now, 6 * HOUR);
  assert.equal(pause.due, 6 * HOUR);
  assert.equal(validPause({ until: now, count: 1, code: 'other' }, now, 0), undefined);
});
