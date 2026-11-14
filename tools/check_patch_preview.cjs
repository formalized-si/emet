// Verify actual local HTTP/kernel responses, not the UI's labels.
// node tools/check_patch_preview.cjs [url] [report.json]      the default url is where ./verify.sh --serve listens
const fs = require('node:fs'),
  crypto = require('node:crypto');
const url = process.argv[2] || `http://127.0.0.1:${process.env.EMET_PORT || 8798}`;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw Error('Local preview only');
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
(async () => {
  const catalog = JSON.parse(fs.readFileSync('cases/intents-refund/candidates.json'));
  const rows = [];
  const status = await (await fetch(url + '/api/patches/status')).json();
  if (!status.ready) throw Error('The refund kernel is not ready');
  for (const c of catalog.candidates) {
    const r = await fetch(url + '/api/patches/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidate: c.label }),
    });
    const body = await r.json();
    const expected = c.counterexample ? 'refuted' : 'proved';
    const ok =
      r.status === 200 &&
      body.result?.ok === true &&
      body.decision === expected &&
      body.claim === c.proved &&
      body.base_sha256 === status.base_sha256 &&
      body.proof_sha256 === hash(fs.readFileSync(`cases/intents-refund/proofs/${c.label}.ndjson`));
    rows.push({ candidate: c.label, ok, result: body });
    console.log(ok ? 'PASS' : 'FAIL', c.label, body.decision);
  }
  for (const input of [{ candidate: '__proto__' }, { candidate: 'repair', padding: 'x'.repeat(2048) }]) {
    const r = await fetch(url + '/api/patches/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    rows.push({ kind: 'invalid request', ok: r.status === 400, status: r.status });
    console.log(r.status === 400 ? 'PASS' : 'FAIL', 'invalid request', r.status);
  }
  const report = { at: new Date().toISOString(), url, checks: rows, ok: rows.every((r) => r.ok) };
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
  if (!report.ok) process.exitCode = 1;
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
