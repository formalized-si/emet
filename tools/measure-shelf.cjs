// Seal a base ("shelf") in the kernel contract on a local NEAR node and measure the gas of
// checking proof deltas against it. Not a demo: a measurement for choosing the shelf.
// usage: node tools/measure-shelf.cjs kernel.wasm <packed_dir> cases.json output.json
// cases.json: [{"label": "...", "claim": "Wallet.Spec.X", "delta": "path"}]
const localNode = require('./local-node.cjs');
const fs = require('fs'),
  path = require('path');
const [kernelWasm, packed, casesPath, output] = process.argv.slice(2);
const N = 10n ** 24n,
  PGAS = '1000000000000000';
const manifest = JSON.parse(fs.readFileSync(path.join(packed, 'manifest.json')));
const cases = JSON.parse(fs.readFileSync(casesPath));
const report = {
  kernel_wasm_sha256: require('crypto').createHash('sha256').update(fs.readFileSync(kernelWasm)).digest('hex'),
  manifest,
  calls: [],
  cases: [],
};
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const burnt = (raw) =>
  [raw.transaction_outcome, ...raw.receipts_outcome].reduce((a, x) => a + BigInt(x.outcome.gas_burnt), 0n);
(async () => {
  const worker = await localNode('measure-shelf');
  try {
    const root = worker.rootAccount;
    const kernel = await root.createSubAccount('kernel', { initialBalance: (300n * N).toString() });
    await kernel.deploy(fs.readFileSync(kernelWasm));
    await root.call(kernel, 'init', { owner: root.accountId });
    const call = async (label, method, args) => {
      const r = await root.callRaw(kernel, method, args, { gas: PGAS });
      const ok = Object.prototype.hasOwnProperty.call(r.result.status, 'SuccessValue');
      const gas = burnt(r.result);
      report.calls.push({ label, ok, tgas: Number(gas) / 1e12 });
      console.log(label, ok ? 'ok' : 'FAILED', (Number(gas) / 1e12).toFixed(1), 'TGas');
      return {
        ok,
        gas,
        value: ok
          ? Buffer.from(r.result.status.SuccessValue, 'base64').toString()
          : JSON.stringify(r.result.status.Failure),
      };
    };
    let t0 = Date.now(),
      bootstrap = 0n;
    for (const c of manifest.chunks) {
      const r = await call('upload ' + c, 'load_base_chunk', fs.readFileSync(path.join(packed, c)));
      if (!r.ok) throw Error('upload');
      bootstrap += r.gas;
    }
    let r = await call('seal_base', 'seal_base', {
      expected_sha256: manifest.base_sha256,
      expected_decl_count: manifest.base_decls,
    });
    if (!r.ok) throw Error('seal: ' + r.value);
    bootstrap += r.gas;
    let from = 0,
      span = 64;
    while (from < manifest.base_decls) {
      const to = Math.min(manifest.base_decls, from + span);
      r = await call(`check_base_range ${from}..${to}`, 'check_base_range', { from, to });
      if (r.ok) {
        from = to;
        bootstrap += r.gas;
        span = Math.min(256, span * 2);
      } else {
        if (span === 1) throw Error('single declaration does not fit at ' + from);
        span = Math.max(1, Math.floor(span / 2));
      }
    }
    report.bootstrap_tgas = Number(bootstrap) / 1e12;
    report.bootstrap_seconds = (Date.now() - t0) / 1000;
    report.status = await kernel.view('status', {});
    save();
    for (const c of cases) {
      const delta = fs.readFileSync(c.delta);
      const r = await call('check ' + c.label, 'check_result_raw', Buffer.concat([Buffer.from(c.claim + '\n'), delta]));
      let v = null;
      try {
        v = JSON.parse(r.value);
      } catch (e) {}
      report.cases.push({
        label: c.label,
        claim: c.claim,
        delta_sha256: require('crypto').createHash('sha256').update(delta).digest('hex'),
        delta_bytes: delta.length,
        ok_call: r.ok,
        tgas: Number(r.gas) / 1e12,
        verdict_ok: v && v.ok,
        reason: v ? v.reason : r.value.slice(0, 400),
        mode: v && v.mode,
        proof_theorem: v && v.proof_theorem,
        decls_checked: v && v.decls_checked,
        gas_read: v && v.gas_read,
        gas_parse: v && v.gas_parse,
        gas_kernel: v && v.gas_kernel,
        statement_hash: v && v.statement_hash,
      });
      save();
    }
    console.log(
      JSON.stringify(
        {
          bootstrap_tgas: report.bootstrap_tgas,
          cases: report.cases.map((c) => [c.label, c.delta_bytes, c.tgas.toFixed(1), c.verdict_ok, c.reason]),
        },
        null,
        1,
      ),
    );
  } finally {
    await worker.tearDown();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
