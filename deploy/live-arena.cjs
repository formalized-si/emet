#!/usr/bin/env node
// NEAR Proof Arena's transfer relation in a kernel contract on a NEAR network, and the Arena's own proofs of two
// theorems about it, each sent in one transaction.
//
// WITHOUT --send ON TESTNET IT ONLY PRINTS THE PLAN: no key is loaded and nothing is sent.
//
//   node deploy/live-arena.cjs --plan                                      what it would create and send
//   node deploy/live-arena.cjs --network sandbox                           the whole run on a fresh local node
//   node deploy/live-arena.cjs --network testnet --master <you>.testnet --send
//
// It needs what `bash tools/measure_nearspec.sh` writes: the packed environment (.tools/nearspec/packed) and the two
// proof files (evidence/nearspec/*.delta.ndjson). It makes one account, `arena.<master>`: deploy, init and delete
// its only key in one transaction; upload the chunks; seal; type-check every declaration; then send each proof,
// and one of them under the other claim, which must be refused. The record is deploy/testnet-arena.json
// (run-output/live-arena-sandbox.json for a local run). Run again after an interruption, it reads the contract's
// own state and the record and continues from there; a check that the record holds is not sent twice.
const nearAPI = require('near-api-js');
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  crypto = require('crypto');
const { KeyPair, keyStores, transactions: T, utils } = nearAPI;
if (!process.env.EMET_RECEIPT_LOGS) nearAPI.utils.Logger.overrideLogger(undefined);
const ROOT = path.resolve(__dirname, '..');
const has = (k) => process.argv.includes(k);
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const TGAS = 10n ** 12n,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (y) => Number(BigInt(y) / 10n ** 20n) / 1e4;

