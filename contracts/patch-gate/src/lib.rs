//! Immutable artifact allowlist, with activation gated by an Emet proof certificate.
//! The builder/extractor and compiler remain trusted: a hash binds artifacts, not semantics.
//! A target gives this account the sole Upgrader role and removes its full-access keys.
//! This gate never treats a refutation as permission to install code.
use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct Candidate {
    pub id: String,
    pub source_sha256: String,
    pub wasm_sha256: String,
    pub claim: String,
    pub bounty_id: U64,
    pub chunks: Vec<Chunk>,
}

#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct Chunk {
    pub sha256: String,
    pub bytes: u32,
}

#[near(serializers=[borsh,json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Phase {
    Open,
    Checking,
    Upgrading,
    Uncertain,
    Applied,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PatchGate {
    target: AccountId,
    board: AccountId,
    base_hash: String,
    candidates: Vec<Candidate>,
    phase: Phase,
    generation: u64,
    started_height: u64,
    staged: LookupMap<String, Vec<u8>>,
    candidate: Option<String>,
    last_error: Option<String>,
}

fn hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn certified(candidate: &Candidate, base: &str, config: &Value, bounty: &Value) -> bool {
    config["base_hash"] == base
        && config.get("kernel_broken_by") == Some(&Value::Null)
        && bounty["id"] == candidate.bounty_id.0.to_string()
        && bounty["claim"] == candidate.claim
        && bounty["certificate"]["side"] == "proof"
        && bounty["certificate"]["proved"] == candidate.claim
        && bounty["certificate"]["base_hash"] == base
        && bounty["certificate"]["delta_sha256"]
            .as_str()
            .is_some_and(hex64)
}

#[near]
impl PatchGate {
    #[init]
    pub fn new(
        target: AccountId,
        board: AccountId,
        base_hash: String,
        candidates: Vec<Candidate>,
    ) -> Self {
        require!(hex64(&base_hash), "bad_base_hash");
        require!(
            !candidates.is_empty() && candidates.len() <= 16,
            "bad_candidates"
        );
        for (i, c) in candidates.iter().enumerate() {
            require!(
                !c.id.is_empty()
                    && c.id.len() <= 64
                    && hex64(&c.source_sha256)
                    && hex64(&c.wasm_sha256),
                "bad_candidate"
            );
            require!(!c.chunks.is_empty() && c.chunks.len() <= 8, "bad_chunks");
            require!(
                c.chunks
                    .iter()
                    .all(|x| hex64(&x.sha256) && x.bytes > 0 && x.bytes <= 400_000),
                "bad_chunk"
            );
            require!(
                c.chunks.iter().map(|x| u64::from(x.bytes)).sum::<u64>() <= 2_000_000,
                "code_too_large"
            );
            require!(
                c.claim == format!("Refund.C_{}.Correct", c.source_sha256),
                "claim_must_be_source_correctness"
            );
            require!(
                candidates[..i]
                    .iter()
                    .all(|x| x.id != c.id && x.bounty_id != c.bounty_id),
                "duplicate_candidate"
            );
        }
        Self {
            target,
            board,
            base_hash,
            candidates,
            phase: Phase::Open,
            generation: 0,
            started_height: 0,
            staged: LookupMap::new(b"chunks".as_slice()),
            candidate: None,
            last_error: None,
        }
    }

    /// Chunks are immutable and content-addressed. The uploader pays their storage.
    #[payable]
    pub fn stage_code(&mut self, candidate_id: String, index: u32, data: Base64VecU8) -> bool {
        let c = self
            .candidates
            .iter()
            .find(|c| c.id == candidate_id)
            .expect("unknown_candidate");
        let chunk = c.chunks.get(index as usize).expect("unknown_chunk");
        require!(
            data.0.len() == chunk.bytes as usize
                && hex::encode(env::sha256(&data.0)) == chunk.sha256,
            "chunk_mismatch"
        );
        let key = format!("{}:{}", candidate_id, index);
        if self.staged.contains_key(&key) {
            require!(env::attached_deposit() == NearToken::ZERO, "already_staged");
            return false;
        }
        let cost = env::storage_byte_cost().as_yoctonear() * (data.0.len() as u128 + 256);
        require!(
            env::attached_deposit().as_yoctonear() >= cost,
            "storage_deposit_required"
        );
        self.staged.insert(key, data.0);
        true
    }

