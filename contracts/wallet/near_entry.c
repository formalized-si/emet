/* near_entry.c — NEAR ABI shim for the Lean-compiled agent wallet (Proof Courier).
 *
 * Every policy decision (parse request, check caps/allowlist, new state,
 * tightening, policy JSON) is made by Lean code (Policy.Core, Policy.Wire,
 * Wallet.Entry), compiled by `lake build` and linked unchanged. This file only
 * moves bytes between NEAR host functions and those Lean exports.
 *
 * Methods (JSON args; amounts/caps are decimal strings in units, 1 unit = 10^18 yocto = 1 µNEAR):
 *   init       {"owner":"<acc>","agent":"<acc>"?,"policy":{<policy JSON>},"board":"<acc>"?}   once; caller = the
 *                wallet itself, or the account directly above it (a factory that creates <name>.<factory> and calls
 *                init in the same transaction; nobody else can create a sub-account of the factory)
 *   pay        {"to":"<acc>","amount":"<units>"}
 *                caller not owner/agent -> {"verdict":"DENY_CALLER"}        (normal return, event, no storage write)
 *                wallet frozen          -> {"verdict":"FROZEN"}             (the same; Lean is not asked)
 *                Lean verdict OK        -> state written, transfer amount*10^18 yocto, {"verdict":"OK",...}
 *                Lean verdict DENY_*    -> {"verdict":"DENY_...",...}        (normal return, event, no storage write)
 *                malformed input        -> panic ERR_INPUT / ERR_INPUT_TOO_LARGE (receipt fails)
 *   set_policy {"policy":{<policy JSON>}}  non-owner -> {"verdict":"DENY_CALLER"};
 *                not a Lean `tighten` of the current policy -> {"verdict":"REJECTED_NOT_TIGHTER"}; else {"verdict":"OK"}
 *   set_agent  {"agent":"<acc>"}           non-owner -> {"verdict":"DENY_CALLER"}; else {"verdict":"OK"}
 *   freeze     {}                          caller not the board given at init -> panic ERR_FREEZE_NOT_BOARD; else the
 *                wallet is frozen for good: there is no unfreeze
 *   withdraw   {"amount":"<units>"}        non-owner -> {"verdict":"DENY_CALLER"}; not frozen -> {"verdict":"NOT_FROZEN"};
 *                else transfer amount*10^18 yocto to the owner, {"verdict":"OK",...}
 *   views: get_state, get_policy (with "board" and "frozen"), get_code_meta ("rules": "v1", or "v2" when built with -DWALLET_RULES_V2)
 * Storage: "s" state (32 B), "p" policy bytes, "o" owner, "a" agent, "b" board, "f" frozen. Denials never write storage.
 *
 * Frozen: the board freezes a wallet when a claim about this wallet code is refuted (a counterexample the Lean
 * kernel accepted on-chain). The flag is checked here, in front of the Lean decision function: a frozen wallet
 * does not run `step` at all, so nothing the Lean theorems say about `step` changes. The owner's money is the
 * owner's: `withdraw` sends it to the owner's account, and only there.
 */
#include <lean/lean.h>

#define IMP(name) __attribute__((import_module("env"), import_name(#name)))
IMP(input)                         extern void     near_input(uint64_t reg);
IMP(register_len)                  extern uint64_t near_register_len(uint64_t reg);
IMP(read_register)                 extern void     near_read_register(uint64_t reg, uint64_t ptr);
IMP(value_return)                  extern void     near_value_return(uint64_t len, uint64_t ptr);
IMP(panic_utf8)                    extern void     near_panic_utf8(uint64_t len, uint64_t ptr);
IMP(log_utf8)                      extern void     near_log_utf8(uint64_t len, uint64_t ptr);
IMP(storage_read)                  extern uint64_t near_storage_read(uint64_t klen, uint64_t kptr, uint64_t reg);
IMP(storage_write)                 extern uint64_t near_storage_write(uint64_t klen, uint64_t kptr, uint64_t vlen, uint64_t vptr, uint64_t reg);
IMP(block_timestamp)               extern uint64_t near_block_timestamp(void);
IMP(predecessor_account_id)        extern void     near_predecessor_account_id(uint64_t reg);
IMP(current_account_id)            extern void     near_current_account_id(uint64_t reg);
IMP(promise_batch_create)          extern uint64_t near_promise_batch_create(uint64_t len, uint64_t ptr);
IMP(promise_batch_action_transfer) extern void     near_promise_batch_action_transfer(uint64_t idx, uint64_t amount_ptr);

