// The proof-gated repair page. It works in three settings and says which one it is in:
//   live    a record written by deploy/live-refund.cjs is published next to it (deploy/testnet.json): the button
//           makes read-only calls from the browser straight to the kernel contract on that network;
//   local   ./verify.sh --serve is running: the button asks the local server, which calls its own fresh kernel;
//   record  neither: the recorded evidence is shown and the button is off.
import { inspectPatchEvidence, inspectPatchResponse, inspectLiveRecord } from './patch-evidence.mjs';

const $ = (id) => document.getElementById(id);
const get = async (url) => {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) {
    r.body?.cancel();
    throw Error(`HTTP ${r.status}: ${url}`);
  }
  return r.json();
};
const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children);
  return n;
};
const link = (href, text) =>
  href ? el('a', { href, target: '_blank', rel: 'noopener', textContent: text }) : el('span', { textContent: text });
const short = (s, n = 10) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-6)}` : s);
// A Rust expression that may wrap before a method call, not in the middle of a name.
const rust = (s) => {
  const c = el('code');
  s.split(/(?=\.min\()/).forEach((part, i) => {
    if (i) c.append(document.createElement('wbr'));
    c.append(part);
  });
  return c;
};
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

const REPOSITORY = 'https://github.com/formalized-si/emet';
let catalog,
  mode = 'record',
  live = null,
  busy = false,
  ready = false,
  modelClaim = null;

function table(rows, head) {
  const t = document.createElement('table');
  if (head) {
    const r = t.createTHead().insertRow();
    for (const h of head) r.append(el('th', { scope: 'col', textContent: h }));
  }
  const body = t.createTBody();
  for (const cells of rows) {
    const row = body.insertRow();
    cells.forEach((c, i) => {
      const cell = i === 0 && !head ? el('th', { scope: 'row' }) : document.createElement('td');
      cell.append(c instanceof Node ? c : String(c));
      row.append(cell);
    });
  }
  return t;
}

function selection() {
  const c = catalog?.candidates.find((c) => c.label === $('candidate').value);
  if (!c) return null;
  $('expression').replaceChildren('let refund_amount = ', ...rust(c.expression).childNodes, ';');
  $('source-hash').textContent = `Source SHA-256 ${c.source_sha256}`;
  $('patch-result').hidden = true;
  $('check-patch').disabled = !ready || busy;
  return c;
}

// ---- asking a kernel ------------------------------------------------------------------------------------
// Public RPC nodes for a network, tried in order after the one the record names: any of them gives the same answer.
const OTHER_NODES = { testnet: ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'] };
async function rpcQuery(rpc, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { finality: 'final', ...params } });
  let r = null,
    problem = null;
  for (const node of [rpc, ...((live && OTHER_NODES[live.network]) || []).filter((n) => n !== rpc)]) {
    try {
      r = await fetch(node, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (r.ok) break;
      problem = `HTTP ${r.status}`;
      r = null;
    } catch (e) {
      problem = e.message;
      r = null;
    }
  }
  if (!r) throw Error(`No RPC node answered (${problem}).`);
  const answer = await r.json();
  if (answer.error) throw Error(`The RPC node refused the call: ${JSON.stringify(answer.error).slice(0, 200)}`);
  return answer.result;
}
async function viewCall(rpc, account, method, args) {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const result = await rpcQuery(rpc, {
    request_type: 'call_function',
    account_id: account,
    method_name: method,
    args_base64: btoa(binary),
  });
  if (result.error) return { trap: result.error, block_height: result.block_height };
  return {
    value: JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))),
    block_height: result.block_height,
  };
}

async function checkLive(c) {
  let proof = await (await fetch(`../../cases/intents-refund/proofs/${c.label}.ndjson`, { cache: 'no-store' })).text();
  const damaged = $('damage').checked;
  if (damaged) {
    // the theorem's last line then names the term one before its real proof
    const lines = proof.replace(/\n$/, '').split('\n'),
      row = JSON.parse(lines.pop());
    row.thm.value -= 1;
    proof = [...lines, JSON.stringify(row)].join('\n') + '\n';
  }
  const started = performance.now();
  const answer = await viewCall(live.rpc, live.accounts.kernel, 'dry_run', { theorem_name: c.proved, delta: proof });
  const result = answer.value || { ok: false, reason: 'kernel_trap', detail: String(answer.trap).slice(0, 300) };
  const digest = crypto.subtle ? hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proof))) : null;
  return {
    candidate: c.label,
    source_sha256: c.source_sha256,
    claim: c.proved,
    network: live.network,
    kernel: live.accounts.kernel,
    damaged,
    decision: result.ok === true ? (c.proved === c.claim ? 'proved' : 'refuted') : 'unverified',
    checked_at: new Date().toISOString(),
    block_height: answer.block_height,
    milliseconds: Math.round(performance.now() - started),
    proof_sha256: digest,
    proof_bytes: new TextEncoder().encode(proof).length,
    result,
  };
}

async function checkLocal(c) {
  const r = await fetch('/api/patches/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ candidate: c.label }),
  });
  const result = await r.json();
  if (!r.ok || result.error) throw Error(result.error || 'No check result');
  return result;
}

// Why the contract did not accept: its own reason, or the last line of the type checker's panic when the call trapped.
function why(verdict) {
  const panic = /panic_msg: "([\s\S]*?)" \}/.exec(verdict.detail || '');
  if (panic)
    return `The contract's type checker stopped: "${panic[1]
      .split(/\\n|\n/)
      .pop()
      .slice(0, 160)}".`;
  return `The contract answered: ${String(verdict.reason || verdict.detail || 'not accepted').slice(0, 220)}`;
}

