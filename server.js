// Hacker's Lair — lists processes listening on local ports and can stop them.
// Runtime OS operations live behind lib/platform so the request layer stays portable.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const { gitAttentionForProject, refreshGitAttention } = require('./lib/git-attention');
const { compareProjectsForDisplay } = require('./lib/project-order');
const {
  onboardingState,
  usageTrackingSetupPrompt,
  workflowRepairPrompt,
} = require('./lib/onboarding-prompts');
const { listSkills, skillRoots } = require('./lib/skill-registry');
const { lintSkills } = require('./lib/skill-lint');
const { contextCost } = require('./lib/context-cost');
const {
  archiveSkill,
  listArchivedSkills,
  scaffoldSkill,
  unarchiveSkill,
} = require('./lib/skill-maintenance');
const { lastTouchedForSkills } = require('./lib/skill-git');
const { appendFriction, listFriction } = require('./lib/friction-log');
const { listInstructions } = require('./lib/instruction-registry');
const { checkInstructionDrift } = require('./lib/instruction-drift');
const { listAgents } = require('./lib/agent-registry');
const { listCommands } = require('./lib/command-registry');
const { listMcpServers } = require('./lib/mcp-registry');
const { permissionsView } = require('./lib/permissions-view');
const { scanStaleContent } = require('./lib/stale-scan');
const { checkFileUrls } = require('./lib/url-checker');
const { projectCoverageMatrix } = require('./lib/coverage-matrix');
const { skillsRepoStatus } = require('./lib/skills-repo-status');
const { listMemoryEntries } = require('./lib/memory-registry');
const { generateWorkflowReport } = require('./lib/workflow-report');
const { exportWorkflowBundle } = require('./lib/workflow-export');
const { harnessParity } = require('./lib/harness-parity');
const {
  buildUsageHookCommand,
  inspectUsageHook,
  installUsageHooks,
  listConfiguredHooks,
  readSettings,
  usageFallbackInstruction,
  usageHooksBlock,
  writeUsageHookShim,
} = require('./lib/claude-settings');
const {
  aggregateUsageLog,
  eventKey,
  isColdUsage,
  pruneOlderThan,
  resolveAgentsHome,
} = require('./lib/usage-log');
const { discoverProjects } = require('./lib/project-discovery');
const { formatDoctorReport, runDoctor } = require('./lib/doctor');
const { redactValue } = require('./lib/redaction');
const { instantiateTemplate, PROJECT_TEMPLATES } = require('./lib/project-templates');
const {
  removeProjectFromConfig,
  updateProjectConfig,
} = require('./lib/project-config');
const {
  describeProjectPortConflicts,
  findProjectPortConflicts,
} = require('./lib/project-port-conflicts');
const {
  detectedUrlsFromLog,
  isZombieComponent,
  splitTargetUrls,
} = require('./lib/runtime-intelligence');
const {
  createRuntimeConfig,
  DEFAULT_AI_WORKFLOW_SETTINGS,
  normalizeAiWorkflowSettings,
} = require('./lib/runtime-config');
const { LogStore } = require('./lib/log-store');
const { createLocalModelService } = require('./lib/local-models');
const { normalizeUiPreferences, validateUiPreferences } = require('./lib/ui-preferences');
const { createPlatform } = require('./lib/platform');
const {
  allowedHost,
  createRuntimeIdentity,
  isJsonContentType,
  renderApplicationHtml,
  validToken,
  writeRuntimeIdentity,
} = require('./lib/runtime-identity');

const PORT = Number(process.env.PORT) || 4949;
const MAX_PORT_TRIES = 10;
const CONFIGURED_COMMAND_TIMEOUT_MS = 60_000;
const configuredStopVerifyTimeout = Number(process.env.PROJECT_STOP_VERIFY_TIMEOUT_MS);
const PROJECT_STOP_VERIFY_TIMEOUT_MS = Number.isFinite(configuredStopVerifyTimeout)
  ? Math.max(0, configuredStopVerifyTimeout)
  : 5_000;
const PROJECT_STOP_VERIFY_INTERVAL_MS = 200;
const PROCESS_SNAPSHOT_TTL_MS = 3_000;
const GIT_REFRESH_INTERVAL_MS = 10_000;
const LOG_MAINTENANCE_INTERVAL_MS = 5_000;
const configuredMaxLogBytes = Number(process.env.LAIR_MAX_COMPONENT_LOG_BYTES);
const MAX_COMPONENT_LOG_BYTES = Number.isFinite(configuredMaxLogBytes)
  ? Math.max(64 * 1024, configuredMaxLogBytes)
  : 2 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const runtimeConfig = createRuntimeConfig(__dirname);
const runtimeIdentity = createRuntimeIdentity();
const platform = createPlatform();
const localModels = createLocalModelService({ platform, processDetails: getProcessSnapshot });
const DATA_DIR = runtimeConfig.dataDirectory;
const AGENTS_HOME = resolveAgentsHome();
const CLAUDE_HOME = path.resolve(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
);
const CLAUDE_SETTINGS_FILE = path.join(CLAUDE_HOME, 'settings.json');
const USAGE_LOG_FILE = path.join(AGENTS_HOME, 'usage-log.jsonl');
const USAGE_HOOK_SHIM_FILE = path.join(DATA_DIR, 'hackers-lair-usage-hook.js');
const USAGE_HOOK_COMMAND = buildUsageHookCommand(USAGE_HOOK_SHIM_FILE);
const SKILL_ROOTS = skillRoots({
  agentsHome: AGENTS_HOME,
  claudeHome: CLAUDE_HOME,
});
const PERSONAL_SKILLS_ROOT = SKILL_ROOTS.personalSkills;
const SKILL_BACKUP_ROOT = path.join(DATA_DIR, 'backups', 'skills');
const FRICTION_LOG_FILE = path.join(DATA_DIR, 'friction-log.jsonl');
const URL_CHECK_CACHE_FILE = path.join(DATA_DIR, 'url-check-cache.json');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
const WORKSPACE_ROOT = path.resolve(
  process.env.LAIR_WORKSPACE_ROOT || path.dirname(AGENTS_HOME),
);
const REWRITE_USAGE_THRESHOLD = 3;
const STORE = path.join(DATA_DIR, 'stopped.json');
const MAX_STOPPED = 40;
const PROJECTS_FILE = runtimeConfig.projects.file;
const SCRIPTS_FILE = runtimeConfig.scripts.file;
const discoveryScans = new Map();
let doctorSnapshot = null;

function loadSettings() {
  const result = runtimeConfig.settings.read();
  return {
    enableSkills: result.value.enableSkills === true,
    enableScripts: result.value.enableScripts === true,
    browserPath: String(result.value.browserPath || ''),
    zombieAfterHours: Number(result.value.zombieAfterHours) || 8,
    workspaceFolders: Array.isArray(result.value.workspaceFolders)
      ? result.value.workspaceFolders
      : [],
    uiPreferences: normalizeUiPreferences(result.value.uiPreferences),
    aiWorkflow: normalizeAiWorkflowSettings(result.value.aiWorkflow),
    error: result.error,
  };
}

function workspaceInstructionsFile(settings = loadSettings()) {
  const candidates = [
    ...settings.workspaceFolders,
    ...loadProjects().flatMap((project) => (
      (project.components || []).map((component) => component.cwd).filter(Boolean)
    )),
  ];
  for (const folder of candidates) {
    const current = path.resolve(folder);
    for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
      const candidate = path.join(current, filename);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '';
}

function ensureUsageHookShim() {
  return writeUsageHookShim({
    shimFile: USAGE_HOOK_SHIM_FILE,
    usageLogFile: USAGE_LOG_FILE,
  });
}

function usageSetupState(settings = loadSettings()) {
  ensureUsageHookShim();
  const hook = inspectUsageHook({
    settingsFile: CLAUDE_SETTINGS_FILE,
    hookCommand: USAGE_HOOK_COMMAND,
  });
  const instructionsFile = workspaceInstructionsFile(settings);
  return {
    hookInstalled: hook.installed,
    hookConflict: hook.conflict,
    hookError: hook.error,
    usageLogFile: USAGE_LOG_FILE,
    claudeSettingsFile: CLAUDE_SETTINGS_FILE,
    lairSettingsFile: runtimeConfig.settings.file,
    instructionsFile,
    hookCommand: USAGE_HOOK_COMMAND,
    hookJson: {
      hooks: usageHooksBlock({ hookCommand: USAGE_HOOK_COMMAND }),
    },
    fallbackInstruction: usageFallbackInstruction(USAGE_LOG_FILE),
    prompt: usageTrackingSetupPrompt({
      usageLogFile: USAGE_LOG_FILE,
      claudeSettingsFile: CLAUDE_SETTINGS_FILE,
      lairSettingsFile: runtimeConfig.settings.file,
      instructionsFile,
      hookCommand: USAGE_HOOK_COMMAND,
    }),
  };
}

function internalSkills() {
  return listSkills({
    agentsHome: AGENTS_HOME,
    claudeHome: CLAUDE_HOME,
    includeFiles: true,
  });
}

function publicSkillRecord(skill) {
  const {
    directory: _directory,
    skillFile: _skillFile,
    skillsRoot: _skillsRoot,
    modifiedAt: _modifiedAt,
    ...record
  } = skill;
  return record;
}

async function annotatedSkills(settings = loadSettings()) {
  const skills = internalSkills();
  const usage = await aggregateUsageLog(USAGE_LOG_FILE);
  const lint = lintSkills(skills);
  const [lastTouched, repoStatus] = await Promise.all([
    lastTouchedForSkills(skills.filter((skill) => skill.kind === 'personal')),
    skillsRepoStatus(PERSONAL_SKILLS_ROOT),
  ]);
  const ratingsResult = runtimeConfig.skillRatings.read();
  const ratings = ratingsResult.value.ratings || {};
  return {
    skills: skills.map((skill) => {
      const skillUsage = usage.byKey[eventKey('skill', skill.name)] || null;
      const rating = ratings[skill.id] || { positive: 0, negative: 0 };
      let staleFindings = [];
      try {
        if (skill.skillFile) staleFindings = scanStaleContent(fs.readFileSync(skill.skillFile, 'utf8'));
      } catch {
        // The registry lint already reports unreadable skill files.
      }
      const baseLint = lint.get(skill.id) || { level: 'ok', findings: [] };
      const findings = [...baseLint.findings, ...staleFindings];
      return {
        ...publicSkillRecord(skill),
        canManage: skill.kind === 'personal',
        usage: skillUsage,
        cold: isColdUsage({
          usage: skillUsage,
          logStartedAt: usage.logStartedAt,
          coldSkillDays: DEFAULT_AI_WORKFLOW_SETTINGS.coldSkillDays,
        }),
        lint: {
          level: baseLint.level === 'error'
            ? 'error'
            : findings.length ? 'warn' : 'ok',
          findings,
        },
        rating,
        rewriteSuggested: Boolean(
          skillUsage?.count >= REWRITE_USAGE_THRESHOLD
          && rating.negative > rating.positive,
        ),
        lastTouchedAt: lastTouched.get(skill.id) || null,
      };
    }),
    archived: listArchivedSkills(PERSONAL_SKILLS_ROOT),
    usage: {
      enabled: true,
      events: usage.events,
      logStartedAt: usage.logStartedAt,
      malformedLines: usage.malformedLines,
    },
    ratingsError: ratingsResult.error,
    repoStatus,
    parity: harnessParity(skills),
  };
}

function knownProjectFolders() {
  return loadProjects().flatMap((project) => (
    (project.components || []).map((component) => component.cwd).filter(Boolean)
  ));
}

function instructionRecords(settings = loadSettings()) {
  return listInstructions({
    workspaceRoot: WORKSPACE_ROOT,
    projectFolders: knownProjectFolders(),
    workspaceFolders: settings.workspaceFolders,
  }).map((instruction) => {
    let staleFindings = [];
    try { staleFindings = scanStaleContent(fs.readFileSync(instruction.path, 'utf8')); }
    catch { /* the file may have disappeared after the registry scan */ }
    return { ...instruction, staleFindings };
  });
}

function currentWorkflowRepairPrompt(settings = loadSettings()) {
  const skills = internalSkills();
  const lint = lintSkills(skills);
  const findings = [];
  for (const skill of skills) {
    for (const finding of lint.get(skill.id)?.findings || []) {
      if (skill.skillFile) findings.push({ file: skill.skillFile, message: finding.message });
    }
    try {
      for (const finding of scanStaleContent(fs.readFileSync(skill.skillFile, 'utf8'))) {
        findings.push({ file: skill.skillFile, message: finding.message });
      }
    } catch {
      // Unreadable files are already represented by lint findings.
    }
  }
  for (const instruction of instructionRecords(settings)) {
    for (const finding of instruction.staleFindings) {
      findings.push({ file: instruction.path, message: finding.message });
    }
  }
  return workflowRepairPrompt({ findings });
}

function agentOpsProjectFolders(settings = loadSettings()) {
  return [...new Set([
    ...knownProjectFolders(),
    ...settings.workspaceFolders,
  ].map((folder) => path.resolve(folder)))];
}

function claudeSettingsSources(settings = loadSettings()) {
  return [
    { file: CLAUDE_SETTINGS_FILE, scope: 'user' },
    ...agentOpsProjectFolders(settings).flatMap((projectFolder) => [
      {
        file: path.join(projectFolder, '.claude', 'settings.json'),
        scope: 'project',
      },
      {
        file: path.join(projectFolder, '.claude', 'settings.local.json'),
        scope: 'project-local',
      },
    ]),
  ];
}

async function agentOpsSnapshot(settings = loadSettings()) {
  const projectFolders = agentOpsProjectFolders(settings);
  const [agents, commands, usage] = await Promise.all([
    Promise.resolve(listAgents({ claudeHome: CLAUDE_HOME, projectFolders })),
    Promise.resolve(listCommands({ claudeHome: CLAUDE_HOME, projectFolders })),
    aggregateUsageLog(USAGE_LOG_FILE),
  ]);
  const annotateUsage = (type, records) => records.map((record) => {
    const recordUsage = usage.byKey[eventKey(type, record.name)] || null;
    return {
      ...record,
      usage: recordUsage,
      cold: isColdUsage({
        usage: recordUsage,
        logStartedAt: usage.logStartedAt,
        coldSkillDays: DEFAULT_AI_WORKFLOW_SETTINGS.coldSkillDays,
      }),
    };
  });
  const hookStatus = inspectUsageHook({
    settingsFile: CLAUDE_SETTINGS_FILE,
    hookCommand: USAGE_HOOK_COMMAND,
  });
  return {
    agents: annotateUsage('agent', agents),
    commands: annotateUsage('command', commands),
    mcpServers: listMcpServers({ claudeHome: CLAUDE_HOME, projectFolders }),
    permissions: permissionsView({ claudeHome: CLAUDE_HOME, projectFolders }),
    hooks: listConfiguredHooks(claudeSettingsSources(settings)),
    memory: listMemoryEntries({ projectFolders }),
    coverage: projectCoverageMatrix(loadProjects()),
    parity: harnessParity(internalSkills()),
    usageHook: {
      installed: hookStatus.installed,
      conflict: hookStatus.conflict,
      error: hookStatus.error,
    },
  };
}

function configuredBrowserPath() {
  return process.env.BROWSER_PATH || process.env.FIREFOX_PATH || loadSettings().browserPath || '';
}

function environmentWithBrowser() {
  const browser = configuredBrowserPath();
  return browser ? { ...process.env, BROWSER: browser } : process.env;
}

// Apps stopped from the UI, remembered (with their command line + working dir)
// so they can be restarted. Persisted to disk so the list survives a restart.
let stopped = [];
try { stopped = JSON.parse(fs.readFileSync(STORE, 'utf8')); if (!Array.isArray(stopped)) stopped = []; } catch { stopped = []; }
function saveStopped() {
  try { fs.writeFileSync(STORE, JSON.stringify(stopped, null, 2)); } catch { /* best effort */ }
}
// Drop remembered apps whose first port is listening again — they're back.
function reconcileStopped(live) {
  const livePorts = new Set();
  for (const p of live) for (const x of p.ports) livePorts.add(x.port);
  const before = stopped.length;
  stopped = stopped.filter((s) => !(s.ports[0] && livePorts.has(s.ports[0].port)));
  if (stopped.length !== before) saveStopped();
}

// Never allow killing these — taking them down can break Windows itself.
// Pretty names for dev tools found in node_modules paths.
const PACKAGE_LABELS = {
  'vite': 'Vite', 'react-scripts': 'React (CRA)', 'next': 'Next.js', 'remix': 'Remix',
  'astro': 'Astro', 'nuxt': 'Nuxt', 'webpack': 'Webpack', 'webpack-dev-server': 'Webpack',
  'nodemon': 'nodemon', 'ts-node': 'ts-node', 'ts-node-dev': 'ts-node-dev', 'tsx': 'tsx',
  'turbo': 'Turborepo', 'parcel': 'Parcel', '@angular': 'Angular', 'expo': 'Expo',
  'storybook': 'Storybook', 'strapi': 'Strapi', 'nest': 'NestJS', '@nestjs': 'NestJS',
  'json-server': 'json-server', 'serve': 'serve', 'http-server': 'http-server',
  'live-server': 'live-server', 'npm': 'npm', 'pnpm': 'pnpm', 'yarn': 'yarn',
};

function splitArgs(cmd) {
  const re = /"([^"]*)"|(\S+)/g;
  const out = [];
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

