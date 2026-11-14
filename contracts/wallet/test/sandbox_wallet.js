// Sandbox test of the Lean-compiled wallet: every ABI path, balances, events, gas.
// usage: NODE_PATH=<near-workspaces node_modules> node sandbox_wallet.js wallet.wasm
const localNode = require('../../../tools/local-node.cjs');
const fs = require('fs');
const U = n => String(Math.round(n * 1e6));            // NEAR -> policy units (1 unit = 1e18 yocto)
const tg = r => (Number(r.result.receipts_outcome[0].outcome.gas_burnt) / 1e12).toFixed(3);
const status = r => { const s = r.result.status; return s.SuccessValue !== undefined ? Buffer.from(s.SuccessValue, 'base64').toString() : 'FAILURE ' + JSON.stringify(s.Failure).replace(/.*ExecutionError":"/, '').slice(0, 90); };
const logs = r => r.result.receipts_outcome.flatMap(x => x.outcome.logs);
(async () => {
  const worker = await localNode('wallet-test'); const root = worker.rootAccount;
  const mk = (n, bal = '10') => root.createSubAccount(n, { initialBalance: (BigInt(bal) * 10n ** 24n).toString() });
  const [wallet, owner, agent, wa, wb, stranger] = await Promise.all([mk('wallet', '40'), mk('owner'), mk('agent'), mk('worker-a', '1'), mk('worker-b', '1'), mk('stranger')]);
  await wallet.deploy(fs.readFileSync(process.argv[2]));
  const policy = { budget: U(20), per_tx: U(5), per_day: U(10), day_ns: '86400000000000', allowed: [wa.accountId, wb.accountId] };
  const rows = []; let pass = 0, n = 0;
  const record = (r, want, label, method) => {
    const got = status(r), ok = want instanceof RegExp ? want.test(got) : got.includes(want);
    n++; pass += ok;
    const ev = logs(r).filter(l => l.startsWith('EVENT_JSON')).map(l => JSON.parse(l.slice(11)).data[0].verdict || JSON.parse(l.slice(11)).event);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label.padEnd(44)} ${tg(r)} TGas  -> ${got.slice(0, 110)}${ev.length ? '  events=' + ev.join(',') : ''}`);
    rows.push({ label, method, ok, gas_tgas: Number(tg(r)), result: got.slice(0, 300), logs: logs(r) });
    return r;
  };
  const callAt = async (who, target, method, args, want, label) => record(await who.callRaw(target, method, args, { gas: '300000000000000' }), want, label, method);
  const call = (who, method, args, want, label) => callAt(who, wallet, method, args, want, label);
  await call(stranger, 'init', { owner: owner.accountId, agent: agent.accountId, policy }, 'ERR_INIT_NOT_SELF_OR_PARENT', 'init by a stranger');
  await call(wallet, 'init', { owner: owner.accountId, agent: agent.accountId, policy }, '{"ok":true}', 'init by the wallet itself');
  await call(wallet, 'init', { owner: owner.accountId, policy }, 'ERR_ALREADY_INITIALIZED', 'init twice');
  // A factory: the account directly above the wallet creates it and calls init in the same transaction.
  const wasm = fs.readFileSync(process.argv[2]);
  const kid = `kid.${owner.accountId}`, late = `late.${owner.accountId}`;
  record(await owner.batch(kid).createAccount().transfer('2000000000000000000000000').deployContract(wasm)
    .functionCall('init', { owner: owner.accountId, policy }, { gas: '100000000000000' }).transact(), '{"ok":true}', 'init by the parent, in the creating transaction', 'init');
  await owner.batch(late).createAccount().transfer('2000000000000000000000000').deployContract(wasm).transact();
  await callAt(root, late, 'init', { owner: root.accountId, policy }, 'ERR_INIT_NOT_SELF_OR_PARENT', 'init by the grandparent');
  await callAt(stranger, late, 'init', { owner: stranger.accountId, policy }, 'ERR_INIT_NOT_SELF_OR_PARENT', 'init of a sub-account by a stranger');
  await callAt(owner, late, 'init', { owner: owner.accountId, policy }, '{"ok":true}', 'init by the parent, later');
  const meta = await wallet.view('get_code_meta', {}); console.log('code_meta', JSON.stringify(meta));
  console.log('policy', JSON.stringify(await wallet.view('get_policy', {})));
  const before = (await wa.balance()).total;
  await call(agent, 'pay', { to: wa.accountId, amount: U(2) }, '"verdict":"OK"', 'agent pays 2 NEAR to worker-a');
  const after = (await wa.balance()).total;
  const delta = BigInt(after.toString()) - BigInt(before.toString());
  console.log(`worker-a balance delta = ${delta} yocto (want 2000000000000000000000000)`); n++; pass += delta === 2000000000000000000000000n;
  const su0 = (await wallet.accountView()).storage_usage;
  await call(agent, 'pay', { to: wa.accountId, amount: U(500) }, '"verdict":"DENY_PER_TX"', 'agent pays 500 NEAR');
  await call(agent, 'pay', { to: 'drain.test.near', amount: U(1) }, '"verdict":"DENY_RECEIVER"', 'agent pays drain.test.near');
  await call(agent, 'pay', { to: wa.accountId, amount: '18446744073709551615' }, '"verdict":"DENY_PER_TX"', 'amount u64 max (per-tx check first)');
  await call(stranger, 'pay', { to: wa.accountId, amount: U(1) }, '{"verdict":"DENY_CALLER"}', 'stranger calls pay');
  await call(stranger, 'pay', 'not json', '{"verdict":"DENY_CALLER"}', 'stranger sends garbage');
  const su1 = (await wallet.accountView()).storage_usage;
  console.log(`storage_usage before/after 5 denials: ${su0} / ${su1}`); n++; pass += su0 === su1;
  await call(agent, 'pay', { to: wb.accountId, amount: U(5) }, '"verdict":"OK"', 'agent pays 5 NEAR to worker-b');
  await call(agent, 'pay', { to: wa.accountId, amount: U(5) }, '"verdict":"DENY_DAILY"', 'agent pays 5 more (day: 7+5 > 10)');
  await call(agent, 'pay', { amount: U(1), to: wa.accountId }, '"verdict":"OK"', 'key order swapped, 1 NEAR');
  await call(owner, 'pay', { to: wa.accountId, amount: U(1) }, '"verdict":"OK"', 'owner pays 1 NEAR');
  await call(agent, 'pay', '{"to":"worker-a.test.near","amount":"-1"}', 'ERR_INPUT', 'amount "-1"');
  await call(agent, 'pay', '{"to":"worker-a.test.near","amount":"abc"}', 'ERR_INPUT', 'amount "abc"');
  await call(agent, 'pay', '{"to":"worker-a.test.near","amount":"18446744073709551616"}', 'ERR_INPUT', 'amount 2^64');
  await call(agent, 'pay', '{"to":"worker-a.test.near","amount":"1","to":"drain.test.near"}', 'ERR_INPUT', 'duplicate "to" key');
  await call(agent, 'pay', JSON.stringify({ to: wa.accountId, amount: '1', pad: 'x'.repeat(1100) }), 'ERR_INPUT_TOO_LARGE', 'input > 1 KiB');
  await call(agent, 'set_policy', { policy: { ...policy, per_tx: U(1) } }, '{"verdict":"DENY_CALLER"}', 'agent calls set_policy');
  await call(owner, 'set_policy', { policy: { ...policy, budget: U(30) } }, '{"verdict":"REJECTED_NOT_TIGHTER"}', 'owner loosens budget 20 -> 30');
  await call(owner, 'set_policy', { policy: { ...policy, allowed: [wa.accountId, wb.accountId, 'drain.test.near'] } }, '{"verdict":"REJECTED_NOT_TIGHTER"}', 'owner adds drain to allowlist');
  await call(agent, 'set_agent', { agent: stranger.accountId }, '{"verdict":"DENY_CALLER"}', 'agent calls set_agent');
  await call(owner, 'set_agent', { agent: stranger.accountId }, '{"verdict":"OK"}', 'owner sets agent = stranger');
  await call(agent, 'pay', { to: wa.accountId, amount: U(0.5) }, '{"verdict":"DENY_CALLER"}', 'old agent pays after set_agent');
  await call(owner, 'set_agent', { agent: agent.accountId }, '{"verdict":"OK"}', 'owner restores agent');
  await call(owner, 'set_policy', { policy: { ...policy, per_tx: U(4), allowed: [wa.accountId] } }, '{"verdict":"OK"}', 'owner tightens per_tx 5->4, drops worker-b');
  await call(agent, 'pay', { to: wb.accountId, amount: U(1) }, '"verdict":"DENY_RECEIVER"', 'pay worker-b after tightening');
  const st = await wallet.view('get_state', {}); console.log('state', JSON.stringify(st));
  n++; pass += st.spent_total === U(9) && st.nonce === '4';
  // Frozen: only the board named at init may freeze; then pay answers FROZEN and the owner alone can withdraw, to itself.
  const board = await mk('board'), icy = `icy.${owner.accountId}`;
  record(await owner.batch(icy).createAccount().transfer('5000000000000000000000000').deployContract(wasm)
    .functionCall('init', { owner: owner.accountId, agent: agent.accountId, policy, board: board.accountId }, { gas: '100000000000000' }).transact(), '{"ok":true}', 'init with a board', 'init');
  await call(board, 'freeze', {}, 'ERR_FREEZE_NOT_BOARD', 'freeze of a wallet that has no board');
  await callAt(stranger, icy, 'freeze', {}, 'ERR_FREEZE_NOT_BOARD', 'freeze by a stranger');
  await callAt(owner, icy, 'freeze', {}, 'ERR_FREEZE_NOT_BOARD', 'freeze by the owner');
  await callAt(agent, icy, 'pay', { to: wa.accountId, amount: U(1) }, '"verdict":"OK"', 'agent pays 1 NEAR before the freeze');
  await callAt(owner, icy, 'withdraw', { amount: U(1) }, '{"verdict":"NOT_FROZEN"}', 'owner withdraws before the freeze');
  const pol0 = await root.getAccount(icy).view('get_policy', {});
  await callAt(board, icy, 'freeze', {}, '{"frozen":true}', 'freeze by the board');
  await callAt(board, icy, 'freeze', {}, '{"frozen":true}', 'freeze twice');
  const stFrozen = await root.getAccount(icy).view('get_state', {});
  await callAt(agent, icy, 'pay', { to: wa.accountId, amount: U(1) }, '{"verdict":"FROZEN"}', 'agent pays after the freeze');
  await callAt(owner, icy, 'pay', { to: wa.accountId, amount: U(1) }, '{"verdict":"FROZEN"}', 'owner pays after the freeze');
  await callAt(stranger, icy, 'pay', { to: wa.accountId, amount: U(1) }, '{"verdict":"DENY_CALLER"}', 'stranger pays after the freeze');
  await callAt(agent, icy, 'withdraw', { amount: U(1) }, '{"verdict":"DENY_CALLER"}', 'agent withdraws');
  await callAt(owner, icy, 'withdraw', { amount: 'abc' }, 'ERR_AMOUNT', 'withdraw "abc"');
  await callAt(owner, icy, 'withdraw', { amount: '18446744073709551616' }, 'ERR_AMOUNT', 'withdraw 2^64');
  const icyBal = async () => BigInt((await root.getAccount(icy).balance()).total.toString());
  const icyBefore = await icyBal();
  const wd = await callAt(owner, icy, 'withdraw', { amount: U(3) }, '"verdict":"OK"', 'owner withdraws 3 NEAR');
  const left = icyBefore - await icyBal();   // 3 NEAR out, minus the wallet's share of the call's gas
  const toOwner = wd.result.receipts_outcome.length >= 2 && wd.result.receipts_outcome[1].outcome.executor_id === owner.accountId;
  console.log(`frozen wallet balance delta = -${left} yocto (want 3 NEAR, less its gas reward), transfer receipt executed on the owner: ${toOwner}`);
  n++; pass += left > 2999000000000000000000000n && left <= 3000000000000000000000000n && toOwner;
  const pol1 = await root.getAccount(icy).view('get_policy', {}), stAfter = await root.getAccount(icy).view('get_state', {});
  console.log('frozen policy', JSON.stringify(pol1));
  n++; pass += pol0.frozen === false && pol0.board === board.accountId && pol1.frozen === true && JSON.stringify(stAfter) === JSON.stringify(stFrozen);
  n++; pass += (await wallet.view('get_policy', {})).board === null && (await wallet.view('get_policy', {})).frozen === false;
  console.log(`checks ${pass}/${n}`);
  fs.writeFileSync(process.argv[3] || 'sandbox_wallet.json', JSON.stringify({ wasm_bytes: fs.statSync(process.argv[2]).size, code_meta: meta, final_state: st, pass, n, rows }, null, 2));
  await worker.tearDown();
  if (pass !== n) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
