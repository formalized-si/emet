//! `kernel`: Lean 4 proof checking on NEAR with a PINNED base environment.
//!
//! Flow (see README.md):
//! 1. owner uploads the base export (lean4export NDJSON of a fixed, ordered root list) with
//!    `load_base_chunk` (raw input: `<chunk_idx>\n<ndjson bytes>`);
//! 2. `seal_base(expected_sha256, expected_decl_count)` pins hash and declaration count;
//! 3. `check_base_range(from, to)` type-checks base declarations in staged calls; the base is
//!    sealed once every declaration passed;
//! 4. `check` / `check_result(theorem_name, delta_ndjson)` check a delta: the NDJSON lines that
//!    lean4export prints after the base when run on `<base roots...> <theorem>`.
//!
//! Every call re-reads and re-parses the stored base (NEAR keeps no memory between calls), so
//! per-call gas is about 0.18 TGas per KB of base.
use nanoda_lib::util::{Config, ExportFile};
use near_sdk::json_types::U64;
use near_sdk::{env, near, AccountId, PanicOnDefault};

/// The only axioms a base may contain. A delta may declare no axiom at all.
const BASE_AXIOMS: [&str; 3] = ["propext", "Classical.choice", "Quot.sound"];

/// The names that the type checker gives a meaning of its own and finds by name alone
/// (vendor/nanoda_lib/src/util.rs, `mk_name_cache`). A delta may declare none of them. If the sealed
/// base lacks such a name and a delta declares it, the checker computes with the built-in function and
/// not with the declared body, or takes the declared constant as the type of a literal. Both give a
/// proof of `False`. The test `builtin_name_in_delta_is_refused` keeps this list equal to the vendored one.
const BUILTIN_NAMES: [&str; 31] = [
    "eagerReduce", "Quot", "Quot.mk", "Quot.lift", "Quot.ind", "String", "String.ofList", "Nat", "Nat.zero",
    "Nat.succ", "Nat.add", "Nat.sub", "Nat.mul", "Nat.pow", "Nat.mod", "Nat.div", "Nat.beq", "Nat.ble", "Nat.gcd",
    "Nat.xor", "Nat.land", "Nat.lor", "Nat.shiftLeft", "Nat.shiftRight", "Bool.true", "Bool.false", "Char",
    "Char.ofNat", "List", "List.nil", "List.cons",
];

fn cfg(permitted: &[String], hard_error: bool) -> Config {
    let v = serde_json::json!({
        "use_stdin": true, "num_threads": 1,
        "permitted_axioms": permitted,
        "unpermitted_axiom_hard_error": hard_error,
        "nat_extension": true, "string_extension": true,
        "print_success_message": false, "print_axioms": false
    });
    serde_json::from_value(v).unwrap_or_else(|e| env::panic_str(&format!("cfg: {e}")))
}

fn gas() -> u64 { env::used_gas().as_gas() }

/// Gas readings are prohibited in view calls; `dry_run` passes `instrument = false`.
fn gas_if(instrument: bool) -> u64 { if instrument { gas() } else { 0 } }

const DECL_KEYS: [&str; 6] = ["axiom", "def", "thm", "opaque", "quot", "inductive"];
const DECL_PREFIXES: [&[u8]; 6] = [b"{\"axiom\"", b"{\"def\"", b"{\"thm\"", b"{\"opaque\"", b"{\"quot\"", b"{\"inductive\""];

