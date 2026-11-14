// The hostile suite: every known-invalid proof we have is sent to the kernel CONTRACT, and none may be admitted.
//
// Inputs (all in this repository, unchanged):
//   cheats/arena/bad/     the 84 exports the Lean Kernel Arena expects a checker to reject (commit in MANIFEST.json)
//   cheats/arena/built/   the two forged-recursor exports tools/check_arena.sh makes from cheats/ForgedRec.lean
//   cheats/deltas/        this repository's own twelve fake proofs of the headline claim
// Controls, which must be ACCEPTED, so that the suite cannot pass by refusing everything:
//   cheats/arena/good/    nine exports the arena expects to be accepted, through the same two paths
//   proofs/MANIFEST.json  the agents' eight honest proofs, and the appended carrier theorem on its own
//
// Two paths into the contract:
//   base   the export is sealed as a base in a fresh kernel account, bytes unchanged: load_base_chunk, seal_base
//          (parser and axiom list, no kernel), then check_base_range (the kernel). A base is admitted if it ends
//          sealed. Which call fails says where it stopped: seal_base = a guard, check_base_range = the kernel.
//   delta  the export re-expressed by tools/arena_delta.py as a proof file on the sealed wallet shelf (not every
//          export can be: see that file), sent as check_result_raw (the call a board pays on), as dry_run in a
//          transaction (the free check's gas: a view call reports none) and as the dry_run view call itself.
//          Admitted if the contract answers ok. A returned reason is a guard; a panic in the parser is a guard;
//          a panic anywhere else, on bytes the parser accepts (statement_of, which only parses), is the kernel.
//
// usage: node demo/hostile.cjs [output.json]     (default run-output/hostile/results.json; ./verify.sh --hostile
//        sets up the sandbox binary and writes to run-output/ instead)
// Exits 1 if a bad input is admitted, a control is refused, or a test could not be completed.
//
// The target is the environment's:
//   HOSTILE_NETWORK      "sandbox" (default): start a local near-sandbox node. Any other id needs the next three.
//   HOSTILE_RPC_URL      RPC endpoint
//   HOSTILE_SIGNER       the account that pays; kernel accounts are created below it and keep its key
//   HOSTILE_SIGNER_KEY   its key (ed25519:...), or HOSTILE_SIGNER_KEY_FILE: a file with "private_key" or "secret_key"
//   HOSTILE_KERNEL       an already sealed kernel account for the delta path (default: deploy and seal one)
//   HOSTILE_PATHS        "delta,base" (default); the base path locks about 8 NEAR of storage per test
//   HOSTILE_ONLY         run only the tests whose id contains this text
//   HOSTILE_JOBS         signers working in parallel (default 4 on the local node, 1 elsewhere)
//   HOSTILE_KERNEL_WASM  another kernel build (default artifacts/kernel.wasm)
//   HOSTILE_TRY_DIR      also write the "try a fake proof" fixtures there (cheats/try when recording)
// Tested on near-sandbox only. It refuses mainnet.
const { Worker } = require('near-workspaces');
const localNode = require('../tools/local-node.cjs');
const { KeyPair, keyStores } = require('near-api-js');
const fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'run-output/hostile/results.json'));
const E = process.env;
const NETWORK = E.HOSTILE_NETWORK || 'sandbox',
  LOCAL = NETWORK === 'sandbox';
const PATHS = (E.HOSTILE_PATHS || 'delta,base').split(',');
const JOBS = Number(E.HOSTILE_JOBS || (LOCAL ? 4 : 1));
const VIEW_CAP_TGAS = 300; // public RPC nodes stop a view call around here
const NEAR = 10n ** 24n,
  PGAS = 1000n * 10n ** 12n;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const read = (p) => fs.readFileSync(path.join(ROOT, p));
const json = (p) => JSON.parse(read(p));
const tgas = (g) => Math.round(Number(g) / 1e9) / 1e3;

const cfg = json('demo/bounties.json'),
  shelf = json(path.join(cfg.shelf, 'manifest.json')),
  arena = json('cheats/arena/MANIFEST.json');
