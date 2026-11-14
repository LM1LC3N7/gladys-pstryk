// -----------------------------------------------------------------------------
// Answers of the Pstryk unified metrics endpoint, shaped like its OpenAPI
// description (api.pstryk.pl/integrations/schema/, 2026-11-14) and the frames
// read by ha_Pstryk. Made-up numbers: no real customer.
// -----------------------------------------------------------------------------

export const NOW = Date.parse('2026-11-11T10:00:00.000Z'); // 11:00 in Poland
export const API_KEY = 'sk-Gl4dysT3stK3y-0123456789abcdef';
export const HOUR = 60 * 60 * 1000;

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** The gross price PLN/kWh of the hour starting at `h`: 0.5 + the UTC hour / 100. */
export const priceOf = (h) => Math.round((0.5 + new Date(h).getUTCHours() / 100) * 1e6) / 1e6;
/** The prosumer sale price of the hour. */
export const sellOf = (h) => Math.round((0.3 + new Date(h).getUTCHours() / 200) * 1e6) / 1e6;

/** `metrics=pricing` frames from `from` to `to`; `price(h)` undefined leaves the hour unpriced. */
export function pricing({ from, to, price = priceOf, sell = sellOf, now = NOW }) {
  const frames = [];
  for (let h = from; h < to; h += HOUR) {
    const p = price(h);
    frames.push({
      start: iso(h),
      end: iso(h + HOUR),
      ...(h <= now && now < h + HOUR ? { is_live: true } : {}),
      metrics: {
        pricing: {
          price_net: p === undefined || p === null ? null : Math.round((p / 1.23) * 1e4) / 1e4,
          price_gross: p === undefined ? null : p,
          price_prosumer_gross: sell(h),
          is_cheap: false,
          is_expensive: false,
        },
      },
    });
  }
  return { frames, summary: { pricing: {} } };
}

export const KWH = 0.48;

/** `metrics=meter_values` frames from `from` to `to`, the hour holding `now` live. */
export function meterValues({ from, to, kwh = () => KWH, now = NOW }) {
  const frames = [];
  for (let h = from; h < to; h += HOUR) {
    const live = h <= now && now < h + HOUR;
    frames.push({
      start: iso(h),
      end: iso(h + HOUR),
      ...(live ? { is_live: true } : {}),
      metrics: {
        meter_values: {
          energy_active_import_register: kwh(h),
          energy_active_export_register: 0.1,
          energy_balance: kwh(h) - 0.1,
        },
      },
    });
  }
  return { frames, summary: { meter_values: {} } };
}

/** The answer of a wrong key (Django REST framework, Accept-Language: en). */
export const REFUSED_BODY = { detail: 'Incorrect authentication credentials.' };
