// -----------------------------------------------------------------------------
// The integration itself: the Pstryk customer's own data read through the
// official Pstryk integration API (an API key created by the customer in the
// Pstryk app), one Gladys device for the account, the hourly prices kept to
// price the delegated energy contract and shown as features, the hourly
// consumption of the meter published after the fact
// (publishEnergyConsumption), the pauses and the refused key kept in /data,
// the test button. index.js only wires the SDK handlers to it. Read-only:
// nothing is ever changed on the account.
//
// Pace (each attempt kept in /data before the request, so a restart never
// reads sooner): the recent prices (yesterday to tomorrow) when the ones held
// do not reach the end of today (or of tomorrow from 14:00 in Poland), at
// most once an hour, else nothing until the next 14:00; the past hours
// without a price (31 days back) at most every 6 hours; the consumption of the
// CREATED device every 3 hours (3 days; 7 days once a day after 06:00 and for
// a new device). A failed read of the prices is tried again after 5, 10, 20,
// 40 then every 60 minutes; a 429 or a 5xx pauses every request (persisted, at
// most 6 hours). The price features are published again at every hour from
// what is held: no request.
//
// Two clocks: `now` (wall clock) dates the prices, the consumption and what
// /data keeps; `monotonic` paces the reads and the pauses, so that a wall
// clock set back or forward never stops nor hurries them.
//
// A start (config saved, reconnection) opens a new generation: a late answer
// of an older one publishes nothing and sets no status (checked after every
// await).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { normalizeConfig } from './config.js';
import {
  BACKFILL_DAYS,
  BACKFILL_HOUR,
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  CONFIRM_BEFORE_HOUR,
  CONFIRM_DELAY,
  CONFIRM_MIN,
  CONSUMPTION_DAYS,
  CONSUMPTION_INTERVAL,
  CREATED_MIN_GAP,
  DAY,
  HALF_HOUR,
  HOLES_INTERVAL,
  HOUR,
  MAX_PRICE,
  MAX_STATUS,
  PAUSE_MAX,
  PAUSE_MIN,
  PRICE_BACKFILL_DAYS,
  PRICE_HISTORY_DAYS,
  PRICE_WINDOW_DAYS,
  PRICES_HOUR,
  PRICES_INTERVAL,
  RATE_LIMIT_PAUSE,
  RETRY_MAX,
  RETRY_MIN,
  SERVER_PAUSE,
  STORE_RETRY,
  STORE_WAIT,
  TEST_MIN_GAP,
  TICK,
  UNREADABLE_WAIT,
} from './constants.js';
import { FEATURE, buildDevice, idsOf, priceStates } from './devices.js';
import { both, t } from './i18n.js';
import { PstrykError, PstrykSession } from './pstryk/client.js';
import { parseConsumption, parsePricing } from './pstryk/model.js';
import { FileStore } from './store.js';
import { addDays, clock, fromLocal, local, localDate, stamp, startOfDay } from './time.js';

const TIMED_OUT = Symbol('timed out');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** Errors that pause every request. */
const PAUSING = new Set(['rate_limited', 'server']);
/** Errors that stop a round at once (the next kind of read would meet them too). */
const STOPPING = new Set(['rate_limited', 'server', 'refused', 'stopped']);

/** 8 bits of a salted hash of the key: nothing to find it back from. */
export const tagOf = (salt, apiKey) =>
  createHash('sha256').update(`${salt}\u0000${apiKey}`, 'utf8').digest()[0];

/** A pause read back from /data, its rest capped to PAUSE_MAX; undefined when invalid. */
export function validPause(pause, now, mono) {
  if (
    !pause ||
    !finite(pause.until) ||
    !Number.isInteger(pause.count) ||
    pause.count < 1 ||
    !PAUSING.has(pause.code)
  ) {
    return undefined;
  }
  const left = Math.min(Math.max(0, pause.until - now), PAUSE_MAX);
  return {
    until: now + left,
    due: mono + left,
    count: Math.min(pause.count, 16),
    code: pause.code,
    detail: typeof pause.detail === 'string' ? pause.detail.slice(0, 24) : null,
  };
}

export function validRefused(refused) {
  return refused &&
    typeof refused.salt === 'string' &&
    /^[0-9a-f]{32}$/.test(refused.salt) &&
    Number.isInteger(refused.tag) &&
    refused.tag >= 0 &&
    refused.tag < 256
    ? {
        salt: refused.salt,
        tag: refused.tag,
        status: refused.status === 401 || refused.status === 403 ? refused.status : 403,
      }
    : undefined;
}

/** Prices kept: { hourIndex: PLN/kWh }, hours from `back` before to 3 days after `now`. */
export function validHours(hours, now, back) {
  const out = {};
  if (!hours || typeof hours !== 'object' || Array.isArray(hours)) return out;
  const oldest = Math.floor((now - back) / HOUR);
  const newest = Math.floor((now + 3 * DAY) / HOUR);
  for (const [index, price] of Object.entries(hours).slice(0, 1500)) {
    const i = Number(index);
    if (
      Number.isInteger(i) &&
      i >= oldest &&
      i <= newest &&
      finite(price) &&
      Math.abs(price) <= MAX_PRICE
    ) {
      out[i] = price;
    }
  }
  return out;
}

const bound = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const codeOf = (err) =>
  err instanceof PstrykError
    ? err.status && err.code !== 'rate_limited' && err.code !== 'server'
      ? `${err.code} ${err.status}`
      : err.code
    : 'bad_response';