const kernelWasm = fs.readFileSync(path.resolve(ROOT, E.HOSTILE_KERNEL_WASM || cfg.kernel_wasm));
const CLAIM = cfg.bounties.find((b) => b.headline).claim;

const report = {
  kind: 'emet-hostile',
  started_at: new Date().toISOString(),
  target: {
    network: NETWORK,
    rpc: LOCAL ? 'local near-sandbox' : E.HOSTILE_RPC_URL,
    paths: PATHS,
    only: E.HOSTILE_ONLY || null,
    kernel_wasm_sha256: sha(kernelWasm),
    shelf_sha256: shelf.base_sha256,
    claim: CLAIM,
  },
  arena: { source: arena.source, commit: arena.arena_commit, tarball_sha256: arena.tarball.sha256 },
  how_to_read: {
    admitted:
      'base path: the base ends sealed. delta path: the contract answers ok. For an input with expected "reject" this must be false.',
    not_sent:
      'an arena export that cannot be a proof file on this shelf (tools/arena_delta.py); nothing was sent on the delta path, and its base-path row is the test',
    stopped_by:
      'guard = refused before the kernel ran (decided_at and guard say which call and which check); kernel = the type checker refused a declaration; gas limit = the call ran out of gas first, so neither decided',
    gas_tgas: 'gas burnt by the receipt of the call named in decided_at, whose transaction is tx',
    free: `the same delta through dry_run: "view" is the view call's answer on this node; gas_tgas is dry_run sent as a transaction (a view call does the same work without the receipt's own fees, 1 to 2 TGas here); over_cap marks more than ${VIEW_CAP_TGAS} TGas`,
  },
  results: [],
};
const save = () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
};

// ------------------------------------------------------------------ inputs
function inputs() {
  const list = [];
  const exp = (dir, expected) =>
    Object.keys(arena[dir]).forEach((name) =>
      list.push({
        id: `arena/${dir}/${name}`,
        expected,
        export: `cheats/arena/${dir}/${name}.ndjson`,
        rel: `${dir}/${name}.ndjson`,
        source:
          dir === 'built'
            ? `this repository's export of the arena's tests/bugs/${name}.yaml (tools/check_arena.sh)`
            : `Lean Kernel Arena ${name}`,
        arena_commit: arena.arena_commit,
      }),
    );
  exp('bad', 'reject');
  exp('built', 'reject');
  exp('good', 'accept');
  const own = (file, statement, expected, source) =>
    list.push({
      id: 'repo/' + file.replace(/\/delta\.ndjson$|\.delta\.ndjson$/, ''),
      expected,
      delta: file,
      statement,
      source,
    });
  for (const d of json('proofs/MANIFEST.json').deltas)
    own(
      d.delta,
      d.claim,
      d.expected === 'accepted' ? 'accept' : 'reject',
      d.expected === 'accepted'
        ? `an honest proof (${d.origin}, ${d.model})`
        : 'a fake proof of the headline claim (cheats/, tools/forge_cheats.py)',
    );
  for (const n of ['forgedRec', 'forgedRecNested'])
    own(
      `cheats/deltas/${n}.delta.ndjson`,
      CLAIM,
      'reject',
      'a proof of False from a forged recursor rule, stated as a proof of the headline claim (cheats/Forged.lean)',
    );
  for (const n of ['builtinGcd', 'builtinString'])
    own(
      `cheats/deltas/${n}.delta.ndjson`,
      CLAIM,
      'reject',
      'a proof of False from a name that the type checker computes by itself and that the proof file declares, stated as a proof of the headline claim (tools/forge_cheats.py)',
    );
  return list.filter((t) => !E.HOSTILE_ONLY || t.id.includes(E.HOSTILE_ONLY));
}