/// Cheap structural scan of NDJSON lines (no kernel): returns the declaration lines as
/// (kind, declared name indices) and the name table defined by these lines.
fn scan_lines(bytes: &[u8]) -> Result<(Vec<(String, Vec<u64>)>, Vec<(u64, u64, String)>), String> {
    let mut decls = Vec::new();
    let mut names = Vec::new();
    for (ln, line) in bytes.split(|b| *b == b'\n').enumerate() {
        if line.is_empty() { continue }
        let is_name = line.starts_with(b"{\"in\"");
        let kind = DECL_PREFIXES.iter().position(|prefix| line.starts_with(prefix)).map(|i| &DECL_KEYS[i]);
        if !is_name && kind.is_none() { continue }
        let v: serde_json::Value = serde_json::from_slice(line).map_err(|e| format!("line {}: {e}", ln + 1))?;
        if is_name {
            let idx = v["in"].as_u64().unwrap_or(0);
            if let Some(st) = v.get("str") {
                names.push((idx, st["pre"].as_u64().unwrap_or(0), st["str"].as_str().unwrap_or("").to_string()));
            } else if let Some(nm) = v.get("num") {
                names.push((idx, nm["pre"].as_u64().unwrap_or(0), nm["i"].to_string()));
            }
            continue;
        }
        let k = *kind.unwrap();
        let body = &v[k];
        let mut idxs = Vec::new();
        if k == "inductive" {
            for part in ["types", "ctors", "recs"] {
                for t in body[part].as_array().into_iter().flatten() { if let Some(n) = t["name"].as_u64() { idxs.push(n) } }
            }
        } else if let Some(n) = body["name"].as_u64() {
            idxs.push(n);
        }
        decls.push((k.to_string(), idxs));
    }
    Ok((decls, names))
}

fn resolve(names: &[(u64, u64, String)], idx: u64) -> String {
    let mut parts = vec![];
    let mut cur = idx;
    for _ in 0..64 {
        if cur == 0 { break }
        match names.iter().find(|(i, _, _)| *i == cur) {
            Some((_, pre, s)) => { parts.push(s.clone()); cur = *pre }
            None => { parts.push(format!("#{cur}")); break }
        }
    }
    parts.reverse();
    parts.join(".")
}

#[near(serializers = [json])]
pub struct Status {
    pub owner: AccountId,
    pub chunks: u32,
    pub base_bytes: u64,
    pub stored_bytes: u64,
    pub base_hash: Option<String>,
    pub base_decls: u32,
    pub checked_upto: u32,
    pub sealed: bool,
    pub axioms_in_base: Vec<String>,
}

#[near(serializers = [json])]
pub struct RangeResult {
    pub checked_from: u32,
    pub checked_to: u32,
    pub base_decls: u32,
    pub sealed: bool,
    pub gas_read: u64,
    pub gas_parse: u64,
    pub gas_check: u64,
}

/// Frozen bounty interface (contracts/lean_check, kernel_stub): externally tagged JSON.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Accepted { axioms: Vec<String>, decls: u32, gas: U64 },
    Rejected { reason: String },
}

pub const KERNEL_NAME: &str = "nanoda_lib-0.4.32/pinned-base/v4";

#[near(serializers = [json])]
pub struct CheckResult {
    pub ok: bool,
    /// Why the delta was rejected (None when ok).
    pub reason: Option<String>,
    pub theorem: String,
    /// "claim" (statement_name is a base Prop definition; the proof theorem's type must be that
    /// constant) or "theorem" (statement_name names the new theorem in the delta).
    pub mode: Option<String>,
    /// The delta theorem that was checked.
    pub proof_theorem: Option<String>,
    /// Pretty-printed statement (nanoda pretty printer).
    pub statement: Option<String>,
    /// hex sha256 of nanoda's debug print of the theorem type; pins the statement for bounties.
    pub statement_hash: Option<String>,
    pub decls_checked: u32,
    /// `kind name` of each declaration the delta adds.
    pub new_decls: Vec<String>,
    /// Axioms the theorem transitively depends on (all from the sealed base).
    pub axioms: Vec<String>,
    pub base_hash: Option<String>,
    pub delta_bytes: u32,
    pub gas_read: u64,
    pub gas_parse: u64,
    pub gas_analyze: u64,
    pub gas_kernel: u64,
    /// total gas used by the call (string; absent in views)
    pub gas: Option<U64>,
    /// same as `gas` (kept for the lead's field name)
    pub gas_hint: Option<U64>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Kernel {
    owner: AccountId,
    chunks: u32,
    base_bytes: u64,
    /// bytes actually stored for the base chunks (after compression)
    stored_bytes: u64,
    base_hash: Option<String>,
    base_decls: u32,
    checked_upto: u32,
    sealed: bool,
    axioms_in_base: Vec<String>,
    /// Sorted name indices of every base declaration (types, ctors, recs included).
    base_decl_idx: Vec<u64>,
}

const BASE_NAMES_KEY: &[u8] = b"bn";

fn chunk_key(i: u32) -> Vec<u8> { format!("c{i}").into_bytes() }

/// Stored chunk = 1 codec byte + payload. 0 = raw NDJSON, 1 = lz4 block (size prepended,
/// `lz4_flex::compress_prepend_size`), 2 = zlib (`miniz_oxide`).
const CODEC_RAW: u8 = 0;
const CODEC_LZ4: u8 = 1;
const CODEC_ZLIB: u8 = 2;

fn decode_chunk(stored: &[u8]) -> Vec<u8> {
    let (codec, payload) = stored.split_first().unwrap_or_else(|| env::panic_str("empty chunk"));
    match *codec {
        CODEC_RAW => payload.to_vec(),
        CODEC_LZ4 => lz4_flex::block::decompress_size_prepended(payload).unwrap_or_else(|e| env::panic_str(&format!("lz4: {e}"))),
        CODEC_ZLIB => miniz_oxide::inflate::decompress_to_vec_zlib(payload).unwrap_or_else(|e| env::panic_str(&format!("zlib: {e:?}"))),
        c => env::panic_str(&format!("unknown codec {c}")),
    }
}

impl Kernel {
    fn assert_owner(&self) {
        if env::predecessor_account_id() != self.owner { env::panic_str("owner only") }
    }
    fn read_base(&self, extra: usize) -> Vec<u8> {
        let mut buf = Vec::with_capacity(self.base_bytes as usize + extra);
        for i in 0..self.chunks {
            let stored = env::storage_read(&chunk_key(i)).unwrap_or_else(|| env::panic_str("missing base chunk"));
            buf.extend_from_slice(&decode_chunk(&stored));
        }
        buf
    }

