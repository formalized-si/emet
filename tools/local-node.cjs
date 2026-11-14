// The one place where a script of this repository starts a local NEAR node (near-sandbox):
//   const worker = await localNode('scenario');
// The node's directory, .runtime/<name>-<time>-<pid>, belongs to the process that started it and is removed
// when that process ends: after a pass, a failure, an uncaught error, Ctrl-C or SIGTERM (nothing runs after
// SIGKILL). A script that listens to a signal itself (demo/serve.cjs) ends as it decides, and the directory goes
// then. With several nodes in one process (agent/nearai_local.cjs) all of them go at the end.
// EMET_KEEP_RUNTIME=1, or keep = true, leaves the directory; the node then stops only when the script calls
// tearDown(). near-workspaces 5.0.0 has `rm: true` for this, but it calls fs.rm without `recursive`, which
// fails on a directory, and tearDown() swallows the error: every run left its directory behind.
// The network is the local sandbox, whatever NEAR_WORKSPACES_NETWORK says.
const fs = require('fs'),
  path = require('path');
const { Worker } = require('near-workspaces');
const onExit = require('signal-exit'); // on exit and on a signal that ends the process; near-workspaces loads it already (proper-lockfile)

const nodes = []; // the nodes this process started and will remove
function removeNodes() {
  for (const { home, worker } of nodes) {
    try {
      if (worker) worker.server.subprocess.kill('SIGKILL'); // nothing is sent once it has exited; it must not write while its directory goes
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10 });
    } catch (e) {
      console.error(`could not remove ${home}: ${e.message}`);
    }
  }
}

module.exports = async function localNode(name, keep = false) {
  if (!/^[a-z][a-z-]*$/.test(name)) throw Error(`localNode: not a name for a node directory: ${name}`);
  const node = {
    home: path.resolve(__dirname, '..', '.runtime', `${name}-${Date.now()}-${process.pid}`),
    worker: null,
  };
  if (!keep && process.env.EMET_KEEP_RUNTIME !== '1') {
    if (!nodes.length) onExit(removeNodes);
    nodes.push(node);
  }
  return (node.worker = await Worker.init({ network: 'sandbox', homeDir: node.home }));
};

// The check:  S=$PWD/.sandbox/2.14.0 NEAR_SANDBOX_BIN_PATH=$S/near-sandbox NEAR_SANDBOX_BINARY_PATH=$S node tools/local-node.cjs
// A child process starts a node and ends in each of these ways; afterwards its directory must be gone, or still
// there when it was asked to stay.
if (require.main === module)
  (async () => {
    if (!process.env.NEAR_SANDBOX_BIN_PATH || !process.env.NEAR_SANDBOX_BINARY_PATH) {
      console.error(
        'usage: S=$PWD/.sandbox/2.14.0 NEAR_SANDBOX_BIN_PATH=$S/near-sandbox NEAR_SANDBOX_BINARY_PATH=$S node tools/local-node.cjs',
      );
      process.exit(64);
    }
    const how = process.argv[2];
    if (how) {
      // the child
      const worker = await module.exports('check');
      console.log(worker.config.homeDir);
      if (how === 'error') throw Error('the error this check asks for');
      if (how.startsWith('SIG')) return setInterval(() => {}, 1000); // until the parent sends that signal
      return worker.tearDown();
    }
    const { spawn } = require('child_process');
    for (const [how, keep] of [
      ['pass', ''],
      ['error', ''],
      ['SIGINT', ''],
      ['SIGTERM', ''],
      ['pass', '1'],
    ]) {
      const child = spawn(process.execPath, [__filename, how], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, EMET_KEEP_RUNTIME: keep },
      });
      const ended = new Promise((resolve) => child.once('exit', resolve));
      const home = await Promise.race([
        new Promise((resolve) => child.stdout.once('data', (d) => resolve(String(d).trim()))),
        ended.then(() => ''),
      ]);
      if (how.startsWith('SIG')) child.kill(how);
      const stuck = setTimeout(() => child.kill('SIGKILL'), 60000); // a child that does not end fails the check instead of hanging it
      await ended;
      clearTimeout(stuck);
      const ok = home && fs.existsSync(home) === !!keep;
      console.log(
        `${ok ? 'PASS' : 'FAIL'} a run that ends with ${how}${keep ? ' under EMET_KEEP_RUNTIME=1 keeps' : ' removes'} its node directory`,
      );
      if (keep && home.includes(`${path.sep}.runtime${path.sep}check-`))
        fs.rmSync(home, { recursive: true, force: true }); // what the kept run left
      if (!ok) process.exitCode = 1;
    }
  })();
