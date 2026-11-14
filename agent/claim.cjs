#!/usr/bin/env node
// Claim an open bounty of a deployed Emet board with your own account.
//
//   node agent/claim.cjs --account <you>.testnet --key-file <key.json>
//        --key-file  a NEAR credentials file ({"account_id", "private_key"}), e.g. ~/.near-credentials/testnet/<you>.testnet.json
//        --bounty    the id of one open bounty (default: every open one)
//        --record    the deployment record (default deploy/testnet.json);  --rpc  another RPC node
//
// It reads which bounties are open from the board, takes the proof files this repository holds for them, and
// hands both to the courier (agent/courier.cjs): commit, a free check of the proof with a view call, wait for
// the reveal delay, reveal. The kernel contract checks the proof and the board pays the first valid one.
// You need about 4 NEAR on the account: a 0.01 NEAR commit fee, a 0.01 NEAR bond that comes back, and the gas
// reserved for the reveal, most of which is returned.
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};

(async () => {
  const account = arg('--account'),
    keyFile = arg('--key-file');
  if (!account || !keyFile || process.argv.includes('--help')) {
    console.log(
      fs
        .readFileSync(__filename, 'utf8')
        .split('\n')
        .slice(1, 14)
        .map((l) => l.replace(/^\/\/ ?/, ''))
        .join('\n'),
    );
    process.exit(account && keyFile ? 0 : 64);
  }
  const recordFile = path.resolve(arg('--record', path.join(ROOT, 'deploy/testnet.json')));
  if (!fs.existsSync(recordFile)) throw Error(`no deployment record at ${recordFile}`);
  const record = JSON.parse(fs.readFileSync(recordFile));
  const rpc = arg('--rpc', record.rpc);
  if (!rpc) throw Error('the record names no RPC node; pass --rpc');
  const only = arg('--bounty');
  const listed = (record.open_bounties || []).filter((b) => !only || b.id === only);
  if (!listed.length)
    throw Error(
      only
        ? `bounty ${only} is not one of the open bounties of this deployment`
        : 'this deployment left no bounty open',
    );

  const view = async (contract, method, args) => {
    const r = await (
      await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'query',
          params: {
            request_type: 'call_function',
            finality: 'final',
            account_id: contract,
            method_name: method,
            args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
          },
        }),
      })
    ).json();
    if (r.error || r.result.error) throw Error(JSON.stringify(r.error || r.result.error).slice(0, 300));
    return JSON.parse(Buffer.from(r.result.result).toString());
  };
  const board = await view(record.accounts.board, 'list_bounties', {});
  const open = listed.filter((b) => {
    const now = board.find((x) => x.id === b.id);
    return now && now.phase === 'Open';
  });
  for (const b of listed)
    if (!open.includes(b)) {
      const now = board.find((x) => x.id === b.id);
      console.log(
        `#${b.id} (${b.expression}) is no longer open: ${now ? `${now.phase}, ${now.winner || ''}` : 'not on the board'}`,
      );
    }
  if (!open.length) {
    console.log('Nothing left to claim.');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-claim-'));
  try {
    for (const b of open)
      fs.copyFileSync(path.join(ROOT, b.proof_file), path.join(dir, `${b.settles_with}.delta.ndjson`));
    console.log(
      `${account}: ${open.length} open bount${open.length === 1 ? 'y' : 'ies'} on ${record.accounts.board} (${record.network})`,
    );
    const out = execFileSync(
      'node',
      [
        path.join(__dirname, 'courier.cjs'),
        '--rpc',
        rpc,
        '--account',
        account,
        '--key-file',
        path.resolve(keyFile),
        '--board',
        record.accounts.board,
        '--solutions',
        dir,
      ],
      { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const at = out.indexOf('\n{\n');
    process.stdout.write(out.slice(0, at + 1));
    const ledger = JSON.parse(out.slice(at + 1));
    const after = await view(record.accounts.board, 'list_bounties', {});
    const won = open.filter((b) => {
      const now = after.find((x) => x.id === b.id);
      return now && now.winner === account;
    });
    console.log(
      `\npaid for ${won.length} of ${open.length}: ${won.map((b) => `#${b.id}`).join(', ') || 'none'}; received ${ledger.earned_near} NEAR, net of fees and gas ${Number(ledger.net_near).toFixed(4)} NEAR`,
    );
    if (record.explorer) console.log(`${record.explorer}/address/${account}`);
    if (process.argv.includes('--json'))
      console.log(
        JSON.stringify({
          account,
          won: won.map((b) => b.id),
          earned_near: ledger.earned_near,
          net_near: ledger.net_near,
        }),
      );
    if (!won.length) process.exitCode = 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
