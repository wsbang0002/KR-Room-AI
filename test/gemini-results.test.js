import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../lib/gemini.js';
import {checkIntegrations} from '../lib/integrations.js';
import {FakeRedis} from '../test-support/fake-redis.js';

const env = {
  GEMINI_API_KEY: 'mock',
  ADMIN_API_KEY: 'mock-admin-key-with-at-least-24-chars',
  UPSTASH_REDIS_REST_URL: 'https://redis.invalid',
  UPSTASH_REDIS_REST_TOKEN: 'mock'
};
const req = {headers: {authorization: 'Bearer ' + env.ADMIN_API_KEY}};

function optionsFor(ai) {
  return {
    env, req,
    store: new FakeRedis(),
    fetcher: async () => Response.json({
      candidates: [{content: {parts: [{text: JSON.stringify(ai)}]}}]
    })
  };
}

test('an empty extraction falls back for both live and previously cached data', async () => {
  for (const ai of [{}, {weights: null, location: ' ', roomTypes: []}]) {
    const options = optionsFor(ai);
    const live = await analyze('원룸', options);
    assert.equal(live.parserReason, 'empty-conditions');
    options.store.reserve = async () => ({ai});
    const cached = await analyze('원룸', options);
    assert.equal(cached.parser, 'local');
    assert.equal(cached.parserReason, 'empty-conditions');
  }
  const free = await analyze('보증금 0', optionsFor({maxDeposit: 0}));
  assert.equal(free.parser, 'gemini');
});

test('a failed cache write still returns the live validated extraction', async () => {
  const options = optionsFor({maxRent: 40});
  let writes = 0;
  options.store.set = async () => { writes++; throw Error('Redis unavailable'); };
  const result = await analyze('월세 40만원', options);
  assert.equal(result.parser, 'gemini');
  assert.equal(result.ai.maxRent, 40);
  assert.equal(result.cacheStored, false);
  assert.equal(writes, 1);
});

test('a rejected reservation prevents both a generation request and failure-cache writes', async () => {
  const options = optionsFor({});
  const limit = Object.assign(Error('Limit'), {status: 429});
  options.store.reserve = async () => {throw limit;};
  let calls = 0;
  options.fetcher = options.store.set = async () => {calls++;};
  const result = await analyze('월세 40만원', options);
  assert.equal(result.parserReason, 'daily-rate-limit');
  assert.equal(calls, 0);
});

test('admin generation check verifies the model extracted the requested district and rent', async () => {
  for (const ai of [{maxRent: 40}, {location: '서울 관악구', maxRent: 50}, {location: '부산 금정구', maxRent: 40}]) {
    const options = optionsFor(ai);
    const result = await checkIntegrations({service: 'gemini'}, options);
    assert.equal(result.gemini.status, 'failed');
    assert.equal(result.gemini.reason, 'unexpected-conditions');
    options.store.reserve = async () => ({ai});
    const cached = await checkIntegrations({service: 'gemini'}, options);
    assert.equal(cached.gemini.reason, 'unexpected-conditions');
  }
  const valid = await checkIntegrations({service: 'gemini'}, optionsFor({location: '서울 관악구', maxRent: 40}));
  assert.equal(valid.gemini.status, 'verified');
  assert.equal(valid.gemini.parser, 'gemini');
});