// Derive "project · tool" or "folder · script.js" from a raw command line.
function friendlyLabel(cmd) {
  if (!cmd) return null;

  // Running something out of node_modules: grab project folder + package name.
  const pkgMatch = cmd.match(/([^\\/"]+)[\\/]node_modules[\\/](?:\.bin[\\/])?(@[^\\/"\s]+|[^\\/"\s]+)/i);
  if (pkgMatch) {
    const project = pkgMatch[1];
    const pkg = pkgMatch[2].toLowerCase();
    const tool = PACKAGE_LABELS[pkg] || pkg;
    if (/^(node(js)?|program files.*)$/i.test(project)) return tool;
    return `${project} · ${tool}`;
  }

  // Otherwise: first script-looking argument, shown with its parent folder.
  for (const arg of splitArgs(cmd).slice(1)) {
    if (!/\.(mjs|cjs|jsx?|tsx?|py)$/i.test(arg)) continue;
    const segs = arg.split(/[\\/]/).filter(Boolean);
    const script = segs[segs.length - 1];
    const parent = segs.length > 1 ? segs[segs.length - 2] : null;
    return parent && !/^(node(js)?|scripts|src|dist|build|bin)$/i.test(parent)
      ? `${parent} · ${script}`
      : script;
  }
  return null;
}

// Work out how to actually relaunch a stopped app. The captured command line is
// often an internal worker (e.g. Next.js forks start-server.js to bind the port),
// which can't just be re-run. So when the project has a package.json, prefer the
// matching `npm run <script>` — that's what the user ran to begin with.
function resolveRestart(entry) {
  const cwd = entry.cwd && fs.existsSync(entry.cwd) ? entry.cwd : null;
  const cmd = entry.cmd || '';

  if (cwd) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      const scripts = pkg.scripts || {};
      const names = Object.keys(scripts);
      if (names.length) {
        // A token identifying the tool/script that had been running.
        let token = '';
        const nm = cmd.match(/node_modules[\\/](?:\.bin[\\/])?(@[^\\/"\s]+|[^\\/"\s]+)/i);
        if (nm) token = nm[1].toLowerCase();
        else {
          const scriptFile = (cmd.match(/([^\\/"\s]+\.(?:mjs|cjs|jsx?|tsx?))(?:["\s]|$)/i) || [])[1];
          if (scriptFile) token = scriptFile.toLowerCase();
        }
        const rank = { dev: 0, start: 1, serve: 2 };
        const tokenMatch = token && names
          .filter((n) => String(scripts[n]).toLowerCase().includes(token))
          .sort((a, b) => (rank[a] ?? 9) - (rank[b] ?? 9))[0];
        const chosen = tokenMatch || (scripts.dev && 'dev') || (scripts.start && 'start');
        if (chosen) return { command: `npm run ${chosen}`, cwd, via: `npm run ${chosen}` };
      }
    } catch { /* no/invalid package.json — fall back to the raw command */ }
  }

  if (cmd) return { command: cmd, cwd, via: 'saved command' };
  return null;
}

// Best guess at the folder an app should be restarted from.
function deriveCwd(cmd, exePath) {
  for (const arg of splitArgs(cmd)) {
    const m = arg.match(/^(.*[\\/][^\\/]+)[\\/]node_modules[\\/]/i);
    if (m) return m[1]; // the project folder that owns node_modules
  }
  for (const arg of splitArgs(cmd).slice(1)) {
    if (/\.(mjs|cjs|jsx?|tsx?|py)$/i.test(arg) && path.isAbsolute(arg)) {
      return path.dirname(arg); // absolute script path -> its directory
    }
  }
  if (exePath && /[\\/]/.test(exePath)) return path.dirname(exePath);
  return null;
}

// pid -> { cmd, exePath } ('' when unavailable). These are immutable per
// process, so cache them and only query CIM for PIDs we haven't seen.
const cmdCache = new Map();
const cpuSamples = new Map();
let systemCache = { at: 0, data: null };

async function getCommandLines(pids) {
  const alive = new Set(pids);
  for (const pid of cmdCache.keys()) if (!alive.has(pid)) cmdCache.delete(pid);

  const missing = pids.filter((pid) => !cmdCache.has(pid));
  if (missing.length) {
    try {
      for (const row of await platform.processDetails(missing)) {
        cmdCache.set(row.pid, { cmd: row.cmd || '', exePath: row.exePath || '' });
      }
    } catch { /* access denied or CIM hiccup — fall back to exe names */ }
    for (const pid of missing) if (!cmdCache.has(pid)) cmdCache.set(pid, { cmd: '', exePath: '' });
  }
  return cmdCache;
}

async function getProcessMetrics(pids) {
  const metrics = new Map();
  // Prune samples by age, not by the pids in *this* call: within one poll we call
  // this for listeners and (separately) for command-line-tracked apps, and keying
  // the prune on "last seen" keeps those two pid subsets from wiping each other's
  // CPU baselines. Dead pids fall out once they go 60s without an update.
  const pruneNow = Date.now();
  for (const [pid, s] of cpuSamples) if (pruneNow - s.sampledAt > 60000) cpuSamples.delete(pid);
  if (!pids.length) return metrics;

  try {
    const rows = await platform.processDetails(pids);
    const now = Date.now();
    const cpuCount = Math.max(os.cpus().length, 1);

    for (const row of rows) {
      const pid = Number(row.pid);
      if (!Number.isInteger(pid)) continue;

      const cpuTimeSeconds = Number(row.cpuTimeSeconds) || 0;
      const previous = cpuSamples.get(pid);
      let cpuPercent = null;
      if (previous && cpuTimeSeconds >= previous.cpuTimeSeconds) {
        const elapsedSeconds = (now - previous.sampledAt) / 1000;
        if (elapsedSeconds > 0) {
          cpuPercent = Math.max(0, ((cpuTimeSeconds - previous.cpuTimeSeconds) / elapsedSeconds) * (100 / cpuCount));
        }
      }
      cpuSamples.set(pid, { cpuTimeSeconds, sampledAt: now });

      const startedAt = Number(row.startedAt);
      metrics.set(pid, {
        startedAt: Number.isFinite(startedAt) ? startedAt : null,
        uptimeSeconds: Number.isFinite(Number(row.uptimeSeconds))
          ? Number(row.uptimeSeconds)
          : Number.isFinite(startedAt) ? Math.max(0, Math.floor((now - startedAt) / 1000)) : null,
        cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : null,
        cpuTimeSeconds,
        workingSetKB: Number(row.workingSetKB) || 0,
      });
    }
  } catch {
    // Best-effort telemetry. Process control still works without CIM access.
  }

  return metrics;
}

async function getSystemStats() {
  const now = Date.now();
  if (systemCache.data && now - systemCache.at < 2500) return systemCache.data;

  const fallbackMemory = {
    totalKB: Math.round(os.totalmem() / 1024),
    freeKB: Math.round(os.freemem() / 1024),
  };
  let data = {
    node: os.hostname(),
    status: 'ONLINE',
    mode: 'PROCESS CONTROL',
    pid: process.pid,
    port: currentPort,
    cpuPercent: null,
    memory: {
      ...fallbackMemory,
      usedPercent: fallbackMemory.totalKB
        ? ((fallbackMemory.totalKB - fallbackMemory.freeKB) / fallbackMemory.totalKB) * 100
        : null,
    },
  };

  try {
    const row = await platform.systemStats();
    if (row) {
      const totalKB = Number(row.totalMemoryKB) || fallbackMemory.totalKB;
      const freeKB = Number(row.freeMemoryKB) || fallbackMemory.freeKB;
      data = {
        ...data,
        cpuPercent: Number.isFinite(Number(row.cpuPercent)) ? Number(row.cpuPercent) : null,
        memory: {
          totalKB,
          freeKB,
          usedPercent: totalKB ? ((totalKB - freeKB) / totalKB) * 100 : null,
        },
      };
    }
  } catch {
    // Keep the fast Node fallback if CIM is unavailable.
  }

  systemCache = { at: now, data };
  return data;
}

function run(cmd, args) {
  return platform.execFile(cmd, args);
}

function runConfiguredCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    exec(command, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
      timeout: CONFIGURED_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || stdout.trim() || err.message));
      else resolve(stdout);
    });
  });
}

