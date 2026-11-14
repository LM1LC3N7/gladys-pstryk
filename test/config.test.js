import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';

test('config: the key needed; control characters, spaces inside, too long refused', () => {
  assert.equal(normalizeConfig({}).problem, 'missing');
  assert.equal(normalizeConfig({ api_key: '   ' }).problem, 'missing');
  assert.equal(normalizeConfig({ api_key: null }).problem, 'missing');
  assert.equal(normalizeConfig({ api_key: 42 }).problem, 'malformed');
  assert.equal(normalizeConfig({ api_key: 'sk-ab\ncd' }).problem, 'malformed');
  assert.equal(normalizeConfig({ api_key: 'sk-ab\rcd' }).problem, 'malformed');
  assert.equal(normalizeConfig({ api_key: 'sk-ab cd' }).problem, 'malformed');
  assert.equal(normalizeConfig({ api_key: 'sk-é' }).problem, 'malformed');
  assert.equal(normalizeConfig({ api_key: 'x'.repeat(201) }).problem, 'malformed');
  assert.deepEqual(normalizeConfig({ api_key: ' sk-abc ' }), {
    apiKey: 'sk-abc',
    problem: undefined,
  });
});
