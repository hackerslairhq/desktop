const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(check, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    try { child.kill(); } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function removeDirectoryWithRetry(directory) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error.code !== 'EPERM' || attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test('project status resolves a relative listener script from its direct parent project path', async (t) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-manager-lineage-'));
  const configPath = path.join(tempDirectory, 'projects.json');
  const launcherPath = path.join(tempDirectory, 'launcher.js');
  const childPidPath = path.join(tempDirectory, 'child.pid');
  const workerPort = await freePort();
  const managerPort = await freePort();
  const expectedScript = path.join(tempDirectory, 'dashboard.js');

  fs.writeFileSync(launcherPath, [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    'const [port, pidFile] = process.argv.slice(2);',
    "const source = \"require('node:http').createServer((_request, response) => response.end('ok')).listen(Number(process.argv[1]), '127.0.0.1');\";",
    "const child = spawn(process.execPath, ['-e', source, port], { stdio: 'ignore', windowsHide: true });",
    "child.once('spawn', () => fs.writeFileSync(pidFile, String(child.pid)));",
    "process.on('SIGTERM', () => { try { child.kill(); } finally { process.exit(); } });",
    'setInterval(() => {}, 1_000);',
  ].join('\n'));
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{
      name: 'Process lineage fixture',
      type: 'test',
      components: [{
        name: 'dashboard',
        role: 'backend',
        cwd: tempDirectory,
        command: 'this-command-must-not-run',
        port: workerPort,
        match: expectedScript,
      }],
    }],
  }));

  const launcher = spawn(
    process.execPath,
    [launcherPath, String(workerPort), childPidPath, path.basename(expectedScript)],
    {
      cwd: tempDirectory,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  const manager = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(managerPort),
      PROJECTS_FILE: configPath,
      PROJECT_MANAGER_DATA_DIR: tempDirectory,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(async () => {
    try {
      const childPid = Number(fs.readFileSync(childPidPath, 'utf8'));
      if (Number.isInteger(childPid)) process.kill(childPid);
    } catch { /* already stopped */ }
    await Promise.all([stopChild(manager), stopChild(launcher)]);
    await removeDirectoryWithRetry(tempDirectory);
  });

  const baseUrl = `http://127.0.0.1:${managerPort}`;
  await waitFor(async () => (await fetch(`${baseUrl}/api/projects`)).ok, 'server did not start');
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/projects`);
    if (!response.ok) return false;
    const payload = await response.json();
    return payload.projects[0].running;
  }, 'listener was not attributed to its project');

  const payload = await fetch(`${baseUrl}/api/projects`).then((response) => response.json());
  assert.equal(payload.projects[0].components[0].status, 'running');
  assert.deepEqual(payload.projects[0].components[0].livePorts, [workerPort]);

  const processPayload = await fetch(`${baseUrl}/api/processes`).then((response) => response.json());
  assert.ok(processPayload.processes.length > 0);
  assert.equal(processPayload.processes.some((process) => 'matchText' in process), false);
});
