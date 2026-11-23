import test from 'node:test';
import assert from 'node:assert/strict';
import {handleSearch} from '../api/search.js';
import {checkIntegrations} from '../lib/integrations.js';
import {readFileSync} from 'node:fs';
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
    assert.ok(url.endsWith('/gemini-3.6-flash:generateContent'));
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
  assert.deepEqual(deadlines, [15000]);

  const check = await checkIntegrations({service: 'gemini'}, options);
  assert.equal(check.gemini.reason, 'upstream-timeout');
  assert.deepEqual(deadlines, [15000, 35000]);
});

test('signed-in search accepts a Gemini response after the previous five-second deadline', async () => {
  const {handleConditions} = await import('../api/conditions.js');
  const {issueSearchSession} = await import('../lib/search-session.js');
  const deployment = JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
  const env = {
    ...deployment.env,
    ADMIN_API_KEY: 'mock-admin-key-for-local-tests-only',
    GEMINI_API_KEY: 'mock', GEMINI_MODEL: 'gemini-3.8-flash', AI_PROVIDER: 'gemini'
  };
  const session = issueSearchSession(env);
  const req = {headers: {cookie: session.cookie.split(';')[0]}};
  let calls = 0;
  const store = new FakeRedis();
  const fetcher = async (url, {signal}) => {
    calls++;
    assert.ok(url.endsWith('/gemini-3.6-flash:generateContent'));
    await new Promise(resolve => setTimeout(resolve, 5100));
    signal.throwIfAborted();
    return Response.json({candidates: [{finishReason:'STOP', content: {parts: [
      {text:'{"location":"원주시 무실동","maxMonthlyTotal":45}'}
    ]}}]});
  };
  const body = {query:'원주시 무실동 원룸 관리비 포함 월 45만원'};
  for (let i = 0; i < 2; i++) {
    const result = await handleConditions(body,{env,req,store,fetcher});
    assert.equal(result.interpretation.mode,'ai');
    assert.equal(result.conditions.maxMonthlyTotal,45);
  }
  assert.equal(calls,1);
});