/* Lean exports (Policy/Wire.lean, Wallet/Entry.lean); ByteArray args are owned. */
/* The v2 wallet (Policy.CoreV2: the day window carries the old window's spending) is this same shim
 * built with `lean-near build --define WALLET_RULES_V2`; only the decision export differs. */
#ifdef WALLET_RULES_V2
#define near_policy_decide near_policy_decide_v2
#define WALLET_RULES "v2"
#else
#define WALLET_RULES "v1"
#endif
extern lean_object *near_policy_decide(lean_object *policy, lean_object *state, lean_object *input, uint64_t now);
extern uint8_t      near_policy_validate(lean_object *policy);
extern uint8_t      near_policy_tighten(lean_object *old_, lean_object *new_);
extern lean_object *near_policy_from_json(lean_object *json);
extern lean_object *near_policy_init_state(uint64_t now);
extern lean_object *near_wallet_parsed_request(lean_object *input);
extern lean_object *initialize_wallet_Wallet_Entry(uint8_t builtin);
extern void lean_io_mark_end_initialization(void);

/* Baked in by lean-near build (-D...). */
#ifndef LEAN_SRC_SHA256
#define LEAN_SRC_SHA256 "unknown"
#endif
#ifndef LEAN_TOOLCHAIN
#define LEAN_TOOLCHAIN "unknown"
#endif
#ifndef LEAN_NEAR_RUNTIME
#define LEAN_NEAR_RUNTIME "unknown"
#endif
#ifndef LEAN_NEAR_VERSION
#define LEAN_NEAR_VERSION "unknown"
#endif
#ifndef SHIM_SHA256
#define SHIM_SHA256 "unknown"
#endif

void *memcpy(void *, const void *, size_t);
#define MAX_PAY_INPUT 1024u
#define MAX_POLICY_INPUT 8192u
#define U(p) ((uint64_t)(uintptr_t)(p))

static size_t slen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
static LEAN_NORETURN void fail(const char *m) { near_panic_utf8(slen(m), U(m)); __builtin_unreachable(); }
static int beq(const uint8_t *a, size_t an, const uint8_t *b, size_t bn) {
  if (an != bn) return 0;
  for (size_t i = 0; i < an; i++) if (a[i] != b[i]) return 0;
  return 1;
}

/* ---------- output buffer ---------- */
static char ob[4096]; static size_t on;
static void out_reset(void) { on = 0; }
static void out_raw(const void *p, size_t n) { if (on + n > sizeof ob) fail("ERR_OUTPUT_TOO_LARGE"); memcpy(ob + on, p, n); on += n; }
static void out_s(const char *s) { out_raw(s, slen(s)); }
static void out_u64(uint64_t v) { char t[21]; int i = 20; t[i] = 0; do { t[--i] = (char)('0' + v % 10); v /= 10; } while (v); out_s(t + i); }
static void out_q(const uint8_t *p, size_t n) { out_s("\""); out_raw(p, n); out_s("\""); }   /* only for validated [a-z0-9._-] bytes */
static void out_qu64(uint64_t v) { out_s("\""); out_u64(v); out_s("\""); }
/* yocto = units * 10^18 exactly, so its decimal is the units' decimal followed by 18 zeros */
static void out_qyocto(uint64_t units) { out_s("\""); out_u64(units); if (units) out_s("000000000000000000"); out_s("\""); }

