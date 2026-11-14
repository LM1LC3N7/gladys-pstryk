# Third-party notices

No third-party code is included or ported: the integration is written from
the official OpenAPI description of the Pstryk integration API
(https://api.pstryk.pl/integrations/swagger/, schema
`https://api.pstryk.pl/integrations/schema/`, read on 2026-11-14).

The shape of the price frames (`metrics.pricing.price_gross`,
`price_prosumer_gross`) and the hint that tomorrow's prices may come as
placeholders before they are published were learnt from reading ha_Pstryk
(https://github.com/balgerion/ha_Pstryk, MIT License, Copyright (c) 2024 Piotr
Machowski), used as an example only: none of its code is copied.

## Pstryk API

The data come from the Pstryk integration API (https://api.pstryk.pl), read
with the customer's own API key. This integration is not affiliated with
Pstryk. "Pstryk" is a name of its owner, used only to say which service the
integration reads.
