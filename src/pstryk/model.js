// -----------------------------------------------------------------------------
// Reading the answers of the Pstryk unified metrics endpoint (pure functions).
// Every value is checked: a frame that does not read is left out (unknown),
// never taken as 0.
//
// A frame: { start, end, is_live?, metrics: { pricing: { price_gross,
// price_prosumer_gross, ... }, meter_values: { energy_active_import_register,
// ... } } }, instants in UTC, one hour each (resolution=hour).
// -----------------------------------------------------------------------------

import {
  FLAT_DAY_SHARE,
  HALF_HOUR,
  HOUR,
  MAX_FRAMES,
  MAX_HOUR_KWH,
  MAX_PRICE,
} from '../constants.js';
import { addDays, localDate, parseInstant, startOfDay } from '../time.js';

/** A strict number: a finite number, or a plain decimal text ("0.85"); undefined otherwise. */
export function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d{1,6}(\.\d{1,10})?$/.test(value)) return Number(value);
  return undefined;
}

/** The hourly frames of an answer `[{ at, frame }]`, or undefined when it is not a list. */
function hourFrames(body) {
  if (!Array.isArray(body?.frames) || body.frames.length > MAX_FRAMES) return undefined;
  const out = [];
  for (const frame of body.frames) {
    if (!frame || typeof frame !== 'object') continue;
    const at = parseInstant(frame.start);
    const end = parseInstant(frame.end);
    // An hour, on a whole hour: anything else is not the resolution asked.
    if (at === undefined || end !== at + HOUR || at % HOUR !== 0) continue;
    const metrics = frame.metrics && typeof frame.metrics === 'object' ? frame.metrics : {};
    out.push({ at, frame, metrics });
  }
  return out;
}

/** Values by hour; two different values for one hour: neither is kept. */
function byHour(entries) {
  const values = new Map();
  const conflicts = new Set();
  for (const [at, value] of entries) {
    if (values.has(at) && values.get(at) !== value) conflicts.add(at);
    values.set(at, value);
  }
  for (const at of conflicts) values.delete(at);
  return values;
}

/** Whether more than FLAT_DAY_SHARE of the prices of a day are one value (a placeholder). */
function flat(prices) {
  const counts = new Map();
  for (const p of prices) counts.set(p, (counts.get(p) ?? 0) + 1);
  return Math.max(...counts.values()) > FLAT_DAY_SHARE * prices.length;
}

/**
 * The prices of `metrics=pricing`: `{ buy: Map(hour start ms -> PLN/kWh
 * gross), sell: Map(...), days: Set(local dates kept), partial: Set(local
 * dates left out) }`, or undefined when the answer does not read. A Polish
 * day is kept only whole (each of its 23, 24 or 25 hours priced) and not flat
 * (prices not published yet come as one repeated value): never a guessed
 * price, never part of a day.
 */
export function parsePricing(body) {
  const frames = hourFrames(body);
  if (!frames) return undefined;
  const buyIn = [];
  const sellIn = [];
  for (const { at, metrics } of frames) {
    const pricing = metrics.pricing && typeof metrics.pricing === 'object' ? metrics.pricing : {};
    const buy = numberOf(pricing.price_gross);
    if (buy !== undefined && Math.abs(buy) <= MAX_PRICE) buyIn.push([at, round(buy)]);
    const sell = numberOf(pricing.price_prosumer_gross);
    if (sell !== undefined && Math.abs(sell) <= MAX_PRICE) sellIn.push([at, round(sell)]);
  }
  const buyAll = byHour(buyIn);
  const sellAll = byHour(sellIn);
  const dates = new Map();
  for (const at of buyAll.keys()) {
    const day = startOfDay(at);
    if (!dates.has(day)) dates.set(day, []);
  }
  const buy = new Map();
  const sell = new Map();
  const days = new Set();
  const partial = new Set();
  for (const day of [...dates.keys()].sort((a, b) => a - b)) {
    const end = addDays(day, 1);
    const prices = [];
    let whole = true;
    for (let h = day; h < end; h += HOUR) {
      if (!buyAll.has(h)) {
        whole = false;
        break;
      }
      prices.push(buyAll.get(h));
    }
    if (!whole || flat(prices)) {
      partial.add(localDate(day));
      continue;
    }
    days.add(localDate(day));
    for (let h = day; h < end; h += HOUR) {
      buy.set(h, buyAll.get(h));
      if (sellAll.has(h)) sell.set(h, sellAll.get(h));
    }
  }
  return { buy, sell, days, partial };
}

/** The meter values of a frame (the spec names them `meter_values`, its example `meterValues`). */
const meterValuesOf = (metrics) => {
  const v = metrics.meter_values ?? metrics.meterValues;
  return v && typeof v === 'object' ? v : {};
};

/**
 * The consumption of `metrics=meter_values`: the half hours `[{ starts_at,
 * kwh }]` of the hours ended by `now`, each hour split in two equal halves;
 * or undefined when the answer does not read. An hour without a readable
 * value, or still running (`is_live`), is left out (never 0).
 */
export function parseConsumption(body, now) {
  const frames = hourFrames(body);
  if (!frames) return undefined;
  const entries = [];
  for (const { at, frame, metrics } of frames) {
    if (frame.is_live === true || at + HOUR > now) continue;
    const kwh = numberOf(meterValuesOf(metrics).energy_active_import_register);
    if (kwh === undefined || kwh < 0 || kwh > MAX_HOUR_KWH) continue;
    entries.push([at, kwh]);
  }
  const hours = byHour(entries);
  const out = [];
  for (const at of [...hours.keys()].sort((a, b) => a - b)) {
    const half = Math.round((hours.get(at) / 2) * 1e6) / 1e6;
    out.push({ starts_at: new Date(at).toISOString(), kwh: half });
    out.push({ starts_at: new Date(at + HALF_HOUR).toISOString(), kwh: half });
  }
  return out;
}

/** To a millionth of a złoty: the same price always reads the same. */
const round = (v) => Math.round(v * 1e6) / 1e6;
