import test from 'node:test';
import assert from 'node:assert/strict';
import {handleSearch} from '../api/search.js';
import {checkIntegrations} from '../lib/integrations.js';
import {FakeRedis} from '../test-support/fake-redis.js';

test('search aborts Gemini at the search cap and returns local conditions, while the admin check can wait longer', async t => {
  const env = {
    ADMIN_API_KEY: 'mock-admin-key-for-local-tests',
    GEMINI_API_KEY: 'mock',
    UPSTASH_REDIS_REST_URL: 'https://redis.invalid',
    UPSTASH_REDIS_REST_TOKEN: 'mock',
    GEMINI_TIMEOUT_MS: '35000'
  };
  const req = {headers: {authorization: 'Bearer ' + env.ADMIN_API_KEY}};
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', ms => {
    deadlines.push(ms);
    return AbortSignal.abort(new DOMException('Deadline reached', 'TimeoutError'));
  });
  const fetcher = async (url, {signal}) => {
    assert.ok(url.endsWith(':generateContent'));
    signal.throwIfAborted();
    assert.fail('Expected an aborted generation request');
  };
  const options = {req, env, store: new FakeRedis(), fetcher};
  const result = await handleSearch({query: '강원 원주시 원룸 월세 60만원 이하'}, options);
  assert.equal(result.status, 200);
  assert.equal(result.data.parser, 'local');
  assert.equal(result.data.parserReason, 'upstream-timeout');
  assert.equal(result.data.conditions.location, '강원특별자치도 원주시');
  assert.equal(result.data.conditions.maxRent, 60);
  assert.deepEqual(deadlines, [5000]);

  const check = await checkIntegrations({service: 'gemini'}, options);
  assert.equal(check.gemini.reason, 'upstream-timeout');
  assert.deepEqual(deadlines, [5000, 35000]);
});