function showVerdict(c, result) {
  $('patch-result').hidden = false;
  $('proof-response').textContent = JSON.stringify(result, null, 2);
  const proved = result.decision === 'proved',
    refuted = result.decision === 'refuted',
    turnedAway = result.damaged && !proved && !refuted;
  $('decision').textContent = proved
    ? 'Proved: this patch meets the refund rule.'
    : refuted
      ? 'Refuted: this patch breaks the refund rule.'
      : turnedAway
        ? 'Refused: the contract did not accept the damaged proof.'
        : 'No verified result.';
  $('decision').className = proved || turnedAway ? 'good' : 'bad';
  $('explanation').textContent = proved
    ? 'The proof checker accepted a proof that the patch meets every line of the rule, for every u128 input.'
    : refuted
      ? `The proof checker accepted a counterexample. With these inputs the patch returns ${c.counterexample?.breaks || 'the wrong amount'}:`
      : turnedAway
        ? `The page changed one number in the last line of the proof file before it sent the file. ${why(result.result)}`
        : 'The contract did not accept the supplied proof.';
  $('counterexample').replaceChildren();
  if (refuted && c.counterexample) {
    const w = c.counterexample;
    $('counterexample').append(
      table([
        ['Requested', w.requested_refund],
        ['Deposited', w.deposited],
        ['Balance left', w.balance_left],
        ['This patch returns', w.actual],
        ['The rule requires', w.expected],
      ]),
    );
  }
  const who = mode === 'live' ? result.kernel : 'The proof checker on the local node',
    block = mode === 'live' ? ` at block ${result.block_height}` : '';
  $('patch-status').textContent =
    `${who} checked ${result.proof_bytes.toLocaleString()} proof bytes${block}${result.milliseconds ? ` in ${(result.milliseconds / 1000).toFixed(1)} s` : ''}.`;
  $('patch-result').scrollIntoView({ block: 'nearest' });
}

