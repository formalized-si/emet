import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspectPatchEvidence, inspectPatchResponse } from './patch-evidence.mjs';
const read = (p) => JSON.parse(fs.readFileSync(new URL('../../' + p, import.meta.url)));
const fixture = () => [
  read('evidence/refund/replay.json'),
  read('evidence/refund/upgrade.json'),
  read('cases/intents-refund/candidates.json'),
];
test('live responses bind their verdict to the selected source and statement', () => {
  const candidates = fixture()[2].candidates;
  for (const c of candidates) {
    const r = {
      candidate: c.label,
      source_sha256: c.source_sha256,
      claim: c.proved,
      decision: c.proved === c.claim ? 'proved' : 'refuted',
      result: { ok: true, theorem: c.proved },
    };
    assert.equal(inspectPatchResponse(r, c), r);
    for (const changed of [
      { candidate: 'other' },
      { source_sha256: '0'.repeat(64) },
      { claim: 'True' },
      { decision: 'unverified' },
      { result: { ok: true, theorem: 'True' } },
    ]) {
      assert.throws(() => inspectPatchResponse({ ...r, ...changed }, c));
    }
  }
});
test('the recorded external-contract case has matching amounts, proof, build and target', () => {
  const d = inspectPatchEvidence(...fixture());
  assert.equal(d.badGap, '80');
  assert.equal(d.goodGap, '0');
});
test('changing the installed binary invalidates the story', () => {
  const args = fixture();
  args[1].after_wasm_sha256 = 'a'.repeat(64);
  assert.throws(() => inspectPatchEvidence(...args));
});
test('a refutation cannot masquerade as an upgrade certificate', () => {
  const args = fixture();
  args[1].repair_bounty.certificate.side = 'refutation';
  assert.throws(() => inspectPatchEvidence(...args));
});
test('switching target accounts invalidates the before/after comparison', () => {
  const args = fixture();
  args[1].transactions.find((t) => t.label === 'same refund after upgrade').target = 'other.near';
  assert.throws(() => inspectPatchEvidence(...args));
});
test('a hidden backing deficit is rejected', () => {
  const args = fixture();
  args[0].backed_runs.find((t) => t.version === 'fixed').after.credit = '99999999999999999999999999999999999999';
  assert.throws(() => inspectPatchEvidence(...args));
});
test('a pre-proof upgrade success invalidates the report', () => {
  const args = fixture();
  args[1].transactions.find((t) => t.label === 'try upgrade without proof').result.status.SuccessValue = btoa('true');
  assert.throws(() => inspectPatchEvidence(...args));
});
test('the token replay must use the same repaired binary', () => {
  const args = fixture();
  args[0].artifacts['fixed.wasm'] = 'f'.repeat(64);
  assert.throws(() => inspectPatchEvidence(...args));
});
test('the gate must bind the exact claim and bounty', () => {
  for (const [key, value] of [
    ['claim', 'Unrelated.Correct'],
    ['bounty_id', '99'],
  ]) {
    const args = fixture();
    args[1].gate.candidates.find((c) => c.id === 'repair')[key] = value;
    assert.throws(() => inspectPatchEvidence(...args));
  }
});
test('the gate must target the upgraded account', () => {
  const args = fixture();
  args[1].gate.target = 'other.near';
  assert.throws(() => inspectPatchEvidence(...args));
});
test('unfinalized code is not shown as the installed result', () => {
  const args = fixture();
  args[1].finality.observed_final_height = 0;
  assert.throws(() => inspectPatchEvidence(...args));
});
// The live record: a local rehearsal of deploy/live-refund.cjs when one exists, otherwise the committed testnet record.
import { inspectLiveRecord } from './patch-evidence.mjs';
const liveFile = ['deploy/testnet.json', 'run-output/live-refund-sandbox.json'].find((p) =>
  fs.existsSync(new URL('../../' + p, import.meta.url)),
);
test('the live record tells the same story with matching certificates, binaries and order', { skip: !liveFile }, () => {
  const live = () => read(liveFile),
    catalog = fixture()[2];
  const d = inspectLiveRecord(live(), catalog);
  assert.equal(d.story.old_refund.value[0], '100');
  assert.equal(d.story.new_refund.value[0], '1');
  const broken = [
    (r) => {
      r.story.proof_paid.certificate.side = 'refutation';
    },
    (r) => {
      r.story.upgrade_refused.value = true;
    },
    (r) => {
      r.code_sha256.intents_after = 'a'.repeat(64);
    },
    (r) => {
      r.access_keys[r.accounts.intents] = 1;
    },
    (r) => {
      r.story.old_batch.unbacked_added = '0';
    },
    (r) => {
      r.story.new_refund.receiver = 'other.testnet';
    },
    (r) => {
      r.story.proof_paid.certificate.axioms = ['sorryAx'];
    },
    (r) => {
      const t = r.transactions,
        i = t.findIndex((x) => x.hash === r.story.upgrade_applied.hash),
        j = t.findIndex((x) => x.hash === r.story.proof_paid.hash);
      [t[i], t[j]] = [t[j], t[i]];
    },
    (r) => {
      r.story.new_batch.after.credit = String(BigInt(r.story.new_batch.after.credit) + 1n);
    },
    (r) => {
      r.roles.roles.Upgrader.grantees.push('someone.testnet');
    },
    (r) => {
      r.story.old_batch.after.sender = '0';
    },
    (r) => {
      r.story.deposit_while_paused.ok = true;
    },
    (r) => {
      delete r.kernel_bounty;
    },
  ];
  for (const change of broken) {
    const r = live();
    change(r);
    assert.throws(() => inspectLiveRecord(r, catalog));
  }
});
