// -----------------------------------------------------------------------------
// Constants of the Pstryk integration: the endpoint, the pace, the bounds and
// the manifest keys (forever: stored in user configs and contracts).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** The official Pstryk integration API (api.pstryk.pl/integrations/swagger/). */
export const API_URL = 'https://api.pstryk.pl';
export const METRICS_PATH = '/integrations/meter-data/unified-metrics/';
// The version follows the release (package.json is in the image).
const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
export const USER_AGENT = `gladys-pstryk/${VERSION} (+https://github.com/LM1LC3N7/gladys-pstryk)`;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const HALF_HOUR = 30 * MINUTE;

export const TIME_ZONE = 'Europe/Warsaw';
export const CURRENCY = 'PLN';

// --- Requests -----------------------------------------------------------------

/** One request never takes longer (headers and body). */
export const REQUEST_TIMEOUT = 20 * SECOND;
/** A larger answer is cut before it is read whole (16 days of hours: ~200 kB). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Two requests of the integration are always this far apart (one in flight at a time). */
export const REQUEST_GAP = 2 * SECOND;

// --- Pace -----------------------------------------------------------------------

/** The recent prices (yesterday to tomorrow): at most once an hour while some are missing. */
export const PRICES_INTERVAL = HOUR;
/** Tomorrow's prices are looked for from 14:00, Polish time (the day-ahead market is out by then). */
export const PRICES_HOUR = 14;
/**
 * Tomorrow's prices, once first kept, are read once more to confirm them
 * (a provisional answer is replaced in the hours not started yet): 3 hours
 * later, aiming before 23:00 Polish time, never sooner than an hour.
 */
export const CONFIRM_DELAY = 3 * HOUR;
export const CONFIRM_MIN = HOUR;
export const CONFIRM_BEFORE_HOUR = 23;
/**
 * Past hours without a price (an outage, a 429, a stop of Gladys) are read
 * again, as far back as the core may ask (31 days), at most every 6 hours, by
 * windows of 16 days (384 hours).
 */
export const PRICE_BACKFILL_DAYS = 31;
export const PRICE_WINDOW_DAYS = 16;
export const HOLES_INTERVAL = 6 * HOUR;
/** The consumption of the created device: every 3 hours, the last 3 days. */
export const CONSUMPTION_INTERVAL = 3 * HOUR;
export const CONSUMPTION_DAYS = 3;
/** Once a day (the first read after 06:00 in Poland) and for a new device: 7 days. */
export const BACKFILL_DAYS = 7;
export const BACKFILL_HOUR = 6;
/** After a failed read: again after 5, 10, 20, 40 then every 60 minutes. */
export const RETRY_MIN = 5 * MINUTE;
export const RETRY_MAX = HOUR;
/** A 429 without Retry-After: 15 minutes, doubled up to 6 hours. */
export const RATE_LIMIT_PAUSE = 15 * MINUTE;
/** A 5xx: 5 minutes, doubled up to 6 hours. */
export const SERVER_PAUSE = 5 * MINUTE;
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** The test button answers at most once a minute with a new request. */
export const TEST_MIN_GAP = MINUTE;
/** /data unreadable: the last reads are unknown; a read waits this long (or its interval when shorter). */
export const UNREADABLE_WAIT = 5 * MINUTE;
/** A new device or a new key are read soon, never sooner than this after a read. */
export const CREATED_MIN_GAP = MINUTE;
/** The config is read again after a failure: 5 s doubled up to 5 minutes, for ever. */
export const CONFIG_RETRY_MIN = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;
/** /data: waited at most STORE_WAIT; an unreadable one is read again every STORE_RETRY. */
export const STORE_WAIT = 3 * SECOND;
export const STORE_RETRY = 10 * SECOND;
/** The price features are published again at every hour (no request). */
export const TICK = HOUR;

// --- Bounds -----------------------------------------------------------------------

/** Prices kept in /data to price the past intervals: 40 days of hours. */
export const PRICE_HISTORY_DAYS = 40;
/** At most this many frames of one answer are read (16 days of hours: 384). */
export const MAX_FRAMES = 2000;
/** A gross price beyond ± this (PLN/kWh) is not a price. */
export const MAX_PRICE = 50;
/** An hour beyond this (kWh) is not a household reading. */
export const MAX_HOUR_KWH = 250;
/**
 * A day whose hours share one price for more than this share of them is a
 * placeholder (prices not published yet), never kept.
 */
export const FLAT_DAY_SHARE = 0.9;
export const MAX_STATUS = 400;

// --- Manifest keys (forever) -------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection' };
export const TEMPLATES = { DYNAMIC: 'pstryk-dynamic' };