$('candidate').addEventListener('change', selection);
$('damage').addEventListener('change', selection);
$('check-patch').addEventListener('click', async () => {
  const c = selection();
  if (!c || !ready || busy) return;
  busy = true;
  $('candidate').disabled = true;
  $('check-patch').disabled = true;
  $('patch-status').textContent =
    mode === 'live' ? `The page calls ${live.accounts.kernel}…` : 'The local proof checker checks the proof bytes…';
  try {
    const result = mode === 'live' ? await checkLive(c) : await checkLocal(c);
    inspectPatchResponse(result, c);
    if ($('candidate').value !== c.label) throw Error('The selection changed. Check the selected patch again.');
    showVerdict(c, result);
  } catch (e) {
    $('patch-status').textContent = e.message;
  } finally {
    busy = false;
    $('candidate').disabled = false;
    $('check-patch').disabled = !ready;
  }
});

// ---- which setting are we in ----------------------------------------------------------------------------
const onThisMachine = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
async function connectLocal() {
  // ./verify.sh --serve answers here. A static host does not, and is not asked.
  if (!onThisMachine) return false;
  let s;
  try {
    s = await get('/api/patches/status');
  } catch {
    return false;
  }
  mode = 'local';
  ready = s.ready === true;
  $('network-line').textContent = live
    ? 'PROOF-GATED CONTRACT UPGRADES · LOCAL PROOF CHECKER · THE RECORD BELOW IS NEAR TESTNET'
    : 'PROOF-GATED CONTRACT UPGRADES · NEAR · LOCAL NODE';
  $('patch-status').textContent = ready
    ? `Ready: ${s.kernel} on a local NEAR node.`
    : s.error || 'The server prepares a fresh local proof checker…';
  $('check-note').textContent =
    'The button makes a new read-only call to a proof checker on a local NEAR node that ./verify.sh --serve started. The proof files are the ones in this repository. The button does not call a model, move money or install anything.' +
    (live
      ? ' The accounts below are the deployment on NEAR testnet. This button does not ask that deployment, and python3 tools/check_live.py does.'
      : '');
  $('check-patch').disabled = !ready || busy;
  if (!ready && !s.error) setTimeout(connectLocal, 2000);
  return true;
}
async function connect() {
  if (await connectLocal()) return;
  if (!live || !live.rpc) {
    $('patch-status').textContent =
      'No proof checker is reachable from this page. Run ./verify.sh --serve for a local one. The recorded transactions are below.';
    return;
  }
  mode = 'live';
  $('damage-row').hidden = false;
  const name = live.network === 'testnet' ? 'NEAR testnet' : 'a local NEAR node';
  $('check-note').textContent =
    `The button makes a read-only call to ${live.accounts.kernel} on ${name}. It costs nothing and needs no wallet. The proof files are the ones in this repository. The page sends their bytes to the contract and shows the answer.`;
  try {
    const status = await viewCall(live.rpc, live.accounts.kernel, 'status', {});
    ready = status.value?.sealed === true && status.value.checked_upto === live.declarations;
    $('patch-status').textContent = ready
      ? `Ready: ${live.accounts.kernel} on ${name}, ${live.declarations} declarations type-checked on-chain.`
      : 'The proof checker on this network has no sealed environment.';
  } catch (e) {
    $('patch-status').textContent = `The page cannot reach the proof checker: ${e.message}`;
  }
  $('check-patch').disabled = !ready || busy;
}

