import Policy.Wire
/-!
# Policy.WireProofs — the codecs are correct, and the exported call is `step`
-/
namespace Wallet.Wire
open Wallet

/-! ## u64 and State round-trips -/

private theorem split_byte (x : UInt64) :
    x.toUInt8.toUInt64 + (256 : UInt64) * (x >>> 8) = x := by
  apply UInt64.toNat_inj.mp
  have hx := UInt64.toNat_lt x
  simp only [UInt64.toNat_add, UInt64.toNat_mul, UInt8.toNat_toUInt64,
    UInt64.toNat_toUInt8, UInt64.toNat_shiftRight, Nat.shiftRight_eq_div_pow,
    UInt64.toNat_ofNat, Nat.reduceMod, Nat.reducePow]
  omega

theorem combine8_bytes (x : UInt64) :
    combine8 x.toUInt8 (x >>> 8).toUInt8 (x >>> 16).toUInt8 (x >>> 24).toUInt8
      (x >>> 32).toUInt8 (x >>> 40).toUInt8 (x >>> 48).toUInt8 (x >>> 56).toUInt8 = x := by
  have h8 : (x >>> 8).toUInt8.toUInt64 + (256 : UInt64) * (x >>> 16) = x >>> 8 := by
    have h := split_byte (x >>> 8)
    have hs : (x >>> 8) >>> 8 = x >>> 16 := by
      apply UInt64.toNat_inj.mp
      simp [UInt64.toNat_shiftRight, Nat.shiftRight_eq_div_pow, Nat.div_div_eq_div_mul]
    rw [hs] at h
    exact h
  have h16 : (x >>> 16).toUInt8.toUInt64 + (256 : UInt64) * (x >>> 24) = x >>> 16 := by
    have h := split_byte (x >>> 16)
    have hs : (x >>> 16) >>> 8 = x >>> 24 := by
      apply UInt64.toNat_inj.mp
      simp [UInt64.toNat_shiftRight, Nat.shiftRight_eq_div_pow, Nat.div_div_eq_div_mul]
    rw [hs] at h
    exact h
  have h24 : (x >>> 24).toUInt8.toUInt64 + (256 : UInt64) * (x >>> 32) = x >>> 24 := by
    have h := split_byte (x >>> 24)
    have hs : (x >>> 24) >>> 8 = x >>> 32 := by
      apply UInt64.toNat_inj.mp
      simp [UInt64.toNat_shiftRight, Nat.shiftRight_eq_div_pow, Nat.div_div_eq_div_mul]
    rw [hs] at h
    exact h
  have h32 : (x >>> 32).toUInt8.toUInt64 + (256 : UInt64) * (x >>> 40) = x >>> 32 := by
    have h := split_byte (x >>> 32)
    have hs : (x >>> 32) >>> 8 = x >>> 40 := by
      apply UInt64.toNat_inj.mp
      simp [UInt64.toNat_shiftRight, Nat.shiftRight_eq_div_pow, Nat.div_div_eq_div_mul]
    rw [hs] at h
    exact h
  have h40 : (x >>> 40).toUInt8.toUInt64 + (256 : UInt64) * (x >>> 48) = x >>> 40 := by
    have h := split_byte (x >>> 40)
    have hs : (x >>> 40) >>> 8 = x >>> 48 := by
      apply UInt64.toNat_inj.mp
      simp [UInt64.toNat_shiftRight, Nat.shiftRight_eq_div_pow, Nat.div_div_eq_div_mul]
    rw [hs] at h
    exact h
  have h48 : (x >>> 48).toUInt8.toUInt64 + (256 : UInt64) * (x >>> 56) = x >>> 48 := by
    have h := split_byte (x >>> 48)
    have hs : (x >>> 48) >>> 8 = x >>> 56 := by
      apply UInt64.toNat_inj.mp
      simp [UInt64.toNat_shiftRight, Nat.shiftRight_eq_div_pow, Nat.div_div_eq_div_mul]
    rw [hs] at h
    exact h
  have last_byte : (x >>> 56).toUInt8.toUInt64 = x >>> 56 := by
    apply UInt64.toNat_inj.mp
    have hx := UInt64.toNat_lt x
    simp only [UInt8.toNat_toUInt64, UInt64.toNat_toUInt8,
      UInt64.toNat_shiftRight, Nat.shiftRight_eq_div_pow,
      UInt64.toNat_ofNat, Nat.reduceMod, Nat.reducePow]
    omega
  unfold combine8
  rw [last_byte, h48, h40, h32, h24, h16, h8, split_byte]

