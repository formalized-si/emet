// Failure paths on a local NEAR node: what the board and the factory do when a transfer fails.
//
//  F1  The winner deletes its account right after revealing, so the reward transfer fails: the bounty
//      stays `Owed` (nothing is lost, nothing is paid twice); once the account exists again, anyone's
//      `retry_payment` pays it, exactly once.
//  F2  The poster of a bounty with an escrow deletes its account, then the claim is refuted, so the
//      escrow cannot go back: it stays `held`; once the poster exists again, `retry_escrow` returns it.
//  F3  `create_wallet` with a policy the wallet refuses: the setup fails as a whole, no wallet exists,
//      and the whole deposit comes back.
//  F4  The double-escrow attack an independent review found in an earlier board: post a bounty with an
//      escrow for a wallet the factory will reject, and call `retry_escrow` while the bounty is still being
//      validated. Now refused; the poster gets reward + escrow back once, and the posting fee stays.
//  F5  Found by a second review: retrying an old bounty's refund used to free the claim name a newer bounty
//      had taken, so the same claim could be paid twice. Now a bounty frees only names it still holds.
//  F6  Found by the same review: the refund of a refused post was a single unobserved transfer. Now it goes
//      through the same retryable paths as an expired bounty (`refund`, `retry_escrow`).
//  F7  Found by the Lean Kernel Arena's tests of 2026-11-10 (bugs/rec-rule-proof-irrel and -nested): a proof
//      of `False` built on one forged rule of a recursor, stated as a proof of the headline claim. The
//      kernel contract accepted both with nanoda_lib 0.4.31; with 0.4.32 the check fails in the kernel.
//  F8  A counterexample that arrives after its bounty was closed (expired and refunded): the reveal is refused,
//      nobody is paid, the code is not recorded refuted, and nothing can be frozen: not on an accusation either.
//  F9  The same counterexample twice: two accounts reveal a refutation at the same moment. One is paid, once,
//      and that transaction freezes the wallet; the other gets its bond back; neither can reveal or commit again.
//  F10 A freeze that fails: the wallet's factory named another account as its board, so the wallet refuses the
//      freeze. The refutation is still paid once and the escrow returned once; sending the freeze again moves no
//      money. And the board refuses to freeze an account its factory does not know.
//  F11 The root bounty on `False`, on the current kernel: the two forged-recursor proofs of `False` in
//      cheats/deltas/ fail in the kernel, an honest proof of another statement is not a proof of `False`, and
//      the bounty stays open with its reward (plus the forfeited bonds).
//  F12 WHAT-IF, with the superseded kernel binary (nanoda_lib 0.4.31, artifacts/kernel.wasm as it was before the update of 11 November,
//      kept in history/kernel-nanoda-0.4.31/): the same forged proofs against a board pinned to that kernel.
//      The root bounty is paid, once; the board records its kernel broken; after that it posts, commits, reveals,
//      boosts and funds nothing, an open bounty's reward, escrow and boost go back at once, and anyone can
//      freeze the factory's wallets. No board in artifacts/ is pinned to this kernel.
// Not exercised: `clear_stale` (a kernel check whose callback never runs; the callback has its own
// reserved gas, so this run cannot make it happen).
//
// usage: node demo/faults.cjs [output.json]      (./verify.sh --faults sets up the sandbox binary)
const localNode = require('../tools/local-node.cjs');
const { InMemoryKeyStore } = require('@near-js/keystores');
const { InMemorySigner } = require('@near-js/signers');
const { createTransaction, signTransaction, actionCreators } = require('@near-js/transactions');
const { baseDecode, baseEncode } = require('@near-js/utils');
const fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo/bounties.json')));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'run-output/faults.json'));
const NEAR = 10n ** 24n,
  PGAS = '1000000000000000',
  TGAS100 = '100000000000000';
