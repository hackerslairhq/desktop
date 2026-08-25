const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('a raw app shell fails closed with an actionable stale-server message', () => {
  const bootstrapScript = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(bootstrapScript);
  const context = {
    URLSearchParams,
    document: {
      documentElement: {
        classList: { add() {} },
        dataset: {},
        style: { setProperty() {} },
      },
    },
    localStorage: { getItem: () => null },
    location: { search: '' },
    window: {},
  };

  assert.doesNotThrow(() => vm.runInNewContext(bootstrapScript, context));
  assert.throws(
    () => context.window.__LAIR_BOOTSTRAP__.token,
    /outdated Hacker's Lair process.*reopen Hacker's Lair/i,
  );
});

test('UI omits N/A placeholders and keeps persisted preference behavior', () => {
  assert.doesNotMatch(html, /\bN\/A\b/);
  for (const theme of ['phosphor', 'ultraviolet', 'ice', 'volt', 'ghost']) {
    assert.match(html, new RegExp(`data-theme="${theme}"|'${theme}'`));
  }
  assert.doesNotMatch(html, /<option value="(?:amber|crimson)">/);
  assert.match(html, /amber:\s*'ultraviolet'/);
  assert.match(html, /crimson:\s*'volt'/);
  assert.match(html, /\/api\/settings\/preferences/);
  assert.match(html, /if \(pollInFlight \|\| document\.hidden\) return/);
});