// What a failed receipt or a failed view call says, on one line: { gas } | { file, line, msg } | { msg }.
function failure(x) {
  const exec =
    x &&
    x.ActionError &&
    x.ActionError.kind &&
    x.ActionError.kind.FunctionCallError &&
    x.ActionError.kind.FunctionCallError.ExecutionError;
  // A view call's error repeats itself as JSON after `" })`; a receipt's ExecutionError is the message alone.
  const t = (exec || (typeof x === 'string' ? x : JSON.stringify(x)).split('" })')[0])
    .replace(/\\n|\n/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  if (/GasLimitExceeded|GasExceeded|Exceeded the prepaid gas|Exceeded the maximum amount of gas/.test(t))
    return { gas: true, msg: 'ran out of gas' };
  let m = t.match(/panicked at (?:\S*\/)?(\w+\.rs):(\d+):\d+: ?(.*)$/);
  if (m) return { file: m[1], line: Number(m[2]), msg: m[3] };
  m = t.match(/Smart contract panicked: (.*)$/) || t.match(/panic_msg: "(.*)$/);
  return { msg: (m ? m[1] : t).slice(0, 400) };
}
// Declarations as the kernel counts them: an inductive block counts its types, constructors and recursors.
const declCount = (bytes) =>
  bytes
    .toString()
    .split('\n')
    .reduce((n, l) => {
      if (/^\{"(axiom|def|thm|opaque|quot)"/.test(l)) return n + 1;
      if (!l.startsWith('{"inductive"')) return n;
      try {
        const v = JSON.parse(l).inductive;
        return n + ['types', 'ctors', 'recs'].reduce((a, k) => a + (v[k] || []).length, 0);
      } catch (e) {
        return n;
      }
    }, 0);
const where = (f) => (f.file ? `${f.file}:${f.line}: ` : '') + f.msg;

async function main() {
  if (/mainnet/i.test(NETWORK + (E.HOSTILE_RPC_URL || ''))) throw Error('this suite does not run on mainnet');
  const tests = inputs();
  // The arena exports as proof files on the shelf (tools/arena_delta.py says how, and which cannot be).
  const deltaDir = path.join(ROOT, 'run-output/hostile/deltas');
  if (PATHS.includes('delta'))
    console.log(
      execFileSync('python3', [
        '-I',
        path.join(ROOT, 'tools/arena_delta.py'),
        path.join(ROOT, cfg.shelf, 'base.ndjson'),
        CLAIM,
        deltaDir,
        path.join(ROOT, 'cheats/arena'),
        ...tests.filter((t) => t.export).map((t) => path.join(ROOT, t.export)),
      ])
        .toString()
        .trim(),
    );
  const index = PATHS.includes('delta') ? JSON.parse(fs.readFileSync(path.join(deltaDir, 'index.json'))) : {};

  let worker;
  if (LOCAL) worker = await localNode('hostile');
  else {
    for (const k of ['HOSTILE_RPC_URL', 'HOSTILE_SIGNER'])
      if (!E[k]) throw Error(`HOSTILE_NETWORK=${NETWORK} needs ${k}`);
    const kf = E.HOSTILE_SIGNER_KEY_FILE && JSON.parse(fs.readFileSync(E.HOSTILE_SIGNER_KEY_FILE));
    const key = E.HOSTILE_SIGNER_KEY || (kf && (kf.private_key || kf.secret_key));
    if (!key) throw Error('needs HOSTILE_SIGNER_KEY or HOSTILE_SIGNER_KEY_FILE');
    worker = await Worker.init({
      network: 'custom',
      rpcAddr: E.HOSTILE_RPC_URL,
      rootAccountId: E.HOSTILE_SIGNER,
      keyStore: new keyStores.InMemoryKeyStore(),
    });
    await worker.rootAccount.setKey(KeyPair.fromString(key));
  }
  try {
    const root = worker.rootAccount,
      rpc = worker.provider,
      rootKey = await root.getKey();
    const run = LOCAL ? '' : '-' + Date.now().toString(36).slice(-6); // account names must be new on a chain that persists
    report.target.signer = root.accountId;

    // One transaction, one function call: what came back, what it burnt, where to find it.
    async function send(signer, contract, method, args, gas = PGAS) {
      const r = (await signer.callRaw(contract, method, args, { gas })).result;
      const first =
        r.receipts_outcome.find((o) => o.id === r.transaction_outcome.outcome.receipt_ids[0]) || r.receipts_outcome[0];
      const failed = r.receipts_outcome.map((o) => o.outcome.status.Failure).find(Boolean) || r.status.Failure;
      const out = { method, tx: r.transaction.hash, gas_tgas: tgas(first.outcome.gas_burnt), ok: !failed };
      if (failed) out.failure = failure(failed);
      else if (r.status.SuccessValue) {
        try {
          out.value = JSON.parse(Buffer.from(r.status.SuccessValue, 'base64').toString());
        } catch (e) {
          /* not JSON */
        }
      }
      return out;
    }
    // A new account below `signer` running the kernel, owned by `signer`, in one transaction.
    async function newKernel(signer, name, stateBytes) {
      const id = `${name}${run}.${signer.accountId}`;
      const amount = BigInt(kernelWasm.length + Math.ceil(stateBytes * 1.3) + 30000) * 10n ** 19n + NEAR / 5n;
      const r = await signer
        .batch(id)
        .createAccount()
        .transfer(amount)
        .addKey((await signer.getKey()).getPublicKey())
        .deployContract(kernelWasm)
        .functionCall('init', { owner: signer.accountId }, { gas: 100n * 10n ** 12n })
        .transact();
      if (!r.succeeded) throw Error(`deploy ${id}: ${JSON.stringify(r.result.status).slice(0, 300)}`);
      return signer.getAccount(id);
    }

    // Signers: on the local node four funded accounts work in parallel; elsewhere the signer itself.
    const signers = [];
    if (JOBS <= 1) signers.push(root);
    else
      for (let i = 0; i < JOBS; i++)
        signers.push(
          await root.createSubAccount(`w${i}${run}`, {
            initialBalance: (LOCAL ? 2000n : 300n) * NEAR,
            keyPair: rootKey,
          }),
        );
    async function pool(items, fn) {
      const q = items.slice();
      await Promise.all(
        signers.map(async (s) => {
          for (let it; (it = q.shift()); ) await fn(it, s);
        }),
      );
    }
    function record(t, row) {
      const {
        path: p,
        form,
        statement_name,
        sent_sha256,
        sent_bytes,
        admitted,
        stopped_by,
        guard,
        detail,
        decided_at,
        gas_tgas,
        tx,
        ...rest
      } = row;
      row.pass = row.error ? false : admitted === (t.expected === 'accept');
      report.results.push({
        id: t.id,
        expected: t.expected,
        source: t.source,
        arena_commit: t.arena_commit,
        path: p,
        form,
        statement_name,
        sent_sha256,
        sent_bytes,
        admitted,
        pass: row.pass,
        stopped_by,
        guard,
        detail,
        decided_at,
        gas_tgas,
        tx,
        ...rest,
      });
      save();
      const how = row.error
        ? `ERROR ${row.error}`
        : row.admitted
          ? 'admitted'
          : row.not_sent
            ? row.detail
            : `stopped by ${row.stopped_by === 'guard' ? `a guard (${row.guard})` : row.stopped_by === 'kernel' ? 'the kernel' : 'the gas limit'}: ${row.detail}`;
      console.log(
        `${row.pass ? (row.not_sent ? '--  ' : 'ok  ') : 'FAIL'}  ${row.path.padEnd(5)}  ${t.id}  ${how}`.slice(0, 230),
      );
    }

    // ------------------------------------------------------------------ the delta path
    if (PATHS.includes('delta')) {
      let kernel;
      if (E.HOSTILE_KERNEL) kernel = root.getAccount(E.HOSTILE_KERNEL);
      else {
        console.log('\n[shelf] a kernel with the wallet shelf, sealed and type-checked on-chain');
        kernel = await newKernel(root, 'shelf', shelf.base_bytes);
        for (const c of shelf.chunks)
          if (!(await send(root, kernel, 'load_base_chunk', read(path.join(cfg.shelf, c)))).ok)
            throw Error('shelf upload');
        if (
          !(
            await send(root, kernel, 'seal_base', {
              expected_sha256: shelf.base_sha256,
              expected_decl_count: shelf.base_decls,
            })
          ).ok
        )
          throw Error('shelf seal');
        for (let from = 0, span = 256; from < shelf.base_decls; ) {
          const to = Math.min(shelf.base_decls, from + span);
          if ((await send(root, kernel, 'check_base_range', { from, to })).ok) from = to;
          else if (span === 1) throw Error('shelf check');
          else span >>= 1;
        }
      }
      const st = await kernel.view('status', {});
      if (!st.sealed || st.base_hash !== shelf.base_sha256)
        throw Error(`${kernel.accountId} is not a kernel sealed with this shelf: ${JSON.stringify(st)}`);
      Object.assign(report.target, {
        kernel_account: kernel.accountId,
        kernel_name: await kernel.view('kernel_name', {}),
      });
      console.log(
        `      ${kernel.accountId}: ${report.target.kernel_name}, shelf ${st.base_hash.slice(0, 16)}…, ${st.checked_upto} declarations checked`,
      );

      const jobs = [];
      for (const t of tests) {
        if (t.delta) jobs.push({ t, form: 'as written', statement: t.statement, delta: read(t.delta) });
        else if (index[t.rel].status === 'delta')
          jobs.push({
            t,
            form: index[t.rel].form,
            statement: index[t.rel].statement_name,
            delta: fs.readFileSync(path.join(deltaDir, index[t.rel].delta)),
          });
        else
          record(t, {
            path: 'delta',
            not_sent: true,
            admitted: false,
            detail: `not a delta on this shelf: it ${index[t.rel].why}, which the contract refuses before the kernel; the base path runs it`,
          });
      }
      if (!E.HOSTILE_ONLY || 'control/carrier'.includes(E.HOSTILE_ONLY))
        jobs.unshift({
          t: {
            id: 'control/carrier',
            expected: 'accept',
            source: 'the carrier theorem tools/arena_delta.py appends, on its own',
          },
          form: 'carrier',
          statement: index.carrier.statement_name,
          delta: fs.readFileSync(path.join(deltaDir, index.carrier.delta)),
        });
      console.log(
        `\n[delta] ${jobs.length} proof files to ${kernel.accountId}: check_result_raw, dry_run as a transaction, dry_run as a view call`,
      );
      await pool(jobs, async ({ t, form, statement, delta }, signer) => {
        const row = {
          path: 'delta',
          form,
          statement_name: statement,
          sent_sha256: sha(delta),
          sent_bytes: delta.length,
        };
        try {
          const args = { theorem_name: statement, delta: delta.toString() };
          const paid = await send(
            signer,
            kernel,
            'check_result_raw',
            Buffer.concat([Buffer.from(statement + '\n'), delta]),
          );
          Object.assign(row, {
            admitted: !!(paid.value && paid.value.ok),
            decided_at: 'check_result_raw',
            gas_tgas: paid.gas_tgas,
            tx: paid.tx,
          });
          if (paid.value && !paid.value.ok)
            Object.assign(row, {
              stopped_by: 'guard',
              guard: paid.value.reason.split(':')[0],
              detail: paid.value.reason,
            });
          else if (!paid.ok) {
            const f = paid.failure;
            if (f.gas) Object.assign(row, { stopped_by: 'gas limit', detail: f.msg });
            else if (f.file === 'parser.rs')
              Object.assign(row, { stopped_by: 'guard', guard: 'parser', detail: where(f) });
            else {
              // Not the parser's panic. statement_of parses base + delta and nothing more: if it answers, the parser took these bytes.
              row.parser_accepted = await kernel.view('statement_of', args).then(
                () => true,
                (e) => !/malformed|parser\.rs/.test(String(e.message)),
              );
              Object.assign(
                row,
                row.parser_accepted && /^(tc|inductive|quot|expr|level|env)\.rs$/.test(f.file || '')
                  ? { stopped_by: 'kernel', detail: where(f) }
                  : { stopped_by: 'guard', guard: 'contract', detail: where(f) },
              );
            }
          } else if (!row.admitted) throw Error('no verdict: ' + JSON.stringify(paid).slice(0, 200));
          const free = await send(signer, kernel, 'dry_run', args);
          const view = await kernel.view('dry_run', args).then(
            (r) => (r.ok ? 'accepted' : 'refused:' + r.reason),
            (e) => {
              const f = failure(String(e.message));
              return f.gas ? 'over the view gas limit of this node' : 'failed: ' + where(f);
            },
          );
          row.free = { view, gas_tgas: free.gas_tgas, tx: free.tx, over_cap: free.gas_tgas > VIEW_CAP_TGAS };
          // The free check must say what the paid one said (unless this node's view gas limit cut it short).
          const agrees =
            view.startsWith('over') ||
            (row.admitted
              ? view === 'accepted'
              : paid.value
                ? view === 'refused:' + row.detail
                : view.startsWith('failed'));
          if (!agrees || (!(free.failure && free.failure.gas) && !!(free.value && free.value.ok) !== row.admitted))
            throw Error(`the free check disagrees with the paid one: ${view}`);
        } catch (e) {
          row.error = String(e.message || e).slice(0, 400);
        }
        record(t, row);
      });
    }

    // ------------------------------------------------------------------ the base path
    if (PATHS.includes('base')) {
      const jobs = tests.filter((t) => t.export);
      console.log(
        `\n[base] ${jobs.length} exports, each sealed as a base in its own kernel account: load_base_chunk, seal_base, check_base_range`,
      );
      let n = 0;
      await pool(jobs, async (t, signer) => {
        const bytes = read(t.export);
        const row = {
          path: 'base',
          form: 'unchanged',
          sent_sha256: sha(bytes),
          sent_bytes: bytes.length,
          admitted: false,
          calls: [],
        };
        const call = async (...a) => {
          const c = await send(...a);
          row.calls.push({ method: c.method, tx: c.tx, gas_tgas: c.gas_tgas, ok: c.ok });
          Object.assign(row, { decided_at: c.method, gas_tgas: c.gas_tgas, tx: c.tx });
          return c;
        };
        try {
          const k = await newKernel(signer, `b${String(n++).padStart(3, '0')}`, bytes.length);
          row.kernel_account = k.accountId;
          let c = await call(
            signer,
            k,
            'load_base_chunk',
            Buffer.concat([Buffer.from('0 raw\n'), bytes]),
            300n * 10n ** 12n,
          );
          if (!c.ok) Object.assign(row, { stopped_by: 'guard', guard: 'upload format', detail: where(c.failure) });
          else {
            // The declaration count is the caller's to state; if ours is not the parser's, take the parser's, so that a wrong count is never the reason.
            let count = declCount(bytes);
            c = await call(signer, k, 'seal_base', { expected_sha256: row.sent_sha256, expected_decl_count: count });
            const m = !c.ok && c.failure.msg.match(/base has (\d+) declarations/);
            if (m) {
              count = Number(m[1]);
              c = await call(signer, k, 'seal_base', { expected_sha256: row.sent_sha256, expected_decl_count: count });
            }
            row.declarations = count;
            if (!c.ok)
              Object.assign(
                row,
                c.failure.gas
                  ? { stopped_by: 'gas limit', detail: c.failure.msg }
                  : {
                      stopped_by: 'guard',
                      guard: /unpermitted axiom/.test(c.failure.msg) ? 'axiom list' : 'parser',
                      detail: where(c.failure),
                    },
              );
            else {
              for (let from = 0, span = count; from < count; ) {
                const to = Math.min(count, from + span);
                c = await call(signer, k, 'check_base_range', { from, to });
                if (c.ok) from = to;
                else if (c.failure.gas && span > 1)
                  span >>= 1; // too much for one call: smaller ranges
                else {
                  Object.assign(row, {
                    stopped_by: c.failure.gas ? 'gas limit' : 'kernel',
                    detail: where(c.failure),
                    declarations_checked_before: from,
                    failed_range: [from, to],
                  });
                  break;
                }
              }
              row.admitted = (await k.view('status', {})).sealed;
              if (!row.admitted && !row.stopped_by) throw Error('not sealed and nothing failed');
            }
          }
        } catch (e) {
          row.error = String(e.message || e).slice(0, 400);
        }
        record(t, row);
      });
    }
  } finally {
    summarize();
    save();
    await worker.tearDown();
  }
  const s = report.summary;
  console.log(
    `\n${s.bad_inputs} bad inputs in ${s.bad_checks} checks: ${s.admitted} admitted (${s.stopped_by_kernel} checks stopped by the kernel, ${s.stopped_by_guard} by a guard, ${s.stopped_by_gas_limit} by the gas limit, ${s.not_sent} not sent). ` +
      `Controls: ${s.controls_accepted}/${s.controls} accepted. Free path over ${VIEW_CAP_TGAS} TGas: ${s.free_path.over_cap.length} of ${s.free_path.measured}. Record: ${path.relative(process.cwd(), OUT)}`,
  );
  if (E.HOSTILE_TRY_DIR) tryFixtures(path.resolve(E.HOSTILE_TRY_DIR));
  if (s.admitted || s.errors || s.controls_accepted !== s.controls) process.exit(1);
}

function summarize() {
  const R = report.results,
    bad = R.filter((r) => r.expected === 'reject'),
    ctl = R.filter((r) => r.expected === 'accept');
  const count = (rows, key) =>
    rows.reduce((m, r) => {
      const k = key(r);
      if (k) m[k] = (m[k] || 0) + 1;
      return m;
    }, {});
  const range = (rows) => {
    const g = rows.map((r) => r.gas_tgas).filter((x) => x != null);
    return g.length ? [Math.min(...g), Math.max(...g)] : null;
  };
  const sent = bad.filter((r) => !r.not_sent && !r.error),
    free = R.filter((r) => r.free);
  const byKernel = new Set(sent.filter((r) => r.stopped_by === 'kernel').map((r) => r.id));
  report.finished_at = new Date().toISOString();
  report.summary = {
    bad_inputs: new Set(bad.map((r) => r.id)).size,
    bad_checks: sent.length,
    admitted: bad.filter((r) => r.admitted).length,
    admitted_ids: bad.filter((r) => r.admitted).map((r) => `${r.path}:${r.id}`),
    errors: R.filter((r) => r.error).length,
    not_sent: bad.filter((r) => r.not_sent).length,
    stopped_by_kernel: sent.filter((r) => r.stopped_by === 'kernel').length,
    stopped_by_guard: sent.filter((r) => r.stopped_by === 'guard').length,
    stopped_by_gas_limit: sent.filter((r) => r.stopped_by === 'gas limit').length,
    bad_inputs_the_kernel_stopped_on_some_path: byKernel.size,
    bad_inputs_only_guards_stopped: [...new Set(sent.map((r) => r.id))].filter((id) => !byKernel.has(id)),
    by_path: Object.fromEntries(
      ['base', 'delta'].map((p) => {
        const rows = sent.filter((r) => r.path === p);
        return [
          p,
          {
            checks: rows.length,
            admitted: rows.filter((r) => r.admitted).length,
            kernel: rows.filter((r) => r.stopped_by === 'kernel').length,
            gas_limit: rows.filter((r) => r.stopped_by === 'gas limit').length,
            guard: count(
              rows.filter((r) => r.stopped_by === 'guard'),
              (r) => r.guard,
            ),
            gas_tgas_range: range(rows),
          },
        ];
      }),
    ),
    controls: ctl.length,
    controls_accepted: ctl.filter((r) => r.admitted && !r.error).length,
    free_path: {
      measured: free.length,
      cap_tgas: VIEW_CAP_TGAS,
      gas_tgas_range_bad: range(free.filter((r) => r.expected === 'reject').map((r) => r.free)),
      gas_tgas_range_valid: range(free.filter((r) => r.expected === 'accept').map((r) => r.free)),
      over_cap: free
        .filter((r) => r.free.over_cap)
        .map((r) => ({ id: r.id, expected: r.expected, gas_tgas: r.free.gas_tgas })),
    },
  };
}

// The "try a fake proof for free" fixtures: the exact dry_run arguments, with the verdict and gas of this run.
function tryFixtures(dir) {
  const pick = [
    [
      'forged-recursor-rule',
      'repo/cheats/deltas/forgedRec',
      'A proof of False built on one forged rule of a recursor, used to "prove" the wallet claim; this kernel accepted it until 2026-11-11.',
    ],
    [
      'nested-unused-param',
      'arena/bad/bugs/nested-unused-param',
      "A proof of False through an ill-typed argument hidden inside a nested inductive type: the bug found in Lean's own kernel in July 2026 (lean4#14576).",
    ],
    ['private-axiom', 'repo/cheats/deltas/viaAxiom', 'The proof brings its own axiom saying False is true.'],
    [
      'ill-typed-proof',
      'repo/cheats/deltas/illTyped',
      'A real proof of the claim with its last step replaced by something of the wrong type.',
    ],
    [
      'valid-proof',
      'repo/evidence/agent/Refute.SlidingDayCap-sonnet',
      'An honest proof: a counterexample to "at most one day\'s cap in any stretch shorter than a day", written by an AI agent.',
    ],
  ];
  fs.mkdirSync(dir, { recursive: true });
  const fixtures = [];
  for (const [name, id, description] of pick) {
    const r = report.results.find((x) => x.id === id && x.path === 'delta' && x.free);
    if (!r) {
      console.log(`try fixture ${name}: ${id} was not run on the delta path`);
      continue;
    }
    const t = inputs().find((x) => x.id === id);
    const delta = t.delta
      ? read(t.delta)
      : fs.readFileSync(
          path.join(
            ROOT,
            'run-output/hostile/deltas',
            t.rel.replace(/\//g, '__').replace(/\.ndjson$/, '.delta.ndjson'),
          ),
        );
    if (sha(delta) !== r.sent_sha256) throw Error(`try fixture ${name}: the delta changed since the run`);
    const args = JSON.stringify({ theorem_name: r.statement_name, delta: delta.toString() });
    fs.writeFileSync(path.join(dir, `${name}.args.json`), args);
    fixtures.push({
      name,
      description,
      valid: r.expected === 'accept',
      method: 'dry_run',
      args_file: `${name}.args.json`,
      args_sha256: sha(args),
      args_bytes: args.length,
      statement_name: r.statement_name,
      delta_sha256: r.sent_sha256,
      source: r.source,
      arena_commit: r.arena_commit,
      expected: { view: r.free.view, admitted: r.admitted, stopped_by: r.stopped_by || null, detail: r.detail || null },
      free_gas_tgas: r.free.gas_tgas,
      fits_a_300_tgas_view: !r.free.over_cap,
    });
  }
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify(
      {
        what: 'Ready-to-send arguments for the kernel contract\'s free check: a view call of `dry_run` with the bytes of args_file as its arguments. `expected.view` is what the call answered on a local node: "accepted", "refused:<reason>" (a guard), or "failed: <where>" (the call fails because the kernel panics on the proof).',
        shelf_sha256: shelf.base_sha256,
        kernel_wasm_sha256: report.target.kernel_wasm_sha256,
        recorded_in: 'evidence/hostile/results.json',
        fixtures,
      },
      null,
      1,
    ) + '\n',
  );
  console.log(`${fixtures.length} try-it fixtures in ${path.relative(process.cwd(), dir)}`);
}

main().catch((e) => {
  console.error(e);
  report.error = String((e && e.stack) || e);
  save();
  process.exit(1);
});
