#!/usr/bin/env node
// Claim the bounty for a proof of `False` on a testnet board: commit, wait the reveal delay, reveal.
//
// WITHOUT --send IT ONLY READS: the board's config, the open bounty on `False`, and the free check of the proof
// (a dry_run view call to the board's proof checker). It loads no key and sends nothing.
//
//   node deploy/claim-false.cjs                                     the plan, for the defaults below
//   node deploy/claim-false.cjs --account <you>.testnet --send      commit and reveal, signed with the key of
//                                                                   <you>.testnet in ~/.near-credentials/testnet
//   options: --board <id> (board.v1.emet.testnet)  --delta <file> (cases/intents-refund/forged/builtinGcd.ndjson)
//            --theorem <name of the theorem of type False in it> (builtinGcd.absurd)  --rpc <url>
//            --out <record> (deploy/v1/false-claim.json)
//
// On 13 November 2026 it claimed the bounty on board.v1.emet.testnet. The proof file declares `Nat.gcd`, which
// the sealed environment of that checker does not declare and which the checker computes by itself
// (tools/forge_cheats.py). The checker of v1 accepts it. The checker in artifacts/ refuses it
// (builtin_name_in_delta). Testnet only.
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
  const board = arg('--board', 'board.v1.emet.testnet'),
    rpc = arg('--rpc', 'https://test.rpc.fastnear.com'),
    deltaPath = arg('--delta', 'cases/intents-refund/forged/builtinGcd.ndjson'),
    theorem = arg('--theorem', 'builtinGcd.absurd'),
    account = arg('--account'),
    out = path.resolve(ROOT, arg('--out', 'deploy/v1/false-claim.json'));
  const delta = fs.readFileSync(path.resolve(ROOT, deltaPath));
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
  const near = await nearAPI.connect({ networkId: 'testnet', nodeUrl: rpc, keyStore });
  const status = await near.connection.provider.status();
  if (status.chain_id !== 'testnet') throw Error(`${rpc} is ${status.chain_id}, not testnet`);
  const viewer = await near.account(board);
  const view = (contractId, methodName, args = {}) => viewer.viewFunction({ contractId, methodName, args });
  const cfg = await view(board, 'get_config');
  const root = (await view(board, 'list_bounties', {})).find((b) => b.claim === 'False' && b.phase === 'Open');
  const free = await view(cfg.kernel, 'dry_run', { theorem_name: theorem, delta: delta.toString() }).catch((e) => ({
    ok: false,
    reason: String(e.message || e).slice(0, 200),
  }));
  const plan = {
    board,
    kernel: cfg.kernel,
    kernel_broken_by: cfg.kernel_broken_by,
    bounty: root ? { id: root.id, reward_near: Number(BigInt(root.reward)) / 1e24, deadline: root.deadline } : null,
    delta: { file: deltaPath, bytes: delta.length, sha256: sha(delta), theorem },
    free_check: { ok: free.ok, mode: free.mode, reason: free.reason, statement: free.statement },
  };
  console.log(JSON.stringify(plan, null, 1));
  if (!process.argv.includes('--send')) return console.log('\nNothing was sent. Add --account <id> --send to claim.');
  if (!account) throw Error('--account <id>.testnet is required with --send');
  if (!root) throw Error('no open bounty on False on this board');
  if (!free.ok || free.mode !== 'theorem') throw Error('the free check does not accept this proof of False');

  const who = await near.account(account);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = sha(Buffer.from(`${cfg.commit_domain}\n${root.id}\n${account}\nproof\n${sha(delta)}\n${salt}`));
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
      ok: !failed,
      gas_burnt_tgas: tgas,
      logs: r.receipts_outcome.flatMap((o) => o.outcome.logs),
    };
  };
  const commit = await send('commit', [T.functionCall('commit', { id: root.id, hash }, 100n * TGAS, 10n ** 22n)]);
  if (!commit.ok) throw Error('commit failed');
  const at = (await near.connection.provider.block({ finality: 'final' })).header.height;
  while (
    (await near.connection.provider.block({ finality: 'final' })).header.height <
    at + Number(cfg.reveal_delay_blocks) + 1
  )
    await new Promise((s) => setTimeout(s, 1500));
  const input = Buffer.concat([Buffer.from(`${root.id}\nproof ${theorem}\n${salt}\n`), delta]);
  const reveal = await send('reveal', [
    T.functionCall('reveal', input, 1000n * TGAS, BigInt(cfg.reveal_bond), (x) => x),
  ]);
  const after = await view(board, 'get_config');
  const bounty = await view(board, 'get_bounty', { id: root.id });
  const record = {
    schema: 'emet-false-claim/1',
    network: 'testnet',
    rpc,
    explorer: 'https://testnet.nearblocks.io',
    at: new Date().toISOString(),
    account,
    ...plan,
    commit,
    reveal,
    after: { kernel_broken_by: after.kernel_broken_by, bounty_phase: bounty.phase, winner: bounty.winner || null },
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, null, 1) + '\n');
  console.log(
    `kernel_broken_by: ${after.kernel_broken_by}; bounty ${root.id}: ${bounty.phase}. Record: ${path.relative(ROOT, out)}`,
  );
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