function showLive(d) {
  const tx = (step) => link(d.story[step].explorer, short(d.story[step].hash));
  const address = (id) => link(d.explorer && `${d.explorer}/address/${id}`, id);
  const tgas = (step) => `${Math.round(d.story[step].gas_burnt_tgas)} TGas`;
  const name = d.network === 'testnet' ? 'NEAR testnet' : 'a local NEAR node';
  $('network-line').textContent =
    d.network === 'testnet'
      ? 'PROOF-GATED CONTRACT UPGRADES · LIVE ON NEAR TESTNET'
      : 'PROOF-GATED CONTRACT UPGRADES · NEAR · LOCAL REHEARSAL';
  const strip = $('live-strip');
  strip.hidden = false;
  strip.replaceChildren(
    el('div', {}, el('dt', { textContent: 'Proof checker' }), el('dd', {}, address(d.accounts.kernel))),
    el('div', {}, el('dt', { textContent: 'Upgraded contract' }), el('dd', {}, address(d.accounts.intents))),
    el('div', {}, el('dt', { textContent: 'Gate' }), el('dd', {}, address(d.accounts.gate))),
    el(
      'div',
      {},
      el('dt', { textContent: 'Access keys on any of them' }),
      el('dd', { id: 'keys-now', textContent: d.rpc ? 'the page reads the chain…' : 'none in the record' }),
    ),
  );
  if (d.rpc)
    Promise.all(
      [d.accounts.kernel, d.accounts.board, d.accounts.gate, d.accounts.intents, d.accounts.ledger].map((id) =>
        rpcQuery(d.rpc, { request_type: 'view_access_key_list', account_id: id }),
      ),
    )
      .then((lists) => {
        const n = lists.reduce((sum, l) => sum + l.keys.length, 0);
        $('keys-now').textContent = n === 0 ? 'none, read from the chain now' : `${n}, read from the chain now`;
      })
      .catch(() => {
        $('keys-now').textContent = 'none in the record (the page cannot read the chain now)';
      });
  $('old-gap').textContent = d.story.old_batch.unbacked_added;
  $('new-gap').textContent = d.story.new_batch.unbacked_added;
  $('failure').hidden = false;
  $('backing-fact').replaceChildren(
    `On ${name} the receiver's credit grew by ${d.story.old_batch.unbacked_added} while every token went back to the sender (`,
    tx('old_batch'),
    '). After the upgrade the same batch leaves nothing behind (',
    tx('new_batch'),
    ').',
  );
  const rows = [
    [
      'A deposit of 1, and the receiver asks for 100 back',
      `The old code answers ${d.story.old_refund.value[0]}`,
      tx('old_refund'),
    ],
    [
      'Eighty transfers of 1 through the token contract, each with a request for 10³⁵ back',
      `The refund callback fails on the log limit, and ${d.story.old_batch.unbacked_added} credits stay with no tokens behind them`,
      tx('old_batch'),
    ],
    ['The guardian pauses deposits', 'One transaction. The contract refuses deposits from then on', tx('paused')],
    ['A caller asks for the upgrade before any proof exists', 'Refused: no certificate', tx('upgrade_refused')],
    ['A caller offers a binary that differs in one bit', 'Refused by its hash', tx('binary_refused')],
    [
      'A prover submits a counterexample to the old expression',
      `The proof checker checks it (${tgas('refutation_paid')}), and the board pays its author`,
      tx('refutation_paid'),
    ],
    [
      `A prover submits a proof for the fix (${d.story.proof_paid.proof_bytes.toLocaleString('en-US')} bytes)`,
      `The proof checker checks it (${tgas('proof_paid')}), and the board pays its author`,
      tx('proof_paid'),
    ],
    [
      'A caller asks for the upgrade again',
      'The gate reads the certificate and installs the registered binary',
      tx('upgrade_applied'),
    ],
    ['The guardian lets deposits resume', 'One transaction', tx('unpaused')],
    ['The same deposit of 1, same account', `Answers ${d.story.new_refund.value[0]}`, tx('new_refund')],
    [
      'The same eighty transfers, same account',
      'The batch completes, and no credit stays without backing',
      tx('new_batch'),
    ],
  ];
  const box = $('upgrade-evidence');
  box.replaceChildren(el('div', { className: 'tx-table' }, table(rows, ['Step', 'Result', 'Transaction'])));
  const accounts = el(
    'p',
    { className: 'muted' },
    'The record lists no access key on ',
    address(d.accounts.kernel),
    ', ',
    address(d.accounts.board),
    ', ',
    address(d.accounts.gate),
    ', ',
    address(d.accounts.intents),
    ' or the token ledger. The contract’s own role list names the gate as the only account that can upgrade it, and ',
    address(d.accounts.guardian),
    ' as the only one that can pause it. The guardian can stop deposits within one transaction. It cannot change the code.',
  );
  const verify = el(
    'details',
    {},
    el('summary', { textContent: 'Check all of this yourself in about a minute' }),
    el('pre', { textContent: 'python3 tools/check_live.py' }),
    el('p', {
      textContent:
        'The script uses read-only queries and the Python standard library. It compares the code on the network with the binaries in this repository. It lists the access keys and reads the certificates. It asks the proof checker to accept the real proofs and to refuse wrong ones.',
    }),
  );
  box.append(accounts, verify);
  if (d.kernelBounty) showKernelBounty(d);
  if (d.open.length) showOpenBounties(d);
}

