/* lean_near_rt.c — minimal single-threaded Lean runtime subset for NEAR wasm32.
 *
 * Provides the out-of-line symbols that lean.h (built WITHOUT LEAN_MIMALLOC)
 * and Lean-generated C need for a program over scalars, ctors, arrays,
 * ByteArray and small Nat. Anything outside that subset FAILS CLOSED
 * (NEAR panic -> transaction aborts): bignums (Nat >= 2^31 on wasm32),
 * closures, thunks/tasks/refs/externals, multi-threaded objects.
 * This file + libc subset below is the trusted, unverified part.
 */
#include <lean/lean.h>

__attribute__((import_module("env"), import_name("panic_utf8")))
extern void near_panic_utf8(uint64_t len, uint64_t ptr);

static size_t rt_strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
static LEAN_NORETURN void rt_die(const char *m) {
  near_panic_utf8(rt_strlen(m), (uint64_t)(uintptr_t)m);
  __builtin_unreachable();
}

/* ---------------- libc subset (compiled with -fno-builtin) ---------------- */
void *memcpy(void *d, const void *s, size_t n) { char *a = d; const char *b = s; while (n--) *a++ = *b++; return d; }
void *memmove(void *d, const void *s, size_t n) {
  char *a = d; const char *b = s;
  if (a < b) while (n--) *a++ = *b++; else { a += n; b += n; while (n--) *--a = *--b; }
  return d;
}
void *memset(void *d, int c, size_t n) { unsigned char *a = d; while (n--) *a++ = (unsigned char)c; return d; }
int memcmp(const void *x, const void *y, size_t n) {
  const unsigned char *a = x, *b = y;
  for (; n; n--, a++, b++) if (*a != *b) return *a - *b;
  return 0;
}

/* Allocator: 8-byte header holding the block size; exact-size free lists for
   blocks <= 4 KiB, a first-fit list for bigger ones; bump from __heap_base. */
extern unsigned char __heap_base;
static uintptr_t heap_top = 0, heap_end = 0;
#define NCLASS 512
typedef struct blk { size_t size; struct blk *next; } blk;
static blk *freel[NCLASS + 1];

static void *bump(size_t total) {
  if (!heap_top) { heap_top = ((uintptr_t)&__heap_base + 7) & ~(uintptr_t)7; heap_end = __builtin_wasm_memory_size(0) * 65536u; }
  if (heap_top + total > heap_end) {
    size_t need = heap_top + total - heap_end, pages = (need + 65535) / 65536;
    if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) rt_die("lean-rt: out of memory");
    heap_end += pages * 65536u;
  }
  void *p = (void *)heap_top; heap_top += total; return p;
}
void *malloc(size_t n) {
  size_t sz = (n + 7) & ~(size_t)7; if (sz == 0) sz = 8;
  size_t cls = sz / 8;
  blk *b;
  if (cls < NCLASS && (b = freel[cls])) { freel[cls] = b->next; return (char *)b + 8; }
  if (cls >= NCLASS) {
    blk **pp = &freel[NCLASS];
    for (; *pp; pp = &(*pp)->next) if ((*pp)->size >= sz) { b = *pp; *pp = b->next; return (char *)b + 8; }
  }
  b = bump(sz + 8); b->size = sz; return (char *)b + 8;
}
void free(void *p) {
  if (!p) return;
  blk *b = (blk *)((char *)p - 8);
  size_t cls = b->size / 8; if (cls > NCLASS) cls = NCLASS;
  b->next = freel[cls]; freel[cls] = b;
}
void free_sized(void *p, size_t n) { (void)n; free(p); }
void *calloc(size_t a, size_t b) { size_t n = a * b; if (b && n / b != a) return 0; void *p = malloc(n); if (p) memset(p, 0, n); return p; }
void *realloc(void *p, size_t n) {
  if (!p) return malloc(n);
  blk *b = (blk *)((char *)p - 8);
  if (b->size >= n) return p;
  void *q = malloc(n); memcpy(q, p, b->size); free(p); return q;
}
void abort(void) { rt_die("abort"); }

/* ---------------- Lean object memory ---------------- */
/* Same layout lean.h uses for small objects without mimalloc: size_t header. */
lean_object *lean_alloc_object(size_t sz) {
  void *mem = malloc(sizeof(size_t) + sz);
  if (!mem) lean_internal_panic_out_of_memory();
  *(size_t *)mem = sz;
  return (lean_object *)((size_t *)mem + 1);
}
void lean_free_object(lean_object *o) { free((size_t *)o - 1); }