    fn with_gas(&self, mut r: CheckResult) -> CheckResult {
        let g = U64(env::used_gas().as_gas());
        r.gas = Some(g);
        r.gas_hint = Some(g);
        r
    }

    fn verdict(&self, statement_name: &str, delta: &[u8]) -> Verdict {
        let r = self.run_check(statement_name, delta, true);
        if r.ok {
            Verdict::Accepted { axioms: r.axioms, decls: r.decls_checked, gas: U64(env::used_gas().as_gas()) }
        } else {
            Verdict::Rejected { reason: r.reason.unwrap_or_else(|| "malformed".into()) }
        }
    }

    fn run_check(&self, theorem_name: &str, delta: &[u8], instrument: bool) -> CheckResult {
        let mut r = CheckResult {
            ok: false, reason: None, theorem: theorem_name.to_string(), mode: None, proof_theorem: None, statement: None, statement_hash: None,
            decls_checked: 0, new_decls: vec![], axioms: vec![], base_hash: self.base_hash.clone(),
            delta_bytes: delta.len() as u32, gas_read: 0, gas_parse: 0, gas_analyze: 0, gas_kernel: 0, gas: None, gas_hint: None,
        };
        macro_rules! reject { ($($t:tt)*) => {{ r.reason = Some(format!($($t)*)); return r; }} }
        if !self.sealed { reject!("base_not_sealed") }
        if delta.windows(7).any(|w| w == b"{\"meta\"") { reject!("malformed:the delta must not contain a meta line (it continues the base)") }
        if !delta.is_empty() && *delta.last().unwrap() != b'\n' { reject!("malformed:the delta must end with a newline") }
        // Pre-parse scan of the delta only (cheap): redefinitions and forbidden declaration kinds.
        let (ddecls, dnames) = match scan_lines(delta) { Ok(x) => x, Err(e) => reject!("malformed:{e}") };
        for (k, idxs) in &ddecls {
            for n in idxs {
                if self.base_decl_idx.binary_search(n).is_ok() {
                    let base_names: Vec<(u64, String)> = env::storage_read(BASE_NAMES_KEY)
                        .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
                    let nm = base_names.iter().find(|(i, _)| i == n).map(|(_, s)| s.clone()).unwrap_or(format!("#{n}"));
                    reject!("redefines_base_name:{nm}")
                }
            }
            if matches!(k.as_str(), "axiom" | "opaque" | "quot") {
                let nm = idxs.first().map(|n| resolve(&dnames, *n)).unwrap_or_default();
                if nm == "sorryAx" { reject!("sorryAx") }
                reject!("axiom_in_delta:{k} {nm}")
            }
        }
        let g0 = gas_if(instrument);
        let mut buf = self.read_base(delta.len());
        buf.extend_from_slice(delta);
        let g1 = gas_if(instrument);
        r.gas_read = g1 - g0;
        let parsed = nanoda_lib::parser::parse_export_file(std::io::BufReader::new(&buf[..]), cfg(&self.axioms_in_base, false));
        let (ef, skipped): (ExportFile, Vec<String>) = match parsed {
            Ok(x) => x,
            Err(e) => {
                let e = e.to_string();
                if e.contains("duplicate declaration") { reject!("redefines_base_name:{e}") }
                reject!("malformed:{e}")
            }
        };
        let g2 = gas_if(instrument);
        r.gas_parse = g2 - g1;
        if skipped.iter().any(|a| a == "sorryAx") { reject!("sorryAx") }
        if !skipped.is_empty() { reject!("axiom_in_delta:{}", skipped.join(",")) }
        let base = self.base_decls as usize;
        // Claim mode: statement_name is a base Prop definition -> find the delta theorem proving it.
        let target: String = match ef.claim_proof(base, theorem_name) {
            Ok(Some(t)) => { r.mode = Some("claim".into()); t }
            Ok(None) => { r.mode = Some("theorem".into()); theorem_name.to_string() }
            Err(e) => reject!("statement_mismatch:{e}"),
        };
        r.proof_theorem = Some(target.clone());
        let theorem_name = target.as_str();
        let rep = ef.analyze(base, theorem_name, true);
        r.new_decls = rep.new_decls.iter().map(|(k, n)| format!("{k} {n}")).collect();
        for (k, n) in &rep.new_decls {
            if matches!(*k, "axiom" | "opaque" | "quot") { reject!("axiom_in_delta:{k} {n}") }
            if BUILTIN_NAMES.contains(&n.as_str()) { reject!("builtin_name_in_delta:{n}") }
        }
        match (rep.target_index, rep.target_kind) {
            (None, _) => reject!("not_a_theorem:{theorem_name} not found in the delta"),
            (Some(i), _) if i < base => reject!("not_a_theorem:{theorem_name} is a base declaration"),
            (Some(_), Some(k)) if k != "theorem" => reject!("not_a_theorem:{theorem_name} is a {k}"),
            _ => {}
        }
        if !rep.stmt_nonbase_consts.is_empty() {
            reject!("statement_mismatch:statement mentions constants outside the sealed base: {}", rep.stmt_nonbase_consts.join(","))
        }
        if !rep.missing_consts.is_empty() { reject!("malformed:depends on undeclared constants {}", rep.missing_consts.join(",")) }
        if let Some(a) = rep.axioms_used.iter().find(|a| !BASE_AXIOMS.contains(&a.as_str())) { reject!("axiom_in_delta:depends on axiom {a}") }
        r.axioms = rep.axioms_used.clone();
        r.statement_hash = Some(hex::encode(env::sha256(rep.stmt_debug.as_bytes())));
        let g3 = gas_if(instrument);
        r.gas_analyze = g3 - g2;
        // Kernel: type errors panic (the receipt fails with the kernel's message).
        for i in base..ef.declars.len() {
            let (_, d) = ef.declars.get_index(i).unwrap();
            ef.check_declar(d);
        }
        r.decls_checked = (ef.declars.len() - base) as u32;
        r.gas_kernel = gas_if(instrument) - g3;
        r.statement = ef.pp_declar_to_string(theorem_name);
        r.ok = true;
        r
    }
}

#[near]
impl Kernel {
    #[init]
    pub fn init(owner: AccountId) -> Self {
        Self { owner, chunks: 0, base_bytes: 0, stored_bytes: 0, base_hash: None, base_decls: 0, checked_upto: 0, sealed: false, axioms_in_base: vec![], base_decl_idx: vec![] }
    }

