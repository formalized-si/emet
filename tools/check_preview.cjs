// Exercise the running local preview through HTTP, including both real kernel paths.
// node tools/check_preview.cjs [url] [report.json]      the default url is where ./verify.sh --serve listens
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const url = process.argv[2] || `http://127.0.0.1:${process.env.EMET_PORT || 8798}`;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw Error('This check is for a local preview only');
const rows = [];
const add = (name, ok, detail) => rows.push({ name, ok: !!ok, detail });
async function call(route, body) {
  const r = await fetch(
    url + route,
    body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  return { status: r.status, body: await r.json() };
}
(async () => {
  const status = await call('/api/status');
  add(
    'the ready server identifies a local kernel',
    status.status === 200 && status.body.ready && status.body.network === 'local sandbox',
    status.body,
  );
  if (!status.body.ready) throw Error('Local checker is not ready');
  const compared = [];
  for (const [fixture, file, expected] of [
    ['genuine', 'evidence/agent/AllowedReceiversOnly-opus/delta.ndjson', 'accepted'],
    ['forged', 'cheats/deltas/forgedRec.delta.ndjson', 'rejected'],
  ]) {
    const r = await call('/api/check', { fixture });
    const hash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.resolve(__dirname, '..', file)))
      .digest('hex');
    compared.push(r.body.claim);
    add(
      `${fixture}: the actual file receives the expected kernel verdict`,
      r.status === 200 &&
        r.body.verdict === expected &&
        r.body.proof_sha256 === hash &&
        r.body.kernel_sha256 === status.body.kernel_sha256,
      r,
    );
  }
  add('both files target the same statement', new Set(compared).size === 1, { claims: compared });
  const unknown = await call('/api/check', { fixture: '__proto__' });
  add('unknown fixture is refused', unknown.status === 400, unknown);
  // The address a visitor types first: follow the HTTP redirect, then the page's own <meta refresh>, if it has one.
  const root = await fetch(url + '/'),
    next = ((await root.text()).match(/http-equiv="refresh" content="0;url=([^"]+)"/) || [])[1] || '';
  const page = await fetch(new URL(next, root.url));
  add('the root address leads to a page', root.ok && page.ok, { root: root.url, page: page.url, status: page.status });
  const git = await fetch(url + '/.git/config');
  add('repository internals are not served', git.status === 404, { status: git.status });
  const invalid = await call('/api/check', { fixture: 'genuine', padding: 'x'.repeat(2048) });
  add('oversized requests are refused', invalid.status === 400, { status: invalid.status });
  const report = { at: new Date().toISOString(), url, checks: rows, ok: rows.every((r) => r.ok) };
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}`);
  process.exitCode = report.ok ? 0 : 1;
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
