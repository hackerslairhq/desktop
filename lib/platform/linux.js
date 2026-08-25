const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const SYSTEM_NAMES = new Set([
  'systemd', 'kthreadd', 'dbus-daemon', 'networkmanager', 'sshd', 'cron',
  'containerd', 'dockerd',
]);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve(String(stdout || ''));
        return;
      }
      const failure = new Error(String(stderr || '').trim() || error.message);
      failure.code = error.code;
      reject(failure);
    });
  });
}

function endpointParts(endpoint) {
  const match = String(endpoint || '').match(/^(.*):(\d+)$/);
  if (!match) return null;
  return {
    address: match[1].replace(/^\[|\]$/g, ''),
    port: Number(match[2]),
  };
}

function parseSs(source) {
  const listeners = new Map();
  const establishedByPort = new Map();
  for (const raw of String(source || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const state = parts[0].toUpperCase();
    const local = endpointParts(parts[3]);
    if (!local) continue;
    if (state === 'ESTAB' || state === 'ESTABLISHED') {
      establishedByPort.set(local.port, (establishedByPort.get(local.port) || 0) + 1);
      continue;
    }
    if (state !== 'LISTEN') continue;
    const owner = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    if (!owner) continue;
    const pid = Number(owner[2]);
    if (!listeners.has(pid)) listeners.set(pid, {
      pid,
      name: owner[1],
      memKB: 0,
      ports: new Map(),
    });
    const ports = listeners.get(pid).ports;
    if (!ports.has(local.port)) ports.set(local.port, new Set());
    ports.get(local.port).add(local.address);
  }
  return { listeners, establishedByPort };
}

function parseLsof(source) {
  const listeners = new Map();
  for (const raw of String(source || '').split(/\r?\n/).slice(1)) {
    const parts = raw.trim().split(/\s+/);
    const pid = Number(parts[1]);
    const local = endpointParts(parts.findLast((part) => /:\d+$/.test(part)));
    if (!Number.isInteger(pid) || !local) continue;
    if (!listeners.has(pid)) listeners.set(pid, {
      pid,
      name: parts[0],
      memKB: 0,
      ports: new Map(),
    });
    const ports = listeners.get(pid).ports;
    if (!ports.has(local.port)) ports.set(local.port, new Set());
    ports.get(local.port).add(local.address);
  }
  return { listeners, establishedByPort: new Map() };
}

function cpuTimeSeconds(value) {
  const [clock, dayText] = String(value || '').split('-').reverse();
  const parts = clock.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  const seconds = parts.reverse().reduce((total, part, index) => total + (part * (60 ** index)), 0);
  return seconds + ((Number(dayText) || 0) * 86400);
}

function selectedLinuxFolders(source) {
  return String(source || '')
    .split(/\r?\n/)
    .map((folder) => folder.trim())
    .filter((folder) => path.posix.isAbsolute(folder))
    .slice(0, 10);
}

async function systemCommandExists(command) {
  try {
    await run('which', [command], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function parsePs(source, now = Date.now()) {
  const rows = [];
  for (const raw of String(source || '').split(/\r?\n/)) {
    const match = raw.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const uptimeSeconds = Number(match[5]);
    let exePath = '';
    try { exePath = fs.readlinkSync(`/proc/${pid}/exe`); } catch { /* permissions or exited */ }
    rows.push({
      pid,
      parentPid: Number(match[2]),
      name: match[3],
      cmd: match[7],
      exePath,
      startedAt: now - (uptimeSeconds * 1000),
      uptimeSeconds,
      cpuTimeSeconds: cpuTimeSeconds(match[6]),
      workingSetKB: Number(match[4]) || 0,
    });
  }
  return rows;
}

function spawnDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      cwd: options.cwd,
      env: options.env || process.env,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function firstAvailable(commands) {
  let lastError;
  for (const [command, args] of commands) {
    try {
      return { command, source: await run(command, args) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No supported system command is available.');
}

function createLinuxPlatform({
  runCommand = run,
  commandExists = systemCommandExists,
  spawnCommand = spawnDetached,
} = {}) {
  return {
    name: 'linux',
    supportsScripts: false,
    async networkSnapshot() {
      const result = await firstAvailable([
        ['ss', ['-ltnpH']],
        ['lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']],
      ]);
      const parsed = result.command === 'ss' ? parseSs(result.source) : parseLsof(result.source);
      if (result.command === 'ss') {
        try {
          const established = parseSs(await run('ss', ['-tnpH', 'state', 'established']));
          parsed.establishedByPort = established.establishedByPort;
        } catch { /* connection counts are optional */ }
      }
      return {
        listeners: [...parsed.listeners.values()].map((listener) => ({
          ...listener,
          ports: [...listener.ports.entries()].map(([port, addresses]) => ({
            port,
            addresses: [...addresses],
            establishedConnections: parsed.establishedByPort.get(port) || 0,
          })),
        })),
      };
    },
    async processDetails(pids = null) {
      if (Array.isArray(pids) && !pids.length) return [];
      const selector = Array.isArray(pids) ? ['-p', pids.join(',')] : ['-e'];
      const source = await run('ps', [
        ...selector,
        '-o',
        'pid=,ppid=,comm=,rss=,etimes=,time=,args=',
      ]);
      return parsePs(source);
    },
    async systemStats() {
      const load = os.loadavg()[0];
      return {
        cpuPercent: Math.max(0, Math.min(100, (load / Math.max(os.cpus().length, 1)) * 100)),
        totalMemoryKB: Math.round(os.totalmem() / 1024),
        freeMemoryKB: Math.round(os.freemem() / 1024),
      };
    },
    isProtectedProcess(pid, _name, ownPid) {
      return pid <= 1 || pid === ownPid;
    },
    isSystemProcess(pid, name, ownPid) {
      return pid !== ownPid && (
        this.isProtectedProcess(pid, name, ownPid)
        || SYSTEM_NAMES.has(String(name || '').toLowerCase())
      );
    },
    async terminateProcess(pid) {
      process.kill(pid, 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 500));
      try { process.kill(pid, 0); } catch { return; }
      process.kill(pid, 'SIGKILL');
    },
    async executableExists(name) {
      try {
        await run('which', [name], { timeout: 2_000 });
        return true;
      } catch {
        return false;
      }
    },
    async toolVersion(command, args = ['--version']) {
      try {
        return (await run(command, args, { timeout: 3_000, maxBuffer: 1024 * 1024 }))
          .trim()
          .split(/\r?\n/)[0] || 'available';
      } catch {
        return 'not found';
      }
    },
    execFile: run,
    async chooseWorkspaceFolders() {
      let command;
      let args;
      if (await commandExists('zenity')) {
        command = 'zenity';
        args = ['--file-selection', '--directory', '--title=Choose a development workspace'];
      } else if (await commandExists('kdialog')) {
        command = 'kdialog';
        args = ['--getexistingdirectory', '.', '--title', 'Choose a development workspace'];
      } else {
        throw new Error('Install zenity or kdialog to use the folder picker in a browser.');
      }
      try {
        const source = await runCommand(command, args, {
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
        });
        return selectedLinuxFolders(source);
      } catch (error) {
        if (Number(error.code) === 1) return [];
        throw error;
      }
    },
    async openUrl(url, browser = '') {
      return spawnDetached(browser || 'xdg-open', [url]);
    },
    async openTarget(action, target) {
      if (action === 'logs') return spawnCommand('xdg-open', [target.logFile]);
      if (action === 'explorer') return spawnCommand('xdg-open', [target.cwd]);
      if (action === 'terminal') return spawnCommand('x-terminal-emulator', [], { cwd: target.cwd });
      if (action === 'vscode') return spawnCommand('code', [target.cwd], { cwd: target.cwd });
      if (action === 'editor-file') return spawnCommand('xdg-open', [target.file]);
      if (action === 'reveal-file') return spawnCommand('xdg-open', [path.dirname(target.file)]);
      throw new Error('Unknown open-in action.');
    },
    resolveScriptRuntime() {
      return null;
    },
    async scriptProcesses() {
      return [];
    },
    async startScript() {
      throw new Error('The Scripts view is available on Windows only.');
    },
  };
}

module.exports = {
  cpuTimeSeconds,
  createLinuxPlatform,
  endpointParts,
  parseLsof,
  parsePs,
  parseSs,
  selectedLinuxFolders,
};
