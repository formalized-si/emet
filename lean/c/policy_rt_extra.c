/* policy_rt_extra.c -- the one out-of-line Lean runtime function the policy
 * library needs beyond lean_near_rt.c: ByteArray.push (used only by
 * Wallet.Wire.toBytes at the output boundary). Same semantics as the Lean
 * runtime (runtime/object.cpp): append in place when exclusive and capacity
 * allows, otherwise copy into a larger buffer and release the argument. */
#include <lean/lean.h>
void *memcpy(void *, const void *, size_t);

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