// The bounty on the proof checker itself: its state and the board's flag are read when the page loads.
async function showKernelBounty(d) {
  const state = el('span', { textContent: d.rpc ? 'the page reads the board…' : 'open in the record' });
  const section = el(
    'div',
    { id: 'kernel-bounty' },
    el('h3', { textContent: 'If the proof checker itself is wrong' }),
    el(
      'p',
      {},
      `A bounty of ${d.kernelBounty.reward_near} NEAR stands on the same board for a proof of `,
      el('code', { textContent: 'False' }),
      '. If the proof checker accepts such a proof, the board records its proof checker as broken and pays the finder. The gate then installs nothing more. Now: ',
      state,
      '.',
    ),
  );
  $('upgrade-evidence').append(section);
  if (!d.rpc) return;
  try {
    const [bounty, config] = await Promise.all([
      viewCall(d.rpc, d.accounts.board, 'get_bounty', { id: d.kernelBounty.id }),
      viewCall(d.rpc, d.accounts.board, 'get_config', {}),
    ]);
    state.textContent =
      config.value?.kernel_broken_by == null && bounty.value?.phase === 'Open'
        ? 'open, unclaimed'
        : `claimed: the board records the proof checker as broken (${bounty.value?.phase})`;
  } catch {
    state.textContent = 'the page cannot read the board';
  }
}

// Bounties left open for anyone: their state is read from the board when the page loads, not from the record.
async function showOpenBounties(d) {
  const address = (id) => link(d.explorer && `${d.explorer}/address/${id}`, id);
  const section = el(
    'div',
    { id: 'open-bounties' },
    el('h3', { textContent: 'Open to anyone' }),
    el(
      'p',
      {},
      `We posted ${['no', 'one', 'two', 'three', 'four', 'five'][d.open.length] || d.open.length} more ${d.open.length === 1 ? 'bounty' : 'bounties'} on the same board for anyone to claim, on the other patches above. Their proofs are in this repository. The board pays the first account that submits one, and nobody needs permission. The page reads the state of each from the board now.`,
    ),
  );
  const rows = d.open.map((b) => [
    rust(b.expression),
    `${b.reward_near} NEAR`,
    el('span', { textContent: 'the page reads the board…', id: `open-${b.id}` }),
  ]);
  section.append(
    el('div', { className: 'tx-table' }, table(rows, ['Patch', 'Reward', 'State on the board now'])),
    el(
      'details',
      {},
      el('summary', { textContent: 'Claim one' }),
      el('pre', { textContent: 'node agent/claim.cjs --account <you>.testnet --key-file <your key file>' }),
      el('p', {
        textContent:
          'The command commits, checks the proof with a free call, waits one block and reveals. The proof checker contract checks the proof, and the board pays your account in the same transaction.',
      }),
    ),
  );
  $('upgrade-evidence').append(section);
  if (!d.rpc) {
    for (const b of d.open) $(`open-${b.id}`).textContent = 'open in the record';
    return;
  }
  try {
    const board = (await viewCall(d.rpc, d.accounts.board, 'list_bounties', {})).value || [];
    for (const b of d.open) {
      const now = board.find((x) => x.id === b.id),
        cell = $(`open-${b.id}`);
      if (!now) cell.textContent = 'not found on the board';
      else if (now.phase === 'Open') cell.textContent = 'open';
      else
        cell.replaceChildren(
          `${now.phase.toLowerCase()}: `,
          address(now.winner || now.claimer || 'unknown'),
          ...(modelClaim && modelClaim.bounty === b.id && now.winner === modelClaim.account
            ? [`, for a counterexample that ${modelClaim.model.split('/').pop()} wrote`]
            : []),
        );
    }
  } catch (e) {
    for (const b of d.open) $(`open-${b.id}`).textContent = 'the page cannot read the board';
  }
}

