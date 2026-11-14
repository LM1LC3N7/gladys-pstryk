// -----------------------------------------------------------------------------
// Runtime texts, English and French: device and feature names, the status of
// the configuration screen, the answers of the test button.
// -----------------------------------------------------------------------------

const TEXTS = {
  device: { en: 'Pstryk electricity', fr: 'Pstryk électricité' },
  featurePrice: { en: 'Price per kWh now (PLN)', fr: 'Prix du kWh actuel (PLN)' },
  featureNextPrice: { en: 'Next price per kWh (PLN)', fr: 'Prochain prix du kWh (PLN)' },
  featureSellPrice: {
    en: 'Sale price per kWh now (PLN, prosumer)',
    fr: 'Prix de vente du kWh actuel (PLN, prosommateur)',
  },
  featureConsumption: { en: 'Consumption (30 min)', fr: 'Consommation (30 min)' },

  // Status of the configuration screen.
  missing: {
    en: 'Enter the API key of your Pstryk account (created in the Pstryk app).',
    fr: 'Saisissez la clé d’API de votre compte Pstryk (créée dans l’application Pstryk).',
  },
  malformed: {
    en: 'The API key is not valid (spaces or control characters, too long): nothing sent.',
    fr: 'La clé d’API n’est pas valide (espaces ou caractères de contrôle, trop longue) : rien envoyé.',
  },
  configUnread: {
    en: 'The configuration could not be read from Gladys: tried again shortly.',
    fr: 'La configuration n’a pas pu être lue depuis Gladys : nouvel essai sous peu.',
  },
  refused: {
    en: 'Pstryk refused the API key (HTTP {code}): nothing is sent until you change it or the Test button succeeds.',
    fr: 'Pstryk a refusé la clé d’API (HTTP {code}) : rien n’est envoyé tant que vous ne la changez pas ou que le bouton Tester ne réussit pas.',
  },
  rateLimited: {
    en: 'Pstryk asked to slow down ({code}): no request until {time}.',
    fr: 'Pstryk a demandé de ralentir ({code}) : aucune requête avant {time}.',
  },
  server: {
    en: 'Pstryk is unavailable ({code}): no request until {time}.',
    fr: 'Pstryk est indisponible ({code}) : aucune requête avant {time}.',
  },
  starting: {
    en: 'Starting: first read at {time}.',
    fr: 'Démarrage : première lecture à {time}.',
  },
  failing: {
    en: 'Pstryk not read ({code}): next try at {time}.',
    fr: 'Pstryk non lu ({code}) : prochain essai à {time}.',
  },
  connected: {
    en: 'Connected: prices read at {time}.',
    fr: 'Connecté : prix lus à {time}.',
  },
  noPrices: {
    en: ' No price of today is known yet: the energy contract is not priced meanwhile.',
    fr: ' Aucun prix d’aujourd’hui n’est encore connu : le contrat d’énergie n’est pas tarifé en attendant.',
  },
  lastFailed: {
    en: ' Last read failed ({code}): next try at {time}.',
    fr: ' Dernière lecture en échec ({code}) : prochain essai à {time}.',
  },
  pastMissing: {
    en: ' Pstryk gave no complete prices for some past days: the energy costs of their billing period stay empty (asked again every 6 hours).',
    fr: ' Pstryk n’a pas donné de prix complets pour certains jours passés : les coûts d’énergie de leur période de facturation restent vides (redemandés toutes les 6 heures).',
  },
  consumptionFailed: {
    en: ' Consumption not read ({code}).',
    fr: ' Consommation non lue ({code}).',
  },
  storage: {
    en: ' /data cannot be read: nothing is kept across restarts until it can.',
    fr: ' /data illisible : rien n’est gardé d’un redémarrage à l’autre tant qu’il ne l’est pas.',
  },

  // Test button.
  testOk: {
    en: 'Connected to Pstryk: the API key works ({count} hourly price(s) read).',
    fr: 'Connecté à Pstryk : la clé d’API fonctionne ({count} prix horaire(s) lu(s)).',
  },
  testTooSoon: {
    en: 'Not sent: one test a minute at most.',
    fr: 'Rien envoyé : un test par minute au plus.',
  },
  testPaused: {
    en: 'Not sent: Pstryk asked to wait until {time}.',
    fr: 'Rien envoyé : Pstryk a demandé d’attendre jusqu’à {time}.',
  },
  testFailed: {
    en: 'Pstryk could not be read ({code}): nothing changed.',
    fr: 'Pstryk n’a pas pu être lu ({code}) : rien n’a changé.',
  },
};

/** A text in a language, with its {placeholders} filled. */
export function t(key, language = 'en', values = {}) {
  const entry = TEXTS[key];
  const text = entry?.[language] ?? entry?.en ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) =>
    name in values ? String(values[name]) : `{${name}}`,
  );
}

/** Both languages of a text: { en, fr }. */
export const both = (key, values) => ({ en: t(key, 'en', values), fr: t(key, 'fr', values) });

export const ALL_TEXTS = TEXTS;