    /// Owner only. Raw input (no JSON): `<chunk_idx> [raw|lz4|zlib]\n<payload>`. The decoded
    /// payload must be whole NDJSON lines; chunk 0 starts with the meta line. Returns decoded base bytes so far.
    pub fn load_base_chunk(&mut self) -> u64 {
        self.assert_owner();
        if self.base_hash.is_some() { env::panic_str("base already pinned; no more chunks") }
        let input = env::input().unwrap_or_default();
        let nl = input.iter().position(|b| *b == b'\n').unwrap_or_else(|| env::panic_str("expected <chunk_idx>\\n<bytes>"));
        let head = core::str::from_utf8(&input[..nl]).unwrap_or_else(|_| env::panic_str("bad header"));
        let mut parts = head.split_whitespace();
        let idx: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or_else(|| env::panic_str("bad chunk_idx"));
        let codec = match parts.next().unwrap_or("raw") { "raw" => CODEC_RAW, "lz4" => CODEC_LZ4, "zlib" => CODEC_ZLIB, c => env::panic_str(&format!("unknown codec {c}")) };
        if idx != self.chunks { env::panic_str(&format!("expected chunk_idx {}", self.chunks)) }
        let mut stored = Vec::with_capacity(input.len() - nl);
        stored.push(codec);
        stored.extend_from_slice(&input[nl + 1..]);
        let decoded = decode_chunk(&stored);
        if decoded.last() != Some(&b'\n') { env::panic_str("decoded chunk must end with a newline") }
        env::storage_write(&chunk_key(idx), &stored);
        self.chunks += 1;
        self.base_bytes += decoded.len() as u64;
        self.stored_bytes += stored.len() as u64;
        self.base_bytes
    }

