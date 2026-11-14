// An autonomous prover agent for an Emet bounty board.
//
// One `round()`: read the board, pick the open bounties this agent expects to win, get a proof
// for each (from its solution cache, or live: agent/solve.py runs an LLM in a clean Lean
// workspace), commit, then check it for free with the kernel's dry_run view (after the commit, so
// whoever runs the RPC node cannot commit to it first). `revealDue()`: reveal
// every commitment whose delay has passed, with the bond. `ledger()`: what it spent and earned.
//
// It is transport-agnostic: give it `view(contract, method, args)` and
// `call(contract, method, args, {gas, deposit, raw})`. demo/scenario.cjs drives two of them on a
// local node with near-workspaces accounts; `node agent/courier.cjs --help` runs one against any
// RPC endpoint with a key file (tested on near-sandbox only).
const crypto = require('crypto'),
  fs = require('fs'),
  path = require('path'),
  { execFileSync } = require('child_process');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const YOCTO = 10n ** 24n;
const toNear = (y) => Number(BigInt(y)) / 1e24;

class Courier {
  /**
   * @param {object} o
   * @param {string} o.name           label for logs
   * @param {string} o.accountId      the agent's NEAR account
   * @param {string} o.board, o.kernel contract accounts
   * @param {Function} o.view, o.call transport
   * @param {Function} o.height       async () => current block height
   * @param {object} o.solutions      { "<shelf constant>": { delta: path, cost_usd, model, seconds } }
   * @param {boolean} [o.live]        run agent/solve.py for constants without a cached solution
   * @param {string} [o.model]        model for live solving
   * @param {number} [o.nearUsd]      price used for the expected-value check
   * @param {Function} [o.log]
   */
  constructor(o) {
    Object.assign(
      this,
      { live: false, model: 'opus', nearUsd: 3, shelf: 'shelf/wallet-v5', liveOnly: [], log: () => {} },
      o,
    );
    this.commits = []; // {id, side, name, delta, salt, height}
    this.book = { gas_tgas: 0, fees_near: 0, bonds_near: 0, llm_usd: 0, earned_near: 0, decisions: [] };
  }

  async solve(name) {
    const cached = this.solutions[name];
    if (cached) return { delta: fs.readFileSync(cached.delta), cost_usd: 0, source: 'cache', model: cached.model };
    if (!this.live || (this.liveOnly.length > 0 && !this.liveOnly.includes(name))) return null;
    this.log(`${this.name}: no proof of ${name} yet: writing one now with ${this.model}`);
    const out = fs.mkdtempSync(path.join(require('os').tmpdir(), 'courier-solve-'));
    try {
      execFileSync(
        'python3',
        ['-I', path.join(__dirname, 'solve.py'), name, out, '--model', this.model, '--shelf', this.shelf],
        { stdio: 'ignore' },
      );
    } catch (e) {
      return null;
    }
    const rep = JSON.parse(fs.readFileSync(path.join(out, 'report.json')));
    if (!rep.ready_to_claim) return null;
    this.book.llm_usd += rep.agent.cost_usd || 0;
    this.book.live_solves = (this.book.live_solves || []).concat([
      { name, seconds: rep.agent.seconds, cost_usd: rep.agent.cost_usd, model: this.model, dir: out },
    ]);
    this.log(
      `${this.name}: wrote and checked a proof of ${name} in ${rep.agent.seconds} s for USD ${(rep.agent.cost_usd || 0).toFixed(2)}`,
    );
    return {
      delta: fs.readFileSync(path.join(out, 'delta.ndjson')),
      cost_usd: rep.agent.cost_usd || 0,
      source: 'live',
      model: this.model,
    };
  }

  // Expected value of trying: the reward shared with the agents already committed to it (the
  // board counts commitments), minus what a claim costs (one reveal of gas, the commit fee, and
  // the model time if the proof has to be written). The bond comes back if the proof is accepted
  // or arrives second, and the free dry run makes a rejection unlikely.
  worthIt(b, solveUsd) {
    const reward = toNear(b.reward),
      rivals = Number(b.commitments || 0);
    const cost = 0.05 + 0.01 + solveUsd / this.nearUsd;
    return { reward, rivals, cost, ev: reward / (1 + rivals) - cost };
  }

