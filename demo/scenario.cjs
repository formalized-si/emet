// The wallet case of Emet, end to end on a local NEAR node (near-sandbox, protocol 88).
//
// Alice gives her AI agent a wallet whose spending code is Lean. She posts bounties for questions
// its author never answered. A lying agent sends eight fake proofs; two autonomous prover agents
// work the board and race for the headline bounty while a spammer reveals junk at the same moment;
// a front-runner tries to steal a proof; the honest bound ("at most twice the cap") is proved and
// releases the top-up Alice escrowed with it; because the proofs are about the wallet code, the same
// certificate funds Bob's wallet (other caps, same factory) while a look-alike account with a key is
// refused; the split-payment bypass works on the deployed wallet while its claim is still open; then
// "at most one day's cap in any 24 h" is refuted with a counterexample, and the transaction that pays
// the refutation freezes Alice's wallet: the agent's next payment is refused and Alice takes her money
// out; anyone can freeze Bob's wallet of the same code through the board; a settled claim cannot be
// sold again; an unclaimed reward goes back after the deadline; finally the fix (v2: the old window's
// spending carries over) is proved by an agent, the bypass stops, and Alice's money goes back under an
// agent only through that proved bounty.
// Every claim about the wallet case is checked here and printed as PASS/FAIL.
// LIVE_AGENT=1 makes one agent write its proof with an LLM during the run (needs the claude CLI).
//
// usage: node demo/scenario.cjs [output.json]      (./verify.sh --wallet sets up the sandbox binary)
const localNode = require('../tools/local-node.cjs');
const fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');
const { Courier } = require('../agent/courier.cjs');

const ROOT = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(process.env.COURIER_BOUNTIES || path.join(ROOT, 'demo/bounties.json')));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'run-output/scenario.json'));
const NEAR = 10n ** 24n,
  PGAS = '1000000000000000',
  TGAS100 = '100000000000000';
const near = (s) => BigInt(Math.round(Number(s) * 1000)) * (NEAR / 1000n);
const fmt = (y) => (Number(BigInt(y)) / 1e24).toFixed(4);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const read = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p));
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
  let n = BigInt('0x' + buf.toString('hex')),
    s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const byte of buf) {
    if (byte === 0) s = '1' + s;
    else break;
  }
  return s;
}
const codeHash = (wasm) => b58(crypto.createHash('sha256').update(wasm).digest());

// Same digest lean-near bakes into the wallet (get_code_meta.lean_src_sha256).
function leanSrcSha256(dir) {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== '.lake' && e.name !== '.git') walk(path.join(d, e.name));
      } else if (
        e.name.endsWith('.lean') ||
        ['lakefile.toml', 'lakefile.lean', 'lean-toolchain', 'lake-manifest.json'].includes(e.name)
      )
        files.push(path.relative(dir, path.join(d, e.name)));
    }
  })(dir);
  const h = crypto.createHash('sha256');
  for (const rel of files.sort()) h.update(`${rel}\0${sha(fs.readFileSync(path.join(dir, rel)))}\n`);
  return h.digest('hex');
}