async function getListeners() {
  const snapshot = await platform.networkSnapshot();
  const listenerPids = snapshot.listeners.map((listener) => listener.pid);

  // Command lines only matter for identifying user apps — skip system ones.
  const userPids = snapshot.listeners
    .filter((listener) => !platform.isSystemProcess(listener.pid, listener.name, process.pid))
    .map((listener) => listener.pid);
  const [cmds, metrics] = await Promise.all([
    getCommandLines(userPids),
    getProcessMetrics(listenerPids),
  ]);

  const result = snapshot.listeners.map((info) => {
    const { pid } = info;
    const isProtected = platform.isProtectedProcess(pid, info.name, process.pid);
    const { cmd, exePath } = cmds.get(pid) || { cmd: '', exePath: '' };
    const metric = metrics.get(pid) || {};
    return {
      pid,
      name: info.name,
      label: pid === process.pid ? "Hacker's Lair" : friendlyLabel(cmd),
      cmd,
      exePath,
      cwd: deriveCwd(cmd, exePath),
      memKB: metric.workingSetKB || info.memKB,
      startedAt: metric.startedAt || null,
      uptimeSeconds: metric.uptimeSeconds ?? null,
      cpuPercent: metric.cpuPercent ?? null,
      cpuTimeSeconds: metric.cpuTimeSeconds ?? null,
      self: pid === process.pid,
      protected: isProtected,
      system: platform.isSystemProcess(pid, info.name, process.pid),
      ports: info.ports.slice().sort((left, right) => left.port - right.port),
    };
  });

  // User processes first, then by lowest port.
  result.sort((a, b) => (a.system - b.system) || (a.ports[0].port - b.ports[0].port));
  return result;
}

