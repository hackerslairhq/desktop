const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const SYSTEM_NAMES = new Set([
  'system', 'system idle process', 'idle', 'registry', 'memory compression',
  'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe',
  'lsass.exe', 'svchost.exe', 'spoolsv.exe', 'dns.exe', 'mdnsresponder.exe',
  'dashost.exe', 'wslrelay.exe', 'vmcompute.exe', 'com.docker.backend.exe',
]);
const PROTECTED_NAMES = new Set([
  'system', 'system idle process', 'idle', 'registry', 'memory compression',
  'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe',
  'lsass.exe', 'svchost.exe',
]);
const WORKSPACE_FOLDER_PICKER_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$dialog.Description = "Choose a development workspace"',
  '$dialog.ShowNewFolderButton = $true',
  'try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) } } finally { $dialog.Dispose() }',
].join('; ');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      ...options,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || '').trim() || error.message));
      else resolve(String(stdout || ''));
    });
  });
}

function parseTasklist(source) {
  const processes = new Map();
  for (const raw of String(source || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('"')) continue;
    const columns = line.replace(/^"|"$/g, '').split('","');
    const pid = Number(columns[1]);
    if (!Number.isInteger(pid)) continue;
    processes.set(pid, {
      pid,
      name: columns[0],
      memKB: Number(String(columns[4] || '').replace(/[^\d]/g, '')) || 0,
    });
  }
  return processes;
}

function parseNetstat(source) {
  const listeners = new Map();
  const establishedByPort = new Map();
  for (const raw of String(source || '').split(/\r?\n/)) {
    const parts = raw.trim().split(/\s+/);
    if (parts[0] !== 'TCP' || parts.length < 5) continue;
    const local = parts[1];
    const separator = local.lastIndexOf(':');
    const port = Number(local.slice(separator + 1));
    const pid = Number(parts[4]);
    if (separator < 0 || !Number.isInteger(port) || !Number.isInteger(pid)) continue;
    if (parts[3] === 'ESTABLISHED') {
      establishedByPort.set(port, (establishedByPort.get(port) || 0) + 1);
      continue;
    }
    if (parts[3] !== 'LISTENING') continue;
    if (!listeners.has(pid)) listeners.set(pid, new Map());
    const ports = listeners.get(pid);
    if (!ports.has(port)) ports.set(port, new Set());
    ports.get(port).add(local.slice(0, separator));
  }
  return { listeners, establishedByPort };
}

function normalizeProcessRows(source) {
  const parsed = String(source || '').trim() ? JSON.parse(source) : [];
  const now = Date.now();
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => {
    const kernel = Number(row.KernelModeTime) || 0;
    const user = Number(row.UserModeTime) || 0;
    const startedAt = row.CreationDateUtc ? Date.parse(row.CreationDateUtc) : NaN;
    return {
      pid: Number(row.ProcessId),
      parentPid: Number(row.ParentProcessId),
      name: String(row.Name || ''),
      cmd: String(row.CommandLine || ''),
      exePath: String(row.ExecutablePath || ''),
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      uptimeSeconds: Number.isFinite(startedAt)
        ? Math.max(0, Math.floor((now - startedAt) / 1000))
        : null,
      cpuTimeSeconds: (kernel + user) / 10_000_000,
      workingSetKB: Math.round((Number(row.WorkingSetSize) || 0) / 1024),
    };
  }).filter((row) => Number.isInteger(row.pid));
}

function processQuery(pids) {
  const filter = Array.isArray(pids) && pids.length
    ? ` -Filter "${pids.map((pid) => `ProcessId=${Number(pid)}`).join(' OR ')}"`
    : '';
  return `$rows = Get-CimInstance Win32_Process${filter} | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,@{Name='CreationDateUtc';Expression={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } }},KernelModeTime,UserModeTime,WorkingSetSize; $rows | ConvertTo-Json -Compress`;
}

function spawnDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: options.windowsHide ?? false,
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

function selectedWin32Folders(source) {
  return String(source || '')
    .split(/\r?\n/)
    .map((folder) => folder.trim())
    .filter((folder) => path.win32.isAbsolute(folder))
    .slice(0, 10);
}

