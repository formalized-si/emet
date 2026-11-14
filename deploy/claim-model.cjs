#!/usr/bin/env node
// Claim an open refutation bounty on a testnet board with a proof a model already wrote, and write
// evidence/nearai-testnet/claim.json. Commit, wait the reveal delay, reveal. The model holds no key:
// this account signs, the way agent/courier.cjs does.
//
// WITHOUT --send IT ONLY READS: the board, the bounty, and the free check of the proof. It sends nothing.
//
//   node deploy/claim-model.cjs                               the plan, for the defaults below
//   node deploy/claim-model.cjs --account courier.emet.testnet --send
//
//   options: --board (board.v2.emet.testnet)  --bounty (the deposit_only bounty, by its claim)
//            --attempt (evidence/nearai-testnet/deposit_only-deepseek-v4.1-flash)  --rpc  --out
//
// Testnet only.
const nearAPI = require('near-api-js');
if (!process.env.EMET_RECEIPT_LOGS) nearAPI.utils.Logger.overrideLogger(undefined);
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  crypto = require('crypto');
const { keyStores, transactions: T } = nearAPI;
const ROOT = path.resolve(__dirname, '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const TGAS = 10n ** 12n;

(async () => {
  const board = arg('--board', 'board.v2.emet.testnet'),
    rpc = arg('--rpc', 'https://test.rpc.fastnear.com'),
    attempt = arg('--attempt', 'evidence/nearai-testnet/deposit_only-deepseek-v4.1-flash'),
    account = arg('--account'),
    out = path.resolve(ROOT, arg('--out', 'evidence/nearai-testnet/claim.json'));
  const report = JSON.parse(fs.readFileSync(path.resolve(ROOT, attempt, 'report.json')));
  const claimName = report.claim; // the Refute claim this proof refutes
  const delta = fs.readFileSync(path.resolve(ROOT, attempt, 'delta.ndjson'));
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
  const near = await nearAPI.connect({ networkId: 'testnet', nodeUrl: rpc, keyStore });
  if ((await near.connection.provider.status()).chain_id !== 'testnet') throw Error(`${rpc} is not testnet`);
  const viewer = await near.account(board);
  const view = (c, m, a = {}) => viewer.viewFunction({ contractId: c, methodName: m, args: a });
  const cfg = await view(board, 'get_config');
  // The open bounty whose counter_claim this proof refutes.
  const bounty = (await view(board, 'list_bounties', {})).find(
    (b) => b.counter_claim === claimName && b.phase === 'Open',
  );
  const free = await view(cfg.kernel, 'dry_run', { theorem_name: claimName, delta: delta.toString() }).catch((e) => ({
    ok: false,
    reason: String(e.message || e).slice(0, 200),
  }));
  const plan = {
    board,
    kernel: cfg.kernel,
    bounty: bounty ? { id: bounty.id, label: bounty.title, reward_near: Number(BigInt(bounty.reward)) / 1e24 } : null,
    claim: claimName,
    model: report.agent && report.agent.model,
    proof: { file: path.join(attempt, 'delta.ndjson'), bytes: delta.length, sha256: sha(delta) },
    free_check: { ok: free.ok, mode: free.mode, reason: free.reason },
  };
  console.log(JSON.stringify(plan, null, 1));
  if (!process.argv.includes('--send')) return console.log('\nNothing was sent. Add --account <id> --send to claim.');
  if (!account) throw Error('--account <id>.testnet is required with --send');
  if (!bounty) throw Error('no open bounty with this counter_claim on this board');
  if (!free.ok || free.mode !== 'claim') throw Error('the free check does not accept this refutation');

  const who = await near.account(account);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = sha(Buffer.from(`${cfg.commit_domain}\n${bounty.id}\n${account}\nrefutation\n${sha(delta)}\n${salt}`));
  const send = async (label, actions) => {
    const r = await who.signAndSendTransaction({ receiverId: board, actions });
    const failed = r.receipts_outcome.some((o) => o.outcome.status.Failure) || r.status.Failure;
    const tgas =
      Number(
        [r.transaction_outcome, ...r.receipts_outcome].reduce((a, o) => a + BigInt(o.outcome.gas_burnt), 0n) /
          10n ** 9n,
      ) / 1e3;
    console.log(`${label}: ${r.transaction.hash} ${failed ? 'FAILED' : 'ok'} (${tgas} TGas)`);
    return {
      hash: r.transaction.hash,
      explorer: `https://testnet.nearblocks.io/txns/${r.transaction.hash}`,
      ok: !failed,
      gas_burnt_tgas: tgas,
    };
  };
  const before = BigInt((await who.state()).amount);
  const commit = await send('commit', [T.functionCall('commit', { id: bounty.id, hash }, 100n * TGAS, 10n ** 22n)]);
  if (!commit.ok) throw Error('commit failed');
  const at = (await near.connection.provider.block({ finality: 'final' })).header.height;
  while (
    (await near.connection.provider.block({ finality: 'final' })).header.height <
    at + Number(cfg.reveal_delay_blocks) + 1
  )
    await new Promise((s) => setTimeout(s, 1500));
  const input = Buffer.concat([Buffer.from(`${bounty.id}\nrefutation\n${salt}\n`), delta]);
  const reveal = await send('reveal', [
    T.functionCall('reveal', input, 1000n * TGAS, BigInt(cfg.reveal_bond), (x) => x),
  ]);
  const after = BigInt((await who.state()).amount);
  const b2 = await view(board, 'get_bounty', { id: bounty.id });
  const record = {
    schema: 'emet-model-claim/1',
    network: 'testnet',
    rpc,
    explorer: 'https://testnet.nearblocks.io',
    board,
    kernel: cfg.kernel,
    bounty: bounty.id,
    expression: report.expression || report.candidate_expression,
    claim: claimName,
    side: 'refutation',
    model: plan.model,
    served_by: 'NEAR AI Cloud',
    attempt: path.basename(attempt),
    counterexample: report.counterexample,
    proof: plan.proof,
    account,
    who_signed:
      'agent/courier.cjs with the key of ' +
      account +
      ', an account this project created and funded. The model wrote Solution.lean and holds no key.',
    account_created: true,
    commit,
    reveal,
    reward_near: Number(BigInt(bounty.reward)) / 1e24,
    bond_returned_near: Number(BigInt(cfg.reveal_bond)) / 1e24,
    bounty_after: b2.phase,
  };
  fs.writeFileSync(out, JSON.stringify(record, null, 1) + '\n');
  console.log(`bounty ${bounty.id}: ${b2.phase}, winner ${b2.winner}. Record: ${path.relative(ROOT, out)}`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