/* ---------- registers / storage ---------- */
static uint64_t reg_into(uint64_t reg, uint8_t *dst, uint64_t cap, const char *too_big) {
  uint64_t n = near_register_len(reg);
  if (n == UINT64_MAX) return UINT64_MAX;
  if (n > cap) fail(too_big);
  near_read_register(reg, U(dst));
  return n;
}
static uint8_t in_buf[MAX_POLICY_INPUT]; static uint64_t in_len;
static void read_input(uint64_t cap) { near_input(0); in_len = reg_into(0, in_buf, cap, "ERR_INPUT_TOO_LARGE"); if (in_len == UINT64_MAX) in_len = 0; }
static uint64_t sread(const char *key, uint8_t *dst, uint64_t cap) {
  if (near_storage_read(slen(key), U(key), 1) == 0) return UINT64_MAX;
  return reg_into(1, dst, cap, "ERR_STORAGE_VALUE_TOO_LARGE");
}
static void swrite(const char *key, const uint8_t *v, uint64_t n) { near_storage_write(slen(key), U(key), n, U(v), 2); }
static uint8_t pred[64]; static uint64_t pred_len;
static uint8_t self_id[64]; static uint64_t self_len;
static void load_pred(void) { near_predecessor_account_id(3); pred_len = reg_into(3, pred, sizeof pred, "ERR_ACCOUNT_ID"); }
static void load_self(void) { near_current_account_id(3); self_len = reg_into(3, self_id, sizeof self_id, "ERR_ACCOUNT_ID"); }

/* ---------- Lean bridge ---------- */
static void init_lean(void) {
  lean_object *r = initialize_wallet_Wallet_Entry(1);
  if (lean_io_result_is_error(r)) fail("ERR_LEAN_INIT");
  lean_dec_ref(r);
  lean_io_mark_end_initialization();
}
static lean_object *ba(const uint8_t *p, size_t n) {
  lean_object *a = lean_alloc_sarray(1, n, n);
  memcpy(lean_sarray_cptr(a), p, n);
  return a;
}
/* copy a Lean ByteArray result out, then release it */
static size_t ba_out(lean_object *a, uint8_t *dst, size_t cap) {
  size_t n = lean_sarray_size(a);
  if (n > cap) fail("ERR_LEAN_RESULT_TOO_LARGE");
  memcpy(dst, lean_sarray_cptr(a), n);
  lean_dec(a);
  return n;
}

