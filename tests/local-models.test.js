const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LOCAL_MODEL_SPECS,
  batchCommandArguments,
  createLocalModelService,
  launchBatchFile,
  localInferenceSetupPrompt,
} = require('../lib/local-models');

test('Windows batch launch leaves quoting to Node argument serialization', () => {
  const launcher = 'C:\\Model Tools\\serve-coder.bat';
  assert.deepEqual(batchCommandArguments(launcher), ['/d', '/c', launcher]);
});

test('Windows batch launch works when the launcher path contains spaces', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lair model launch-'));
  const launcher = path.join(root, 'serve coder.bat');
  const marker = path.join(root, 'started.txt');
  fs.writeFileSync(launcher, `@echo off\r\n> "${marker}" echo started\r\n`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await launchBatchFile(launcher, root);
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'started');
});

function createLlamaRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lair-local-models-'));
  fs.mkdirSync(path.join(root, 'models'));
  fs.writeFileSync(path.join(root, 'llama-server.exe'), 'fixture');
  for (const model of LOCAL_MODEL_SPECS) {
    fs.writeFileSync(path.join(root, model.launcherFile), 'fixture');
    fs.writeFileSync(path.join(root, 'models', model.modelFile), 'fixture');
  }
  return root;
}

function fakePlatform({ processes = [], listeners = [] } = {}) {
  const terminated = [];
  return {
    name: 'win32',
    terminated,
    async processDetails() { return processes; },
    async networkSnapshot() { return { listeners }; },
    async terminateProcess(pid) { terminated.push(pid); },
  };
}

test('local model inventory reports both verified launch targets as stopped', async (t) => {
  const root = createLlamaRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createLocalModelService({ platform: fakePlatform(), rootDirectory: root });

  const snapshot = await service.status();

  assert.equal(snapshot.supported, true);
  assert.equal(snapshot.port, 8080);
  assert.equal(snapshot.activeModelId, null);
  assert.deepEqual(snapshot.models.map((model) => [model.id, model.available, model.state]), [
    ['qwen3-coder-next', true, 'stopped'],
    ['qwen3.6-35b-a3b', true, 'stopped'],
  ]);
});

test('starting a model launches only its reviewed batch file', async (t) => {
  const root = createLlamaRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launches = [];
  const service = createLocalModelService({
    platform: fakePlatform(),
    rootDirectory: root,
    launch: async (launcher, cwd) => {
      launches.push({ launcher, cwd });
      return 4242;
    },
  });

  const result = await service.start('qwen3-coder-next');

  assert.equal(result.pid, 4242);
  assert.deepEqual(launches, [{ launcher: path.join(root, 'serve-coder.bat'), cwd: root }]);
});

test('an active model blocks the second model from sharing port 8080', async (t) => {
  const root = createLlamaRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const platform = fakePlatform({
    processes: [{
      pid: 91,
      name: 'llama-server.exe',
      cmd: `${path.join(root, 'llama-server.exe')} --alias qwen3-coder-next --port 8080`,
    }],
    listeners: [{ pid: 91, ports: [{ port: 8080 }] }],
  });
  const service = createLocalModelService({ platform, rootDirectory: root });

  const snapshot = await service.status();
  assert.equal(snapshot.activeModelId, 'qwen3-coder-next');
  assert.equal(snapshot.models[0].state, 'running');
  await assert.rejects(
    service.start('qwen3.6-35b-a3b'),
    /Stop Qwen3 Coder Next before starting Qwen3\.6 35B A3B/,
  );
});

test('stopping a model terminates only processes matched to that model', async (t) => {
  const root = createLlamaRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const platform = fakePlatform({
    processes: [
      { pid: 12, name: 'cmd.exe', cmd: `cmd /c ${path.join(root, 'serve-coder.bat')}` },
      { pid: 13, name: 'llama-server.exe', cmd: `llama-server --alias qwen3-coder-next` },
      { pid: 77, name: 'node.exe', cmd: 'node unrelated.js' },
      { pid: 78, name: 'powershell.exe', cmd: 'Get-Content serve-coder.bat' },
    ],
    listeners: [{ pid: 13, ports: [{ port: 8080 }] }],
  });
  const service = createLocalModelService({ platform, rootDirectory: root });

  const result = await service.stop('qwen3-coder-next');

  assert.equal(result.stopped, 2);
  assert.deepEqual(platform.terminated, [12, 13]);
});

test('missing local artifacts disable only the affected controls', async (t) => {
  const root = createLlamaRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.rmSync(path.join(root, 'models', LOCAL_MODEL_SPECS[1].modelFile));
  const service = createLocalModelService({ platform: fakePlatform(), rootDirectory: root });

  const snapshot = await service.status();

  assert.equal(snapshot.models[0].available, true);
  assert.equal(snapshot.models[1].available, false);
  assert.deepEqual(snapshot.models[1].missing, ['model']);
  await assert.rejects(service.start('qwen3.6-35b-a3b'), /Missing: model/);
});

test('agent setup prompt reflects the exact live artifact audit and safety contract', async (t) => {
  const root = createLlamaRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.rmSync(path.join(root, 'models', LOCAL_MODEL_SPECS[1].modelFile));
  const service = createLocalModelService({ platform: fakePlatform(), rootDirectory: root });

  const { prompt } = await service.setupPrompt();

  assert.equal(prompt, localInferenceSetupPrompt(await service.status()));
  assert.match(prompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt, /unsloth\/Qwen3-Coder-Next-GGUF, UD-Q3_K_XL/);
  assert.match(prompt, /Qwen3\.6 35B A3B: .* \(missing model\)/);
  assert.match(prompt, /--list-devices/);
  assert.match(prompt, /Never run both models at once/);
  assert.match(prompt, /Do not silently fall back/);
});

test('agent setup prompt stops on platforms outside the native Windows contract', async () => {
  const platform = { ...fakePlatform(), name: 'linux' };
  const service = createLocalModelService({ platform, rootDirectory: '/tmp/llama.cpp' });

  const { prompt } = await service.setupPrompt();

  assert.match(prompt, /require native Windows/);
  assert.match(prompt, /Stop and move this setup/);
  assert.doesNotMatch(prompt, /Install only these exact model files/);
});
