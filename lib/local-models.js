const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LOCAL_MODEL_PORT = 8080;
const LOCAL_MODEL_SPECS = Object.freeze([
  Object.freeze({
    id: 'qwen3-coder-next',
    name: 'Qwen3 Coder Next',
    quant: 'UD-Q3_K_XL',
    generationTokensPerSecond: 28.22,
    alias: 'qwen3-coder-next',
    source: 'unsloth/Qwen3-Coder-Next-GGUF',
    modelFile: 'Qwen3-Coder-Next-UD-Q3_K_XL.gguf',
    launcherFile: 'serve-coder.bat',
    nCpuMoe: 24,
  }),
  Object.freeze({
    id: 'qwen3.6-35b-a3b',
    name: 'Qwen3.6 35B A3B',
    quant: 'UD-Q6_K',
    generationTokensPerSecond: 26.54,
    alias: 'qwen3.6-35b-a3b',
    source: 'unsloth/Qwen3.6-35B-A3B-GGUF',
    modelFile: 'Qwen3.6-35B-A3B-UD-Q6_K.gguf',
    launcherFile: 'serve-35b.bat',
    nCpuMoe: 24,
  }),
]);

function defaultLlamaRoot() {
  if (process.env.LLAMA_CPP_ROOT) return path.resolve(process.env.LLAMA_CPP_ROOT);
  if (process.platform === 'win32') return 'C:\\llama.cpp';
  return path.join(os.homedir(), 'llama.cpp');
}

function localModelError(message, status = 409) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function batchCommandArguments(launcherPath) {
  return ['/d', '/c', launcherPath];
}

function launchBatchFile(launcherPath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', batchCommandArguments(launcherPath), {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      const pid = child.pid;
      child.unref();
      resolve(pid);
    });
  });
}

function commandMatchesModel(process, spec, rootDirectory) {
  const name = String(process.name || '').toLowerCase();
  const command = String(process.cmd || '').toLowerCase();
  if (name === 'llama-server.exe') {
    return command.includes(spec.modelFile.toLowerCase())
      || command.includes(`--alias ${spec.alias}`.toLowerCase());
  }
  const launcher = path.join(rootDirectory, spec.launcherFile).toLowerCase();
  return name === 'cmd.exe' && command.includes(launcher);
}

function modelFiles(rootDirectory, spec) {
  return {
    executable: path.join(rootDirectory, 'llama-server.exe'),
    launcher: path.join(rootDirectory, spec.launcherFile),
    model: path.join(rootDirectory, 'models', spec.modelFile),
  };
}

function localInferenceSetupPrompt(snapshot) {
  const rootDirectory = snapshot.rootDirectory;
  if (!snapshot.supported) {
    return [
      `Hacker's Lair Local Models controls require native Windows.`,
      `This machine cannot use the reviewed setup at ${rootDirectory}.`,
      'Do not install WSL2, HIP, ROCm, or a substitute backend. Stop and move this setup to a native Windows machine with a Vulkan-capable GPU.',
    ].join('\n');
  }
  const modelInventory = snapshot.models.map((model) => {
    const state = model.available ? 'ready' : `missing ${model.missing.join(', ')}`;
    return `- ${model.name}: ${model.source} at ${model.quant}; expected ${model.files.model} (${state})`;
  }).join('\n');
  const launcherInventory = snapshot.models
    .map((model) => `   - ${model.files.launcher}: --alias ${model.alias} --n-cpu-moe ${model.nCpuMoe}`)
    .join('\n');
  return [
    `Set up Hacker's Lair Local Models on this native Windows machine.`,
    '',
    'Inspect the machine and existing files before changing anything. Preserve working files and do not replace an exact model or quant with a smaller one.',
    '',
    `Hacker's Lair llama.cpp root: ${rootDirectory}`,
    `Shared OpenAI-compatible endpoint: http://localhost:${LOCAL_MODEL_PORT}/v1`,
    'Current artifact audit:',
    modelInventory,
    '',
    'Requirements:',
    `1. Use the latest prebuilt Windows x64 Vulkan release from ggml-org/llama.cpp. Do not build from source. Do not use WSL2, HIP, or ROCm. Install or repair it in ${rootDirectory}.`,
    `2. Before downloading models, check free disk space; the two exact GGUFs require about 66 GB total.`,
    `3. Run ${path.join(rootDirectory, 'llama-server.exe')} --list-devices and confirm a Vulkan GPU appears. If the list is empty or CPU-only, stop and report it.`,
    '4. Install only these exact model files unless I explicitly approve a substitution:',
    ...snapshot.models.map((model) => `   - ${model.source}, ${model.quant}, saved as ${model.files.model}`),
    `5. Create or repair the two reviewed launchers in ${rootDirectory}. Each must use --device Vulkan0 --port ${LOCAL_MODEL_PORT} -ngl 999 -fa on --cache-type-k q8_0 --cache-type-v q8_0 -c 65536 --jinja, plus its exact model path and these per-model values:`,
    launcherInventory,
    '   Keep --n-cpu-moe overridable as the first batch argument.',
    '6. Never run both models at once. Start one model, wait for /v1/models to respond, stop it, confirm port 8080 is clear, then test the other.',
    `7. Finish in Hacker's Lair > Local Models: confirm neither channel shows MISSING, then start each model separately and confirm it reaches ONLINE with no conflict. Report every file changed and both verification results.`,
    '',
    'On any download, extraction, GPU detection, or model validation failure, stop and tell me. Do not silently fall back.',
  ].join('\n');
}