  async round() {
    const cfg = await this.view(this.board, 'get_config', {});
    this.cfg = cfg;
    const open = (await this.view(this.board, 'list_bounties', {})).filter((b) => b.phase === 'Open');
    for (const b of open) {
      for (const side of ['proof', 'refutation']) {
        const name = side === 'proof' ? b.claim : b.counter_claim;
        if (!name || this.commits.some((c) => c.id === b.id)) continue;
        const sol = await this.solve(name);
        if (!sol) {
          this.book.decisions.push({ id: b.id, side, name, decision: 'skip: no proof' });
          continue;
        }
        const { reward, rivals, cost, ev } = this.worthIt(b, sol.cost_usd);
        if (ev <= 0) {
          this.book.decisions.push({ id: b.id, side, name, decision: 'skip: not worth it', reward, rivals, cost });
          continue;
        }
        // Commit first, then run the free check: the check sends the proof to the RPC node, and whoever
        // runs it could otherwise commit to the same proof first. After our commit, a copy reveals later.
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = sha(
          Buffer.from(`${cfg.commit_domain}\n${b.id}\n${this.accountId}\n${side}\n${sha(sol.delta)}\n${salt}`),
        );
        const t = await this.call(
          this.board,
          'commit',
          { id: b.id, hash },
          { deposit: 10n ** 22n, gas: 30n * 10n ** 12n },
        );
        this.book.gas_tgas += t.tgas;
        this.book.fees_near += 0.01;
        const dry = await this.view(this.kernel, 'dry_run', { theorem_name: name, delta: sol.delta.toString() });
        if (!dry.ok) {
          // keep the commitment unrevealed: losing 0.01 NEAR beats losing the bond
          this.book.decisions.push({
            id: b.id,
            side,
            name,
            decision: 'committed, then own dry run failed: not revealed',
            reason: dry.reason,
          });
          this.log(
            `${this.name}: #${b.id} ${side} (${name}): committed, but the free check failed (${String(dry.reason).slice(0, 60)}): not revealing`,
          );
          break;
        }
        this.commits.push({
          id: b.id,
          side,
          name,
          delta: sol.delta,
          salt,
          height: await this.height(),
          source: sol.source,
          model: sol.model,
          commit_tx: t.hash,
        });
        this.book.decisions.push({
          id: b.id,
          side,
          name,
          decision: 'committed',
          reward,
          rivals,
          cost,
          ev,
          dry_run_ok: dry.ok,
          dry_run_mode: dry.mode,
          proof_bytes: sol.delta.length,
          source: sol.source,
        });
        this.log(
          `${this.name}: #${b.id} ${side} (${name}): ${rivals} rival commitment(s), worth ${ev.toFixed(2)} NEAR: committed, then the free check passed (proof ${sol.delta.length} bytes, ${sol.source})`,
        );
        break; // one side per bounty
      }
    }
  }

  due(height) {
    return this.commits.filter((c) => !c.revealed && height >= c.height + Number(this.cfg.reveal_delay_blocks));
  }

  async revealDue({ only } = {}) {
    const h = await this.height();
    return Promise.all(
      this.due(h)
        .filter((c) => only === undefined || c.id === only)
        .map(async (c) => {
          c.revealed = true;
          const bond = BigInt(this.cfg.reveal_bond);
          const t = await this.call(
            this.board,
            'reveal',
            Buffer.concat([Buffer.from(`${c.id}\n${c.side}\n${c.salt}\n`), c.delta]),
            { deposit: bond, gas: 10n ** 15n, raw: true },
          );
          this.book.gas_tgas += t.tgas;
          const got = (t.transfers || [])
            .filter((x) => x.to === this.accountId && x.from === this.board && x.ok)
            .reduce((a, x) => a + BigInt(x.amount), 0n);
          this.book.earned_near += toNear(got);
          if (t.success) this.book.bonds_near += toNear(bond); // a failed call returns the deposit
          c.result = {
            success: t.success,
            received_near: toNear(got),
            failures: t.failures,
            kernel_tgas: t.kernel_tgas,
            tx: t.hash,
          };
          this.log(
            `${this.name}: revealed #${c.id} ${c.side}: received ${toNear(got)} NEAR${t.success ? '' : ' (' + JSON.stringify(t.failures).slice(0, 80) + ')'}`,
          );
          return { ...c, delta: undefined };
        }),
    );
  }