export class PstrykApp {
  constructor({
    gladys,
    logger = console,
    now = () => Date.now(),
    monotonic = () => performance.now(),
    timers = { setTimeout, clearTimeout },
    store = new FileStore(),
    fetchImpl = (...args) => globalThis.fetch(...args),
    random = (n) => randomBytes(n),
    requestGap,
    requestTimeout,
    api,
  }) {
    this.gladys = gladys;
    this.log = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.random = random;
    this.requestGap = requestGap;
    this.requestTimeout = requestTimeout;
    this.api = api;
    this.ids = idsOf(gladys);

    this.gen = 0;
    this.stopped = false;
    this.stopEpoch = 0;
    this.config = normalizeConfig({});
    this.session = undefined;
    this.credKey = undefined;
    /** Another key entered in this process: what /data still holds of the old one is not taken. */
    this.keyChanged = false;

    /** What /data keeps. */
    this.data = {
      lastPrices: null,
      lastPricesOk: null,
      lastHoles: null,
      lastConsumption: null,
      lastFull: null,
      failures: 0,
      pause: null,
      refused: null,
      seen: false,
      backfilled: false,
      prices: {},
      sell: {},
      /** Tomorrow's prices kept once, to read again: { day, due } (wall clock, /data). */
      confirm: null,
      /** The last day whose prices were confirmed by a second read. */
      confirmed: null,
    };
    /** The monotonic time of the pending confirmation (this process). */
    this.confirmMono = undefined;
    this.storeState = 'pending';
    this.loading = null;
    this.storeTimer = null;
    this.pause = undefined;
    this.refused = undefined;

    this.created = new Set();
    this.pendingBackfill = false;

    this.lastPricesMono = undefined;
    this.lastHolesMono = undefined;
    this.lastConsumptionMono = undefined;
    this.pastMissing = false;
    this.failures = 0;
    this.lastError = undefined;
    this.consumptionError = undefined;

    this.roundTimer = null;
    this.tickTimer = null;
    this.configTimer = null;
    this.configDelay = 0;
    this.running = Promise.resolve();
    this.sleeps = new Set();
    this.lastStatus = undefined;
    this.lastTest = undefined;
    this.dueMono = undefined;
    this.lastDiscovery = undefined;
    this.freshConfig = false;
    /** The monotonic time of the first start (the reference while /data cannot be read). */
    this.bootMono = undefined;
  }

