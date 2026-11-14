import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRun, maxRollingSpend } from './evidence.mjs';

const recorded = JSON.parse(readFileSync(new URL('../../evidence/demo/scenario.json', import.meta.url)));
const copy = () => structuredClone(recorded);

test('the shipped record supports the displayed bypass and repair', () => {
  assert.equal(validateRun(recorded), recorded);
  assert.equal(maxRollingSpend(recorded.bypass.payments, recorded.wallet.policy_near.day_seconds), 11);
  assert.equal(maxRollingSpend(recorded.fix.payments, recorded.wallet.policy_near.day_seconds), 6);
});
test('a summary cannot hide a failed check', () => {
  const d = copy();
  d.claims[0].pass = false;
  assert.throws(() => validateRun(d), /summary/);
});
test('a claimed total must follow from the payment records', () => {
  const d = copy();
  d.bypass.payments[0].amount_near++;
  assert.throws(() => validateRun(d), /total/);
});
test('a repaired wallet that accepts the boundary attack is not presented as repaired', () => {
  const d = copy();
  d.fix.payments.find((p) => p.verdict === 'denyDaily').verdict = 'allow';
  assert.throws(() => validateRun(d), /rolling spend/);
});
test('an unpaid proof is not presented as an earned bounty', () => {
  const d = copy();
  d.board_final.find((b) => b.certificate?.side === 'refutation').phase = 'Open';
  assert.throws(() => validateRun(d), /paid counterexample/);
});
test('a failed freeze is not presented as protection of the wallet', () => {
  const d = copy();
  d.freeze = { wallet_after: { frozen: false } };
  assert.throws(() => validateRun(d), /freeze/);
});
test('window calculation excludes exactly one day and includes one nanosecond less', () => {
  const rows = [
    { at_ns: '0', amount_near: 4, verdict: 'allow' },
    { at_ns: '1000000000', amount_near: 5, verdict: 'allow' },
  ];
  assert.equal(maxRollingSpend(rows, 1), 5);
  rows[1].at_ns = '999999999';
  assert.equal(maxRollingSpend(rows, 1), 9);
});
