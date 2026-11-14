# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads **Pstryk** (Poland) through the official Pstryk integration API
(`https://api.pstryk.pl/integrations/meter-data/unified-metrics/`, the
customer's API key in the `Authorization` header; OpenAPI at
`/integrations/schema/`): the gross hourly prices (`metrics=pricing`) and the
hourly meter consumption (`metrics=meter_values`). **Read-only.** Unofficial:
not affiliated with Pstryk. Written from the official OpenAPI description;
ha_Pstryk (MIT) read as an example only.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/model.test.js            # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run mutants                           # mutation check (run under memcap, one at a time)
```

## Architecture

```
index.js                 SDK wiring only
src/handlers.js          every handler registered before connect() (shared with the tests)
src/app.js               PstrykApp: pace, pauses, refusal, /data, Discovery, prices, pricing, status
src/pstryk/client.js     the only network code: GET with the key, bounded bodies, one request at a time
src/pstryk/model.js      reading the answers (pure): prices (whole days only), consumption
src/devices.js           the Gladys device (pure), external ids
src/store.js             /data/pstryk.json (atomic writes, unreadable != empty)
src/time.js              Polish local time (Intl)
src/i18n.js              runtime texts, en + fr
test/                    node --test against the SDK's fake Gladys and a fake Pstryk API
```

## Rules

- **External ids are forever**: `ext:pstryk:meter:pstryk` and its feature
  keys `price`, `next_price`, `sell_price`, `consumption`; the template key
  `pstryk-dynamic` and its input `monthly_fees`.
- **No secret anywhere**: the API key never reaches a log, the status,
  `/data`, a URL nor an error message; the text of an answer never reaches an
  error message.
- **Never a guessed value**: an unreadable price or consumption is unknown,
  never 0; a Polish day is kept only whole and not flat; a delegated interval
  without its hour price fails the request.
- **Only a 401/403 whose `detail` is the API's wrong-credentials text is a
  refusal**; everything else is passing.
- **Two clocks**: the monotonic clock paces and pauses; the wall clock dates
  prices, consumption and what `/data` keeps.
- **Versions belong to the Release workflow.** Changelog lines under
  `## [Unreleased]`. Texts bilingual (en, fr), docs/en.md and docs/fr.md in
  sync with the code. A secret field is described as kept by Gladys, never shown again.
