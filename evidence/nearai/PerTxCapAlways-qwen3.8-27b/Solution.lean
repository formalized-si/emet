import Policy.Bounties
open Wallet

namespace Experiment

theorem run_nil (p : Policy) (s : State) : run p s [] = (s, []) := by
  unfold run
  rfl

theorem run_cons (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64)
    (rest : List Req) :
    (run p s ((now, to, amount) :: rest)).2 =
      (step p s now to amount).1 :: (run p (step p s now to amount).2 rest).2 := by
  unfold run
  rfl

end Experiment
