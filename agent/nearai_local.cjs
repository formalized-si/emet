// Take proofs written by a NEAR AI Cloud model through the kernel contract on a local NEAR node, the way
// any agent claims a bounty: a fresh chain, the kernel with the sealed shelf, the wallet factory, the board,
// the five bounties of demo/bounties.json, and one courier (agent/courier.cjs) that holds only the given
// proofs: commit, free dry_run on the kernel, wait the reveal delay, reveal with the bond. Local only.
//
// usage: node agent/nearai_local.cjs <out.json> <agent evidence dir>...      (each has report.json and delta.ndjson)
//        A board pays one proof per claim, so two proofs of the same claim go to two fresh chains, one after the other.
//        NEAR_SANDBOX_BIN_PATH must point at near-sandbox and NEAR_SANDBOX_BINARY_PATH at its directory (a ./verify.sh mode that runs a local node, such as --rehearse, downloads it into .sandbox/2.14.0/).
const localNode = require('../tools/local-node.cjs');
const fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');
const { Courier } = require('./courier.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || 'run-output/nearai-local.json');
const dirs = process.argv.slice(3);
if (!dirs.length) {
  console.error('usage: node agent/nearai_local.cjs <out.json> <agent evidence dir>...');
  process.exit(64);
}
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo/bounties.json')));
const NEAR = 10n ** 24n,
  TGAS = 10n ** 12n;
const near = (x) => BigInt(Math.round(Number(x) * 1e6)) * (NEAR / 1000000n);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const read = (p) => fs.readFileSync(path.join(ROOT, p));

const shelf = JSON.parse(read(path.join(cfg.shelf, 'manifest.json')));
const wasm = {
  kernel: read(cfg.kernel_wasm),
  board: read(cfg.board_wasm),
  factory: read(cfg.factory_wasm),
  wallet: read(cfg.wallet_wasm),
};

// One fresh chain; `proofs` holds at most one proof per claim. Returns what happened to each.
async function chain(proofs) {
  const solutions = Object.fromEntries(
    proofs.map((p) => [p.claim, { delta: path.join(ROOT, p.dir, 'delta.ndjson'), model: p.model }]),
  );
  const out = {};
  const worker = await localNode('nearai-local');
  try {
    const root = worker.rootAccount,
      rpc = worker.provider;
    const st = await rpc.status();
    out.node = { version: st.version, protocol: st.protocol_version };
    const height = async () => (await rpc.block({ finality: 'final' })).header.height;
    const make = (name, amount) => root.createSubAccount(name, { initialBalance: near(amount).toString() });
    const must = (r, what) => {
      const f = r.result.receipts_outcome.filter((x) => x.outcome.status.Failure);
      if (f.length) throw Error(`${what}: ${JSON.stringify(f[0].outcome.status.Failure)}`);
      return r;
    };
    const keyless = async (acct, code, method, args) => {
      const key = await acct.getKey();
      must(
        await acct
          .batch(acct)
          .deployContract(code)
          .functionCall(method, args, { gas: (300n * TGAS).toString() })
          .deleteKey(key.getPublicKey())
          .transact(),
        'deploy ' + acct.accountId,
      );
    };
    const call = async (who, target, method, args, deposit = 0n, gas = 300n * TGAS) =>
      must(
        await who.callRaw(target, method, args, { gas: gas.toString(), attachedDeposit: deposit.toString() }),
        `${method} on ${target.accountId}`,
      );

    // The deployment: kernel + shelf (checked on-chain), factory, board, a wallet, the bounties.
    const keeper = await make('keeper', 4),
      kernel = await make('kernel', 11.5);
    await keyless(kernel, wasm.kernel, 'init', { owner: keeper.accountId });
    for (const c of shelf.chunks) await call(keeper, kernel, 'load_base_chunk', read(path.join(cfg.shelf, c)));
    await call(
      keeper,
      kernel,
      'seal_base',
      { expected_sha256: shelf.base_sha256, expected_decl_count: shelf.base_decls },
      0n,
      1000n * TGAS,
    );
    for (let from = 0, span = 256; from < shelf.base_decls; ) {
      const to = Math.min(shelf.base_decls, from + span);
      try {
        await call(root, kernel, 'check_base_range', { from, to }, 0n, 1000n * TGAS);
        from = to;
      } catch (e) {
        if (span === 1) throw e;
        span = Math.max(1, span >> 1);
      }
    }
    const ks = await kernel.view('status', {});
    if (!ks.sealed || ks.checked_upto !== shelf.base_decls) throw Error('shelf not checked: ' + JSON.stringify(ks));
    console.log(
      `kernel ${kernel.accountId}: shelf ${shelf.base_sha256.slice(0, 16)}… sealed, ${ks.checked_upto} declarations checked on-chain`,
    );
    const factory = await make('wallets', 10),
      board = await make('board', 4),
      alice = await make('alice', 40),
      vendor = await make('vendor', 0.1);
    await keyless(factory, wasm.factory, 'new', {
      wallet_code: wasm.wallet.toString('base64'),
      board: `board.${root.accountId}`,
    });
    const b = cfg.board;
    await keyless(board, wasm.board, 'new', {
      kernel: kernel.accountId,
      base_hash: shelf.base_sha256,
      factory: factory.accountId,
      wallet_code_hash: sha(wasm.wallet),
      claims: cfg.bounties.map((x) => ({ claim: x.claim, counter: x.counter_claim })),
      reveal_delay_blocks: String(b.reveal_delay_blocks),
      min_reveal_gas_tgas: String(b.min_reveal_gas_tgas),
      reveal_bond: near(b.reveal_bond_near).toString(),
      grace_seconds: String(b.grace_seconds),
      stale_blocks: String(b.stale_blocks),
    });
    const U = (n) => String(Math.round(n * 1e6));
    await call(
      alice,
      factory,
      'create_wallet',
      {
        name: 'alice',
        agent: alice.accountId,
        policy: {
          budget: U(20),
          per_tx: U(3),
          per_day: U(6),
          day_ns: (86400n * 10n ** 9n).toString(),
          allowed: [vendor.accountId],
        },
      },
      near('0.05'),
    );
    const wallet = factory.getSubAccount('alice');
    const deadline = (
      BigInt((await rpc.block({ finality: 'final' })).header.timestamp_nanosec) +
      24n * 3600n * 10n ** 9n
    ).toString();
    for (const x of cfg.bounties) {
      await call(
        alice,
        board,
        'post_bounty',
        {
          claim: x.claim,
          counter_claim: x.counter_claim,
          title: x.title,
          deadline,
          subject: wallet.accountId,
          escrow: null,
        },
        near(x.reward_near) + near('0.1'),
        1000n * TGAS,
      );
    }
    console.log(
      `board ${board.accountId}: ${(await board.view('list_bounties', {})).filter((x) => x.phase === 'Open').length} bounties open`,
    );

    // The courier: its own account, only the NEAR AI proofs. Its transport is the one demo/scenario.cjs gives its couriers.
    const acct = await make('nearai-agent', 8);
    const txs = [];
    const send = async (contract, method, args, o) => {
      const r = await acct.callRaw(contract === board.accountId ? board : kernel, method, args, {
        gas: String(o.gas || 1000n * TGAS),
        attachedDeposit: String(o.deposit || 0n),
      });
      const raw = await rpc.sendJsonRpc('EXPERIMENTAL_tx_status', {
        tx_hash: r.result.transaction.hash,
        sender_account_id: acct.accountId,
        wait_until: 'FINAL',
      });
      const outcomes = new Map(raw.receipts_outcome.map((x) => [x.id, x]));
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
      const gas = (f) => raw.receipts_outcome.filter(f).reduce((a, x) => a + Number(x.outcome.gas_burnt), 0) / 1e12;
      const row = {
        method,
        tx_hash: r.result.transaction.hash,
        success: failures.length === 0 && 'SuccessValue' in raw.status,
        failures,
        transfers,
        tgas: gas(() => true) + Number(raw.transaction_outcome.outcome.gas_burnt) / 1e12,
        kernel_tgas: gas((x) => x.outcome.executor_id === kernel.accountId),
      };
      txs.push(row);
      return row;
    };
    const courier = new Courier({
      name: 'nearai-agent',
      accountId: acct.accountId,
      board: board.accountId,
      kernel: kernel.accountId,
      solutions,
      log: console.log,
      height,
      view: (contract, method, a) => (contract === kernel.accountId ? kernel : board).view(method, a),
      call: send,
    });
    await courier.round();
    const target = (await height()) + Number(b.reveal_delay_blocks) + 2;
    await rpc.fastForward(Number(b.reveal_delay_blocks) + 2); // local chain only
    while ((await height()) < target) await new Promise((r) => setTimeout(r, 200));
    await courier.revealDue();

    const bounties = await board.view('list_bounties', {});
    out.results = proofs.map((p) => {
      const bo = bounties.find((x) => x.claim === p.claim || x.counter_claim === p.claim);
      const c = courier.commits.find((x) => x.name === p.claim);
      const d = courier.book.decisions.find((x) => x.name === p.claim);
      const cert = bo && bo.certificate;
      const ok = !!(
        bo &&
        bo.phase === 'Paid' &&
        bo.winner === acct.accountId &&
        cert &&
        cert.proved === p.claim &&
        cert.delta_sha256 === p.delta_sha256 &&
        cert.base_hash === shelf.base_sha256
      );
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${p.claim} (${p.model}): dry_run ${d && d.dry_run_ok ? 'ok' : (d && d.decision) || 'not tried'}; ${bo ? bo.phase : 'no bounty'}${c && c.result ? `, kernel ${c.result.kernel_tgas.toFixed(0)} TGas, received ${c.result.received_near} NEAR` : ''}`,
      );
      return {
        ...p,
        accepted_by_kernel_contract: ok,
        decision: d,
        bounty: bo && { id: bo.id, phase: bo.phase, winner: bo.winner, certificate: cert },
        reveal: c && c.result,
      };
    });
    out.transactions = txs;
    out.ledger = courier.ledger();
    return out;
  } finally {
    await worker.tearDown();
  }
}

(async () => {
  const groups = [];
  for (const d of dirs) {
    const rep = JSON.parse(fs.readFileSync(path.join(d, 'report.json')));
    if (!rep.ready_to_claim) {
      console.log(`skip ${d}: not ready to claim`);
      continue;
    }
    const delta = fs.readFileSync(path.join(d, 'delta.ndjson'));
    const p = {
      claim: rep.claim,
      dir: path.relative(ROOT, path.resolve(d)),
      model: rep.agent.model,
      delta_bytes: delta.length,
      delta_sha256: sha(delta),
    };
    let g = groups.find((x) => !x.some((q) => q.claim === p.claim));
    if (!g) groups.push((g = []));
    g.push(p);
  }
  const out = {
    kind: 'nearai-proofs-on-a-local-node',
    started_at: new Date().toISOString(),
    code_sha256: {
      kernel: sha(wasm.kernel),
      board: sha(wasm.board),
      factory: sha(wasm.factory),
      wallet: sha(wasm.wallet),
    },
    shelf_sha256: shelf.base_sha256,
    chains: [],
  };
  for (const g of groups) out.chains.push(await chain(g));
  out.node = out.chains[0] && out.chains[0].node;
  out.results = out.chains.flatMap((c) => c.results);
  out.ok = out.results.length > 0 && out.results.every((r) => r.accepted_by_kernel_contract);
  out.finished_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(
    out.ok
      ? `all ${out.results.length} proof(s) accepted by the kernel contract and paid by the board (record: ${path.relative(process.cwd(), OUT)})`
      : 'not every proof was accepted; see the record',
  );
  if (!out.ok) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