(async () => {
  const network = arg('--network', 'sandbox');
  if (!['sandbox', 'testnet'].includes(network)) throw Error('--network sandbox or testnet');
  const packed = path.resolve(arg('--packed', path.join(ROOT, '.tools/nearspec/packed')));
  const E = path.join(ROOT, 'evidence/nearspec');
  const size = JSON.parse(fs.readFileSync(path.join(E, 'size.json')));
  const kernelWasm = fs.readFileSync(path.join(ROOT, 'artifacts/kernel.wasm'));
  const cases = [
    {
      label: 'NearRelation.outputs_unique',
      claim: 'Emet.Arena.OutputsUnique',
      file: 'evidence/nearspec/outputs_unique.delta.ndjson',
      expect: true,
    },
    {
      label: 'NearRelation.domain',
      claim: 'Emet.Arena.RelationInDomain',
      file: 'evidence/nearspec/relation_in_domain.delta.ndjson',
      expect: true,
    },
    {
      label: 'wrong on purpose: the proof of outputs_unique offered for the other claim',
      claim: 'Emet.Arena.RelationInDomain',
      file: 'evidence/nearspec/outputs_unique.delta.ndjson',
      expect: false,
    },
  ];
  const funding = 19.6; // NEAR for the account: 10.3 for the code and 8.4 for the environment at 1 NEAR per 100 kB, and room for the calls
  const plan = {
    network,
    account: 'arena.<master account>',
    funding_near: funding,
    kernel_wasm_sha256: sha(kernelWasm),
    environment: size.sealed_environment,
    arena: size.arena,
    arena_commit: size.arena_commit,
    checks: cases.map((c) => ({ label: c.label, claim: c.claim, proof: c.file, must_be_accepted: c.expect })),
    note: 'Read-only plan. No key was loaded and nothing was sent. The account ends with no access key, so its storage stake cannot be taken back.',
  };
  if (has('--plan') || (network === 'testnet' && !has('--send'))) {
    console.log(JSON.stringify(plan, null, 2));
    if (network === 'testnet' && !has('--plan'))
      console.error('\nNothing was sent. Transactions on testnet need --send.');
    return;
  }
  if (!fs.existsSync(path.join(packed, 'manifest.json')))
    throw Error(`no packed environment at ${packed}: run bash tools/measure_nearspec.sh first`);
  const manifest = JSON.parse(fs.readFileSync(path.join(packed, 'manifest.json')));
  if (manifest.base_sha256 !== size.sealed_environment.sha256)
    throw Error('the packed environment is not the one evidence/nearspec/size.json names');

  let worker = null,
    rpc,
    masterId,
    keyStore;
  if (network === 'sandbox') {
    process.env.NEAR_SANDBOX_BIN_PATH ||= path.join(ROOT, '.sandbox/2.14.0/near-sandbox');
    process.env.NEAR_SANDBOX_BINARY_PATH ||= path.join(ROOT, '.sandbox/2.14.0');
    worker = await require('../tools/local-node.cjs')('live-arena'); // its directory under .runtime/ goes when this process ends
    rpc = worker.provider.connection.url;
    masterId = worker.rootAccount.accountId;
    keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey(network, masterId, KeyPair.fromString((await worker.rootAccount.getKey()).toString()));
  } else {
    rpc = arg('--rpc', 'https://test.rpc.fastnear.com');
    masterId = arg('--master');
    if (!masterId || !masterId.endsWith('.testnet'))
      throw Error('--master <you>.testnet (its key must be in ~/.near-credentials/testnet)');
    keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
    if (!(await keyStore.getKey(network, masterId)))
      throw Error(`no key for ${masterId} in ~/.near-credentials/testnet`);
  }
  const OUT = path.resolve(
    arg(
      '--out',
      network === 'testnet'
        ? path.join(ROOT, 'deploy/testnet-arena.json')
        : path.join(ROOT, 'run-output/live-arena-sandbox.json'),
    ),
  );
  const net = await nearAPI.connect({ networkId: network, nodeUrl: rpc, keyStore });
  const provider = net.connection.provider;
  if (network === 'testnet' && (await provider.status()).chain_id !== 'testnet') throw Error(`${rpc} is not testnet`);
  const explorer = network === 'testnet' ? 'https://testnet.nearblocks.io' : null;
  const id = arg('--account') || `arena.${masterId}`;
  let record = {
    schema: 'emet-live-arena/1',
    network,
    rpc: network === 'testnet' ? rpc : null,
    explorer,
    started_at: new Date().toISOString(),
    account: id,
    master: masterId,
    arena: size.arena,
    arena_commit: size.arena_commit,
    kernel_wasm_sha256: sha(kernelWasm),
    environment: size.sealed_environment,
    transactions: [],
    checks: [],
  };
  if (network === 'testnet' && fs.existsSync(OUT)) {
    const old = JSON.parse(fs.readFileSync(OUT));
    if (
      old.account !== id ||
      old.kernel_wasm_sha256 !== record.kernel_wasm_sha256 ||
      old.environment.sha256 !== record.environment.sha256
    )
      throw Error(`${OUT} records another deployment; move it away or pass --out`);
    record = old;
    console.log(`continuing ${OUT}: ${record.transactions.length} transactions recorded`);
  }
  const save = () => {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(record, null, 2) + '\n');
  };
  const retry = async (fn) => {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (
          i >= 5 ||
          !/timeout|timed out|ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|\b(408|429|500|502|503|504)\b/i.test(
            String(e && e.type + ' ' + e.message),
          )
        )
          throw e;
        await sleep(1500 * (i + 1));
      }
    }
  };
  const query = (request) => retry(() => provider.query({ finality: 'final', ...request }));
  const exists = async (who) => {
    try {
      await query({ request_type: 'view_account', account_id: who });
      return true;
    } catch (e) {
      if (/does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(String(e.type) + String(e.message))) return false;
      throw e;
    }
  };
  const status = () =>
    retry(async () =>
      (await net.account(id)).viewFunction({
        contractId: id,
        methodName: 'status',
        args: {},
        blockQuery: { finality: 'final' },
      }),
    );
  const height = (finality) => retry(async () => (await provider.block({ finality })).header.height);
  // One transaction: sign, send, wait until every receipt is in a final block, record it under its label.
  const send = async (label, signer, receiver, actions, { mayFail = false } = {}) => {
    const res = await retry(async () =>
      (await net.account(signer)).signAndSendTransaction({ receiverId: receiver, actions }).catch((e) => {
        if (e.transaction_outcome) return e;
        throw e;
      }),
    );
    const outcomes = [res.transaction_outcome, ...res.receipts_outcome];
    const executed = Math.max(
      ...(
        await Promise.all(
          [...new Set(outcomes.map((o) => o.block_hash))].map((h) => retry(() => provider.block({ blockId: h }))),
        )
      ).map((b) => b.header.height),
    );
    for (let i = 0; i < 600 && (await height('final')) < executed; i++) await sleep(network === 'testnet' ? 600 : 150);
    if (network === 'testnet') await sleep(1200);
    const failed = outcomes
      .filter((o) => o.outcome.status.Failure)
      .map((o) => ({ executor: o.outcome.executor_id, error: o.outcome.status.Failure }));
    const ok = failed.length === 0 && !(res.status && res.status.Failure);
    let value = null;
    if (res.status && typeof res.status.SuccessValue === 'string' && res.status.SuccessValue) {
      try {
        value = JSON.parse(Buffer.from(res.status.SuccessValue, 'base64').toString());
      } catch {
        value = null;
      }
    }
    const hash = res.transaction.hash;
    const row = {
      label,
      hash,
      explorer: explorer && `${explorer}/txns/${hash}`,
      signer,
      receiver,
      ok,
      gas_burnt_tgas: Number(outcomes.reduce((s, o) => s + BigInt(o.outcome.gas_burnt), 0n) / 10n ** 9n) / 1000,
      tokens_burnt_near: near(outcomes.reduce((s, o) => s + BigInt(o.outcome.tokens_burnt), 0n)),
      failures: failed.length ? failed : undefined,
    };
    record.transactions.push(row);
    save();
    console.log(ok ? 'ok    ' : 'FAILED', label, `${row.gas_burnt_tgas.toFixed(1)} TGas`, hash);
    if (!ok && !mayFail) throw Error(`${label}: ${JSON.stringify(failed[0] || res.status).slice(0, 500)}`);
    return { row, value, ok };
  };
  const call = (label, method, args, gas, opts) =>
    send(label, masterId, id, [T.functionCall(method, args, gas * TGAS, 0n)], opts);

  try {
    console.log(`network ${network}, master ${masterId}, account ${id}`);
    save();
    // The account. Its key is written before the account exists and never replaced.
    if (!(await exists(id))) {
      let key = await keyStore.getKey(network, id);
      if (!key) {
        key = KeyPair.fromRandom('ed25519');
        await keyStore.setKey(network, id, key);
      }
      await send(`create ${id}`, masterId, id, [
        T.createAccount(),
        T.transfer(utils.format.parseNearAmount(String(funding))),
        T.addKey(key.getPublicKey(), T.fullAccessKey()),
      ]);
    }
    // Deploy, initialize and delete the only key in one transaction: all three happen or none does.
    const code = (await query({ request_type: 'view_account', account_id: id })).code_hash;
    if (code === '11111111111111111111111111111111') {
      const key = await keyStore.getKey(network, id);
      if (!key) throw Error(`${id} exists without code and its key is not here`);
      await send(`deploy ${id} and delete its key`, id, id, [
        T.deployContract(kernelWasm),
        T.functionCall('init', { owner: masterId }, 300n * TGAS, 0n),
        T.deleteKey(key.getPublicKey()),
      ]);
    }
    let s = await status();
    for (let i = s.chunks; i < manifest.chunks.length; i++)
      await call(
        `upload ${manifest.chunks[i]}`,
        'load_base_chunk',
        fs.readFileSync(path.join(packed, manifest.chunks[i])),
        100n,
      );
    s = await status();
    if (!s.sealed)
      await call(
        'seal the environment',
        'seal_base',
        { expected_sha256: manifest.base_sha256, expected_decl_count: manifest.base_decls },
        1000n,
      );
    s = await status();
    for (let from = s.checked_upto, span = 128; from < manifest.base_decls; ) {
      const to = Math.min(manifest.base_decls, from + span);
      const r = await call(`type-check declarations ${from + 1} to ${to}`, 'check_base_range', { from, to }, 1000n, {
        mayFail: true,
      });
      if (r.ok) from = to;
      else if (span === 1) throw Error(`declaration ${from + 1} does not fit in one call`);
      else span = Math.max(1, span >> 1);
    }
    s = await status();
    const done = new Map((record.results || []).map((r) => [r.label, r]));
    record.results = [...done.values()];
    for (const c of cases) {
      if (done.has(c.label)) continue;
      const delta = fs.readFileSync(path.join(ROOT, c.file));
      const r = await call(
        `check ${c.label}`,
        'check_result_raw',
        Buffer.concat([Buffer.from(c.claim + '\n'), delta]),
        1000n,
      );
      const v = r.value || {};
      record.results.push({
        label: c.label,
        claim: c.claim,
        proof: c.file,
        proof_bytes: delta.length,
        proof_sha256: sha(delta),
        must_be_accepted: c.expect,
        accepted: v.ok === true,
        reason: v.reason || null,
        proof_theorem: v.proof_theorem || null,
        statement_hash: v.statement_hash || null,
        decls_checked: v.decls_checked,
        axioms: v.axioms,
        hash: r.row.hash,
        explorer: r.row.explorer,
        gas_burnt_tgas: r.row.gas_burnt_tgas,
        kernel_tgas: v.gas_kernel === undefined ? undefined : Number(v.gas_kernel) / 1e12,
        parse_tgas: v.gas_parse === undefined ? undefined : Number(v.gas_parse) / 1e12,
      });
      save();
    }
    const check = (name, ok, detail) => {
      record.checks = record.checks.filter((x) => x.name !== name);
      record.checks.push({ name, ok: !!ok, detail });
      save();
      console.log(ok ? 'PASS' : 'FAIL', name);
    };
    const account = await query({ request_type: 'view_account', account_id: id });
    const keys = (await query({ request_type: 'view_access_key_list', account_id: id })).keys.length;
    record.status = s;
    record.access_keys = keys;
    record.storage_bytes = account.storage_usage;
    check(
      'The account runs artifacts/kernel.wasm and has no access key',
      sha(Buffer.from((await query({ request_type: 'view_code', account_id: id })).code_base64, 'base64')) ===
        sha(kernelWasm) && keys === 0,
      { keys },
    );
    check(
      'The kernel sealed the environment exported from the Arena specification and type-checked every declaration',
      s.sealed === true &&
        s.base_hash === manifest.base_sha256 &&
        s.checked_upto === manifest.base_decls &&
        s.base_decls === size.sealed_environment.declarations_as_the_kernel_counts_them,
      { checked: s.checked_upto, of: manifest.base_decls },
    );
    for (const c of cases) {
      const r = record.results.find((x) => x.label === c.label);
      check(
        c.expect
          ? `Accepted in one call: the Arena's proof of ${c.label}`
          : 'Refused: one of those proofs offered under the other claim',
        r.accepted === c.expect && (c.expect || String(r.reason).startsWith('statement_mismatch')),
        { gas_burnt_tgas: r.gas_burnt_tgas, reason: r.reason },
      );
    }
    record.ok = record.checks.every((x) => x.ok);
    record.finished_at = new Date().toISOString();
    record.spent_near = Number(record.transactions.reduce((sum, t) => sum + t.tokens_burnt_near, 0).toFixed(4));
    save();
    console.log(
      `\n${record.checks.filter((x) => x.ok).length}/${record.checks.length} checks passed. Record: ${path.relative(ROOT, OUT)}`,
    );
    if (!record.ok) process.exitCode = 1;
  } finally {
    if (worker) await worker.tearDown();
  }
})().catch((e) => {
  console.error(String(e.stack || e.message || e));
  process.exit(1);
});