    /// Owner only. Pins the uploaded base: checks its sha256 and declaration count and that it
    /// contains no axiom besides propext / Classical.choice / Quot.sound (parse only, no kernel).
    pub fn seal_base(&mut self, expected_sha256: String, expected_decl_count: u32) -> Status {
        self.assert_owner();
        if self.base_hash.is_some() { env::panic_str("already pinned") }
        let buf = self.read_base(0);
        env::log_str(&format!("courier:read:{}", gas()));
        let h = hex::encode(env::sha256(&buf));
        if h != expected_sha256.to_lowercase() { env::panic_str(&format!("base sha256 mismatch: stored {h}")) }
        let permitted: Vec<String> = BASE_AXIOMS.iter().map(|s| s.to_string()).collect();
        let (ef, _) = nanoda_lib::parser::parse_export_file(std::io::BufReader::new(&buf[..]), cfg(&permitted, true))
            .unwrap_or_else(|e| env::panic_str(&format!("base parse: {e}")));
        env::log_str(&format!("courier:parse:{}", gas()));
        let n = ef.declars.len() as u32;
        if n != expected_decl_count { env::panic_str(&format!("base has {n} declarations, expected {expected_decl_count}")) }
        let rep = ef.analyze(0, "", false);
        self.axioms_in_base = rep.new_decls.iter().filter(|(k, _)| *k == "axiom").map(|(_, n)| n.clone()).collect();
        // Reuse names whose indices and declarations were already validated
        // by the parser; avoid reparsing the whole export solely for this index.
        let mut idx = ef.declaration_name_indices();
        assert_eq!(idx.len(), rep.new_decls.len());
        let mut named: Vec<(u64, String)> = idx.iter().copied()
            .zip(rep.new_decls.iter().map(|(_, n)| n.clone())).collect();
        named.sort_unstable_by_key(|(i, _)| *i);
        idx.sort_unstable();
        idx.dedup();
        drop(ef);
        env::log_str(&format!("courier:names:{}", gas()));
        env::storage_write(BASE_NAMES_KEY, &serde_json::to_vec(&named).unwrap());
        self.base_decl_idx = idx;
        self.base_hash = Some(h);
        self.base_decls = n;
        self.checked_upto = 0;
        self.status()
    }