/* Deletion worklist threaded through m_rc (fits a wasm32 pointer), as the
   real runtime does on 32-bit targets. */
LEAN_CASSERT(sizeof(void *) == sizeof(int));
static lean_object *todo = 0;
static void push_del(lean_object *o) { *(lean_object **)&o->m_rc = todo; todo = o; }
static void dec_child(lean_object *c) {
  if (lean_is_scalar(c)) return;
  int rc = c->m_rc;
  if (rc > 1) c->m_rc = rc - 1;
  else if (rc == 1) push_del(c);
  else if (rc < 0) rt_die("lean-rt: multi-threaded/sticky object");
  /* rc == 0: persistent, never freed */
}
static void drain(void) {
  while (todo) {
    lean_object *o = todo;
    todo = *(lean_object **)&o->m_rc;
    uint8_t tag = o->m_tag;
    if (tag <= LeanMaxCtorTag) {
      unsigned n = lean_ctor_num_objs(o);
      for (unsigned i = 0; i < n; i++) dec_child(lean_ctor_get(o, i));
    } else if (tag == LeanArray) {
      size_t n = lean_array_size(o);
      for (size_t i = 0; i < n; i++) dec_child(lean_array_get_core(o, i));
    } else if (tag == LeanScalarArray || tag == LeanString) {
      /* no children */
    } else {
      rt_die("lean-rt: unsupported object kind (closure/thunk/task/ref/external/mpz)");
    }
    lean_free_object(o);
  }
}
void lean_dec_ref_cold(lean_object *o) {
  if (o->m_rc == 1) { push_del(o); drain(); return; }
  rt_die("lean-rt: multi-threaded/sticky object");
}

/* Persistent marking for closed terms: rc := 0 over the reachable graph. */
static void mark_persistent_rec(lean_object *o, int depth) {
  if (lean_is_scalar(o) || o->m_rc == 0) return;
  if (depth > 10000) rt_die("lean-rt: mark_persistent depth");
  o->m_rc = 0;
  uint8_t tag = o->m_tag;
  if (tag <= LeanMaxCtorTag) {
    unsigned n = lean_ctor_num_objs(o);
    for (unsigned i = 0; i < n; i++) mark_persistent_rec(lean_ctor_get(o, i), depth + 1);
  } else if (tag == LeanArray) {
    size_t n = lean_array_size(o);
    for (size_t i = 0; i < n; i++) mark_persistent_rec(lean_array_get_core(o, i), depth + 1);
  } else if (tag != LeanScalarArray && tag != LeanString) {
    rt_die("lean-rt: unsupported persistent object kind");
  }
}
void lean_mark_persistent(lean_object *o) { mark_persistent_rec(o, 0); }
void lean_mark_mt(lean_object *o) { (void)o; /* single-threaded: no-op */ }

/* ---------------- runtime hooks ---------------- */
void lean_inc_heartbeat(void) {}
void lean_initialize_runtime_module(void) {}
void lean_io_mark_end_initialization(void) {}
void lean_set_exit_on_panic(bool f) { (void)f; }
/* User module imports only Init; nothing from Init is linked (link fails if
   any Init symbol is referenced), so Init's initializer has nothing to do. */
__attribute__((weak)) lean_object *initialize_Init(uint8_t builtin) { (void)builtin; return lean_io_result_mk_ok(lean_box(0)); }

LEAN_NORETURN void lean_internal_panic(char const *m) { (void)m; rt_die("lean: internal panic"); }
LEAN_NORETURN void lean_internal_panic_out_of_memory(void) { rt_die("lean: out of memory"); }
LEAN_NORETURN void lean_internal_panic_unreachable(void) { rt_die("lean: unreachable"); }
LEAN_NORETURN void lean_internal_panic_rc_overflow(void) { rt_die("lean: rc overflow"); }
LEAN_NORETURN void lean_internal_panic_overflow(void) { rt_die("lean: overflow"); }
/* Lean `panic!`: abort the transaction instead of returning the default. */
lean_object *lean_panic_fn(lean_object *d, lean_object *msg) { (void)d; (void)msg; rt_die("lean: panic!"); }
lean_object *lean_panic_fn_borrowed(b_lean_obj_arg d, lean_object *msg) { (void)d; (void)msg; rt_die("lean: panic!"); }

