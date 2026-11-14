// -----------------------------------------------------------------------------
// The Gladys device (pure). Read-only features only: nothing is commanded.
//
// External ids (forever):
//   ext:<selector>:meter:pstryk   the Pstryk electricity supply of the account
//                                 the API key belongs to (one per integration:
//                                 the key reads one account). Nothing of the
//                                 key, the meter or the customer is in it.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { MAX_PRICE } from './constants.js';
import { t } from './i18n.js';

export const DEVICE_KEY = 'pstryk';
export const FEATURE = Object.freeze({
  PRICE: 'price',
  NEXT_PRICE: 'next_price',
  SELL_PRICE: 'sell_price',
  CONSUMPTION: 'consumption',
});

export const idsOf = (gladys) => gladys.externalIds('meter', DEVICE_KEY);

const sensor = (ids, key, name, category, type, extra = {}) => ({
  name,
  external_id: ids.feature(key),
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max: 1,
  ...extra,
});

// Gladys has no złoty unit: the price features carry no unit, their name says it.
const money = (ids, key, name) =>
  sensor(ids, key, name, C.CURRENCY, T.CURRENCY.DECIMAL, { min: -MAX_PRICE, max: MAX_PRICE });

/** The device of the account. */
export function buildDevice(gladys, language = 'en') {
  const ids = idsOf(gladys);
  return {
    name: t('device', language),
    external_id: ids.device,
    features: [
      money(ids, FEATURE.PRICE, t('featurePrice', language)),
      money(ids, FEATURE.NEXT_PRICE, t('featureNextPrice', language)),
      money(ids, FEATURE.SELL_PRICE, t('featureSellPrice', language)),
      sensor(
        ids,
        FEATURE.CONSUMPTION,
        t('featureConsumption', language),
        C.ENERGY_SENSOR,
        T.ENERGY_SENSOR.THIRTY_MINUTES_CONSUMPTION,
        { unit: U.KILOWATT_HOUR, max: 500 },
      ),
    ],
    params: [],
  };
}

const round = (v) => Math.round(v * 1e6) / 1e6;

/** The price states; a value unknown is left out (never 0). */
export function priceStates(ids, { price, nextPrice, sellPrice }) {
  const out = [];
  const add = (key, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out.push({ device_feature_external_id: ids.feature(key), state: round(value) });
    }
  };
  add(FEATURE.PRICE, price);
  add(FEATURE.NEXT_PRICE, nextPrice);
  add(FEATURE.SELL_PRICE, sellPrice);
  return out;
}