  gone(gen) {
    return this.stopped || gen !== this.gen;
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Every (re)connection to Gladys: read the config (retried for ever), then start. */
  async connected() {
    const epoch = this.stopEpoch;
    this.stopped = false;
    this.lastStatus = undefined;
    // What Gladys holds may be older than this process knows: published again.
    this.gladys.forgetPublishedStates?.();
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = null;
    }
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      if (this.stopped || epoch !== this.stopEpoch) return;
      this.configDelay = Math.min(
        CONFIG_RETRY_MAX,
        Math.max(CONFIG_RETRY_MIN, this.configDelay * 2),
      );
      this.log.warn(
        `Configuration not read (${err?.name ?? 'Error'}): again in ${this.configDelay / 1000} s`,
      );
      await this.setStatus(false, both('configUnread'));
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = null;
        this.connected().catch((e) => this.log.error(`Start failed (${e?.name ?? 'Error'})`));
      }, this.configDelay);
      return;
    }
    if (this.stopped || epoch !== this.stopEpoch) return;
    this.configDelay = 0;
    await this.start(config);
  }

  async start(rawConfig) {
    this.stopped = false;
    const gen = ++this.gen;
    const config = normalizeConfig(rawConfig);
    const credKey = config.apiKey;
    const changed = credKey !== this.credKey;
    const another = changed && this.credKey !== undefined;
    // Another key entered by the user: read soon (not at a restart), and
    // always tried, even when its 8-bit tag matches the refused one (a
    // restart keeps the tag only).
    if (another) {
      this.freshConfig = true;
      if (this.refused) {
        this.refused = undefined;
        this.data.refused = null;
      }
    }
    this.config = config;
    if (changed || !this.session) {
      this.session?.close();
      this.session = config.problem
        ? undefined
        : new PstrykSession({
            apiKey: config.apiKey,
            fetchImpl: this.fetchImpl,
            monotonic: this.monotonic,
            sleep: (ms) => this.sleep(ms),
            ...(this.api ? { api: this.api } : {}),
            ...(this.requestTimeout ? { timeout: this.requestTimeout } : {}),
            ...(this.requestGap !== undefined ? { gap: this.requestGap } : {}),
          });
      this.credKey = credKey;
      if (another && config.apiKey) this.forgetAccount();
    }
    this.clearRound();
    await this.ready();
    if (this.gone(gen)) return;
    await this.save();
    if (this.gone(gen)) return;
    await this.refreshCreated(gen);
    if (this.gone(gen)) return;
    await this.publishDiscovery(gen);
    if (this.gone(gen)) return;
    this.schedule(gen);
    this.armTick(gen);
    await this.publishPrices(gen);
    await this.report(gen);
  }

  /**
   * Another API key (maybe another account, whose prices hold another
   * distribution tariff): the prices, the backfill and the errors of the old
   * one go; they are read again.
   */
  forgetAccount() {
    this.keyChanged = true;
    this.data.prices = {};
    this.data.sell = {};
    this.data.backfilled = false;
    this.data.lastFull = null;
    this.data.lastPricesOk = null;
    this.data.confirm = null;
    this.data.confirmed = null;
    this.confirmMono = undefined;
    this.failures = 0;
    this.lastError = undefined;
    this.consumptionError = undefined;
    this.pastMissing = false;
  }

  async stop() {
    this.stopped = true;
    this.stopEpoch += 1;
    this.gen += 1;
    this.clearRound();
    for (const timer of [this.tickTimer, this.configTimer, this.storeTimer]) {
      if (timer) this.timers.clearTimeout(timer);
    }
    this.tickTimer = null;
    this.configTimer = null;
    this.storeTimer = null;
    this.session?.close();
    this.session = undefined;
    this.credKey = undefined;
    for (const wake of this.sleeps) wake();
    this.sleeps.clear();
    await this.running.catch(() => {});
    await this.save();
    await this.bounded(Promise.resolve(this.store.flush?.()), STORE_WAIT).catch(() => {});
  }

  /** `promise`, or TIMED_OUT after `ms` (the timer is cleared either way). */
  bounded(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => resolve(TIMED_OUT), ms);
      promise.then(
        (value) => {
          this.timers.clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          this.timers.clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** Resolves after `ms` (injected timers), or at once when the app stops. */
  sleep(ms) {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      let timer;
      const wake = () => {
        this.timers.clearTimeout(timer);
        this.sleeps.delete(wake);
        resolve();
      };
      timer = this.timers.setTimeout(wake, Math.max(0, ms));
      this.sleeps.add(wake);
    });
  }

  // --- /data ----------------------------------------------------------------------

  /** Waits for /data at most STORE_WAIT; without it, nothing is ever saved. */
  async ready() {
    if (this.storeState === 'ok') return;
    const result = await this.bounded(this.loadStore(), STORE_WAIT);
    if (result === TIMED_OUT && this.storeState === 'pending') {
      this.storeState = 'unreadable';
      this.armStoreRetry();
    }
  }

  armStoreRetry() {
    if (this.storeState === 'ok' || this.stopped || this.storeTimer) return;
    this.storeTimer = this.timers.setTimeout(() => {
      this.storeTimer = null;
      this.loadStore();
    }, STORE_RETRY);
  }

  /** One read of /data at a time; an unreadable one is read again every STORE_RETRY. */
  loadStore() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const raw = await this.store.load();
        const late = this.storeState === 'unreadable';
        this.merge(raw);
        this.storeState = 'ok';
        if (late) await this.afterLateLoad();
      } catch (err) {
        this.storeState = 'unreadable';
        this.log.warn(
          `/data unreadable (${err?.name ?? 'Error'}): read again in ${STORE_RETRY / 1000} s`,
        );
      } finally {
        this.loading = null;
      }
      this.armStoreRetry();
    })();
    return this.loading;
  }

  async afterLateLoad() {
    if (this.storeState !== 'ok' || this.stopped) return;
    const gen = this.gen;
    await this.save();
    if (this.gone(gen)) return;
    if (this.roundTimer) this.schedule(gen);
    await this.publishDiscovery(gen, { onlyChanged: true });
    if (this.gone(gen)) return;
    await this.publishPrices(gen);
    await this.report(gen);
  }

  /** /data read back, merged with what this process learnt meanwhile (the stricter wins). */
  merge(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const now = this.now();
    const mono = this.monotonic();
    for (const key of ['lastPrices', 'lastHoles', 'lastConsumption', 'lastPricesOk']) {
      if (key === 'lastPricesOk' && this.keyChanged) continue;
      // A time of /data in the future is invalid: ignored.
      if (
        finite(data[key]) &&
        data[key] <= now &&
        !(finite(this.data[key]) && this.data[key] > data[key])
      ) {
        this.data[key] = data[key];
      }
    }
    // The failed reads in a row: a restart keeps their spacing (never the full interval).
    if (Number.isInteger(data.failures) && data.failures > this.failures) {
      this.failures = Math.min(data.failures, 16);
    }
    const pause = validPause(data.pause, now, mono);
    if (pause && !(this.pause && this.pause.until >= pause.until)) {
      this.pause = pause;
      this.data.pause = {
        until: pause.until,
        count: pause.count,
        code: pause.code,
        detail: pause.detail,
      };
    }
    const refused = validRefused(data.refused);
    // A refusal of an older key is never taken back once another key was entered.
    if (refused && !this.refused && !this.keyChanged) {
      this.refused = refused;
      this.data.refused = refused;
    }
    if (data.seen === true) this.data.seen = true;
    if (this.keyChanged) return;
    if (
      typeof data.lastFull === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(data.lastFull) &&
      !this.data.lastFull
    ) {
      this.data.lastFull = data.lastFull;
    }
    if (data.backfilled === true) this.data.backfilled = true;
    // What this process read wins over what /data held.
    this.data.prices = {
      ...validHours(data.prices, now, PRICE_HISTORY_DAYS * DAY),
      ...this.data.prices,
    };
    this.data.sell = { ...validHours(data.sell, now, DAY), ...this.data.sell };
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (
      !this.data.confirm &&
      data.confirm &&
      typeof data.confirm.day === 'string' &&
      day.test(data.confirm.day) &&
      finite(data.confirm.due)
    ) {
      // A due date further than the delay is invalid: capped.
      this.data.confirm = {
        day: data.confirm.day,
        due: Math.min(data.confirm.due, now + CONFIRM_DELAY),
      };
    }
    if (!this.data.confirmed && typeof data.confirmed === 'string' && day.test(data.confirmed)) {
      this.data.confirmed = data.confirmed;
    }
  }

  async save() {
    if (this.storeState !== 'ok') return false;
    const snapshot = {
      version: 1,
      lastPrices: this.data.lastPrices,
      lastPricesOk: this.data.lastPricesOk,
      lastHoles: this.data.lastHoles,
      lastConsumption: this.data.lastConsumption,
      lastFull: this.data.lastFull,
      failures: this.failures,
      pause: this.data.pause,
      refused: this.data.refused,
      seen: this.data.seen,
      backfilled: this.data.backfilled,
      prices: this.data.prices,
      sell: this.data.sell,
      confirm: this.data.confirm,
      confirmed: this.data.confirmed,
    };
    try {
      // A slow volume never holds a read: the write goes on in the background.
      const done = this.store.save(snapshot);
      done.catch((err) => this.log.warn(`/data not saved (${err?.name ?? 'Error'})`));
      return (
        (await this.bounded(
          done.then(() => true),
          STORE_WAIT,
        )) === true
      );
    } catch (err) {
      this.log.warn(`/data not saved (${err?.name ?? 'Error'})`);
      return false;
    }
  }

  // --- Pace ------------------------------------------------------------------------

  clearRound() {
    if (this.roundTimer) {
      this.timers.clearTimeout(this.roundTimer);
      this.roundTimer = null;
    }
  }

  pauseActive(mono = this.monotonic()) {
    return Boolean(this.pause && this.pause.due > mono);
  }

  isRefused() {
    return Boolean(
      this.refused && this.refused.tag === tagOf(this.refused.salt, this.config.apiKey),
    );
  }

  /** The monotonic time a kind of read is due, from this process or from /data. */
  dueOf(lastMono, lastWall, interval, mono, now) {
    if (lastMono !== undefined) return lastMono + interval;
    // /data not read: its last read is unknown; a short wait (never a burst
    // of restarts), the interval when shorter.
    // Counted from the first start of this process: a fixed time, never moving on.
    this.bootMono ??= mono;
    if (this.storeState !== 'ok') return this.bootMono + Math.min(interval, UNREADABLE_WAIT);
    return finite(lastWall) && lastWall <= now
      ? mono + Math.max(0, interval - (now - lastWall))
      : mono;
  }

  /** Whether every hour from `from` to `until` has a price. */
  covered(from, until) {
    for (let h = from - (from % HOUR); h < until; h += HOUR) {
      if (this.data.prices[h / HOUR] === undefined) return false;
    }
    return true;
  }

  /** The first past hour without a price, as far back as the core may ask (31 days); undefined when none. */
  firstHole(now) {
    const from = addDays(now, -PRICE_BACKFILL_DAYS);
    // Up to yesterday: the recent window (yesterday to tomorrow) is the hourly read's business.
    const until = addDays(now, -1);
    for (let h = from; h < until; h += HOUR) {
      if (this.data.prices[h / HOUR] === undefined) return h;
    }
    return undefined;
  }

  /** The end of the prices needed now: today, or tomorrow too from 14:00 in Poland. */
  neededUntil(now) {
    return addDays(now, local(now).h >= PRICES_HOUR ? 2 : 1);
  }

  pricesDue(mono, now) {
    const gap = this.freshConfig
      ? CREATED_MIN_GAP
      : this.failures > 0
        ? Math.min(RETRY_MAX, RETRY_MIN * 2 ** (this.failures - 1))
        : PRICES_INTERVAL;
    const due = this.dueOf(this.lastPricesMono, this.data.lastPrices, gap, mono, now);
    if (this.freshConfig || !this.covered(now, this.neededUntil(now))) return due;
    // All held: the next read when tomorrow's prices are needed (the next 14:00 in Poland).
    const t = local(now);
    let at = fromLocal(t.y, t.mo, t.d, PRICES_HOUR);
    if (at <= now) {
      const n = local(addDays(now, 1));
      at = fromLocal(n.y, n.mo, n.d, PRICES_HOUR);
    }
    let next = mono + (at - now);
    // Tomorrow kept once: read again to confirm it (once).
    const confirm = this.pendingConfirm(now);
    if (confirm) {
      const confirmDue =
        this.confirmMono ?? mono + Math.min(CONFIRM_DELAY, Math.max(0, confirm.due - now));
      next = Math.min(next, confirmDue);
    }
    return Math.max(due, next);
  }

  /** The confirmation still to do (its day not over), else undefined. */
  pendingConfirm(now) {
    const c = this.data.confirm;
    if (!c) return undefined;
    if (c.day < localDate(now)) {
      this.data.confirm = null;
      this.confirmMono = undefined;
      return undefined;
    }
    return c;
  }

  /**
   * After a read of the recent prices: a confirmation due by then is done;
   * tomorrow kept for the first time asks for one (3 hours later, aiming
   * before 23:00, at least an hour later).
   */
  afterRecentRead(startMono, now, heldBefore) {
    const tomorrow = addDays(now, 1);
    const day = localDate(tomorrow);
    const c = this.pendingConfirm(now);
    if (c) {
      const due = this.confirmMono ?? startMono + Math.max(0, c.due - now);
      if (startMono >= due) {
        this.data.confirmed = c.day;
        this.data.confirm = null;
        this.confirmMono = undefined;
      }
      return;
    }
    if (heldBefore || this.data.confirmed === day) return;
    if (!this.covered(tomorrow, addDays(tomorrow, 1))) return;
    const t = local(now);
    const aim = fromLocal(t.y, t.mo, t.d, CONFIRM_BEFORE_HOUR) - now;
    const delay = Math.max(CONFIRM_MIN, Math.min(CONFIRM_DELAY, aim));
    this.data.confirm = { day, due: now + delay };
    this.confirmMono = startMono + delay;
  }

  /**
   * A past hour without a price (before yesterday) blocks every delegated
   * request of its billing period: read again on its own pace, at most every
   * 6 hours, never mixed with the recent read.
   */
  holesDue(mono, now) {
    // After a recent read succeeded (the key answers): never a burst after a test or a new key.
    if (!finite(this.data.lastPricesOk) || this.freshConfig || this.firstHole(now) === undefined) {
      return Infinity;
    }
    return this.dueOf(this.lastHolesMono, this.data.lastHoles, HOLES_INTERVAL, mono, now);
  }

  consumptionDue(mono, now) {
    if (!this.data.seen || !this.created.has(this.ids.feature(FEATURE.CONSUMPTION))) {
      return Infinity;
    }
    const due = this.dueOf(
      this.lastConsumptionMono,
      this.data.lastConsumption,
      CONSUMPTION_INTERVAL,
      mono,
      now,
    );
    // A new device: soon, but never sooner than CREATED_MIN_GAP after a read.
    if (this.pendingBackfill) {
      return Math.min(
        due,
        this.dueOf(this.lastConsumptionMono, this.data.lastConsumption, CREATED_MIN_GAP, mono, now),
      );
    }
    return due;
  }

  /** The next round: when the first kind of read is due, never during a pause or a refusal. */
  schedule(gen) {
    if (this.gone(gen)) return;
    this.clearRound();
    if (!this.session || this.isRefused()) {
      this.dueMono = undefined;
      return;
    }
    const mono = this.monotonic();
    const now = this.now();
    let due = Math.min(
      this.pricesDue(mono, now),
      this.holesDue(mono, now),
      this.consumptionDue(mono, now),
    );
    if (this.pause) due = Math.max(due, this.pause.due);
    this.dueMono = Math.max(due, mono);
    this.roundTimer = this.timers.setTimeout(() => {
      this.roundTimer = null;
      this.running = this.round(gen).catch((err) =>
        this.log.error(`Round failed (${err?.name ?? 'Error'})`),
      );
    }, this.dueMono - mono);
  }

  /** The price features again at every hour (no request). */
  armTick(gen) {
    if (this.tickTimer) this.timers.clearTimeout(this.tickTimer);
    const now = this.now();
    // On the next hour (wall clock: the prices are), a second after it.
    const wait = Math.min(TICK, HOUR - (now % HOUR) + 1000);
    this.tickTimer = this.timers.setTimeout(() => {
      this.tickTimer = null;
      if (this.gone(gen)) return;
      this.publishPrices(gen)
        .catch(() => {})
        .then(() => this.capPause(gen))
        .catch(() => {})
        .then(() => this.report(gen))
        .catch(() => {})
        .then(() => {
          if (!this.gone(gen)) this.armTick(gen);
        });
    }, wait);
  }

  // --- Reads -------------------------------------------------------------------------

  async round(gen) {
    if (this.gone(gen) || !this.session || this.isRefused()) return;
    if (this.pauseActive()) {
      this.schedule(gen);
      return;
    }
    try {
      if (this.pricesDue(this.monotonic(), this.now()) <= this.monotonic()) {
        await this.readPrices(gen);
      }
      if (this.gone(gen)) return;
      if (!this.pauseActive() && this.holesDue(this.monotonic(), this.now()) <= this.monotonic()) {
        await this.readHoles(gen);
      }
      if (this.gone(gen)) return;
      if (
        !this.pauseActive() &&
        this.consumptionDue(this.monotonic(), this.now()) <= this.monotonic()
      ) {
        await this.readConsumption(gen);
      }
    } catch (err) {
      if (this.gone(gen)) return;
      await this.failed(gen, err);
    }
    if (this.gone(gen)) return;
    this.schedule(gen);
    await this.report(gen);
  }

  /** A read failed: a refusal, a pause or a passing error (retried later). */
  async failed(gen, err) {
    const code = err instanceof PstrykError ? err.code : 'bad_response';
    if (code === 'stopped') return;
    if (code === 'refused') {
      await this.refuse(err);
      return;
    }
    if (PAUSING.has(code)) {
      await this.setPause(err);
      return;
    }
    this.lastError = codeOf(err);
    this.log.warn(`Pstryk not read (${this.lastError})`);
    await this.save();
  }

  async refuse(err) {
    const salt = this.random(16).toString('hex');
    this.refused = {
      salt,
      tag: tagOf(salt, this.config.apiKey),
      status: err.status === 401 ? 401 : 403,
    };
    this.data.refused = this.refused;
    this.log.warn(
      `Pstryk refused the API key (HTTP ${this.refused.status}): no request until it changes or Test succeeds`,
    );
    this.clearRound();
    await this.save();
  }

  async setPause(err) {
    const now = this.now();
    const mono = this.monotonic();
    const count = Math.min((this.pause?.code === err.code ? this.pause.count : 0) + 1, 16);
    const base = err.code === 'rate_limited' ? RATE_LIMIT_PAUSE : SERVER_PAUSE;
    const asked = finite(err.retryAfter) && err.retryAfter > 0 ? err.retryAfter : 0;
    const ms = Math.min(
      this.serverCap(err.code, now),
      Math.max(PAUSE_MIN, asked, base * 2 ** (count - 1)),
    );
    const detail = err.status ? `HTTP ${err.status}` : null;
    this.pause = { until: now + ms, due: mono + ms, count, code: err.code, detail };
    this.data.pause = { until: now + ms, count, code: err.code, detail };
    this.log.warn(`Pstryk paused until ${clock(now + ms)} (${detail ?? err.code})`);
    await this.save();
  }

  /**
   * The longest pause: 6 hours, but an hour for a 5xx while no price of the
   * current hour is held (an outage lasting past midnight: today's prices are
   * looked for hourly, never 6 hours late). A 429 keeps what was asked.
   */
  serverCap(code, now) {
    return code === 'server' && this.priceAt(now) === undefined ? HOUR : PAUSE_MAX;
  }

  /** At every hour: a 5xx pause longer than its cap now is shortened (the next read sooner). */
  async capPause(gen) {
    if (!this.pause || this.pause.code !== 'server') return;
    const now = this.now();
    const mono = this.monotonic();
    const cap = this.serverCap('server', now);
    if (this.pause.due - mono <= cap) return;
    this.pause = { ...this.pause, until: now + cap, due: mono + cap };
    this.data.pause = { ...this.data.pause, until: now + cap };
    await this.save();
    if (!this.gone(gen) && this.roundTimer) this.schedule(gen);
  }

  /** A request answered: the pause is over and its count forgotten. */
  async clearPause() {
    if (!this.pause && !this.data.pause) return;
    this.pause = undefined;
    this.data.pause = null;
    await this.save();
  }

  /** A first answer of the key: the device is offered in Discovery from now on. */
  async markSeen(gen) {
    if (this.data.seen) return;
    this.data.seen = true;
    await this.save();
    if (this.gone(gen)) return;
    await this.publishDiscovery(gen);
  }

  /** The recent prices (yesterday to the end of tomorrow). */
  async readPrices(gen) {
    const session = this.session;
    const now = this.now();
    // The attempt is kept BEFORE anything: a restart never reads sooner.
    this.freshConfig = false;
    const startMono = this.monotonic();
    this.lastPricesMono = startMono;
    this.data.lastPrices = now;
    await this.save();
    if (this.gone(gen)) return;
    let parsed;
    try {
      const body = await session.metrics('pricing', addDays(now, -1), addDays(now, 2));
      if (this.gone(gen)) return;
      parsed = parsePricing(body);
      if (!parsed) throw new PstrykError('bad_response');
    } catch (err) {
      this.failures = Math.min(this.failures + 1, 16);
      throw err;
    }
    await this.clearPause();
    if (this.gone(gen)) return;
    this.failures = 0;
    this.lastError = undefined;
    this.data.lastPricesOk = this.now();
    const tomorrow = addDays(now, 1);
    const heldBefore = this.covered(tomorrow, addDays(tomorrow, 1));
    this.record(parsed);
    this.afterRecentRead(startMono, now, heldBefore);
    this.prune();
    await this.save();
    if (this.gone(gen)) return;
    await this.markSeen(gen);
    if (this.gone(gen)) return;
    await this.publishPrices(gen);
  }

  /**
   * The past hours without a price (before yesterday, 31 days back at most),
   * by windows of 16 days. A day Pstryk gives incomplete or flat stays a
   * hole, said in the status.
   */
  async readHoles(gen) {
    const session = this.session;
    const now = this.now();
    this.lastHolesMono = this.monotonic();
    this.data.lastHoles = now;
    await this.save();
    if (this.gone(gen)) return;
    const hole = this.firstHole(now);
    if (hole !== undefined) {
      const end = addDays(now, -1);
      for (let from = startOfDay(hole); from < end;) {
        const to = Math.min(end, addDays(from, PRICE_WINDOW_DAYS));
        try {
          const parsed = parsePricing(await session.metrics('pricing', from, to));
          if (this.gone(gen)) return;
          if (!parsed) throw new PstrykError('bad_response');
          this.record(parsed);
        } catch (err) {
          if (STOPPING.has(err?.code)) throw err;
          this.log.warn(`Past prices not read (${codeOf(err)})`);
        }
        from = to;
      }
    }
    if (this.gone(gen)) return;
    this.pastMissing = this.firstHole(this.now()) !== undefined;
    this.prune();
    await this.save();
  }

  /** Prices kept in /data; an hour already started keeps the price kept for it. */
  record({ buy, sell }) {
    const now = this.now();
    let changed = 0;
    for (const [h, price] of buy) {
      const index = h / HOUR;
      if (h <= now && this.data.prices[index] !== undefined) continue;
      if (h > now + 3 * DAY) continue;
      // An hour not started yet takes the value read again.
      if (this.data.prices[index] !== undefined && this.data.prices[index] !== price) changed += 1;
      this.data.prices[index] = price;
    }
    if (changed) this.log.warn(`Pstryk changed the price of ${changed} hour(s) to come: replaced`);
    for (const [h, price] of sell) {
      if (h + HOUR <= now - DAY || h > now + 3 * DAY) continue;
      this.data.sell[h / HOUR] = price;
    }
  }

  /** Prices leave /data by their age only (40 days; the sale prices after a day). */
  prune() {
    const now = this.now();
    const oldest = Math.floor((now - PRICE_HISTORY_DAYS * DAY) / HOUR);
    for (const index of Object.keys(this.data.prices)) {
      if (Number(index) < oldest) delete this.data.prices[index];
    }
    const oldestSell = Math.floor((now - DAY) / HOUR);
    for (const index of Object.keys(this.data.sell)) {
      if (Number(index) < oldestSell) delete this.data.sell[index];
    }
  }

  async readConsumption(gen) {
    const session = this.session;
    const now = this.now();
    this.lastConsumptionMono = this.monotonic();
    this.data.lastConsumption = now;
    const today = localDate(now);
    const full = this.data.lastFull !== today && local(now).h >= BACKFILL_HOUR;
    const backfill = full || !this.data.backfilled || this.pendingBackfill;
    await this.save();
    if (this.gone(gen)) return;
    const days = backfill ? BACKFILL_DAYS : CONSUMPTION_DAYS;
    let intervals;
    try {
      const body = await session.metrics('meter_values', addDays(now, -days), now - (now % HOUR));
      if (this.gone(gen)) return;
      intervals = parseConsumption(body, this.now());
      if (!intervals) throw new PstrykError('bad_response');
    } catch (err) {
      if (STOPPING.has(err?.code)) throw err;
      // The consumption failing never stops the prices.
      this.consumptionError = codeOf(err);
      this.log.warn(`Consumption not read (${this.consumptionError})`);
      await this.save();
      return;
    }
    await this.clearPause();
    if (this.gone(gen)) return;
    const feature = this.ids.feature(FEATURE.CONSUMPTION);
    try {
      for (let i = 0; i < intervals.length; i += 2000) {
        await this.gladys.publishEnergyConsumption(feature, intervals.slice(i, i + 2000));
        if (this.gone(gen)) return;
      }
      this.pendingBackfill = false;
      this.data.backfilled = true;
      this.consumptionError = undefined;
      if (full) this.data.lastFull = today;
    } catch (err) {
      this.consumptionError = 'gladys';
      this.log.warn(`Consumption not published (${err?.name ?? 'Error'})`);
    }
    await this.save();
  }

  // --- Gladys --------------------------------------------------------------------------

  async refreshCreated(gen) {
    try {
      const devices = await this.bounded(Promise.resolve(this.gladys.getDevices()), 10_000);
      if (this.gone(gen) || devices === TIMED_OUT || !Array.isArray(devices)) return;
      this.created = new Set();
      for (const d of devices) this.addCreated(d);
    } catch (err) {
      this.log.warn(`Devices not read from Gladys (${err?.name ?? 'Error'})`);
    }
  }

  addCreated(device) {
    if (device?.external_id !== this.ids.device) return false;
    this.created.add(device.external_id);
    for (const f of device.features ?? []) if (f?.external_id) this.created.add(f.external_id);
    return true;
  }

  async onDeviceCreated(device) {
    if (!this.addCreated(device)) return;
    const gen = this.gen;
    if (!this.data.backfilled) this.pendingBackfill = true;
    // Its values from what is held, then its reads when due (never a burst).
    await this.publishPrices(gen);
    if (!this.gone(gen) && this.roundTimer) this.schedule(gen);
  }

  onDeviceDeleted(device) {
    if (device?.external_id !== this.ids.device) return;
    for (const f of device.features ?? []) this.created.delete(f?.external_id);
    this.created.delete(device.external_id);
    this.pendingBackfill = false;
  }

  /** The device offered in Discovery once the key was answered. Never a request. */
  async publishDiscovery(gen, { onlyChanged = false } = {}) {
    const devices = this.data.seen ? [buildDevice(this.gladys)] : [];
    const text = JSON.stringify(devices);
    if (onlyChanged && text === this.lastDiscovery) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      if (!this.gone(gen)) this.lastDiscovery = text;
    } catch (err) {
      this.log.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  async scan() {
    await this.publishDiscovery(this.gen);
  }

  /** The price kept for the hour holding `ms`. */
  priceAt(ms) {
    return this.data.prices[Math.floor(ms / HOUR)];
  }

  /** The next change of price after the hour `h` (within 2 days): { at, price }. */
  nextChange(h, price) {
    for (let at = h + HOUR; at < h + 2 * DAY; at += HOUR) {
      const p = this.priceAt(at);
      if (p === undefined) return { at, price: undefined };
      if (p !== price) return { at, price: p };
    }
    return undefined;
  }

  /** The price features of the created device, from what is held (no request). */
  async publishPrices(gen) {
    if (this.gone(gen) || !this.created.has(this.ids.device)) return;
    const now = this.now();
    const h = now - (now % HOUR);
    const states = priceStates(this.ids, {
      price: this.priceAt(h),
      // The next hour's price; unknown stays unknown.
      nextPrice: this.priceAt(h + HOUR),
      sellPrice: this.data.sell[h / HOUR],
    });
    if (!states.length) return;
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.log.warn(`States not published (${err?.name ?? 'Error'})`);
    }
  }

  // --- Energy contracts (delegated) ------------------------------------------------------

  /**
   * The cost of every interval (30 min): its kWh at the gross price of its
   * hour read from Pstryk; a negative price costs 0 (a cost is >= 0). One
   * price unknown: the whole request fails (the core retries later), never a
   * silent zero. No request: what is held only.
   */
  energyPrice({ intervals }) {
    return (Array.isArray(intervals) ? intervals : []).map(({ starts_at: startsAt, kwh }) => {
      const t0 = Date.parse(startsAt);
      const price = Number.isFinite(t0) && t0 % HALF_HOUR === 0 ? this.priceAt(t0) : undefined;
      if (!finite(kwh) || kwh < 0) {
        throw new Error(`Not a consumption for ${String(startsAt).slice(0, 40)}`);
      }
      // Nothing consumed costs 0 whatever the price (nothing guessed).
      if (kwh === 0) return { starts_at: startsAt, cost: 0, label: 'Pstryk' };
      if (price === undefined) {
        throw new Error(`No Pstryk price known for ${String(startsAt).slice(0, 40)}`);
      }
      const cost = Math.max(0, kwh * price);
      return { starts_at: startsAt, cost: Math.round(cost * 1e8) / 1e8, label: 'Pstryk' };
    });
  }

  energyCurrent() {
    const now = this.now();
    const h = now - (now % HOUR);
    const price = this.priceAt(h);
    if (price === undefined) return { price: null };
    const next = this.nextChange(h, price);
    return {
      price,
      valid_until: next ? new Date(next.at).toISOString() : null,
      next_price: next?.price ?? null,
    };
  }

  // --- Status ------------------------------------------------------------------------

  async report(gen = this.gen) {
    if (this.gone(gen)) return;
    const [connected, message] = this.statusNow();
    if (this.storeState !== 'ok' && this.storeState !== 'pending') {
      for (const lang of ['en', 'fr']) message[lang] += t('storage', lang);
    }
    for (const lang of ['en', 'fr']) message[lang] = bound(message[lang].trim(), MAX_STATUS);
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    await this.setStatus(connected, message, key);
  }

  async setStatus(connected, message, key = JSON.stringify([connected, message])) {
    try {
      await this.gladys.setConnectionStatus(connected, message);
      this.lastStatus = key;
    } catch (err) {
      this.log.warn(`Status not sent (${err?.name ?? 'Error'})`);
    }
  }

  nextTime() {
    const wait = Math.max(0, (this.dueMono ?? this.monotonic()) - this.monotonic());
    // Rounded up: never a time before the read.
    const now = this.now();
    return stamp(now + wait + 999, now);
  }

  statusNow() {
    if (this.config.problem) return [false, both(this.config.problem)];
    if (this.isRefused()) return [false, both('refused', { code: this.refused.status })];
    if (this.pauseActive()) {
      return [
        false,
        both(this.pause.code === 'rate_limited' ? 'rateLimited' : 'server', {
          time: clock(this.pause.until),
          code: this.pause.detail ?? this.pause.code,
        }),
      ];
    }
    const now = this.now();
    const ok = this.data.lastPricesOk;
    if (!finite(ok)) {
      return this.lastError
        ? [false, both('failing', { code: this.lastError, time: this.nextTime() })]
        : [false, both('starting', { time: this.nextTime() })];
    }
    const message = both('connected', { time: stamp(ok, now) });
    const add = (key, values) => {
      for (const lang of ['en', 'fr']) message[lang] += t(key, lang, values);
    };
    if (this.lastError) add('lastFailed', { code: this.lastError, time: this.nextTime() });
    if (this.priceAt(now) === undefined) add('noPrices');
    // Said only while a hole is still there (filled, or out of the 31 days).
    if (this.pastMissing && this.firstHole(now) === undefined) this.pastMissing = false;
    if (this.pastMissing) add('pastMissing');
    if (this.consumptionError) add('consumptionFailed', { code: this.consumptionError });
    return [!this.lastError, message];
  }

  // --- Test button ------------------------------------------------------------------------

  /** "Not sent" during a pause: asked by Pstryk (429) or Pstryk unavailable (5xx). */
  pausedText() {
    return both(this.pause.code === 'rate_limited' ? 'testPaused' : 'testServer', {
      time: clock(this.pause.until),
    });
  }

  /** One read of the prices of this hour: lifts a refusal on success. */
  async testConnection() {
    if (this.config.problem) return both(this.config.problem);
    const mono = this.monotonic();
    if (this.lastTest !== undefined && mono - this.lastTest < TEST_MIN_GAP)
      return both('testTooSoon');
    if (this.pauseActive(mono)) return this.pausedText();
    const session = this.session;
    if (!session) return both('missing');
    const gen = this.gen;
    this.lastTest = mono;
    const now = this.now();
    const h = now - (now % HOUR);
    let message;
    try {
      const body = await session.metrics('pricing', h, h + HOUR);
      if (this.gone(gen)) return both('testFailed', { code: 'restarted' });
      if (!Array.isArray(body?.frames)) throw new PstrykError('bad_response');
      const count = body.frames.filter(
        (f) =>
          f?.metrics?.pricing?.price_gross !== undefined && f.metrics.pricing.price_gross !== null,
      ).length;
      message = both('testOk', { count });
      await this.clearPause();
      if (this.refused) {
        // The key works: read soon (never sooner than a minute after the last read).
        this.refused = undefined;
        this.data.refused = null;
        this.freshConfig = true;
        this.failures = 0;
        await this.save();
      }
      if (!this.gone(gen)) await this.markSeen(gen);
      if (!this.gone(gen)) this.schedule(gen);
    } catch (err) {
      if (this.gone(gen)) return both('testFailed', { code: 'restarted' });
      const code = err instanceof PstrykError ? err.code : 'bad_response';
      if (code === 'refused') {
        await this.refuse(err);
        message = both('refused', { code: this.refused.status });
      } else if (PAUSING.has(code)) {
        await this.setPause(err);
        message = this.pausedText();
      } else {
        message = both('testFailed', { code: codeOf(err) });
      }
    }
    await this.report(gen);
    return message;
  }
}
