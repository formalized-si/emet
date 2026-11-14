// Read-only live checking of the source-bound refund candidates on a local kernel.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
module.exports = function createPatchPreview(root) {
  const dir = path.join(root, 'cases/intents-refund');
  const candidates = JSON.parse(fs.readFileSync(path.join(dir, 'candidates.json'))).candidates;
  const shelf = JSON.parse(fs.readFileSync(path.join(dir, 'shelf/manifest.json')));
  const state = { ready: false, network: 'local sandbox', kernel: null, base_sha256: shelf.base_sha256 };
  let kernel,
    busy = false;
  return {
    state,
    async start(owner, wasm, gas) {
      try {
        kernel = await owner.createSubAccount('patch-kernel', { initialBalance: '40000000000000000000000000' });
        const key = await kernel.getKey();
        await kernel
          .batch(kernel)
          .deployContract(wasm)
          .functionCall('init', { owner: owner.accountId }, { gas: '100000000000000' })
          .deleteKey(key.getPublicKey())
          .transact();
        for (const chunk of shelf.chunks)
          await owner.call(kernel, 'load_base_chunk', fs.readFileSync(path.join(dir, 'shelf', chunk)), { gas });
        await owner.call(
          kernel,
          'seal_base',
          { expected_sha256: shelf.base_sha256, expected_decl_count: shelf.base_decls },
          { gas },
        );
        for (let from = 0; from < shelf.base_decls; from += 128)
          await owner.call(kernel, 'check_base_range', { from, to: Math.min(from + 128, shelf.base_decls) }, { gas });
        const result = await kernel.view('status', {});
        if (!result.sealed || result.checked_upto !== shelf.base_decls)
          throw Error('Refund environment is not checked');
        Object.assign(state, { ready: true, kernel: kernel.accountId, kernel_sha256: sha(wasm) });
        console.log('Ready: source-bound refund checker', kernel.accountId);
      } catch (error) {
        state.error = String(error.message || error);
      }
    },
    async check(label) {
      const candidate = candidates.find((c) => c.label === label);
      if (!candidate) throw Error('Unknown candidate');
      if (!state.ready) throw Error(state.error || 'Local refund kernel is starting');
      if (busy) throw Error('A refund proof is already being checked');
      busy = true;
      try {
        const delta = fs.readFileSync(path.join(dir, 'proofs', candidate.label + '.ndjson'));
        const result = await kernel.view('dry_run', { theorem_name: candidate.proved, delta: delta.toString() });
        return {
          ...state,
          candidate: candidate.label,
          source_sha256: candidate.source_sha256,
          claim: candidate.proved,
          decision: result.ok ? (candidate.proved === candidate.claim ? 'proved' : 'refuted') : 'unverified',
          checked_at: new Date().toISOString(),
          proof_sha256: sha(delta),
          proof_bytes: delta.length,
          result,
        };
      } finally {
        busy = false;
      }
    },
  };
};