function createLocalModelService({
  platform,
  rootDirectory = defaultLlamaRoot(),
  launch = launchBatchFile,
  fileExists = fs.existsSync,
  processDetails = () => platform.processDetails(),
} = {}) {
  if (!platform) throw new Error('A platform adapter is required.');

  function inventory() {
    return LOCAL_MODEL_SPECS.map((spec) => {
      const files = modelFiles(rootDirectory, spec);
      const missing = Object.entries(files)
        .filter(([, file]) => !fileExists(file))
        .map(([kind]) => kind);
      return {
        ...spec,
        available: platform.name === 'win32' && missing.length === 0,
        missing,
        files,
      };
    });
  }

  async function status() {
    const configuredModels = inventory();
    if (platform.name !== 'win32') {
      return {
        supported: false,
        rootDirectory,
        port: LOCAL_MODEL_PORT,
        activeModelId: null,
        conflict: null,
        models: configuredModels.map((model) => ({
          ...model,
          state: 'unavailable',
          ready: false,
          pids: [],
        })),
      };
    }

    const [processes, network] = await Promise.all([
      processDetails(),
      platform.networkSnapshot(),
    ]);
    const readyPids = new Set((network.listeners || [])
      .filter((process) => (process.ports || []).some((entry) => entry.port === LOCAL_MODEL_PORT))
      .map((process) => process.pid));
    const matchedPids = new Set();

    const models = configuredModels.map((model) => {
      const matches = processes.filter((process) => commandMatchesModel(process, model, rootDirectory));
      const pids = [...new Set(matches.map((process) => process.pid))].sort((left, right) => left - right);
      pids.forEach((pid) => matchedPids.add(pid));
      const ready = pids.some((pid) => readyPids.has(pid));
      return {
        ...model,
        state: !model.available ? 'unavailable' : ready ? 'running' : pids.length ? 'starting' : 'stopped',
        ready,
        pids,
      };
    });

    const unknownServer = processes.find((process) => (
      String(process.name || '').toLowerCase() === 'llama-server.exe'
      && !matchedPids.has(process.pid)
    ));
    const unknownPortOwner = [...readyPids].find((pid) => !matchedPids.has(pid));
    const conflict = unknownServer || unknownPortOwner
      ? {
          pid: unknownServer?.pid || unknownPortOwner,
          message: unknownServer
            ? `Another llama-server process is active as PID ${unknownServer.pid}.`
            : `Port ${LOCAL_MODEL_PORT} is already in use by PID ${unknownPortOwner}.`,
        }
      : null;
    const activeModel = models.find((model) => ['running', 'starting'].includes(model.state));

    return {
      supported: true,
      rootDirectory,
      port: LOCAL_MODEL_PORT,
      activeModelId: activeModel?.id || null,
      conflict,
      models,
    };
  }

  function requireModel(id, models) {
    const model = models.find((candidate) => candidate.id === id);
    if (!model) throw localModelError(`Unknown local model "${id}".`, 404);
    return model;
  }

  async function start(id) {
    const snapshot = await status();
    if (!snapshot.supported) throw localModelError('Local llama.cpp controls require native Windows.', 501);
    const model = requireModel(id, snapshot.models);
    if (!model.available) {
      throw localModelError(`${model.name} is unavailable. Missing: ${model.missing.join(', ')}.`, 409);
    }
    if (['running', 'starting'].includes(model.state)) {
      return { ok: true, id, alreadyRunning: true, state: model.state };
    }
    const activeModel = snapshot.models.find((candidate) => ['running', 'starting'].includes(candidate.state));
    if (activeModel) {
      throw localModelError(`Stop ${activeModel.name} before starting ${model.name}.`, 409);
    }
    if (snapshot.conflict) throw localModelError(snapshot.conflict.message, 409);

    const pid = await launch(model.files.launcher, rootDirectory);
    return { ok: true, id, state: 'starting', pid };
  }

  async function stop(id) {
    const snapshot = await status();
    if (!snapshot.supported) throw localModelError('Local llama.cpp controls require native Windows.', 501);
    const model = requireModel(id, snapshot.models);
    let stopped = 0;
    for (const pid of model.pids) {
      try {
        await platform.terminateProcess(pid);
        stopped += 1;
      } catch {
        // A parent tree termination can remove the remaining matched process.
      }
    }
    return { ok: true, id, stopped, state: 'stopped' };
  }

  async function setupPrompt() {
    const snapshot = await status();
    return { prompt: localInferenceSetupPrompt(snapshot) };
  }

  return { status, start, stop, setupPrompt };
}

module.exports = {
  LOCAL_MODEL_PORT,
  LOCAL_MODEL_SPECS,
  batchCommandArguments,
  commandMatchesModel,
  createLocalModelService,
  launchBatchFile,
  localInferenceSetupPrompt,
  localModelError,
};
