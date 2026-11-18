import test from 'node:test';
import assert from 'node:assert/strict';
import {normalize} from '../lib/core.js';

test('the Actor accuracy flag takes precedence over a conflicting legacy flag', () => {
  assert.equal(normalize({location_is_approximate: true, approximate: false}).approximate, true);
  assert.equal(normalize({location_is_approximate: false, approximate: true}).approximate, false);
  for (const unknown of [null, 'false', 0]) {
    assert.equal(normalize({location_is_approximate: unknown, approximate: false}).approximate, true);
  }
  assert.equal(normalize({}).approximate, true);
});

test('normalizing legacy or Actor coordinate data twice preserves its coordinates and accuracy', () => {
  const records = [
    {lat: 37.5, lng: 127.1, approximate: false},
    {latitude: '37.5', longitude: '127.1', location_is_approximate: true}
  ];
  for (const [index,record] of records.entries()) {
    const normalized = normalize(record);
    assert.equal(normalized.lat, 37.5);
    assert.equal(normalized.lng, 127.1);
    assert.equal(normalized.approximate, index === 1);
    assert.deepEqual(normalize(normalized), normalized);
  }
});

test('coordinates reject invalid types, nonfinite values and out-of-range axes', () => {
  for (const input of [true, false, ' ', [], [37.5], {}, 'NaN', '0x25', Infinity, null]) {
    const result = normalize({latitude: input, longitude: input});
    assert.equal(result.lat, null);
    assert.equal(result.lng, null);
  }
  assert.equal(normalize({latitude: 90.1}).lat, null);
  assert.equal(normalize({longitude: -180.1}).lng, null);
});
