/* selftest_entry.c -- runs the Lean-compiled policy inside wasm32 against the
 * minimal runtime (no NEAR host). Exported `selftest(i)` runs scenario i and
 * leaves the output bytes in `outbuf`; returns their length. */
#include <lean/lean.h>
void *memcpy(void *, const void *, size_t);
extern lean_object *near_policy_decide(lean_object*, lean_object*, lean_object*, uint64_t);
extern uint8_t near_policy_validate(lean_object*);
extern uint8_t near_policy_tighten(lean_object*, lean_object*);
extern lean_object *near_policy_from_json(lean_object*);
extern lean_object *near_policy_init_state(uint64_t);
extern lean_object *initialize_lean_x2dpolicy_Policy_Wire(uint8_t);

static size_t slen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
static lean_object *ba(const char *s, size_t n) {
  lean_object *o = lean_alloc_sarray(1, n, n);
  memcpy(lean_sarray_cptr(o), s, n);
  return o;
}
static lean_object *bs(const char *s) { return ba(s, slen(s)); }
static unsigned char outbuf[4096];
__attribute__((export_name("outptr"))) uint32_t outptr(void) { return (uint32_t)(uintptr_t)outbuf; }
static uint32_t emit(lean_object *o) {
  size_t n = lean_sarray_size(o);
  memcpy(outbuf, lean_sarray_cptr(o), n);
  lean_dec(o);
  return (uint32_t)n;
}
static int inited = 0;
static const char *POLICY =
  "{\"budget\":\"1000\",\"per_tx\":\"300\",\"per_day\":\"500\",\"day_ns\":\"86400000000000\","
  "\"allowed\":[\"alice.testnet\",\"bob.testnet\"]}";
static const char *TIGHT =
  "{\"budget\":\"900\",\"per_tx\":\"300\",\"per_day\":\"500\",\"day_ns\":\"86400000000000\","
  "\"allowed\":[\"alice.testnet\"]}";

/* scenario: 0 policy bytes, 1 init state, 2..: decide on (state from previous step) */
static lean_object *state = 0;
__attribute__((export_name("selftest"))) uint32_t selftest(uint32_t i) {
  if (!inited) { initialize_lean_x2dpolicy_Policy_Wire(1); inited = 1; }
  lean_object *pol = near_policy_from_json(bs(POLICY));
  if (i == 0) return emit(pol);
  if (i == 1) { lean_dec(pol); return emit(near_policy_init_state(1000)); }
  if (i == 2) { lean_object *t = near_policy_from_json(bs(TIGHT)); lean_inc(pol);
                outbuf[0] = near_policy_validate(pol); outbuf[1] = near_policy_tighten(pol, t);
                lean_object *t2 = near_policy_from_json(bs(TIGHT)); outbuf[2] = near_policy_tighten(t2, pol);
                return 3; }
  if (!state) state = near_policy_init_state(1000);
  static const char *reqs[] = {
    "{\"to\":\"alice.testnet\",\"amount\":\"200\"}",            /* 3: allow            */
    "{\"amount\":\"301\", \"to\":\"bob.testnet\"}",             /* 4: per-tx deny      */
    "{\"to\":\"mallory.testnet\",\"amount\":\"1\"}",            /* 5: receiver deny    */
    "{\"to\":\"alice.testnet\",\"amount\":\"300\"}",            /* 6: allow (500 today)*/
    "{\"to\":\"bob.testnet\",\"amount\":\"1\"}",                /* 7: daily deny       */
    "{\"to\":\"alice.testnet\",\"amount\":\"18446744073709551615\"}", /* 8: per-tx deny (2^64-1) */
    "{\"to\":\"alice.testnet\",\"amount\":\"18446744073709551616\"}", /* 9: input error (>u64)   */
    "{\"to\":\"bob.testnet\",\"amount\":\"300\"}",              /* 10: next day: allow */
  };
  uint64_t nows[] = {2000, 3000, 4000, 5000, 6000, 7000, 8000, 1000 + 86400000000000ull + 1};
  if (i - 3 >= sizeof(nows) / sizeof(nows[0])) { lean_dec(pol); return 0; }
  lean_inc(state);
  lean_object *out = near_policy_decide(pol, state, bs(reqs[i - 3]), nows[i - 3]);
  size_t n = lean_sarray_size(out);
  if (n >= 33 && lean_sarray_cptr(out)[0] != 'E') {   /* commit new state = bytes 1..33 */
    lean_dec(state); state = ba((const char *)lean_sarray_cptr(out) + 1, 32);
  }
  return emit(out);
}
