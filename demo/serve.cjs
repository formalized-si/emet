// A local-only proof checker and static preview. It never connects to testnet or mainnet.
// ./verify.sh --serve prepares the pinned sandbox binary, then starts this server.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const localNode = require('../tools/local-node.cjs');
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.EMET_PORT || 8798);
if (!Number.isSafeInteger(PORT) || PORT < 1024 || PORT > 65535) throw Error('EMET_PORT must be 1024–65535');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo/bounties.json')));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, cfg.shelf, 'manifest.json')));
const wasm = fs.readFileSync(path.join(ROOT, cfg.kernel_wasm));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const patches = require('./patch-preview.cjs')(ROOT);
const fixtures = {
  genuine: {
    label: 'A genuine proof',
    file: 'evidence/agent/AllowedReceiversOnly-opus/delta.ndjson',
    claim: 'Wallet.Claim.AllowedReceiversOnly',
  },
  forged: {
    label: 'A forged recursor proof',
    file: 'cheats/deltas/forgedRec.delta.ndjson',
    claim: 'Wallet.Claim.AllowedReceiversOnly',
  },
};
let worker,
  kernel,
  busy = false;
const state = {
  ready: false,
  network: 'local sandbox',
  kernel: null,
  kernel_sha256: sha(wasm),
  shelf_sha256: manifest.base_sha256,
  checks: 0,
};
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1024) throw Error('request too large');
  }
  return JSON.parse(text);
}
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (u.pathname === '/api/patches/status' && req.method === 'GET') return json(res, 200, patches.state);
    if (u.pathname === '/api/patches/check' && req.method === 'POST') {
      const input = await body(req);
      return json(res, 200, await patches.check(input.candidate));
    }
    if (u.pathname === '/api/status' && req.method === 'GET') return json(res, 200, state);
    if (u.pathname === '/api/check' && req.method === 'POST') {
      if (!state.ready) return json(res, 503, { error: state.error || 'The local kernel is still starting.' });
      if (busy) return json(res, 429, { error: 'Another proof is being checked. Try again shortly.' });
      const input = await body(req),
        f = Object.hasOwn(fixtures, input.fixture) ? fixtures[input.fixture] : null;
      if (!f) return json(res, 400, { error: 'Choose genuine or forged.' });
      const delta = fs.readFileSync(path.join(ROOT, f.file));
      const started = Date.now();
      busy = true;
      try {
        let result, verdict;
        try {
          result = await kernel.view('dry_run', { theorem_name: f.claim, delta: delta.toString() });
          verdict = result.ok === true ? 'accepted' : 'rejected';
        } catch (error) {
          const message = String(error.message || error);
          if (/gas|timeout|ECONN|fetch failed/i.test(message) || !/panick|wasm trap|unreachable/i.test(message))
            throw error;
          verdict = 'rejected';
          result = { ok: false, reason: 'kernel_failed', detail: message.slice(0, 500) };
        }
        state.checks++;
        return json(res, 200, {
          verdict,
          fixture: input.fixture,
          network: state.network,
          kernel: state.kernel,
          kernel_sha256: state.kernel_sha256,
          proof_sha256: sha(delta),
          proof_bytes: delta.length,
          claim: f.claim,
          checked_at: new Date().toISOString(),
          milliseconds: Date.now() - started,
          result,
        });
      } finally {
        busy = false;
      }
    }
    if (u.pathname.startsWith('/api/')) return json(res, 404, { error: 'No such API route.' });
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Read-only preview.' });
    let rel = decodeURIComponent(u.pathname).replace(/^\//, '');
    // The page's links are relative to demo/web/: served at "/", its redirect would point at /patches.html, which is not a resource.
    if (!rel) {
      res.writeHead(302, { location: '/demo/web/' });
      return res.end();
    }
    if (rel.endsWith('/')) rel += 'index.html';
    if (
      rel.split('/').some((p) => p === '..' || p.startsWith('.')) ||
      !/^(demo\/web\/|docs\/|evidence\/|cases\/intents-refund\/|cheats\/|lean\/|deploy\/testnet\.json$|README\.md$|LICENSE$|SOURCES\.json$|THIRD_PARTY_NOTICES\.md$)/.test(
        rel,
      )
    )
      return json(res, 404, { error: 'Not a preview resource.' });
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) return json(res, 404, { error: 'Not a preview resource.' });
    try {
      if (!fs.realpathSync(file).startsWith(ROOT + path.sep))
        return json(res, 404, { error: 'Not a preview resource.' });
    } catch {
      return json(res, 404, { error: 'Not found.' });
    }
    let data;
    try {
      data = fs.readFileSync(file);
    } catch {
      return json(res, 404, { error: 'Not found.' });
    }
    const ext = path.extname(file),
      types = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
        '.mp4': 'video/mp4',
        '.md': 'text/plain',
        '.lean': 'text/plain',
        '.ndjson': 'text/plain',
      };
    res.writeHead(200, {
      'content-type': types[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    json(res, 400, { error: String(error.message || error).slice(0, 500) });
  }
});
server.listen(PORT, process.env.EMET_HOST || '127.0.0.1', () =>
  console.log(`Emet preview: http://127.0.0.1:${PORT}/demo/web/\nStarting a local NEAR kernel…`),
);
(async () => {
  worker = await localNode('preview');
  const owner = worker.rootAccount,
    gas = '1000000000000000';
  kernel = await owner.createSubAccount('kernel', { initialBalance: '20000000000000000000000000' });
  const key = await kernel.getKey();
  const deployed = await kernel
    .batch(kernel)
    .deployContract(wasm)
    .functionCall('init', { owner: owner.accountId }, { gas: '100000000000000' })
    .deleteKey(key.getPublicKey())
    .transact();
  if (deployed.result.receipts_outcome.some((r) => r.outcome.status.Failure)) throw Error('Kernel deployment failed');
  for (const chunk of manifest.chunks)
    await owner.call(kernel, 'load_base_chunk', fs.readFileSync(path.join(ROOT, cfg.shelf, chunk)), { gas });
  await owner.call(
    kernel,
    'seal_base',
    { expected_sha256: manifest.base_sha256, expected_decl_count: manifest.base_decls },
    { gas },
  );
  for (let from = 0; from < manifest.base_decls; from += 256)
    await owner.call(kernel, 'check_base_range', { from, to: Math.min(manifest.base_decls, from + 256) }, { gas });
  const result = await kernel.view('status', {});
  if (!result.sealed || result.checked_upto !== manifest.base_decls)
    throw Error('The environment did not finish checking');
  state.kernel = kernel.accountId;
  state.ready = true;
  console.log(
    `Ready: ${kernel.accountId}, ${manifest.base_decls} declarations checked. Browser checks use view calls.`,
  );
  await patches.start(owner, wasm, gas);
})().catch((error) => {
  state.error = String(error.message || error).slice(0, 500);
  console.error(state.error);
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close();
  if (worker) await worker.tearDown();
  process.exit();
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
