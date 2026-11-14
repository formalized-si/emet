// Reproduce the public upstream refund regression on an isolated NEAR sandbox.
// Uses the actual defuse wasm and the upstream receiver stub, not a rewritten ledger.
// Run by ./verify.sh --refund; by hand: node cases/intents-refund/replay.cjs [out.json]  (default run-output/refund/replay.json)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sandbox = path.resolve(__dirname, '../../.sandbox/2.14.0');
process.env.NEAR_SANDBOX_BIN_PATH ||= path.join(sandbox, 'near-sandbox');
process.env.NEAR_SANDBOX_BINARY_PATH ||= sandbox;
const localNode = require('../../tools/local-node.cjs');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(root, process.argv[2] || 'run-output/refund/replay.json');
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const GAS = '1000000000000000';
const NEAR = (n) => String(BigInt(n) * 10n ** 24n);
const read = (name) => fs.readFileSync(path.join(root, 'run-output/refund', name));

async function main() {
  const record = {
    upstream: 'https://github.com/near/intents',
    revision: '35044fd1795b0de9d1ac269c6aa28a0d6a7efdfa',
    network: 'local sandbox',
    at: new Date().toISOString(),
    scope:
      'Upstream public methods: direct regression plus NEP-245 transfers between two compiled upstream contracts. Tokens are local test assets.',
    artifacts: {},
    runs: [],
    backed_runs: [],
    checks: [],
  };
  for (const name of ['old.wasm', 'fixed.wasm', 'receiver.wasm']) record.artifacts[name] = hash(read(name));
  const worker = await localNode('refund-replay');
  try {
    record.node = await worker.provider.status();
    const owner = worker.rootAccount;
    const issuer = await owner.createSubAccount('a'.repeat(64 - owner.accountId.length - 1), {
      initialBalance: NEAR(100),
    });
    const receiver = await owner.createSubAccount('receiver', { initialBalance: NEAR(100) });
    await receiver.deploy(read('receiver.wasm'));
    const contracts = {};
    for (const version of ['old', 'fixed']) {
      const contract = await owner.createSubAccount(version, { initialBalance: NEAR(200) });
      contracts[version] = contract;
      await contract.deploy(read(version + '.wasm'));
      await owner.call(
        contract,
        'new',
        { config: { wnear_id: 'wrap.test.near', fees: { fee: 0, fee_collector: owner.accountId }, roles: {} } },
        { gas: GAS },
      );
      for (const [name, count, pre, request] of [
        ['single', 1, '1000', '100'],
        ['oversized-log', 80, '10000000000000000000000000000000000000', '100000000000000000000000000000000000'],
      ]) {
        // Use a long token id in the second case, matching the upstream regression's log pressure.
        const token = name === 'single' ? 'single' : 't'.repeat(101);
        const tokenId = `nep245:${issuer.accountId}:${token}`;
        await issuer.call(
          contract,
          'mt_on_transfer',
          {
            sender_id: issuer.accountId,
            previous_owner_ids: [issuer.accountId],
            token_ids: [token],
            amounts: [pre],
            msg: receiver.accountId,
          },
          { gas: GAS },
        );
        const before = await contract.view('mt_balance_of', { account_id: receiver.accountId, token_id: tokenId });
        const tx = await issuer.callRaw(
          contract,
          'mt_on_transfer',
          {
            sender_id: issuer.accountId,
            previous_owner_ids: Array(count).fill(issuer.accountId),
            token_ids: Array(count).fill(token),
            amounts: Array(count).fill('1'),
            msg: JSON.stringify({
              receiver_id: receiver.accountId,
              msg: JSON.stringify({ ReturnValue: request }),
              min_gas: '5000000000000',
            }),
          },
          { gas: GAS },
        );
        const after = await contract.view('mt_balance_of', { account_id: receiver.accountId, token_id: tokenId });
        const result = tx.result;
        const status = result.status;
        const refunded =
          status.SuccessValue === undefined ? null : JSON.parse(Buffer.from(status.SuccessValue, 'base64').toString());
        const failures = result.receipts_outcome
          .filter((r) => r.outcome.status.Failure)
          .map((r) => ({ id: r.id, executor: r.outcome.executor_id, error: r.outcome.status.Failure }));
        record.runs.push({
          version,
          name,
          count,
          deposit_each: '1',
          requested_each: request,
          before,
          after,
          refunded,
          failures,
          transaction: result,
        });
        if (name === 'single') assert.deepEqual(refunded, [version === 'old' ? '100' : '1']);
        else if (version === 'fixed') assert.deepEqual(refunded, Array(count).fill('1'));
        console.log(
          version,
          name,
          JSON.stringify({ before, after, refund: refunded?.[0], failure_count: failures.length }),
        );
      }
    }
    // A second unmodified-upstream contract acts as the real NEP-245 token ledger.
    // Initial test assets are issued via its public deposit callback. Every later
    // backing movement goes through mt_transfer_call and mt_resolve_transfer.
    const outer = await owner.createSubAccount('b'.repeat(64 - owner.accountId.length - 1), {
      initialBalance: NEAR(200),
    });
    await outer.deploy(read('fixed.wasm'));
    await owner.call(
      outer,
      'new',
      { config: { wnear_id: 'wrap.test.near', fees: { fee: 0, fee_collector: owner.accountId }, roles: {} } },
      { gas: GAS },
    );
    const filler = 'x'.repeat(31),
      tokenId = `nep245:${issuer.accountId}:${filler}`;
    const nestedId = `nep245:${outer.accountId}:${tokenId}`;
    const pre = 10n ** 37n,
      count = 80;
    for (const version of ['old', 'fixed']) {
      const contract = contracts[version];
      await issuer.call(
        outer,
        'mt_on_transfer',
        {
          sender_id: issuer.accountId,
          previous_owner_ids: [issuer.accountId],
          token_ids: [filler],
          amounts: [String(pre + 80n)],
          msg: issuer.accountId,
        },
        { gas: GAS },
      );
      await issuer.call(
        outer,
        'mt_transfer_call',
        { receiver_id: contract.accountId, token_id: tokenId, amount: String(pre), msg: receiver.accountId },
        { gas: GAS, attachedDeposit: '1' },
      );
      const balances = async () => ({
        backing: await outer.view('mt_balance_of', { account_id: contract.accountId, token_id: tokenId }),
        credit: await contract.view('mt_balance_of', { account_id: receiver.accountId, token_id: nestedId }),
        sender: await outer.view('mt_balance_of', { account_id: issuer.accountId, token_id: tokenId }),
      });
      const before = await balances();
      const tx = await issuer.callRaw(
        outer,
        'mt_batch_transfer_call',
        {
          receiver_id: contract.accountId,
          token_ids: Array(count).fill(tokenId),
          amounts: Array(count).fill('1'),
          msg: JSON.stringify({
            receiver_id: receiver.accountId,
            msg: JSON.stringify({ ReturnValue: String(10n ** 35n) }),
            min_gas: '5000000000000',
          }),
        },
        { gas: GAS, attachedDeposit: '1' },
      );
      const after = await balances();
      const failures = tx.result.receipts_outcome
        .filter((r) => r.outcome.status.Failure)
        .map((r) => ({ id: r.id, executor: r.outcome.executor_id, error: r.outcome.status.Failure }));
      const deficit = String(BigInt(after.credit) - BigInt(after.backing));
      record.backed_runs.push({
        version,
        token_id: tokenId,
        nested_token_id: nestedId,
        count,
        before,
        after,
        unbacked_credit: deficit,
        failures,
        transaction: tx.result,
      });
      console.log(
        version,
        'actual backing transfer',
        JSON.stringify({ before, after, unbacked_credit: deficit, failure_count: failures.length }),
      );
    }
    const single = (version) => record.runs.find((r) => r.version === version && r.name === 'single');
    const large = (version) => record.runs.find((r) => r.version === version && r.name === 'oversized-log');
    const check = (name, ok) => {
      record.checks.push({ name, ok });
      assert(ok, name);
    };
    check('Old upstream code returns more than the new deposit', single('old').refunded[0] === '100');
    check('The one-expression repair caps that same refund to the deposit', single('fixed').refunded[0] === '1');
    check(
      'The old resolver fails the oversized refund event',
      large('old').failures.some((r) => {
        const m = JSON.stringify(r.error).match(/length of a log message (\d+) exceeds the limit (\d+)/);
        return m && Number(m[1]) > Number(m[2]) && Number(m[2]) === 16384;
      }),
    );
    check(
      'The repaired resolver completes the identical batch',
      large('fixed').failures.length === 0 && large('fixed').refunded.length === 80,
    );
    const backed = (version) => record.backed_runs.find((r) => r.version === version);
    check('Old upstream code retains 80 credits after its backing is refunded', backed('old').unbacked_credit === '80');
    check(
      'The identical token transfer leaves no unbacked credit after the repair',
      backed('fixed').unbacked_credit === '0',
    );
    check(
      'Both backing ledgers return the unused deposit to the sender',
      ['old', 'fixed'].every((v) => {
        const r = backed(v);
        return r.after.sender === r.before.sender && r.after.backing === r.before.backing;
      }),
    );
    record.ok = record.checks.every((c) => c.ok);
  } catch (error) {
    record.error = String(error.stack || error);
    throw error;
  } finally {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
    await worker.tearDown();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
