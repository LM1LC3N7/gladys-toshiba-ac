// -----------------------------------------------------------------------------
// The states sent within the Gladys rate limit.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatePublisher } from '../src/publisher.js';

function fakeGladys() {
  const calls = [];
  return {
    calls,
    fail: false,
    async publishChangedStates(states, options) {
      if (this.fail) {
        throw new Error('429');
      }
      calls.push({ states, options });
      return { success: true, count: states.length };
    },
  };
}

test('the last value of each feature, within the per-minute budget', async () => {
  const gladys = fakeGladys();
  let now = 0;
  const publisher = new StatePublisher({ gladys, now: () => now, budget: 3 });
  publisher.push('a', { state: 1 });
  publisher.push('a', { state: 2 });
  publisher.push('b', { text: 'eco' });
  publisher.push('c', { state: 3 });
  publisher.push('d', { state: 4 });
  assert.equal(await publisher.flush(), 3);
  assert.deepEqual(gladys.calls[0].states, [
    { device_feature_external_id: 'a', state: 2 },
    { device_feature_external_id: 'b', text: 'eco' },
    { device_feature_external_id: 'c', state: 3 },
  ]);
  assert.equal(gladys.calls[0].options.heartbeat, 30 * 60_000);
  assert.equal(await publisher.flush(), 0, 'the budget of the minute is spent');
  now = 60_001;
  assert.equal(await publisher.flush(), 1);
  assert.deepEqual(gladys.calls[1].states, [{ device_feature_external_id: 'd', state: 4 }]);
});

test('a failed send keeps the values, unless a newer one arrived', async () => {
  const gladys = fakeGladys();
  const publisher = new StatePublisher({ gladys });
  publisher.push('a', { state: 1 });
  publisher.push('b', { state: 1 });
  gladys.fail = true;
  const failing = publisher.flush();
  publisher.push('b', { state: 2 });
  await assert.rejects(failing, /429/);
  gladys.fail = false;
  await publisher.flush();
  assert.deepEqual(gladys.calls[0].states, [
    { device_feature_external_id: 'b', state: 2 },
    { device_feature_external_id: 'a', state: 1 },
  ]);
});

test('forgetting a device drops its pending values', async () => {
  const gladys = fakeGladys();
  const publisher = new StatePublisher({ gladys });
  publisher.push('ext:t:ac:x:mode', { state: 1 });
  publisher.push('ext:t:ac:xy:mode', { state: 1 });
  publisher.forget('ext:t:ac:x');
  await publisher.flush();
  assert.deepEqual(
    gladys.calls[0].states.map((s) => s.device_feature_external_id),
    ['ext:t:ac:xy:mode'],
  );
});

test('the flush runs every second once started', () => {
  const intervals = [];
  const timers = {
    setInterval: (fn, ms) => intervals.push(ms) && 7,
    clearInterval: (id) => intervals.push(`clear ${id}`),
  };
  const publisher = new StatePublisher({ gladys: fakeGladys(), timers });
  publisher.start();
  publisher.stop();
  assert.deepEqual(intervals, [1000, 'clear 7']);
});
