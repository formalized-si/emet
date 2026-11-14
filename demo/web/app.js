// The wallet page: it plays a recorded run of the wallet scenario (evidence/demo/scenario.json, or ?run=<file>)
// and, under ./verify.sh --serve, sends a genuine and a forged proof to a proof checker on a local node.
import { validateRun } from './evidence.mjs';

const REPOSITORY = 'https://github.com/formalized-si/emet';
// On a static host a Markdown file would open as raw text: send those links to the repository instead.
if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname))
  for (const a of document.querySelectorAll('a[href^="../../"]')) {
    const file = a.getAttribute('href').slice(6);
    if (/\.md(#.*)?$/.test(file) || file === 'LICENSE') a.href = `${REPOSITORY}/blob/main/${file}`;
  }

const params = new URLSearchParams(location.search);
const SRC = params.get('run') || '../../evidence/demo/scenario.json';
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const yocto = (y) => (Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(2);
const chip = (text, kind) => `<span class="chip ${kind}">${esc(text)}</span>`;
const nm = (s) => esc(s).replace(/\./g, '.<wbr>');
async function loadRun() {
  $('load-error').hidden = true;
  $('story').hidden = true;
  try {
    const url = new URL(SRC, location.href);
    if (url.origin !== location.origin) throw new Error('The run file must be on this origin.');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${SRC}`);
    const data = validateRun(await response.json());
    render(data);
    renderStory(data);
    $('record-link').href = url.href;
    $('record-label').textContent = `RECORDED LOCAL RUN · ${data.started_at.slice(0, 10)} · NOT A LIVE WALLET`;
    $('story').hidden = false;
  } catch (e) {
    $('headline').textContent = "Check the wallet's spending rule.";
    $('record-label').textContent = 'EVIDENCE UNAVAILABLE';
    $('error-message').textContent = `${e.message} Restart the local preview with ./verify.sh --serve, then try again.`;
    $('load-error').hidden = false;
  }
}
$('retry').addEventListener('click', loadRun);
loadRun();

function render(d) {
  $('src').textContent = SRC.replace('../../', '');
  const c = d.costs,
    pass = d.claims.filter((x) => x.pass).length;
  const agents = (d.couriers || []).flatMap((k) => k.ledger.decisions.filter((x) => x.decision === 'committed'));
  const llm = (d.couriers || []).reduce((a, k) => a + k.llm_usd_spent_writing_its_proofs, 0);
  $('stats').innerHTML = [
    [`${pass}/${d.claims.length}`, 'claims passed in this run'],
    [
      `${c.shelf.near} NEAR`,
      `seal the environment once (${c.shelf.decls} declarations, ${(c.shelf.base_bytes / 1e6).toFixed(2)} MB)`,
    ],
    [
      `≤ ${c.check_near_max} NEAR`,
      `one check in the proof checker (${c.check_tgas_range.map((x) => x.toFixed(0)).join('–')} of 1,000 TGas)`,
    ],
    [`${agents.length} commitments`, `proof submissions in this replay. Agents wrote the proofs before this run`],
    [`${d.cheats.filter((x) => x.refused).length}/${d.cheats.length}`, 'fake proofs refused, none paid'],
  ]
    .map(([b, s]) => `<div class="card stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`)
    .join('');

  const w = d.wallet;
  $('wallet').innerHTML =
    '<tr><th>request from the agent</th><th>to</th><th>NEAR</th><th>wallet verdict</th></tr>' +
    w.payments
      .map(
        (p) =>
          `<tr><td>${esc(p.label)}</td><td class="mono">${esc(p.to)}</td><td>${esc(p.amount_near)}</td><td>${chip(p.verdict, p.verdict === 'allow' ? 'ok' : 'no')}</td></tr>`,
      )
      .join('');
  $('walletNote').textContent =
    `Policy: lifetime budget ${w.policy_near.budget} NEAR, ${w.policy_near.per_tx} per payment, ${w.policy_near.per_day} per day, receivers ${w.policy_near.allowed.join(', ')}. ` +
    'These requests exercise the wallet. The bounties pay for a proof or counterexample to the exact statements below.';

  const finals = Object.fromEntries((d.board_final || []).map((b) => [b.claim, b]));
  const decisions = Object.fromEntries(
    (d.couriers || []).flatMap((k) =>
      k.ledger.decisions.filter((x) => x.decision === 'committed').map((x) => [x.name, { agent: k.agent, ...x }]),
    ),
  );
  $('bounties').innerHTML = Object.values(d.bounties)
    .map((b) => {
      const f = finals[b.claim] || {},
        cert = f.certificate;
      const status =
        f.phase === 'Paid'
          ? chip(cert && cert.side === 'refutation' ? 'refuted · paid' : 'proved · paid', 'ok')
          : f.phase === 'Refunded'
            ? chip('refunded after deadline', 'warn')
            : chip(f.phase || '?', 'warn');
      const rejected = (f.attempts || []).filter((x) => !x.outcome.startsWith('accepted')).length;
      const dec = cert && decisions[cert.proved];
      return `<div class="card"><div class="row"><span class="claim">#${esc(b.id)} ${nm(b.claim)}</span>${status}</div>
      <div class="title">${esc(b.title)}</div>
      <dl class="kv"><dt>reward</dt><dd>${esc(b.reward_near)} NEAR${f.forfeited && f.forfeited !== '0' ? ` + ${yocto(f.forfeited)} from forfeited bonds` : ''}${f.boosted && f.boosted !== '0' ? ` + ${yocto(f.boosted)} pooled by ${f.boosters} other owner${f.boosters === 1 ? '' : 's'}` : ''}</dd>
      ${
        cert
          ? `<dt>settled by</dt><dd>${esc(cert.side === 'refutation' ? 'a counterexample' : 'a proof')} from <span class="mono">${esc(cert.claimer)}</span></dd>
      <dt>certificate</dt><dd class="mono">${nm(cert.proved)} · ${esc(cert.decls_checked)} decls · axioms ${esc(cert.axioms.join(', ') || 'none')}</dd>
      <dt>proof sha256</dt><dd class="mono">${esc(cert.delta_sha256.slice(0, 24))}…</dd>
      ${b.settled && b.settled.kernel_tgas ? `<dt>checked in</dt><dd>${b.settled.kernel_tgas.toFixed(0)} TGas, inside one NEAR call</dd>` : ''}`
          : '<dt>settled by</dt><dd>nobody before the deadline</dd>'
      }
      ${rejected ? `<dt>refused</dt><dd>${rejected} attempts (see 3)</dd>` : ''}</dl></div>`;
    })
    .join('');
  $('couriers').innerHTML =
    '<tr><th>agent</th><th>proofs it held (model, time, LLM cost)</th><th>earned</th><th>balance change</th></tr>' +
    (d.couriers || [])
      .map(
        (k) =>
          `<tr><td class="mono">${esc(k.agent)}</td><td>${k.ledger.decisions
            .filter((x) => x.decision === 'committed')
            .map((x) => `${esc(x.name.replace('Wallet.Claim.', ''))}`)
            .join('<br>')}</td>
     <td>${k.ledger.earned_near.toFixed(3)} NEAR</td><td>${esc(k.balance_change_near)} NEAR <span class="note">(USD ${k.llm_usd_spent_writing_its_proofs.toFixed(2)} of model time)</span></td></tr>`,
      )
      .join('');
  const head = Object.values(d.bounties)[0],
    hf = finals[head.claim] || {};
  const loser = (hf.attempts || []).find((a) => a.outcome === 'accepted_after_settled');
  $('raceNote').textContent =
    `Both agents held a valid proof of ${head.claim}. The proof checker checked the proof of ${hf.winner} first, and the board paid that agent. ` +
    (loser
      ? `The proof of ${loser.claimer} was also valid. It arrived second and got its bond back.`
      : 'The board refused the reveal of the other agent, because the bounty had a winner.');
  $('money').innerHTML =
    '<tr><th>when</th><th>what</th><th>on-chain answer</th></tr>' +
    (d.money_path || [])
      .map(
        (x) => `<tr><td>${esc(x.when)}</td><td>${esc(x.what)}</td><td>${chip(x.outcome, x.ok ? 'ok' : 'no')}</td></tr>`,
      )
      .join('');
  if (d.reuse && d.factory)
    $('moneyNote').textContent =
      `The factory ${d.factory.account} creates every wallet here. It published the wallet code once (${d.factory.code_publication_near} NEAR), and it leaves each wallet with no key. ` +
      `The claims are about that code, so the proof that Alice paid for also covers Bob's wallet (${d.reuse.bob_wallet}: budget ${d.reuse.bob_policy_near.budget}, ${d.reuse.bob_policy_near.per_day} per day). The board asked the factory and forwarded ${d.reuse.funded_near} NEAR, with no new bounty and no new proof. ` +
      `${d.reuse.lookalike} runs the same bytes but keeps a key, so it can run other code tomorrow. The board refused it and returned ${d.reuse.lookalike_refunded_near} NEAR.`;

  $('cheats').innerHTML =
    '<tr><th>attempt</th><th>what it does</th><th>on-chain answer</th></tr>' +
    d.cheats
      .map(
        (x) =>
          `<tr><td class="mono">${esc(x.name)}</td><td>${esc(x.story)}</td><td>${chip(x.refused ? 'refused' : 'NOT REFUSED', x.refused ? 'no' : 'warn')} <span class="mono">${esc((x.outcome || '').slice(0, 90))}</span></td></tr>`,
      )
      .join('');
  $('frontrun').innerHTML =
    '<tr><th>who</th><th>tries</th><th>on-chain answer</th></tr>' +
    (d.frontrun || [])
      .map(
        (x) => `<tr><td class="mono">${esc(x.who)}</td><td>${esc(x.what)}</td><td>${chip(x.outcome, 'no')}</td></tr>`,
      )
      .join('');
  const bp = d.bypass;
  if (bp) {
    $('bypass').innerHTML =
      '<tr><th>request from the agent</th><th>NEAR</th><th>wallet verdict</th></tr>' +
      bp.payments
        .map(
          (p) =>
            `<tr><td>${esc(p.label)}</td><td>${esc(p.amount_near)}</td><td>${chip(p.verdict, p.verdict === 'allow' ? 'ok' : 'no')}</td></tr>`,
        )
        .join('');
    $('bypassNote').textContent =
      `${bp.total_near} NEAR left the wallet in ${Math.round(bp.seconds)} seconds with a daily cap of ${bp.per_day_cap_near}. The day window is anchored, and it does not slide, as the paid counterexample says. A weaker bound has a proof and holds: at most twice the cap in any stretch of one day. (In this demo a "day" is ${d.wallet.policy_near.day_seconds} seconds.)`;
  }
  const fx = d.fix;
  if (fx) {
    $('fix').innerHTML =
      '<tr><th>request from the agent (v2 wallet)</th><th>NEAR</th><th>wallet verdict</th></tr>' +
      fx.payments
        .map(
          (p) =>
            `<tr><td>${esc(p.label)}</td><td>${esc(p.amount_near)}</td><td>${chip(p.verdict, p.verdict === 'allow' ? 'ok' : 'no')}</td></tr>`,
        )
        .join('');
    const c = fx.bounty.certificate || {};
    $('fixNote').textContent =
      `For v2 the proof checker ${fx.old_counterexample_on_v2.ok ? 'accepts' : 'refuses'} the old counterexample. ` +
      `The proof checker checked the repair proof in ${Math.round(fx.bounty.kernel_tgas || 0)} TGas, and the board paid the bounty` +
      (fx.bounty.escrow_released ? ' and released the locked top-up.' : '.');
  }
  $('stmt').textContent = head.statement;
  $('claims').innerHTML = d.claims
    .map((x) => `<li>${chip(x.pass ? 'PASS' : 'FAIL', x.pass ? 'ok' : 'no')} <b>${esc(x.id)}</b> ${esc(x.title)}</li>`)
    .join('');
}

let replayIndex = 0;
let currentRun;
const steps = ['attack', 'proof', 'fix'];
function selectStep(step, focus = false) {
  for (const name of steps) {
    const active = name === step;
    const tab = $('tab-' + name);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $('panel-' + name).hidden = !active;
    if (active && focus) tab.focus();
  }
}
for (const [index, name] of steps.entries()) {
  $('tab-' + name).addEventListener('click', () => selectStep(name));
  $('tab-' + name).addEventListener('keydown', (e) => {
    const next =
      e.key === 'ArrowRight'
        ? (index + 1) % 3
        : e.key === 'ArrowLeft'
          ? (index + 2) % 3
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? 2
              : -1;
    if (next >= 0) {
      e.preventDefault();
      selectStep(steps[next], true);
    }
  });
}
for (const button of document.querySelectorAll('[data-step]'))
  button.addEventListener('click', () => selectStep(button.dataset.step, true));
function updateReplay() {
  const rows = [...$('bypass').querySelectorAll('tr')].slice(1);
  for (const [i, row] of rows.entries()) row.hidden = i >= replayIndex;
  const visible = currentRun.bypass.payments.slice(0, replayIndex);
  const total = visible.filter((p) => p.verdict === 'allow').reduce((sum, p) => sum + p.amount_near, 0);
  $('replay-total').textContent = String(total);
  $('replay-status').textContent = `${replayIndex} of ${rows.length} recorded payments`;
  $('next-payment').textContent = replayIndex === rows.length ? 'Replay from start' : 'Next payment';
  $('show-payments').disabled = replayIndex === rows.length;
}
$('next-payment').addEventListener('click', () => {
  replayIndex = replayIndex === currentRun.bypass.payments.length ? 0 : replayIndex + 1;
  updateReplay();
});
$('show-payments').addEventListener('click', () => {
  replayIndex = currentRun.bypass.payments.length;
  updateReplay();
});
function renderStory(d) {
  currentRun = d;
  $('headline').innerHTML =
    `A <span>${esc(d.bypass.per_day_cap_near)}</span> NEAR daily cap.<br><span>${esc(d.bypass.total_near)}</span> NEAR got through.`;
  $('fix-cap').textContent = d.fix.allowed_in_day_near;
  const bounty = Object.values(d.bounties).find((b) => b.claim === 'Wallet.Claim.SlidingDayCap');
  const final = d.board_final.find((b) => b.claim === bounty.claim && b.certificate);
  const cert = final.certificate;
  $('proof-summary').innerHTML =
    `<dl class="proof-result"><dt>Contract verdict</dt><dd>${chip('counterexample accepted', 'ok')}</dd><dt>Bounty paid</dt><dd>${esc(bounty.reward_near)} NEAR reward, plus the returned bond</dd><dt>Checked in</dt><dd>${Math.round(bounty.settled.kernel_tgas)} TGas inside the proof checker</dd><dt>Prover account</dt><dd class="mono">${esc(cert.claimer)}</dd><dt>Claim refuted</dt><dd class="mono">${esc(bounty.claim)}</dd><dt>Proof SHA-256</dt><dd class="mono">${esc(cert.delta_sha256)}</dd></dl>`;
  $('freeze-note').hidden = !d.freeze;
  if (d.freeze)
    $('freeze-note').textContent =
      'After the accepted counterexample, the wallet executed a freeze. The wallet refused its next payment, and the owner was able to withdraw the remaining funds. A freeze takes effect through separate NEAR receipts.';
  replayIndex = 0;
  updateReplay();
}

let checking = false;
let connecting = false;
let poll;
async function connectChecker() {
  if (connecting || checking) return;
  connecting = true;
  clearTimeout(poll);
  try {
    // ./verify.sh --serve answers here. A static host does not, and is not asked.
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname))
      throw new Error('No local checker at this address.');
    const response = await fetch('../../api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('No local checker at this address.');
    const status = await response.json();
    if (status.network !== 'local sandbox') throw new Error('Unrecognized checker.');
    $('checker-status').textContent = status.ready
      ? `Ready · ${status.kernel} · local NEAR view calls`
      : status.error || 'The server starts the local proof checker and checks its environment…';
    $('checker-help').hidden = status.ready;
    $('check-genuine').disabled = $('check-forged').disabled = !status.ready;
    if (!status.ready && !status.error) poll = setTimeout(connectChecker, 2000);
  } catch (error) {
    $('checker-status').textContent = 'The recorded demo is available. No live checker runs at this address.';
    $('checker-help').hidden = false;
    $('check-genuine').disabled = $('check-forged').disabled = true;
  } finally {
    connecting = false;
  }
}
async function checkProof(fixture) {
  if (checking) return;
  checking = true;
  $('check-genuine').disabled = $('check-forged').disabled = true;
  $('check-result').hidden = false;
  $('check-verdict').className = '';
  $('check-verdict').textContent = 'The contract checks the proof…';
  $('check-detail').textContent = '';
  $('check-json').textContent = '';
  try {
    const response = await fetch('../../api/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixture }),
    });
    const result = await response.json();
    if (!response.ok || !['accepted', 'rejected'].includes(result.verdict))
      throw new Error(result.error || 'No verdict returned.');
    $('check-verdict').className = `chip ${result.verdict === 'accepted' ? 'ok' : 'no'}`;
    $('check-verdict').textContent =
      result.verdict === 'accepted' ? 'Contract accepted this proof' : 'Contract rejected this proof';
    $('check-detail').textContent =
      `${result.proof_bytes.toLocaleString()} proof bytes · ${result.kernel} · ${result.checked_at} · no transaction or payout`;
    $('check-json').textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    $('check-verdict').textContent = 'The check did not finish.';
    $('check-detail').textContent = error.message;
  } finally {
    checking = false;
    connectChecker();
  }
}
$('connect-checker').addEventListener('click', connectChecker);
$('check-genuine').addEventListener('click', () => checkProof('genuine'));
$('check-forged').addEventListener('click', () => checkProof('forged'));
connectChecker();