  ledger(gasPriceYocto = 100000000n) {
    const gasNear = (this.book.gas_tgas * 1e12 * Number(gasPriceYocto)) / 1e24;
    return {
      ...this.book,
      gas_near: gasNear,
      net_near: this.book.earned_near - this.book.bonds_near - this.book.fees_near - gasNear,
      commits: this.commits.map(({ delta, salt, ...c }) => c),
    };
  }
}

module.exports = { Courier };

// ------------------------------------------------------------------------------ CLI
if (require.main === module) {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .map((a, i, all) =>
        a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null,
      )
      .filter(Boolean),
  );
  if (args.help || !args.rpc || !args.account || !args['key-file'] || !args.board) {
    console.log(`usage: node agent/courier.cjs --rpc <url> --account <id> --key-file <ed25519 key json> --board <id>
                           [--solutions <dir with <ShelfConstant>.delta.ndjson>] [--live --model opus] [--rounds 1]
One courier: reads the board, commits to the bounties it can prove (cached proofs or live LLM),
waits for the reveal delay, reveals, prints its ledger with the hashes of its transactions.`);
    process.exit(args.help ? 0 : 64);
  }
  const { connect, keyStores, KeyPair } = require('near-api-js');
  (async () => {
    const key = JSON.parse(fs.readFileSync(args['key-file']));
    const ks = new keyStores.InMemoryKeyStore();
    const near = await connect({ networkId: 'custom', nodeUrl: args.rpc, keyStore: ks });
    await ks.setKey('custom', args.account, KeyPair.fromString(key.private_key || key.secret_key));
    const acct = await near.account(args.account);
    const cfg = await acct.viewFunction({ contractId: args.board, methodName: 'get_config', args: {} });
    const solutions = {};
    if (args.solutions)
      for (const f of fs.readdirSync(args.solutions))
        if (f.endsWith('.delta.ndjson'))
          solutions[f.replace('.delta.ndjson', '')] = { delta: path.join(args.solutions, f) };
    const c = new Courier({
      name: args.account,
      accountId: args.account,
      board: args.board,
      kernel: cfg.kernel,
      solutions,
      live: !!args.live,
      model: args.model || 'opus',
      log: console.log,
      view: (contractId, methodName, a) => acct.viewFunction({ contractId, methodName, args: a }),
      height: async () => (await near.connection.provider.block({ finality: 'final' })).header.height,
      call: async (contractId, methodName, a, o) => {
        let r;
        try {
          r = await acct.functionCall({
            contractId,
            methodName,
            args: a,
            gas: o.gas,
            attachedDeposit: o.deposit,
            stringify: o.raw ? (x) => x : undefined,
          });
        } catch (e) {
          if (!e.transaction_outcome) throw e;
          r = e;
        }
        // Full receipts, to see which transfers the board made to us.
        const raw = await near.connection.provider.sendJsonRpc('EXPERIMENTAL_tx_status', {
          tx_hash: r.transaction.hash,
          sender_account_id: args.account,
          wait_until: 'FINAL',
        });
        const outcomes = new Map(raw.receipts_outcome.map((x) => [x.id, x]));
        const transfers = (raw.receipts || [])
          .filter((rc) => rc.predecessor_id !== 'system' && rc.receipt.Action)
          .flatMap((rc) =>
            rc.receipt.Action.actions
              .filter((x) => x.Transfer)
              .map((x) => ({
                from: rc.predecessor_id,
                to: rc.receiver_id,
                amount: x.Transfer.deposit,
                ok: !!(outcomes.get(rc.receipt_id) && 'SuccessValue' in outcomes.get(rc.receipt_id).outcome.status),
              })),
          );
        const tgas =
          [raw.transaction_outcome, ...raw.receipts_outcome].reduce((s, x) => s + Number(x.outcome.gas_burnt), 0) /
          1e12;
        const failures = raw.receipts_outcome
          .filter((x) => x.outcome.status.Failure)
          .map((x) => x.outcome.status.Failure);
        return {
          success: failures.length === 0 && 'SuccessValue' in raw.status,
          tgas,
          failures,
          transfers,
          hash: r.transaction.hash,
        };
      },
    });
    for (let i = 0; i < Number(args.rounds || 1); i++) {
      await c.round();
      while (c.commits.some((x) => !x.revealed)) {
        await new Promise((r) => setTimeout(r, 1500));
        await c.revealDue();
      }
    }
    console.log(JSON.stringify(c.ledger(), null, 2));
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