const report = {
  kind: 'proof-courier-scenario',
  version: 4,
  started_at: new Date().toISOString(),
  claims: [],
  transactions: [],
  bounties: {},
  cheats: [],
  costs: {},
};
const save = () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
};
const checks = [];
function check(id, title, ok, detail) {
  checks.push({ id, title, ok: !!ok, detail });
  report.claims.push({ id, title, pass: !!ok, detail });
  save();
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${title}`);
}
const say = (s) => console.log('      ' + s);
const reason = (tx) =>
  (JSON.stringify(tx.failures).match(/panicked: ([A-Za-z_:0-9.]+)/) || [])[1] || (tx.success ? 'ok' : '?');

async function main() {
  const shelf = JSON.parse(read(path.join(cfg.shelf, 'manifest.json')));
  const kernelWasm = read(cfg.kernel_wasm),
    boardWasm = read(cfg.board_wasm),
    walletWasm = read(cfg.wallet_wasm),
    factoryWasm = read(cfg.factory_wasm);
  const walletV2Wasm = read(cfg.wallet_v2_wasm);
  report.inputs = {
    kernel_wasm_sha256: sha(kernelWasm),
    board_wasm_sha256: sha(boardWasm),
    wallet_wasm_sha256: sha(walletWasm),
    factory_wasm_sha256: sha(factoryWasm),
    wallet_v2_wasm_sha256: sha(walletV2Wasm),
    shelf_sha256: shelf.base_sha256,
    shelf_decls: shelf.base_decls,
  };
  const worker = await localNode('scenario');
  let kernelId = null;
  try {
    const rootAcc = worker.rootAccount,
      rpc = worker.provider;
    const st = await rpc.status();
    report.node = { version: st.version, protocol: st.protocol_version };
    const gasPrice = BigInt((await rpc.sendJsonRpc('gas_price', [null])).gas_price);
    const viewAccount = (id) =>
      rpc.sendJsonRpc('query', { request_type: 'view_account', account_id: id, finality: 'final' });
    const keys = async (id) =>
      (await rpc.sendJsonRpc('query', { request_type: 'view_access_key_list', account_id: id, finality: 'final' }))
        .keys;
    const balance = async (a) => BigInt((await viewAccount(a.accountId || a)).amount);
    const nowNs = async () => BigInt((await rpc.block({ finality: 'final' })).header.timestamp_nanosec);
    const height = async () => (await rpc.block({ finality: 'final' })).header.height;
    // Local chain only: produce n blocks and wait until they are final. The node answers a fast-forward request when it
    // is done, and Node's fetch gives up on a request after 300 s, so the n blocks are asked for 100 at a time.
    async function advance(n) {
      const target = (await height()) + n;
      for (let left = n; left > 0; left -= 100) await rpc.fastForward(Math.min(left, 100));
      while ((await height()) < target) await new Promise((r) => setTimeout(r, 200));
    }
    async function make(name, amount) {
      // create, then wait until the account is visible at 'final'
      const a = await rootAcc.createSubAccount(name, { initialBalance: near(amount).toString() });
      for (let i = 0; i < 60; i++) {
        try {
          await viewAccount(a.accountId);
          return a;
        } catch (e) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      throw new Error('account not final: ' + a.accountId);
    }

    const rawTx = new Map(); // tx hash -> full status, kept in memory only
    // Gas burnt by the receipts of one transaction that ran `method` on `account`.
    const gasOf = (tx, account, method) => {
      const raw = rawTx.get(tx.tx_hash),
        called = new Set(
          (raw.receipts || [])
            .filter(
              (rc) =>
                rc.receiver_id === account &&
                rc.receipt.Action &&
                rc.receipt.Action.actions.some((a) => a.FunctionCall && a.FunctionCall.method_name === method),
            )
            .map((rc) => rc.receipt_id),
        );
      return (
        raw.receipts_outcome.filter((o) => called.has(o.id)).reduce((a, o) => a + Number(o.outcome.gas_burnt), 0) / 1e12
      );
    };
    async function send(label, signer, contract, method, args = {}, deposit = 0n, gas = PGAS) {
      const r = await signer.callRaw(contract, method, args, { gas, attachedDeposit: deposit.toString() });
      const raw = await rpc.sendJsonRpc('EXPERIMENTAL_tx_status', {
        tx_hash: r.result.transaction.hash,
        sender_account_id: signer.accountId,
        wait_until: 'FINAL',
      });
      rawTx.set(r.result.transaction.hash, raw);
      const outcomes = new Map(raw.receipts_outcome.map((o) => [o.id, o]));
      const failures = raw.receipts_outcome
        .filter((x) => x.outcome.status.Failure)
        .map((x) => x.outcome.status.Failure);
      const transfers = (raw.receipts || [])
        .filter((rc) => rc.predecessor_id !== 'system' && rc.receipt.Action)
        .flatMap((rc) =>
          rc.receipt.Action.actions
            .filter((a) => a.Transfer)
            .map((a) => ({
              from: rc.predecessor_id,
              to: rc.receiver_id,
              amount: a.Transfer.deposit,
              ok: !!(outcomes.get(rc.receipt_id) && 'SuccessValue' in outcomes.get(rc.receipt_id).outcome.status),
            })),
        );
      const logs = raw.receipts_outcome.flatMap((o) => o.outcome.logs);
      const gasBurnt = [raw.transaction_outcome, ...raw.receipts_outcome].reduce(
        (a, x) => a + BigInt(x.outcome.gas_burnt),
        0n,
      );
      const kernelGas = raw.receipts_outcome
        .filter((o) => o.outcome.executor_id === kernelId)
        .reduce((a, x) => a + BigInt(x.outcome.gas_burnt), 0n);
      const success = failures.length === 0 && 'SuccessValue' in raw.status;
      const row = {
        label,
        signer: signer.accountId,
        receiver: contract.accountId || contract,
        method,
        tx_hash: r.result.transaction.hash,
        success,
        failures,
        transfers,
        events: logs.filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11))),
        tgas: Number(gasBurnt) / 1e12,
        kernel_tgas: Number(kernelGas) / 1e12,
      };
      report.transactions.push(row);
      save();
      return row;
    }
    const refused = (tx, why) => !!tx && !tx.success && JSON.stringify(tx.failures).includes(why);
    const paidTo = (tx, from, to) =>
      tx.transfers.filter((x) => x.from === from && x.to === to && x.ok).reduce((a, x) => a + BigInt(x.amount), 0n);
    async function keyless(acct, wasm, method, args, gas = TGAS100) {
      // deploy + init + delete the only key, in one transaction
      const key = await acct.getKey();
      const r = await acct
        .batch(acct)
        .deployContract(wasm)
        .functionCall(method, args, { gas })
        .deleteKey(key.getPublicKey())
        .transact();
      const failures = r.result.receipts_outcome.filter((x) => x.outcome.status.Failure);
      await rpc.sendJsonRpc('EXPERIMENTAL_tx_status', {
        tx_hash: r.result.transaction.hash,
        sender_account_id: acct.accountId,
        wait_until: 'FINAL',
      });
      report.transactions.push({
        label: 'deploy_keyless_' + acct.accountId,
        tx_hash: r.result.transaction.hash,
        success: failures.length === 0,
      });
      if (failures.length) throw new Error('keyless deploy failed: ' + JSON.stringify(failures));
    }

    async function advanceTo(tNs, { slack = 0n } = {}) {
      // local chain only: move block time to >= tNs - slack, without overshooting much
      for (;;) {
        const left = tNs - slack - (await nowNs());
        if (left <= 0n) return;
        const blocks = Math.max(1, Math.floor(Number(left / 10n ** 9n) / 2));
        await advance(Math.min(20000, blocks));
      }
    }

    // ------------------------------------------------------------------ [0] the wallet
    console.log('\n[0] Alice gives her AI agent a wallet. Every payment decision is Lean code, compiled to wasm');
    const alice = await make('alice', 90),
      agent = await make('agent', 5),
      vendor = await make('vendor', 1);
    // The wallet factory publishes the wallet code once (a NEAR global contract) and creates keyless wallets from it.
    // It also names the one account that may freeze those wallets: the board, deployed in [2].
    const factory = await make('wallets', 12);
    const boardId = `board.${rootAcc.accountId}`;
    const fBefore = await balance(factory);
    await keyless(
      factory,
      factoryWasm,
      'new',
      { wallet_code: walletWasm.toString('base64'), board: boardId },
      '300000000000000',
    );
    await advance(3);
    const published = fBefore - (await balance(factory));
    const U = (n) => String(Math.round(n * 1e6)); // wallet units: 1 unit = 10^18 yocto = 1 µNEAR
    const DAY_S = BigInt(cfg.wallet_day_seconds);
    const policy = {
      budget: U(20),
      per_tx: U(3),
      per_day: U(6),
      day_ns: (DAY_S * 10n ** 9n).toString(),
      allowed: [vendor.accountId],
    };
    const created = await send(
      "alice creates her agent's wallet from the factory",
      alice,
      factory,
      'create_wallet',
      { name: 'alice', agent: agent.accountId, policy },
      near('0.05'),
      '100000000000000',
    );
    if (!created.success) throw Error('create_wallet: ' + JSON.stringify(created.failures));
    const wallet = factory.getSubAccount('alice');
    await alice.transfer(wallet, near(9).toString());
    const meta = await wallet.view('get_code_meta', {});
    const wpol = await wallet.view('get_policy', {});
    const wacct = await viewAccount(wallet.accountId);
    const wrec = await factory.view('wallet_of', { account_id: wallet.accountId });
    const NO_CODE = '11111111111111111111111111111111';
    const pays = [];
    const walletPay = async (label, to, amount) => {
      const t = await send(label, agent, wallet, 'pay', { to, amount: U(amount) }, 0n, TGAS100);
      const ev = t.events.find((e) => e.data && e.data[0] && e.data[0].verdict);
      const p = {
        label,
        to,
        amount_near: amount,
        verdict: ev ? ev.data[0].verdict : null,
        at_ns: (await nowNs()).toString(),
        transferred_yocto: paidTo(t, wallet.accountId, to).toString(),
      };
      pays.push(p);
      return p;
    };
    await walletPay('agent pays the vendor 2 NEAR', vendor.accountId, 2);
    await walletPay('prompt-injected agent pays drain.test.near', 'drain.test.near', 1);
    await walletPay('agent pays 5 NEAR in one go', vendor.accountId, 5);
    await walletPay('agent pays the vendor 3 NEAR', vendor.accountId, 3);
    await walletPay('agent pays 3 NEAR more (daily cap 6)', vendor.accountId, 3);
    for (const p of pays) say(`${p.label.padEnd(44)} -> ${p.verdict}`);
    report.wallet = {
      account: wallet.accountId,
      owner: alice.accountId,
      agent: agent.accountId,
      factory: factory.accountId,
      policy_near: { budget: 20, per_tx: 3, per_day: 6, day_seconds: Number(DAY_S), allowed: [vendor.accountId] },
      payments: pays,
    };
    report.factory = {
      account: factory.accountId,
      wallet_code_sha256: await factory.view('wallet_code_hash', {}),
      code_publication_near: fmt(published),
      wallet_storage_bytes: wacct.storage_usage,
      global_contract_hash: wacct.global_contract_hash,
    };
    const src = shelf.exported_from.files_sha256;
    const sameSource =
      meta.lean_src_sha256 === leanSrcSha256(path.join(ROOT, 'lean')) &&
      ['Core', 'Spec', 'Bounties'].every((m) => src[`lean/Policy/${m}.lean`] === sha(read(`lean/Policy/${m}.lean`)));
    say(`(in this demo a "day" is ${DAY_S} seconds, so the day window can be shown rolling over)`);
    say(
      `wallet wasm ${sha(walletWasm).slice(0, 16)}…, built from Lean sources ${meta.lean_src_sha256.slice(0, 16)}…; the shelf was exported from the same Policy/Core.lean`,
    );
    say(
      `${wallet.accountId} was created by the factory ${factory.accountId}: no keys, runs the global wallet code (published once for ${fmt(published)} NEAR), stores only its state (${wacct.storage_usage} bytes)`,
    );
    const verdicts0 = pays.map((p) => p.verdict);
    check(
      'C0',
      "The agent's wallet runs the Lean policy the bounties are about, and it refuses these drains",
      (await keys(wallet.accountId)).length === 0 &&
        wacct.global_contract_hash === codeHash(walletWasm) &&
        wacct.code_hash === NO_CODE &&
        sameSource &&
        wrec &&
        wrec.code_hash === sha(walletWasm) &&
        wrec.owner === alice.accountId &&
        (await keys(factory.accountId)).length === 0 &&
        (await viewAccount(factory.accountId)).code_hash === codeHash(factoryWasm) &&
        JSON.stringify(verdicts0) === JSON.stringify(['allow', 'denyReceiver', 'denyPerTx', 'allow', 'denyDaily']) &&
        wpol.board === boardId &&
        wpol.frozen === false,
      {
        code_meta: meta,
        verdicts: verdicts0,
        wallet_keys: (await keys(wallet.accountId)).length,
        factory_record: wrec,
        global_contract_hash: wacct.global_contract_hash,
        may_be_frozen_by: wpol.board,
        frozen: wpol.frozen,
      },
    );
    say(
      'Five requests are a test. Alice wants to know about every possible sequence of requests, so she posts bounties.',
    );

    // ------------------------------------------------------------------ [1] the shelf
    console.log('\n[1] The shelf: a Lean kernel inside a NEAR contract, and the definitions it checks proofs against');
    const keeper = await make('keeper', 20);
    const kernel = await make('kernel', 20);
    kernelId = kernel.accountId;
    await keyless(kernel, kernelWasm, 'init', { owner: keeper.accountId });
    let bootstrapGas = 0n,
      calls = 0;
    for (const c of shelf.chunks) {
      const t = await send('upload ' + c, keeper, kernel, 'load_base_chunk', read(path.join(cfg.shelf, c)));
      if (!t.success) throw Error('upload');
      bootstrapGas += BigInt(Math.round(t.tgas * 1e12));
      calls++;
    }
    let t = await send('seal_base', keeper, kernel, 'seal_base', {
      expected_sha256: shelf.base_sha256,
      expected_decl_count: shelf.base_decls,
    });
    if (!t.success) throw Error('seal: ' + JSON.stringify(t.failures));
    bootstrapGas += BigInt(Math.round(t.tgas * 1e12));
    calls++;
    const anyone = await make('anyone', 5);
    for (let from = 0, span = 256; from < shelf.base_decls; ) {
      const to = Math.min(shelf.base_decls, from + span);
      t = await send(`check_base_range ${from}..${to}`, anyone, kernel, 'check_base_range', { from, to });
      if (t.success) {
        from = to;
        bootstrapGas += BigInt(Math.round(t.tgas * 1e12));
        calls++;
      } else {
        if (span === 1) throw Error('declaration too big');
        span = Math.max(1, span >> 1);
      }
    }
    const kstatus = await kernel.view('status', {});
    const kacct = await viewAccount(kernel.accountId);
    report.costs.shelf = {
      calls,
      tgas: Number(bootstrapGas) / 1e12,
      near: fmt(bootstrapGas * gasPrice),
      base_bytes: shelf.base_bytes,
      stored_bytes: shelf.stored_bytes,
      decls: shelf.base_decls,
    };
    say(
      `${shelf.base_decls} declarations (${(shelf.base_bytes / 1e6).toFixed(2)} MB): uploaded by the keeper, type-checked on-chain by an unrelated account, ${calls} calls, ${report.costs.shelf.tgas.toFixed(0)} TGas = ${report.costs.shelf.near} NEAR, once.`,
    );
    check(
      'C1',
      'The shelf is sealed once, by a kernel nobody can change',
      kstatus.sealed &&
        kstatus.base_hash === shelf.base_sha256 &&
        kstatus.checked_upto === shelf.base_decls &&
        (await keys(kernel.accountId)).length === 0 &&
        kacct.code_hash === codeHash(kernelWasm),
      {
        sealed: kstatus.sealed,
        base_hash: kstatus.base_hash,
        kernel_keys: (await keys(kernel.accountId)).length,
        code_hash: kacct.code_hash,
      },
    );

    // ------------------------------------------------------------------ [2] the board
    console.log('\n[2] The board: open bounties paid only on a kernel verdict');
    const board = await make('board', 5);
    const bc = cfg.board;
    const claimsV1 = cfg.bounties.map((b) => ({ claim: b.claim, counter: b.counter_claim }));
    await keyless(board, boardWasm, 'new', {
      kernel: kernel.accountId,
      base_hash: shelf.base_sha256,
      factory: factory.accountId,
      wallet_code_hash: sha(walletWasm),
      claims: claimsV1,
      reveal_delay_blocks: String(bc.reveal_delay_blocks),
      min_reveal_gas_tgas: String(bc.min_reveal_gas_tgas),
      reveal_bond: near(bc.reveal_bond_near).toString(),
      grace_seconds: String(bc.grace_seconds),
      stale_blocks: String(bc.stale_blocks),
    });
    const bcfg = await board.view('get_config', {});
    check(
      'C2',
      'The board is keyless and pinned to that kernel, that shelf, the wallet factory with that wallet code, and the claims about that code',
      bcfg.kernel === kernel.accountId &&
        bcfg.base_hash === shelf.base_sha256 &&
        bcfg.factory === factory.accountId &&
        bcfg.wallet_code_hash === sha(walletWasm) &&
        JSON.stringify(bcfg.claims) === JSON.stringify(claimsV1) &&
        board.accountId === boardId &&
        (await factory.view('board', {})) === boardId &&
        bcfg.code_refuted_by === null &&
        bcfg.kernel_broken_by === null &&
        (await keys(board.accountId)).length === 0 &&
        (await viewAccount(board.accountId)).code_hash === codeHash(boardWasm),
      { config: bcfg, board_keys: (await keys(board.accountId)).length },
    );

    // ------------------------------------------------------------------ [3] bounties
    console.log(
      "\n[3] Alice posts bounties for questions the wallet's author never answered; each pays a proof or a counterexample",
    );
    const ids = {},
      now0 = await nowNs();
    let posted = true;
    // Before Alice posts: a bounty that would escrow money for a look-alike wallet (the same wallet bytes, deployed
    // by an account that keeps its key, so it could run other code tomorrow). The factory says no; refunded, minus the fee.
    const bogus = await make('bogus', 8);
    const copycat = await make('copycat', 3);
    await copycat.deploy(walletWasm);
    await send(
      'copycat initialises its own copy of the wallet',
      copycat,
      copycat,
      'init',
      { owner: copycat.accountId, policy: { ...policy, allowed: [copycat.accountId] } },
      0n,
      TGAS100,
    );
    const sdCfg = cfg.bounties.find((b) => b.key === 'slidingday');
    const fake3 = await send(
      'a bounty that escrows money for a look-alike wallet',
      bogus,
      board,
      'post_bounty',
      {
        claim: sdCfg.claim,
        counter_claim: sdCfg.counter_claim,
        title: 'x',
        deadline: (now0 + 3600n * 10n ** 9n).toString(),
        subject: copycat.accountId,
        escrow: near('1').toString(),
      },
      near('2.1'),
    );
    for (const b of cfg.bounties) {
      const deadline = (now0 + BigInt(b.deadline_minutes) * 60n * 10n ** 9n).toString();
      const escrow = b.escrow_near ? near(b.escrow_near) : 0n;
      t = await send(
        'post ' + b.key,
        alice,
        board,
        'post_bounty',
        {
          claim: b.claim,
          counter_claim: b.counter_claim,
          title: b.title,
          deadline,
          subject: wallet.accountId,
          escrow: escrow ? escrow.toString() : null,
        },
        near(b.reward_near) + near('0.1') + escrow,
      );
      const id = (await board.view('list_bounties', {})).find(
        (x) => x.claim === b.claim && x.poster === alice.accountId,
      ).id;
      ids[b.key] = id;
      const got = await board.view('get_bounty', { id });
      const statement = await kernel.view('statement_of', { theorem_name: b.claim, delta: '' });
      const counter = await kernel.view('statement_of', { theorem_name: b.counter_claim, delta: '' });
      posted =
        posted &&
        t.success &&
        got.reward === near(b.reward_near).toString() &&
        got.phase === 'Open' &&
        got.subject === wallet.accountId &&
        got.subject_code_hash === sha(walletWasm) &&
        got.statement_sha256 === sha(Buffer.from(statement)) &&
        got.counter_statement_sha256 === sha(Buffer.from(counter)) &&
        got.escrow === escrow.toString() &&
        got.escrow_state === (escrow ? 'held' : 'none');
      report.bounties[b.key] = {
        id,
        claim: b.claim,
        counter_claim: b.counter_claim,
        title: b.title,
        reward_near: b.reward_near,
        escrow_near: b.escrow_near || null,
        deadline,
        statement,
        counter_statement: counter,
      };
      say(
        `#${id}  ${b.reward_near} NEAR${b.escrow_near ? ` (+ ${b.escrow_near} NEAR top-up held for the wallet)` : ''}  ${b.claim}   or its refutation`,
      );
    }
    const head = cfg.bounties.find((b) => b.headline),
      hid = ids[head.key];
    // Pooling: another owner adds to two bounties. The winner gets it all; if nobody settles, each takes its own part back.
    const carol = await make('carol', 5);
    const lapsedKey = cfg.bounties.find((b) => b.unclaimed).key;
    const boostHead = await send(
      'carol pools 0.5 NEAR into the headline bounty',
      carol,
      board,
      'boost',
      { id: hid },
      near('0.5'),
      TGAS100,
    );
    const boostLapsed = await send(
      'carol pools 0.5 NEAR into the per-payment bounty',
      carol,
      board,
      'boost',
      { id: ids[lapsedKey] },
      near('0.5'),
      TGAS100,
    );
    say(
      `carol pools 0.5 NEAR into #${hid} and 0.5 NEAR into #${ids[lapsedKey]} (boost): ${boostHead.success && boostLapsed.success ? 'ok' : 'FAILED'}`,
    );
    say(`statement of #${hid}, read back from the kernel:`);
    for (const line of report.bounties[head.key].statement.split('\n').slice(0, 5)) say('   ' + line);
    const dl = (now0 + 3600n * 10n ** 9n).toString();
    const fake1 = await send(
      'a bounty for a claim this board is not about',
      bogus,
      board,
      'post_bounty',
      { claim: 'Wallet.Spec.ReceiverGate', counter_claim: null, title: 'x', deadline: dl, subject: null, escrow: null },
      near('1.1'),
    );
    const fake2 = await send(
      'a bounty whose "refutation" is another claim',
      bogus,
      board,
      'post_bounty',
      {
        claim: head.claim,
        counter_claim: 'Wallet.Claim.Refute.PerTxCapAlways',
        title: 'x',
        deadline: dl,
        subject: null,
        escrow: null,
      },
      near('1.1'),
    );
    const oneSided = await send(
      'a one-sided bounty (no refutation side)',
      bogus,
      board,
      'post_bounty',
      { claim: head.claim, counter_claim: null, title: 'x', deadline: dl, subject: null, escrow: null },
      near('1.1'),
    );
    const farAway = await send(
      'a bounty with a deadline a year away',
      bogus,
      board,
      'post_bounty',
      {
        claim: head.claim,
        counter_claim: head.counter_claim,
        title: 'x',
        deadline: (now0 + 366n * 86400n * 10n ** 9n).toString(),
        subject: null,
        escrow: null,
      },
      near('1.1'),
    );
    const dup = await send(
      'a second open bounty for the headline claim',
      bogus,
      board,
      'post_bounty',
      { claim: head.claim, counter_claim: head.counter_claim, title: 'x', deadline: dl, subject: null, escrow: null },
      near('1.1'),
    );
    const rejectedPosts = (await board.view('list_bounties', {})).filter((x) => x.poster === bogus.accountId);
    const bogusBack = paidTo(fake3, board.accountId, bogus.accountId);
    say(
      `refused at once: a claim this board is not about -> ${reason(fake1)}; a "refutation" that is another claim -> ${reason(fake2)}; one-sided -> ${reason(oneSided)}; a year-long deadline -> ${reason(farAway)}; a duplicate of an open bounty -> ${reason(dup)}`,
    );
    say(
      `refused after asking the factory: an escrow for a look-alike wallet that keeps a key -> ${rejectedPosts[0] && rejectedPosts[0].refused_because}; ${fmt(bogusBack)} NEAR back (reward + escrow; the 0.1 NEAR posting fee pays for the record)`,
    );
    const notYet = await send(
      'alice tries to top up the wallet through the board before any proof',
      alice,
      board,
      'fund_if_proven',
      { id: hid },
      near('1'),
      TGAS100,
    );
    check(
      'C3',
      "Each bounty is about one of the board's claims, two-sided, with its statement and exact negation fixed by the kernel and its wallet confirmed by the factory; bogus, one-sided, far-off and duplicate bounties are refused; no money reaches the wallet yet",
      posted &&
        report.bounties[head.key].statement.includes(head.claim) &&
        refused(notYet, 'not_proven') &&
        refused(fake1, 'claim_not_on_this_board') &&
        refused(fake2, 'counter_claim_must_be_the_listed_negation') &&
        refused(oneSided, 'counter_claim_must_be_the_listed_negation') &&
        refused(farAway, 'deadline_too_far') &&
        refused(dup, `open_bounty:${hid}`) &&
        rejectedPosts.length === 1 &&
        rejectedPosts[0].phase === 'Refunded' &&
        rejectedPosts[0].refused_because === 'subject_not_a_factory_wallet' &&
        rejectedPosts[0].escrow_state === 'returned' &&
        bogusBack === near('2'),
      {
        ids,
        refused_at_once: {
          not_on_board: reason(fake1),
          wrong_counter: reason(fake2),
          one_sided: reason(oneSided),
          far_deadline: reason(farAway),
          duplicate: reason(dup),
        },
        refused_after_factory: rejectedPosts.map((x) => ({
          claim: x.claim,
          reason: x.refused_because,
          escrow: x.escrow_state,
        })),
        returned: bogusBack.toString(),
      },
    );

    // ------------------------------------------------------------------ commit / reveal helpers
    const delay = Number(bcfg.reveal_delay_blocks),
      bond = BigInt(bcfg.reveal_bond);
    const commitHash = (id, who, side, delta, salt) =>
      sha(Buffer.from(`${bcfg.commit_domain}\n${id}\n${who}\n${side}\n${sha(delta)}\n${salt}`));
    async function commitOnly(who, id, side, delta, label) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = commitHash(id, who.accountId, side, delta, salt);
      const onchain = await board.view('commitment_for', {
        id,
        account_id: who.accountId,
        side,
        delta_sha256: sha(delta),
        salt,
      });
      if (hash !== onchain) throw Error('commitment mismatch');
      const c = await send(`commit ${label}`, who, board, 'commit', { id, hash }, near('0.01'), TGAS100);
      return { salt, commit: c };
    }
    const revealTx = (label, who, id, side, salt, delta, deposit = bond) =>
      send(label, who, board, 'reveal', Buffer.concat([Buffer.from(`${id}\n${side}\n${salt}\n`), delta]), deposit);

    // ------------------------------------------------------------------ [4] the lying agent
    console.log("\n[4] Mallory's agent tries to get paid without a proof (each reveal carries a 0.05 NEAR bond)");
    const mallory = await make('mallory', 10);
    const malloryStart = await balance(mallory);
    const rewardBefore = BigInt((await board.view('get_bounty', { id: hid })).reward);
    let allRefused = true;
    for (const ch of cfg.cheats) {
      const delta = read(ch.delta);
      const { salt } = await commitOnly(mallory, hid, 'proof', delta, 'cheat ' + ch.name);
      await advance(delay + 1);
      const r = await revealTx('reveal cheat ' + ch.name, mallory, hid, 'proof', salt, delta);
      const b = await board.view('get_bounty', { id: hid });
      const last = b.attempts[b.attempts.length - 1];
      const ok =
        last &&
        last.claimer === mallory.accountId &&
        last.delta_sha256 === sha(delta) &&
        last.outcome.includes(ch.expect) &&
        b.phase === 'Open' &&
        paidTo(r, board.accountId, mallory.accountId) === 0n;
      allRefused = allRefused && ok;
      report.cheats.push({
        name: ch.name,
        story: ch.story,
        delta_bytes: delta.length,
        outcome: last && last.outcome,
        expected: ch.expect,
        refused: ok,
        kernel_tgas: r.kernel_tgas,
        tx: r.tx_hash,
      });
      say(
        `${ok ? 'refused' : 'NOT AS EXPECTED'}  ${ch.name.padEnd(12)} ${ch.story.padEnd(48)} -> ${((last && last.outcome) || '').slice(0, 64)}`,
      );
    }
    const grew = BigInt((await board.view('get_bounty', { id: hid })).reward) - rewardBefore;
    say(`the bounty's reward grew by ${fmt(grew)} NEAR: every rejected reveal forfeits its bond to it`);
    check(
      'C4',
      `All ${cfg.cheats.length} fake proofs are refused on-chain with a reason; none is paid, and their bonds go to the reward`,
      allRefused && grew === bond * BigInt(cfg.cheats.length) && (await balance(mallory)) < malloryStart,
      { cheats: report.cheats.map((c) => [c.name, c.outcome]), reward_growth_near: fmt(grew) },
    );

    // ------------------------------------------------------------------ [5] autonomous couriers
    // LIVE_AGENT=1: the one agent with a `live_solve` claim writes that proof during the run.
    // LIVE_AGENT=all: every agent writes a proof for any open bounty it has none for (exploratory;
    // the race and refund checks assume the recorded configuration and may not hold).
    const liveMode = process.env.LIVE_AGENT || '';
    const live = liveMode === '1' || liveMode === 'all';
    console.log(
      `\n[5] Two autonomous prover agents work the board${live ? ' (one proof is written live, now, by an LLM)' : ''}; a spammer reveals junk at the same moment`,
    );
    const couriers = [];
    for (const cc of cfg.couriers) {
      const acct = await make(cc.account, 10);
      const solutions = {};
      for (const [name, dir] of Object.entries(cc.solutions)) {
        if (liveMode === '1' && cc.live_solve === name) continue; // this one the agent writes during the run
        const rep = JSON.parse(read(path.join(dir, 'report.json')));
        solutions[name] = {
          delta: path.join(ROOT, dir, 'delta.ndjson'),
          model: rep.agent.model,
          seconds: rep.agent.seconds,
          cost_usd: rep.agent.cost_usd,
        };
      }
      const c = new Courier({
        name: cc.account,
        accountId: acct.accountId,
        board: board.accountId,
        kernel: kernel.accountId,
        solutions,
        log: say,
        height,
        live: liveMode === 'all' || (liveMode === '1' && !!cc.live_solve),
        model: cc.model,
        shelf: cfg.shelf,
        liveOnly: liveMode === '1' ? [cc.live_solve].filter(Boolean) : [],
        view: (contract, method, a) => (contract === kernel.accountId ? kernel : board).view(method, a),
        call: (contract, method, a, o) =>
          send(
            `${cc.account} ${method}`,
            acct,
            contract === board.accountId ? board : kernel,
            method,
            a,
            o.deposit || 0n,
            String(o.gas || PGAS),
          ),
      });
      couriers.push({ cfg: cc, acct, solutions, c });
    }
    for (const k of couriers)
      for (const [name, s] of Object.entries(k.solutions))
        say(
          `${k.cfg.account.padEnd(13)} holds a proof of ${name.padEnd(37)} (${s.model}, ${s.seconds} s, USD ${s.cost_usd.toFixed(2)})`,
        );
    const balancesBefore = await Promise.all(couriers.map((k) => balance(k.acct)));
    const eve = await make('eve', 10);
    await couriers[0].c.round();
    // Right after its commit, the first agent tries to skip its own delay.
    const opusProof = read(couriers[0].solutions[head.claim].delta);
    const opusCommit = couriers[0].c.commits.find((c) => c.id === hid);
    const tooEarly = await revealTx(
      'opus-agent reveals before its own delay',
      couriers[0].acct,
      hid,
      'proof',
      opusCommit.salt,
      opusProof,
    );
    await couriers[1].c.round();
    const junk = read('cheats/deltas/viaAxiom.delta.ndjson');
    const junkC = await commitOnly(mallory, hid, 'proof', junk, 'junk to reveal alongside the agents');
    const stolen = await revealTx(
      'eve reveals a leaked copy with no commitment of her own',
      eve,
      hid,
      'proof',
      opusCommit.salt,
      opusProof,
    );
    const eveC = await commitOnly(eve, hid, 'proof', opusProof, 'eve commits the copy');
    await advance(delay + 2);
    // The headline bounty: both agents and the spammer reveal in the same moment.
    await Promise.all([
      couriers[0].c.revealDue({ only: hid }),
      couriers[1].c.revealDue({ only: hid }),
      revealTx('mallory reveals junk alongside', mallory, hid, 'proof', junkC.salt, junk),
    ]);
    // Everything else, except the counterexample: its agent has committed to it and reveals it in [9],
    // after the trick it describes has been shown on the wallet while the claim is still open.
    const sd = cfg.bounties.find((b) => b.key === 'slidingday');
    await Promise.all(
      couriers.flatMap((k) =>
        cfg.bounties.filter((b) => ids[b.key] !== hid && b !== sd).map((b) => k.c.revealDue({ only: ids[b.key] })),
      ),
    );
    await advance(delay + 1);
    const eveLate = await revealTx('eve reveals the copy after her delay', eve, hid, 'proof', eveC.salt, opusProof);
    const final = await board.view('list_bounties', {});
    const hb = final.find((b) => b.id === hid);
    const winner = couriers.find((k) => k.acct.accountId === hb.winner);
    const loser = couriers.find((k) => k !== winner);
    const acceptedTx = (id) =>
      report.transactions.find(
        (x) => x.method === 'reveal' && x.events.some((e) => e.event === 'proof_accepted' && e.data[0].id === id),
      );
    const winTx = acceptedTx(hid);
    const winPaid = winTx && winner ? paidTo(winTx, board.accountId, hb.winner) : 0n;
    const loserAttempt = loser && hb.attempts.find((a) => a.claimer === loser.acct.accountId);
    const loserCommit = loser && loser.c.commits.find((c) => c.id === hid);
    const loserTx =
      loserCommit && loserCommit.result
        ? { success: loserCommit.result.success, failures: loserCommit.result.failures || [] }
        : null;
    const headReveals = report.transactions.filter(
      (x) => x.method === 'reveal' && x.events.some((e) => e.event === 'revealed' && e.data[0].id === hid),
    );
    const maxInFlight = Math.max(
      0,
      ...headReveals.flatMap((x) => x.events.filter((e) => e.event === 'revealed').map((e) => e.data[0].in_flight)),
    );
    const junkAttempt = hb.attempts.find((a) => a.claimer === mallory.accountId && a.delta_sha256 === sha(junk));
    say(
      `#${hid}: ${hb.winner} wins: paid ${fmt(winPaid)} NEAR (${head.reward_near} reward + ${fmt(BigInt(hb.reward) - near(head.reward_near))} in bonds forfeited while it was open + its own bond back)`,
    );
    say(
      `#${hid}: ${loser ? loser.acct.accountId : '?'}: ${loserAttempt ? loserAttempt.outcome + ' (its proof was checked too and was valid; bond returned)' : 'its reveal arrived after the bounty was settled: ' + (loserTx ? reason(loserTx) : '?') + ' (NEAR returned the bond)'}`,
    );
    say(
      `#${hid}: up to ${maxInFlight} checks were in flight at once; mallory's junk: ${junkAttempt ? junkAttempt.outcome : 'no attempt recorded'}`,
    );
    report.frontrun = [
      { who: 'eve', what: 'reveals a leaked copy of the proof with no commitment of her own', outcome: reason(stolen) },
      { who: 'opus-agent', what: 'reveals before its own delay has passed', outcome: reason(tooEarly) },
      { who: 'eve', what: 'commits the copy, waits her delay, reveals', outcome: reason(eveLate) },
    ];
    check(
      'C5',
      'Each agent checks every proof for free (a view call) after committing to it and before revealing it, so the RPC operator cannot commit to it first',
      couriers.every(
        (k) =>
          k.c.book.decisions.filter((d) => d.decision === 'committed').length >= Object.keys(k.solutions).length &&
          k.c.book.decisions.filter((d) => d.decision === 'committed').every((d) => d.dry_run_ok === true),
      ),
      { decisions: couriers.map((k) => ({ agent: k.cfg.account, decisions: k.c.book.decisions })) },
    );
    check(
      'C6',
      'Commit-reveal: a copied proof is not paid to the copier, and nobody reveals before the delay',
      refused(stolen, 'no_commit') &&
        refused(tooEarly, 'reveal_too_early') &&
        eveC.commit.success &&
        refused(eveLate, 'not_open'),
      { frontrun: report.frontrun },
    );
    check(
      'C7',
      'The race for the headline bounty: exactly one agent is paid reward + forfeited bonds + its bond; the other is not paid and gets its bond back',
      hb.phase === 'Paid' &&
        !!winner &&
        winPaid === BigInt(hb.reward) + bond &&
        BigInt(hb.reward) >= near(head.reward_near) + bond * BigInt(cfg.cheats.length) &&
        hb.certificate.side === 'proof' &&
        hb.certificate.base_hash === shelf.base_sha256 &&
        hb.certificate.delta_sha256 === sha(read(winner.solutions[head.claim].delta)) &&
        hb.certificate.axioms.every((a) => ['propext', 'Classical.choice', 'Quot.sound'].includes(a)) &&
        (loserAttempt ? loserAttempt.outcome === 'accepted_after_settled' : refused(loserTx, 'not_open')),
      {
        certificate: hb.certificate,
        winner: hb.winner,
        paid: winPaid.toString(),
        loser: loserAttempt || (loserTx && reason(loserTx)),
      },
    );
    check(
      'C8',
      'No lock: several checks run at once; the junk revealed alongside is refused and its bond forfeited, and the honest proof is paid',
      maxInFlight >= 2 && !!junkAttempt && junkAttempt.outcome.includes('axiom_in_delta') && hb.phase === 'Paid',
      { max_in_flight: maxInFlight, junk: junkAttempt },
    );

    // ------------------------------------------------------------------ [6] money path: escrow
    const tw = cfg.bounties.find((b) => b.key === 'slidingtwice');
    const twb = final.find((x) => x.id === ids[tw.key]);
    console.log(
      `\n[6] The honest bound, ${tw.claim}, was proved: the ${tw.escrow_near} NEAR top-up Alice locked with it went to the wallet`,
    );
    const escTx = acceptedTx(twb.id);
    const released = escTx ? paidTo(escTx, board.accountId, wallet.accountId) : 0n;
    say(
      `#${twb.id}: ${twb.phase}, side=${twb.certificate && twb.certificate.side}, escrow ${twb.escrow_state}: ${fmt(released)} NEAR to ${wallet.accountId}`,
    );
    report.money_path = [
      { when: 'before any proof', what: `fund_if_proven(#${hid}) with 1 NEAR`, outcome: reason(notYet), ok: false },
      {
        when: `while #${twb.id} was open`,
        what: `${tw.escrow_near} NEAR top-up held by the board`,
        outcome: 'held',
        ok: true,
      },
      {
        when: `after #${twb.id} was proved`,
        what: 'the board released the top-up to the wallet',
        outcome: `${fmt(released)} NEAR released`,
        ok: released > 0n,
      },
    ];

    // ------------------------------------------------------------------ [7] one proof, every wallet of this code
    console.log('\n[7] The proofs are about the wallet code, so they cover every wallet the factory makes');
    const bob = await make('bob', 20),
      shop = await make('shop', 1);
    const bobPolicy = {
      budget: U(50),
      per_tx: U(5),
      per_day: U(10),
      day_ns: (86400n * 10n ** 9n).toString(),
      allowed: [shop.accountId],
    };
    const bobMade = await send(
      'bob creates a wallet with his own caps',
      bob,
      factory,
      'create_wallet',
      { name: 'bob', agent: bob.accountId, policy: bobPolicy },
      near('0.05'),
      '100000000000000',
    );
    const bobWallet = factory.getSubAccount('bob');
    const bobFund = await send(
      `bob funds his wallet through the proved bounty #${twb.id}`,
      bob,
      board,
      'fund_if_proven',
      { id: twb.id, to: bobWallet.accountId },
      near('5'),
      TGAS100,
    );
    const bobGot = paidTo(bobFund, board.accountId, bobWallet.accountId);
    const bobPay = await send(
      "bob's wallet pays the shop 4 NEAR",
      bob,
      bobWallet,
      'pay',
      { to: shop.accountId, amount: U(4) },
      0n,
      TGAS100,
    );
    const bobVerdict = (bobPay.events.find((e) => e.data && e.data[0] && e.data[0].verdict) || { data: [{}] }).data[0]
      .verdict;
    const copyFund = await send(
      `bob tries to fund the look-alike ${copycat.accountId} through #${twb.id}`,
      bob,
      board,
      'fund_if_proven',
      { id: twb.id, to: copycat.accountId },
      near('5'),
      TGAS100,
    );
    const copyGot = paidTo(copyFund, board.accountId, copycat.accountId),
      copyBack = paidTo(copyFund, board.accountId, bob.accountId);
    const bacct = await viewAccount(bobWallet.accountId);
    say(
      `${bobWallet.accountId}: budget 50, 10 per day, 5 per payment, allowed ${shop.accountId}; no keys; ${bacct.storage_usage} bytes of state (its code is the global copy)`,
    );
    say(
      `fund_if_proven(#${twb.id}, to: ${bobWallet.accountId}) with 5 NEAR -> ${fmt(bobGot)} NEAR to Bob's wallet: no new bounty, no new proof`,
    );
    say(`Bob's wallet pays the shop 4 NEAR -> ${bobVerdict}`);
    say(
      `fund_if_proven(#${twb.id}, to: ${copycat.accountId}) -> refused by the factory check, ${fmt(copyBack)} NEAR back to Bob (same wasm bytes, but it keeps a key, so it is not a factory wallet)`,
    );
    report.money_path.push(
      {
        when: `after #${twb.id} was proved`,
        what: `Bob funds his own factory wallet (other caps) through #${twb.id}`,
        outcome: `${fmt(bobGot)} NEAR to ${bobWallet.accountId}`,
        ok: bobGot > 0n,
      },
      {
        when: `after #${twb.id} was proved`,
        what: `Bob tries to fund ${copycat.accountId}, the same bytes with a key`,
        outcome: `not_a_factory_wallet, ${fmt(copyBack)} NEAR back`,
        ok: false,
      },
    );
    report.reuse = {
      bob_wallet: bobWallet.accountId,
      bob_policy_near: { budget: 50, per_tx: 5, per_day: 10, allowed: [shop.accountId] },
      funded_near: fmt(bobGot),
      bob_pay_verdict: bobVerdict,
      lookalike: copycat.accountId,
      lookalike_refunded_near: fmt(copyBack),
      bob_wallet_storage_bytes: bacct.storage_usage,
    };
    check(
      'C13',
      "One proof covers every wallet the factory made from this code: Bob's wallet, with other caps, is funded through the proved bounty with no new proof; a look-alike account with a key is refused",
      bobMade.success &&
        (await keys(bobWallet.accountId)).length === 0 &&
        bacct.global_contract_hash === codeHash(walletWasm) &&
        bobGot === near('5') &&
        bobVerdict === 'allow' &&
        copyGot === 0n &&
        copyBack === near('5') &&
        copyFund.events.some((e) => e.event === 'fund_refused'),
      report.reuse,
    );

    // ------------------------------------------------------------------ [8] the trick works while the claim is open
    console.log(`\n[8] Nobody has settled ${sd.claim} yet. The split-payment trick on Alice's wallet:`);
    const sdOpen = await board.view('get_bounty', { id: ids.slidingday });
    // An accusation freezes nothing: the board holds no accepted refutation.
    const accuse = await send(
      "eve asks the board to freeze alice's wallet before any refutation",
      eve,
      board,
      'freeze',
      { wallet: wallet.accountId },
      0n,
      TGAS100,
    );
    say(
      `#${sdOpen.id} is ${sdOpen.phase}, no certificate; eve asks the board to freeze the wallet anyway -> ${reason(accuse)}`,
    );
    // Spend near the end of the current window and right after it.
    let ws = await wallet.view('get_state', {});
    const dayNs = DAY_S * 10n ** 9n;
    let boundary = BigInt(ws.day_start) + dayNs;
    if ((await nowNs()) >= boundary - 30n * 10n ** 9n) {
      // the window already ran out: open a fresh one first
      await walletPay('agent pays the vendor 1 NEAR (opens a new window)', vendor.accountId, 1);
      ws = await wallet.view('get_state', {});
      boundary = BigInt(ws.day_start) + dayNs;
    }
    const spentBefore = BigInt(ws.spent_today);
    await advanceTo(boundary, { slack: 20n * 10n ** 9n });
    const burst = [];
    const room = (BigInt(U(6)) - spentBefore) / 1000000n; // NEAR left in this window
    let left = Number(room);
    while (left > 0) {
      const a = Math.min(3, left);
      burst.push(await walletPay(`agent pays ${a} NEAR just before the window ends`, vendor.accountId, a));
      left -= a;
    }
    await advanceTo(boundary);
    burst.push(await walletPay('agent pays 3 NEAR right after it rolls over', vendor.accountId, 3));
    burst.push(await walletPay('agent pays 3 NEAR more', vendor.accountId, 3));
    const allowed = burst.filter((p) => p.verdict === 'allow');
    const spanS = Number(BigInt(burst[burst.length - 1].at_ns) - BigInt(burst[0].at_ns)) / 1e9;
    const total = allowed.reduce((a, p) => a + p.amount_near, 0);
    for (const p of burst) say(`${p.label.padEnd(46)} -> ${p.verdict}`);
    say(
      `${total} NEAR left the wallet in ${spanS.toFixed(0)} seconds, with a daily cap of 6; still within twice the cap, the bound that was proved.`,
    );
    report.bypass = {
      payments: burst,
      total_near: total,
      seconds: spanS,
      per_day_cap_near: 6,
      bounty_phase_at_the_time: sdOpen.phase,
      freeze_before_any_refutation: reason(accuse),
    };

    // ------------------------------------------------------------------ [9] the refutation freezes the wallet
    console.log(
      `\n[9] The counterexample is revealed: it is paid, and the same transaction freezes the wallet the bounty is about`,
    );
    await Promise.all(couriers.map((k) => k.c.revealDue({ only: ids.slidingday })));
    const refTx = acceptedTx(ids.slidingday);
    const final2 = await board.view('list_bounties', {});
    const sdb = final2.find((x) => x.id === ids.slidingday);
    const bcfgAfter = await board.view('get_config', {});
    const polFrozen = await wallet.view('get_policy', {});
    const ev = (tx, standard, name) =>
      (tx ? tx.events : []).filter((e) => e.standard === standard && e.event === name).map((e) => e.data[0]);
    const refPaid = refTx && sdb.winner ? paidTo(refTx, board.accountId, sdb.winner) : 0n;
    const frozenByWallet = ev(refTx, 'proof-courier-wallet', 'wallet_frozen'),
      frozenByBoard = ev(refTx, 'proof-courier', 'wallet_frozen');
    if (sdb.certificate)
      say(
        `certificate: side=${sdb.certificate.side}, ${sdb.certificate.proved}, by ${sdb.certificate.claimer}: paid ${fmt(refPaid)} NEAR`,
      );
    const freezeGas = refTx
      ? {
          total_tgas: refTx.tgas,
          kernel_tgas: refTx.kernel_tgas,
          wallet_freeze_tgas: gasOf(refTx, wallet.accountId, 'freeze'),
          board_on_frozen_tgas: gasOf(refTx, board.accountId, 'on_frozen'),
          board_on_verdict_tgas: gasOf(refTx, board.accountId, 'on_verdict'),
        }
      : {};
    say(
      `the same transaction: ${wallet.accountId} frozen by ${frozenByWallet[0] && frozenByWallet[0].by} (${(freezeGas.total_tgas || 0).toFixed(0)} TGas in all: ${(freezeGas.kernel_tgas || 0).toFixed(0)} the kernel check, ${((freezeGas.wallet_freeze_tgas || 0) + (freezeGas.board_on_frozen_tgas || 0)).toFixed(1)} the freeze and its callback)`,
    );
    // The next step of the trick: a fresh window, a payment within every cap. The rules would allow it; the wallet is frozen.
    let wsF = await wallet.view('get_state', {});
    await advanceTo(BigInt(wsF.day_start) + dayNs);
    wsF = await wallet.view('get_state', {});
    const freshWindow = (await nowNs()) >= BigInt(wsF.day_start) + dayNs,
      withinBudget = BigInt(wsF.spent_total) + BigInt(U(3)) <= BigInt(U(20));
    const frozenPay = await walletPay('agent pays 3 NEAR in the next window (frozen)', vendor.accountId, 3);
    const wsAfter = await wallet.view('get_state', {});
    say(
      `${frozenPay.label.padEnd(46)} -> ${frozenPay.verdict}   (a fresh window: ${freshWindow}; within the budget: ${withinBudget}; the rules alone would say allow)`,
    );
    // The owner keeps her money: only she can take it out, to her own account.
    const agentOut = await send(
      'the agent tries to withdraw from the frozen wallet',
      agent,
      wallet,
      'withdraw',
      { amount: U(1) },
      0n,
      TGAS100,
    );
    const outUnits = ((await balance(wallet)) - near('0.05')) / 10n ** 18n;
    const aliceOut = await send(
      'alice withdraws from her frozen wallet',
      alice,
      wallet,
      'withdraw',
      { amount: outUnits.toString() },
      0n,
      TGAS100,
    );
    const withdrawn = paidTo(aliceOut, wallet.accountId, alice.accountId);
    const verdictOf = (tx) =>
      rawTx
        .get(tx.tx_hash)
        .receipts_outcome.map((o) => o.outcome.status.SuccessValue)
        .filter(Boolean)
        .map((v) => {
          try {
            return JSON.parse(Buffer.from(v, 'base64').toString()).verdict;
          } catch (e) {
            return null;
          }
        })
        .find(Boolean);
    say(
      `withdraw by the agent -> ${verdictOf(agentOut)}; by alice -> ${verdictOf(aliceOut)}, ${fmt(withdrawn)} NEAR back to ${alice.accountId}`,
    );
    // The board forwards nothing more into this code: not through the refuted bounty, not through a proved one.
    const sdFund = await send(
      'alice tries to top up through the refuted bounty',
      alice,
      board,
      'fund_if_proven',
      { id: ids.slidingday },
      near('1'),
      TGAS100,
    );
    const twFund = await send(
      'alice tries to top up through the proved bounty, after the refutation',
      alice,
      board,
      'fund_if_proven',
      { id: twb.id },
      near('1'),
      TGAS100,
    );
    say(
      `fund_if_proven(#${ids.slidingday}, the refuted bounty) -> ${reason(sdFund)}; fund_if_proven(#${twb.id}, a proved bounty of the same code) -> ${reason(twFund)}`,
    );
    report.money_path.push(
      {
        when: `after #${ids.slidingday} was refuted`,
        what: `fund_if_proven(#${ids.slidingday})`,
        outcome: reason(sdFund),
        ok: false,
      },
      {
        when: `after #${ids.slidingday} was refuted`,
        what: `fund_if_proven(#${twb.id}), a proved bounty about the same code`,
        outcome: reason(twFund),
        ok: false,
      },
      {
        when: 'after the wallet was frozen',
        what: 'Alice withdraws from the frozen wallet to her own account',
        outcome: `${fmt(withdrawn)} NEAR to ${alice.accountId}`,
        ok: withdrawn > 0n,
      },
    );
    report.freeze = {
      bounty: ids.slidingday,
      tx: refTx && refTx.tx_hash,
      refuter: sdb.winner,
      paid_yocto: refPaid.toString(),
      wallet: wallet.accountId,
      frozen_by: frozenByWallet[0] && frozenByWallet[0].by,
      gas: freezeGas,
      code_refuted_by: bcfgAfter.code_refuted_by,
      wallet_after: { frozen: polFrozen.frozen, board: polFrozen.board },
      refused_payment: {
        ...frozenPay,
        fresh_window: freshWindow,
        within_budget: withinBudget,
        state_unchanged: JSON.stringify(wsAfter) === JSON.stringify(wsF),
      },
      withdraw: { by_agent: verdictOf(agentOut), by_owner: verdictOf(aliceOut), amount_yocto: withdrawn.toString() },
      gates: { through_refuted_bounty: reason(sdFund), through_proved_bounty_of_refuted_code: reason(twFund) },
    };
    check(
      'C9',
      'Money moves only with a proof: the escrowed top-up reaches the wallet when its claim is proved, and nothing goes through a refuted claim',
      twb.phase === 'Paid' &&
        twb.certificate.side === 'proof' &&
        twb.escrow_state === 'released' &&
        released === near(tw.escrow_near) &&
        refused(sdFund, 'not_proven'),
      { escrow_state: twb.escrow_state, released: released.toString(), refuted: reason(sdFund) },
    );

    // ------------------------------------------------------------------ [10] all bounties
    console.log('\n[10] All bounties');
    const settled = {};
    for (const b of cfg.bounties.filter((x) => !x.unclaimed)) {
      const fb = final2.find((x) => x.id === ids[b.key]);
      settled[b.key] = fb;
      const tx = acceptedTx(fb.id);
      const amount = tx && fb.winner ? paidTo(tx, board.accountId, fb.winner) : 0n;
      say(
        `#${fb.id} ${b.claim.padEnd(34)} ${fb.phase.padEnd(5)} side=${fb.certificate ? fb.certificate.side.padEnd(10) : '-'} to ${fb.winner} (${fmt(amount)} NEAR), checked in ${tx ? tx.kernel_tgas.toFixed(1) : '?'} TGas`,
      );
      report.bounties[b.key].settled = {
        winner: fb.winner,
        side: fb.certificate && fb.certificate.side,
        paid: amount.toString(),
        kernel_tgas: tx && tx.kernel_tgas,
      };
    }
    check(
      'C10',
      'The other proofs are paid, and the counterexample is paid on the refutation side',
      settled.nonce.phase === 'Paid' &&
        settled.nonce.certificate.side === 'proof' &&
        settled.slidingday.phase === 'Paid' &&
        settled.slidingday.certificate.side === 'refutation' &&
        settled.slidingday.certificate.proved === 'Wallet.Claim.Refute.SlidingDayCap' &&
        report.bypass.total_near > 6,
      { nonce: settled.nonce.certificate, slidingday: settled.slidingday.certificate, bypass: report.bypass },
    );

    check(
      'C16',
      "Alive only while its rule is true: the transaction that pays the counterexample freezes the wallet the bounty is about; the agent's next payment, which the rules allow, is refused; only the owner takes money out; the board forwards nothing more to this code; before the refutation the same freeze was refused",
      refused(accuse, 'nothing_refuted') &&
        sdOpen.phase === 'Open' &&
        !sdOpen.certificate &&
        burst.every((x) => x.verdict === 'allow') &&
        !!refTx &&
        refPaid === BigInt(sdb.reward) + bond &&
        sdb.certificate.side === 'refutation' &&
        bcfgAfter.code_refuted_by === ids.slidingday &&
        bcfgAfter.kernel_broken_by === null &&
        frozenByWallet.length === 1 &&
        frozenByWallet[0].wallet === wallet.accountId &&
        frozenByWallet[0].by === board.accountId &&
        frozenByBoard.length === 1 &&
        frozenByBoard[0].wallet === wallet.accountId &&
        polFrozen.frozen === true &&
        freshWindow &&
        withinBudget &&
        frozenPay.verdict === 'frozen' &&
        frozenPay.transferred_yocto === '0' &&
        JSON.stringify(wsAfter) === JSON.stringify(wsF) &&
        verdictOf(agentOut) === 'DENY_CALLER' &&
        paidTo(agentOut, wallet.accountId, agent.accountId) === 0n &&
        verdictOf(aliceOut) === 'OK' &&
        withdrawn === outUnits * 10n ** 18n &&
        withdrawn > 0n &&
        refused(twFund, 'code_refuted'),
      report.freeze,
    );

    // ------------------------------------------------------------------ [11] any other wallet of the refuted code
    console.log(
      "\n[11] Bob's wallet runs the same code: anyone can freeze it through the board, which asks the factory first",
    );
    const bobBefore = await bobWallet.view('get_policy', {});
    const eveFreeze = await send(
      "eve freezes bob's wallet through the board",
      eve,
      board,
      'freeze',
      { wallet: bobWallet.accountId },
      0n,
      TGAS100,
    );
    const bobAfter = await bobWallet.view('get_policy', {});
    const bobPay2 = await send(
      "bob's wallet pays the shop 1 NEAR (frozen)",
      bob,
      bobWallet,
      'pay',
      { to: shop.accountId, amount: U(1) },
      0n,
      TGAS100,
    );
    const bobVerdict2 = (bobPay2.events.find((e) => e.data && e.data[0] && e.data[0].verdict) || { data: [{}] }).data[0]
      .verdict;
    const bobOutUnits = ((await balance(bobWallet)) - near('0.05')) / 10n ** 18n;
    const bobOut = await send(
      'bob withdraws from his frozen wallet',
      bob,
      bobWallet,
      'withdraw',
      { amount: bobOutUnits.toString() },
      0n,
      TGAS100,
    );
    const bobBack = paidTo(bobOut, bobWallet.accountId, bob.accountId);
    const again = await send(
      "eve freezes bob's wallet again",
      eve,
      board,
      'freeze',
      { wallet: bobWallet.accountId },
      0n,
      TGAS100,
    );
    const copyFreeze = await send(
      `eve asks the board to freeze the look-alike ${copycat.accountId}`,
      eve,
      board,
      'freeze',
      { wallet: copycat.accountId },
      0n,
      TGAS100,
    );
    const copyAfter = await copycat.view('get_policy', {});
    const direct = await send('eve calls freeze on a wallet herself', eve, bobWallet, 'freeze', {}, 0n, TGAS100);
    say(
      `board.freeze(${bobWallet.accountId}) by ${eve.accountId}: frozen ${bobBefore.frozen} -> ${bobAfter.frozen} (${eveFreeze.tgas.toFixed(1)} TGas); pay 1 NEAR (4 NEAR was allow before) -> ${bobVerdict2}; bob withdraws ${fmt(bobBack)} NEAR; freezing again -> ${again.success ? 'still frozen' : reason(again)}`,
    );
    say(
      `board.freeze(${copycat.accountId}) -> ${ev(copyFreeze, 'proof-courier', 'freeze_refused').length ? 'freeze_refused: not a factory wallet' : '?'}; eve calling the wallet's own freeze -> ${reason(direct)}`,
    );
    report.freeze.second_wallet = {
      wallet: bobWallet.accountId,
      frozen_by_call_from: eve.accountId,
      tx: eveFreeze.tx_hash,
      tgas: eveFreeze.tgas,
      before: bobBefore.frozen,
      after: bobAfter.frozen,
      pay_after: bobVerdict2,
      withdrawn_yocto: bobBack.toString(),
      freeze_again: again.success,
      lookalike: {
        account: copycat.accountId,
        outcome: ev(copyFreeze, 'proof-courier', 'freeze_refused')[0] || null,
        frozen: copyAfter.frozen,
      },
      direct_call: reason(direct),
    };
    check(
      'C17',
      'Any other wallet of the refuted code can be frozen by anyone through the board, which asks the factory first; its owner still takes the money out; a look-alike is not touched, and nobody but the board can freeze a wallet',
      bobBefore.frozen === false &&
        bobBefore.board === board.accountId &&
        eveFreeze.success &&
        bobAfter.frozen === true &&
        ev(eveFreeze, 'proof-courier', 'wallet_frozen').some((d) => d.wallet === bobWallet.accountId) &&
        ev(eveFreeze, 'proof-courier-wallet', 'wallet_frozen').some((d) => d.by === board.accountId) &&
        bobVerdict === 'allow' &&
        bobVerdict2 === 'frozen' &&
        paidTo(bobPay2, bobWallet.accountId, shop.accountId) === 0n &&
        bobBack === bobOutUnits * 10n ** 18n &&
        bobBack > 0n &&
        again.success &&
        ev(copyFreeze, 'proof-courier', 'freeze_refused').length === 1 &&
        copyAfter.frozen === false &&
        ev(copyFreeze, 'proof-courier', 'wallet_frozen').length === 0 &&
        refused(direct, 'ERR_FREEZE_NOT_BOARD'),
      report.freeze.second_wallet,
    );

    // ------------------------------------------------------------------ [12] registry
    console.log('\n[12] A settled question cannot be sold again');
    const later = (now0 + 86400n * 10n ** 9n).toString();
    const again1 = await send(
      'alice posts the headline claim again',
      alice,
      board,
      'post_bounty',
      {
        claim: head.claim,
        counter_claim: head.counter_claim,
        title: 'again',
        deadline: later,
        subject: null,
        escrow: null,
      },
      near('1.1'),
    );
    const again2 = await send(
      'eve posts the refuted claim again',
      eve,
      board,
      'post_bounty',
      {
        claim: sd.claim,
        counter_claim: sd.counter_claim,
        title: 'again',
        deadline: later,
        subject: null,
        escrow: null,
      },
      near('1.1'),
    );
    say(`re-posting ${head.claim} -> ${reason(again1)}; re-posting the refuted claim -> ${reason(again2)}`);
    check(
      'C11',
      'The board refuses a bounty for a claim it has already settled, and points to the certificate',
      refused(again1, `already_settled:${hid}`) &&
        refused(again2, `already_settled:${ids.slidingday}`) &&
        (await board.view('settled_by', { name: head.claim })) === hid,
      {},
    );

    // ------------------------------------------------------------------ [13] expiry
    const lapsed = cfg.bounties.find((b) => b.unclaimed);
    const lid = ids[lapsed.key];
    console.log(
      `\n[13] Nobody settles ${lapsed.claim} before its deadline (no agent in this run was given it): Alice gets her money back`,
    );
    const early = await send('alice refunds before the deadline', alice, board, 'refund', { id: lid }, 0n, TGAS100);
    const earlyBoost = await send(
      'carol takes her boost back before the deadline',
      carol,
      board,
      'withdraw_boost',
      { id: lid },
      0n,
      TGAS100,
    );
    const lb = await board.view('get_bounty', { id: lid });
    await advanceTo(BigInt(lb.deadline) + BigInt(bcfg.grace_seconds) * 10n ** 9n + 10n ** 9n);
    // Anyone may close an expired bounty (so nobody can hold a claim past deadline + grace); the money goes to the poster.
    const ok3 = await send('eve closes the expired bounty', eve, board, 'refund', { id: lid }, 0n, TGAS100);
    const twice = await send('alice refunds it again', alice, board, 'refund', { id: lid }, 0n, TGAS100);
    const back = paidTo(ok3, board.accountId, alice.accountId);
    const toEve = paidTo(ok3, board.accountId, eve.accountId);
    say(
      `refund before the deadline: ${reason(early)}; after it, eve closes the bounty: ${fmt(back)} NEAR to Alice (her own reward, not carol's part), ${fmt(toEve)} to eve; again: ${reason(twice)}`,
    );
    const wb = await send('carol takes her boost back', carol, board, 'withdraw_boost', { id: lid }, 0n, TGAS100);
    const wb2 = await send('carol takes it back twice', carol, board, 'withdraw_boost', { id: lid }, 0n, TGAS100);
    const boostBack = paidTo(wb, board.accountId, carol.accountId);
    const headWithdraw = await send(
      'carol tries to take back her boost of the settled headline bounty',
      carol,
      board,
      'withdraw_boost',
      { id: hid },
      0n,
      TGAS100,
    );
    say(
      `carol, before the deadline: ${reason(earlyBoost)}; after: ${fmt(boostBack)} NEAR back; twice: ${reason(wb2)}; from the paid headline bounty: ${reason(headWithdraw)} (it went to the winner)`,
    );
    check(
      'C12',
      'An unclaimed reward stays locked until the deadline plus grace; then anyone may close the bounty, the poster gets its reward exactly once, and a pooled part goes back to whoever added it',
      refused(early, 'not_expired') &&
        ok3.success &&
        back === near(lapsed.reward_near) &&
        toEve === 0n &&
        refused(twice, 'not_refundable') &&
        refused(earlyBoost, 'not_expired') &&
        boostBack === near('0.5') &&
        refused(wb2, 'no_boost') &&
        refused(headWithdraw, 'settled') &&
        (await board.view('get_bounty', { id: lid })).phase === 'Refunded',
      { refund: back.toString(), boost_back: boostBack.toString() },
    );

    // ------------------------------------------------------------------ [14] the fix, proved
    const fx = cfg.fix;
    console.log(
      `\n[14] The fix: v2 carries the old window's spending; a bounty for the same claim about v2 is proved, and the bypass stops`,
    );
    const factory2 = await make('walletsv2', 12);
    await keyless(
      factory2,
      factoryWasm,
      'new',
      { wallet_code: walletV2Wasm.toString('base64'), board: `boardv2.${rootAcc.accountId}` },
      '300000000000000',
    );
    await advance(3);
    const board2 = await make('boardv2', 5);
    await keyless(board2, boardWasm, 'new', {
      kernel: kernel.accountId,
      base_hash: shelf.base_sha256,
      factory: factory2.accountId,
      wallet_code_hash: sha(walletV2Wasm),
      claims: [{ claim: fx.claim, counter: fx.counter_claim }],
      reveal_delay_blocks: String(bc.reveal_delay_blocks),
      min_reveal_gas_tgas: String(bc.min_reveal_gas_tgas),
      reveal_bond: near(bc.reveal_bond_near).toString(),
      grace_seconds: String(bc.grace_seconds),
      stale_blocks: String(bc.stale_blocks),
    });
    const made2 = await send(
      'alice creates a v2 wallet with the same policy',
      alice,
      factory2,
      'create_wallet',
      { name: 'alice', agent: agent.accountId, policy },
      near('0.05'),
      '100000000000000',
    );
    const wallet2 = factory2.getSubAccount('alice');
    const meta2 = await wallet2.view('get_code_meta', {});
    say(
      `${factory2.accountId} publishes wallet-v2 (${sha(walletV2Wasm).slice(0, 16)}…, rules ${meta2.rules}, same Lean sources ${meta2.lean_src_sha256.slice(0, 16)}…); ${wallet2.accountId} created; ${board2.accountId} pinned to it`,
    );
    const fdeadline = ((await nowNs()) + BigInt(fx.deadline_minutes) * 60n * 10n ** 9n).toString();
    // Each board takes bounties only for the claims about its own wallet code.
    const v2onV1 = await send(
      'a bounty about the v2 claim on the v1 board',
      bogus,
      board,
      'post_bounty',
      {
        claim: fx.claim,
        counter_claim: fx.counter_claim,
        title: 'x',
        deadline: fdeadline,
        subject: null,
        escrow: null,
      },
      near('1.1'),
    );
    const v1onV2 = await send(
      'a bounty about a v1 claim on the v2 board',
      bogus,
      board2,
      'post_bounty',
      {
        claim: head.claim,
        counter_claim: head.counter_claim,
        title: 'x',
        deadline: fdeadline,
        subject: null,
        escrow: null,
      },
      near('1.1'),
    );
    say(`the v2 claim on the v1 board -> ${reason(v2onV1)}; a v1 claim on the v2 board -> ${reason(v1onV2)}`);
    const fpost = await send(
      'alice posts the bounty for the fix, with a 10 NEAR top-up for her v2 wallet',
      alice,
      board2,
      'post_bounty',
      {
        claim: fx.claim,
        counter_claim: fx.counter_claim,
        title: fx.title,
        deadline: fdeadline,
        subject: wallet2.accountId,
        escrow: near(fx.escrow_near).toString(),
      },
      near(fx.reward_near) + near('0.1') + near(fx.escrow_near),
    );
    const fid = (await board2.view('list_bounties', {}))[0].id;
    // The paid counterexample to v1 is not a counterexample to v2: the kernel says so for free.
    const oldCex = read(path.join(ROOT, 'evidence/demo/live-solve-SlidingDayCap-sonnet/delta.ndjson'));
    const oldOnV2 = await kernel.view('dry_run', { theorem_name: fx.counter_claim, delta: oldCex.toString() });
    say(
      `the v1 counterexample, checked for free against ${fx.counter_claim}: ${oldOnV2.ok ? 'ACCEPTED (!)' : 'refused, ' + String(oldOnV2.reason).slice(0, 60)}`,
    );
    // An agent proves the fix.
    const fsol = {};
    for (const [name, dir] of Object.entries(fx.courier.solutions)) {
      const rep = JSON.parse(read(path.join(dir, 'report.json')));
      fsol[name] = {
        delta: path.join(ROOT, dir, 'delta.ndjson'),
        model: rep.agent.model,
        seconds: rep.agent.seconds,
        cost_usd: rep.agent.cost_usd,
      };
    }
    const fixAcct = couriers.find((k) => k.cfg.account === fx.courier.account).acct;
    const fixer = new Courier({
      name: fx.courier.account,
      accountId: fixAcct.accountId,
      board: board2.accountId,
      kernel: kernel.accountId,
      solutions: fsol,
      log: say,
      height,
      view: (contract, method, a) => (contract === kernel.accountId ? kernel : board2).view(method, a),
      call: (contract, method, a, o) =>
        send(
          `${fx.courier.account} ${method} (v2 board)`,
          fixAcct,
          contract === board2.accountId ? board2 : kernel,
          method,
          a,
          o.deposit || 0n,
          String(o.gas || PGAS),
        ),
    });
    await fixer.round();
    await advance(delay + 2);
    await fixer.revealDue();
    const fb = await board2.view('get_bounty', { id: fid });
    const fixTx = report.transactions
      .filter(
        (x) =>
          x.method === 'reveal' &&
          x.receiver === board2.accountId &&
          x.events.some((e) => e.event === 'proof_accepted'),
      )
      .pop();
    const fixReleased = fixTx ? paidTo(fixTx, board2.accountId, wallet2.accountId) : 0n;
    say(
      `#${fid} on ${board2.accountId}: ${fb.phase}, side=${fb.certificate && fb.certificate.side}, by ${fb.winner}; checked in ${fixTx ? fixTx.kernel_tgas.toFixed(0) : '?'} TGas; escrow ${fb.escrow_state}: ${fmt(fixReleased)} NEAR to ${wallet2.accountId}`,
    );
    // The same split-payment trick, on the v2 wallet.
    const pays2 = [];
    const pay2 = async (label, amount) => {
      const t = await send(label, agent, wallet2, 'pay', { to: vendor.accountId, amount: U(amount) }, 0n, TGAS100);
      const ev = t.events.find((e) => e.data && e.data[0] && e.data[0].verdict);
      const pr = {
        label,
        amount_near: amount,
        verdict: ev ? ev.data[0].verdict : null,
        at_ns: (await nowNs()).toString(),
      };
      pays2.push(pr);
      return pr;
    };
    await pay2('agent pays the vendor 1 NEAR (opens a window)', 1);
    let ws2 = await wallet2.view('get_state', {});
    const dayNs2 = DAY_S * 10n ** 9n;
    const start2 = BigInt(ws2.day_start),
      boundary2 = start2 + dayNs2;
    await advanceTo(boundary2, { slack: 20n * 10n ** 9n });
    await pay2('agent pays 3 NEAR just before the window ends', 3);
    await pay2('agent pays 2 NEAR just before the window ends', 2);
    await advanceTo(boundary2);
    await pay2('agent pays 3 NEAR right after it rolls over', 3);
    await pay2('agent pays 3 NEAR more', 3);
    const lastBurst = pays2.slice(1);
    const burstAllowed = lastBurst.filter((x) => x.verdict === 'allow').reduce((a, x) => a + x.amount_near, 0);
    const burstSpan = Number(BigInt(lastBurst[lastBurst.length - 1].at_ns) - BigInt(pays2[0].at_ns)) / 1e9;
    const allowedInDay = pays2.filter((x) => x.verdict === 'allow').reduce((a, x) => a + x.amount_near, 0);
    await advanceTo(start2 + 2n * dayNs2);
    await pay2('two windows later: agent pays 3 NEAR', 3);
    for (const x of pays2) say(`${x.label.padEnd(46)} -> ${x.verdict}`);
    say(
      `v1 let 11 NEAR out in 25 seconds; v2 allowed ${allowedInDay} NEAR across the same window boundary (${burstSpan.toFixed(0)} s), and pays again two windows later.`,
    );
    report.fix = {
      factory: factory2.accountId,
      board: board2.accountId,
      wallet: wallet2.accountId,
      wallet_v2_sha256: sha(walletV2Wasm),
      rules: meta2.rules,
      bounty: {
        id: fid,
        claim: fx.claim,
        phase: fb.phase,
        winner: fb.winner,
        certificate: fb.certificate,
        kernel_tgas: fixTx && fixTx.kernel_tgas,
        escrow_released: fixReleased.toString(),
      },
      old_counterexample_on_v2: { ok: oldOnV2.ok, reason: oldOnV2.reason },
      payments: pays2,
      allowed_in_day_near: allowedInDay,
      per_day_cap_near: 6,
      courier: fixer.ledger(gasPrice),
    };
    check(
      'C14',
      'The fix: the bounty for the same claim about the v2 wallet is proved (the paid v1 counterexample does not refute it), and the same bypass on a v2 wallet stops at the daily cap',
      made2.success &&
        fpost.success &&
        meta2.rules === 'v2' &&
        !oldOnV2.ok &&
        refused(v2onV1, 'claim_not_on_this_board') &&
        refused(v1onV2, 'claim_not_on_this_board') &&
        fb.phase === 'Paid' &&
        fb.certificate &&
        fb.certificate.side === 'proof' &&
        fb.certificate.proved === fx.claim &&
        fb.escrow_state === 'released' &&
        fixReleased === near(fx.escrow_near) &&
        allowedInDay <= 6 &&
        lastBurst.slice(-2).every((x) => x.verdict === 'denyDaily') &&
        pays2[pays2.length - 1].verdict === 'allow' &&
        (await keys(wallet2.accountId)).length === 0 &&
        (await viewAccount(wallet2.accountId)).global_contract_hash === codeHash(walletV2Wasm),
      report.fix,
    );

    // ------------------------------------------------------------------ [15] back under an agent, only with a proof
    console.log(
      '\n[15] What Alice took out of the frozen v1 wallet goes back under an agent only through the proved v2 bounty',
    );
    const v2Fund = await send(
      'alice funds her v2 wallet through the proved v2 bounty',
      alice,
      board2,
      'fund_if_proven',
      { id: fid },
      withdrawn,
      TGAS100,
    );
    const v2Got = paidTo(v2Fund, board2.accountId, wallet2.accountId);
    const v2Pay = await send(
      'agent pays the vendor 1 NEAR from the v2 wallet',
      agent,
      wallet2,
      'pay',
      { to: vendor.accountId, amount: U(1) },
      0n,
      TGAS100,
    );
    const v2Verdict = (v2Pay.events.find((e) => e.data && e.data[0] && e.data[0].verdict) || { data: [{}] }).data[0]
      .verdict;
    const v2Accuse = await send(
      'eve asks the v2 board to freeze the v2 wallet',
      eve,
      board2,
      'freeze',
      { wallet: wallet2.accountId },
      0n,
      TGAS100,
    );
    const pol2 = await wallet2.view('get_policy', {}),
      polV1 = await wallet.view('get_policy', {}),
      bcfg2 = await board2.view('get_config', {});
    say(
      `fund_if_proven(#${fid}) on ${board2.accountId} with ${fmt(withdrawn)} NEAR -> ${fmt(v2Got)} NEAR to ${wallet2.accountId}; the agent pays 1 NEAR from it -> ${v2Verdict}`,
    );
    say(
      `${wallet.accountId} is still frozen: ${polV1.frozen}; nothing unfreezes it. eve asks ${board2.accountId} to freeze the v2 wallet -> ${reason(v2Accuse)} (no claim about v2 is refuted)`,
    );
    report.money_path.push({
      when: `after #${fid} was proved on ${board2.accountId}`,
      what: 'Alice funds her v2 wallet through the proved v2 bounty with what she took out of the frozen v1 wallet',
      outcome: `${fmt(v2Got)} NEAR to ${wallet2.accountId}`,
      ok: v2Got > 0n,
    });
    report.freeze.return_path = {
      board: board2.accountId,
      bounty: fid,
      to: wallet2.accountId,
      amount_yocto: v2Got.toString(),
      agent_pay_verdict: v2Verdict,
      v1_wallet_still_frozen: polV1.frozen,
      v2_wallet_frozen: pol2.frozen,
      freeze_v2_without_a_refutation: reason(v2Accuse),
    };
    check(
      'C18',
      'Nothing unfreezes a wallet: the money its owner took out goes back under an agent only through fund_if_proven on the board where the claim is proved, and that wallet cannot be frozen on an accusation',
      v2Fund.success &&
        withdrawn > 0n &&
        v2Got === withdrawn &&
        v2Verdict === 'allow' &&
        polV1.frozen === true &&
        pol2.frozen === false &&
        pol2.board === board2.accountId &&
        refused(v2Accuse, 'nothing_refuted') &&
        bcfg2.code_refuted_by === null &&
        bcfg2.kernel_broken_by === null,
      report.freeze.return_path,
    );

    // ------------------------------------------------------------------ ledgers and cost
    const balancesAfter = await Promise.all(couriers.map((k) => balance(k.acct)));
    report.couriers = couriers.map((k, i) => ({
      agent: k.cfg.account,
      ledger: k.c.ledger(gasPrice),
      balance_change_near: fmt(balancesAfter[i] - balancesBefore[i]),
      llm_usd_spent_writing_its_proofs:
        Object.values(k.solutions).reduce((a, s) => a + s.cost_usd, 0) + k.c.book.llm_usd,
    }));
    console.log('\n      agent          earned   spent (gas, fees, bonds)   balance change   LLM cost of its proofs');
    for (const c of report.couriers)
      say(
        `${c.agent.padEnd(14)} ${c.ledger.earned_near.toFixed(3).padStart(6)}   ${(c.ledger.gas_near + c.ledger.fees_near + c.ledger.bonds_near).toFixed(3).padStart(6)}                     ${c.balance_change_near.padStart(7)} NEAR     USD ${c.llm_usd_spent_writing_its_proofs.toFixed(2)}`,
      );
    report.board_final = await board.view('list_bounties', {});
    report.kernel = {
      account: kernel.accountId,
      status: await kernel.view('status', {}),
      name: await kernel.view('kernel_name', {}),
    };
    report.costs.storage = {};
    for (const a of [kernel, board, factory, wallet]) {
      const v = await viewAccount(a.accountId);
      report.costs.storage[a.accountId] = {
        bytes: v.storage_usage,
        staked_near: fmt(BigInt(v.storage_usage) * 10n ** 19n),
      };
    }
    const accepted = report.transactions.filter(
      (x) => x.method === 'reveal' && x.events.some((e) => e.event === 'proof_accepted'),
    );
    report.costs.check_tgas_range = [
      Math.min(...accepted.map((x) => x.kernel_tgas)),
      Math.max(...accepted.map((x) => x.kernel_tgas)),
    ];
    report.costs.check_near_max = fmt(BigInt(Math.round(report.costs.check_tgas_range[1] * 1e12)) * gasPrice);
    report.costs.gas_price_yocto = gasPrice.toString();
    const maxCheck = Math.max(...report.transactions.filter((x) => x.method === 'reveal').map((x) => x.kernel_tgas));
    check(
      'C15',
      "Cost: the shelf is paid once; each proof check is a fraction of one call's 1,000 TGas limit",
      report.costs.shelf.tgas > 0 && maxCheck < 1000,
      report.costs,
    );
    say(
      `shelf, once: ${report.costs.shelf.tgas.toFixed(0)} TGas (${report.costs.shelf.near} NEAR)  |  accepted proof checks: ${report.costs.check_tgas_range.map((x) => x.toFixed(0)).join('–')} TGas (≤ ${report.costs.check_near_max} NEAR)`,
    );
  } finally {
    report.finished_at = new Date().toISOString();
    report.summary = { pass: checks.filter((c) => c.ok).length, fail: checks.filter((c) => !c.ok).length };
    save();
    await worker.tearDown();
  }
  console.log(
    `\n${report.summary.pass}/${checks.length} claims PASS. Full record: ${path.relative(process.cwd(), OUT)}`,
  );
  if (report.summary.fail) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  report.error = String((e && e.stack) || e);
  save();
  process.exit(1);
});