const near = (s) => BigInt(Math.round(Number(s) * 1000)) * (NEAR / 1000n);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const read = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p));
const report = { kind: 'proof-courier-faults', started_at: new Date().toISOString(), checks: [], transactions: [] };
const save = () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
};
function check(id, title, ok, detail) {
  report.checks.push({ id, title, pass: !!ok, detail });
  save();
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${title}`);
}
const say = (s) => console.log('      ' + s);

async function main() {
  const shelf = JSON.parse(read(path.join(cfg.shelf, 'manifest.json')));
  const kernelWasm = read(cfg.kernel_wasm),
    boardWasm = read(cfg.board_wasm),
    walletWasm = read(cfg.wallet_wasm),
    factoryWasm = read(cfg.factory_wasm);
  const SUPERSEDED_KERNEL = 'history/kernel-nanoda-0.4.31/kernel.wasm'; // artifacts/kernel.wasm as it was before the update to nanoda 0.4.32; used by F12 only
  const oldKernelWasm = read(SUPERSEDED_KERNEL);
  report.inputs = {
    kernel_wasm_sha256: sha(kernelWasm),
    board_wasm_sha256: sha(boardWasm),
    wallet_wasm_sha256: sha(walletWasm),
    factory_wasm_sha256: sha(factoryWasm),
    shelf_sha256: shelf.base_sha256,
    superseded_kernel_wasm: SUPERSEDED_KERNEL,
    superseded_kernel_wasm_sha256: sha(oldKernelWasm),
  };
  const worker = await localNode('faults');
  try {
    const root = worker.rootAccount,
      rpc = worker.provider;
    const height = async () => (await rpc.block({ finality: 'final' })).header.height;
    const balance = async (id) =>
      BigInt(
        (await rpc.sendJsonRpc('query', { request_type: 'view_account', account_id: id, finality: 'final' })).amount,
      );
    const exists = async (id) => {
      try {
        await balance(id);
        return true;
      } catch (e) {
        return false;
      }
    };
    // n blocks, asked for 100 at a time: the node answers a fast-forward request when it is done, and Node's fetch gives up after 300 s.
    async function advance(n) {
      const t = (await height()) + n;
      for (let left = n; left > 0; left -= 100) await rpc.fastForward(Math.min(left, 100));
      while ((await height()) < t) await new Promise((r) => setTimeout(r, 200));
    }
    const nowNs = async () => BigInt((await rpc.block({ finality: 'final' })).header.timestamp_nanosec);
    async function advanceTo(tNs) {
      for (;;) {
        const left = tNs - (await nowNs());
        if (left <= 0n) return;
        await advance(Math.max(1, Math.min(20000, Math.floor(Number(left / 10n ** 9n) / 2))));
      }
    }
    async function make(name, amount) {
      const a = await root.createSubAccount(name, { initialBalance: near(amount).toString() });
      for (let i = 0; i < 60 && !(await exists(a.accountId)); i++) await new Promise((r) => setTimeout(r, 250));
      return a;
    }
    async function finalTx(hash, sender) {
      const raw = await rpc.sendJsonRpc('EXPERIMENTAL_tx_status', {
        tx_hash: hash,
        sender_account_id: sender,
        wait_until: 'FINAL',
      });
      const outcomes = new Map(raw.receipts_outcome.map((o) => [o.id, o]));
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
      const failures = raw.receipts_outcome
        .filter((x) => x.outcome.status.Failure)
        .map((x) => x.outcome.status.Failure);
      const events = raw.receipts_outcome
        .flatMap((o) => o.outcome.logs)
        .filter((l) => l.startsWith('EVENT_JSON:'))
        .map((l) => JSON.parse(l.slice(11)));
      return { success: failures.length === 0 && 'SuccessValue' in raw.status, failures, transfers, events };
    }
    async function send(label, signer, contract, method, args = {}, deposit = 0n, gas = PGAS) {
      const r = await signer.callRaw(contract, method, args, { gas, attachedDeposit: deposit.toString() });
      const row = { label, method, ...(await finalTx(r.result.transaction.hash, signer.accountId)) };
      report.transactions.push(row);
      save();
      return row;
    }
    const paid = (tx, from, to) =>
      tx.transfers.filter((x) => x.from === from && x.to === to && x.ok).reduce((a, x) => a + BigInt(x.amount), 0n);
    async function keyless(acct, wasm, method, args, gas = TGAS100) {
      const key = await acct.getKey();
      const r = await acct
        .batch(acct)
        .deployContract(wasm)
        .functionCall(method, args, { gas })
        .deleteKey(key.getPublicKey())
        .transact();
      if (r.result.receipts_outcome.some((x) => x.outcome.status.Failure)) throw Error('deploy ' + acct.accountId);
    }

    // Kernel with the shelf, factory, board: the same setup as the main scenario.
    console.log('\n[setup] kernel, shelf, factory, board');
    const keeper = await make('keeper', 40),
      checker = await make('checker', 10),
      bc = cfg.board;
    async function sealedKernel(name, wasm) {
      // a keyless kernel with the shelf uploaded, pinned and type-checked
      const k = await make(name, 20);
      await keyless(k, wasm, 'init', { owner: keeper.accountId });
      for (const c of shelf.chunks) {
        const t = await send('upload', keeper, k, 'load_base_chunk', read(path.join(cfg.shelf, c)));
        if (!t.success) throw Error('upload');
      }
      if (
        !(
          await send('seal', keeper, k, 'seal_base', {
            expected_sha256: shelf.base_sha256,
            expected_decl_count: shelf.base_decls,
          })
        ).success
      )
        throw Error('seal');
      for (let from = 0, span = 256; from < shelf.base_decls; ) {
        const to = Math.min(shelf.base_decls, from + span);
        if ((await send('check', checker, k, 'check_base_range', { from, to })).success) from = to;
        else span = Math.max(1, span >> 1);
      }
      return k;
    }
    // A factory and the board it names as the only account that may freeze its wallets (`factoryBoard`: name another).
    async function pair(tag, kernelAcct, factoryBoard) {
      const f = await make('wallets' + tag, 12),
        bId = `board${tag}.${root.accountId}`;
      await keyless(
        f,
        factoryWasm,
        'new',
        { wallet_code: walletWasm.toString('base64'), board: factoryBoard || bId },
        '300000000000000',
      );
      await advance(3);
      const b = await make('board' + tag, 5);
      await keyless(b, boardWasm, 'new', {
        kernel: kernelAcct.accountId,
        base_hash: shelf.base_sha256,
        factory: f.accountId,
        wallet_code_hash: sha(walletWasm),
        claims: cfg.bounties.map((x) => ({ claim: x.claim, counter: x.counter_claim })),
        reveal_delay_blocks: String(bc.reveal_delay_blocks),
        min_reveal_gas_tgas: String(bc.min_reveal_gas_tgas),
        reveal_bond: near(bc.reveal_bond_near).toString(),
        grace_seconds: String(bc.grace_seconds),
        stale_blocks: String(bc.stale_blocks),
      });
      return { factory: f, board: b };
    }
    const POLICY = { budget: '20000000', per_tx: '3000000', per_day: '6000000', day_ns: '600000000000' };
    async function walletFor(f, owner, name, agent, allowed) {
      if (
        !(
          await send(
            'create a wallet',
            owner,
            f,
            'create_wallet',
            { name, agent: agent ? agent.accountId : null, policy: { ...POLICY, allowed: [allowed.accountId] } },
            near('0.05'),
            TGAS100,
          )
        ).success
      )
        throw Error('wallet');
      return f.getSubAccount(name);
    }
    const kernel = await sealedKernel('kernel', kernelWasm);
    const { factory, board } = await pair('', kernel);
    const bcfg = await board.view('get_config', {});
    const delay = Number(bcfg.reveal_delay_blocks),
      bond = BigInt(bcfg.reveal_bond);
    const now = BigInt((await rpc.block({ finality: 'final' })).header.timestamp_nanosec);
    const deadline = (now + 3600n * 10n ** 9n).toString();
    async function commit(who, id, side, delta, brd = board) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = sha(Buffer.from(`${bcfg.commit_domain}\n${id}\n${who.accountId}\n${side}\n${sha(delta)}\n${salt}`));
      if (!(await send('commit', who, brd, 'commit', { id, hash }, near('0.01'), TGAS100)).success)
        throw Error('commit');
      return salt;
    }
    async function twoAtOnce(acct, first, second) {
      // [receiver, actions] pairs, consecutive nonces, broadcast together
      const k = await acct.getKey(),
        store = new InMemoryKeyStore();
      await store.setKey('sandbox', acct.accountId, k);
      const sg = new InMemorySigner(store);
      const ak = await rpc.sendJsonRpc('query', {
        request_type: 'view_access_key',
        account_id: acct.accountId,
        public_key: k.getPublicKey().toString(),
        finality: 'final',
      });
      const bh = baseDecode((await rpc.block({ finality: 'final' })).header.hash);
      const signed = [];
      for (const [i, [to, actions]] of [first, second].entries())
        signed.push(
          await signTransaction(
            createTransaction(acct.accountId, k.getPublicKey(), to, BigInt(ak.nonce) + 1n + BigInt(i), actions, bh),
            sg,
            acct.accountId,
            'sandbox',
          ),
        );
      for (const [, st] of signed) await rpc.sendTransactionAsync(st);
      return Promise.all(signed.map(([h]) => finalTx(baseEncode(h), acct.accountId)));
    }
    // `side` is the second line of the reveal: `proof`, `refutation`, or `proof <theorem>` for the root bounty.
    const reveal = (who, id, side, salt, delta, brd = board) =>
      send(
        `reveal ${side}`,
        who,
        brd,
        'reveal',
        Buffer.concat([Buffer.from(`${id}\n${side}\n${salt}\n`), delta]),
        bond,
      );
    const byClaim = async (claim, brd = board) =>
      (await brd.view('list_bounties', {})).filter((b) => b.claim === claim).pop();
    const why = (tx) =>
      (JSON.stringify(tx.failures).match(/panicked: ([A-Za-z_:0-9.]+)/) || [])[1] || (tx.success ? 'ok' : '?');
    const evs = (tx, standard, name) =>
      tx.events.filter((e) => e.standard === standard && e.event === name).map((e) => e.data[0]);
    const frozen = async (w) => (await w.view('get_policy', {})).frozen;

    // ------------------------------------------------------------------ F1
    console.log("\n[F1] the winner's account is gone when the reward is sent");
    const poster = await make('poster', 30),
      beneficiary = await make('beneficiary', 1),
      anyone = await make('anyone', 5);
    const head = cfg.bounties.find((b) => b.headline);
    await send(
      'post',
      poster,
      board,
      'post_bounty',
      { claim: head.claim, counter_claim: head.counter_claim, title: 't', deadline, subject: null, escrow: null },
      near('1.1'),
    );
    const b1 = await byClaim(head.claim);
    const proof = read(path.join(cfg.couriers[0].solutions[head.claim], 'delta.ndjson'));
    const doomed = await make('doomed', 5);
    const salt1 = await commit(doomed, b1.id, 'proof', proof);
    await advance(delay + 2);
    // Two transactions from the same key, broadcast without waiting: the reveal, then deleting the account.
    const key = await doomed.getKey();
    const ks = new InMemoryKeyStore();
    await ks.setKey('sandbox', doomed.accountId, key);
    const signer = new InMemorySigner(ks);
    const ak = await rpc.sendJsonRpc('query', {
      request_type: 'view_access_key',
      account_id: doomed.accountId,
      public_key: key.getPublicKey().toString(),
      finality: 'final',
    });
    const blockHash = baseDecode((await rpc.block({ finality: 'final' })).header.hash);
    const revealArgs = Buffer.concat([Buffer.from(`${b1.id}\nproof\n${salt1}\n`), proof]);
    const [hRev, sRev] = await signTransaction(
      createTransaction(
        doomed.accountId,
        key.getPublicKey(),
        board.accountId,
        BigInt(ak.nonce) + 1n,
        [actionCreators.functionCall('reveal', revealArgs, BigInt(PGAS), bond, (x) => x)],
        blockHash,
      ),
      signer,
      doomed.accountId,
      'sandbox',
    );
    const [hDel, sDel] = await signTransaction(
      createTransaction(
        doomed.accountId,
        key.getPublicKey(),
        doomed.accountId,
        BigInt(ak.nonce) + 2n,
        [actionCreators.deleteAccount(beneficiary.accountId)],
        blockHash,
      ),
      signer,
      doomed.accountId,
      'sandbox',
    );
    await rpc.sendTransactionAsync(sRev);
    await rpc.sendTransactionAsync(sDel);
    const rv = await finalTx(baseEncode(hRev), doomed.accountId);
    await finalTx(baseEncode(hDel), doomed.accountId);
    report.transactions.push({ label: 'reveal, then the winner deletes its account', method: 'reveal', ...rv });
    save();
    const owed = await board.view('get_bounty', { id: b1.id });
    say(
      `after the reveal: phase ${owed.phase}, winner ${owed.winner}, last_error ${owed.last_error}; ${doomed.accountId} exists: ${await exists(doomed.accountId)}`,
    );
    const retryEarly = await send(
      'retry_payment while the account is still gone',
      anyone,
      board,
      'retry_payment',
      { id: b1.id },
      0n,
      TGAS100,
    );
    const stillOwed = (await board.view('get_bounty', { id: b1.id })).phase;
    await root.createSubAccount('doomed', { initialBalance: near('0.1').toString() });
    const retry = await send(
      'retry_payment after the account exists again',
      anyone,
      board,
      'retry_payment',
      { id: b1.id },
      0n,
      TGAS100,
    );
    const after = await board.view('get_bounty', { id: b1.id });
    const got = paid(retry, board.accountId, doomed.accountId);
    const again = await send('retry_payment once more', anyone, board, 'retry_payment', { id: b1.id }, 0n, TGAS100);
    say(
      `retry while gone -> ${stillOwed}; account re-created; retry -> ${after.phase}, ${Number(got) / 1e24} NEAR to ${doomed.accountId}; retry again -> ${again.success ? 'ok?' : 'refused'}`,
    );
    check(
      'F1',
      'A failed reward transfer leaves the bounty Owed; retry_payment pays the recorded winner once it can receive, exactly once',
      owed.phase === 'Owed' &&
        owed.winner === doomed.accountId &&
        owed.last_error === 'transfer_failed_owed_preserved' &&
        stillOwed === 'Owed' &&
        retry.success &&
        after.phase === 'Paid' &&
        got === BigInt(after.reward) + bond &&
        !again.success &&
        JSON.stringify(again.failures).includes('nothing_owed'),
      {
        owed_phase: owed.phase,
        last_error: owed.last_error,
        retry_while_gone: stillOwed,
        after: after.phase,
        paid: got.toString(),
        retry_again: again.failures,
      },
    );

    // ------------------------------------------------------------------ F2
    console.log("\n[F2] the poster's account is gone when a refuted bounty returns its escrow");
    const sd = cfg.bounties.find((b) => b.key === 'slidingday');
    const owner = await make('owner', 5);
    if (
      !(
        await send(
          'owner creates a wallet',
          owner,
          factory,
          'create_wallet',
          {
            name: 'safe',
            agent: null,
            policy: {
              budget: '20000000',
              per_tx: '3000000',
              per_day: '6000000',
              day_ns: '600000000000',
              allowed: [owner.accountId],
            },
          },
          near('0.05'),
          TGAS100,
        )
      ).success
    )
      throw Error('wallet');
    const wallet = factory.getSubAccount('safe');
    const leaving = await make('leaving', 20);
    await send(
      'post with escrow',
      leaving,
      board,
      'post_bounty',
      {
        claim: sd.claim,
        counter_claim: sd.counter_claim,
        title: 't',
        deadline,
        subject: wallet.accountId,
        escrow: near('2').toString(),
      },
      near('1.1') + near('2'),
    );
    const b2 = await byClaim(sd.claim);
    await leaving.delete(beneficiary.accountId);
    const cex = read(path.join(cfg.couriers[1].solutions[sd.counter_claim], 'delta.ndjson'));
    const refuter = await make('refuter', 5);
    const salt2 = await commit(refuter, b2.id, 'refutation', cex);
    await advance(delay + 2);
    const rv2 = await reveal(refuter, b2.id, 'refutation', salt2, cex);
    const held = await board.view('get_bounty', { id: b2.id });
    const frozen2 = evs(rv2, 'proof-courier-wallet', 'wallet_frozen').length === 1 && (await frozen(wallet));
    say(
      `refuted: phase ${held.phase}, escrow ${held.escrow_state}; ${leaving.accountId} exists: ${await exists(leaving.accountId)}; the same transaction froze ${wallet.accountId}: ${frozen2}`,
    );
    await root.createSubAccount('leaving', { initialBalance: near('0.1').toString() });
    const re = await send(
      'retry_escrow after the poster exists again',
      anyone,
      board,
      'retry_escrow',
      { id: b2.id },
      0n,
      TGAS100,
    );
    const b2after = await board.view('get_bounty', { id: b2.id });
    const back = paid(re, board.accountId, leaving.accountId);
    const re2 = await send('retry_escrow once more', anyone, board, 'retry_escrow', { id: b2.id }, 0n, TGAS100);
    say(
      `retry_escrow -> ${b2after.escrow_state}, ${Number(back) / 1e24} NEAR back to ${leaving.accountId}; once more -> ${re2.success ? 'ok?' : 'refused'}; nothing went to the wallet: ${paid(rv2, board.accountId, wallet.accountId) === 0n}`,
    );
    check(
      'F2',
      'A failed escrow return leaves the escrow held; retry_escrow returns it to the poster once it can receive, exactly once, and never to the wallet of a refuted claim',
      paid(rv2, board.accountId, refuter.accountId) > 0n &&
        held.certificate &&
        held.certificate.side === 'refutation' &&
        held.escrow_state === 'held' &&
        re.success &&
        b2after.escrow_state === 'returned' &&
        back === near('2') &&
        !re2.success &&
        JSON.stringify(re2.failures).includes('no_escrow_to_move') &&
        paid(rv2, board.accountId, wallet.accountId) === 0n &&
        paid(re, board.accountId, wallet.accountId) === 0n &&
        frozen2,
      {
        held: held.escrow_state,
        after: b2after.escrow_state,
        returned: back.toString(),
        again: re2.failures,
        wallet_frozen_by_the_refutation: frozen2,
      },
    );

    // ------------------------------------------------------------------ F3
    console.log('\n[F3] a wallet whose setup fails');
    const careless = await make('careless', 5);
    const before = await balance(careless.accountId);
    const bad = await send(
      'create_wallet with a policy the wallet refuses (no allowed list)',
      careless,
      factory,
      'create_wallet',
      { name: 'broken', agent: null, policy: { budget: '1', per_tx: '1', per_day: '1', day_ns: '1' } },
      near('0.5'),
      TGAS100,
    );
    await advance(3);
    const lost = before - (await balance(careless.accountId));
    const record = await factory.view('wallet_of', { account_id: `broken.${factory.accountId}` });
    const refundEvent = bad.events.find((e) => e.event === 'wallet_setup_failed');
    say(
      `setup failed: wallet exists ${await exists(`broken.${factory.accountId}`)}, factory record ${JSON.stringify(record)}, refund event ${!!refundEvent}; the caller is out ${Number(lost) / 1e24} NEAR (gas only)`,
    );
    check(
      'F3',
      'A wallet whose setup fails is not created and not recorded, and the caller gets the whole deposit back',
      !(await exists(`broken.${factory.accountId}`)) &&
        record === null &&
        !!refundEvent &&
        paid(bad, factory.accountId, careless.accountId) === near('0.5') &&
        lost < near('0.01'),
      { refunded: paid(bad, factory.accountId, careless.accountId).toString(), lost_to_gas: lost.toString(), record },
    );

    // ------------------------------------------------------------------ F4
    console.log('\n[F4] the double-escrow attack: retry_escrow while a bounty is still being validated');
    const nonce = cfg.bounties.find((b) => b.key === 'nonce');
    const attacker = await make('attacker', 20),
      notAWallet = await make('notawallet', 1);
    const boardBefore = await balance(board.accountId),
      attackerBefore = await balance(attacker.accountId);
    const nextId = (await board.view('get_config', {})).bounties; // the id the attacker's bounty will get
    const [post4, retry4] = await twoAtOnce(
      attacker,
      [
        board.accountId,
        [
          actionCreators.functionCall(
            'post_bounty',
            Buffer.from(
              JSON.stringify({
                claim: nonce.claim,
                counter_claim: nonce.counter_claim,
                title: 'x',
                deadline,
                subject: notAWallet.accountId,
                escrow: near('10').toString(),
              }),
            ),
            BigInt(PGAS),
            near('11.1'),
            (x) => x,
          ),
        ],
      ],
      [
        board.accountId,
        [
          actionCreators.functionCall(
            'retry_escrow',
            Buffer.from(JSON.stringify({ id: nextId })),
            100000000000000n,
            0n,
            (x) => x,
          ),
        ],
      ],
    );
    report.transactions.push(
      { label: 'post with escrow for a non-wallet', method: 'post_bounty', ...post4 },
      { label: 'retry_escrow at once', method: 'retry_escrow', ...retry4 },
    );
    save();
    await advance(3);
    const b4 = (await board.view('list_bounties', {})).find((b) => b.poster === attacker.accountId);
    const got4 = paid(post4, board.accountId, attacker.accountId) + paid(retry4, board.accountId, attacker.accountId);
    const net = (await balance(attacker.accountId)) - attackerBefore,
      boardNet = (await balance(board.accountId)) - boardBefore;
    say(
      `bounty #${b4 && b4.id}: ${b4 && b4.phase}, ${b4 && b4.refused_because}, escrow ${b4 && b4.escrow_state}; retry_escrow -> ${retry4.success ? 'ACCEPTED' : (JSON.stringify(retry4.failures).match(/panicked: ([a-z_]+)/) || [])[1]}`,
    );
    say(
      `the board sent the attacker ${Number(got4) / 1e24} NEAR (reward + escrow); attacker net ${Number(net) / 1e24} NEAR; the board kept ${Number(boardNet) / 1e24} NEAR (the posting fee, which pays for the record)`,
    );
    check(
      'F4',
      'retry_escrow is refused while a bounty is being validated; a refused bounty returns reward + escrow exactly once and keeps the posting fee',
      !!b4 &&
        b4.phase === 'Refunded' &&
        b4.refused_because === 'subject_not_a_factory_wallet' &&
        b4.escrow_state === 'returned' &&
        !retry4.success &&
        JSON.stringify(retry4.failures).includes('no_escrow_to_move') &&
        got4 === near('11') &&
        net < 0n &&
        boardNet >= 0n,
      {
        phase: b4 && b4.phase,
        reason: b4 && b4.last_error,
        escrow_state: b4 && b4.escrow_state,
        retry: retry4.failures,
        returned: got4.toString(),
        attacker_net: net.toString(),
        board_net: boardNet.toString(),
      },
    );

    // ------------------------------------------------------------------ F5
    console.log("\n[F5] a retried refund of an old bounty does not free a newer bounty's claim");
    const pertx = cfg.bounties.find((b) => b.key === 'pertx');
    const postA = await make('posta', 10),
      postB = await make('postb', 10),
      postC = await make('postc', 10);
    const shortDeadline = ((await nowNs()) + 60n * 10n ** 9n).toString();
    await send(
      'A posts a short bounty',
      postA,
      board,
      'post_bounty',
      {
        claim: pertx.claim,
        counter_claim: pertx.counter_claim,
        title: 'A',
        deadline: shortDeadline,
        subject: null,
        escrow: null,
      },
      near('1.1'),
    );
    const idA = await board.view('open_for', { name: pertx.claim });
    await advanceTo(BigInt(shortDeadline) + BigInt(bcfg.grace_seconds) * 10n ** 9n + 10n ** 9n);
    await postA.delete(beneficiary.accountId);
    await send('anyone closes A while its poster is gone', anyone, board, 'refund', { id: idA }, 0n, TGAS100);
    const aOwed = (await board.view('get_bounty', { id: idA })).phase;
    await send(
      'B posts the same claim',
      postB,
      board,
      'post_bounty',
      { claim: pertx.claim, counter_claim: pertx.counter_claim, title: 'B', deadline, subject: null, escrow: null },
      near('1.1'),
    );
    const idB = await board.view('open_for', { name: pertx.claim });
    await root.createSubAccount('posta', { initialBalance: near('0.1').toString() });
    const retryA = await send("A's refund retried", anyone, board, 'refund', { id: idA }, 0n, TGAS100);
    const aBack = paid(retryA, board.accountId, `posta.${root.accountId}`);
    const stillB = await board.view('open_for', { name: pertx.claim });
    const postC5 = await send(
      'C tries to post the same claim',
      postC,
      board,
      'post_bounty',
      { claim: pertx.claim, counter_claim: pertx.counter_claim, title: 'C', deadline, subject: null, escrow: null },
      near('1.1'),
    );
    say(
      `A: ${aOwed} while its poster was gone, then ${(await board.view('get_bounty', { id: idA })).phase} (${Number(aBack) / 1e24} NEAR back); open_for(${pertx.claim}) after A's retry: #${stillB} (B is #${idB}); C's post -> ${(JSON.stringify(postC5.failures).match(/panicked: ([a-z_:0-9]+)/) || [])[1]}`,
    );
    check(
      'F5',
      'Retrying an old bounty’s refund pays its poster once and leaves a newer bounty’s hold on the claim alone, so the claim cannot be posted (and paid) twice',
      aOwed === 'OwedRefund' &&
        aBack === near('1') &&
        idB !== idA &&
        stillB === idB &&
        !postC5.success &&
        JSON.stringify(postC5.failures).includes(`open_bounty:${idB}`),
      {
        a_phase_while_gone: aOwed,
        a_refund: aBack.toString(),
        open_for_after: stillB,
        b: idB,
        c_post: postC5.failures,
      },
    );

    // ------------------------------------------------------------------ F6
    console.log('\n[F6] the poster of a refused post is gone when its refund is sent');
    const twice = cfg.bounties.find((b) => b.key === 'slidingtwice');
    const gone = await make('gone', 10);
    const [post6] = await twoAtOnce(
      gone,
      [
        board.accountId,
        [
          actionCreators.functionCall(
            'post_bounty',
            Buffer.from(
              JSON.stringify({
                claim: twice.claim,
                counter_claim: twice.counter_claim,
                title: 'x',
                deadline,
                subject: notAWallet.accountId,
                escrow: near('2').toString(),
              }),
            ),
            BigInt(PGAS),
            near('3.1'),
            (x) => x,
          ),
        ],
      ],
      [gone.accountId, [actionCreators.deleteAccount(beneficiary.accountId)]],
    );
    report.transactions.push({ label: 'refused post whose poster leaves at once', method: 'post_bounty', ...post6 });
    save();
    await advance(3);
    const b6 = (await board.view('list_bounties', {})).find((b) => b.poster === gone.accountId);
    say(`refused (${b6.refused_because}) while the poster is gone: phase ${b6.phase}, escrow ${b6.escrow_state}`);
    await root.createSubAccount('gone', { initialBalance: near('0.1').toString() });
    const r6 = await send(
      'the refund retried (it also moves the held escrow)',
      anyone,
      board,
      'refund',
      { id: b6.id },
      0n,
      TGAS100,
    );
    const e6 = await send('the escrow retried after that', anyone, board, 'retry_escrow', { id: b6.id }, 0n, TGAS100);
    const r6b = await send('the refund retried once more', anyone, board, 'refund', { id: b6.id }, 0n, TGAS100);
    const b6after = await board.view('get_bounty', { id: b6.id });
    const back6 = paid(r6, board.accountId, gone.accountId);
    say(
      `after the account exists again: refund ${Number(back6) / 1e24} NEAR (reward 1 + escrow 2); then retry_escrow -> ${e6.success ? 'paid again?' : 'nothing held'}, refund -> ${r6b.success ? 'paid again?' : 'not refundable'}; phase ${b6after.phase}, escrow ${b6after.escrow_state}`,
    );
    check(
      'F6',
      'A refused post whose refund cannot be delivered stays owed (reward OwedRefund, escrow held), keeps its refusal reason, and is paid exactly once when the poster can receive',
      b6.refused_because === 'subject_not_a_factory_wallet' &&
        b6.phase === 'OwedRefund' &&
        b6.escrow_state === 'held' &&
        back6 === near('3') &&
        !e6.success &&
        !r6b.success &&
        b6after.phase === 'Refunded' &&
        b6after.escrow_state === 'returned',
      {
        refused_because: b6.refused_because,
        while_gone: { phase: b6.phase, escrow: b6.escrow_state },
        refunded: back6.toString(),
        after: { phase: b6after.phase, escrow: b6after.escrow_state },
      },
    );

    // ------------------------------------------------------------------ F7
    console.log(
      '\n[F7] a proof of False from a forged recursor rule, sent to the kernel as a proof of the headline claim',
    );
    const honest = await kernel.view('dry_run', { theorem_name: head.claim, delta: proof.toString() });
    const forged = [];
    for (const name of ['forgedRec', 'forgedRecNested']) {
      const delta = read(`cheats/deltas/${name}.delta.ndjson`);
      const free = await kernel.view('dry_run', { theorem_name: head.claim, delta: delta.toString() }).then(
        (r) => (r.ok ? 'accepted' : 'refused:' + r.reason),
        () => 'kernel_failed',
      );
      const tx = await send(
        `check ${name}`,
        anyone,
        kernel,
        'check_result_raw',
        Buffer.concat([Buffer.from(head.claim + '\n'), delta]),
      );
      forged.push({
        name,
        delta_sha256: sha(delta),
        dry_run: free,
        check: tx.success ? 'accepted' : 'kernel_failed',
        failure: JSON.stringify(tx.failures).slice(0, 240),
      });
      say(
        `${name}: the free check -> ${free}; the paid check -> ${tx.success ? 'ACCEPTED (!)' : 'the receipt fails in the kernel'}`,
      );
    }
    check(
      'F7',
      'A proof of False built on a forged recursor rule, stated as a proof of the headline claim, fails in the kernel, while an honest proof of that claim is accepted',
      honest.ok === true && forged.every((f) => f.dry_run === 'kernel_failed' && f.check === 'kernel_failed'),
      { honest_proof_ok: honest.ok, kernel: await kernel.view('kernel_name', {}), forged },
    );

    // ------------------------------------------------------------------ F8
    console.log('\n[F8] a counterexample that arrives after its bounty was closed');
    const p8 = await pair('late', kernel),
      board8 = p8.board;
    const owner8 = await make('owner8', 5),
      agent8 = await make('agent8', 2),
      poster8 = await make('poster8', 20),
      late = await make('late', 5),
      refuter9 = await make('refuter9', 5);
    const wallet8 = await walletFor(p8.factory, owner8, 'safe', agent8, owner8);
    const cex2 = read('evidence/demo/live-solve-SlidingDayCap-sonnet/delta.ndjson'); // a second, different counterexample
    const short8 = ((await nowNs()) + 120n * 10n ** 9n).toString();
    await send(
      'post a short bounty',
      poster8,
      board8,
      'post_bounty',
      {
        claim: sd.claim,
        counter_claim: sd.counter_claim,
        title: 't',
        deadline: short8,
        subject: wallet8.accountId,
        escrow: null,
      },
      near('1.1'),
    );
    const b8 = await byClaim(sd.claim, board8);
    const salt8 = await commit(late, b8.id, 'refutation', cex, board8);
    const accuse8 = await send(
      'freeze before any refutation',
      anyone,
      board8,
      'freeze',
      { wallet: wallet8.accountId },
      0n,
      TGAS100,
    );
    await advanceTo(BigInt(short8) + BigInt(bcfg.grace_seconds) * 10n ** 9n + 10n ** 9n);
    const close8 = await send('anyone closes the expired bounty', anyone, board8, 'refund', { id: b8.id }, 0n, TGAS100);
    const lateRv = await reveal(late, b8.id, 'refutation', salt8, cex, board8);
    const accuse8b = await send(
      'freeze after the late reveal',
      anyone,
      board8,
      'freeze',
      { wallet: wallet8.accountId },
      0n,
      TGAS100,
    );
    const b8after = await board8.view('get_bounty', { id: b8.id }),
      cfg8 = await board8.view('get_config', {});
    say(
      `bounty #${b8.id} ${b8after.phase} (${Number(paid(close8, board8.accountId, poster8.accountId)) / 1e24} NEAR back to its poster); the late reveal -> ${why(lateRv)}; code refuted: ${cfg8.code_refuted_by}; freeze -> ${why(accuse8)}, then ${why(accuse8b)}; wallet frozen: ${await frozen(wallet8)}`,
    );
    check(
      'F8',
      'A counterexample revealed after its bounty expired and was refunded is refused: nobody is paid, the code is not recorded refuted, and the board freezes nothing, before or after',
      b8after.phase === 'Refunded' &&
        paid(close8, board8.accountId, poster8.accountId) === near('1') &&
        !lateRv.success &&
        why(lateRv) === 'not_open' &&
        paid(lateRv, board8.accountId, late.accountId) === 0n &&
        b8after.certificate === null &&
        cfg8.code_refuted_by === null &&
        why(accuse8) === 'nothing_refuted' &&
        why(accuse8b) === 'nothing_refuted' &&
        !(await frozen(wallet8)),
      {
        phase: b8after.phase,
        late_reveal: why(lateRv),
        code_refuted_by: cfg8.code_refuted_by,
        freeze_before: why(accuse8),
        freeze_after: why(accuse8b),
        wallet_frozen: await frozen(wallet8),
      },
    );

    // ------------------------------------------------------------------ F9
    console.log('\n[F9] the same question refuted twice at the same moment');
    await send(
      'post again',
      poster8,
      board8,
      'post_bounty',
      {
        claim: sd.claim,
        counter_claim: sd.counter_claim,
        title: 't',
        deadline,
        subject: wallet8.accountId,
        escrow: null,
      },
      near('1.1'),
    );
    const b9 = await byClaim(sd.claim, board8);
    const salt9a = await commit(late, b9.id, 'refutation', cex, board8),
      salt9b = await commit(refuter9, b9.id, 'refutation', cex2, board8);
    await advance(delay + 2);
    const before9 = await board8.view('get_bounty', { id: b9.id });
    const [rvA, rvB] = await Promise.all([
      reveal(late, b9.id, 'refutation', salt9a, cex, board8),
      reveal(refuter9, b9.id, 'refutation', salt9b, cex2, board8),
    ]);
    const b9after = await board8.view('get_bounty', { id: b9.id }),
      cfg9 = await board8.view('get_config', {});
    const [winTx, loseTx, winner9, loser9] =
      b9after.winner === late.accountId ? [rvA, rvB, late, refuter9] : [rvB, rvA, refuter9, late];
    const loserAttempt = b9after.attempts.find((a) => a.claimer === loser9.accountId);
    const freezes9 =
      evs(rvA, 'proof-courier-wallet', 'wallet_frozen').length +
      evs(rvB, 'proof-courier-wallet', 'wallet_frozen').length;
    const again9 = await reveal(
      winner9,
      b9.id,
      'refutation',
      winner9 === late ? salt9a : salt9b,
      winner9 === late ? cex : cex2,
      board8,
    );
    const recommit9 = await send(
      'the winner commits again',
      winner9,
      board8,
      'commit',
      { id: b9.id, hash: 'a'.repeat(64) },
      near('0.01'),
      TGAS100,
    );
    const refreeze9 = await send(
      'anyone sends the freeze again',
      anyone,
      board8,
      'freeze',
      { wallet: wallet8.accountId },
      0n,
      TGAS100,
    );
    const stray9 = await send(
      'anyone asks the board to freeze an account the factory does not know',
      anyone,
      board8,
      'freeze',
      { wallet: anyone.accountId },
      0n,
      TGAS100,
    );
    const toRefuters = [late, refuter9].map(
      (a) =>
        paid(rvA, board8.accountId, a.accountId) +
        paid(rvB, board8.accountId, a.accountId) +
        paid(again9, board8.accountId, a.accountId),
    );
    say(
      `${winner9.accountId} is paid ${Number(paid(winTx, board8.accountId, winner9.accountId)) / 1e24} NEAR and its transaction froze ${wallet8.accountId}; ${loser9.accountId}: ${loserAttempt ? loserAttempt.outcome : why(loseTx)}, ${Number(paid(loseTx, board8.accountId, loser9.accountId)) / 1e24} NEAR (its bond)`,
    );
    say(
      `the winner reveals again -> ${why(again9)}; commits again -> ${why(recommit9)}; the freeze sent again -> still frozen: ${await frozen(wallet8)}; freeze of a stranger -> ${evs(stray9, 'proof-courier', 'freeze_refused').length ? 'freeze_refused' : '?'}`,
    );
    check(
      'F9',
      'Two refutations of one claim at the same moment: one is paid, once, and its transaction freezes the wallet; the other gets only its bond back; a repeated reveal, commit or freeze changes nothing, and an account the factory does not know is not frozen',
      before9.phase === 'Open' &&
        b9after.phase === 'Paid' &&
        b9after.certificate.side === 'refutation' &&
        cfg9.code_refuted_by === b9.id &&
        paid(winTx, board8.accountId, winner9.accountId) === BigInt(before9.reward) + bond &&
        (loserAttempt
          ? loserAttempt.outcome === 'accepted_after_settled' &&
            paid(loseTx, board8.accountId, loser9.accountId) === bond
          : why(loseTx) === 'not_open' && paid(loseTx, board8.accountId, loser9.accountId) === 0n) &&
        toRefuters[0] + toRefuters[1] === BigInt(before9.reward) + bond + (loserAttempt ? bond : 0n) &&
        freezes9 === 1 &&
        evs(winTx, 'proof-courier', 'wallet_frozen').length === 1 &&
        (await frozen(wallet8)) &&
        !again9.success &&
        why(again9) === 'no_commit' &&
        !recommit9.success &&
        why(recommit9) === 'not_open' &&
        refreeze9.success &&
        evs(refreeze9, 'proof-courier', 'wallet_frozen').length === 1 &&
        paid(refreeze9, board8.accountId, winner9.accountId) === 0n &&
        evs(stray9, 'proof-courier', 'freeze_refused').length === 1 &&
        evs(stray9, 'proof-courier', 'wallet_frozen').length === 0,
      {
        winner: winner9.accountId,
        paid: paid(winTx, board8.accountId, winner9.accountId).toString(),
        loser: loserAttempt ? loserAttempt.outcome : why(loseTx),
        loser_got: paid(loseTx, board8.accountId, loser9.accountId).toString(),
        wallet_freezes_in_the_two_reveals: freezes9,
        reveal_again: why(again9),
        commit_again: why(recommit9),
        freeze_again: refreeze9.success,
        code_refuted_by: cfg9.code_refuted_by,
      },
    );

    // ------------------------------------------------------------------ F10
    console.log('\n[F10] a freeze that fails: the wallet answers to another board');
    const elsewhere = await make('elsewhere', 1);
    const p10 = await pair('deaf', kernel, elsewhere.accountId),
      board10 = p10.board;
    const owner10 = await make('owner10', 5),
      poster10 = await make('poster10', 20),
      refuter10 = await make('refuter10', 5);
    const wallet10 = await walletFor(p10.factory, owner10, 'safe', null, owner10);
    await send(
      'post with escrow',
      poster10,
      board10,
      'post_bounty',
      {
        claim: sd.claim,
        counter_claim: sd.counter_claim,
        title: 't',
        deadline,
        subject: wallet10.accountId,
        escrow: near('2').toString(),
      },
      near('1.1') + near('2'),
    );
    const b10 = await byClaim(sd.claim, board10);
    const salt10 = await commit(refuter10, b10.id, 'refutation', cex, board10);
    await advance(delay + 2);
    const rv10 = await reveal(refuter10, b10.id, 'refutation', salt10, cex, board10);
    const b10after = await board10.view('get_bounty', { id: b10.id });
    const retry10 = await send(
      'anyone sends the freeze again',
      anyone,
      board10,
      'freeze',
      { wallet: wallet10.accountId },
      0n,
      TGAS100,
    );
    const pay10 = await send(
      'retry_payment after the failed freeze',
      anyone,
      board10,
      'retry_payment',
      { id: b10.id },
      0n,
      TGAS100,
    );
    const esc10 = await send(
      'retry_escrow after the failed freeze',
      anyone,
      board10,
      'retry_escrow',
      { id: b10.id },
      0n,
      TGAS100,
    );
    const moved10 = retry10.transfers.length + pay10.transfers.length + esc10.transfers.length;
    say(
      `the refuter is paid ${Number(paid(rv10, board10.accountId, refuter10.accountId)) / 1e24} NEAR, the escrow ${b10after.escrow_state} (${Number(paid(rv10, board10.accountId, poster10.accountId)) / 1e24} NEAR to its poster); the freeze: ${evs(rv10, 'proof-courier', 'freeze_failed').length ? 'freeze_failed' : '?'} (${wallet10.accountId} answers to ${elsewhere.accountId})`,
    );
    say(
      `the freeze sent again -> ${evs(retry10, 'proof-courier', 'freeze_failed').length ? 'freeze_failed' : '?'}; retry_payment -> ${why(pay10)}; retry_escrow -> ${why(esc10)}; transfers in those three: ${moved10}`,
    );
    check(
      'F10',
      'A freeze the wallet refuses does not disturb the settlement: the refutation is paid once and the escrow returned once; sending the freeze again fails again and moves no money',
      b10after.phase === 'Paid' &&
        paid(rv10, board10.accountId, refuter10.accountId) === near('1') + bond &&
        b10after.escrow_state === 'returned' &&
        paid(rv10, board10.accountId, poster10.accountId) === near('2') &&
        evs(rv10, 'proof-courier', 'freeze_failed').length === 1 &&
        evs(rv10, 'proof-courier', 'wallet_frozen').length === 0 &&
        JSON.stringify(rv10.failures).includes('ERR_FREEZE_NOT_BOARD') &&
        !(await frozen(wallet10)) &&
        evs(retry10, 'proof-courier', 'freeze_failed').length === 1 &&
        why(pay10) === 'nothing_owed' &&
        why(esc10) === 'no_escrow_to_move' &&
        moved10 === 0,
      {
        phase: b10after.phase,
        paid: paid(rv10, board10.accountId, refuter10.accountId).toString(),
        escrow: b10after.escrow_state,
        freeze: 'freeze_failed',
        wallet_board: (await wallet10.view('get_policy', {})).board,
        freeze_again: 'freeze_failed',
        retry_payment: why(pay10),
        retry_escrow: why(esc10),
        transfers_after: moved10,
      },
    );

    // ------------------------------------------------------------------ F11
    console.log('\n[F11] the root bounty on False, on the current kernel');
    const ROOT = { claim: 'False', counter_claim: null, subject: null, escrow: null };
    const forgedDeltas = [
      ['forgedRec', 'badApp'],
      ['forgedRecNested', 'badNested'],
    ].map(([name, theorem]) => ({ name, theorem, delta: read(`cheats/deltas/${name}.delta.ndjson`) }));
    const hunters = [await make('hunter1', 5), await make('hunter2', 5)],
      scribe = await make('scribe', 5);
    const twoSided = await send(
      'a root bounty with a refutation side',
      poster,
      board,
      'post_bounty',
      { ...ROOT, counter_claim: pertx.counter_claim, title: 'x', deadline },
      near('1.1'),
    );
    const rootPost = await send(
      'post the root bounty',
      poster,
      board,
      'post_bounty',
      { ...ROOT, title: 'A proof of False on this shelf: this kernel is broken', deadline },
      near('2.1'),
    );
    const r11 = await byClaim('False');
    const rootDup = await send(
      'a second root bounty',
      poster,
      board,
      'post_bounty',
      { ...ROOT, title: 'x', deadline },
      near('1.1'),
    );
    const falseText = await kernel.view('statement_of', { theorem_name: 'False', delta: '' });
    const salts11 = [];
    for (const [i, f] of forgedDeltas.entries()) salts11.push(await commit(hunters[i], r11.id, 'proof', f.delta));
    const saltHonest = await commit(scribe, r11.id, 'proof', proof);
    const saltRefute = await commit(anyone, r11.id, 'refutation', proof);
    await advance(delay + 2);
    const wrongSide = await reveal(anyone, r11.id, 'refutation', saltRefute, proof);
    const unnamed = await reveal(hunters[0], r11.id, 'proof', salts11[0], forgedDeltas[0].delta);
    const root11 = [];
    for (const [i, f] of forgedDeltas.entries()) {
      const tx = await reveal(hunters[i], r11.id, `proof ${f.theorem}`, salts11[i], f.delta);
      const b = await board.view('get_bounty', { id: r11.id }),
        last = b.attempts[b.attempts.length - 1];
      root11.push({
        name: f.name,
        theorem: f.theorem,
        delta_sha256: sha(f.delta),
        outcome: last && last.delta_sha256 === sha(f.delta) ? last.outcome : null,
        paid: paid(tx, board.accountId, hunters[i].accountId).toString(),
      });
      say(`${f.name} (theorem ${f.theorem} : False) -> ${root11[i].outcome}; paid ${root11[i].paid}`);
    }
    const honestTx = await reveal(scribe, r11.id, 'proof Solution.proof', saltHonest, proof);
    const r11after = await board.view('get_bounty', { id: r11.id }),
      cfg11 = await board.view('get_config', {});
    const honestAttempt = r11after.attempts.find((a) => a.claimer === scribe.accountId);
    say(`an honest proof of ${head.claim}, sent as a proof of False -> ${honestAttempt && honestAttempt.outcome}`);
    say(
      `the root bounty: ${r11after.phase}, reward ${Number(BigInt(r11after.reward)) / 1e24} NEAR (2 + three forfeited bonds), winner ${r11after.winner}; kernel recorded broken: ${cfg11.kernel_broken_by}`,
    );
    check(
      'F11',
      'The root bounty on False, on the current kernel: one-sided; the two forged-recursor proofs of False fail in the kernel and an honest proof of another statement is not a proof of False; the bounty stays open with its reward and the kernel is not recorded broken',
      why(twoSided) === 'root_bounty_is_one_sided_and_has_no_escrow' &&
        rootPost.success &&
        r11.phase === 'Open' &&
        r11.counter_claim === null &&
        r11.statement_sha256 === sha(Buffer.from(falseText)) &&
        falseText === 'inductive False : Prop' &&
        why(rootDup) === `open_bounty:${r11.id}` &&
        why(wrongSide) === 'one_sided_bounty' &&
        why(unnamed) === 'name_the_theorem_of_type_false' &&
        root11.length === 2 &&
        root11.every((x) => x.outcome === 'kernel_failed' && x.paid === '0') &&
        honestAttempt &&
        honestAttempt.outcome === 'not_a_proof_of_false' &&
        paid(honestTx, board.accountId, scribe.accountId) === 0n &&
        r11after.phase === 'Open' &&
        r11after.winner === null &&
        r11after.certificate === null &&
        BigInt(r11after.reward) === near('2') + 3n * bond &&
        cfg11.kernel_broken_by === null,
      {
        kernel: await kernel.view('kernel_name', {}),
        statement: falseText,
        refused_at_once: {
          two_sided: why(twoSided),
          duplicate: why(rootDup),
          refutation_side: why(wrongSide),
          no_theorem_named: why(unnamed),
        },
        forged: root11,
        honest_proof_of_another_statement: honestAttempt && honestAttempt.outcome,
        bounty: { phase: r11after.phase, reward: r11after.reward, winner: r11after.winner },
        kernel_broken_by: cfg11.kernel_broken_by,
      },
    );

    // ------------------------------------------------------------------ F12
    console.log(
      '\n[F12] WHAT-IF: the same forged proofs against a board pinned to the superseded kernel (nanoda_lib 0.4.31)',
    );
    const oldKernel = await sealedKernel('oldkernel', oldKernelWasm);
    const oldName = await oldKernel.view('kernel_name', {});
    const pOld = await pair('old', oldKernel),
      boardOld = pOld.board;
    const ownerO = await make('ownero', 5),
      agentO = await make('agento', 2),
      posterO = await make('postero', 40),
      carolO = await make('carolo', 5),
      proverO = await make('provero', 5);
    const hunterA = await make('huntera', 5),
      hunterB = await make('hunterb', 5);
    const walletO = await walletFor(pOld.factory, ownerO, 'safe', agentO, ownerO);
    await ownerO.transfer(walletO, near('3').toString());
    // Before: one bounty proved honestly (its gate works), one open with an escrow and a boost, and the root bounty.
    await send(
      'post the headline bounty',
      posterO,
      boardOld,
      'post_bounty',
      {
        claim: head.claim,
        counter_claim: head.counter_claim,
        title: 't',
        deadline,
        subject: walletO.accountId,
        escrow: null,
      },
      near('1.1'),
    );
    const bP = await byClaim(head.claim, boardOld);
    await send(
      'post a bounty with an escrow',
      posterO,
      boardOld,
      'post_bounty',
      {
        claim: nonce.claim,
        counter_claim: nonce.counter_claim,
        title: 't',
        deadline,
        subject: walletO.accountId,
        escrow: near('2').toString(),
      },
      near('1.1') + near('2'),
    );
    const bO = await byClaim(nonce.claim, boardOld);
    await send('carol boosts it', carolO, boardOld, 'boost', { id: bO.id }, near('0.5'), TGAS100);
    await send(
      'post the root bounty',
      posterO,
      boardOld,
      'post_bounty',
      { ...ROOT, title: 'A proof of False on this shelf: this kernel is broken', deadline },
      near('5.1'),
    );
    const bR = await byClaim('False', boardOld);
    const saltP = await commit(proverO, bP.id, 'proof', proof, boardOld);
    const nonceProof = read(path.join(cfg.couriers[1].solutions[nonce.claim], 'delta.ndjson'));
    const saltA = await commit(hunterA, bR.id, 'proof', forgedDeltas[0].delta, boardOld),
      saltB = await commit(hunterB, bR.id, 'proof', forgedDeltas[1].delta, boardOld);
    await advance(delay + 2);
    const honestP = await reveal(proverO, bP.id, 'proof', saltP, proof, boardOld);
    const fundBefore = await send(
      'fund_if_proven before the kernel is recorded broken',
      posterO,
      boardOld,
      'fund_if_proven',
      { id: bP.id },
      near('1'),
      TGAS100,
    );
    const freezeBefore = await send(
      'freeze before the kernel is recorded broken',
      anyone,
      boardOld,
      'freeze',
      { wallet: walletO.accountId },
      0n,
      TGAS100,
    );
    const saltLate = await commit(proverO, bO.id, 'proof', nonceProof, boardOld); // committed before the break, revealed after
    await advance(delay + 2);
    // Both forged proofs of False at the same moment: the root bounty must be paid once.
    const [rA, rB] = await Promise.all([
      reveal(hunterA, bR.id, `proof ${forgedDeltas[0].theorem}`, saltA, forgedDeltas[0].delta, boardOld),
      reveal(hunterB, bR.id, `proof ${forgedDeltas[1].theorem}`, saltB, forgedDeltas[1].delta, boardOld),
    ]);
    const bRafter = await boardOld.view('get_bounty', { id: bR.id }),
      cfgOld = await boardOld.view('get_config', {});
    const [hWin, hLose, txWin, txLose] =
      bRafter.winner === hunterA.accountId ? [hunterA, hunterB, rA, rB] : [hunterB, hunterA, rB, rA];
    const secondAttempt = bRafter.attempts.find((a) => a.claimer === hLose.accountId);
    const rootPaid = paid(txWin, boardOld.accountId, hWin.accountId),
      secondGot = paid(txLose, boardOld.accountId, hLose.accountId);
    say(
      `${oldName}: the root bounty is ${bRafter.phase}: ${Number(rootPaid) / 1e24} NEAR to ${hWin.accountId} (certificate: ${bRafter.certificate && bRafter.certificate.proof_theorem} : ${bRafter.certificate && bRafter.certificate.proved}); kernel recorded broken by bounty #${cfgOld.kernel_broken_by}`,
    );
    say(
      `the second proof of False: ${secondAttempt ? secondAttempt.outcome : why(txLose)}, ${Number(secondGot) / 1e24} NEAR (its bond at most)`,
    );
    // After: every gate is shut, and the money that was waiting goes back.
    const shut = {
      post_bounty: why(
        await send(
          'post after the break',
          posterO,
          boardOld,
          'post_bounty',
          { claim: pertx.claim, counter_claim: pertx.counter_claim, title: 't', deadline, subject: null, escrow: null },
          near('1.1'),
        ),
      ),
      commit: why(
        await send(
          'commit after the break',
          hLose,
          boardOld,
          'commit',
          { id: bO.id, hash: 'a'.repeat(64) },
          near('0.01'),
          TGAS100,
        ),
      ),
      reveal: why(await reveal(proverO, bO.id, 'proof', saltLate, nonceProof, boardOld)),
      boost: why(await send('boost after the break', carolO, boardOld, 'boost', { id: bO.id }, near('0.5'), TGAS100)),
      fund_if_proven: why(
        await send(
          'fund_if_proven after the break',
          posterO,
          boardOld,
          'fund_if_proven',
          { id: bP.id },
          near('1'),
          TGAS100,
        ),
      ),
      root_again: why(
        await send(
          'the root bounty posted again',
          posterO,
          boardOld,
          'post_bounty',
          { ...ROOT, title: 'x', deadline },
          near('1.1'),
        ),
      ),
    };
    const refundO = await send(
      'anyone closes the open bounty at once',
      anyone,
      boardOld,
      'refund',
      { id: bO.id },
      0n,
      TGAS100,
    );
    const refundO2 = await send('and again', anyone, boardOld, 'refund', { id: bO.id }, 0n, TGAS100);
    const boostBack = await send(
      'carol takes her boost back at once',
      carolO,
      boardOld,
      'withdraw_boost',
      { id: bO.id },
      0n,
      TGAS100,
    );
    const boostBack2 = await send('and again', carolO, boardOld, 'withdraw_boost', { id: bO.id }, 0n, TGAS100);
    const rootRetry = await send(
      'retry_payment of the paid root bounty',
      anyone,
      boardOld,
      'retry_payment',
      { id: bR.id },
      0n,
      TGAS100,
    );
    const bOafter = await boardOld.view('get_bounty', { id: bO.id }),
      bPafter = await boardOld.view('get_bounty', { id: bP.id });
    const freezeAfter = await send(
      'anyone freezes a wallet of the factory',
      anyone,
      boardOld,
      'freeze',
      { wallet: walletO.accountId },
      0n,
      TGAS100,
    );
    const payO = await send(
      'the agent pays from the frozen wallet',
      agentO,
      walletO,
      'pay',
      { to: ownerO.accountId, amount: '1000000' },
      0n,
      TGAS100,
    );
    const outO = await send('the owner withdraws', ownerO, walletO, 'withdraw', { amount: '3000000' }, 0n, TGAS100);
    const backO = paid(refundO, boardOld.accountId, posterO.accountId);
    say(
      `after the break: ${Object.entries(shut)
        .map(([k, v]) => `${k} -> ${v}`)
        .join('; ')}`,
    );
    say(
      `the open bounty, before its deadline: ${bOafter.phase}, ${Number(backO) / 1e24} NEAR back to its poster (reward 1 + escrow 2, escrow ${bOafter.escrow_state}); carol's boost: ${Number(paid(boostBack, boardOld.accountId, carolO.accountId)) / 1e24} NEAR back; again -> ${why(refundO2)}, ${why(boostBack2)}`,
    );
    say(
      `freeze(${walletO.accountId}) by anyone: ${why(freezeBefore)} before, frozen ${await frozen(walletO)} after; the agent's payment -> ${(payO.events[0] || { data: [{}] }).data[0].verdict}; the owner withdraws ${Number(paid(outO, walletO.accountId, ownerO.accountId)) / 1e24} NEAR`,
    );
    check(
      'F12',
      "WHAT-IF with the superseded kernel (nanoda_lib 0.4.31, not the kernel in artifacts/): a forged proof of False is paid the root bounty, once; the board records its kernel broken and from then on posts, commits, reveals, boosts and funds nothing; an open bounty returns its reward, escrow and boost at once; anyone can freeze the factory's wallets",
      oldName.includes('0.4.31') &&
        sha(oldKernelWasm) !== sha(kernelWasm) &&
        honestP.success &&
        paid(fundBefore, boardOld.accountId, walletO.accountId) === near('1') &&
        why(freezeBefore) === 'nothing_refuted' &&
        bRafter.phase === 'Paid' &&
        bRafter.certificate.proved === 'False' &&
        bRafter.certificate.side === 'proof' &&
        cfgOld.kernel_broken_by === bR.id &&
        cfgOld.code_refuted_by === null &&
        rootPaid === near('5') + bond &&
        evs(txWin, 'proof-courier', 'kernel_broken').length === 1 &&
        evs(txLose, 'proof-courier', 'kernel_broken').length === 0 &&
        (secondAttempt
          ? secondAttempt.outcome === 'kernel_broken' && secondGot === bond
          : why(txLose) === 'kernel_broken' && secondGot === 0n) &&
        paid(txWin, boardOld.accountId, hLose.accountId) === 0n &&
        why(rootRetry) === 'nothing_owed' &&
        Object.values(shut).every((v) => v === 'kernel_broken') &&
        refundO.success &&
        bOafter.phase === 'Refunded' &&
        bOafter.escrow_state === 'returned' &&
        backO === near('3') &&
        paid(refundO, boardOld.accountId, walletO.accountId) === 0n &&
        why(refundO2) === 'not_refundable' &&
        paid(boostBack, boardOld.accountId, carolO.accountId) === near('0.5') &&
        why(boostBack2) === 'no_boost' &&
        bPafter.phase === 'Paid' &&
        freezeAfter.success &&
        (await frozen(walletO)) &&
        (payO.events[0] || { data: [{}] }).data[0].verdict === 'frozen' &&
        paid(outO, walletO.accountId, ownerO.accountId) === near('3'),
      {
        what_if: true,
        kernel: oldName,
        kernel_wasm: SUPERSEDED_KERNEL,
        kernel_wasm_sha256: sha(oldKernelWasm),
        current_kernel_wasm_sha256: sha(kernelWasm),
        forged: forgedDeltas.map((f) => ({ name: f.name, theorem: f.theorem, delta_sha256: sha(f.delta) })),
        root_bounty: {
          phase: bRafter.phase,
          winner: bRafter.winner,
          paid: rootPaid.toString(),
          certificate: bRafter.certificate,
        },
        second_proof: secondAttempt ? secondAttempt.outcome : why(txLose),
        second_got: secondGot.toString(),
        kernel_broken_by: cfgOld.kernel_broken_by,
        gates_after: shut,
        open_bounty: {
          phase: bOafter.phase,
          escrow: bOafter.escrow_state,
          returned: backO.toString(),
          boost_back: paid(boostBack, boardOld.accountId, carolO.accountId).toString(),
        },
        freeze: {
          before: why(freezeBefore),
          after_frozen: await frozen(walletO),
          owner_withdrew: paid(outO, walletO.accountId, ownerO.accountId).toString(),
        },
      },
    );
  } finally {
    report.finished_at = new Date().toISOString();
    report.summary = {
      pass: report.checks.filter((c) => c.pass).length,
      fail: report.checks.filter((c) => !c.pass).length,
    };
    save();
    await worker.tearDown();
  }
  console.log(
    `\n${report.summary.pass}/${report.checks.length} failure-path checks PASS. Record: ${path.relative(process.cwd(), OUT)}`,
  );
  if (report.summary.fail) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  report.error = String((e && e.stack) || e);
  save();
  process.exit(1);
});