/* ---------- account ids and the JSON envelope (init / set_policy only) ---------- */
static int valid_acc(const uint8_t *p, size_t n) {
  if (n < 2 || n > 64) return 0;
  for (size_t i = 0; i < n; i++) {
    uint8_t c = p[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) return 0;
  }
  return 1;
}
typedef struct { const uint8_t *k; size_t kn; const uint8_t *v; size_t vn; int is_obj; } member_t;
static size_t ws(const uint8_t *s, size_t i, size_t n) { while (i < n && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++; return i; }
/* string without escapes starting at s[i]=='"'; returns index after closing quote */
static size_t jstr(const uint8_t *s, size_t i, size_t n, size_t *b, size_t *e) {
  if (i >= n || s[i] != '"') fail("ERR_ARGS_JSON");
  size_t j = i + 1;
  while (j < n && s[j] != '"') { if (s[j] == '\\' || s[j] < 0x20) fail("ERR_ARGS_JSON"); j++; }
  if (j >= n) fail("ERR_ARGS_JSON");
  *b = i + 1; *e = j; return j + 1;
}
/* balanced object starting at s[i]=='{' (strings without escapes); returns index after '}' */
static size_t jobj(const uint8_t *s, size_t i, size_t n) {
  int depth = 0;
  for (size_t j = i; j < n; j++) {
    uint8_t c = s[j];
    if (c == '"') { size_t b, e; j = jstr(s, j, n, &b, &e) - 1; continue; }
    if (c == '{' || c == '[') depth++;
    else if (c == '}' || c == ']') { if (--depth == 0) { if (c != '}') fail("ERR_ARGS_JSON"); return j + 1; } if (depth < 0) fail("ERR_ARGS_JSON"); }
  }
  fail("ERR_ARGS_JSON");
}
/* flat top-level object of string/object members; rejects duplicates and trailing bytes */
static int parse_envelope(const uint8_t *s, size_t n, member_t *m, int maxm) {
  size_t i = ws(s, 0, n); int cnt = 0;
  if (i >= n || s[i] != '{') fail("ERR_ARGS_JSON");
  i = ws(s, i + 1, n);
  if (i < n && s[i] == '}') { i++; goto done; }
  for (;;) {
    if (cnt == maxm) fail("ERR_ARGS_JSON");
    size_t kb, ke; i = jstr(s, i, n, &kb, &ke);
    i = ws(s, i, n); if (i >= n || s[i] != ':') fail("ERR_ARGS_JSON"); i = ws(s, i + 1, n);
    member_t *x = &m[cnt]; x->k = s + kb; x->kn = ke - kb;
    for (int t = 0; t < cnt; t++) if (beq(m[t].k, m[t].kn, x->k, x->kn)) fail("ERR_ARGS_DUPLICATE_KEY");
    if (i < n && s[i] == '"') { size_t vb, ve; i = jstr(s, i, n, &vb, &ve); x->v = s + vb; x->vn = ve - vb; x->is_obj = 0; }
    else if (i < n && s[i] == '{') { size_t vb = i; i = jobj(s, i, n); x->v = s + vb; x->vn = i - vb; x->is_obj = 1; }
    else fail("ERR_ARGS_JSON");
    cnt++;
    i = ws(s, i, n);
    if (i < n && s[i] == ',') { i = ws(s, i + 1, n); continue; }
    if (i < n && s[i] == '}') { i++; break; }
    fail("ERR_ARGS_JSON");
  }
done:
  if (ws(s, i, n) != n) fail("ERR_ARGS_JSON");
  return cnt;
}
static const member_t *find(const member_t *m, int cnt, const char *key) {
  for (int i = 0; i < cnt; i++) if (beq(m[i].k, m[i].kn, (const uint8_t *)key, slen(key))) return &m[i];
  return 0;
}
static void only_keys(const member_t *m, int cnt, const char *a, const char *b, const char *c) {
  for (int i = 0; i < cnt; i++) {
    int ok = (a && beq(m[i].k, m[i].kn, (const uint8_t *)a, slen(a))) || (b && beq(m[i].k, m[i].kn, (const uint8_t *)b, slen(b))) ||
             (c && beq(m[i].k, m[i].kn, (const uint8_t *)c, slen(c)));
    if (!ok) fail("ERR_ARGS_UNKNOWN_KEY");
  }
}

/* ---------- policy / state bytes -> JSON (views and events) ---------- */
static uint64_t le64(const uint8_t *p) { uint64_t v = 0; for (int i = 7; i >= 0; i--) v = (v << 8) | p[i]; return v; }
static uint8_t pol[MAX_POLICY_INPUT]; static uint64_t pol_len;
static uint8_t st[32];
static void out_policy_fields(const uint8_t *p, uint64_t n) {
  if (n < 32) fail("ERR_POLICY_STORAGE");
  out_s("\"budget_total\":"); out_qu64(le64(p)); out_s(",\"per_tx_cap\":"); out_qu64(le64(p + 8));
  out_s(",\"per_day_cap\":"); out_qu64(le64(p + 16)); out_s(",\"day_ns\":"); out_qu64(le64(p + 24));
  out_s(",\"allowed\":[");
  for (uint64_t i = 32, k = 0; i < n; k++) {
    uint64_t l = p[i];
    if (i + 1 + l > n || !valid_acc(p + i + 1, l)) fail("ERR_POLICY_STORAGE");
    if (k) out_s(",");
    out_q(p + i + 1, l); i += 1 + l;
  }
  out_s("]");
}
static void out_state_fields(const uint8_t *s) {
  out_s("\"spent_total\":"); out_qu64(le64(s)); out_s(",\"spent_today\":"); out_qu64(le64(s + 8));
  out_s(",\"day_start\":"); out_qu64(le64(s + 16)); out_s(",\"nonce\":"); out_qu64(le64(s + 24));
}
static void event_begin(const char *event) {
  out_reset();
  out_s("EVENT_JSON:{\"standard\":\"proof-courier-wallet\",\"version\":\"1.0.0\",\"event\":\""); out_s(event); out_s("\",\"data\":[{");
}
static void event_end(void) { out_s("}]}"); near_log_utf8(on, U(ob)); }
static void load_policy_state(void) {
  pol_len = sread("p", pol, sizeof pol);
  if (pol_len == UINT64_MAX) fail("ERR_NOT_INITIALIZED");
  if (sread("s", st, sizeof st) != 32) fail("ERR_STATE_STORAGE");
}

/* ---------- init ---------- */
/* p is the direct parent of c: c = "<label>.<p>" with no '.' in <label>. */
static int is_parent(const uint8_t *p, size_t pn, const uint8_t *c, size_t cn) {
  if (cn < pn + 2 || c[cn - pn - 1] != '.' || !beq(c + cn - pn, pn, p, pn)) return 0;
  for (size_t i = 0; i < cn - pn - 1; i++) if (c[i] == '.') return 0;
  return 1;
}
__attribute__((export_name("init"))) void m_init(void) {
  init_lean();
  load_self(); load_pred();
  if (!beq(pred, pred_len, self_id, self_len) && !is_parent(pred, pred_len, self_id, self_len)) fail("ERR_INIT_NOT_SELF_OR_PARENT");
  uint8_t tmp[64];
  if (sread("o", tmp, sizeof tmp) != UINT64_MAX) fail("ERR_ALREADY_INITIALIZED");
  read_input(MAX_POLICY_INPUT);
  member_t m[4]; int cnt = parse_envelope(in_buf, in_len, m, 4);
  const member_t *o = find(m, cnt, "owner"), *a = find(m, cnt, "agent"), *p = find(m, cnt, "policy"), *b = find(m, cnt, "board");
  if (cnt != 2 + !!a + !!b) fail("ERR_ARGS_UNKNOWN_KEY");
  if (!o || o->is_obj || !valid_acc(o->v, o->vn)) fail("ERR_OWNER");
  if (a && (a->is_obj || !valid_acc(a->v, a->vn))) fail("ERR_AGENT");
  if (b && (b->is_obj || !valid_acc(b->v, b->vn))) fail("ERR_BOARD");
  if (!p || !p->is_obj) fail("ERR_POLICY_JSON");
  pol_len = ba_out(near_policy_from_json(ba(p->v, p->vn)), pol, sizeof pol);
  if (pol_len == 0) fail("ERR_POLICY_JSON");
  if (near_policy_validate(ba(pol, pol_len)) != 1) fail("ERR_POLICY_INVALID");
  if (ba_out(near_policy_init_state(near_block_timestamp()), st, sizeof st) != 32) fail("ERR_STATE_INIT");
  swrite("p", pol, pol_len); swrite("s", st, 32); swrite("o", o->v, o->vn);
  if (a) swrite("a", a->v, a->vn);
  if (b) swrite("b", b->v, b->vn);
  event_begin("wallet_policy");
  out_s("\"wallet\":"); out_q(self_id, self_len); out_s(",\"by\":"); out_q(pred, pred_len); out_s(",\"action\":\"init\",\"policy\":{");
  out_policy_fields(pol, pol_len); out_s("},\"lean_sha256\":\"" LEAN_SRC_SHA256 "\"");
  event_end();
  static const char r[] = "{\"ok\":true}"; near_value_return(sizeof r - 1, U(r));
}

/* ---------- pay ---------- */
static const char *verdict_name(uint8_t tag) {
  switch (tag) {
    case 'A': return "allow"; case 'B': return "denyBudget"; case 'T': return "denyPerTx";
    case 'D': return "denyDaily"; case 'R': return "denyReceiver"; case 'O': return "denyOverflow";
  }
  return 0;
}
/* units * 10^18 as u128 little-endian, with 32-bit limbs (no compiler-rt) */
static void yocto_le(uint64_t units, uint8_t out[16]) {
  const uint64_t F = 1000000000000000000ull;
  uint64_t a0 = units & 0xffffffffu, a1 = units >> 32, b0 = F & 0xffffffffu, b1 = F >> 32;
  uint64_t p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
  uint64_t mid = (p00 >> 32) + (p01 & 0xffffffffu) + (p10 & 0xffffffffu);
  uint64_t lo = (p00 & 0xffffffffu) | (mid << 32);
  uint64_t hi = p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32);
  for (int i = 0; i < 8; i++) { out[i] = (uint8_t)(lo >> (8 * i)); out[8 + i] = (uint8_t)(hi >> (8 * i)); }
}
static const char *code_of(const uint8_t *dec, size_t dn, size_t *len) { *len = dn - 33; return (const char *)dec + 33; }
static int is_owner(void) {
  uint8_t own[64]; uint64_t n = sread("o", own, sizeof own);
  if (n == UINT64_MAX) fail("ERR_NOT_INITIALIZED");
  return beq(pred, pred_len, own, n);
}
static int is_agent(void) {
  uint8_t agt[64]; uint64_t n = sread("a", agt, sizeof agt);
  return n != UINT64_MAX && beq(pred, pred_len, agt, n);
}
static void ret_simple(const char *verdict) {
  out_reset(); out_s("{\"verdict\":\""); out_s(verdict); out_s("\"}"); near_value_return(on, U(ob));
}
static int is_frozen(void) { uint8_t f[1]; return sread("f", f, sizeof f) != UINT64_MAX; }
__attribute__((export_name("pay"))) void m_pay(void) {
  init_lean();
  read_input(MAX_PAY_INPUT);
  load_pred(); load_self();
  /* the request exactly as Lean parses it (theorem Wallet.Entry.decide_allow_parsed) */
  uint8_t pr[8 + 64]; size_t pn = ba_out(near_wallet_parsed_request(ba(in_buf, in_len)), pr, sizeof pr);
  if (!is_owner() && !is_agent()) {                 /* caller gate: no storage write, event only */
    event_begin("wallet_attempt");
    out_s("\"wallet\":"); out_q(self_id, self_len); out_s(",\"agent\":"); out_q(pred, pred_len);
    if (pn >= 10) { out_s(",\"to\":"); out_q(pr + 8, pn - 8); out_s(",\"amount_yocto\":"); out_qyocto(le64(pr)); }
    else out_s(",\"to\":null,\"amount_yocto\":null");
    out_s(",\"verdict\":\"denyCaller\",\"key_layer_block\":false,\"note\":\"DENY_CALLER\"");
    event_end();
    ret_simple("DENY_CALLER");
    return;
  }
  if (is_frozen()) {                                 /* frozen gate, in front of Lean: no storage write, event only */
    event_begin("wallet_attempt");
    out_s("\"wallet\":"); out_q(self_id, self_len); out_s(",\"agent\":"); out_q(pred, pred_len);
    if (pn >= 10) { out_s(",\"to\":"); out_q(pr + 8, pn - 8); out_s(",\"amount_yocto\":"); out_qyocto(le64(pr)); }
    else out_s(",\"to\":null,\"amount_yocto\":null");
    out_s(",\"verdict\":\"frozen\",\"key_layer_block\":false,\"note\":\"FROZEN\"");
    event_end();
    ret_simple("FROZEN");
    return;
  }
  load_policy_state();
  uint8_t dec[64];
  size_t dn = ba_out(near_policy_decide(ba(pol, pol_len), ba(st, 32), ba(in_buf, in_len), near_block_timestamp()), dec, sizeof dec - 1);
  if (dn == 0) fail("ERR_LEAN_EMPTY");
  if (dec[0] == 'E') { dec[dn] = 0; fail((const char *)dec + 1); }       /* ERR_POLICY / ERR_STATE / ERR_INPUT */
  const char *verdict = verdict_name(dec[0]);
  if (!verdict || dn < 34) fail("ERR_LEAN_RESULT");
  if (pn < 8 + 2) fail("ERR_LEAN_PARSE_MISMATCH");
  uint64_t units = le64(pr); const uint8_t *to = pr + 8; size_t to_len = pn - 8;
  size_t cl; const char *code = code_of(dec, dn, &cl);
  if (dec[0] == 'A') {
    swrite("s", dec + 1, 32);
    uint8_t amt[16]; yocto_le(units, amt);
    uint64_t idx = near_promise_batch_create(to_len, U(to));
    near_promise_batch_action_transfer(idx, U(amt));
  }
  event_begin("wallet_attempt");
  out_s("\"wallet\":"); out_q(self_id, self_len); out_s(",\"agent\":"); out_q(pred, pred_len);
  out_s(",\"to\":"); out_q(to, to_len); out_s(",\"amount_yocto\":"); out_qyocto(units);
  out_s(",\"verdict\":\""); out_s(verdict); out_s("\",\"key_layer_block\":false,\"note\":\""); out_raw(code, cl); out_s("\"");
  event_end();
  out_reset();
  out_s("{\"verdict\":\""); out_raw(code, cl);
  out_s("\",\"to\":"); out_q(to, to_len); out_s(",\"amount\":"); out_qu64(units); out_s(",\"amount_yocto\":"); out_qyocto(units);
  out_s(",\"transferred\":"); out_s(dec[0] == 'A' ? "true" : "false"); out_s(",\"state\":{");
  out_state_fields(dec[0] == 'A' ? dec + 1 : st); out_s("}}");
  near_value_return(on, U(ob));
}

