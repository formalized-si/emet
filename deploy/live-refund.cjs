#!/usr/bin/env node
// The proof-gated repair of upstream NEAR Intents on a network other people can read.
//
//   node deploy/live-refund.cjs                      rehearsal on a fresh local node (pinned near-sandbox),
//                                                    funded with exactly the NEAR the plan asks for
//   node deploy/live-refund.cjs --plan               accounts, funding, artifact hashes; loads no key, sends nothing
//   node deploy/live-refund.cjs --keep               rehearsal, then leave the node running (web page, tools/check_live.py);
//                                                    its directory under .runtime/ stays after Ctrl-C
//   TESTNET_MASTER_ACCOUNT_ID=<you>.testnet node deploy/live-refund.cjs --network testnet --root v1 --send
//        signs with the key of <you>.testnet in ~/.near-credentials/testnet, creates v1.<you>.testnet and the
//        accounts below it. Run it again with the same --root to continue after an interruption.
//        Without --send it prints the plan for testnet and sends nothing.
//   options: --rpc <url>  --reward <NEAR, default 0.5>  --out <file>  --full  --sweep  --open  --claim-open
//            --attach  rehearsal only: continue a --keep run on its still-running local node (tests the resume path)
//            --full   also stage the original binary, to show that a paid refutation cannot install it
//                     (costs the storage of a second 1.5 MB binary)
//            --sweep  at the end, return what the prover, issuer and root still hold to the master account
//            --open   at the end, post three more bounties (--open-reward NEAR each, default 0.3) and leave them
//                     open: on the three other patches of the catalog, for whoever submits the proof first
//            --claim-open  rehearsal only: an unrelated account then claims one of them with the courier CLI
//                     (agent/courier.cjs over RPC, its own key file), the way an outside agent would
//
// It deploys the committed binaries (artifacts/), never a fresh build, so the code hashes on the network are
// the ones in artifacts/SHA256SUMS and artifacts/refund/build.json. The same code path runs on both networks.
// Mainnet is not supported.
const nearAPI = require('near-api-js');
if (!process.env.EMET_RECEIPT_LOGS) nearAPI.utils.Logger.overrideLogger(undefined); // it would print every receipt log
const fs = require('fs'),
  path = require('path'),
  crypto = require('crypto'),
  os = require('os');
const { KeyPair, keyStores, transactions: T } = nearAPI;