theorem getU64_putU64 (x : UInt64) (rest : List UInt8) :
    getU64 (putU64 x rest) = some (x, rest) := by
  simp only [putU64, getU64, combine8_bytes]

/-- **State codec round-trip** (proved, not just tested). -/
theorem decodeState_encodeState (s : State) : decodeState (encodeState s) = some s := by
  simp only [decodeState, encodeState, putState, getU64_putU64]

/-- The 32 state bytes in a decision output are exactly `encodeState`. -/
theorem putState_eq (s : State) (rest : List UInt8) :
    putState s rest = encodeState s ++ rest := by
  simp [putState, encodeState, putU64]

theorem encodeState_length (s : State) : (encodeState s).length = 32 := by
  simp [encodeState, putState, putU64]

/-! ## Policy codec round-trip (for well-formed policies) -/

theorem atMost_iff (n : Nat) (l : List UInt8) : atMost n l = true ↔ l.length ≤ n := by
  induction l generalizing n with
  | nil => cases n <;> simp [atMost]
  | cons x xs ih => cases n <;> simp [atMost, ih]

theorem validAccount_length (a : Account) (h : validAccount a = true) : a.length ≤ 64 := by
  unfold validAccount at h
  split at h
  · simp only [Bool.and_eq_true] at h; exact (atMost_iff 64 _).mp h.1
  · cases h

theorem lenU8_toNat (a : List UInt8) (h : a.length < 256) : (lenU8 a).toNat = a.length := by
  induction a with
  | nil => rfl
  | cons x xs ih =>
    simp only [List.length_cons] at h
    simp only [lenU8, UInt8.toNat_add, ih (by omega), List.length_cons]
    have : (1 : UInt8).toNat = 1 := rfl
    rw [this]; omega

theorem takeN_putBytes (a rest : List UInt8) : takeN a.length (putBytes a rest) = some (a, rest) := by
  induction a with
  | nil => rfl
  | cons x xs ih => simp [takeN, putBytes, ih]

theorem getAccounts_putAccounts (accs : List Account) (fuel : Nat) (hf : accs.length ≤ fuel)
    (hv : ∀ a ∈ accs, validAccount a = true) : getAccounts fuel (putAccounts accs) = some accs := by
  induction accs generalizing fuel with
  | nil => cases fuel <;> rfl
  | cons a as ih =>
    cases fuel with
    | zero => simp at hf
    | succ f =>
      have ha := hv a (by simp)
      have hlen := lenU8_toNat a (by have := validAccount_length a ha; omega)
      simp only [putAccounts, getAccounts, hlen, takeN_putBytes, ha, ite_true]
      rw [ih f (by simp at hf; omega) (fun b hb => hv b (by simp [hb]))]

/-- **Policy codec round-trip** for every well-formed policy (all allowlisted ids valid,
at most `maxAccounts` of them) — exactly the policies `decodePolicy` can return. -/
theorem decodePolicy_encodePolicy (p : Policy) (hv : ∀ a ∈ p.allowed, validAccount a = true)
    (hl : p.allowed.length ≤ maxAccounts) : decodePolicy (encodePolicy p) = some p := by
  simp only [decodePolicy, encodePolicy, getU64_putU64, getAccounts_putAccounts _ _ hl hv]

/-! ## The exported call is exactly `step` -/

/-- **`decideList` = decode + `step` + encode.** When policy, state and request
decode, the contract output is the verdict tag, the 32-byte encoding of the new
state computed by `step`, and the verdict code — nothing else decides. -/
theorem decideList_spec (pb sb ib : List UInt8) (now : UInt64) (p : Policy) (s : State)
    (to : Account) (amount : UInt64)
    (hp : decodePolicy pb = some p) (hs : decodeState sb = some s)
    (hi : parseRequest ib = some (to, amount)) :
    decideList pb sb ib now =
      Verdict.tag (step p s now to amount).1 ::
        (encodeState (step p s now to amount).2 ++ Verdict.putCode (step p s now to amount).1 []) := by
  simp only [decideList, hp, hs, hi, putState_eq]