function showRecorded(replay, upgrade) {
  const d = inspectPatchEvidence(replay, upgrade, catalog);
  if (live) return;
  $('backing-fact').textContent =
    `We recorded real NEP-245 transfers between two upstream contracts on a local node. The old code leaves ${d.badGap} credits without backing, and the fix leaves ${d.goodGap}.`;
  $('old-gap').textContent = d.badGap;
  $('new-gap').textContent = d.goodGap;
  $('failure').hidden = false;
  const box = $('upgrade-evidence');
  box.replaceChildren(
    table([
      ['Without a proof', 'The old code stays installed'],
      ['With the proof of the fix', 'The same account returns 1, where the old code returned 100'],
      ['Existing balance', `${upgrade.balances.before_upgrade} before, ${upgrade.balances.after_upgrade} after`],
      ['Prover reward', 'The bounty contract pays it'],
    ]),
  );
  box.append(
    el(
      'details',
      {},
      el('summary', { textContent: 'Inspect the source and deployment binding' }),
      table([
        ['Wrong binary chunk', 'Refused by its content hash'],
        ['Paid counterexample', 'Cannot authorize installation'],
        ['Certificate of the fix', d.cert.proved],
        ['Installed WASM SHA-256', d.built.wasm_sha256],
        ['Prover', upgrade.repair_bounty.winner],
        ['Control keys', 'None on kernel, board, gate or target'],
      ]),
    ),
    el('p', {
      className: 'muted',
      textContent:
        'These are recorded transactions on a local node. ./verify.sh --refund builds everything from source and runs them again.',
    }),
  );
}