    /// Kernel-check base declarations [from, to) (insertion order). Anyone may advance the
    /// seal; `from` must equal the saved progress. The base is sealed after the last range.
    pub fn check_base_range(&mut self, from: u32, to: u32) -> RangeResult {
        if self.base_hash.is_none() || self.sealed { env::panic_str("base not pinned or already sealed") }
        if from != self.checked_upto || to <= from || to > self.base_decls { env::panic_str(&format!("bad range; progress is {}", self.checked_upto)) }
        let g0 = gas();
        let buf = self.read_base(0);
        let g1 = gas();
        let (ef, _) = nanoda_lib::parser::parse_export_file(std::io::BufReader::new(&buf[..]), cfg(&self.axioms_in_base, true))
            .unwrap_or_else(|e| env::panic_str(&format!("base parse: {e}")));
        let g2 = gas();
        for i in from..to {
            let (_, d) = ef.declars.get_index(i as usize).unwrap();
            ef.check_declar(d);
        }
        let g3 = gas();
        self.checked_upto = to;
        if to == self.base_decls { self.sealed = true }
        RangeResult { checked_from: from, checked_to: to, base_decls: self.base_decls, sealed: self.sealed, gas_read: g1 - g0, gas_parse: g2 - g1, gas_check: g3 - g2 }
    }

    /// Bounty v2 interface (contracts/README.md). JSON args. Pre-kernel rejections return
    /// `ok:false` + `reason`; kernel type errors panic (the bounty records `kernel_failed`).
    pub fn check_result(&self, theorem_name: String, delta: String) -> CheckResult {
        self.with_gas(self.run_check(&theorem_name, delta.as_bytes(), true))
    }

    /// Same, raw input `<theorem_name>\n<delta bytes>` (no JSON escaping; recommended for the bounty).
    pub fn check_result_raw(&self) -> CheckResult {
        let input = env::input().unwrap_or_default();
        let nl = input.iter().position(|b| *b == b'\n').unwrap_or(input.len());
        let name = core::str::from_utf8(&input[..nl]).unwrap_or("").to_string();
        let delta = if nl < input.len() { &input[nl + 1..] } else { &[][..] };
        self.with_gas(self.run_check(&name, delta, true))
    }

    /// Same as `check_result` but panics with `rejected:<reason>` on any rejection.
    pub fn check(&self, theorem_name: String, delta: String) -> CheckResult {
        let r = self.with_gas(self.run_check(&theorem_name, delta.as_bytes(), true));
        if !r.ok { env::panic_str(&format!("rejected:{}", r.reason.clone().unwrap_or_default())) }
        r
    }

    /// v1 frozen interface (kernel_stub `check_borsh`): Borsh args, JSON Verdict.
    pub fn check_borsh(&self, #[serializer(borsh)] statement_name: String, #[serializer(borsh)] export: Vec<u8>) -> Verdict {
        self.verdict(&statement_name, &export)
    }

    /// View-safe dry run (free RPC view): same checks and reasons, gas fields 0.
    pub fn dry_run(&self, theorem_name: String, delta: String) -> CheckResult {
        self.run_check(&theorem_name, delta.as_bytes(), false)
    }

    /// View: pretty-printed declaration of `theorem_name` in base + delta (no kernel check).
    /// For a claim (base Prop definition) this prints the claim with its body, which is the
    /// statement a bounty is about. Cheap alternative for exact comparison: `statement_hash`
    /// in `check_result` (sha256 of nanoda's debug print of the theorem type).
    pub fn statement_of(&self, theorem_name: String, delta: String) -> String {
        if self.base_hash.is_none() { env::panic_str("base not pinned") }
        let mut buf = self.read_base(delta.len());
        buf.extend_from_slice(delta.as_bytes());
        let (ef, _) = nanoda_lib::parser::parse_export_file(std::io::BufReader::new(&buf[..]), cfg(&self.axioms_in_base, false))
            .unwrap_or_else(|e| env::panic_str(&format!("malformed:{e}")));
        ef.pp_declar_to_string(&theorem_name).unwrap_or_else(|| env::panic_str("not_found"))
    }

    pub fn kernel_name(&self) -> String { KERNEL_NAME.to_string() }

    pub fn status(&self) -> Status {
        Status { owner: self.owner.clone(), chunks: self.chunks, base_bytes: self.base_bytes, stored_bytes: self.stored_bytes, base_hash: self.base_hash.clone(),
            base_decls: self.base_decls, checked_upto: self.checked_upto, sealed: self.sealed, axioms_in_base: self.axioms_in_base.clone() }
    }
}

/// The contract's own `run_check` on the sealed shelf, natively: `cargo test --release`.
#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, Gas};

    const CLAIM: &str = "Wallet.Claim.AllowedReceiversOnly";

