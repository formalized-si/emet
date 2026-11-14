import Policy.Bounties
open Wallet

namespace Solution

lemma testClash (s s' : State) (h : (Verdict.denyPerTx, s) = (Verdict.allow, s')) : False := by
  cases h

lemma rollDay_nonce (p : Policy) (s : State) (now : UInt64) :
    (rollDay p s now).nonce = s.nonce := by
  unfold rollDay
  split <;> rfl

end Solution
