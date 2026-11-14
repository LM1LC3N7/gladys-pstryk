// -----------------------------------------------------------------------------
// The configuration of the form, normalized: the API key the customer created
// in the Pstryk app. Nothing here talks to the network.
// -----------------------------------------------------------------------------

/** Printable ASCII without space: never a control character (CR, LF, tab) in a key. */
const KEY_TEXT = /^[\x21-\x7e]+$/;

/**
 * `{ apiKey, problem }`: `problem` names what keeps the integration from
 * reading (nothing is sent then).
 */
export function normalizeConfig(raw = {}) {
  const value = raw?.api_key;
  const config = { apiKey: '', problem: undefined };
  if (value === undefined || value === null) {
    config.problem = 'missing';
    return config;
  }
  if (typeof value !== 'string') {
    config.problem = 'malformed';
    return config;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    config.problem = 'missing';
  } else if (trimmed.length > 200 || !KEY_TEXT.test(trimmed)) {
    config.problem = 'malformed';
  } else {
    config.apiKey = trimmed;
  }
  return config;
}