    fn file(p: &str) -> Vec<u8> {
        let p = format!("{}/../../{p}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read(&p).unwrap_or_else(|e| panic!("{p}: {e}"))
    }

    /// One call: fresh gas, the given input, the storage kept.
    fn call(input: Vec<u8>) {
        let mut c = VMContextBuilder::new().predecessor_account_id("keeper.test.near".parse().unwrap()).prepaid_gas(Gas::from_tgas(1000)).build();
        c.input = input.into();
        testing_env!(c);
    }

    /// The shelf as the chain holds it: uploaded in chunks, pinned by hash, every declaration type-checked.
    fn sealed() -> Kernel {
        call(vec![]);
        let mut k = Kernel::init("keeper.test.near".parse().unwrap());
        let m: serde_json::Value = serde_json::from_slice(&file("shelf/wallet-v5/manifest.json")).unwrap();
        for c in m["chunks"].as_array().unwrap() {
            call(file(&format!("shelf/wallet-v5/{}", c.as_str().unwrap())));
            k.load_base_chunk();
        }
        let n = m["base_decls"].as_u64().unwrap() as u32;
        call(vec![]);
        k.seal_base(m["base_sha256"].as_str().unwrap().to_string(), n);
        call(vec![]);
        assert!(k.check_base_range(0, n).sealed);
        k
    }

    /// "accepted", "refused:<reason>" (before the kernel) or "kernel_failed" (the kernel panics; on-chain the receipt fails).
    fn outcome(k: &Kernel, delta: &str) -> String {
        call(vec![]);
        let delta = file(delta);
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| k.run_check(CLAIM, &delta, false))) {
            Ok(r) if r.ok => "accepted".into(),
            Ok(r) => format!("refused:{}", r.reason.unwrap_or_default()),
            Err(_) => "kernel_failed".into(),
        }
    }

    /// A proof of `False` from a forged recursor rule (Lean Kernel Arena, bugs/rec-rule-proof-irrel and
    /// -nested), stated as a proof of a bounty claim. The delta has no axiom and redefines nothing, so
    /// the scans before the kernel pass: only the kernel's check of the rule can refuse it.
    /// nanoda_lib 0.4.31 accepted both.
    #[test]
    fn forged_recursor_rule_is_refused() {
        let k = sealed();
        let got: Vec<(&str, String)> = [
            "evidence/agent/AllowedReceiversOnly-opus/delta.ndjson",   // an honest proof
            "cheats/deltas/illTyped.delta.ndjson",                     // an ill-typed proof term
            "cheats/deltas/forgedRec.delta.ndjson",
            "cheats/deltas/forgedRecNested.delta.ndjson",
        ].into_iter().map(|d| (d, outcome(&k, d))).collect();
        let want = ["accepted", "kernel_failed", "kernel_failed", "kernel_failed"];
        assert_eq!(got.iter().map(|(_, o)| o.as_str()).collect::<Vec<_>>(), want, "{got:#?}");
    }

    /// A delta that declares a name which the type checker computes by itself and which the shelf lacks
    /// (cheats/deltas/builtinGcd and builtinString, made by tools/forge_cheats.py). Both are proofs of `False`
    /// that the bare type checker accepts, so only the contract's rule can refuse them.
    /// The kernel contract of 12 November 2026 accepted both.
    #[test]
    fn builtin_name_in_delta_is_refused() {
        let k = sealed();
        assert_eq!(outcome(&k, "cheats/deltas/builtinGcd.delta.ndjson"), "refused:builtin_name_in_delta:Nat.gcd");
        assert_eq!(outcome(&k, "cheats/deltas/builtinString.delta.ndjson"), "refused:builtin_name_in_delta:String");
        // The list is the vendored one: every name that `mk_name_cache` looks up, and no other.
        let src = String::from_utf8(file("contracts/kernel/vendor/nanoda_lib/src/util.rs")).unwrap();
        let body = src.split("fn mk_name_cache").nth(1).unwrap().split("\n    }\n").next().unwrap();
        let mut vendored: Vec<&str> = body.split("find_name(\"").skip(1).map(|s| s.split('"').next().unwrap()).collect();
        let mut ours = BUILTIN_NAMES.to_vec();
        vendored.sort_unstable();
        ours.sort_unstable();
        assert_eq!(vendored, ours);
    }
}
