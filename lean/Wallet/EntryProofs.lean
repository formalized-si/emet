import Wallet.Entry
namespace Wallet.Entry
open Wallet Wallet.Wire

/-- If the decision starts with tag `A`, then policy, state and request all decoded,
`step` returned `allow` for exactly `(to, amount)`, and `parsedList` (what the shim
transfers) encodes that same `(to, amount)`. -/
theorem decide_allow_parsed (pB sB iB : List UInt8) (now : UInt64) (rest : List UInt8)
    (h : decideList pB sB iB now = 65 :: rest) :
    ∃ p s to amt, decodePolicy pB = some p ∧ decodeState sB = some s ∧
      parseRequest iB = some (to, amt) ∧ (step p s now to amt).1 = .allow ∧
      parsedList iB = putU64 amt to := by
  unfold decideList at h
  split at h
  · simp [errPolicy] at h
  · rename_i p hp
    split at h
    · simp [errState] at h
    · rename_i s hs
      split at h
      · simp [errInput] at h
      · rename_i to amt hr
        refine ⟨p, s, to, amt, hp, hs, hr, ?_, by simp [parsedList, hr]⟩
        cases hv : step p s now to amt with
        | mk v s2 =>
          rw [hv] at h
          cases v <;> simp_all [Verdict.tag]

end Wallet.Entry
