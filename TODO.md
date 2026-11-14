# TODO

## Before announcing

- [ ] Test on a real Gladys 5.3+ with a real Pstryk account: the key, the
      Test button, Discovery, the 7-day consumption backfill, the price
      features over a day, a "Pstryk dynamic price" contract priced.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).
- [ ] Store keywords left out of the manifest on purpose (Louis' rule):
      `pstryk`, `taryfa dynamiczna`, `ceny dynamiczne prądu`.

## To confirm on a real account (built from the OpenAPI description only)

- [ ] Where the API key is created in the Pstryk app (the docs say "in the
      app", without the menu).
- [ ] `metrics.pricing.price_gross` of a frame (`resolution=hour`) is the
      gross price per kWh shown in the app, in PLN; what it includes (energy
      only, or the variable distribution charges and the excise too). The
      template description says "the gross price Pstryk gives", not more.
- [ ] The answer of a wrong key: HTTP 403 `{"detail": "Incorrect
authentication credentials."}` (seen on 2026-11-14 with a made-up key;
      Polish without `Accept-Language: en`). A right key on a 403: never seen.
- [ ] Tomorrow's prices before they are out: missing (`null`) or placeholders
      (one repeated value, as ha_Pstryk guards against)? Both are refused
      (a day is kept whole and not flat), and asked again hourly from 14:00.
- [ ] How far back `metrics=pricing` answers (the module asks up to 31 days).
- [ ] `metrics=meter_values` hourly frames: `energy_active_import_register`
      in kWh for the hour (a delta, not the register index), the live hour
      flagged `is_live`; the key `meter_values` (the spec's example says
      `meterValues`: both read).
- [ ] The rate limits of the API (none published): one request at a time,
      2 s apart, about 15 requests a day in normal use.
- [ ] A Polish 15-minute market since 2025: Pstryk serves `hour`,
      `day`, `month` and `minute` resolutions only; the hourly price is
      taken as Pstryk gives it.

## Decisions

- **Version 0.1.0** set by hand (package, lock, manifest, image tag) when
  leaving the template; the Release workflow owns it from now on.
- **`gladys_version: ">=5.3.0"`** with `countries: ["PL"]` (Louis' rule of
  2026-11-12: `countries` needs 5.3.0); `publishEnergyConsumption` and the
  energy contracts need 5.2.0 anyway.
- **Read-only (v1)**: only GET requests of the unified metrics endpoint.
- **One device, fixed id** `ext:pstryk:meter:pstryk`: a key reads one account
  and the API gives no account id; nothing of the key is derived into an id.
  Offered in Discovery once the key was answered.
- **One delegated template, no calendar.** The price per kWh is the
  customer's (its distribution tariff depends on the account): a shared
  calendar key (global, provider-neutral, e.g. a Polish spot calendar) could
  not carry it. The fixed monthly fees are a `fixed` component fed by a
  template input (Gladys computes it).
- **Prices**: `price_gross`, PLN/kWh, VAT included, as given. A half hour is
  priced at its hour's price; a negative price costs 0 (the core refuses a
  negative cost); an unknown price fails the whole request of its billing
  period (never a silent zero). A Polish day is kept only whole (23, 24 or 25
  hours) and not flat (> 90 % of its hours one value: a placeholder). An hour
  already started keeps the price first kept (a retry gets the same answer).
  Prices kept 40 days in `/data`; the sale price (`price_prosumer_gross`) a
  day, for the feature only.
- **Export not priced**: the core prices consumption only; the sale price is
  a feature.
- **Another key in the running process** drops the prices, the backfill marker
  and the refusal; across a restart the key cannot be compared (no
  fingerprint of a valid key is ever kept), so `/data` is kept.
- **Refusal**: only a 401/403 whose `detail` is the DRF wrong-credentials
  text (English asked, Polish read too); persisted as 8 bits of a salted
  hash; no request until the key changes or Test succeeds. Any other 401/403,
  a 404, an unreadable answer: passing, spaced 5 minutes doubled to 1 hour.
- **Pace**: recent prices (yesterday to the end of tomorrow) when the ones
  held do not reach the end of today (or of tomorrow from 14:00, Polish
  time), at most hourly, else nothing until the next 14:00; past holes (31
  days, windows of 16 days) every 6 hours, only after a recent read
  succeeded; consumption every 3 h (3 days; 7 days daily after 06:00 and for
  a new device, at least 1 minute after another read). 429: `Retry-After` or
  15 min doubled; 5xx: 5 min doubled; at most 6 h, persisted.
- **No złoty unit in Gladys**: the price features carry no unit, their name
  says PLN.
- **CI**: `timeout-minutes` added to the jobs of `.github/workflows/ci.yml`
  (a hanging test never holds a runner): the release tag is set by hand.
