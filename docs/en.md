# Pstryk

Unofficial integration for **Pstryk** electricity customers in Poland, not
affiliated with Pstryk. It reads your own data through the official Pstryk
integration API (api.pstryk.pl). **Read-only**: nothing is ever changed on
your account.

> This integration has never been tested with a real Pstryk account: it was
> written from the official API description. Please report what you see
> (GitHub issues of LM1LC3N7/gladys-pstryk).

## What you get

- **One device**, "Pstryk electricity", offered in Discovery once Pstryk has
  answered your key:
  - **Price per kWh now (PLN)** and **Next price per kWh (PLN)**: the gross
    price (VAT included) Pstryk gives for the current hour and the next one,
    in złoty per kWh. Gladys has no złoty unit: the features show the bare
    number.
  - **Sale price per kWh now (PLN, prosumer)**: the price Pstryk gives for the
    energy you export during the current hour, when it gives one.
  - **Consumption (30 min)**: the consumption of your meter, published after
    the fact for the Gladys energy monitoring. Pstryk gives hours: each hour is
    split in two equal halves. The hour still running is never published.
- **The energy contract template "Pstryk dynamic price"**: Gladys asks the
  integration the cost of every half hour; it answers with the consumption
  times the gross price of that hour. An hour whose price is negative costs 0
  (Gladys accepts no negative cost): the cost shown by Gladys is then above
  your bill by the credit, if Pstryk grants one. The energy you export is not
  credited (Gladys prices the consumption only). The fixed monthly fees
  (subscription, fixed part of the distribution, capacity fee) are an amount
  you enter in the contract.

## Setting up

1. In the **Pstryk app**, create an **API key** for integrations and copy it.
2. In Gladys, open the integration's **Configuration**, paste the key and
   save. **Test the connection** reads the price of the current hour with it.
3. In **Discovery**, add the "Pstryk electricity" device.
4. In the energy settings, create a contract from the **Pstryk dynamic price**
   template, attached to that device's consumption, and enter your fixed fees
   per month (VAT included, from your invoice).

The API key is kept by Gladys in its database, never shown again and sent only
to Pstryk (api.pstryk.pl), in the `Authorization` header of each request.

## How often it reads

- The recent prices (yesterday to the end of tomorrow): when the ones held do
  not cover the rest of today (or, from 14:00 Polish time, the whole of
  tomorrow), at most once an hour. Once tomorrow is held, nothing until 14:00
  the next day.
- The missing past prices (after a stop, an outage): up to 31 days back, at
  most every 6 hours.
- The consumption, once you added the device: every 3 hours (the last 3
  days), once a day after 06:00 and for a new device the last 7 days.
- After a failed read of the prices: again after 5, 10, 20, 40, then every 60
  minutes. Pstryk asking to slow down (HTTP 429, its `Retry-After` honoured)
  or being unavailable (5xx): no request at all until the time asked (at
  least 1 minute, at most 6 hours), kept across restarts.
- A restart, Discovery or saving the configuration never reads sooner than
  these intervals (a new key is read after 1 minute). One request at a time,
  2 seconds apart at least.

## What the prices are

For each hour, Pstryk's API gives the gross price per kWh of your contract
(`price_gross`, VAT included). The integration keeps it as given; whether it
includes the variable distribution charges and the excise is Pstryk's choice
(the price shown in the Pstryk app). The prices of the past hours are kept 40
days in `/data`, so Gladys can price the past intervals.

Never a guessed price, never an unknown price counted 0. A Polish day is kept
only whole: every one of its hours priced (23 or 25 on the days the clocks
change), and not one value repeated over almost the whole day (what Pstryk may answer before tomorrow's
prices are published). When one hour of a billing period has no price,
Gladys's whole request for that period fails and no cost is stored for it
until the price is known: the integration reads the missing past days again
(up to 31 days back, at most every 6 hours), for instance after Gladys was
stopped; a day Pstryk never gives keeps those costs empty.

Another API key (maybe another account, with another distribution tariff)
drops the prices held and reads them again. After a restart the prices held in
`/data` are kept whatever the key: change the key while Gladys runs.

## Messages

- _Pstryk refused the API key_: Pstryk answered 401 or 403 saying the key is
  wrong ("Incorrect authentication credentials."). Nothing is sent again until
  you change the key or the **Test** button succeeds. Any other answer (a 403
  saying something else, an unreadable answer, a 404, a 5xx) is never taken as
  a refusal: it is tried again later.
- _No price of today is known yet_: the energy contract is not priced
  meanwhile.
- _Pstryk gave no complete prices for some past days_: some of the last 31
  days could not be filled. Today's and tomorrow's prices are not affected;
  the costs of the billing period of those days stay empty (asked again every
  6 hours).
- _Consumption not read_: the prices go on; the consumption is asked again 3
  hours later.

## Privacy

The API key is never written in a log, the status or `/data`. `/data` keeps
the times of the last reads, the pause, the hourly prices and a marker of a
refused key (8 bits of a salted hash, nothing to find the key back from). The
device id holds nothing of the key, the meter nor the customer.