// What open-weight models on NEAR AI Cloud did with the same task: read from the record of those runs.
async function showAgent() {
  let a;
  try {
    a = await get('../../evidence/nearai-refund/attempts.json');
  } catch {
    return;
  }
  const accepted = a.attempts.filter((x) => x.accepted);
  if (!accepted.length) return;
  const word = (n) => ['no', 'one', 'two', 'three', 'four', 'five', 'six'][n] || n;
  const models = new Set(a.attempts.map((x) => x.model)).size;
  const rows = a.attempts.map((x) => [
    x.model.split('/').pop() + (x.no_axioms_asked ? ', asked to use no axiom' : ''),
    rust(x.expression || x.bound_without_a_proof || 'none'),
    x.accepted ? `proof accepted in round ${x.rounds.length}` : `no proof: ${x.agent_final}`,
    x.accepted ? (x.axioms.length ? `axiom: ${x.axioms.join(', ')}` : 'no axiom') : '',
    x.local_node ? `checked in ${Math.round(x.local_node.kernel_tgas)} TGas` : '',
  ]);
  const c = modelClaim,
    tx = (step, text) => link(c[step].explorer, text);
  const onTestnet = c
    ? [
        el(
          'p',
          {},
          'One of the open bounties on the testnet board was on the patch ',
          rust(c.expression),
          `. That patch caps the refund by the deposit and forgets the receiver’s balance. ${c.model.split('/').pop()} is an open-weight model that NEAR AI Cloud serves. The model got the name of the claim and the Lean definitions, and no counterexample or proof. In ${c.model_run.requests} requests and ${Math.round(c.model_run.seconds / 60)} minutes the model found a counterexample: requested ${c.counterexample.requested}, deposited ${c.counterexample.deposited}, balance ${c.counterexample.balance}. For these inputs the patch returns ${c.counterexample.the_patch_returns}, ${c.counterexample.breaks}. The model wrote a proof of ${c.proof.bytes.toLocaleString('en-US')} bytes with no axiom.`,
        ),
        el(
          'p',
          {},
          'A courier script ',
          tx('commit', 'committed'),
          ' and ',
          tx('reveal', 'revealed'),
          ` it on NEAR testnet. The proof checker contract checked it in ${Math.round(c.reveal.kernel_tgas)} TGas, and the board paid ${c.reward_near} NEAR to `,
          link(`${c.explorer}/address/${c.account}`, c.account),
          '. The model holds no key. The account that the board paid is ours, and a script signed for it. The certificate on the board names the hash of the proof file in this repository.',
        ),
        el('h3', { textContent: 'The harder task, on a local node: the patch and its proof' }),
      ]
    : [];
  $('agent-title').textContent = c
    ? 'A model writes the proof, and is paid on testnet.'
    : 'A model writes the patch and its proof.';
  $('agent-evidence').replaceChildren(
    ...onTestnet,
    el('p', {
      textContent: `${word(models)[0].toUpperCase()}${word(models).slice(1)} open-weight models that NEAR AI Cloud serves each got the pinned NEAR Intents file, one observed transaction and the rule in words. They got no fix and no Lean. Each model had to propose a replacement for the expression. It also had to write a Lean proof of the claim that the scripts generated for its own patch, in three rounds at most.`,
    }),
    el(
      'div',
      { className: 'tx-table' },
      table(rows, ['Model', 'Patch it proposed', 'Its proof', 'Axioms', 'Proof checker contract']),
    ),
    el('p', {
      textContent: `${word(accepted.length)[0].toUpperCase()}${word(accepted.length).slice(1)} of ${word(a.attempts.length)} attempts ended with a proof that the proof checker contract accepted. For each of them the whole job ran on a fresh local NEAR node. The board paid the account that submitted the proof, and the gate installed the contract that we built from the model's own source. The ${a.series_requests} model requests cost USD ${a.series_usd.toFixed(2)} at list price.`,
    }),
    el(
      'p',
      { className: 'muted' },
      'The scope of these attempts is narrow. The rule in words almost gives the expression away, and the team published the fix in March. So the part that a model had to produce is the proof. The attempts ran on a local node. A script signed the transactions, and the model signed none. Every response carries a signature of NEAR AI’s model service, and ',
      el('code', { textContent: './verify.sh --nearai' }),
      ' checks those signatures and the proofs again with no API call. ',
      link(
        `${onThisMachine ? '../..' : `${REPOSITORY}/blob/main`}/evidence/nearai-refund/FACTS.md`,
        'The prompt, every request and response, and the limits →',
      ),
    ),
  );
  $('agent').hidden = false;
  $('agent-link').hidden = false;
}

// NEAR Proof Arena's transfer relation in a second proof checker on the same network: read from that deployment's record.
async function showArena() {
  let a;
  try {
    a = await get('../../deploy/testnet-arena.json');
  } catch {
    return;
  }
  const find = (label) => a.results?.find((r) => r.label === label);
  const unique = find('NearRelation.outputs_unique'),
    domain = find('NearRelation.domain'),
    wrong = a.results?.find((r) => r.must_be_accepted === false);
  if (a.ok !== true || !unique?.accepted || !domain?.accepted || !wrong || wrong.accepted) return;
  const tx = (r, text) => link(r.explorer, text),
    env = a.environment;
  $('arena-evidence').replaceChildren(
    el(
      'p',
      {},
      link(a.arena, 'NEAR Proof Arena'),
      ' holds a Lean specification of how nearcore handles a batch of transfer receipts: ',
      el('code', { textContent: 'NearSpec.TransferV1.NearRelation' }),
      '. The Arena proves two theorems about that relation. The relation determines its outputs. Whatever the relation holds for lies inside the specified domain.',
    ),
    el(
      'p',
      {},
      'A second copy of the proof checker on NEAR testnet, ',
      link(`${a.explorer}/address/${a.account}`, a.account),
      `, sealed that statement: ${env.declarations_as_the_kernel_counts_them.toLocaleString('en-US')} declarations, ${(env.export_bytes / 1e6).toFixed(2)} MB. It then accepted each of the Arena’s own proofs in one transaction (`,
      tx(unique, `${Math.round(unique.gas_burnt_tgas)} TGas`),
      ' and ',
      tx(domain, `${Math.round(domain.gas_burnt_tgas)} TGas`),
      '). We sent one of the two proofs under the other claim, and the proof checker refused it (',
      tx(wrong, 'the refusal'),
      ').',
    ),
    el(
      'p',
      { className: 'muted' },
      'We use the specification as it is, at commit ',
      el('code', { textContent: a.arena_commit }),
      '. We prove nothing about nearcore here. Most of the gas of such a check reads the statement again, and little of it checks the proof. ',
      link(`${onThisMachine ? '../..' : `${REPOSITORY}/blob/main`}/docs/TECHNICAL.md#numbers`, 'The numbers →'),
    ),
  );
  $('arena').hidden = false;
}