/* Big naturals (>= 2^31 on wasm32) are outside the subset: creating or
   consuming one aborts the call. Small-Nat fast paths stay inline in lean.h. */
#define BIGNAT "lean-rt: Nat >= 2^31 (bignum) not supported"
lean_object *lean_nat_big_add(lean_object *a, lean_object *b) { (void)a; (void)b; rt_die(BIGNAT); }
lean_object *lean_nat_big_sub(lean_object *a, lean_object *b) { (void)a; (void)b; rt_die(BIGNAT); }
lean_object *lean_nat_big_mul(lean_object *a, lean_object *b) { (void)a; (void)b; rt_die(BIGNAT); }
lean_object *lean_nat_big_div(lean_object *a, lean_object *b) { (void)a; (void)b; rt_die(BIGNAT); }
lean_object *lean_nat_big_mod(lean_object *a, lean_object *b) { (void)a; (void)b; rt_die(BIGNAT); }
bool lean_nat_big_eq(lean_object *a, lean_object *b) { (void)a; (void)b; rt_die(BIGNAT); }
bool lean_nat_big_le(lean_object *a, lean_object *b) { (void)a; (void)b; rt_die(BIGNAT); }
bool lean_nat_big_lt(lean_object *a, lean_object *b) { (void)a; (void)b; rt_die(BIGNAT); }
lean_object *lean_nat_overflow_mul(size_t a, size_t b) { (void)a; (void)b; rt_die(BIGNAT); }
lean_obj_res lean_big_usize_to_nat(size_t n) { (void)n; rt_die(BIGNAT); }
lean_obj_res lean_big_uint64_to_nat(uint64_t n) { (void)n; rt_die(BIGNAT); }
uint64_t lean_uint64_of_big_nat(b_lean_obj_arg a) { (void)a; rt_die(BIGNAT); }
lean_obj_res lean_nat_big_shiftr(b_lean_obj_arg a, b_lean_obj_arg b) { (void)a; (void)b; rt_die(BIGNAT); }

/* ---------------- re-implemented runtime primitives (trusted) ----------------
   Semantics follow src/runtime/object.cpp: owned args, in-place when exclusive. */
lean_object *lean_array_push(lean_obj_arg a, lean_obj_arg v) {
  size_t sz = lean_array_size(a), cap = lean_array_capacity(a);
  if (lean_is_exclusive(a) && sz < cap) {
    lean_array_cptr(a)[sz] = v; lean_to_array(a)->m_size = sz + 1; return a;
  }
  size_t ncap = 2 * cap + 1; if (ncap < sz + 1) ncap = sz + 1;
  lean_object *r = lean_alloc_array(sz + 1, ncap);
  lean_object **src = lean_array_cptr(a), **dst = lean_array_cptr(r);
  if (lean_is_exclusive(a)) {           /* move elements, free old shell */
    for (size_t i = 0; i < sz; i++) dst[i] = src[i];
    lean_free_object(a);
  } else {                              /* share elements */
    for (size_t i = 0; i < sz; i++) { lean_inc(src[i]); dst[i] = src[i]; }
    lean_dec_ref(a);
  }
  dst[sz] = v;
  return r;
}
lean_object *lean_array_to_list(lean_obj_arg a) {
  size_t n = lean_array_size(a);
  lean_object *l = lean_box(0);
  for (size_t i = n; i-- > 0;) {
    lean_object *x = lean_array_get_core(a, i); lean_inc(x);
    lean_object *c = lean_alloc_ctor(1, 2, 0); lean_ctor_set(c, 0, x); lean_ctor_set(c, 1, l); l = c;
  }
  lean_dec(a);
  return l;
}

/* ByteArray.push — from the lean-policy agent's policy_rt_extra.c (runtime/object.cpp semantics). */
lean_obj_res lean_byte_array_push(lean_obj_arg a, uint8_t b) {
  lean_object *r;
  size_t sz = lean_sarray_size(a);
  if (lean_is_exclusive(a) && lean_sarray_capacity(a) > sz) {
    r = a;
  } else {
    size_t cap = lean_sarray_capacity(a);
    size_t ncap = 2 * (cap > sz ? cap : sz) + 1;
    r = lean_alloc_sarray(1, sz, ncap);
    memcpy(lean_sarray_cptr(r), lean_sarray_cptr(a), sz);
    lean_dec(a);
  }
  lean_sarray_cptr(r)[sz] = b;
  lean_to_sarray(r)->m_size = sz + 1;
  return r;
}
