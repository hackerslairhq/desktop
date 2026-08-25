const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createWin32Platform,
  parseNetstat,
  parseTasklist,
} = require('../lib/platform/win32');
const {
  cpuTimeSeconds,
  createLinuxPlatform,
  parsePs,
  parseSs,
} = require('../lib/platform/linux');

test('Win32 fixtures map listeners, connections, names, and memory', () => {
  const tasklist = [
    '"node.exe","4120","Console","1","123,456 K"',
    '"System","4","Services","0","1,024 K"',
  ].join('\r\n');
  const netstat = [
    '  TCP    127.0.0.1:5173     0.0.0.0:0       LISTENING       4120',
    '  TCP    127.0.0.1:5173     127.0.0.1:60211 ESTABLISHED     4120',
  ].join('\r\n');

  const processes = parseTasklist(tasklist);
  const network = parseNetstat(netstat);
  assert.equal(processes.get(4120).name, 'node.exe');
  assert.equal(processes.get(4120).memKB, 123456);
  assert.deepEqual([...network.listeners.get(4120).get(5173)], ['127.0.0.1']);
  assert.equal(network.establishedByPort.get(5173), 1);
});

test('Linux fixtures map ss listeners and ps process telemetry', () => {
  const ss = [
    'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=812,fd=20))',
    'ESTAB 0 0 127.0.0.1:3000 127.0.0.1:48812 users:(("node",pid=812,fd=21))',
  ].join('\n');
  const network = parseSs(ss);
  assert.equal(network.listeners.get(812).name, 'node');
  assert.deepEqual([...network.listeners.get(812).ports.get(3000)], ['127.0.0.1']);
  assert.equal(network.establishedByPort.get(3000), 1);

  const now = Date.UTC(2026, 0, 1);
  const [process] = parsePs(' 812 400 node 204800 65 00:01:05 node server.js --port 3000', now);
  assert.equal(process.pid, 812);
  assert.equal(process.parentPid, 400);
  assert.equal(process.workingSetKB, 204800);
  assert.equal(process.uptimeSeconds, 65);
  assert.equal(process.cpuTimeSeconds, 65);
  assert.equal(process.cmd, 'node server.js --port 3000');
});

test('Linux CPU time parser supports day-prefixed values', () => {
  assert.equal(cpuTimeSeconds('01:02:03'), 3723);
  assert.equal(cpuTimeSeconds('2-01:00:00'), 176400);
});

test('Win32 workspace picker returns the selected absolute folder', async () => {
  let invocation;
  const platform = createWin32Platform({
    runCommand: async (command, args, options) => {
      invocation = { command, args, options };
      return 'C:\\Workspaces\\sample-app\r\n';
    },
  });

  assert.deepEqual(await platform.chooseWorkspaceFolders(), ['C:\\Workspaces\\sample-app']);
  assert.equal(invocation.command, 'powershell.exe');
  assert.ok(invocation.args.includes('-STA'));
  assert.equal(invocation.options.timeout, 120_000);
});

test('Linux workspace picker uses an available desktop dialog', async () => {
  let invocation;
  const platform = createLinuxPlatform({
    commandExists: async (command) => command === 'zenity',
    runCommand: async (command, args, options) => {
      invocation = { command, args, options };
      return '/home/dev/sample-app\n';
    },
  });

  assert.deepEqual(await platform.chooseWorkspaceFolders(), ['/home/dev/sample-app']);
  assert.equal(invocation.command, 'zenity');
  assert.ok(invocation.args.includes('--directory'));
  assert.equal(invocation.options.timeout, 120_000);
});

test('Linux workspace picker treats cancel as empty but surfaces launch failures', async () => {
  const commandExists = async (command) => command === 'zenity';
  const canceled = createLinuxPlatform({
    commandExists,
    runCommand: async () => {
      throw Object.assign(new Error('canceled'), { code: 1 });
    },
  });
  assert.deepEqual(await canceled.chooseWorkspaceFolders(), []);

  const unavailable = createLinuxPlatform({
    commandExists,
    runCommand: async () => {
      throw Object.assign(new Error('cannot open display'), { code: 2 });
    },
  });
  await assert.rejects(
    unavailable.chooseWorkspaceFolders(),
    /cannot open display/,
  );
});

test('instruction files open in the associated editor and reveal without shell interpolation', async () => {
  const windowsCalls = [];
  const windows = createWin32Platform({
    spawnCommand: async (command, args) => { windowsCalls.push({ command, args }); },
  });
  const windowsFile = 'C:\\Work & Notes\\AGENTS.md';
  await windows.openTarget('editor-file', { file: windowsFile });
  await windows.openTarget('reveal-file', { file: windowsFile });
  assert.deepEqual(windowsCalls, [
    {
      command: 'explorer.exe',
      args: [windowsFile],
    },
    {
      command: 'explorer.exe',
      args: [`/select,${windowsFile}`],
    },
  ]);

  const linuxCalls = [];
  const linux = createLinuxPlatform({
    spawnCommand: async (command, args) => { linuxCalls.push({ command, args }); },
  });
  await linux.openTarget('editor-file', { file: '/work/AGENTS.md' });
  await linux.openTarget('reveal-file', { file: '/work/AGENTS.md' });
  assert.deepEqual(linuxCalls, [
    { command: 'xdg-open', args: ['/work/AGENTS.md'] },
    { command: 'xdg-open', args: ['/work'] },
  ]);
});
