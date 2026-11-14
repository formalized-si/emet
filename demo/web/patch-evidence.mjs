// Readers of the recorded evidence for the page (patches.js): each returns what the page shows, or throws when a
// record does not tell the story the page would tell. patch-evidence.test.mjs holds their tests.
const need = (value, message) => {
  if (!value) throw Error(message);
};
const hex = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
export function inspectPatchResponse(response, candidate) {
  need(
    response.candidate === candidate.label &&
      response.source_sha256 === candidate.source_sha256 &&
      response.claim === candidate.proved,
    'The response belongs to another candidate.',
  );
  const verdict = response.result;
  const decision = verdict?.ok === true ? (candidate.proved === candidate.claim ? 'proved' : 'refuted') : 'unverified';
  need(response.decision === decision, 'The decision disagrees with the kernel result.');
  if (verdict?.ok === true) need(verdict.theorem === candidate.proved, 'The kernel checked another statement.');
  return response;
}
export function inspectPatchEvidence(replay, upgrade, catalog) {
  need(replay.ok === true && upgrade.ok === true, 'The transaction run did not complete.');
  need(replay.checks?.length > 0 && replay.checks.every((c) => c.ok === true), 'Refund checks failed.');
  need(upgrade.checks?.length > 0 && upgrade.checks.every((c) => c.ok === true), 'Upgrade checks failed.');
  const tx = (label) => {
    const t = upgrade.transactions.find((t) => t.label === label);
    need(t, 'Missing transaction: ' + label);
    return t;
  };
  const returned = (label) => {
    const s = tx(label).result.status.SuccessValue;
    need(typeof s === 'string', 'Transaction failed: ' + label);
    return JSON.parse(atob(s));
  };
  need(returned('try upgrade without proof') === false, 'The gate did not refuse an upgrade without a proof.');
  need(returned('try installing refuted source') === false, 'A refutation authorized installation.');
  need(
    JSON.stringify(tx('try another binary chunk').result).includes('chunk_mismatch'),
    'The gate did not reject the changed binary chunk.',
  );
  need(returned('install the proved patch') === true, 'The recorded installation failed.');
  need(
    tx('old contract refund').target === upgrade.accounts.target &&
      tx('same refund after upgrade').target === upgrade.accounts.target,
    'The before and after use different contracts.',
  );
  need(
    returned('old contract refund')[0] === '100' && returned('same refund after upgrade')[0] === '1',
    'The upgraded contract did not change its refund behavior.',
  );
  const old = replay.runs.find((r) => r.version === 'old' && r.name === 'single');
  const fixed = replay.runs.find((r) => r.version === 'fixed' && r.name === 'single');
  need(
    old && fixed && old.refunded?.length === 1 && fixed.refunded?.length === 1,
    'The comparable refunds are missing.',
  );
  need(
    BigInt(old.refunded[0]) > BigInt(old.deposit_each) && fixed.refunded[0] === fixed.deposit_each,
    'Refund amounts disagree with the story.',
  );
  const bad = replay.backed_runs.find((r) => r.version === 'old'),
    good = replay.backed_runs.find((r) => r.version === 'fixed');
  need(bad && good, 'Backed-transfer comparison is missing.');
  const badGap = BigInt(bad.after.credit) - BigInt(bad.after.backing),
    goodGap = BigInt(good.after.credit) - BigInt(good.after.backing);
  need(
    badGap > 0n && goodGap === 0n && String(badGap) === bad.unbacked_credit && String(goodGap) === good.unbacked_credit,
    'Credit and backing disagree.',
  );
  const source = catalog.candidates.find((c) => c.label === 'repair');
  const built = upgrade.build.candidates.find((c) => c.label === 'repair');
  const oldBuild = upgrade.build.candidates.find((c) => c.label === 'original');
  const registered = upgrade.gate?.candidates.find((c) => c.id === 'repair');
  const cert = upgrade.repair_bounty?.certificate;
  need(source && built && registered && cert, 'Source, build or certificate is missing.');
  need(
    oldBuild &&
      replay.artifacts['old.wasm'] === oldBuild.wasm_sha256 &&
      replay.artifacts['fixed.wasm'] === built.wasm_sha256,
    'The transfer replay uses different binaries.',
  );
  need(
    hex(source.source_sha256) && source.claim.includes(source.source_sha256),
    'The claim does not carry a source digest.',
  );
  need(
    source.source_sha256 === built.source_sha256 && source.source_sha256 === registered.source_sha256,
    'Source digest differs across the records.',
  );
  need(
    registered.claim === source.claim && registered.bounty_id === upgrade.repair_bounty.id,
    'The gate registers another claim or bounty.',
  );
  need(
    hex(built.wasm_sha256) &&
      built.wasm_sha256 === registered.wasm_sha256 &&
      built.wasm_sha256 === upgrade.after_wasm_sha256,
    'Installed binary is not the registered build.',
  );
  need(upgrade.before_wasm_sha256 !== upgrade.after_wasm_sha256, 'The contract code did not change.');
  need(upgrade.before_wasm_sha256 === oldBuild.wasm_sha256, 'The upgrade starts from another binary.');
  need(
    cert.side === 'proof' && cert.proved === source.claim && cert.base_hash === upgrade.base_sha256,
    'Certificate does not prove this candidate.',
  );
  need(
    upgrade.repair_bounty.phase === 'Paid' && upgrade.repair_bounty.winner === upgrade.accounts.prover,
    'Prover payment is missing.',
  );
  need(upgrade.gate.phase === 'Applied' && upgrade.gate.candidate === 'repair', 'The gate did not apply the repair.');
  need(
    upgrade.gate.target === upgrade.accounts.target &&
      upgrade.gate.board === upgrade.accounts.board &&
      upgrade.gate.base_hash === upgrade.base_sha256,
    'The gate targets another account, board or environment.',
  );
  need(
    Number.isSafeInteger(upgrade.finality?.executed_height) &&
      upgrade.finality.executed_height > 0 &&
      Number.isSafeInteger(upgrade.finality.observed_final_height) &&
      upgrade.finality.observed_final_height >= upgrade.finality.executed_height,
    'The record does not show the upgrade as final.',
  );
  need(upgrade.balances.before_upgrade === upgrade.balances.after_upgrade, 'Upgrade changed the recorded balance.');
  const keys = upgrade.access_keys;
  need(
    keys &&
      [upgrade.accounts.target, upgrade.accounts.gate, upgrade.accounts.board, upgrade.accounts.kernel].every(
        (a) => Array.isArray(keys[a]) && keys[a].length === 0,
      ),
    'A control account still has an access key.',
  );
  return {
    deposit: old.deposit_each,
    oldRefund: old.refunded[0],
    fixedRefund: fixed.refunded[0],
    badGap: String(badGap),
    goodGap: String(goodGap),
    source,
    built,
    cert,
    upgrade,
  };
}
// A record written by deploy/live-refund.cjs (testnet, or a local rehearsal): the same story as real transactions.
const STORY = [
  'old_refund',
  'old_batch',
  'paused',
  'deposit_while_paused',
  'upgrade_refused',
  'binary_refused',
  'refutation_paid',
  'proof_paid',
  'upgrade_applied',
  'unpaused',
  'new_refund',
  'new_batch',
];
export function inspectLiveRecord(record, catalog) {
  need(record?.schema === 'emet-live-refund/1' && record.ok === true, 'The live deployment did not complete.');
  need(record.checks?.length > 0 && record.checks.every((c) => c.ok === true), 'A live check failed.');
  const s = record.story || {},
    a = record.accounts || {};
  for (const k of STORY)
    need(s[k] && typeof s[k].hash === 'string' && s[k].hash.length > 20, 'Missing live transaction: ' + k);
  need(
    s.old_refund.ok && s.old_refund.value?.[0] === '100' && s.new_refund.ok && s.new_refund.value?.[0] === '1',
    'The live refunds disagree with the story.',
  );
  need(
    s.old_refund.receiver === a.intents && s.new_refund.receiver === a.intents,
    'The before and after use different contracts.',
  );
  // The batch goes through the token ledger. Old code: the callback fails on the log limit, the tokens return
  // to the sender and the credit stays. Repaired code: nothing is left over.
  const gap = (p) => BigInt(p.credit) - BigInt(p.backing);
  for (const k of ['old_batch', 'new_batch']) {
    need(s[k].receiver === a.ledger && s[k].before && s[k].after, 'The batch did not go through the token ledger.');
    need(
      String(gap(s[k].after) - gap(s[k].before)) === s[k].unbacked_added,
      'Credit and backing disagree with the recorded gap.',
    );
    need(
      s[k].after.sender === s[k].before.sender && s[k].after.backing === s[k].before.backing,
      'Tokens did not return to the sender.',
    );
  }
  need(
    s.old_batch.ok === false &&
      s.old_batch.unbacked_added === '80' &&
      /exceeds the limit/.test(JSON.stringify(s.old_batch.failures)),
    'The old batch did not fail on the log limit with 80 credits left.',
  );
  need(s.new_batch.ok === true && s.new_batch.unbacked_added === '0', 'The repaired batch left unbacked credit.');
  need(
    s.paused.ok &&
      s.paused.signer === a.guardian &&
      s.deposit_while_paused.ok === false &&
      s.unpaused.ok &&
      s.unpaused.signer === a.guardian,
    'The pause did not stop deposits.',
  );
  need(
    s.upgrade_refused.ok && s.upgrade_refused.value === false && s.upgrade_refused.receiver === a.gate,
    'The gate did not refuse an upgrade without a proof.',
  );
  need(
    s.binary_refused.ok === false && JSON.stringify(s.binary_refused.failures).includes('chunk_mismatch'),
    'The gate did not refuse the changed binary.',
  );
  const repair = catalog.candidates.find((c) => c.label === 'repair'),
    original = catalog.candidates.find((c) => c.label === 'original'),
    live = record.candidates?.repair;
  need(repair && original && live, 'The candidates are missing.');
  need(
    s.refutation_paid.ok &&
      s.refutation_paid.certificate?.side === 'refutation' &&
      s.refutation_paid.certificate.proved === original.counter_claim,
    'The refutation certificate is for another claim.',
  );
  need(
    s.proof_paid.ok &&
      s.proof_paid.certificate?.side === 'proof' &&
      s.proof_paid.certificate.proved === repair.claim &&
      s.proof_paid.certificate.base_hash === record.base_sha256,
    'The proof certificate is for another claim.',
  );
  need(
    s.proof_paid.certificate.delta_sha256 === s.proof_paid.proof_sha256 &&
      Array.isArray(s.proof_paid.certificate.axioms) &&
      s.proof_paid.certificate.axioms.length === 0,
    'The certificate is for other proof bytes, or uses axioms.',
  );
  need(
    s.upgrade_applied.ok && s.upgrade_applied.value === true && s.upgrade_applied.receiver === a.gate,
    'The gate did not apply the upgrade.',
  );
  need(
    live.source_sha256 === repair.source_sha256 &&
      live.claim === repair.claim &&
      hex(live.wasm_sha256) &&
      live.wasm_sha256 === record.code_sha256?.intents_after,
    'The installed binary is not the registered repair.',
  );
  need(record.code_sha256.intents_before !== record.code_sha256.intents_after, 'The contract code did not change.');
  need(record.gate?.phase === 'Applied' && record.gate.candidate === 'repair', 'The gate did not apply the repair.');
  need(record.balance_before_upgrade === record.balance_after_upgrade, 'The upgrade changed a balance.');
  const keys = record.access_keys || {};
  need(
    [a.kernel, a.board, a.gate, a.intents].every((x) => keys[x] === 0),
    'A control account still has an access key.',
  );
  const roles = record.roles?.roles || {},
    grantees = (r) => JSON.stringify(roles[r]?.grantees || []);
  need(
    grantees('Upgrader') === JSON.stringify([a.gate]) &&
      grantees('PauseManager') === JSON.stringify([a.guardian]) &&
      (record.roles?.super_admins || []).length === 0,
    'Someone other than the gate can upgrade.',
  );
  need(
    record.kernel_bounty?.id && Number(record.kernel_bounty.reward_near) > 0,
    'The bounty on the kernel is missing.',
  );
  const order = STORY.map((k) => record.transactions.findIndex((t) => t.hash === s[k].hash));
  need(
    order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])),
    'The live transactions are not in the order of the story.',
  );
  const open = record.open_bounties || [];
  for (const b of open) {
    const c = catalog.candidates.find((x) => x.label === b.label);
    need(
      c &&
        b.claim === c.claim &&
        b.counter_claim === c.counter_claim &&
        b.settles_with === c.proved &&
        b.expression === c.expression &&
        Number(b.reward_near) > 0 &&
        /^\d+$/.test(b.id),
      'An open bounty is not about a patch of this catalog.',
    );
  }
  return {
    story: s,
    accounts: a,
    repair: live,
    network: record.network,
    explorer: record.explorer || null,
    rpc: record.rpc || null,
    declarations: record.base_declarations,
    open,
    kernelBounty: record.kernel_bounty,
  };
}