/* ---------- set_policy ---------- */
__attribute__((export_name("set_policy"))) void m_set_policy(void) {
  init_lean();
  read_input(MAX_POLICY_INPUT);
  load_pred(); load_self();
  if (!is_owner()) { ret_simple("DENY_CALLER"); return; }
  member_t m[1]; int cnt = parse_envelope(in_buf, in_len, m, 1);
  only_keys(m, cnt, "policy", 0, 0);
  const member_t *p = find(m, cnt, "policy");
  if (!p || !p->is_obj) fail("ERR_POLICY_JSON");
  static uint8_t np[MAX_POLICY_INPUT];
  uint64_t np_len = ba_out(near_policy_from_json(ba(p->v, p->vn)), np, sizeof np);
  if (np_len == 0) fail("ERR_POLICY_JSON");
  load_policy_state();
  uint8_t t = near_policy_tighten(ba(pol, pol_len), ba(np, np_len));   /* Lean `tighten`, see tighten_sound */
  if (t == 2) fail("ERR_POLICY_DECODE");
  if (t != 1) {                                                         /* no storage write; event only */
    event_begin("wallet_policy");
    out_s("\"wallet\":"); out_q(self_id, self_len); out_s(",\"by\":"); out_q(pred, pred_len);
    out_s(",\"action\":\"set_policy_rejected\",\"verdict\":\"REJECTED_NOT_TIGHTER\",\"proposed_policy\":{");
    out_policy_fields(np, np_len); out_s("},\"lean_sha256\":\"" LEAN_SRC_SHA256 "\"");
    event_end();
    ret_simple("REJECTED_NOT_TIGHTER"); return;
  }
  swrite("p", np, np_len);
  event_begin("wallet_policy");
  out_s("\"wallet\":"); out_q(self_id, self_len); out_s(",\"by\":"); out_q(pred, pred_len); out_s(",\"action\":\"set_policy\",\"policy\":{");
  out_policy_fields(np, np_len); out_s("},\"lean_sha256\":\"" LEAN_SRC_SHA256 "\"");
  event_end();
  ret_simple("OK");
}