    fn code_for(&self, candidate_id: &str) -> Vec<u8> {
        let c = self
            .candidates
            .iter()
            .find(|c| c.id == candidate_id)
            .expect("unknown_candidate");
        let mut code = Vec::new();
        for i in 0..c.chunks.len() {
            code.extend(
                self.staged
                    .get(&format!("{}:{}", candidate_id, i))
                    .expect("code_not_staged"),
            );
        }
        require!(
            hex::encode(env::sha256(&code)) == c.wasm_sha256,
            "artifact_mismatch"
        );
        require!(code.starts_with(b"\0asm\x01\0\0\0"), "not_wasm");
        code
    }

    /// Anyone may activate a staged allowlisted build after a matching positive certificate.
    pub fn apply_patch(&mut self, candidate_id: String) -> Promise {
        require!(self.phase == Phase::Open, "gate_not_open");
        self.code_for(&candidate_id);
        let c = self
            .candidates
            .iter()
            .find(|c| c.id == candidate_id)
            .expect("unknown_candidate");
        let id = c.bounty_id;
        self.phase = Phase::Checking;
        self.generation += 1;
        self.started_height = env::block_height();
        self.candidate = Some(candidate_id.clone());
        self.last_error = None;
        Promise::new(self.board.clone())
            .function_call(
                "get_config",
                b"{}".to_vec(),
                NearToken::ZERO,
                Gas::from_tgas(15),
            )
            .and(Promise::new(self.board.clone()).function_call(
                "get_bounty",
                json!({"id":id}).to_string().into_bytes(),
                NearToken::ZERO,
                Gas::from_tgas(15),
            ))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(650))
                    .on_certificate(U64(self.generation), candidate_id),
            )
    }

    #[private]
    pub fn on_certificate(
        &mut self,
        generation: U64,
        candidate_id: String,
        #[callback_result] config: Result<Value, PromiseError>,
        #[callback_result] bounty: Result<Option<Value>, PromiseError>,
    ) -> PromiseOrValue<bool> {
        if generation.0 != self.generation
            || self.phase != Phase::Checking
            || self.candidate.as_deref() != Some(&candidate_id)
        {
            return PromiseOrValue::Value(false);
        }
        let candidate = self
            .candidates
            .iter()
            .find(|c| c.id == candidate_id)
            .expect("unknown_candidate");
        let valid = match (&config, &bounty) {
            (Ok(config), Ok(Some(bounty))) => certified(candidate, &self.base_hash, config, bounty),
            _ => false,
        };
        if !valid {
            self.phase = Phase::Open;
            self.candidate = None;
            self.last_error = Some("no_matching_positive_certificate".into());
            return PromiseOrValue::Value(false);
        }
        self.phase = Phase::Upgrading;
        self.started_height = env::block_height();
        self.dispatch_upgrade(generation, self.code_for(&candidate_id))
            .into()
    }

    fn dispatch_upgrade(&self, generation: U64, code: Vec<u8>) -> Promise {
        // NEAR Intents ControllerUpgradable::upgrade uses Borsh(Vec<u8>, Option<Gas>).
        let mut args = (u32::try_from(code.len()).expect("code_too_large"))
            .to_le_bytes()
            .to_vec();
        args.extend(code);
        args.push(0); // default migration gas
        Promise::new(self.target.clone())
            .function_call(
                "upgrade",
                args,
                NearToken::from_yoctonear(1),
                Gas::from_tgas(500),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(30))
                    .on_upgraded(generation),
            )
    }

    /// A failed check callback commits no upgrade receipt. Invalidate its old response.
    pub fn reopen_stale_check(&mut self) {
        require!(
            self.phase == Phase::Checking
                && env::block_height().saturating_sub(self.started_height) >= 200,
            "check_not_stale"
        );
        self.generation += 1;
        self.phase = Phase::Open;
        self.candidate = None;
        self.last_error = Some("stale_check_reopened".into());
    }

    /// This case has an idempotent no-op migration. Retrying may only reinstall the same bytes.
    /// The original authorization persists for recovery; a later board invalidation is not re-read.
    pub fn retry_upgrade(&mut self) -> Promise {
        require!(
            (self.phase == Phase::Upgrading || self.phase == Phase::Uncertain)
                && env::block_height().saturating_sub(self.started_height) >= 200,
            "upgrade_not_retryable"
        );
        let code = self.code_for(self.candidate.as_ref().expect("missing_candidate"));
        self.generation += 1;
        self.started_height = env::block_height();
        self.phase = Phase::Upgrading;
        self.dispatch_upgrade(U64(self.generation), code)
    }

    #[private]
    pub fn on_upgraded(
        &mut self,
        generation: U64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if generation.0 != self.generation || self.phase != Phase::Upgrading {
            return false;
        }
        let ok = result.is_ok();
        if ok {
            self.phase = Phase::Applied;
        } else {
            // Deployment can have succeeded before migration failed. Keep the candidate fixed.
            self.phase = Phase::Uncertain;
            self.last_error = Some("upgrade_or_migration_failed_state_unknown".into());
        }
        ok
    }

    pub fn status(&self) -> Value {
        json!({"target":self.target,"board":self.board,"base_hash":self.base_hash,
        "phase":self.phase,"generation":U64(self.generation),"started_height":U64(self.started_height),"candidate":self.candidate,"last_error":self.last_error,"candidates":self.candidates,
        "staged":self.candidates.iter().map(|c| c.chunks.iter().enumerate().map(|(i,_)|self.staged.contains_key(&format!("{}:{}",c.id,i))).collect::<Vec<_>>()).collect::<Vec<_>>()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Candidate, Value, Value) {
        let c = Candidate {
            id: "repair".into(),
            source_sha256: "a".repeat(64),
            wasm_sha256: "b".repeat(64),
            claim: format!("Refund.C_{}.Correct", "a".repeat(64)),
            bounty_id: U64(7),
            chunks: vec![Chunk {
                sha256: "e".repeat(64),
                bytes: 8,
            }],
        };
        let cfg = json!({"base_hash":"c".repeat(64),"kernel_broken_by":null});
        let b = json!({"id":"7","claim":c.claim,"certificate":{"side":"proof","proved":c.claim,"base_hash":"c".repeat(64),"delta_sha256":"d".repeat(64)}});
        (c, cfg, b)
    }
    #[test]
    fn exact_positive_certificate_is_required() {
        let (c, cfg, b) = fixture();
        assert!(certified(&c, &"c".repeat(64), &cfg, &b));
        for (field, value) in [
            ("side", json!("refutation")),
            ("proved", json!("Other.Correct")),
            ("base_hash", json!("e".repeat(64))),
            ("delta_sha256", json!("")),
        ] {
            let mut bad = b.clone();
            bad["certificate"][field] = value;
            assert!(!certified(&c, &"c".repeat(64), &cfg, &bad));
        }
        let mut bad = b.clone();
        bad["id"] = json!("8");
        assert!(!certified(&c, &"c".repeat(64), &cfg, &bad));
        let mut broken = cfg.clone();
        broken["kernel_broken_by"] = json!("0");
        assert!(!certified(&c, &"c".repeat(64), &broken, &b));
    }

    fn gate_at(height: u64) -> PatchGate {
        use near_sdk::test_utils::VMContextBuilder;
        near_sdk::testing_env!(VMContextBuilder::new().block_height(height).build());
        let (c, _, _) = fixture();
        PatchGate::new(
            "target.near".parse().unwrap(),
            "board.near".parse().unwrap(),
            "c".repeat(64),
            vec![c],
        )
    }

    #[test]
    fn stale_check_reopens_without_accepting_its_late_certificate() {
        let mut g = gate_at(500);
        g.phase = Phase::Checking;
        g.generation = 3;
        g.started_height = 100;
        g.candidate = Some("repair".into());
        let (_, config, bounty) = fixture();
        g.reopen_stale_check();
        assert_eq!(g.phase, Phase::Open);
        assert_eq!(g.generation, 4);
        assert!(matches!(
            g.on_certificate(U64(3), "repair".into(), Ok(config), Ok(Some(bounty))),
            PromiseOrValue::Value(false)
        ));
        assert_eq!(g.phase, Phase::Open);
    }

    #[test]
    fn migration_failure_retains_candidate_and_blocks_a_different_patch() {
        let mut g = gate_at(500);
        g.phase = Phase::Upgrading;
        g.generation = 3;
        g.started_height = 100;
        g.candidate = Some("repair".into());
        assert!(!g.on_upgraded(U64(3), Err(PromiseError::Failed)));
        assert_eq!(g.phase, Phase::Uncertain);
        assert_eq!(g.candidate.as_deref(), Some("repair"));
        assert_ne!(g.phase, Phase::Open);
    }

    #[test]
    fn a_late_upgrade_result_cannot_complete_the_new_generation() {
        let mut g = gate_at(500);
        g.phase = Phase::Upgrading;
        g.generation = 4;
        g.candidate = Some("repair".into());
        assert!(!g.on_upgraded(U64(3), Ok(())));
        assert_eq!(g.phase, Phase::Upgrading);
    }
}