function createWin32Platform({
  runCommand = run,
  spawnCommand = spawnDetached,
} = {}) {
  return {
    name: 'win32',
    supportsScripts: true,
    async networkSnapshot() {
      const [netstat, tasklist] = await Promise.all([
        run('netstat', ['-ano']),
        run('tasklist', ['/FO', 'CSV', '/NH']),
      ]);
      const processMap = parseTasklist(tasklist);
      const { listeners, establishedByPort } = parseNetstat(netstat);
      return {
        listeners: [...listeners.entries()].map(([pid, ports]) => ({
          ...(processMap.get(pid) || { pid, name: `PID ${pid}`, memKB: 0 }),
          ports: [...ports.entries()].map(([port, addresses]) => ({
            port,
            addresses: [...addresses],
            establishedConnections: establishedByPort.get(port) || 0,
          })),
        })),
      };
    },
    async processDetails(pids = null) {
      if (Array.isArray(pids) && !pids.length) return [];
      const source = await run('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        processQuery(pids),
      ]);
      return normalizeProcessRows(source);
    },
    async systemStats() {
      const script = `$os = Get-CimInstance Win32_OperatingSystem; $cores = [int]$env:NUMBER_OF_PROCESSORS; if ($cores -lt 1) { $cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors }; $s1 = @{}; foreach ($p in Get-Process) { try { $s1[$p.Id] = $p.TotalProcessorTime.TotalSeconds } catch {} }; $sw = [Diagnostics.Stopwatch]::StartNew(); Start-Sleep -Milliseconds 350; $sw.Stop(); $busy = 0.0; foreach ($p in Get-Process) { try { if ($s1.ContainsKey($p.Id)) { $d = $p.TotalProcessorTime.TotalSeconds - $s1[$p.Id]; if ($d -gt 0) { $busy += $d } } } catch {} }; $cpu = [math]::Round($busy / $sw.Elapsed.TotalSeconds / $cores * 100, 1); if ($cpu -gt 100) { $cpu = 100 }; [pscustomobject]@{ CpuPercent = $cpu; TotalMemoryKB = [int64]$os.TotalVisibleMemorySize; FreeMemoryKB = [int64]$os.FreePhysicalMemory } | ConvertTo-Json -Compress`;
      const source = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
      const row = JSON.parse(source);
      return {
        cpuPercent: Number(row.CpuPercent),
        totalMemoryKB: Number(row.TotalMemoryKB),
        freeMemoryKB: Number(row.FreeMemoryKB),
      };
    },
    isProtectedProcess(pid, name, ownPid) {
      return [0, 4, ownPid].includes(pid) || PROTECTED_NAMES.has(String(name || '').toLowerCase());
    },
    isSystemProcess(pid, name, ownPid) {
      return pid !== ownPid && (
        this.isProtectedProcess(pid, name, ownPid)
        || SYSTEM_NAMES.has(String(name || '').toLowerCase())
      );
    },
    terminateProcess(pid) {
      return run('taskkill', ['/PID', String(pid), '/T', '/F']);
    },
    async executableExists(name) {
      try {
        await run('where.exe', [name], { timeout: 2_000 });
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
      const source = await runCommand('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-Command',
        WORKSPACE_FOLDER_PICKER_SCRIPT,
      ], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      return selectedWin32Folders(source);
    },
    async openUrl(url, browser = '') {
      if (browser) await spawnDetached(browser, [url]);
      else await run('cmd.exe', ['/d', '/s', '/c', 'start', '', url]);
    },
    async openTarget(action, target) {
      if (action === 'logs') return spawnCommand('notepad.exe', [target.logFile]);
      if (action === 'explorer') return spawnCommand('explorer.exe', [target.cwd]);
      if (action === 'terminal') return spawnCommand('cmd.exe', ['/d', '/k'], { cwd: target.cwd });
      if (action === 'vscode') return spawnCommand('code.cmd', [target.cwd], { cwd: target.cwd });
      if (action === 'editor-file') return spawnCommand('explorer.exe', [target.file]);
      if (action === 'reveal-file') return spawnCommand('explorer.exe', [`/select,${target.file}`]);
      throw new Error('Unknown open-in action.');
    },
    resolveScriptRuntime(configured) {
      return [
        configured,
        'C:\\Program Files\\AutoIt3\\AutoIt3.exe',
        'C:\\Program Files (x86)\\AutoIt3\\AutoIt3.exe',
      ].filter(Boolean).find((candidate) => {
        try { return fs.existsSync(candidate); } catch { return false; }
      }) || null;
    },
    async scriptProcesses() {
      return (await this.processDetails()).filter((row) => /^autoit/i.test(row.name));
    },
    startScript(executable, scriptPath, cwd) {
      return spawnDetached(executable, [scriptPath], { cwd, windowsHide: true });
    },
  };
}

module.exports = {
  createWin32Platform,
  normalizeProcessRows,
  parseNetstat,
  parseTasklist,
  selectedWin32Folders,
};