/* ---------- set_agent ---------- */
__attribute__((export_name("set_agent"))) void m_set_agent(void) {
  read_input(MAX_PAY_INPUT);
  load_pred(); load_self();
  if (!is_owner()) { ret_simple("DENY_CALLER"); return; }
  member_t m[1]; int cnt = parse_envelope(in_buf, in_len, m, 1);
  only_keys(m, cnt, "agent", 0, 0);
  const member_t *a = find(m, cnt, "agent");
  if (!a || a->is_obj || !valid_acc(a->v, a->vn)) fail("ERR_AGENT");
  swrite("a", a->v, a->vn);
  event_begin("wallet_policy");
  out_s("\"wallet\":"); out_q(self_id, self_len); out_s(",\"by\":"); out_q(pred, pred_len);
  out_s(",\"action\":\"set_agent\",\"agent\":"); out_q(a->v, a->vn);
  event_end();
  ret_simple("OK");
}

/* ---------- freeze / withdraw ---------- */
/* Only the board named at init may freeze; a wallet without a board cannot be frozen. No method clears "f". */
__attribute__((export_name("freeze"))) void m_freeze(void) {
  load_pred(); load_self();
  uint8_t brd[64]; uint64_t n = sread("b", brd, sizeof brd);
  if (n == UINT64_MAX || !beq(pred, pred_len, brd, n)) fail("ERR_FREEZE_NOT_BOARD");
  swrite("f", (const uint8_t *)"1", 1);
  event_begin("wallet_frozen");
  out_s("\"wallet\":"); out_q(self_id, self_len); out_s(",\"by\":"); out_q(pred, pred_len);
  event_end();
  static const char r[] = "{\"frozen\":true}"; near_value_return(sizeof r - 1, U(r));
}
/* The owner takes money out of a frozen wallet, to the owner's own account. Not available while the wallet
 * is alive: then every payment is a Lean decision. */