/-- The state the contract writes back (output bytes `1..33`) decodes to `step`'s state. -/
theorem decideList_state (pb sb ib : List UInt8) (now : UInt64) (p : Policy) (s : State)
    (to : Account) (amount : UInt64)
    (hp : decodePolicy pb = some p) (hs : decodeState sb = some s)
    (hi : parseRequest ib = some (to, amount)) :
    decodeState (((decideList pb sb ib now).drop 1).take 32) = some (step p s now to amount).2 := by
  rw [decideList_spec pb sb ib now p s to amount hp hs hi]
  simp only [List.drop_succ_cons, List.drop_zero]
  rw [List.take_append_of_le_length (by rw [encodeState_length]; exact Nat.le_refl _),
    ← encodeState_length (step p s now to amount).2, List.take_length,
    decodeState_encodeState]

/-- Decode failures never reach `step`: the output is an `E…` error code. -/
theorem decideList_badPolicy (pb sb ib : List UInt8) (now : UInt64)
    (hp : decodePolicy pb = none) : decideList pb sb ib now = errPolicy := by
  simp [decideList, hp]

/-! ## Amount parsing never wraps -/

/-- Decimal value in ℕ (Horner), proof-side. -/
def decVal : Nat → List UInt8 → Nat
  | n, [] => n
  | n, b :: bs => decVal (n * 10 + (b.toNat - 48)) bs

/-- One accepted digit: the u64 update `acc * 10 + d` equals the ℕ update. -/
theorem digit_step (acc : UInt64) (b : UInt8) (h1 : 48 ≤ b.toNat) (h2 : b.toNat ≤ 57)
    (hov : acc.toNat < 1844674407370955161 ∨
      (acc.toNat = 1844674407370955161 ∧ b.toNat ≤ 53)) :
    (acc * 10 + (b - 48).toUInt64).toNat = acc.toNat * 10 + (b.toNat - 48) := by
  have h48 : (48 : UInt8) ≤ b := by
    rw [UInt8.le_iff_toNat_le]; exact h1
  rw [UInt64.toNat_add, UInt64.toNat_mul, UInt8.toNat_toUInt64, UInt8.toNat_sub_of_le _ _ h48]
  have e10 : (10 : UInt64).toNat = 10 := rfl
  have e48 : (48 : UInt8).toNat = 48 := rfl
  rw [e10, e48]
  omega

theorem digitsAux_cons (acc : UInt64) (b : UInt8) (bs : List UInt8) :
    digitsAux acc (b :: bs) =
      if b < 48 ∨ 57 < b then none
      else if 1844674407370955161 < acc ∨ (acc = 1844674407370955161 ∧ 53 < b) then none
      else digitsAux (acc * 10 + (b - 48).toUInt64) bs := by
  simp only [digitsAux, Bool.or_eq_true, decide_eq_true_eq, Bool.and_eq_true]

/-- **The parsed amount is the true decimal value** (in ℕ, no wrap-around). -/
theorem digitsAux_sound (acc : UInt64) (bs : List UInt8) (v : UInt64)
    (h : digitsAux acc bs = some v) : v.toNat = decVal acc.toNat bs := by
  induction bs generalizing acc with
  | nil =>
    rw [digitsAux] at h
    cases h
    rfl
  | cons b bs ih =>
    rw [digitsAux_cons] at h
    split at h
    · cases h
    · rename_i hd
      split at h
      · cases h
      · rename_i hov
        have e48 : (48 : UInt8).toNat = 48 := rfl
        have e57 : (57 : UInt8).toNat = 57 := rfl
        have e53 : (53 : UInt8).toNat = 53 := rfl
        have eM : (1844674407370955161 : UInt64).toNat = 1844674407370955161 := rfl
        rw [not_or, UInt8.lt_iff_toNat_lt, UInt8.lt_iff_toNat_lt, e48, e57] at hd
        rw [not_or, UInt64.lt_iff_toNat_lt, eM, not_and, UInt8.lt_iff_toNat_lt, e53] at hov
        have hcase : acc.toNat < 1844674407370955161 ∨
            (acc.toNat = 1844674407370955161 ∧ b.toNat ≤ 53) := by
          by_cases ha : acc.toNat = 1844674407370955161
          · exact Or.inr ⟨ha, by
              have := hov.2 (UInt64.toNat_inj.mp (by rw [ha, eM])); omega⟩
          · exact Or.inl (by omega)
        have hstep := digit_step acc b (by omega) (by omega) hcase
        rw [ih _ h, hstep]
        rfl

theorem parseAmount_sound (bs : List UInt8) (v : UInt64) (h : parseAmount bs = some v) :
    v.toNat = decVal 0 bs := by
  cases bs with
  | nil => simp [parseAmount] at h
  | cons b bs => exact digitsAux_sound 0 (b :: bs) v h

end Wallet.Wire
