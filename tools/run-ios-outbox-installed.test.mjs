// MIT. Receipt rejection tests do not boot or inspect simulators.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expected, validate } from './run-ios-outbox-installed.mjs';
const receipt = () => ({ nonce: 'fresh', mode: 'seed', status: 'passed', storage: 'durable', outcomes: [...expected] });
test('all 64 cells and persistence receipt are mandatory', () => {
  validate(receipt(), 'seed', 'fresh');
  for (let cell = 0; cell < 64; cell++) {
    const changed = receipt(); changed.outcomes[cell] = (changed.outcomes[cell] + 1) % 3;
    assert.throws(() => validate(changed, 'seed', 'fresh'));
  }
  const partial = receipt(); partial.outcomes.pop();
  assert.throws(() => validate(partial, 'seed', 'fresh'));
  assert.throws(() => validate(receipt(), 'seed', 'stale'));
  assert.throws(() => validate({ ...receipt(), storage: 'empty' }, 'seed', 'fresh'));
  assert.throws(() => validate({ ...receipt(), status: 'failed' }, 'seed', 'fresh'));
});
test('absence and blocking cannot count as native acceptance', () => {
  for (const mode of ['absent', 'blocked']) {
    validate({ nonce: 'fresh', mode, status: 'refused', faultInjection: true }, mode, 'fresh');
    assert.throws(() => validate({ ...receipt(), mode }, mode, 'fresh'));
    assert.throws(() => validate({ nonce: 'fresh', mode, status: 'refused' }, mode, 'fresh'));
  }
});
