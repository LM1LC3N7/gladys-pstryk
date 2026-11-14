# Pstryk for Gladys Assistant

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for
**Pstryk** electricity customers in Poland, not affiliated with Pstryk. It
reads your own data through the official Pstryk integration API
([api.pstryk.pl/integrations/swagger](https://api.pstryk.pl/integrations/swagger/))
with an API key you create in the Pstryk app:

- one device: the gross price per kWh of the current hour and of the next
  one, the prosumer sale price of the current hour, and the hourly
  consumption of your meter for the energy monitoring (each hour split in two
  halves);
- the energy contract template **Pstryk dynamic price**, priced by the
  integration from the gross hourly prices Pstryk gives for your contract
  (VAT included), plus the monthly fees you enter.

**Read-only**: nothing is ever changed on your account. Never tested with a
real Pstryk account yet.

Documentation: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test            # node --test
npm run lint
npm run format:check
npm run mutants     # mutation check of the guards (scripts/mutants.json)
npm run cover       # regenerates cover.png
```

Rules for contributors and coding assistants: [CLAUDE.md](CLAUDE.md).
Open points and decisions: [TODO.md](TODO.md).

## Credits and license

Apache-2.0 ([LICENSE](LICENSE)). Written from the official OpenAPI description
of the Pstryk API, no third-party code: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
