// Validate the facts used by the demo before presenting a successful story.
// This checks record consistency. It does not verify a proof or a blockchain.
const fail = (message) => {
  throw new Error(`Invalid run record: ${message}`);
};
const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const hash = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);

function payments(rows, label) {
  if (!Array.isArray(rows) || !rows.length) fail(`${label} has no payments`);
  let previous = -1n;
  for (const row of rows) {
    if (
      !finite(row.amount_near) ||
      typeof row.label !== 'string' ||
      typeof row.verdict !== 'string' ||
      !/^\d+$/.test(row.at_ns)
    )
      fail(`${label} has a malformed payment`);
    const now = BigInt(row.at_ns);
    if (now < previous) fail(`${label} timestamps are out of order`);
    previous = now;
  }
}

export function maxRollingSpend(rows, daySeconds) {
  const duration = BigInt(daySeconds) * 1_000_000_000n;
  const allowed = rows.filter((p) => p.verdict === 'allow');
  let start = 0,
    sum = 0,
    maximum = 0;
  for (let end = 0; end < allowed.length; end++) {
    sum += Math.round(allowed[end].amount_near * 1e6);
    while (start <= end && BigInt(allowed[end].at_ns) - BigInt(allowed[start].at_ns) >= duration) {
      sum -= Math.round(allowed[start++].amount_near * 1e6);
    }
    maximum = Math.max(maximum, sum);
  }
  return maximum / 1e6;
}

export function validateRun(d) {
  if (!d || d.kind !== 'proof-courier-scenario' || !Number.isFinite(Date.parse(d.started_at)))
    fail('unsupported format');
  if (!Array.isArray(d.claims) || !d.claims.length || d.claims.some((c) => typeof c.pass !== 'boolean'))
    fail('missing check results');
  if (new Set(d.claims.map((c) => c.id)).size !== d.claims.length) fail('duplicate check IDs');
  const passed = d.claims.filter((c) => c.pass).length;
  if (d.summary?.pass !== passed || d.summary?.fail !== d.claims.length - passed)
    fail('summary disagrees with check results');
  if (!d.inputs || !Object.values(d.inputs).some(hash)) fail('missing artifact hashes');
  if (!d.bypass || !d.fix || !d.wallet?.policy_near || !d.costs?.shelf || !Array.isArray(d.cheats))
    fail('missing story evidence');
  const day = d.wallet.policy_near.day_seconds;
  if (!Number.isSafeInteger(day) || day <= 0) fail('invalid day length');
  if (![d.bypass.per_day_cap_near, d.fix.per_day_cap_near, d.fix.allowed_in_day_near].every(finite))
    fail('invalid spending cap');
  payments(d.bypass.payments, 'v1');
  payments(d.fix.payments, 'v2');
  const total =
    d.bypass.payments.filter((p) => p.verdict === 'allow').reduce((n, p) => n + Math.round(p.amount_near * 1e6), 0) /
    1e6;
  if (total !== d.bypass.total_near || !finite(d.bypass.seconds)) fail('v1 total disagrees with its payments');
  const span = Number(BigInt(d.bypass.payments.at(-1).at_ns) - BigInt(d.bypass.payments[0].at_ns)) / 1e9;
  if (Math.abs(span - d.bypass.seconds) > 0.001 || span >= day || total <= d.bypass.per_day_cap_near)
    fail('v1 record does not show the claimed bypass');
  if (
    maxRollingSpend(d.fix.payments, day) !== d.fix.allowed_in_day_near ||
    d.fix.allowed_in_day_near > d.fix.per_day_cap_near
  )
    fail('v2 rolling spend disagrees with the displayed cap');
  if (
    d.bypass.per_day_cap_near !== d.fix.per_day_cap_near ||
    d.bypass.per_day_cap_near !== d.wallet.policy_near.per_day
  )
    fail('the compared wallets have different caps');
  const bounty = Object.values(d.bounties || {}).find((b) => b.claim === 'Wallet.Claim.SlidingDayCap');
  const result = d.board_final?.find((b) => b.claim === bounty?.claim && b.certificate);
  if (
    result?.phase !== 'Paid' ||
    result.certificate.side !== 'refutation' ||
    !hash(result.certificate.delta_sha256) ||
    bounty?.settled?.side !== 'refutation' ||
    bounty.settled.winner !== result.certificate.claimer
  )
    fail('no matching paid counterexample');
  if (
    d.fix.bounty?.phase !== 'Paid' ||
    d.fix.bounty.certificate?.side !== 'proof' ||
    !hash(d.fix.bounty.certificate.delta_sha256)
  )
    fail('no paid proof of the repair');
  if (
    d.freeze &&
    (d.freeze.wallet_after?.frozen !== true ||
      d.freeze.refused_payment?.verdict !== 'frozen' ||
      d.freeze.refused_payment?.transferred_yocto !== '0' ||
      !/^\d+$/.test(d.freeze.withdraw?.amount_yocto) ||
      BigInt(d.freeze.withdraw.amount_yocto) <= 0n)
  )
    fail('the record does not support the freeze or the owner withdrawal');
  return d;
}
