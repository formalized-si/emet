// node selftest.mjs policy_selftest.wasm  -- prints each scenario's output
import { readFileSync } from 'fs';
const bytes = readFileSync(process.argv[2]);
let mem;
const dec = new TextDecoder();
const { instance } = await WebAssembly.instantiate(bytes, { env: {
  panic_utf8: (len, ptr) => { throw new Error('PANIC: ' + dec.decode(new Uint8Array(mem.buffer, Number(ptr), Number(len)))); },
}});
mem = instance.exports.memory;
const out = instance.exports.outptr();
const u64 = (b, o) => { let x = 0n; for (let k = 7; k >= 0; k--) x = (x << 8n) | BigInt(b[o + k]); return x; };
for (let i = 0; i <= 10; i++) {
  const n = instance.exports.selftest(i);
  const b = new Uint8Array(mem.buffer, out, n).slice();
  if (i === 0) { console.log(`#0 policy bytes (${n}): caps`, [0,8,16,24].map(o => u64(b,o)).join(','), 'rest', dec.decode(b.slice(32))); continue; }
  if (i === 1) { console.log(`#1 init state:`, [0,8,16,24].map(o => u64(b,o)).join(',')); continue; }
  if (i === 2) { console.log(`#2 validate=${b[0]} tighten(orig,tight)=${b[1]} tighten(tight,orig)=${b[2]}`); continue; }
  const tag = String.fromCharCode(b[0]);
  if (tag === 'E') { console.log(`#${i} ${dec.decode(b)}`); continue; }
  const st = [1,9,17,25].map(o => u64(b,o)).join(',');
  console.log(`#${i} tag=${tag} state[spentTotal,spentToday,dayStart,nonce]=${st} code=${dec.decode(b.slice(33))}`);
}
