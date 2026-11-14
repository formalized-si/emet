# Lean wallet: build the wasm from ../../lean, or show that a weakened policy cannot be built.
#   make -C contracts/wallet build        lake build (every proof re-checked) -> wasm -> out/wallet.wasm
#   make -C contracts/wallet break-proof  weaken the per-payment cap check; a theorem fails; no wasm
# Needs elan (Lean 4.35.0); wasm-tools optional (MVP validation).
LEAN_NEAR := lean-near/lean-near
PROJECT   := ../../lean
OUT       := out

.PHONY: build break-proof
build:
	python3 $(LEAN_NEAR) build $(PROJECT) --entry near_entry.c --out $(OUT)/wallet.wasm

break-proof:
	rm -rf $(OUT)/broken && mkdir -p $(OUT)/broken && rsync -a --exclude .lake $(PROJECT)/ $(OUT)/broken/lean/
	cd $(OUT)/broken/lean && patch -p1 < ../../../break-proof.patch
	@set +e; python3 $(LEAN_NEAR) build $(OUT)/broken/lean --entry near_entry.c --out $(OUT)/broken/wallet.wasm > $(OUT)/broken/build.log 2>&1; \
	  rc=$$?; grep -m3 -E "error" $(OUT)/broken/build.log; \
	  echo "lean-near exit code: $$rc"; \
	  if [ -e $(OUT)/broken/wallet.wasm ]; then echo "UNEXPECTED: wasm produced"; exit 1; fi; \
	  if [ $$rc -eq 0 ]; then echo "UNEXPECTED: build succeeded"; exit 1; fi; \
	  echo "OK: the weakened policy does not compile to a contract (no wasm)"