__attribute__((export_name("withdraw"))) void m_withdraw(void) {
  read_input(MAX_PAY_INPUT);
  load_pred(); load_self();
  if (!is_owner()) { ret_simple("DENY_CALLER"); return; }
  if (!is_frozen()) { ret_simple("NOT_FROZEN"); return; }
  member_t m[1]; int cnt = parse_envelope(in_buf, in_len, m, 1);
  only_keys(m, cnt, "amount", 0, 0);
  const member_t *a = find(m, cnt, "amount");
  if (!a || a->is_obj || a->vn == 0 || a->vn > 20) fail("ERR_AMOUNT");
  uint64_t units = 0;
  for (size_t i = 0; i < a->vn; i++) {
    uint8_t c = a->v[i];
    if (c < '0' || c > '9' || units > (UINT64_MAX - (uint64_t)(c - '0')) / 10) fail("ERR_AMOUNT");
    units = units * 10 + (uint64_t)(c - '0');
  }
  uint8_t amt[16]; yocto_le(units, amt);
  uint64_t idx = near_promise_batch_create(pred_len, U(pred));
  near_promise_batch_action_transfer(idx, U(amt));
  event_begin("wallet_withdraw");
  out_s("\"wallet\":"); out_q(self_id, self_len); out_s(",\"owner\":"); out_q(pred, pred_len); out_s(",\"amount_yocto\":"); out_qyocto(units);
  event_end();
  out_reset(); out_s("{\"verdict\":\"OK\",\"amount\":"); out_qu64(units); out_s(",\"amount_yocto\":"); out_qyocto(units); out_s("}");
  near_value_return(on, U(ob));
}