(async () => {
  // On a static host a Markdown file would open as raw text: send those links to the repository instead.
  if (!onThisMachine)
    for (const a of document.querySelectorAll('a[href^="../../"]')) {
      const file = a.getAttribute('href').slice(6);
      if (/\.md(#.*)?$/.test(file)) a.href = `${REPOSITORY}/blob/main/${file}`;
    }
  try {
    catalog = await get('../../cases/intents-refund/candidates.json');
    selection();
  } catch (e) {
    $('patch-status').textContent = e.message;
    return;
  }
  // Show the rule as it is written in the Lean file the kernel's environment was exported from.
  try {
    const lean = await (await fetch('../../cases/intents-refund/RefundCase.lean', { cache: 'no-store' })).text();
    const from = lean.indexOf('def Rule '),
      to = lean.indexOf('def meetsRule ');
    if (from >= 0 && to > from) {
      const lines = lean.slice(from, to).trimEnd().split('\n');
      if (!window.matchMedia('(max-width: 760px)').matches) $('rule').textContent = lines.join('\n');
      else
        $('rule').replaceChildren(
          ...lines.flatMap((line) => {
            // narrow: a comment goes above its requirement, and a long line hangs under itself
            const m = /^\s*(\S.*?)\s+(-- .*)$/.exec(line),
              row = (text, kind) => el('span', { className: `row ${kind}`, textContent: text });
            return m ? [row(m[2], 'note'), row(m[1], 'code')] : [row(line.trim(), /^\s/.test(line) ? 'code' : 'head')];
          }),
        );
    }
  } catch {
    /* the page already shows the statement without its comments */
  }
  try {
    modelClaim = await get('../../evidence/nearai-testnet/claim.json');
  } catch {
    modelClaim = null;
  }
  // A published live record wins. ?record= lets a developer point the page at a local rehearsal.
  const asked = new URLSearchParams(location.search).get('record');
  const source =
    asked && /^[\w./-]+\.json$/.test(asked) && !asked.includes('..') ? `../../${asked}` : '../../deploy/testnet.json';
  try {
    const record = await get(source);
    live = inspectLiveRecord(record, catalog);
    showLive(live);
  } catch (e) {
    live = null;
    if (asked) $('upgrade-evidence').textContent = `The page cannot use the live record: ${e.message}`;
  }
  try {
    const [replay, upgrade] = await Promise.all([
      get('../../evidence/refund/replay.json'),
      get('../../evidence/refund/upgrade.json'),
    ]);
    showRecorded(replay, upgrade);
  } catch (e) {
    if (!live) {
      const box = $('upgrade-evidence');
      box.className = 'evidence-error';
      box.textContent = `Transaction evidence unavailable: ${e.message}`;
      box.append(
        document.createElement('br'),
        el('button', { textContent: 'Reload evidence', onclick: () => location.reload() }),
      );
    }
  }
  connect();
  showAgent();
  showArena();
})();