const ROOT = path.resolve(__dirname, '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(k);
const network = arg('--network', 'sandbox');
const rootName = arg('--root', 'v1');
const reward = Number(arg('--reward', '0.5'));
const full = has('--full');
const openReward = Number(arg('--open-reward', '0.3'));
const canary = Number(arg('--canary', '1'));
const OPEN = has('--open') || has('--claim-open') ? ['deposit_only', 'ignore_request', 'zero_refund'] : [];
const OUT = path.resolve(arg('--out', path.join(ROOT, `run-output/live-refund-${network}.json`)));
const NEAR = 10n ** 24n,
  TGAS = 10n ** 12n;
const yocto = (x) => BigInt(Math.round(Number(x) * 1e6)) * (NEAR / 1000000n);
const inNear = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const read = (p) => fs.readFileSync(path.join(ROOT, p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASE = 'cases/intents-refund';
const wasm = {
  kernel: read('artifacts/kernel.wasm'),
  board: read('artifacts/board.wasm'),
  gate: read('artifacts/refund/gate.wasm'),
  old: read('artifacts/refund/old.wasm'),
  fixed: read('artifacts/refund/fixed.wasm'),
  receiver: read('artifacts/refund/receiver.wasm'),
};
const catalog = JSON.parse(read(`${CASE}/candidates.json`));
const shelf = JSON.parse(read(`${CASE}/shelf/manifest.json`));
const build = JSON.parse(read('artifacts/refund/build.json'));
const cand = (label) => catalog.candidates.find((c) => c.label === label);
const built = (label) => build.candidates.find((c) => c.label === label);
const parts = (code) => {
  const rows = [];
  for (let i = 0; i < code.length; i += 300000) rows.push(code.subarray(i, i + 300000));
  return rows;
};

// What each account needs. Storage is 1 NEAR per 100 kB and stays locked: these accounts end with no keys.
// Prepaid gas is reserved at a pessimistic price until the call returns (about 1.3 NEAR for 800 TGas), so
// every call below attaches about twice what the rehearsal burnt, not the 1 PGas maximum.
const storage = (bytes) => bytes / 1e5;
const round = (x) => Math.ceil(x * 10) / 10;
const funds = {
  kernel: round(storage(wasm.kernel.length + shelf.stored_bytes) + 0.5),
  board: round(storage(wasm.board.length) + 0.4),
  gate: round(storage(wasm.gate.length) + 0.3),
  intents: round(storage(wasm.old.length) + 0.4),
  receiver: round(storage(wasm.receiver.length) + 0.2),
  prover: round(storage(wasm.fixed.length + (full ? wasm.old.length : 0)) + 0.2 + 1.6),
  ledger: round(storage(wasm.fixed.length) + 0.5), // a second upstream contract, used only as the NEP-245 token ledger
  guardian: 0.5,
  issuer: 1.0,
};
const rootNeeds = round(
  Object.values(funds).reduce((a, b) => a + b, 0) +
    2 * (reward + 0.1) +
    (canary + 0.1) +
    OPEN.length * (openReward + 0.1) +
    1.5,
);
const GAS = {
  chunk: 100n * TGAS,
  seal: 300n * TGAS,
  range: 400n * TGAS,
  post: 700n * TGAS,
  stage: 150n * TGAS,
  transfer: 100n * TGAS,
  backed: 500n * TGAS,
  commit: 30n * TGAS,
  reveal: 600n * TGAS,
  apply: 800n * TGAS,
};

function plan() {
  return {
    network,
    root: `${rootName}.<master account>`,
    root_funding_near: rootNeeds,
    per_account_near: funds,
    bounties: { count: 2, reward_near_each: reward, posting_fee_near_each: 0.1 },
    kernel_bounty: {
      claim: 'False',
      reward_near: canary,
      note: 'left open: whoever proves False on this kernel is paid, and the gate then installs nothing',
    },
    open_bounties: OPEN.length ? { on: OPEN, reward_near_each: openReward, left_open: true } : null,
    staged_binaries: full ? ['original', 'repair'] : ['repair'],
    upstream_revision: build.revision,
    base_sha256: shelf.base_sha256,
    base_declarations: shelf.base_decls,
    code_sha256: {
      kernel: sha(wasm.kernel),
      board: sha(wasm.board),
      gate: sha(wasm.gate),
      intents_before: sha(wasm.old),
      intents_after: sha(wasm.fixed),
      receiver: sha(wasm.receiver),
      ledger: sha(wasm.fixed),
    },
    note: 'Read-only plan. No key was loaded and nothing was sent. Contract accounts end with no access keys, so their storage stake cannot be taken back.',
  };
}

async function main() {
  if (!['sandbox', 'testnet'].includes(network))
    throw Error('network must be sandbox or testnet; mainnet is not supported');
  if (!/^[a-z0-9][a-z0-9-]{0,15}$/.test(rootName)) throw Error('root must be a short lowercase name');
  if (!Number.isFinite(reward) || reward < 0.05 || reward > 100)
    throw Error('reward must be between 0.05 and 100 NEAR');
  if (!Number.isFinite(openReward) || openReward < 0.1 || openReward > 100)
    throw Error('open-reward must be between 0.1 and 100 NEAR');
  if (!Number.isFinite(canary) || canary < 0.1 || canary > 100) throw Error('canary must be between 0.1 and 100 NEAR');
  if (has('--claim-open') && network !== 'sandbox')
    throw Error('--claim-open is a rehearsal: on a public network the open bounties are for other people');
  for (const [label, code] of [
    ['original', wasm.old],
    ['repair', wasm.fixed],
  ]) {
    if (sha(code) !== built(label).wasm_sha256)
      throw Error(`artifacts/refund: the ${label} binary is not the one in build.json`);
    if (cand(label).source_sha256 !== built(label).source_sha256 || cand(label).claim !== built(label).claim)
      throw Error(`candidates.json and build.json disagree about ${label}`);
  }
  if (has('--plan') || (network === 'testnet' && !has('--send'))) {
    console.log(JSON.stringify(plan(), null, 2));
    if (network === 'testnet' && !has('--plan'))
      console.error('\nNothing was sent. Transactions on testnet need --send.');
    return;
  }

  // ---- network ------------------------------------------------------------------------------------------
  let worker = null,
    rpc,
    masterId,
    keyStore,
    networkId = network,
    sandbox = null;
  const attach = has('--attach');
  if (attach && network !== 'sandbox')
    throw Error('--attach continues a local rehearsal; on testnet just run the same command again');
  if (network === 'sandbox' && attach) {
    sandbox = JSON.parse(fs.readFileSync(OUT)).sandbox;
    if (!sandbox) throw Error(`${OUT} was not written by a --keep run`);
    rpc = sandbox.rpc;
    masterId = sandbox.master;
    keyStore = new keyStores.UnencryptedFileSystemKeyStore(sandbox.keys);
  } else if (network === 'sandbox') {
    process.env.NEAR_SANDBOX_BIN_PATH ||= path.join(ROOT, '.sandbox/2.14.0/near-sandbox');
    process.env.NEAR_SANDBOX_BINARY_PATH ||= path.join(ROOT, '.sandbox/2.14.0');
    // The node's directory goes when this process ends. --keep leaves it: a second process (--attach) signs with the keys in it.
    worker = await require('../tools/local-node.cjs')('live-refund', has('--keep'));
    const home = worker.config.homeDir;
    rpc = worker.provider.connection.url;
    masterId = worker.rootAccount.accountId;
    // Keys on disk, as on testnet, so that a second process can continue this run.
    keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.join(home, 'keys'));
    await keyStore.setKey(networkId, masterId, KeyPair.fromString((await worker.rootAccount.getKey()).toString()));
    sandbox = {
      rpc,
      master: masterId,
      keys: path.join(home, 'keys'),
      home,
      pid: (worker.server && worker.server.subprocess && worker.server.subprocess.pid) || null,
    };
  } else {
    rpc = arg('--rpc', 'https://test.rpc.fastnear.com');
    masterId = arg('--master', process.env.TESTNET_MASTER_ACCOUNT_ID);
    if (!masterId || !masterId.endsWith('.testnet'))
      throw Error('set TESTNET_MASTER_ACCOUNT_ID=<you>.testnet (its key must be in ~/.near-credentials/testnet)');
    keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
    if (!(await keyStore.getKey(networkId, masterId)))
      throw Error(`no key for ${masterId} in ~/.near-credentials/testnet`);
  }
  const near = await nearAPI.connect({ networkId, nodeUrl: rpc, keyStore });
  const provider = near.connection.provider;
  const explorer = network === 'testnet' ? 'https://testnet.nearblocks.io' : null;
  const root = `${rootName}.${masterId}`;
  const id = {
    root,
    kernel: `kernel.${root}`,
    board: `board.${root}`,
    gate: `gate.${root}`,
    intents: `intents.${root}`,
    receiver: `receiver.${root}`,
    prover: `prover.${root}`,
  };
  // The issuer plays the token contract. Its name is 64 characters, the length of an implicit account, so
  // that token ids are as long as upstream's regression test makes them (173 characters).
  id.issuer = `${'a'.repeat(64 - root.length - 1)}.${root}`;
  id.ledger = `${'b'.repeat(64 - root.length - 1)}.${root}`;
  id.guardian = `guardian.${root}`;

  // ---- record, with resume ----------------------------------------------------------------------------
  let record = {
    schema: 'emet-live-refund/1',
    network,
    rpc: network === 'testnet' ? rpc : null,
    explorer,
    started_at: new Date().toISOString(),
    upstream: build.upstream,
    upstream_revision: build.revision,
    accounts: id,
    base_sha256: shelf.base_sha256,
    base_declarations: shelf.base_decls,
    code_sha256: plan().code_sha256,
    candidates: {},
    done: {},
    story: {},
    transactions: [],
    checks: [],
    salts: {},
    marks: {},
  };
  if (network === 'sandbox') record.sandbox = sandbox;
  if ((network === 'testnet' || attach) && fs.existsSync(OUT)) {
    const old = JSON.parse(fs.readFileSync(OUT));
    if (old.accounts?.root !== root || JSON.stringify(old.code_sha256) !== JSON.stringify(record.code_sha256))
      throw Error(`${OUT} records another deployment; move it away or pass --out`);
    record = old;
    delete record.error;
    record.salts ||= {};
    record.marks ||= {};
    console.log(
      `continuing ${OUT}: ${Object.keys(record.done).length} steps and ${record.transactions.length} transactions already done`,
    );
  }
  const save = () => {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(record, null, 2) + '\n');
  };
  const step = async (name, fn) => {
    if (record.done[name]) return;
    await fn();
    record.done[name] = new Date().toISOString();
    save();
    console.log('done', name);
  };
  // A value read from the chain once and kept, so that a resumed run compares with the same "before".
  const mark = async (name, read) => {
    if (record.marks[name] === undefined) {
      record.marks[name] = String(await read());
      save();
    }
    return record.marks[name];
  };
  const check = (name, ok, detail) => {
    record.checks = record.checks.filter((c) => c.name !== name);
    record.checks.push({ name, ok: !!ok, detail });
    save();
    console.log(ok ? 'PASS' : 'FAIL', name);
    if (!ok) throw Error(`check failed: ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`);
  };

  // ---- transactions and views ----------------------------------------------------------------------------
  // Every transaction has its own label and is recorded under it once it is final. Run again after an
  // interruption, the script does not send a recorded label a second time, and it asks the network about the
  // one transaction that was in flight before it signs anything new.
  const account = (who) => near.account(who);
  const transient = (e) =>
    /timeout|timed out|ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|\b(408|429|500|502|503|504)\b/i.test(
      String(e && e.type + ' ' + e.message),
    );
  const retry = async (fn, tries = 6) => {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i + 1 >= tries || !transient(e)) throw e;
        await sleep(1500 * (i + 1));
      }
    }
  };
  const height = (finality) => retry(async () => (await provider.block({ finality })).header.height);
  const waitBlocks = async (n) => {
    const from = await height('optimistic');
    while ((await height('optimistic')) < from + n) await sleep(400);
  };
  const lookup = async (hash, signer) => {
    try {
      return await provider.txStatus(hash, signer, 'EXECUTED_OPTIMISTIC');
    } catch {
      return null;
    }
  };
  // A transaction can be executed before its last receipt is in a final block. State is read only after that.
  const settle = async (res) => {
    const hashes = [...new Set([res.transaction_outcome, ...res.receipts_outcome].map((o) => o.block_hash))];
    const executed = Math.max(
      ...(await Promise.all(hashes.map((h) => retry(() => provider.block({ blockId: h }))))).map(
        (b) => b.header.height,
      ),
    );
    for (let i = 0; i < 600 && (await height('final')) < executed; i++) await sleep(network === 'testnet' ? 600 : 150);
    if ((await height('final')) < executed) throw Error('the transaction did not reach finality');
    if (network === 'testnet') await sleep(1200); // other nodes behind the same endpoint may be a block behind
  };
  const sent = new Map(record.transactions.map((t) => [t.label, t]));
  const send = async (label, signer, receiver, actions, { mayFail = false, story = null } = {}) => {
    const known = sent.get(label);
    if (known) {
      if (story) {
        record.story[story] = known;
        save();
      }
      return { row: known, value: known.value, ok: known.ok };
    }
    let res = null;
    if (record.pending && record.pending.label === label) {
      for (let i = 0; i < 20 && !res; i++) {
        res = await lookup(record.pending.hash, signer);
        if (!res) await sleep(1500);
      }
      console.log(
        res
          ? `found the interrupted transaction ${record.pending.hash}`
          : `the interrupted transaction ${record.pending.hash} never arrived; sending it again`,
      );
    }
    for (let attempt = 0; !res; attempt++) {
      const [bytes, signed] = await (await account(signer)).signTransaction(receiver, actions);
      const hash = nearAPI.utils.serialize.base_encode(bytes);
      record.pending = { label, hash, signer };
      save();
      try {
        res = await provider.sendTransaction(signed);
        if (process.env.EMET_CRASH_AFTER === label) {
          console.error(`simulated crash after sending "${label}"`);
          process.exit(99);
        }
      } catch (e) {
        // The node may have taken the transaction and failed only to answer. Ask before sending anything again.
        if (transient(e))
          for (let i = 0; i < 40 && !res; i++) {
            await sleep(2000);
            res = await lookup(hash, signer);
          }
        if (!res && attempt < 3 && /InvalidNonce|Expired/i.test(String(e.type) + String(e.message))) continue;
        if (!res) throw e;
      }
    }
    await settle(res);
    const outcomes = [res.transaction_outcome, ...res.receipts_outcome];
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
      methods: actions.map((a) =>
        a.functionCall
          ? a.functionCall.methodName
          : Object.keys(a).find((k) => a[k] !== undefined && k !== 'enum') || 'action',
      ),
      ok,
      value,
      gas_burnt_tgas: Number(outcomes.reduce((s, o) => s + BigInt(o.outcome.gas_burnt), 0n) / 10n ** 9n) / 1000,
      tokens_burnt_near: inNear(outcomes.reduce((s, o) => s + BigInt(o.outcome.tokens_burnt), 0n)),
      failures: failed.length ? failed : undefined,
    };
    record.transactions.push(row);
    sent.set(label, row);
    delete record.pending;
    if (story) record.story[story] = row;
    save();
    if (!ok && !mayFail) throw Error(`${label}: ${JSON.stringify(failed[0] || res.status).slice(0, 600)}`);
    return { row, value, ok };
  };
  const call = (label, signer, receiver, method, args, { deposit = 0n, gas = 300n * TGAS, ...opts } = {}) =>
    send(label, signer, receiver, [T.functionCall(method, args, gas, deposit)], opts);
  const view = (contract, method, args = {}) =>
    retry(async () =>
      (await account(contract)).viewFunction({
        contractId: contract,
        methodName: method,
        args,
        blockQuery: { finality: 'final' },
      }),
    );
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
  const codeHash = async (who) =>
    sha(Buffer.from((await query({ request_type: 'view_code', account_id: who })).code_base64, 'base64'));
  const keyCount = async (who) => (await query({ request_type: 'view_access_key_list', account_id: who })).keys.length;
  const make = async (who, amount) => {
    // The key is written before the account exists and is never replaced: a second key for an account that an
    // interrupted run did create would lock this script out of it.
    let key = await keyStore.getKey(networkId, who);
    if (!key) {
      key = KeyPair.fromRandom('ed25519');
      await keyStore.setKey(networkId, who, key);
    }
    if (
      !sent.has(`create ${who}`) &&
      !(record.pending && record.pending.label === `create ${who}`) &&
      (await exists(who))
    )
      return;
    const parent = who.slice(who.indexOf('.') + 1);
    await send(`create ${who}`, parent, who, [
      T.createAccount(),
      T.transfer(yocto(amount)),
      T.addKey(key.getPublicKey(), T.fullAccessKey()),
    ]);
  };
  // Deploy, initialize and delete the account's only key in one transaction: all three happen or none does.
  const keyless = async (who, code, method, args) => {
    const key = await keyStore.getKey(networkId, who);
    await send(`deploy ${who} and delete its key`, who, who, [
      T.deployContract(code),
      T.functionCall(method, args, 300n * TGAS, 0n),
      T.deleteKey(key.getPublicKey()),
    ]);
  };

  console.log(`network ${network}, master ${masterId}, root ${root}`);
  save();
  try {
    await step('accounts', async () => {
      await make(root, rootNeeds);
      for (const name of ['kernel', 'board', 'gate', 'intents', 'receiver', 'prover', 'issuer', 'ledger', 'guardian'])
        await make(id[name], funds[name]);
    });

    // ---- the proof checker and its sealed environment ----------------------------------------------------
    await step('kernel', async () => {
      await keyless(id.kernel, wasm.kernel, 'init', { owner: root });
      for (const chunk of shelf.chunks)
        await call(`upload ${chunk}`, root, id.kernel, 'load_base_chunk', read(`${CASE}/shelf/${chunk}`), {
          gas: GAS.chunk,
        });
      await call(
        'seal the environment',
        root,
        id.kernel,
        'seal_base',
        { expected_sha256: shelf.base_sha256, expected_decl_count: shelf.base_decls },
        { gas: GAS.seal },
      );
      for (let from = 0; from < shelf.base_decls; from += 128)
        await call(
          `type-check declarations ${from + 1} to ${Math.min(from + 128, shelf.base_decls)}`,
          root,
          id.kernel,
          'check_base_range',
          { from, to: Math.min(from + 128, shelf.base_decls) },
          { gas: GAS.range },
        );
    });
    const status = await view(id.kernel, 'status');
    check(
      'The kernel type-checked every declaration of the pinned environment',
      status.sealed && status.checked_upto === shelf.base_decls,
      { checked: status.checked_upto, of: shelf.base_decls },
    );

    // ---- the bounty board, the gate, the upstream contract ------------------------------------------------
    const chosen = ['original', 'repair'].map(cand);
    await step('board', async () => {
      await keyless(id.board, wasm.board, 'new', {
        kernel: id.kernel,
        base_hash: shelf.base_sha256,
        factory: null,
        wallet_code_hash: null,
        claims: catalog.candidates.map((c) => ({ claim: c.claim, counter: c.counter_claim })),
        reveal_delay_blocks: '1',
        min_reveal_gas_tgas: '500',
        reveal_bond: String(NEAR / 100n),
        grace_seconds: '3600',
        stale_blocks: '200',
      });
    });
    await step('bounties', async () => {
      const now = BigInt((await provider.block({ finality: 'final' })).header.timestamp_nanosec);
      const deadline = String(now + 30n * 86400n * 10n ** 9n);
      for (const c of chosen)
        await call(
          `post the bounty on ${c.label}`,
          root,
          id.board,
          'post_bounty',
          {
            claim: c.claim,
            counter_claim: c.counter_claim,
            title: `NEAR Intents refund rule: ${c.expression}`,
            deadline,
            subject: null,
            escrow: null,
          },
          { deposit: yocto(reward + 0.1), gas: GAS.post },
        );
      // A standing bounty on the kernel itself. If a proof of False is ever accepted, the board records its
      // kernel as broken, and the gate reads that flag before it installs anything.
      await call(
        'post a standing bounty for a proof of False',
        root,
        id.board,
        'post_bounty',
        {
          claim: 'False',
          counter_claim: null,
          title: 'A proof of False: this kernel is unsound',
          deadline,
          subject: null,
          escrow: null,
        },
        { deposit: yocto(canary + 0.1), gas: GAS.post, story: 'kernel_bounty' },
      );
    });
    {
      const b = await view(id.board, 'get_bounty', { id: '2' }),
        cfg = await view(id.board, 'get_config');
      record.kernel_bounty = { id: '2', reward_near: canary, phase: b && b.phase };
      check(
        'A bounty for a proof of False is open on the board, and its kernel is not recorded broken',
        b && b.claim === 'False' && b.phase === 'Open' && cfg.kernel_broken_by === null,
        { phase: b && b.phase, kernel_broken_by: cfg.kernel_broken_by },
      );
    }
    const gateCandidates = chosen.map((c, i) => ({
      id: c.label,
      source_sha256: c.source_sha256,
      wasm_sha256: sha(i === 0 ? wasm.old : wasm.fixed),
      claim: c.claim,
      bounty_id: String(i),
      chunks: parts(i === 0 ? wasm.old : wasm.fixed).map((p) => ({ sha256: sha(p), bytes: p.length })),
    }));
    record.candidates = Object.fromEntries(
      gateCandidates.map((c) => [
        c.id,
        {
          source_sha256: c.source_sha256,
          wasm_sha256: c.wasm_sha256,
          claim: c.claim,
          bounty_id: c.bounty_id,
          expression: cand(c.id).expression,
        },
      ]),
    );
    await step('gate', () =>
      keyless(id.gate, wasm.gate, 'new', {
        target: id.intents,
        board: id.board,
        base_hash: shelf.base_sha256,
        candidates: gateCandidates,
      }),
    );
    await step('intents', () =>
      keyless(id.intents, wasm.old, 'new', {
        config: {
          wnear_id: network === 'testnet' ? 'wrap.testnet' : 'wrap.test.near',
          fees: { fee: 0, fee_collector: root },
          roles: { grantees: { Upgrader: [id.gate], PauseManager: [id.guardian], UnpauseManager: [id.guardian] } },
        },
      }),
    );
    {
      // Who may do what on the upstream contract, read from the contract: the gate upgrades, the guardian
      // pauses and unpauses, and nobody else holds any role.
      const roles = await view(id.intents, 'acl_get_permissioned_accounts');
      record.roles = roles;
      const held = Object.entries(roles.roles || {}),
        named = ['Upgrader', 'PauseManager', 'UnpauseManager'];
      const only = (role, who) => JSON.stringify((roles.roles[role] || {}).grantees || []) === JSON.stringify([who]);
      check(
        'On the upstream contract only the gate may upgrade and only the guardian may pause; nobody holds any other role',
        only('Upgrader', id.gate) &&
          only('PauseManager', id.guardian) &&
          only('UnpauseManager', id.guardian) &&
          (roles.super_admins || []).length === 0 &&
          held.every(([role, v]) => v.admins.length === 0 && (named.includes(role) || v.grantees.length === 0)),
        roles,
      );
    }
    await step('receiver', async () => {
      await send(`deploy ${id.receiver}`, id.receiver, id.receiver, [T.deployContract(wasm.receiver)]);
    });
    await step('ledger', () =>
      keyless(id.ledger, wasm.fixed, 'new', {
        config: {
          wnear_id: network === 'testnet' ? 'wrap.testnet' : 'wrap.test.near',
          fees: { fee: 0, fee_collector: root },
          roles: {},
        },
      }),
    );
    await step('stage', async () => {
      for (const [label, code] of full
        ? [
            ['original', wasm.old],
            ['repair', wasm.fixed],
          ]
        : [['repair', wasm.fixed]])
        for (const [index, data] of parts(code).entries())
          await call(
            `stage ${label}, part ${index + 1}`,
            id.prover,
            id.gate,
            'stage_code',
            { candidate_id: label, index, data: data.toString('base64') },
            { deposit: BigInt(data.length + 256) * 10n ** 19n, gas: GAS.stage },
          );
    });

    // ---- the story ------------------------------------------------------------------------------------------
    const token = (name) => `nep245:${id.issuer}:${name}`;
    const balance = (name) => view(id.intents, 'mt_balance_of', { account_id: id.receiver, token_id: token(name) });
    const deposit = (names, amounts, request) => ({
      sender_id: id.issuer,
      previous_owner_ids: names.map(() => id.issuer),
      token_ids: names,
      amounts,
      msg:
        request === null
          ? id.receiver
          : JSON.stringify({
              receiver_id: id.receiver,
              msg: JSON.stringify({ ReturnValue: request }),
              min_gas: '5000000000000',
            }),
    });
    const big = String(10n ** 35n);
    const oversized = (o) =>
      o.failures &&
      o.failures.some((f) => {
        const m = JSON.stringify(f.error).match(/length of a log message (\d+) exceeds the limit (\d+)/);
        return m && Number(m[1]) > Number(m[2]);
      });
    // A second upstream contract is the token ledger: "backing" is then a balance on a real NEP-245 contract,
    // and every movement goes through mt_transfer_call and mt_resolve_transfer, as it does in production.
    const filler = 'x'.repeat(31),
      ledgerToken = `nep245:${id.issuer}:${filler}`,
      nested = `nep245:${id.ledger}:${ledgerToken}`,
      pre = 10n ** 37n;
    const position = async () => ({
      backing: await view(id.ledger, 'mt_balance_of', { account_id: id.intents, token_id: ledgerToken }),
      credit: await view(id.intents, 'mt_balance_of', { account_id: id.receiver, token_id: nested }),
      sender: await view(id.ledger, 'mt_balance_of', { account_id: id.issuer, token_id: ledgerToken }),
    });
    const unbacked = (p) => BigInt(p.credit) - BigInt(p.backing);
    record.tokens = { on_ledger: ledgerToken, in_contract: nested };
    save();
    const batchThroughLedger = (label, story) =>
      call(
        label,
        id.issuer,
        id.ledger,
        'mt_batch_transfer_call',
        {
          receiver_id: id.intents,
          token_ids: Array(80).fill(ledgerToken),
          amounts: Array(80).fill('1'),
          msg: JSON.stringify({
            receiver_id: id.receiver,
            msg: JSON.stringify({ ReturnValue: big }),
            min_gas: '5000000000000',
          }),
        },
        { deposit: 1n, gas: GAS.backed, mayFail: true, story },
      );

    await step('old_code', async () => {
      // The simplest instance: a deposit of 1 for which the receiver asks 100 back.
      await call(
        'give the receiver a balance of 1000',
        id.issuer,
        id.intents,
        'mt_on_transfer',
        deposit(['asset'], ['1000'], null),
        { gas: GAS.transfer },
      );
      const one = await call(
        'deposit 1; the receiver asks for 100 back',
        id.issuer,
        id.intents,
        'mt_on_transfer',
        deposit(['asset'], ['1'], '100'),
        { gas: GAS.transfer, story: 'old_refund' },
      );
      check('The old code answers 100 to a deposit of 1', one.value && one.value[0] === '100', one.value);
      // What that leads to, with the shape of upstream's regression test: 80 transfers of 1, each asking for
      // 1e35 back. The refund event outgrows the log limit, the callback fails, the ledger returns the tokens
      // to the sender, and the credit made on deposit stays.
      await call(
        'mint test tokens on the ledger',
        id.issuer,
        id.ledger,
        'mt_on_transfer',
        {
          sender_id: id.issuer,
          previous_owner_ids: [id.issuer],
          token_ids: [filler],
          amounts: [String(pre + 160n)],
          msg: id.issuer,
        },
        { gas: GAS.transfer },
      );
      await call(
        'move 1e37 of them into the contract for the receiver',
        id.issuer,
        id.ledger,
        'mt_transfer_call',
        { receiver_id: id.intents, token_id: ledgerToken, amount: String(pre), msg: id.receiver },
        { deposit: 1n, gas: GAS.backed },
      );
      const before = JSON.parse(await mark('position_before_old_batch', async () => JSON.stringify(await position())));
      const many = await batchThroughLedger(
        '80 transfers of 1 through the ledger; the receiver asks for 1e35 back on each',
        'old_batch',
      );
      const after = await position();
      Object.assign(record.story.old_batch, {
        before,
        after,
        unbacked_added: String(unbacked(after) - unbacked(before)),
      });
      save();
      check(
        'Through a real token contract, the old code ends that batch with 80 credits that no token backs',
        oversized(many.row) &&
          record.story.old_batch.unbacked_added === '80' &&
          after.sender === before.sender &&
          after.backing === before.backing,
        { before, after, failures: many.row.failures },
      );
    });
    await step('emergency', async () => {
      // The fast path in an emergency is a pause, not an upgrade: one transaction by the guardian.
      await call(
        'the guardian pauses deposits',
        id.guardian,
        id.intents,
        'pa_pause_feature',
        { key: 'mt_on_transfer' },
        { gas: GAS.transfer, story: 'paused' },
      );
      const refused = await call(
        'a deposit while deposits are paused',
        id.issuer,
        id.intents,
        'mt_on_transfer',
        deposit(['asset'], ['1'], '100'),
        { gas: GAS.transfer, mayFail: true, story: 'deposit_while_paused' },
      );
      check(
        'The guardian pauses deposits in one transaction, and a deposit is then refused',
        (await view(id.intents, 'pa_is_paused', { key: 'mt_on_transfer' })) === true && !refused.ok,
        { failures: refused.row.failures },
      );
    });
    record.balance_before_upgrade = await mark('asset_balance_before_upgrade', () => balance('asset'));
    // Asked before the upgrade only: a run that continues after it would find the new binary here.
    if (!record.done.upgrade)
      check('The upstream contract runs the old binary', (await codeHash(id.intents)) === sha(wasm.old));

    await step('refused', async () => {
      const no = await call(
        'try to install the repair before any proof exists',
        id.prover,
        id.gate,
        'apply_patch',
        { candidate_id: 'repair' },
        { gas: GAS.apply, story: 'upgrade_refused' },
      );
      const g = await view(id.gate, 'status');
      check(
        'Without a proof the gate installs nothing',
        no.value === false &&
          g.phase === 'Open' &&
          g.last_error === 'no_matching_positive_certificate' &&
          (await codeHash(id.intents)) === sha(wasm.old),
        { phase: g.phase, last_error: g.last_error },
      );
      const tampered = Buffer.from(parts(wasm.fixed)[0]);
      tampered[tampered.length - 1] ^= 1;
      const wrong = await call(
        'offer the gate a binary that differs in one bit',
        id.prover,
        id.gate,
        'stage_code',
        { candidate_id: 'repair', index: 0, data: tampered.toString('base64') },
        { gas: GAS.stage, mayFail: true, story: 'binary_refused' },
      );
      check(
        'A binary that differs in one bit is refused by its hash',
        !wrong.ok && JSON.stringify(wrong.row.failures).includes('chunk_mismatch'),
      );
    });

    const prove = async (i, label, side, story) => {
      const delta = read(`${CASE}/proofs/${label}.ndjson`);
      const salt = (record.salts[label] ||= crypto.randomBytes(16).toString('hex'));
      save();
      const commitment = sha(
        Buffer.from(`proof-courier/commit/v2\n${i}\n${id.prover}\n${side}\n${sha(delta)}\n${salt}`),
      );
      await call(
        `commit to a ${side} of the ${label} claim`,
        id.prover,
        id.board,
        'commit',
        { id: String(i), hash: commitment },
        { deposit: NEAR / 100n, gas: GAS.commit },
      );
      await waitBlocks(3);
      await call(
        `reveal the ${side}; the kernel checks it`,
        id.prover,
        id.board,
        'reveal',
        Buffer.concat([Buffer.from(`${i}\n${side}\n${salt}\n`), delta]),
        { deposit: NEAR / 100n, gas: GAS.reveal, story },
      );
      const b = await view(id.board, 'get_bounty', { id: String(i) });
      record.story[story].proof_bytes = delta.length;
      record.story[story].proof_sha256 = sha(delta);
      record.story[story].certificate = b.certificate;
      save();
      return b;
    };
    await step('refutation', async () => {
      const b = await prove(0, 'original', 'refutation', 'refutation_paid');
      check(
        'The old expression earns a paid refutation, not a certificate of correctness',
        b.phase === 'Paid' && b.certificate?.side === 'refutation' && b.winner === id.prover,
        { phase: b.phase, side: b.certificate?.side },
      );
      if (full) {
        const no = await call(
          'try to install the refuted binary',
          id.prover,
          id.gate,
          'apply_patch',
          { candidate_id: 'original' },
          { gas: GAS.apply, story: 'refuted_refused' },
        );
        check(
          'A paid refutation cannot install anything',
          no.value === false && (await view(id.gate, 'status')).phase === 'Open',
        );
      }
    });
    await step('proof', async () => {
      const b = await prove(1, 'repair', 'proof', 'proof_paid');
      check(
        'The proof of the repair is checked by the kernel and its author is paid',
        b.phase === 'Paid' &&
          b.winner === id.prover &&
          b.certificate?.side === 'proof' &&
          b.certificate?.proved === cand('repair').claim,
        { phase: b.phase, proved: b.certificate?.proved },
      );
    });
    await step('upgrade', async () => {
      await call(
        'install the repair: the gate reads the certificate and upgrades the contract',
        id.prover,
        id.gate,
        'apply_patch',
        { candidate_id: 'repair' },
        { gas: GAS.apply, story: 'upgrade_applied' },
      );
    });
    const gate = await view(id.gate, 'status');
    record.gate = { phase: gate.phase, candidate: gate.candidate, generation: gate.generation };
    check(
      'The gate installed exactly the binary registered for that claim',
      gate.phase === 'Applied' && gate.candidate === 'repair' && (await codeHash(id.intents)) === sha(wasm.fixed),
      record.gate,
    );
    record.balance_after_upgrade = await balance('asset');
    check('The upgrade kept the balances', record.balance_after_upgrade === record.balance_before_upgrade, {
      before: record.balance_before_upgrade,
      after: record.balance_after_upgrade,
    });

    await step('new_code', async () => {
      await call(
        'the guardian lets deposits resume',
        id.guardian,
        id.intents,
        'pa_unpause_feature',
        { key: 'mt_on_transfer' },
        { gas: GAS.transfer, story: 'unpaused' },
      );
      const one = await call(
        'the same deposit of 1 on the same account',
        id.issuer,
        id.intents,
        'mt_on_transfer',
        deposit(['asset'], ['1'], '100'),
        { gas: GAS.transfer, story: 'new_refund' },
      );
      check('The same account now answers 1 to a deposit of 1', one.value && one.value[0] === '1', one.value);
      const before = JSON.parse(await mark('position_before_new_batch', async () => JSON.stringify(await position())));
      const many = await batchThroughLedger('the same 80 transfers through the ledger', 'new_batch');
      const after = await position();
      Object.assign(record.story.new_batch, {
        before,
        after,
        unbacked_added: String(unbacked(after) - unbacked(before)),
      });
      save();
      check(
        'After the upgrade the same batch completes and adds no unbacked credit',
        many.ok &&
          record.story.new_batch.unbacked_added === '0' &&
          after.sender === before.sender &&
          after.backing === before.backing,
        { before, after, failures: many.row.failures },
      );
    });

    // Bounties left open for anyone. Their proofs are in this repository; the first account to submit one is paid.
    if (OPEN.length)
      await step('open_bounties', async () => {
        const now = BigInt((await provider.block({ finality: 'final' })).header.timestamp_nanosec);
        const deadline = String(now + 30n * 86400n * 10n ** 9n);
        record.open_bounties = [];
        for (const label of OPEN) {
          const c = cand(label);
          const r = await call(
            `post an open bounty on ${label}`,
            root,
            id.board,
            'post_bounty',
            {
              claim: c.claim,
              counter_claim: c.counter_claim,
              title: `NEAR Intents refund rule: ${c.expression}`,
              deadline,
              subject: null,
              escrow: null,
            },
            { deposit: yocto(openReward + 0.1), gas: GAS.post },
          );
          const b = (await view(id.board, 'list_bounties', {})).find((x) => x.claim === c.claim);
          record.open_bounties.push({
            id: b.id,
            label,
            expression: c.expression,
            claim: c.claim,
            counter_claim: c.counter_claim,
            settles_with: c.proved,
            proof_file: `${CASE}/proofs/${label}.ndjson`,
            reward_near: openReward,
            posted: r.row.hash,
            explorer: r.row.explorer,
          });
          save();
        }
      });
    if (has('--claim-open'))
      await step('outside_claim', async () => {
        // An account that is not below the root, with its own key file, talking to the node over RPC.
        const { execFileSync } = require('child_process');
        const outsider = `outsider.${masterId}`,
          target = record.open_bounties[2];
        await make(outsider, 6);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-outsider-'));
        try {
          fs.writeFileSync(
            path.join(dir, 'key.json'),
            JSON.stringify({
              account_id: outsider,
              private_key: (await keyStore.getKey(networkId, outsider)).toString(),
            }),
            { mode: 0o600 },
          );
          // The documented command, as an outside agent would run it.
          const out = execFileSync(
            'node',
            [
              path.join(ROOT, 'agent/claim.cjs'),
              '--record',
              OUT,
              '--rpc',
              rpc,
              '--account',
              outsider,
              '--key-file',
              path.join(dir, 'key.json'),
              '--bounty',
              target.id,
              '--json',
            ],
            { encoding: 'utf8', maxBuffer: 1 << 26 },
          );
          const result = JSON.parse(out.trim().split('\n').pop());
          const b = await view(id.board, 'get_bounty', { id: target.id });
          record.outside_claim = {
            account: outsider,
            bounty: target.id,
            label: target.label,
            phase: b.phase,
            winner: b.winner,
            earned_near: result.earned_near,
            side: b.certificate?.side,
            command: 'node agent/claim.cjs --account <account> --key-file <key file> --bounty ' + target.id,
          };
          check(
            'A separate account claimed an open bounty with the documented command and was paid',
            b.phase === 'Paid' &&
              b.winner === outsider &&
              result.won.includes(target.id) &&
              result.earned_near >= openReward,
            record.outside_claim,
          );
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        const ids = record.open_bounties.map((b) => b.id);
        const rest = (await view(id.board, 'list_bounties', {})).filter(
          (x) => ids.includes(x.id) && x.phase === 'Open',
        ).length;
        check('The other open bounties are still open', rest === OPEN.length - 1, { open: rest });
      });

    record.access_keys = {};
    for (const name of ['kernel', 'board', 'gate', 'intents', 'ledger'])
      record.access_keys[id[name]] = await keyCount(id[name]);
    check(
      'No access key exists on the kernel, the board, the gate, the upstream contract or the ledger',
      Object.values(record.access_keys).every((n) => n === 0),
      record.access_keys,
    );
    record.storage_bytes = {};
    for (const name of ['kernel', 'board', 'gate', 'intents', 'receiver', 'ledger'])
      record.storage_bytes[name] = (await query({ request_type: 'view_account', account_id: id[name] })).storage_usage;

    if (has('--sweep') && network === 'testnet')
      await step('sweep', async () => {
        for (const who of [id.prover, id.issuer, id.guardian, id.root]) {
          const a = await query({ request_type: 'view_account', account_id: who });
          const spare = BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n - NEAR / 5n;
          if (spare > NEAR / 10n)
            await send(`return ${inNear(spare)} NEAR from ${who}`, who, masterId, [T.transfer(spare)]);
        }
      });
    record.ok = record.checks.every((c) => c.ok);
    record.finished_at = new Date().toISOString();
    record.spent_near = Number(record.transactions.reduce((s, t) => s + t.tokens_burnt_near, 0).toFixed(4));
    save();
    console.log(
      `\n${record.checks.filter((c) => c.ok).length}/${record.checks.length} checks passed. Record: ${path.relative(process.cwd(), OUT)}`,
    );
    if (explorer) for (const [k, t] of Object.entries(record.story)) console.log(`  ${k.padEnd(18)} ${t.explorer}`);
    if (worker && has('--keep')) {
      record.rpc = rpc;
      save();
      console.log(
        `\nThe local node keeps running at ${rpc} (kernel ${id.kernel}). Ctrl-C stops it; its directory stays: ${sandbox.home}`,
      );
      await new Promise((resolve) => {
        process.on('SIGINT', resolve);
        process.on('SIGTERM', resolve);
      });
    }
  } catch (e) {
    record.error = String(e.stack || e).slice(0, 2000);
    save();
    throw e;
  } finally {
    if (worker) await worker.tearDown();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