async function liveProjectPortConflicts(projects, originalProjects = []) {
  if (!projects.length) return [];
  const listeners = await getListeners();
  const originalsByName = new Map(originalProjects.map((project) => (
    [String(project.name).toLowerCase(), project]
  )));
  const conflicts = projects.flatMap((project) => {
    const originalProject = originalsByName.get(String(project.name).toLowerCase())
      || (projects.length === 1 && originalProjects.length === 1 ? originalProjects[0] : undefined);
    return findProjectPortConflicts({ project, originalProject, listeners });
  });
  const seen = new Set();
  return conflicts.filter((conflict) => {
    const key = `${conflict.port}:${conflict.pid ?? 'unknown'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rejectProjectPortConflicts(res, conflicts) {
  if (!conflicts.length) return false;
  json(res, 409, {
    error: describeProjectPortConflicts(conflicts),
    portConflicts: conflicts,
  });
  return true;
}

// ---- Coding projects (projects.json) ---------------------------------------

function loadTimestampMap(file, fallback = {}) {
  try {
    const values = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (values && typeof values === 'object' && !Array.isArray(values)) return values;
  } catch { /* use fallback */ }
  return { ...fallback };
}

function saveTimestampMap(file, values) {
  try { fs.writeFileSync(file, JSON.stringify(values, null, 2)); } catch { /* best effort */ }
}

// Starts and all successful project actions are tracked separately so a recent
// termination can lead the dormant group without changing lastStartedAt.
const STARTED_FILE = path.join(DATA_DIR, 'started.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'project-activity.json');
let startedTimes = loadTimestampMap(STARTED_FILE);
let projectActivityTimes = loadTimestampMap(ACTIVITY_FILE, startedTimes);

function saveStartedTimes() {
  saveTimestampMap(STARTED_FILE, startedTimes);
}

function recordProjectActivity(name, timestamp = Date.now()) {
  projectActivityTimes[name] = timestamp;
  saveTimestampMap(ACTIVITY_FILE, projectActivityTimes);
}

// Read fresh each call so edits apply without a restart. Invalid JSON keeps the
// last known-good value and exposes the parse failure through the API.
function loadProjects() {
  return runtimeConfig.projects.read().value.projects;
}

function projectsConfigError() {
  return runtimeConfig.projects.read().error;
}

async function refreshDoctor() {
  const settings = runtimeConfig.settings.read();
  const scripts = runtimeConfig.scripts.read();
  const projects = runtimeConfig.projects.read();
  doctorSnapshot = await runDoctor({
    dataDirectory: DATA_DIR,
    projects: projects.value.projects,
    configErrors: [projects.error, scripts.error, settings.error],
    installChannel: process.env.LAIR_INSTALL_CHANNEL || (process.versions.electron ? 'portable' : 'source'),
    port: currentPort,
    agentsHome: AGENTS_HOME,
    claudeHome: CLAUDE_HOME,
    instructionFiles: [
      path.join(WORKSPACE_ROOT, 'AGENTS.md'),
      path.join(AGENTS_HOME, 'AGENTS.md'),
      path.join(CLAUDE_HOME, 'AGENTS.md'),
    ],
  });
  return doctorSnapshot;
}

// Legacy components are matched by command line so apps that share a default
// port can still be told apart. Docker stacks can instead declare `ports`; those
// ports become their authoritative readiness signal because Docker Desktop's
// listener processes do not include the project path in their command lines.
function listenersFor(component, listeners) {
  const needle = String(component.match || component.cwd || '').toLowerCase();
  if (!needle) return [];
  return listeners.filter((l) => (l.cmd || '').toLowerCase().includes(needle));
}

function configuredPorts(component) {
  const values = Array.isArray(component.ports) ? component.ports : [component.port];
  return [...new Set(values
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))];
}

function configuredPortListeners(component, listeners) {
  const expectedPorts = new Set(configuredPorts(component));
  if (!expectedPorts.size) return [];
  return listeners.filter((listener) => listener.ports.some((port) => expectedPorts.has(port.port)));
}

function usesConfiguredPortDetection(component) {
  return component.detectByPort === true || Array.isArray(component.ports);
}

function liveConfiguredPorts(component, listeners) {
  const expectedPorts = new Set(configuredPorts(component));
  return new Set(configuredPortListeners(component, listeners)
    .flatMap((listener) => listener.ports.map((port) => port.port))
    .filter((port) => expectedPorts.has(port)));
}

function allConfiguredPortsDetected(component, listeners) {
  if (!usesConfiguredPortDetection(component)) return false;
  const expectedPorts = configuredPorts(component);
  const livePorts = liveConfiguredPorts(component, listeners);
  return expectedPorts.length > 0 && expectedPorts.every((port) => livePorts.has(port));
}

function anyConfiguredPortDetected(component, listeners) {
  return usesConfiguredPortDetection(component) && liveConfiguredPorts(component, listeners).size > 0;
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function remainingProjectSignals(project) {
  const listeners = await getListeners();
  const tracked = await getTrackedProcesses([project]);
  const remaining = [];

  for (const component of project.components || []) {
    const pool = component.track === 'process' ? tracked : listeners;
    const hits = listenersFor(component, pool);
    const ports = [...liveConfiguredPorts(component, listeners)].sort((left, right) => left - right);
    if (hits.length || ports.length) {
      remaining.push({
        component: component.name,
        ports,
        pids: [...new Set(hits.map((hit) => hit.pid))].sort((left, right) => left - right),
      });
    }
  }
  return remaining;
}

async function waitForProjectStop(project) {
  const deadline = Date.now() + PROJECT_STOP_VERIFY_TIMEOUT_MS;
  while (true) {
    invalidateProcessSnapshot();
    const remaining = await remainingProjectSignals(project);
    if (!remaining.length || Date.now() >= deadline) return remaining;
    await pause(PROJECT_STOP_VERIFY_INTERVAL_MS);
  }
}

// Components flagged `"track": "process"` don't bind a port — a background
// script, a bot, a worker. getListeners() can't see them (it only inspects
// LISTENING sockets), so scan every process's command line instead and return
// entries shaped exactly like a listener (with ports: []). That lets detection,
// telemetry, and stop treat port-bound services and headless scripts the same.
async function getTrackedProcesses(projects) {
  const needles = [];
  for (const proj of projects)
    for (const c of proj.components || [])
      if (c.track === 'process' && (c.match || c.cwd))
        needles.push(String(c.match || c.cwd).toLowerCase());
  if (!needles.length) return [];

  const rows = await getProcessSnapshot();

  const matched = rows.filter((r) => {
    const cmd = String(r.cmd || '').toLowerCase();
    return needles.some((n) => cmd.includes(n));
  });
  if (!matched.length) return [];

  const pids = matched.map((r) => Number(r.pid)).filter(Number.isInteger);
  const metrics = await getProcessMetrics(pids);

  return matched.map((r) => {
    const pid = Number(r.pid);
    const cmd = String(r.cmd || '');
    const exePath = String(r.exePath || '');
    const m = metrics.get(pid) || {};
    return {
      pid,
      name: r.name || `PID ${pid}`,
      label: friendlyLabel(cmd),
      cmd,
      exePath,
      cwd: deriveCwd(cmd, exePath),
      memKB: m.workingSetKB || 0,
      startedAt: m.startedAt || null,
      uptimeSeconds: m.uptimeSeconds ?? null,
      cpuPercent: m.cpuPercent ?? null,
      cpuTimeSeconds: m.cpuTimeSeconds ?? null,
      self: pid === process.pid,
      protected: platform.isProtectedProcess(pid, r.name, process.pid),
      ports: [],
    };
  });
}

// ---- Optional AutoIt macro scripts -----------------------------------------

function loadScriptsConfig() {
  const result = runtimeConfig.scripts.read();
  const data = result.value;
  return {
    scriptsDir: typeof data.scriptsDir === 'string' ? data.scriptsDir : '',
    autoItExe: typeof data.autoItExe === 'string' ? data.autoItExe : '',
    descriptions: data.descriptions && typeof data.descriptions === 'object' ? data.descriptions : {},
    error: result.error,
  };
}

// Find AutoIt3.exe: prefer the configured path, then the usual install spots.
function resolveAutoItExe(configured) {
  return platform.resolveScriptRuntime(configured);
}

// Every .au3 in the folder, newest-modified first (the UI's "new to old").
function listScriptFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.au3$/i.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        let modifiedAt = 0;
        try { modifiedAt = fs.statSync(full).mtimeMs; } catch { /* keep 0 */ }
        return { file: f, path: full, modifiedAt };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  } catch { return []; }
}

// Running AutoIt processes with their command line + a little telemetry, in one
// CIM call. A script is "on" when some process's command line contains its path.
async function getScriptProcesses() {
  try {
    return (await platform.scriptProcesses()).map((row) => ({
      pid: row.pid,
      cmd: row.cmd,
      uptimeSeconds: row.uptimeSeconds,
      workingSetKB: row.workingSetKB,
    }));
  } catch { return []; }
}

// PIDs of AutoIt processes launched with a given .au3 path. Every filename ends
// in ".au3" and none is a prefix of another with that suffix, so a plain
// case-insensitive substring match on the full path is unambiguous.
function pidsForScript(scriptPath, procs) {
  const needle = scriptPath.toLowerCase();
  return procs.filter((p) => p.cmd.toLowerCase().includes(needle)).map((p) => p.pid);
}

async function getScripts() {
  const cfg = loadScriptsConfig();
  const files = cfg.scriptsDir ? listScriptFiles(cfg.scriptsDir) : [];
  if (!files.length) return [];
  const procs = await getScriptProcesses();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  return files.map((f) => {
    const pids = pidsForScript(f.path, procs);
    const primary = byPid.get(pids[0]);
    return {
      file: f.file,
      name: f.file.replace(/\.au3$/i, ''),
      path: f.path,
      description: cfg.descriptions[f.file] || 'AutoIt macro script.',
      modifiedAt: f.modifiedAt,
      running: pids.length > 0,
      pids,
      pid: pids.length === 1 ? pids[0] : null,
      uptimeSeconds: primary ? primary.uptimeSeconds : null,
      memKB: pids.reduce((sum, pid) => sum + ((byPid.get(pid)?.workingSetKB) || 0), 0),
    };
  });
}

// ---- Launch tracking: capture output + notice early crashes -----------------

const LOG_DIR = path.join(DATA_DIR, 'logs');
const logStore = new LogStore(LOG_DIR, { maxBytes: MAX_COMPONENT_LOG_BYTES });

// key `${project}::${component}` -> { status, reason, logFile, startedAt, pid }
// status: 'starting' | 'running' | 'errored'
const launches = new Map();
const telemetryHistory = new Map();
const launchKey = (proj, comp) => `${proj}::${comp}`;
const MAX_TELEMETRY_POINTS = 60;

function configuredComponentLogFiles(projects = loadProjects()) {
  return new Set(projects.flatMap((project) => (
    (project.components || []).map((component) => (
      logStore.componentFile(project.name, component.name)
    ))
  )));
}

// Pull the meaningful error out of a component's log. Node prints the message
// at the top of its crash (above the stack); Python puts the real exception at
// the bottom of the traceback — so look for a thrown-error line from the bottom
// up, and fall back to the broad-signature first match, then the last lines.
function tailLog(file, code) {
  try {
    const txt = fs.readFileSync(file, 'utf8').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''); // strip ANSI
    const lines = txt.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length);
    if (!lines.length) return `Exited with code ${code} and no output.`;

    const strong = /(^|\s)[\w.]*(Error|Exception|Warning):/;   // "XxxError: message"
    const hard = /EADDRINUSE|EACCES|ENOENT|No module named|command not found|is not recognized|BUILD FAILURE|MODULE_NOT_FOUND/i;
    const broad = /error|exception|cannot|refused|denied|missing|no such|traceback|failed|fatal/i;
    const lastMatch = (re) => { for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return i; return -1; };

    let idx = lastMatch(strong);
    if (idx === -1) idx = lastMatch(hard);
    if (idx === -1) idx = lines.findIndex((l) => broad.test(l));
    if (idx === -1) return lines.slice(-8).join('\n');

    return lines.slice(idx, idx + 6).join('\n');   // headline first, then a little context
  } catch { return `Exited with code ${code}.`; }
}

async function openBrowserUrl(url) {
  const browser = configuredBrowserPath();
  await platform.openUrl(url, browser);
  return browser || 'system default';
}

function launchProjectComponent(project, component, options = {}) {
  if (!component.command || !component.cwd || !fs.existsSync(component.cwd)) {
    const reason = `Missing command or folder: ${component.cwd || '(no cwd)'}`;
    launches.set(launchKey(project.name, component.name), {
      status: 'errored',
      reason,
      logFile: '',
      startedAt: Date.now(),
      pid: null,
    });
    return { started: false, reason };
  }

  const logFile = logStore.componentFile(project.name, component.name);
  const restartCount = Number(options.restartCount) || 0;
  const rec = {
    status: 'starting',
    reason: restartCount ? `Auto-restart attempt ${restartCount}` : '',
    logFile,
    startedAt: Date.now(),
    pid: null,
    restartCount,
    nextRestartAt: null,
    everRunning: false,
    crashEvent: options.crashEvent || null,
  };
  launches.set(launchKey(project.name, component.name), rec);

  let outFd = 'ignore';
  let errFd = 'ignore';
  try {
    logStore.prepare(logFile, {
      append: restartCount > 0,
      heading: restartCount ? `\n--- auto-restart attempt ${restartCount} ---\n` : '',
    });
    [outFd, errFd] = logStore.openAppendDescriptors(logFile);
  } catch {
    outFd = 'ignore';
    errFd = 'ignore';
  }
  const closeFds = () => {
    for (const descriptor of [outFd, errFd]) {
      if (typeof descriptor === 'number') {
        try { fs.closeSync(descriptor); } catch { /* ignore */ }
      }
    }
  };

  try {
    const child = spawn(component.command, {
      cwd: component.cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
      env: environmentWithBrowser(),
    });
    rec.pid = child.pid;
    child.on('error', (error) => {
      closeFds();
      rec.status = 'errored';
      rec.reason = error.message;
    });
    child.on('exit', (code) => {
      closeFds();
      const unexpected = (
        rec.everRunning
        && !shuttingDown
        && !actionLocks.has(`project:${project.name}`)
      );
      const maxRestarts = Math.min(Math.max(Number(component.maxRestarts) || 3, 1), 10);
      if (unexpected) {
        const nextAttempt = rec.restartCount + 1;
        rec.crashEvent = {
          id: `${Date.now()}-${project.name}-${component.name}`,
          at: Date.now(),
          code,
          restarting: component.autoRestart === true && nextAttempt <= maxRestarts,
          attempt: nextAttempt,
          maxRestarts,
        };
        if (rec.crashEvent.restarting) {
          const delay = Math.min(30_000, 1_000 * (2 ** (nextAttempt - 1)));
          rec.status = 'restarting';
          rec.reason = `Exited with code ${code}; retry ${nextAttempt}/${maxRestarts} in ${Math.ceil(delay / 1000)}s.`;
          rec.nextRestartAt = Date.now() + delay;
          const crashEvent = rec.crashEvent;
          setTimeout(() => {
            if (!shuttingDown && !actionLocks.has(`project:${project.name}`)) {
              launchProjectComponent(project, component, { restartCount: nextAttempt, crashEvent });
            }
          }, delay).unref?.();
          return;
        }
      }
      if (rec.status === 'starting' || unexpected) {
        setTimeout(() => {
          rec.status = 'errored';
          rec.reason = tailLog(logFile, code);
        }, 150);
      }
    });
    child.unref();
    return { started: true, pid: child.pid };
  } catch (error) {
    closeFds();
    rec.status = 'errored';
    rec.reason = error.message;
    return { started: false, reason: error.message };
  }
}

function recordTelemetry(projectName, cpuPercent, memKB) {
  const now = Date.now();
  const history = telemetryHistory.get(projectName) || [];
  if (!history.length || now - history[history.length - 1].at >= 2_500) {
    history.push({
      at: now,
      cpuPercent: Number.isFinite(cpuPercent) ? Math.round(cpuPercent * 10) / 10 : null,
      memKB: Math.max(0, Math.round(Number(memKB) || 0)),
    });
    if (history.length > MAX_TELEMETRY_POINTS) history.splice(0, history.length - MAX_TELEMETRY_POINTS);
    telemetryHistory.set(projectName, history);
  }
  return history;
}

function annotateProjects(projects, listeners, tracked = []) {
  const settings = loadSettings();
  return projects.map((proj) => {
    const gitAttention = gitAttentionForProject(proj);
    const components = (proj.components || []).map((c) => {
      const hits = listenersFor(c, c.track === 'process' ? tracked : listeners);
      const expectedPorts = configuredPorts(c);
      const usesPortDetection = usesConfiguredPortDetection(c);
      const requiresReadyPort = c.track === 'process' && expectedPorts.length > 0;
      const readinessListeners = usesPortDetection || requiresReadyPort
        ? configuredPortListeners(c, listeners)
        : [];
      const liveReadinessPorts = [...liveConfiguredPorts(c, listeners)];
      const detectedByPort = allConfiguredPortsDetected(c, listeners);
      const partiallyDetectedByPort = anyConfiguredPortDetected(c, listeners) && !detectedByPort;
      const running = detectedByPort || (hits.length > 0 && (!requiresReadyPort || readinessListeners.length > 0));
      const rec = launches.get(launchKey(proj.name, c.name));
      if (running && rec) {
        rec.status = 'running';
        rec.reason = '';
        rec.everRunning = true;
      }

      let status = 'stopped';
      let error = '';
      if (running) status = 'running';
      else if (rec && rec.status === 'errored') { status = 'errored'; error = rec.reason || 'Failed to start.'; }
      else if ((rec && rec.status === 'starting') || hits.length || partiallyDetectedByPort) status = 'starting';

      const pids = [...new Set([
        ...hits.map((l) => l.pid),
        ...(rec && Number.isInteger(rec.pid) ? [rec.pid] : []),
      ])].sort((a, b) => a - b);
      const cpuValues = hits.map((l) => l.cpuPercent).filter((v) => Number.isFinite(v));
      const startedAt = hits.map((l) => l.startedAt).filter(Boolean).sort((a, b) => a - b)[0]
        || (rec && rec.startedAt) || null;
      const uptimeValues = hits.map((l) => l.uptimeSeconds).filter((v) => Number.isFinite(v));
      const relevantPorts = new Set([...expectedPorts, ...liveReadinessPorts]);
      const establishedConnections = listeners
        .flatMap((listener) => listener.ports)
        .filter((port) => relevantPorts.has(port.port))
        .reduce((sum, port) => sum + (port.establishedConnections || 0), 0);
      const zombieAfterHours = Number(c.zombieAfterHours) || settings.zombieAfterHours;
      const uptimeSeconds = uptimeValues.length ? Math.max(...uptimeValues) : null;
      if (running && rec && uptimeSeconds >= 60 && rec.restartCount) rec.restartCount = 0;
      const zombie = isZombieComponent({
        running,
        uptimeSeconds,
        establishedConnections,
        thresholdHours: zombieAfterHours,
      });
      const componentLivePorts = [...new Set(
        [
          ...hits.flatMap((listener) => listener.ports.map((port) => port.port)),
          ...liveReadinessPorts,
        ],
      )].sort((a, b) => a - b);
      const targetUrls = splitTargetUrls({
        active: running || status === 'starting',
        configuredPorts: expectedPorts,
        livePorts: componentLivePorts,
        logUrls: detectedUrlsFromLog(rec?.logFile),
      });
      const portConflicts = status === 'errored' && /EADDRINUSE|address already in use/i.test(error)
        ? expectedPorts.flatMap((port) => listeners
          .filter((listener) => listener.ports.some((entry) => entry.port === port))
          .map((listener) => ({
            port,
            pid: listener.pid,
            name: listener.label || listener.name,
            protected: listener.protected || listener.self,
          })))
        : [];

      return {
        name: c.name,
        role: c.role || '',
        port: c.port || expectedPorts[0] || null,
        ports: expectedPorts,
        uiPorts: configuredPorts({ ports: c.uiPorts }),
        backendPorts: configuredPorts({ ports: c.backendPorts }),
        command: c.command || '',
        cwd: c.cwd || '',
        match: c.match || '',
        running,
        status,
        error,
        pids,
        pid: pids.length === 1 ? pids[0] : null,
        path: (hits.find((l) => l.exePath)?.exePath) || c.cwd || '',
        exePath: (hits.find((l) => l.exePath)?.exePath) || '',
        memKB: hits.reduce((sum, l) => sum + (Number(l.memKB) || 0), 0),
        cpuPercent: cpuValues.length ? cpuValues.reduce((sum, value) => sum + value, 0) : null,
        startedAt,
        uptimeSeconds,
        establishedConnections,
        zombie,
        zombieAfterHours,
        detectedUrls: targetUrls.detectedUrls,
        configuredPorts: targetUrls.configuredPorts,
        hasLog: Boolean(rec?.logFile && fs.existsSync(rec.logFile)),
        portConflicts,
        autoRestart: c.autoRestart === true,
        restartAttempt: rec?.restartCount || 0,
        nextRestartAt: rec?.nextRestartAt || null,
        crashEvent: rec?.crashEvent || null,
        lastActionAt: (rec && rec.startedAt) || startedTimes[proj.name] || 0,
        livePorts: componentLivePorts,
      };
    });
    const runningCount = components.filter((c) => c.running).length;
    const pids = [...new Set(components.flatMap((c) => c.pids || []))].sort((a, b) => a - b);
    const cpuValues = components.map((c) => c.cpuPercent).filter((v) => Number.isFinite(v));
    const uptimeValues = components.map((c) => c.uptimeSeconds).filter((v) => Number.isFinite(v));
    const projectResult = {
      name: proj.name,
      type: proj.type || '',
      gitBranches: [...new Set(gitAttention.repositories.map((repository) => repository.branch).filter(Boolean))],
      gitAttention,
      components,
      running: runningCount > 0,
      partial: runningCount > 0 && runningCount < components.length,
      errored: components.some((c) => c.status === 'errored'),
      starting: components.some((c) => c.status === 'starting'),
      lastStartedAt: startedTimes[proj.name] || 0,
      lastActionAt: Math.max(projectActivityTimes[proj.name] || 0, ...components.map((c) => c.lastActionAt || 0)),
      pids,
      pid: pids.length === 1 ? pids[0] : null,
      memKB: components.reduce((sum, c) => sum + (Number(c.memKB) || 0), 0),
      cpuPercent: cpuValues.length ? cpuValues.reduce((sum, value) => sum + value, 0) : null,
      uptimeSeconds: uptimeValues.length ? Math.max(...uptimeValues) : null,
    };
    projectResult.telemetry = recordTelemetry(proj.name, projectResult.cpuPercent, projectResult.memKB);
    projectResult.zombie = components.some((component) => component.zombie);
    projectResult.establishedConnections = components.reduce(
      (sum, component) => sum + component.establishedConnections,
      0,
    );
    return projectResult;
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

let processSnapshot = { readAt: 0, rows: [], pending: null };

async function getProcessSnapshot() {
  if (Date.now() - processSnapshot.readAt < PROCESS_SNAPSHOT_TTL_MS) {
    return processSnapshot.rows;
  }
  if (processSnapshot.pending) return processSnapshot.pending;

  processSnapshot.pending = (async () => {
    try {
      processSnapshot.rows = (await platform.processDetails())
        .filter((row) => row.cmd);
    } catch {
      processSnapshot.rows = [];
    }
    processSnapshot.readAt = Date.now();
    return processSnapshot.rows;
  })().finally(() => { processSnapshot.pending = null; });
  return processSnapshot.pending;
}

function invalidateProcessSnapshot() {
  processSnapshot.readAt = 0;
}

let currentPort = PORT;
const actionLocks = new Set();
let shuttingDown = false;

function securityHeaders() {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src 'nonce-${runtimeIdentity.cspNonce}'`,
      `style-src 'nonce-${runtimeIdentity.cspNonce}'`,
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, 'http://localhost');
    const { pathname } = requestUrl;
    if (!allowedHost(req.headers.host, currentPort)) {
      json(res, 403, { error: 'Forbidden host' });
      return;
    }
    if (req.method === 'POST' && !isJsonContentType(req.headers['content-type'])) {
      json(res, 415, { error: 'POST requests require Content-Type: application/json' });
      return;
    }
    if (req.method === 'POST' && !validToken(req.headers['x-lair-token'], runtimeIdentity.token)) {
      json(res, 403, { error: 'Missing or invalid Hacker’s Lair API token' });
      return;
    }
    if (req.method === 'GET' && pathname === '/icon.ico') {
      res.writeHead(200, {
        'Content-Type': 'image/x-icon',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(fs.readFileSync(path.join(__dirname, 'icon.ico')));
      return;
    }
    if (req.method === 'GET' && pathname === '/third-party-notices.txt') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(fs.readFileSync(path.join(__dirname, 'THIRD_PARTY_NOTICES.txt'), 'utf8'));
      return;
    }
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const template = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders() });
      res.end(renderApplicationHtml(template, runtimeIdentity, currentPort));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/identity') {
      json(res, 200, { app: runtimeIdentity.app, nonce: runtimeIdentity.nonce });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/service/shutdown') {
      json(res, 200, { ok: true });
      setImmediate(() => shutDownServer('desktop-request'));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/processes') {
      const processes = await getListeners();
      reconcileStopped(processes);
      json(res, 200, { self: process.pid, port: currentPort, processes, stopped });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/system') {
      json(res, 200, await getSystemStats());
      return;
    }

    if (req.method === 'GET' && req.url === '/api/local-models') {
      json(res, 200, await localModels.status());
      return;
    }

    if (req.method === 'GET' && req.url === '/api/local-models/setup-prompt') {
      json(res, 200, await localModels.setupPrompt());
      return;
    }

    if (req.method === 'POST' && [
      '/api/local-models/start',
      '/api/local-models/stop',
    ].includes(req.url)) {
      let id;
      try { id = String(JSON.parse(await readBody(req)).id || ''); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const actionKey = 'local-models';
      if (actionLocks.has(actionKey)) {
        json(res, 409, { error: 'A local model action is already in progress.' });
        return;
      }
      actionLocks.add(actionKey);
      try {
        const action = req.url.endsWith('/start') ? 'start' : 'stop';
        const result = await localModels[action](id);
        invalidateProcessSnapshot();
        json(res, 200, result);
      } catch (error) {
        json(res, Number(error.status) || 500, { error: error.message });
      } finally {
        actionLocks.delete(actionKey);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/open-ui') {
      let port;
      try { port = Number(JSON.parse(await readBody(req)).port); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        json(res, 400, { error: 'Port must be an integer from 1 to 65535' });
        return;
      }

      const url = `http://localhost:${port}/`;
      try {
        const browser = await openBrowserUrl(url);
        json(res, 200, { ok: true, browser, port, url });
      } catch (err) {
        json(res, 500, { error: `Could not open the browser: ${err.message}` });
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/api/projects') {
      const listeners = await getListeners();
      const projects = loadProjects();
      const tracked = await getTrackedProcesses(projects);
      const annotated = annotateProjects(projects, listeners, tracked);
      // Live targets always lead; recency orders targets within each group.
      annotated.sort(compareProjectsForDisplay);
      json(res, 200, { projects: annotated, configError: projectsConfigError() });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/projects/configure') {
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const actionKey = 'config:projects';
      if (actionLocks.has(actionKey)) {
        json(res, 409, { error: 'Project configuration is already being updated.' });
        return;
      }
      actionLocks.add(actionKey);
      try {
        const current = runtimeConfig.projects.read();
        if (current.error) {
          json(res, 409, { error: `Fix the current configuration first: ${current.error}` });
          return;
        }
        let next;
        const originalProject = (current.value.projects || []).find((project) => (
          project.name.toLowerCase() === String(input.originalName || '').trim().toLowerCase()
        ));
        try {
          next = updateProjectConfig(current.value, {
            originalName: input.originalName,
            project: input.project,
          });
          runtimeConfig.projects.validate(next);
        } catch (error) {
          json(res, 400, { error: error.message });
          return;
        }
        const saved = next.projects.find((project) => (
          project.name.toLowerCase() === String(input.project?.name || '').trim().toLowerCase()
        ));
        const portConflicts = await liveProjectPortConflicts(
          [saved],
          originalProject ? [originalProject] : [],
        );
        if (rejectProjectPortConflicts(res, portConflicts)) return;
        runtimeConfig.projects.write(next);
        void refreshGitAttention(next.projects);
        void refreshDoctor();
        json(res, 200, { ok: true, project: saved });
      } finally {
        actionLocks.delete(actionKey);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/projects/remove') {
      let name;
      try { name = String(JSON.parse(await readBody(req)).name || ''); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const actionKey = 'config:projects';
      if (actionLocks.has(actionKey)) {
        json(res, 409, { error: 'Project configuration is already being updated.' });
        return;
      }
      actionLocks.add(actionKey);
      try {
        const current = runtimeConfig.projects.read();
        if (current.error) {
          json(res, 409, { error: `Fix the current configuration first: ${current.error}` });
          return;
        }
        const project = current.value.projects.find((item) => item.name === name);
        if (!project) {
          json(res, 404, { error: `No project named "${name}"` });
          return;
        }
        if ((await remainingProjectSignals(project)).length) {
          json(res, 409, { error: 'Stop every component before removing this project.' });
          return;
        }
        const next = removeProjectFromConfig(current.value, name);
        runtimeConfig.projects.write(next);
        json(res, 200, { ok: true, name });
        void refreshGitAttention(next.projects);
        void refreshDoctor();
      } finally {
        actionLocks.delete(actionKey);
      }
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/projects/log')) {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const rec = launches.get(launchKey(q.get('name') || '', q.get('component') || ''));
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      let body = 'No log for this component (has it been started from here?).';
      try { if (rec && rec.logFile) body = fs.readFileSync(rec.logFile, 'utf8'); } catch { /* keep default */ }
      res.end(body);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/projects/start') {
      let name;
      try { name = String(JSON.parse(await readBody(req)).name); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const actionKey = `project:${name}`;
      if (actionLocks.has(actionKey)) {
        json(res, 409, { error: `An action for "${name}" is already in progress.` });
        return;
      }
      actionLocks.add(actionKey);
      try {

        const proj = loadProjects().find((p) => p.name === name);
        if (!proj) { json(res, 404, { error: `No project named "${name}"` }); return; }

      const listeners = await getListeners();
      const tracked = await getTrackedProcesses([proj]);
      const started = [], skipped = [], failed = [];
      for (const c of proj.components || []) {
        const pool = c.track === 'process' ? tracked : listeners;
        const detectedByPort = allConfiguredPortsDetected(c, listeners);
        if (listenersFor(c, pool).length || detectedByPort) { skipped.push(c.name); continue; } // already running
        const result = launchProjectComponent(proj, c);
        if (result.started) started.push(c.name);
        else failed.push(c.name);
      }
      // Bump the project to the top of the "recently started" order — only
      // when something actually launched, not for a no-op click.
      if (started.length) {
        const timestamp = Date.now();
        startedTimes[name] = timestamp;
        saveStartedTimes();
        recordProjectActivity(name, timestamp);
      }
        json(res, 200, { ok: true, name, started, skipped, failed });
      } finally {
        actionLocks.delete(actionKey);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/projects/stop') {
      let name;
      try { name = String(JSON.parse(await readBody(req)).name); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const actionKey = `project:${name}`;
      if (actionLocks.has(actionKey)) {
        json(res, 409, { error: `An action for "${name}" is already in progress.` });
        return;
      }
      actionLocks.add(actionKey);
      try {

        const proj = loadProjects().find((p) => p.name === name);
        if (!proj) { json(res, 404, { error: `No project named "${name}"` }); return; }

      // Some managed services (notably detached Docker Compose stacks) need a
      // service-aware shutdown after their launcher has exited. A launch record
      // proves the user started that component here, so its explicit stop
      // command is safe to run even when it has no detectable host process or
      // configured port.
      const listenersBeforeStop = await getListeners();
      const trackedBeforeStop = await getTrackedProcesses([proj]);
      const wasDetectedLive = (proj.components || []).some((c) => {
        const pool = c.track === 'process' ? trackedBeforeStop : listenersBeforeStop;
        return listenersFor(c, pool).length > 0 || anyConfiguredPortDetected(c, listenersBeforeStop);
      });
      const stoppedByCommand = [];
      const stopFailures = [];
      for (const c of proj.components || []) {
        if (!c.stopCommand) continue;
        const pool = c.track === 'process' ? trackedBeforeStop : listenersBeforeStop;
        const detectedByPort = anyConfiguredPortDetected(c, listenersBeforeStop);
        const launchedHere = launches.has(launchKey(name, c.name));
        if (!listenersFor(c, pool).length && !detectedByPort && !launchedHere) continue;
        if (!c.cwd || !fs.existsSync(c.cwd)) {
          stopFailures.push(`${c.name}: missing folder ${c.cwd || '(no cwd)'}`);
          continue;
        }
        try {
          await runConfiguredCommand(c.stopCommand, c.cwd);
          stoppedByCommand.push(c.name);
        } catch (err) {
          stopFailures.push(`${c.name}: ${err.message}`);
        }
      }

      // Only ever kill detected project processes (never an editor/terminal
      // that merely has the path open), and never ourselves or protected ones.
      invalidateProcessSnapshot();
      const listeners = await getListeners();
      const tracked = await getTrackedProcesses([proj]);
      const pids = new Set();
      for (const c of proj.components || []) {
        const pool = c.track === 'process' ? tracked : listeners;
        for (const l of listenersFor(c, pool)) {
          if (!l.self && !l.protected) pids.add(l.pid);
        }
      }
      let killed = 0;
      for (const pid of pids) {
        try { await platform.terminateProcess(pid); killed++; } catch { /* already gone */ }
      }
      invalidateProcessSnapshot();
      if (stopFailures.length) {
        json(res, 500, {
          error: `Graceful stop failed: ${stopFailures.join('; ')}`,
          name,
          stopped: killed + stoppedByCommand.length,
        });
        return;
      }

      const remaining = wasDetectedLive ? await waitForProjectStop(proj) : [];
      if (remaining.length) {
        const details = remaining.map((signal) => {
          const parts = [];
          if (signal.ports.length) parts.push(`ports ${signal.ports.join(', ')}`);
          if (signal.pids.length) parts.push(`PIDs ${signal.pids.join(', ')}`);
          return `${signal.component}: ${parts.join(' and ') || 'live signal detected'}`;
        });
        json(res, 409, {
          error: `Termination incomplete; target is still live (${details.join('; ')}). Check the configured stop command and runtime context.`,
          name,
          remaining,
        });
        return;
      }

      // Forget launch state only after every configured live signal disappears.
      for (const c of proj.components || []) launches.delete(launchKey(name, c.name));
      if (wasDetectedLive || stoppedByCommand.length) recordProjectActivity(name);
        json(res, 200, {
          ok: true,
          name,
          stopped: killed + stoppedByCommand.length,
          processesStopped: killed,
          commandsRun: stoppedByCommand,
        });
      } finally {
        actionLocks.delete(actionKey);
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/api/scripts') {
      const config = loadScriptsConfig();
      const settings = loadSettings();
      json(res, 200, {
        scripts: settings.enableScripts && platform.supportsScripts ? await getScripts() : [],
        enabled: settings.enableScripts,
        supported: platform.supportsScripts,
        configured: platform.supportsScripts && Boolean(config.scriptsDir),
        configError: config.error,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/onboarding') {
      const settings = loadSettings();
      const usageSetup = settings.enableSkills ? usageSetupState(settings) : null;
      const scriptsConfig = loadScriptsConfig();
      const scriptsAvailable = settings.enableScripts
        && platform.supportsScripts
        && !scriptsConfig.error
        && Boolean(scriptsConfig.scriptsDir);
      const selectedWorkspaceFolders = requestUrl.searchParams
        .getAll('workspaceFolder')
        .map((folder) => folder.trim())
        .filter((folder) => folder.length <= 1024)
        .slice(0, 10);
      json(res, 200, onboardingState({
        projectsFile: PROJECTS_FILE,
        projectsSchemaFile: runtimeConfig.projectsSchemaFile,
        projectsSchemaUrl: `http://localhost:${currentPort}/api/schema/projects`,
        agentsHome: AGENTS_HOME,
        projects: loadProjects(),
        skills: settings.enableSkills ? listSkills({ agentsHome: AGENTS_HOME }) : [],
        enableSkills: settings.enableSkills,
        workspaceFolders: [
          ...settings.workspaceFolders,
          ...selectedWorkspaceFolders,
        ],
        usageLogFile: usageSetup?.usageLogFile,
        claudeSettingsFile: usageSetup?.claudeSettingsFile,
        lairSettingsFile: usageSetup?.lairSettingsFile,
        instructionsFile: usageSetup?.instructionsFile || '',
        hookCommand: usageSetup?.hookCommand,
        hookInstalled: usageSetup?.hookInstalled ?? true,
        scriptsFile: SCRIPTS_FILE,
        scriptsDirectory: scriptsAvailable ? scriptsConfig.scriptsDir : '',
        scripts: scriptsAvailable ? listScriptFiles(scriptsConfig.scriptsDir) : [],
        scriptsSupported: platform.supportsScripts,
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/skills') {
      const settings = loadSettings();
      if (!settings.enableSkills) {
        json(res, 404, { error: 'The Skills view is disabled. Enable it in Settings.' });
        return;
      }
      json(res, 200, await annotatedSkills(settings));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/skills') {
      if (!loadSettings().enableSkills) {
        json(res, 404, { error: 'The Skills view is disabled. Enable it in Settings.' });
        return;
      }
      let name;
      try { name = String(JSON.parse(await readBody(req)).name || ''); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const actionKey = 'skills:write';
      if (actionLocks.has(actionKey)) {
        json(res, 409, { error: 'A Skills change is already in progress.' });
        return;
      }
      actionLocks.add(actionKey);
      try {
        const created = scaffoldSkill({ skillsRoot: PERSONAL_SKILLS_ROOT, name });
        json(res, 201, {
          ok: true,
          name: created.name,
          event: 'SKILL_SCAFFOLDED',
        });
      } catch (error) {
        json(res, /already exists/i.test(error.message) ? 409 : 400, { error: error.message });
      } finally {
        actionLocks.delete(actionKey);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/skills/archive') {
      if (!loadSettings().enableSkills) {
        json(res, 404, { error: 'The Skills view is disabled. Enable it in Settings.' });
        return;
      }
      let id;
      try { id = String(JSON.parse(await readBody(req)).id || ''); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const skill = internalSkills().find((candidate) => candidate.id === id);
      if (!skill) {
        json(res, 404, { error: 'Skill was not found.' });
        return;
      }
      if (skill.kind !== 'personal' || skill.skillsRoot !== PERSONAL_SKILLS_ROOT) {
        json(res, 403, { error: 'Only personal workspace skills can be archived.' });
        return;
      }
      const actionKey = 'skills:write';
      if (actionLocks.has(actionKey)) {
        json(res, 409, { error: 'A Skills change is already in progress.' });
        return;
      }
      actionLocks.add(actionKey);
      try {
        const result = archiveSkill({
          skillsRoot: PERSONAL_SKILLS_ROOT,
          backupRoot: SKILL_BACKUP_ROOT,
          name: path.basename(skill.directory),
        });
        json(res, 200, {
          ok: true,
          name: result.name,
          backupCreated: Boolean(result.backupDirectory),
          event: 'SKILL_ARCHIVED',
        });
      } catch (error) {
        json(res, 409, { error: error.message });
      } finally {
        actionLocks.delete(actionKey);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/skills/unarchive') {
      if (!loadSettings().enableSkills) {
        json(res, 404, { error: 'The Skills view is disabled. Enable it in Settings.' });
        return;
      }
      let name;
      try { name = String(JSON.parse(await readBody(req)).name || ''); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const actionKey = 'skills:write';
      if (actionLocks.has(actionKey)) {
        json(res, 409, { error: 'A Skills change is already in progress.' });
        return;
      }
      actionLocks.add(actionKey);
      try {
        const result = unarchiveSkill({
          skillsRoot: PERSONAL_SKILLS_ROOT,
          backupRoot: SKILL_BACKUP_ROOT,
          name,
        });
        json(res, 200, {
          ok: true,
          name: result.name,
          backupCreated: Boolean(result.backupDirectory),
          event: 'SKILL_UNARCHIVED',
        });
      } catch (error) {
        json(res, /already exists/i.test(error.message) ? 409 : 400, { error: error.message });
      } finally {
        actionLocks.delete(actionKey);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/skills/rate') {
      if (!loadSettings().enableSkills) {
        json(res, 404, { error: 'The Skills view is disabled. Enable it in Settings.' });
        return;
      }
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const id = String(input.id || '');
      const rating = String(input.rating || '');
      if (!['positive', 'negative'].includes(rating)) {
        json(res, 400, { error: 'rating must be positive or negative.' });
        return;
      }
      if (!internalSkills().some((skill) => skill.id === id)) {
        json(res, 404, { error: 'Skill was not found.' });
        return;
      }
      const actionKey = 'skills:ratings';
      if (actionLocks.has(actionKey)) {
        json(res, 409, { error: 'A skill rating is already being saved.' });
        return;
      }
      actionLocks.add(actionKey);
      try {
        const current = runtimeConfig.skillRatings.read();
        if (current.error) {
          json(res, 409, { error: `Fix skill-ratings.json before rating: ${current.error}` });
          return;
        }
        const existing = current.value.ratings[id] || { positive: 0, negative: 0 };
        const nextRating = { ...existing, [rating]: existing[rating] + 1 };
        runtimeConfig.skillRatings.write({
          ratings: {
            ...current.value.ratings,
            [id]: nextRating,
          },
        });
        json(res, 200, { ok: true, id, rating: nextRating, event: 'SKILL_RATED' });
      } finally {
        actionLocks.delete(actionKey);
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/api/ai/context-cost') {
      const settings = loadSettings();
      if (!settings.enableSkills) {
        json(res, 404, { error: 'The AI workflow area is disabled. Enable Skills in Settings.' });
        return;
      }
      const workspaceRoots = [
        WORKSPACE_ROOT,
        ...settings.workspaceFolders,
        ...loadProjects().flatMap((project) => (
          (project.components || []).map((component) => component.cwd).filter(Boolean)
        )),
      ];
      json(res, 200, contextCost({
        workspaceRoots,
        skills: internalSkills(),
        claudeHome: CLAUDE_HOME,
        codexHome: SKILL_ROOTS.codexHome,
        warnTokens: DEFAULT_AI_WORKFLOW_SETTINGS.contextTaxWarnTokens,
      }));
      return;
    }

    if (req.method === 'GET' && [
      '/api/ai/ops',
      '/api/ai/agents',
      '/api/ai/commands',
      '/api/ai/mcp',
      '/api/ai/permissions',
      '/api/ai/hooks',
    ].includes(req.url)) {
      const settings = loadSettings();
      if (!settings.enableSkills) {
        json(res, 404, { error: 'The AI workflow area is disabled. Enable Skills in Settings.' });
        return;
      }
      const snapshot = await agentOpsSnapshot(settings);
      const responseByPath = {
        '/api/ai/ops': snapshot,
        '/api/ai/agents': { agents: snapshot.agents },
        '/api/ai/commands': { commands: snapshot.commands },
        '/api/ai/mcp': { mcpServers: snapshot.mcpServers },
        '/api/ai/permissions': snapshot.permissions,
        '/api/ai/hooks': { hooks: snapshot.hooks, usageHook: snapshot.usageHook },
      };
      json(res, 200, responseByPath[req.url]);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/ai/repair-prompt') {
      const settings = loadSettings();
      if (!settings.enableSkills) {
        json(res, 404, { error: 'The AI workflow area is disabled. Enable Skills in Settings.' });
        return;
      }
      json(res, 200, { prompt: currentWorkflowRepairPrompt(settings) });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/ai/friction') {
      if (!loadSettings().enableSkills) {
        json(res, 404, { error: 'The AI workflow area is disabled. Enable Skills in Settings.' });
        return;
      }
      json(res, 200, await listFriction(FRICTION_LOG_FILE));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ai/friction') {
      if (!loadSettings().enableSkills) {
        json(res, 404, { error: 'The AI workflow area is disabled. Enable Skills in Settings.' });
        return;
      }
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const requestedProject = String(input.project || '').trim();
      const project = loadProjects().find((candidate) => (
        candidate.name.toLowerCase() === requestedProject.toLowerCase()
      ));
      try {
        const entry = appendFriction(FRICTION_LOG_FILE, {
          text: input.text,
          project: project?.name || '',
        });
        json(res, 201, { ok: true, entry, event: 'FRICTION_LOGGED' });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/api/ai/instructions') {
      const settings = loadSettings();
      if (!settings.enableSkills) {
        json(res, 404, { error: 'The AI workflow area is disabled. Enable Skills in Settings.' });
        return;
      }
      json(res, 200, { instructions: instructionRecords(settings) });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ai/instructions/drift') {
      const settings = loadSettings();
      if (!settings.enableSkills) {
        json(res, 404, { error: 'The AI workflow area is disabled. Enable Skills in Settings.' });
        return;
      }
      let id;
      try { id = String(JSON.parse(await readBody(req)).id || ''); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const instruction = instructionRecords(settings).find((item) => item.id === id);
      if (!instruction) {
        json(res, 404, { error: 'Instructions file was not found.' });
        return;
      }
      try {
        const result = await checkInstructionDrift(instruction.path, {
          commandExists: (command) => platform.executableExists(command),
        });
        json(res, 200, { ok: true, id, ...result, event: 'INSTRUCTION_DRIFT_CHECKED' });
      } catch (error) {
        json(res, 500, { error: `Could not check instruction drift: ${error.message}` });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ai/instructions/open') {
      const settings = loadSettings();
      if (!settings.enableSkills) {
        json(res, 404, { error: 'The AI workflow area is disabled. Enable Skills in Settings.' });
        return;
      }
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const instruction = instructionRecords(settings).find((item) => item.id === String(input.id || ''));
      if (!instruction) {
        json(res, 404, { error: 'Instructions file was not found.' });
        return;
      }
      const action = input.action === 'reveal' ? 'reveal-file' : input.action === 'editor'
        ? 'editor-file'
        : '';
      if (!action) {
        json(res, 400, { error: 'action must be editor or reveal.' });
        return;
      }
      try {
        await platform.openTarget(action, { file: instruction.path });
        json(res, 200, { ok: true, id: instruction.id, action: input.action });
      } catch (error) {
        json(res, 500, { error: `Could not open instructions: ${error.message}` });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ai/check-urls') {
      const settings = loadSettings();
      if (!settings.enableSkills) {
        json(res, 404, { error: 'The AI workflow area is disabled. Enable Skills in Settings.' });
        return;
      }
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      let file = '';
      if (input.kind === 'skill') {
        file = internalSkills().find((skill) => skill.id === String(input.id || ''))?.skillFile || '';
      } else if (input.kind === 'instruction') {
        file = instructionRecords(settings).find(
          (instruction) => instruction.id === String(input.id || ''),
        )?.path || '';
      }
      if (!file) {
        json(res, 404, { error: 'The requested workflow file was not found.' });
        return;
      }
      const lockKey = `url-check:${input.kind}:${input.id}`;
      if (actionLocks.has(lockKey)) {
        json(res, 409, { error: 'A link check is already running for this file.' });
        return;
      }
      actionLocks.add(lockKey);
      try {
        const result = await checkFileUrls(file, { cacheFile: URL_CHECK_CACHE_FILE });
        json(res, 200, { ok: true, ...result, event: 'WORKFLOW_URLS_CHECKED' });
      } catch (error) {
        json(res, 502, { error: `Could not check links: ${error.message}` });
      } finally {
        actionLocks.delete(lockKey);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ai/coverage/open') {
      const settings = loadSettings();
      if (!settings.enableSkills) {
        json(res, 404, { error: 'The AI workflow area is disabled. Enable Skills in Settings.' });
        return;
      }
      let name;
      try { name = String(JSON.parse(await readBody(req)).name || ''); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const project = loadProjects().find((candidate) => candidate.name === name);
      const directory = project?.components?.find((component) => component.cwd)?.cwd;
      if (!directory) {
        json(res, 404, { error: 'The project folder was not found.' });
        return;
      }
      try {
        await platform.openTarget('explorer', { cwd: directory });
        json(res, 200, { ok: true, name: project.name, event: 'COVERAGE_FOLDER_OPENED' });
      } catch (error) {
        json(res, 500, { error: `Could not open project folder: ${error.message}` });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ai/report') {
      const settings = loadSettings();
      if (!settings.enableSkills) {
        json(res, 404, { error: 'The AI workflow area is disabled. Enable Skills in Settings.' });
        return;
      }
      await readBody(req);
      const [skillsData, friction] = await Promise.all([
        annotatedSkills(settings),
        listFriction(FRICTION_LOG_FILE),
      ]);
      const instructions = instructionRecords(settings);
      const coverage = projectCoverageMatrix(loadProjects());
      const driftResults = await Promise.all(instructions.map(async (instruction) => {
        try {
          return await checkInstructionDrift(instruction.path, {
            commandExists: (command) => platform.executableExists(command),
          });
        } catch {
          return { findings: [] };
        }
      }));
      const skillFindings = skillsData.skills.flatMap((skill) => skill.lint.findings);
      const staleFindingCodes = new Set(['old-model-id', 'old-node-pin', 'old-date']);
      const result = generateWorkflowReport({
        reportsDirectory: REPORTS_DIR,
        usage: skillsData.skills
          .filter((skill) => skill.usage?.count)
          .map((skill) => ({ name: skill.name, count: skill.usage.count }))
          .sort((left, right) => right.count - left.count),
        coldSkills: skillsData.skills.filter((skill) => skill.cold).map((skill) => skill.name),
        frictionGroups: friction.groups.filter((group) => group.nudge),
        counts: {
          lint: skillFindings.filter((finding) => !staleFindingCodes.has(finding.code)).length,
          drift: driftResults.reduce((sum, result) => sum + result.findings.length, 0),
          stale: skillFindings.filter((finding) => staleFindingCodes.has(finding.code)).length
            + instructions.reduce(
              (sum, instruction) => sum + instruction.staleFindings.length,
              0,
            ),
          coverage: coverage.reduce((sum, row) => sum + row.gaps.length, 0),
        },
        skillsRepo: skillsData.repoStatus,
      });
      json(res, 201, { ok: true, ...result, event: 'REPORT_GENERATED' });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ai/export') {
      const settings = loadSettings();
      if (!settings.enableSkills) {
        json(res, 404, { error: 'The AI workflow area is disabled. Enable Skills in Settings.' });
        return;
      }
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const claude = readSettings(CLAUDE_SETTINGS_FILE);
      if (claude.error) {
        json(res, 409, { error: `Fix Claude settings before export: ${claude.error}` });
        return;
      }
      try {
        const result = exportWorkflowBundle({
          exportsDirectory: EXPORTS_DIR,
          skillsDirectory: PERSONAL_SKILLS_ROOT,
          instructionFiles: instructionRecords(settings).map((instruction) => instruction.path),
          hooks: claude.value.hooks || {},
        });
        if (input.reveal === true) {
          await platform.openTarget('explorer', { cwd: result.directory });
        }
        json(res, 201, { ok: true, ...result, event: 'WORKFLOW_BUNDLE_EXPORTED' });
      } catch (error) {
        json(res, 500, { error: `Could not export workflow bundle: ${error.message}` });
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/api/ai/setup') {
      const settings = loadSettings();
      if (!settings.enableSkills) {
        json(res, 404, { error: 'The AI workflow area is disabled. Enable Skills in Settings.' });
        return;
      }
      json(res, 200, usageSetupState(settings));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ai/hooks/install') {
      const settings = loadSettings();
      if (!settings.enableSkills) {
        json(res, 404, { error: 'The AI workflow area is disabled. Enable Skills in Settings.' });
        return;
      }
      try {
        ensureUsageHookShim();
        const result = installUsageHooks({
          settingsFile: CLAUDE_SETTINGS_FILE,
          hookCommand: USAGE_HOOK_COMMAND,
        });
        json(res, 200, {
          ok: true,
          installed: result.installed,
          hookInstalled: true,
          backupCreated: Boolean(result.backupFile),
        });
      } catch (error) {
        const conflict = /malformed|different Hacker's Lair usage hook/i.test(error.message);
        json(res, conflict ? 409 : 500, { error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ai/usage/compact') {
      const settings = loadSettings();
      if (!settings.enableSkills) {
        json(res, 404, { error: 'The AI workflow area is disabled. Enable Skills in Settings.' });
        return;
      }
      let requestedDays;
      try { requestedDays = Number(JSON.parse(await readBody(req)).days); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const days = Number.isInteger(requestedDays)
        ? requestedDays
        : settings.aiWorkflow.coldSkillDays;
      if (days < 1 || days > 3650) {
        json(res, 400, { error: 'days must be an integer from 1 to 3650.' });
        return;
      }
      const result = await pruneOlderThan(USAGE_LOG_FILE, days);
      json(res, 200, { ok: true, days, ...result });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/settings') {
      const settings = loadSettings();
      json(res, 200, {
        dataDirectory: DATA_DIR,
        projectsFile: PROJECTS_FILE,
        scriptsFile: SCRIPTS_FILE,
        enableSkills: settings.enableSkills,
        enableScripts: settings.enableScripts,
        workspaceFolders: settings.workspaceFolders,
        uiPreferences: settings.uiPreferences,
        aiWorkflow: settings.aiWorkflow,
        browserOverride: Boolean(configuredBrowserPath()),
        configError: settings.error,
        backups: runtimeConfig.projects.listBackups().map(({ path: _path, ...backup }) => backup),
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/settings/ai-workflow') {
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        json(res, 400, { error: 'AI workflow settings must be a JSON object.' });
        return;
      }
      const current = runtimeConfig.settings.read();
      if (current.error) {
        json(res, 409, { error: `Fix settings.json before saving AI workflow settings: ${current.error}` });
        return;
      }
      const aiWorkflow = normalizeAiWorkflowSettings({
        ...current.value.aiWorkflow,
        ...input,
      });
      try {
        const saved = runtimeConfig.settings.write({
          ...current.value,
          aiWorkflow,
        });
        json(res, 200, { ok: true, aiWorkflow: saved.aiWorkflow });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/dialog/workspace-folders') {
      try {
        const folders = (await platform.chooseWorkspaceFolders())
          .map((folder) => path.resolve(folder))
          .filter((folder, index, values) => (
            values.indexOf(folder) === index
            && fs.existsSync(folder)
            && fs.statSync(folder).isDirectory()
          ))
          .slice(0, 10);
        json(res, 200, { folders });
      } catch (error) {
        json(res, 501, { error: `Folder picker unavailable: ${error.message}` });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/settings/features') {
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        json(res, 400, { error: 'Panel settings must be a JSON object.' });
        return;
      }
      const updates = {};
      for (const field of ['enableSkills', 'enableScripts']) {
        if (!Object.hasOwn(input, field)) continue;
        if (typeof input[field] !== 'boolean') {
          json(res, 400, { error: `${field} must be true or false.` });
          return;
        }
        updates[field] = input[field];
      }
      if (!Object.keys(updates).length) {
        json(res, 400, { error: 'Choose at least one panel setting to update.' });
        return;
      }
      const current = runtimeConfig.settings.read();
      if (current.error) {
        json(res, 409, { error: `Fix settings.json before saving panel settings: ${current.error}` });
        return;
      }
      const saved = runtimeConfig.settings.write({
        ...current.value,
        ...updates,
      });
      json(res, 200, {
        ok: true,
        enableSkills: saved.enableSkills === true,
        enableScripts: saved.enableScripts === true,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/settings/preferences') {
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      try {
        validateUiPreferences(input);
      } catch (error) {
        json(res, 400, { error: error.message });
        return;
      }
      const current = runtimeConfig.settings.read();
      if (current.error) {
        json(res, 409, { error: `Fix settings.json before saving preferences: ${current.error}` });
        return;
      }
      const uiPreferences = normalizeUiPreferences(input);
      runtimeConfig.settings.write({
        ...current.value,
        uiPreferences,
      });
      json(res, 200, { ok: true, uiPreferences });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/settings/workspaces') {
      let workspaceFolders;
      try {
        workspaceFolders = JSON.parse(await readBody(req)).workspaceFolders;
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      if (
        !Array.isArray(workspaceFolders)
        || workspaceFolders.length > 10
        || workspaceFolders.some((folder) => (
          typeof folder !== 'string'
          || !path.isAbsolute(folder)
          || !fs.existsSync(folder)
        ))
      ) {
        json(res, 400, { error: 'Workspace folders must be existing absolute paths (maximum 10).' });
        return;
      }
      const current = runtimeConfig.settings.read();
      if (current.error) {
        json(res, 409, { error: `Fix settings.json before saving workspaces: ${current.error}` });
        return;
      }
      const uniqueFolders = [...new Set(workspaceFolders.map((folder) => path.resolve(folder)))];
      runtimeConfig.settings.write({ ...current.value, workspaceFolders: uniqueFolders });
      json(res, 200, { ok: true, workspaceFolders: uniqueFolders });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/open-url') {
      let url;
      try { url = new URL(String(JSON.parse(await readBody(req)).url || '')); }
      catch { json(res, 400, { error: 'A valid URL is required.' }); return; }
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)) {
        json(res, 400, { error: 'Only localhost URLs can be opened.' });
        return;
      }
      try {
        const browser = await openBrowserUrl(url.href);
        json(res, 200, { ok: true, browser, url: url.href });
      } catch (error) {
        json(res, 500, { error: `Could not open the browser: ${error.message}` });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/projects/resolve-port') {
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const project = loadProjects().find((item) => item.name === String(input.name));
      const component = project?.components?.find((item) => item.name === String(input.component));
      const port = Number(input.port);
      if (!project || !component || !configuredPorts(component).includes(port)) {
        json(res, 400, { error: 'The requested port is not configured for that component.' });
        return;
      }
      const owner = (await getListeners()).find((listener) => (
        listener.ports.some((entry) => entry.port === port)
      ));
      if (!owner) {
        json(res, 200, { ok: true, alreadyFree: true, port });
        return;
      }
      if (owner.protected || owner.self) {
        json(res, 403, { error: `Port ${port} belongs to a protected process.` });
        return;
      }
      try {
        await platform.terminateProcess(owner.pid);
        invalidateProcessSnapshot();
        json(res, 200, {
          ok: true,
          port,
          killed: { pid: owner.pid, name: owner.label || owner.name },
        });
      } catch (error) {
        json(res, 500, { error: `Could not release port ${port}: ${error.message}` });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/projects/open-in') {
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const project = loadProjects().find((item) => item.name === String(input.name));
      const component = project?.components?.find((item) => item.name === String(input.component))
        || project?.components?.find((item) => item.cwd);
      if (!project || !component?.cwd || !fs.existsSync(component.cwd)) {
        json(res, 404, { error: 'Project folder was not found.' });
        return;
      }
      const action = String(input.action || '');
      if (action === 'copy') {
        json(res, 200, { ok: true, cwd: component.cwd, command: component.command || '' });
        return;
      }
      if (action === 'logs') {
        const logFile = launches.get(launchKey(project.name, component.name))?.logFile;
        if (!logFile || !fs.existsSync(logFile)) {
          json(res, 404, { error: 'No component log exists yet. Start the target once to create it.' });
          return;
        }
        try {
          await platform.openTarget('logs', { logFile, cwd: component.cwd });
          json(res, 200, { ok: true, action, logFile });
        } catch (error) {
          json(res, 500, { error: `Could not open logs: ${error.message}` });
        }
        return;
      }
      if (!['explorer', 'terminal', 'vscode'].includes(action)) {
        json(res, 400, { error: 'Unknown open-in action.' });
        return;
      }
      try {
        await platform.openTarget(action, { cwd: component.cwd });
        json(res, 200, { ok: true, action, cwd: component.cwd });
      } catch (error) {
        json(res, 500, { error: `Could not open ${action}: ${error.message}` });
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/api/doctor') {
      json(res, 200, await refreshDoctor());
      return;
    }

    if (req.method === 'GET' && req.url === '/api/doctor/report') {
      const report = await refreshDoctor();
      json(res, 200, { report: formatDoctorReport(report) });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/logs') {
      json(res, 200, logStore.summary());
      return;
    }

    if (req.method === 'POST' && req.url === '/api/logs/clear') {
      json(res, 200, { ok: true, ...logStore.clear() });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/schema/projects') {
      json(res, 200, runtimeConfig.projectsSchema);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/schema/settings') {
      json(res, 200, runtimeConfig.settingsSchema);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/templates') {
      json(res, 200, {
        templates: PROJECT_TEMPLATES.map(({ component: _component, ...template }) => template),
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/templates/apply') {
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const actionKey = 'config:projects';
      if (actionLocks.has(actionKey)) {
        json(res, 409, { error: 'Project configuration is already being updated.' });
        return;
      }
      actionLocks.add(actionKey);
      try {
        let project;
        try {
          project = instantiateTemplate(input);
        } catch (error) {
          json(res, 400, { error: error.message });
          return;
        }
        const current = runtimeConfig.projects.read();
        if (current.error) {
          json(res, 409, { error: `Fix the current configuration first: ${current.error}` });
          return;
        }
        let next;
        try {
          next = updateProjectConfig(current.value, { project });
          runtimeConfig.projects.validate(next);
        } catch (error) {
          json(res, /already|configured by/i.test(error.message) ? 409 : 400, { error: error.message });
          return;
        }
        const saved = next.projects.at(-1);
        const portConflicts = await liveProjectPortConflicts([saved]);
        if (rejectProjectPortConflicts(res, portConflicts)) return;
        runtimeConfig.projects.write(next);
        void refreshGitAttention(next.projects);
        void refreshDoctor();
        json(res, 200, { ok: true, project: saved });
      } finally {
        actionLocks.delete(actionKey);
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/api/config/backups') {
      json(res, 200, {
        backups: runtimeConfig.projects.listBackups().map(({ path: _path, ...backup }) => backup),
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/config/export') {
      const config = runtimeConfig.projects.read();
      if (config.error) {
        json(res, 409, { error: `Fix the project configuration before exporting: ${config.error}` });
        return;
      }
      json(res, 200, { config: redactValue(config.value) });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/config/import') {
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const imported = input?.config;
      try {
        runtimeConfig.projects.validate(imported);
      } catch (error) {
        json(res, 400, { error: `Imported configuration is invalid: ${error.message}` });
        return;
      }
      const actionKey = 'config:projects';
      if (actionLocks.has(actionKey)) {
        json(res, 409, { error: 'Project configuration is already being updated.' });
        return;
      }
      actionLocks.add(actionKey);
      try {
        const current = runtimeConfig.projects.read();
        if (current.error) {
          json(res, 409, { error: `Fix the current configuration before importing: ${current.error}` });
          return;
        }
        let next = imported;
        if (input.mode === 'merge') {
          const existingNames = new Set(current.value.projects.map((project) => project.name.toLowerCase()));
          const additions = imported.projects.filter((project) => !existingNames.has(project.name.toLowerCase()));
          next = {
            ...current.value,
            projects: [...current.value.projects, ...additions],
          };
        }
        const portConflicts = await liveProjectPortConflicts(
          next.projects,
          current.value.projects,
        );
        if (rejectProjectPortConflicts(res, portConflicts)) return;
        runtimeConfig.projects.write({ ...next, $schema: './projects.schema.json' });
        void refreshGitAttention(loadProjects());
        void refreshDoctor();
        json(res, 200, { ok: true, projects: next.projects.length });
      } finally {
        actionLocks.delete(actionKey);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/config/restore') {
      let name;
      try { name = String(JSON.parse(await readBody(req)).name || ''); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const actionKey = 'config:projects';
      if (actionLocks.has(actionKey)) {
        json(res, 409, { error: 'Project configuration is already being updated.' });
        return;
      }
      actionLocks.add(actionKey);
      try {
        const restored = runtimeConfig.projects.restore(name);
        void refreshGitAttention(loadProjects());
        void refreshDoctor();
        json(res, 200, { ok: true, projects: restored.projects.length });
      } catch (error) {
        json(res, 400, { error: error.message });
      } finally {
        actionLocks.delete(actionKey);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/discovery/scan') {
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const requestedFolders = Array.isArray(input.folders)
        ? input.folders
        : [input.folder];
      const folders = [...new Set(requestedFolders
        .map((folder) => String(folder || '').trim())
        .filter(Boolean)
        .map((folder) => path.resolve(folder)))];
      if (!folders.length || folders.length > 10) {
        json(res, 400, { error: 'Choose between one and ten workspace folders.' });
        return;
      }
      let proposals;
      try {
        const discovered = folders.flatMap((folder) => discoverProjects(folder));
        const seen = new Set();
        proposals = discovered.filter((project) => {
          const cwd = project.components?.[0]?.cwd || '';
          const key = `${project.name.toLowerCase()}\0${path.resolve(cwd).toLowerCase()}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      } catch (error) {
        json(res, 400, { error: error.message });
        return;
      }
      const scanId = `${runtimeIdentity.nonce.slice(0, 12)}-${Date.now().toString(36)}`;
      discoveryScans.set(scanId, { folders, proposals, createdAt: Date.now() });
      json(res, 200, { scanId, folder: folders[0], folders, proposals });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/discovery/apply') {
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const scan = discoveryScans.get(String(input.scanId || ''));
      if (!scan || Date.now() - scan.createdAt > 10 * 60_000) {
        json(res, 410, { error: 'This discovery scan expired. Scan the folder again.' });
        return;
      }
      const indexes = [...new Set((Array.isArray(input.indexes) ? input.indexes : [])
        .map(Number)
        .filter((index) => Number.isInteger(index) && index >= 0 && index < scan.proposals.length))];
      if (!indexes.length) {
        json(res, 400, { error: 'Select at least one discovered project.' });
        return;
      }
      const actionKey = 'config:projects';
      if (actionLocks.has(actionKey)) {
        json(res, 409, { error: 'Project configuration is already being updated.' });
        return;
      }
      actionLocks.add(actionKey);
      try {
        const config = runtimeConfig.projects.read();
        if (config.error) {
          json(res, 409, { error: `Fix the project configuration before importing: ${config.error}` });
          return;
        }
        const existing = config.value.projects;
        const existingNames = new Set(existing.map((project) => String(project.name).toLowerCase()));
        const existingFolders = new Set(existing.flatMap((project) => project.components || [])
          .map((component) => component.cwd && path.resolve(component.cwd).toLowerCase())
          .filter(Boolean));
        const added = [];
        const skipped = [];
        for (const index of indexes) {
          const proposal = scan.proposals[index];
          const folders = proposal.components.map((component) => path.resolve(component.cwd).toLowerCase());
          if (existingNames.has(proposal.name.toLowerCase()) || folders.some((folder) => existingFolders.has(folder))) {
            skipped.push(proposal.name);
            continue;
          }
          existingNames.add(proposal.name.toLowerCase());
          folders.forEach((folder) => existingFolders.add(folder));
          added.push(proposal);
        }
        const projectsToAdd = added.map(({ discoveredFrom, confidence, note, ...project }) => project);
        const portConflicts = await liveProjectPortConflicts(projectsToAdd);
        if (rejectProjectPortConflicts(res, portConflicts)) return;
        runtimeConfig.projects.write({
          ...config.value,
          projects: [...existing, ...projectsToAdd],
        });
        const settings = runtimeConfig.settings.read();
        if (!settings.error) {
          runtimeConfig.settings.write({
            ...settings.value,
            workspaceFolders: scan.folders,
          });
        }
        discoveryScans.delete(String(input.scanId));
        void refreshGitAttention(loadProjects());
        void refreshDoctor();
        json(res, 200, { ok: true, added: added.map((project) => project.name), skipped });
      } finally {
        actionLocks.delete(actionKey);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/scripts/start') {
      if (!platform.supportsScripts) {
        json(res, 404, { error: 'The Scripts view is available on Windows only.' });
        return;
      }
      if (!loadSettings().enableScripts) {
        json(res, 404, { error: 'The Scripts view is disabled. Enable it in Settings.' });
        return;
      }
      let file;
      try { file = String(JSON.parse(await readBody(req)).file); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const actionKey = `script:${path.basename(file).toLowerCase()}`;
      if (actionLocks.has(actionKey)) {
        json(res, 409, { error: `An action for "${path.basename(file)}" is already in progress.` });
        return;
      }
      actionLocks.add(actionKey);
      try {

        const cfg = loadScriptsConfig();
      const exe = resolveAutoItExe(cfg.autoItExe);
      if (!exe) { json(res, 400, { error: 'AutoIt3.exe not found — set "autoItExe" in scripts.json' }); return; }

      // Resolve within the configured folder only (basename strips any traversal).
      const scriptPath = cfg.scriptsDir ? path.join(cfg.scriptsDir, path.basename(file)) : '';
      if (!scriptPath || !/\.au3$/i.test(scriptPath) || !fs.existsSync(scriptPath)) {
        json(res, 404, { error: `No script named "${file}"` }); return;
      }

      const procs = await getScriptProcesses();
      if (pidsForScript(scriptPath, procs).length) {
        json(res, 200, { ok: true, file: path.basename(file), started: false, alreadyRunning: true });
        return;
      }

      try {
        await platform.startScript(exe, scriptPath, cfg.scriptsDir);
        json(res, 200, { ok: true, file: path.basename(file), started: true });
      } catch (err) {
        json(res, 500, { error: `Could not start: ${err.message}` });
      }
      } finally {
        actionLocks.delete(actionKey);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/scripts/stop') {
      if (!platform.supportsScripts) {
        json(res, 404, { error: 'The Scripts view is available on Windows only.' });
        return;
      }
      if (!loadSettings().enableScripts) {
        json(res, 404, { error: 'The Scripts view is disabled. Enable it in Settings.' });
        return;
      }
      let file;
      try { file = String(JSON.parse(await readBody(req)).file); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      const actionKey = `script:${path.basename(file).toLowerCase()}`;
      if (actionLocks.has(actionKey)) {
        json(res, 409, { error: `An action for "${path.basename(file)}" is already in progress.` });
        return;
      }
      actionLocks.add(actionKey);
      try {

        const cfg = loadScriptsConfig();
      const scriptPath = cfg.scriptsDir ? path.join(cfg.scriptsDir, path.basename(file)) : '';
      if (!scriptPath) { json(res, 404, { error: `No script named "${file}"` }); return; }

      const procs = await getScriptProcesses();
      let killed = 0;
      for (const pid of pidsForScript(scriptPath, procs)) {
        try { await platform.terminateProcess(pid); killed++; } catch { /* already gone */ }
      }
        json(res, 200, { ok: true, file: path.basename(file), stopped: killed });
      } finally {
        actionLocks.delete(actionKey);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/kill') {
      let pid;
      try {
        pid = Number(JSON.parse(await readBody(req)).pid);
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      if (!Number.isInteger(pid) || pid <= 0) {
        json(res, 400, { error: 'Invalid PID' });
        return;
      }

      // Re-check against the live list so stale UI state can't kill the wrong thing.
      const target = (await getListeners()).find((p) => p.pid === pid);
      if (!target) {
        json(res, 404, { error: `PID ${pid} is not listening on any port (already stopped?)` });
        return;
      }
      if (target.protected || target.self) {
        json(res, 403, { error: `${target.name} is protected and cannot be stopped from here` });
        return;
      }

      try {
        await platform.terminateProcess(pid);
        // Remember it so it can be restarted from the list.
        const entry = {
          id: `${Date.now()}-${pid}`,
          name: target.name,
          label: target.label,
          cmd: target.cmd || '',
          cwd: target.cwd || null,
          ports: target.ports,
          stoppedAt: Date.now(),
        };
        if (entry.cmd) stopped = stopped.filter((s) => s.cmd !== entry.cmd); // de-dupe same app
        stopped.unshift(entry);
        if (stopped.length > MAX_STOPPED) stopped.length = MAX_STOPPED;
        saveStopped();
        json(res, 200, { ok: true, name: target.label || target.name, pid, canRestart: !!entry.cmd });
      } catch (err) {
        json(res, 500, { error: `Process termination failed: ${err.message}` });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/start') {
      let id;
      try { id = String(JSON.parse(await readBody(req)).id); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }

      const entry = stopped.find((s) => s.id === id);
      if (!entry) { json(res, 404, { error: 'No stopped app with that id' }); return; }

      const plan = resolveRestart(entry);
      if (!plan) { json(res, 400, { error: 'No command was recorded for this app, so it can\'t be restarted' }); return; }

      try {
        const opts = {
          detached: true,
          stdio: 'ignore',
          shell: true,
          windowsHide: true,
          env: environmentWithBrowser(),
        };
        if (plan.cwd) opts.cwd = plan.cwd;
        const child = spawn(plan.command, opts);
        child.on('error', () => {}); // don't crash the server if launch fails
        child.unref();
        json(res, 200, { ok: true, label: entry.label || entry.name, via: plan.via });
      } catch (err) {
        json(res, 500, { error: `Could not start: ${err.message}` });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/forget') {
      let id;
      try { id = String(JSON.parse(await readBody(req)).id); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }
      stopped = stopped.filter((s) => s.id !== id);
      saveStopped();
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

function listen(attempt) {
  currentPort = PORT + attempt;
  server.listen(currentPort, '127.0.0.1', () => {
    writeRuntimeIdentity(runtimeConfig.identityFile, runtimeIdentity, currentPort);
    console.log(`Hacker's Lair running at http://localhost:${currentPort}`);
  });
}
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && currentPort < PORT + MAX_PORT_TRIES) {
    listen(currentPort - PORT + 1);
  } else {
    console.error(err.message);
    process.exit(1);
  }
});
void refreshGitAttention(loadProjects());
void refreshDoctor();
const gitRefreshTimer = setInterval(() => {
  void refreshGitAttention(loadProjects());
}, GIT_REFRESH_INTERVAL_MS);
gitRefreshTimer.unref();
logStore.maintain(configuredComponentLogFiles());
const logMaintenanceTimer = setInterval(() => {
  logStore.maintain(configuredComponentLogFiles());
}, LOG_MAINTENANCE_INTERVAL_MS);
logMaintenanceTimer.unref();

function recordRuntimeFailure(kind, error, context = {}) {
  try {
    logStore.appendRuntimeError(kind, error, {
      coherent: !shuttingDown && server.listening,
      ...context,
    });
  } catch (logError) {
    console.error(`Could not persist ${kind}: ${logError.message}`);
  }
  console.error(`[${kind}]`, error?.stack || error);
}

function shutDownServer(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(gitRefreshTimer);
  clearInterval(logMaintenanceTimer);
  saveStopped();
  saveStartedTimes();
  saveTimestampMap(ACTIVITY_FILE, projectActivityTimes);
  const finish = () => {
    try { fs.unlinkSync(runtimeConfig.identityFile); } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`Could not remove local identity: ${error.message}`);
    }
    process.exit(exitCode);
  };
  if (server.listening) {
    server.close(finish);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  } else {
    finish();
  }
  const forcedExit = setTimeout(() => process.exit(1), 3_000);
  forcedExit.unref?.();
  console.log(`Hacker's Lair local service stopping (${signal}).`);
}
process.once('SIGTERM', () => shutDownServer('SIGTERM'));
process.once('SIGINT', () => shutDownServer('SIGINT'));
process.on('unhandledRejection', (reason) => {
  recordRuntimeFailure('unhandledRejection', reason);
  // Background refresh failures do not invalidate config or HTTP state.
});
process.on('uncaughtException', (error) => {
  recordRuntimeFailure('uncaughtException', error);
  // An uncaught synchronous exception can leave shared process state inconsistent.
  shutDownServer('uncaughtException', 1);
});

listen(0);
