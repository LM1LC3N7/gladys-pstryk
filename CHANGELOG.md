# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: the Pstryk account of an API key read through the official
  Pstryk integration API, one device with the gross price per kWh of the
  current and of the next hour, the prosumer sale price of the current hour
  and the hourly consumption of the meter (published after the fact, by half
  hour).
- The delegated energy contract template "Pstryk dynamic price": every half
  hour priced at the gross price of its hour, kept 40 days in `/data`, plus
  the monthly fees entered by the user.
- Test button, a refused key kept (never sent again until changed or Test
  succeeds), pauses on 429 and 5xx kept across restarts.
- The manifest declares `countries: ["PL"]` (the store shows the integration
  for Poland), which needs Gladys 5.3.0 or later.
- Past hours without a price (Gladys stopped, Pstryk unavailable) are read
  again, up to 31 days back, at most every 6 hours.
- Tomorrow's prices, once first kept, are read once more (3 hours later,
  aiming before 23:00): the hours not started yet take the values read again.
- A 5xx pause lasts at most an hour while no price of the current hour is
  held; `/data` unreadable at a start: the first read after 5 minutes.