test('target cards expose compact details and truthful port groups', () => {
  assert.match(html, /data-toggle-details/);
  assert.match(html, />DETECTED</);
  assert.match(html, />PORTS</);
  assert.match(html, /port-detected/);
  assert.match(html, /points\.length < 5/);
  assert.match(html, /<div class="action-cluster compact">\s*\$\{active\s*\?\s*actionButton\('project', 'terminate'/);
  assert.doesNotMatch(html, /\$\{actionButton\('project', 'terminate'[^}]+}\s*\$\{actionButton\('project', 'initiate'/);
});

test('target traffic lights expose stop, restart, and contextual go controls', () => {
  assert.match(html, /class="traffic-controls" role="group"/);
  assert.match(html, /class="traffic-control \$\{tone\}"/);
  for (const action of ['stop', 'restart', 'start']) {
    assert.match(html, new RegExp(`data-window-action="\\$\\{esc\\(action\\)\\}"|action: '${action}'`));
  }
  assert.match(html, /function runningNowHtml\(rows\)/);
  assert.match(html, /aria-label="Running applications"/);
  assert.match(html, /async function restartProject\(project\)/);
  assert.match(html, /async function restartProcess\(process\)/);
  assert.match(html, /async function restartScript\(script\)/);
  assert.match(html, /data-window-action/);
  assert.match(server, /restartId: entry\.cmd \? entry\.id : null/);
});

test('command palette includes setup, release, conditional update, and every preference family', () => {
  for (const verb of ['ADD', 'SCAN', 'RELEASE', 'UPDATE', 'THEME', 'DENSITY', 'MOTION', 'FONT', 'PANEL']) {
    assert.match(html, new RegExp(`verb: '${verb}'`));
  }
  assert.doesNotMatch(html, /verb: 'SETTINGS'/);
  assert.match(html, /Enable launch on startup/);
  assert.match(html, /if \(state\.scriptsSupported\) \{\s*commands\.push\(\{\s*verb: 'PANEL'/);
  assert.doesNotMatch(html, /Enable launch at login/);
  assert.match(html, /component\.hasLog/);
});

test('a valid visible view can be opened directly from the URL', () => {
  assert.match(html, /REQUESTED_VIEW = new URLSearchParams\(location\.search\)\.get\('view'\)/);
  assert.match(html, /VIEW_CONFIG\[REQUESTED_VIEW\]/);
  assert.match(html, /requestedTab && !requestedTab\.hidden/);
  assert.match(html, /setView\(REQUESTED_VIEW\)/);
});

test('update badge and Settings keep release controls minimal', () => {
  assert.doesNotMatch(html, /id="updateBanner"/);
  assert.match(html, /id="updateAvailableTrigger"/);
  assert.match(html, /id="releaseNotesTrigger"/);
  assert.match(html, /id="settingsPopover"[\s\S]+id="releaseNotesTrigger"/);
  assert.match(html, /id="updateDialog"/);
  assert.match(html, /id="copyUpdateCommand"/);
  assert.doesNotMatch(html, /id="releaseNotesBody"/);
  assert.doesNotMatch(html, /id="updateCurrentVersion"/);
  assert.doesNotMatch(html, /id="updateChannel"/);
  assert.doesNotMatch(html, /id="updateStatus"/);
});

test('Settings contains panel visibility, appearance, startup, and release controls', () => {
  assert.match(html, /id="settingsTrigger"[^>]*aria-label="Settings"[^>]*><span aria-hidden="true">⚙<\/span>/);
  assert.doesNotMatch(html, /id="settingsTrigger"[^>]*>Settings<\/button>/);
  assert.match(html, /id="settingsPopover"[^>]*hidden/);
  assert.match(html, /id="skillsPanelEnabled"[^>]*role="switch"/);
  assert.match(html, /<strong>AI Workflow<\/strong>/);
  assert.match(html, /Enabled by default; all scans stay local/);
  assert.match(html, /id="promptLibraryTrigger"/);
  assert.match(html, /id="promptLibraryDialog"/);
  assert.match(html, /id="promptLibraryList"/);
  assert.match(html, /data-copy-library-prompt/);
  assert.match(html, /id="scriptsPanelEnabled"[^>]*role="switch"/);
  assert.match(html, /\/api\/settings\/features/);
  assert.match(html, /id="launchOnStartup"[^>]*role="switch"/);
  assert.match(html, /<strong>Launch on startup<\/strong>/);
  assert.doesNotMatch(html, /Launch at login/);
  for (const preference of ['themePreference', 'densityPreference', 'motionPreference', 'fontScalePreference']) {
    assert.match(html, new RegExp(`id="${preference}"`));
  }
  assert.match(html, /id="settingsSync"/);
  assert.match(html, /select option[\s\S]*background(?:-color)?:\s*var\(--panel-solid\)/);
  assert.match(html, /<strong>Release notes<\/strong>/);
});

test('a new installation gets one complete setup prompt in a first-run popup', () => {
  for (const marker of [
    'id="firstRunSetupDialog"',
    'id="firstRunSetupPrompt"',
    'id="copyFirstRunSetupPrompt"',
    'maybeOpenFirstRunSetup',
    'state.onboarding?.firstRunSections',
    'data-first-run-section="targets" checked',
    'data-first-run-section="skills" checked',
    'data-first-run-section="automation" checked',
    'data-first-run-section="local-models" checked',
  ]) {
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(html, /Copy one machine-aware prompt to your coding agent/);
  assert.match(html, /Open Settings → Agent Prompts for focused, machine-aware handoffs/);
  assert.match(html, /firstRunSectionSelection/);
  assert.doesNotMatch(html, /function onboardingHtml\(/);
});

test('AI workflow setup is enabled by default, reviewable, and local-only', () => {
  assert.match(html, /all scans stay local/);
  assert.match(html, /data-ai-action="copy-json">Copy JSON/);
  assert.match(html, /data-ai-action="copy-fallback">Copy fallback instruction/);
  assert.match(html, /Harness fallback:/);
  assert.match(html, /data-ai-action="install-hook">Install for me/);
  assert.match(html, /data-ai-action="copy-prompt">Copy agent prompt/);
  assert.match(html, /data-ai-action="compact-log">Compact log/);
  for (const removedControl of [
    'usageStatsEnabled',
    'coldSkillDays',
    'sessionFeedEnabled',
    'contextTaxWarnTokens',
  ]) {
    assert.doesNotMatch(html, new RegExp(`id="${removedControl}"`));
  }
  assert.doesNotMatch(html, /<div class="settings-section-title">AI workflow<\/div>/);
  assert.match(html, /HOOK_INSTALLED/);
  assert.match(html, /USAGE_LOG_SYNCED/);
  assert.match(html, /USAGE_LOG_COMPACTED/);
});

test('Skills maintenance cards expose health, usage, ratings, context, and guarded lifecycle actions', () => {
  assert.match(html, /id="newSkill"[^>]*>\+ New Skill/);
  assert.match(html, /id="contextTaxTrigger"/);
  assert.match(html, /class="skill-health/);
  assert.match(html, /skillSparkline/);
  assert.match(html, /data-skill-rate="positive"/);
  assert.match(html, /data-skill-rate="negative"/);
  assert.match(html, /data-skill-archive/);
  assert.match(html, /id="archiveSkillDialog"/);
  assert.match(html, /timestamped backup/);
  assert.doesNotMatch(html, /confirm\(`Archive|window\.confirm\([^)]*skill/i);
  assert.match(html, /Archived skills/);
  assert.match(html, /data-skill-unarchive/);
  assert.match(html, /CONTEXT_TAX_SCANNED/);
});

test('Skill and Script creation offer agent-assisted setup before manual work', () => {
  for (const marker of [
    'id="additionalSkillSetup"',
    'id="additionalSkillPrompt"',
    'id="copyAdditionalSkillPrompt"',
    'state.onboarding?.additionalSkillPrompt',
    'id="addScript"',
    'id="newScriptDialog"',
    'id="additionalScriptPrompt"',
    'id="copyAdditionalScriptPrompt"',
    'state.onboarding?.additionalScriptPrompt',
  ]) {
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(
    html,
    /id="additionalSkillSetup"[\s\S]*Agent-assisted[\s\S]*Recommended[\s\S]*Manual scaffold/,
  );
  assert.match(
    html,
    /id="newScriptDialog"[\s\S]*Agent-assisted[\s\S]*Recommended[\s\S]*Manual setup/,
  );
  assert.match(html, /scope=additional_skill/);
  assert.match(html, /scope=additional_script/);
});

test('AI maintenance loop captures friction, tests routing, and protects instruction paths', () => {
  assert.match(html, /id="frictionCapture"/);
  assert.match(html, /data-skill-route-input/);
  assert.match(html, /Which skill would fire\?/);
  assert.match(html, /id="instructionsTab"[^>]*data-view="instructions"/);
  assert.match(html, /data-instruction-action="editor"/);
  assert.match(html, /data-instruction-action="reveal"/);
  assert.match(html, /data-instruction-action="drift"/);
  assert.match(html, /Recurring|Three repeats suggest/);
  assert.match(html, /data-friction-scaffold/);
  assert.match(html, /FRICTION_LOGGED/);
  assert.match(html, /INSTRUCTION_DRIFT_CHECKED/);
  assert.match(server, /req\.url === '\/api\/ai\/friction'/);
  assert.match(server, /req\.url === '\/api\/ai\/instructions\/drift'/);
  assert.match(server, /instructionRecords\(settings\)\.find\(\(item\) => item\.id === id\)/);
});

test('Agent Ops keeps wider workflow inventories in one read-only filtered view', () => {
  assert.match(html, /id="agentOpsTab"[^>]*data-view="agentOps"/);
  for (const filter of ['agents', 'commands', 'mcp', 'permissions', 'hooks']) {
    assert.match(html, new RegExp(`data-agent-ops-filter="\\$\\{filter\\}"|\\['${filter}',`));
  }
  assert.match(
    html,
    /class="filter-row"[\s\S]*id="viewActions"[\s\S]*id="viewSubnav"/,
  );
  assert.match(html, /html\s*\{[\s\S]*scrollbar-gutter:\s*stable/);
  assert.match(html, /\$\('viewSubnav'\)\.innerHTML = agentOpsNavHtml\(\)/);
  const panelControls = html.match(/<div class="controls">([\s\S]*?)<\/div>\s*<\/div>\s*<div class="filter-row">/)?.[1] || '';
  for (const conditionalAction of ['addProject', 'newSkill', 'addScript', 'contextTaxTrigger']) {
    assert.doesNotMatch(panelControls, new RegExp(`id="${conditionalAction}"`));
  }
  assert.match(html, /AGENT_OPS_SYNCED/);
  assert.match(html, /\/api\/ai\/ops/);
  assert.match(server, /listAgents/);
  assert.match(server, /listCommands/);
  assert.match(server, /listMcpServers/);
  assert.match(server, /permissionsView/);
  assert.match(server, /listConfiguredHooks/);
  assert.doesNotMatch(html, /data-agent-ops-(?:edit|delete|install)/);
});

test('workflow freshness and reporting stay local unless link checks are explicitly clicked', () => {
  for (const filter of ['memory', 'coverage', 'parity']) {
    assert.match(html, new RegExp(`\\['${filter}',`));
  }
  assert.doesNotMatch(html, /\['sessions',\s*'Sessions'\]/);
  assert.match(html, /data-check-urls="skill"/);
  assert.match(html, /data-check-urls="instruction"/);
  assert.match(html, /data-workflow-action="report"/);
  assert.match(html, /data-workflow-action="export"/);
  assert.match(html, /data-workflow-action="repair-prompt"/);
  assert.match(html, /data-coverage-open/);
  assert.match(html, /Skills repo has unpublished changes/);
  assert.doesNotMatch(html, /Session feed is off/);
  assert.match(html, /WORKFLOW_URLS_CHECKED/);
  assert.match(html, /REPORT_GENERATED/);
  assert.match(html, /WORKFLOW_BUNDLE_EXPORTED/);
  assert.match(server, /req\.url === '\/api\/ai\/check-urls'/);
  assert.match(server, /req\.url === '\/api\/ai\/report'/);
  assert.match(server, /req\.url === '\/api\/ai\/export'/);
  assert.match(server, /req\.url === '\/api\/ai\/repair-prompt'/);
});

test('runtime resilience controls surface backend and log state', () => {
  assert.match(html, /id="backendBanner"/);
  assert.match(html, /syncDesktopBackend/);
  assert.match(html, /onBackendState/);
  assert.match(html, /id="logSummary"/);
  assert.match(html, /id="clearLogs"/);
  assert.match(html, /\/api\/logs\/clear/);
});

test('Local Models exposes exclusive power controls and only shows setup when needed', () => {
  assert.match(html, /id="localInferenceTab"[^>]*data-view="localInference"/);
  assert.match(html, />Local Models<\/button>/);
  assert.doesNotMatch(html, /Model Bay/);
  assert.match(html, /class="local-agent-handoff"/);
  assert.match(html, /data-copy-local-prompt/);
  assert.match(html, /Set up this machine with your agent/);
  assert.match(html, /snapshot\.models\.every\(\(model\) => model\.available\)/);
  assert.doesNotMatch(html, /Setup complete\. Future setup and expansion prompts live in Settings/);
  assert.match(html, /data-model-action="start"/);
  assert.match(html, /data-model-action="stop"/);
  assert.match(html, /data-model-action="start"[^>]*>INITIATE<\/button>/);
  assert.match(html, /data-model-action="stop"[^>]*>TERMINATE<\/button>/);
  assert.match(html, /One model can be online at a time/);
  assert.match(html, /\/api\/local-models/);
  assert.match(html, /MODEL_\$\{action\.toUpperCase\(\)\}_REQUEST/);
  assert.match(server, /createLocalModelService/);
  assert.match(server, /req\.url === '\/api\/local-models'/);
  assert.match(server, /req\.url === '\/api\/local-models\/setup-prompt'/);
  assert.match(server, /'\/api\/local-models\/start'/);
  assert.match(server, /'\/api\/local-models\/stop'/);
  assert.match(server, /const actionKey = 'local-models'/);
});

test('onboarding and project management never require hand-edited JSON', () => {
  for (const marker of [
    'id="setupWizard"',
    'id="projectEditor"',
    'id="addProject"',
    '/api/projects/configure',
    '/api/projects/remove',
    'chooseWorkspaceFolders',
    'data-wizard-proposal',
    'data-edit-project',
  ]) {
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const field of ['uiPorts', 'backendPorts', 'maxRestarts', 'zombieAfterHours']) {
    assert.match(html, new RegExp(`data-editor-field="${field}"`));
  }
  assert.match(html, /class="setup-recommendation"[^>]*>Recommended</);
  assert.match(html, /error\.data\?\.portConflicts/);
  assert.match(server, /findProjectPortConflicts/);
});

test('Add Project offers agent-assisted setup before the manual editor', () => {
  for (const marker of [
    'id="additionalProjectSetup"',
    'id="additionalProjectPrompt"',
    'id="copyAdditionalProjectPrompt"',
    'state.onboarding?.additionalProjectsPrompt',
  ]) {
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(
    html,
    /id="additionalProjectSetup"[\s\S]*Agent-assisted[\s\S]*Recommended[\s\S]*Manual setup/,
  );
  assert.match(
    html,
    /additionalProjectSetup'\)\.hidden = Boolean\(project\) \|\| state\.projects\.length === 0/,
  );
  assert.match(html, /navigator\.clipboard\.writeText\(prompt\)/);
});

test('project setup can cancel safely and browse outside the Electron host', () => {
  assert.equal((html.match(/value="cancel"[^>]*formnovalidate/g) || []).length, 2);
  assert.match(html, /postJson\('\/api\/dialog\/workspace-folders', \{\}\)/);
  assert.match(server, /pathname === '\/api\/dialog\/workspace-folders'/);
  assert.match(server, /platform\.chooseWorkspaceFolders\(\)/);
});