/* ---------- views ---------- */
__attribute__((export_name("get_state"))) void v_get_state(void) {
  if (sread("s", st, sizeof st) != 32) fail("ERR_NOT_INITIALIZED");
  out_reset(); out_s("{"); out_state_fields(st); out_s(",\"unit_yocto\":\"1000000000000000000\"}");
  near_value_return(on, U(ob));
}
__attribute__((export_name("get_policy"))) void v_get_policy(void) {
  pol_len = sread("p", pol, sizeof pol);
  if (pol_len == UINT64_MAX) fail("ERR_NOT_INITIALIZED");
  uint8_t own[64], agt[64], brd[64];
  uint64_t own_len = sread("o", own, sizeof own), agt_len = sread("a", agt, sizeof agt), brd_len = sread("b", brd, sizeof brd);
  out_reset(); out_s("{"); out_policy_fields(pol, pol_len);
  out_s(",\"owner\":"); out_q(own, own_len == UINT64_MAX ? 0 : own_len);
  out_s(",\"agent\":"); if (agt_len == UINT64_MAX) out_s("null"); else out_q(agt, agt_len);
  out_s(",\"board\":"); if (brd_len == UINT64_MAX) out_s("null"); else out_q(brd, brd_len);
  out_s(",\"frozen\":"); out_s(is_frozen() ? "true" : "false");
  out_s(",\"unit_yocto\":\"1000000000000000000\"}");
  near_value_return(on, U(ob));
}
__attribute__((export_name("get_code_meta"))) void v_get_code_meta(void) {
  static const char r[] = "{\"rules\":\"" WALLET_RULES "\",\"lean_src_sha256\":\"" LEAN_SRC_SHA256 "\",\"lean_toolchain\":\"" LEAN_TOOLCHAIN
    "\",\"runtime\":\"" LEAN_NEAR_RUNTIME "\",\"lean_near\":\"" LEAN_NEAR_VERSION "\",\"shim_sha256\":\"" SHIM_SHA256
    "\",\"cc\":\"clang " __clang_version__ "\",\"unit_yocto\":\"1000000000000000000\"}";
  near_value_return(sizeof r - 1, U(r));
}
