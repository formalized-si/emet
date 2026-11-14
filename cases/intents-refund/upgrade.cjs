// A source-bound proof bounty authorizes an actual upstream NEAR Intents upgrade.
// All accounts and transactions exist only on a fresh local sandbox.
// Run by ./verify.sh --refund and by propose.py; by hand: node cases/intents-refund/upgrade.cjs [out.json]
// (default run-output/refund/upgrade.json; EMET_PATCH_CANDIDATE picks a candidate other than the repair).
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
process.env.NEAR_SANDBOX_BIN_PATH ||= path.join(ROOT, '.sandbox/2.14.0/near-sandbox');
process.env.NEAR_SANDBOX_BINARY_PATH ||= path.join(ROOT, '.sandbox/2.14.0');
const localNode = require('../../tools/local-node.cjs');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const read = (p) => fs.readFileSync(path.join(ROOT, p));
const GAS = '1000000000000000',
  N = 10n ** 24n,
  near = (n) => String(BigInt(n) * N);
const OUT = path.resolve(ROOT, process.argv[2] || 'run-output/refund/upgrade.json');

async function main() {
  const candidates = JSON.parse(read('cases/intents-refund/candidates.json')).candidates;
  const build = JSON.parse(read('run-output/refund/build.json'));
  const selected = process.env.EMET_PATCH_CANDIDATE || 'repair';
  const selectedCandidate = candidates.find((c) => c.label === selected);
  if (!selectedCandidate) throw Error('Unknown patch candidate');
  const shelf = JSON.parse(read('cases/intents-refund/shelf/manifest.json'));
  const old = read('run-output/refund/old.wasm'),
    fixed = read(build.candidates.find((c) => c.label === selected).file);
  for (const label of ['original', selected]) {
    const c = candidates.find((c) => c.label === label),
      b = build.candidates.find((c) => c.label === label);
    assert.equal(c.source_sha256, b.source_sha256);
    assert.equal(c.claim, b.claim);
    assert.equal(sha(label === 'original' ? old : fixed), b.wasm_sha256);
  }
  const gateCode = read('contracts/patch-gate/target/near/emet_patch_gate.wasm');
  const record = {
    at: new Date().toISOString(),
    network: 'local sandbox',
    upstream_revision: build.revision,
    scope:
      'Exact refund expression; extractor, Rust compiler, Emet kernel and gate are trusted. This is not a proof of the entire Intents contract.',
    build,
    base_sha256: shelf.base_sha256,
    patch_gate_sha256: sha(gateCode),
    transactions: [],
    checks: [],
  };
  const save = () => {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(record, null, 2) + '\n');
  };
  const check = (name, ok, detail) => {
    record.checks.push({ name, ok: !!ok, detail });
    save();
    assert(ok, name);
    console.log('PASS', name);
  };
  const worker = await localNode('refund-upgrade');
  try {
    const owner = worker.rootAccount,
      provider = worker.provider;
    record.node = await provider.status();
    const make = async (name, funds = 100) => owner.createSubAccount(name, { initialBalance: near(funds) });
    // One signer creates these accounts: its transaction nonce is sequential.
    const accounts = [];
    for (const name of ['kernel', 'board', 'gate', 'target', 'receiver', 'prover', 'issuer'])
      accounts.push(await make(name));
    const [kernel, board, gate, target, receiver, prover, issuer] = accounts;
    record.accounts = {
      kernel: kernel.accountId,
      board: board.accountId,
      gate: gate.accountId,
      target: target.accountId,
      prover: prover.accountId,
    };
    const send = async (label, who, to, method, args, deposit = '0') => {
      const t = await who.callRaw(to, method, args, { gas: GAS, attachedDeposit: deposit });
      record.transactions.push({ label, method, actor: who.accountId, target: to.accountId, result: t.result });
      save();
      return t.result;
    };
    const keyless = async (account, wasm, method, args) => {
      const key = await account.getKey();
      const tx = await account
        .batch(account)
        .deployContract(wasm)
        .functionCall(method, args, { gas: '100000000000000' })
        .deleteKey(key.getPublicKey())
        .transact();
      if (tx.result.receipts_outcome.some((r) => r.outcome.status.Failure)) throw Error('keyless deployment failed');
    };
    await keyless(kernel, read('artifacts/kernel.wasm'), 'init', { owner: owner.accountId });
    for (const chunk of shelf.chunks)
      await send('upload environment', owner, kernel, 'load_base_chunk', read('cases/intents-refund/shelf/' + chunk));
    await send('seal environment', owner, kernel, 'seal_base', {
      expected_sha256: shelf.base_sha256,
      expected_decl_count: shelf.base_decls,
    });
    for (let from = 0; from < shelf.base_decls; from += 128)
      await send('check environment', owner, kernel, 'check_base_range', {
        from,
        to: Math.min(from + 128, shelf.base_decls),
      });
    check(
      'Kernel checked the entire pinned environment',
      (await kernel.view('status', {})).checked_upto === shelf.base_decls,
    );
    await keyless(board, read('artifacts/board.wasm'), 'new', {
      kernel: kernel.accountId,
      base_hash: shelf.base_sha256,
      factory: null,
      wallet_code_hash: null,
      claims: candidates.map((c) => ({ claim: c.claim, counter: c.counter_claim })),
      reveal_delay_blocks: '1',
      min_reveal_gas_tgas: '500',
      reveal_bond: String(N / 100n),
      grace_seconds: '3600',
      stale_blocks: '200',
    });
    const chosen = ['original', selected].map((label) => candidates.find((c) => c.label === label));
    const deadline = String(
      BigInt((await provider.block({ finality: 'final' })).header.timestamp_nanosec) + 3600n * 10n ** 9n,
    );
    for (const c of chosen)
      await send(
        'post ' + c.label,
        owner,
        board,
        'post_bounty',
        {
          claim: c.claim,
          counter_claim: c.counter_claim,
          title: 'Refund ' + c.label,
          deadline,
          subject: null,
          escrow: null,
        },
        String(N + N / 10n),
      );
    const parts = (code) => {
      const rows = [];
      for (let i = 0; i < code.length; i += 300000) rows.push(code.subarray(i, i + 300000));
      return rows;
    };
    const gateCandidates = chosen.map((c, i) => ({
      id: c.label,
      source_sha256: c.source_sha256,
      wasm_sha256: sha(i === 0 ? old : fixed),
      claim: c.claim,
      bounty_id: String(i),
      chunks: parts(i === 0 ? old : fixed).map((p) => ({ sha256: sha(p), bytes: p.length })),
    }));
    await keyless(gate, gateCode, 'new', {
      target: target.accountId,
      board: board.accountId,
      base_hash: shelf.base_sha256,
      candidates: gateCandidates,
    });
    await keyless(target, old, 'new', {
      config: {
        wnear_id: 'wrap.test.near',
        fees: { fee: 0, fee_collector: owner.accountId },
        roles: { grantees: { Upgrader: [gate.accountId] } },
      },
    });
    await receiver.deploy(read('run-output/refund/receiver.wasm'));
    for (const [id, code] of [
      ['original', old],
      [selected, fixed],
    ]) {
      for (const [index, data] of parts(code).entries())
        await send(
          'stage ' + id + ' chunk ' + index,
          prover,
          gate,
          'stage_code',
          { candidate_id: id, index, data: data.toString('base64') },
          String(BigInt(data.length + 256) * 10n ** 19n),
        );
    }
    const codeHash = async () =>
      sha(
        Buffer.from(
          (
            await provider.sendJsonRpc('query', {
              request_type: 'view_code',
              account_id: target.accountId,
              finality: 'final',
            })
          ).code_base64,
          'base64',
        ),
      );
    const balance = () =>
      target.view('mt_balance_of', { account_id: receiver.accountId, token_id: `nep245:${issuer.accountId}:asset` });
    const deposit = (amount, notify) => ({
      sender_id: issuer.accountId,
      previous_owner_ids: [issuer.accountId],
      token_ids: ['asset'],
      amounts: [amount],
      msg: notify
        ? JSON.stringify({
            receiver_id: receiver.accountId,
            msg: JSON.stringify({ ReturnValue: '100' }),
            min_gas: '5000000000000',
          })
        : receiver.accountId,
    });
    await send('pre-fund actual contract', issuer, target, 'mt_on_transfer', deposit('1000', false));
    const before = await send('old contract refund', issuer, target, 'mt_on_transfer', deposit('1', true));
    check(
      'Old upstream contract returns 100 from a deposit of 1',
      JSON.parse(Buffer.from(before.status.SuccessValue, 'base64').toString())[0] === '100',
    );
    const stateBefore = await balance();
    record.before_wasm_sha256 = await codeHash();
    record.balances = { before_upgrade: stateBefore };
    await send('try upgrade without proof', prover, gate, 'apply_patch', { candidate_id: selected });
    check(
      'No proof leaves the old artifact installed',
      (await gate.view('status', {})).phase === 'Open' && (await codeHash()) === sha(old),
    );
    const tampered = Buffer.from(parts(fixed)[0]);
    tampered[tampered.length - 1] ^= 1;
    const wrong = await send('try another binary chunk', prover, gate, 'stage_code', {
      candidate_id: selected,
      index: 0,
      data: tampered.toString('base64'),
    });
    check(
      'Different binary is refused before checking the certificate',
      JSON.stringify(wrong).includes('chunk_mismatch') && (await codeHash()) === sha(old),
    );
    async function settle(i, label, side) {
      const delta = read(`cases/intents-refund/proofs/${label}.ndjson`),
        salt = 'emet-local-refund-' + label;
      const commitment = sha(
        Buffer.from(`proof-courier/commit/v2\n${i}\n${prover.accountId}\n${side}\n${sha(delta)}\n${salt}`),
      );
      await send('commit ' + label, prover, board, 'commit', { id: String(i), hash: commitment }, String(N / 100n));
      await provider.fastForward(3);
      await send(
        'prove ' + label,
        prover,
        board,
        'reveal',
        Buffer.concat([Buffer.from(`${i}\n${side}\n${salt}\n`), delta]),
        String(N / 100n),
      );
      const b = await board.view('get_bounty', { id: String(i) });
      record[label + '_bounty'] = b;
      save();
      return b;
    }
    const rejected = await settle(0, 'original', 'refutation');
    check(
      'The known-bad source earns a refutation, not a safety certificate',
      rejected.certificate?.side === 'refutation' && rejected.phase === 'Paid',
    );
    await send('try installing refuted source', prover, gate, 'apply_patch', { candidate_id: 'original' });
    check(
      'A paid refutation cannot authorize installation',
      (await gate.view('status', {})).phase === 'Open' && (await codeHash()) === sha(old),
    );
    const side = selectedCandidate.proved === selectedCandidate.claim ? 'proof' : 'refutation';
    const accepted = await settle(1, selected, side);
    record.candidate_bounty = accepted;
    record.candidate_label = selected;
    if (side === 'refutation') {
      check(
        'The new candidate is refuted by a checked proof',
        accepted.phase === 'Paid' && accepted.certificate?.side === 'refutation',
      );
      await send('refused user patch', prover, gate, 'apply_patch', { candidate_id: selected });
      check(
        'The refuted user patch is not installed',
        (await gate.view('status', {})).phase === 'Open' && (await codeHash()) === sha(old),
      );
      record.candidate_status = 'refuted';
      record.installed = false;
      record.ok = true;
      save();
      return;
    }
    check(
      'Exact repair proof is checked and its prover is paid',
      accepted.phase === 'Paid' &&
        accepted.winner === prover.accountId &&
        accepted.certificate?.proved === chosen[1].claim,
    );
    const installed = await send('install the proved patch', prover, gate, 'apply_patch', { candidate_id: selected });
    // A transaction can be executed before its last receipt is in the final block.
    // Compare code only after finality has reached every receipt of the upgrade.
    const hashes = [
      ...new Set([installed.transaction_outcome, ...installed.receipts_outcome].map((x) => x.block_hash)),
    ];
    const blocks = await Promise.all(hashes.map((block_id) => provider.sendJsonRpc('block', { block_id })));
    const executedHeight = Math.max(...blocks.map((b) => b.header.height));
    let finalHeight = 0;
    for (let i = 0; i < 100; i++) {
      finalHeight = (await provider.block({ finality: 'final' })).header.height;
      if (finalHeight >= executedHeight) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(finalHeight >= executedHeight, 'Upgrade did not reach finality');
    record.finality = { executed_height: executedHeight, observed_final_height: finalHeight };
    const state = await gate.view('status', {});
    record.gate = state;
    record.after_wasm_sha256 = await codeHash();
    record.balances.after_upgrade = await balance();
    check(
      'The sole upgrader installed exactly the proof-bound wasm',
      state.phase === 'Applied' && state.candidate === selected && record.after_wasm_sha256 === sha(fixed),
      state,
    );
    check(
      'Upgrade preserves existing contract balances',
      record.balances.after_upgrade === stateBefore,
      record.balances,
    );
    const after = await send('same refund after upgrade', issuer, target, 'mt_on_transfer', deposit('1', true));
    check(
      'The same live account now returns 1 from a deposit of 1',
      JSON.parse(Buffer.from(after.status.SuccessValue, 'base64').toString())[0] === '1',
    );
    record.balances.after_refund = await balance();
    record.access_keys = {};
    for (const a of [kernel, board, gate, target]) {
      const keys = (
        await provider.sendJsonRpc('query', {
          request_type: 'view_access_key_list',
          account_id: a.accountId,
          finality: 'final',
        })
      ).keys;
      record.access_keys[a.accountId] = keys;
      check('No full-access key on ' + a.accountId, keys.length === 0);
    }
    record.candidate_status = 'proved';
    record.installed = true;
    record.ok = record.checks.every((c) => c.ok);
    save();
  } catch (e) {
    record.error = String(e.stack || e);
    save();
    throw e;
  } finally {
    await worker.tearDown();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
