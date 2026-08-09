const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  additionalScriptPrompt,
  additionalSkillPrompt,
  configurationPrompts,
  onboardingState,
  usageTrackingSetupPrompt,
  workflowRepairPrompt,
} = require('../lib/onboarding-prompts');

const fixtures = process.platform === 'win32'
  ? {
      projectsFile: 'C:\\Workspaces\\.lair-data\\projects.json',
      schemaFile: 'C:\\Workspaces\\.lair-data\\projects.schema.json',
      agentsHome: 'D:\\Work\\.agents',
      skillsDirectory: 'C:\\Code\\.agents\\skills',
      workspaceFolders: ['D:\\Code', 'D:\\Experiments'],
      command: 'npm.cmd run dev',
      usageLogFile: 'D:\\Work\\.agents\\usage-log.jsonl',
      claudeSettingsFile: 'C:\\Workspaces\\.claude\\settings.json',
      lairSettingsFile: 'C:\\Workspaces\\.lair-data\\settings.json',
      instructionsFile: 'D:\\Work\\AGENTS.md',
      hookCommand: 'node "C:\\Workspaces\\.lair-data\\hackers-lair-usage-hook.js"',
      scriptsFile: 'C:\\Workspaces\\.lair-data\\scripts.json',
      scriptsDirectory: 'D:\\Automation\\scripts',
    }
  : {
      projectsFile: '/workspaces/.lair-data/projects.json',
      schemaFile: '/workspaces/.lair-data/projects.schema.json',
      agentsHome: '/work/.agents',
      skillsDirectory: '/code/.agents/skills',
      workspaceFolders: ['/code', '/experiments'],
      command: 'npm run dev',
      usageLogFile: '/work/.agents/usage-log.jsonl',
      claudeSettingsFile: '/work/.claude/settings.json',
      lairSettingsFile: '/workspaces/.lair-data/settings.json',
      instructionsFile: '/work/AGENTS.md',
      hookCommand: 'node "/workspaces/.lair-data/hackers-lair-usage-hook.js"',
      scriptsFile: '/workspaces/.lair-data/scripts.json',
      scriptsDirectory: '/work/automation/scripts',
    };

test('offers complete and focused prompts when nothing is configured', () => {
  const prompts = configurationPrompts({
    projectsFile: fixtures.projectsFile,
    projectsSchemaFile: fixtures.schemaFile,
    projectsSchemaUrl: 'http://localhost:4951/api/schema/projects',
    skillsDirectory: fixtures.skillsDirectory,
    projectCount: 0,
    personalSkillCount: 0,
  });

  assert.deepEqual(prompts.map((prompt) => prompt.id), ['complete', 'projects', 'skills']);
  assert.match(prompts[0].prompt, /Inspect the config and candidate folders read-only first/);
  assert.match(prompts[1].prompt, /absolute cwd/);
  assert.match(prompts[2].prompt, /without overwriting any real directory/);
});

test('empty installations expose one complete first-run handoff', () => {
  const state = onboardingState({
    projectsFile: fixtures.projectsFile,
    projectsSchemaFile: fixtures.schemaFile,
    projectsSchemaUrl: 'http://localhost:4951/api/schema/projects',
    agentsHome: fixtures.agentsHome,
    projects: [],
    skills: [],
    usageLogFile: fixtures.usageLogFile,
    claudeSettingsFile: fixtures.claudeSettingsFile,
    lairSettingsFile: fixtures.lairSettingsFile,
    instructionsFile: fixtures.instructionsFile,
    hookCommand: fixtures.hookCommand,
    hookInstalled: false,
    scriptsFile: fixtures.scriptsFile,
    scriptsSupported: true,
  });

  assert.equal(state.hasAnySetup, false);
  assert.deepEqual(
    state.firstRunSections.map((section) => section.id),
    ['targets', 'skills', 'automation'],
  );
  assert.match(state.firstRunPrompt, /Set up Hacker's Lair completely for this machine/);
  assert.match(state.firstRunPrompt, /Set up Hacker's Lair targets/);
  assert.match(state.firstRunPrompt, /configure my personal agent skills/i);
  assert.match(state.firstRunPrompt, /set up AI workflow usage tracking/i);
  assert.match(state.firstRunPrompt, /review local automation support/i);
  assert.match(state.firstRunSections[1].prompt, /canonical workspace skill directory/);
});

test('an empty target registry exposes recovery even when other workflow setup exists', () => {
  const state = onboardingState({
    projectsFile: fixtures.projectsFile,
    projectsSchemaFile: fixtures.schemaFile,
    projectsSchemaUrl: 'http://localhost:4951/api/schema/projects',
    agentsHome: fixtures.agentsHome,
    projects: [],
    skills: [{ name: 'verify', kind: 'personal' }],
    usageLogFile: fixtures.usageLogFile,
    hookInstalled: true,
  });

  assert.equal(state.hasAnySetup, true);
  assert.equal(state.firstRunPrompt, '');
  assert.match(state.targetRecoveryPrompt, /Set up Hacker's Lair targets/);
  assert.match(state.targetRecoveryPrompt, /prior valid projects\.json/i);
});

test('project prompts require the live runtime schema URL', () => {
  assert.throws(() => configurationPrompts({
    projectsFile: fixtures.projectsFile,
    projectsSchemaFile: fixtures.schemaFile,
    skillsDirectory: fixtures.skillsDirectory,
    projectCount: 0,
    personalSkillCount: 0,
  }), /projectsSchemaUrl is required/);
});

test('project prompt includes live config, schema, a valid example, and CLI verification', () => {
  const [prompt] = configurationPrompts({
    projectsFile: fixtures.projectsFile,
    projectsSchemaFile: fixtures.schemaFile,
    projectsSchemaUrl: 'http://localhost:4952/api/schema/projects',
    skillsDirectory: fixtures.skillsDirectory,
    projectCount: 0,
    personalSkillCount: 0,
    enableSkills: false,
  });

  assert.equal(prompt.id, 'projects');
  assert.match(
    prompt.prompt,
    new RegExp(fixtures.projectsFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.match(prompt.prompt, /projects\.schema\.json/);
  assert.match(prompt.prompt, /http:\/\/localhost:4952\/api\/schema\/projects/);
  assert.match(prompt.prompt, /`lair doctor`/);
  assert.match(prompt.prompt, /`lair ls`/);
  assert.match(prompt.prompt, /hot-reloads.*without an app restart/i);
  assert.doesNotMatch(prompt.prompt, /run Hacker's Lair tests|server internals/i);

  const exampleLine = prompt.prompt.split('\n')
    .find((line) => line.startsWith('Use this compact valid entry'));
  assert.ok(exampleLine);
  const example = JSON.parse(exampleLine.slice(exampleLine.indexOf(': ') + 2));
  assert.equal(example.components[0].command, fixtures.command);
  assert.equal(example.components[0].port, 5173);
});

test('project prompt uses selected workspace folders and keeps skills gated', () => {
  const prompts = configurationPrompts({
    projectsFile: fixtures.projectsFile,
    projectsSchemaFile: fixtures.schemaFile,
    projectsSchemaUrl: 'http://localhost:4949/api/schema/projects',
    skillsDirectory: fixtures.skillsDirectory,
    projectCount: 0,
    personalSkillCount: 0,
    enableSkills: false,
    workspaceFolders: [...fixtures.workspaceFolders, 'relative-folder'],
  });

  assert.deepEqual(prompts.map((prompt) => prompt.id), ['projects']);
  assert.match(
    prompts[0].prompt,
    new RegExp(`Scan these folders read-only: ${fixtures.workspaceFolders
      .join('; ')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  assert.doesNotMatch(prompts[0].prompt, /relative-folder|Configure my personal agent skills/);
});

test('returns portable machine paths and only the missing setup area', () => {
  const state = onboardingState({
    projectsFile: fixtures.projectsFile,
    projectsSchemaFile: fixtures.schemaFile,
    projectsSchemaUrl: 'http://localhost:4954/api/schema/projects',
    agentsHome: fixtures.agentsHome,
    projects: [{ name: 'App' }],
    skills: [],
  });

  assert.equal(state.configured, false);
  assert.equal(state.hasAnySetup, true);
  assert.equal(state.firstRunPrompt, '');
  assert.deepEqual(state.firstRunSections, []);
  assert.deepEqual(state.prompts.map((prompt) => prompt.id), ['skills']);
  assert.equal(state.skillsDirectory, path.join(fixtures.agentsHome, 'skills'));
});

test('does not show onboarding prompts once projects and skills exist', () => {
  const state = onboardingState({
    projectsFile: fixtures.projectsFile,
    projectsSchemaFile: fixtures.schemaFile,
    projectsSchemaUrl: 'http://localhost:4954/api/schema/projects',
    agentsHome: fixtures.agentsHome,
    projects: [{ name: 'App' }],
    skills: [{ name: 'verify', kind: 'personal' }],
  });

  assert.equal(state.configured, true);
  assert.deepEqual(state.prompts, []);
});

test('configured workspaces expose an incremental project prompt', () => {
  const state = onboardingState({
    projectsFile: fixtures.projectsFile,
    projectsSchemaFile: fixtures.schemaFile,
    projectsSchemaUrl: 'http://localhost:4955/api/schema/projects',
    agentsHome: fixtures.agentsHome,
    projects: [{ name: 'Existing Web' }, { name: 'Existing API' }],
    skills: [],
    enableSkills: false,
    workspaceFolders: fixtures.workspaceFolders,
  });

  assert.match(state.additionalProjectsPrompt, /Add one or more additional Hacker's Lair targets/);
  assert.match(state.additionalProjectsPrompt, /Existing target names: Existing Web; Existing API/);
  assert.match(state.additionalProjectsPrompt, /Never rename, remove, or replace an existing entry/);
  assert.match(state.additionalProjectsPrompt, /Preserve every valid existing entry/);
  assert.match(state.additionalProjectsPrompt, /`lair doctor`/);
  assert.match(state.additionalProjectsPrompt, /`lair ls`/);
  assert.match(state.additionalProjectsPrompt, /hot-reloads.*without an app restart/i);
});

test('additional skill prompt targets the personal directory and preserves existing skills', () => {
  const prompt = additionalSkillPrompt({
    skillsDirectory: fixtures.skillsDirectory,
    existingSkillNames: ['verify', 'release-helper'],
  });

  assert.match(prompt, new RegExp(fixtures.skillsDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt, /Existing personal skill names: verify; release-helper/);
  assert.match(prompt, /Never rename, remove, or overwrite an existing skill/);
  assert.match(prompt, /valid `name` and `description` YAML frontmatter/);
  assert.match(prompt, /no machine-specific paths, secrets, tokens, or credentials/);
  assert.match(prompt, /confirm it appears.*without an app restart/i);
});

test('additional script prompt targets configured files without launching automation', () => {
  const prompt = additionalScriptPrompt({
    scriptsFile: fixtures.scriptsFile,
    scriptsDirectory: fixtures.scriptsDirectory,
    existingScriptFiles: ['window-layout.au3', 'focus-helper.au3'],
  });

  for (const value of [fixtures.scriptsFile, fixtures.scriptsDirectory]) {
    assert.match(prompt, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(prompt, /Existing script files: window-layout\.au3; focus-helper\.au3/);
  assert.match(prompt, /Never rename, remove, or overwrite an existing script/);
  assert.match(prompt, /Do not launch the script or send keyboard or mouse input/);
  assert.match(prompt, /confirm it appears.*without an app restart/i);
});

test('onboarding exposes incremental skill and supported script prompts with privacy gates', () => {
  const state = onboardingState({
    projectsFile: fixtures.projectsFile,
    projectsSchemaFile: fixtures.schemaFile,
    projectsSchemaUrl: 'http://localhost:4955/api/schema/projects',
    agentsHome: fixtures.agentsHome,
    projects: [{ name: 'Existing Web' }],
    skills: [{ name: 'verify', kind: 'personal' }],
    enableSkills: true,
    scriptsFile: fixtures.scriptsFile,
    scriptsDirectory: fixtures.scriptsDirectory,
    scripts: [{ file: 'window-layout.au3' }],
    scriptsSupported: true,
  });

  assert.match(state.additionalSkillPrompt, /Existing personal skill names: verify/);
  assert.match(state.additionalScriptPrompt, /Existing script files: window-layout\.au3/);
  const gated = onboardingState({
    projectsFile: fixtures.projectsFile,
    projectsSchemaFile: fixtures.schemaFile,
    projectsSchemaUrl: 'http://localhost:4955/api/schema/projects',
    agentsHome: fixtures.agentsHome,
    projects: [],
    skills: [],
    enableSkills: false,
    scriptsFile: fixtures.scriptsFile,
    scriptsDirectory: fixtures.scriptsDirectory,
    scripts: [],
    scriptsSupported: false,
  });
  assert.equal(gated.additionalSkillPrompt, '');
  assert.equal(gated.additionalScriptPrompt, '');
});

test('usage tracking prompt includes every live path, exact hook command, and safety guardrail', () => {
  const prompt = usageTrackingSetupPrompt({
    usageLogFile: fixtures.usageLogFile,
    claudeSettingsFile: fixtures.claudeSettingsFile,
    lairSettingsFile: fixtures.lairSettingsFile,
    instructionsFile: fixtures.instructionsFile,
    hookCommand: fixtures.hookCommand,
  });
  for (const value of [
    fixtures.usageLogFile,
    fixtures.claudeSettingsFile,
    fixtures.lairSettingsFile,
    fixtures.instructionsFile,
    fixtures.hookCommand,
  ]) {
    assert.ok(prompt.includes(value), `missing ${value}`);
  }
  assert.match(prompt, /Inspect all four files read-only first/);
  assert.match(prompt, /Never log prompt text, file contents, tool arguments/);
  assert.match(prompt, /confirm exactly one well-formed line/);
});

test('usage tracking prompt asks for an instructions path when none is known', () => {
  const prompt = usageTrackingSetupPrompt({
    usageLogFile: fixtures.usageLogFile,
    claudeSettingsFile: fixtures.claudeSettingsFile,
    lairSettingsFile: fixtures.lairSettingsFile,
    instructionsFile: '',
    hookCommand: fixtures.hookCommand,
  });
  assert.match(
    prompt,
    /Ask me where my workspace instructions file lives before adding the fallback instruction/,
  );
});

test('usage setup prompt is gated by Skills and hook detection and joins complete setup last', () => {
  const base = {
    projectsFile: fixtures.projectsFile,
    projectsSchemaFile: fixtures.schemaFile,
    projectsSchemaUrl: 'http://localhost:4953/api/schema/projects',
    skillsDirectory: fixtures.skillsDirectory,
    projectCount: 0,
    personalSkillCount: 0,
    enableSkills: true,
    usageLogFile: fixtures.usageLogFile,
    claudeSettingsFile: fixtures.claudeSettingsFile,
    lairSettingsFile: fixtures.lairSettingsFile,
    instructionsFile: fixtures.instructionsFile,
    hookCommand: fixtures.hookCommand,
  };
  const prompts = configurationPrompts({ ...base, hookInstalled: false });
  assert.deepEqual(prompts.map((prompt) => prompt.id), [
    'complete',
    'projects',
    'skills',
    'usage',
  ]);
  const complete = prompts[0].prompt;
  const lowerComplete = complete.toLowerCase();
  assert.ok(lowerComplete.indexOf("set up hacker's lair targets") < lowerComplete.indexOf('configure my personal agent skills'));
  assert.ok(lowerComplete.indexOf('configure my personal agent skills') < lowerComplete.indexOf('set up ai workflow usage tracking'));

  assert.doesNotMatch(
    configurationPrompts({ ...base, hookInstalled: true })
      .map((prompt) => prompt.id)
      .join(','),
    /usage/,
  );
  assert.doesNotMatch(
    configurationPrompts({ ...base, enableSkills: false, hookInstalled: false })
      .map((prompt) => prompt.id)
      .join(','),
    /usage/,
  );
});

test('workflow repair prompt embeds only current findings with backup guardrails', () => {
  const prompt = workflowRepairPrompt({
    findings: [{
      file: fixtures.instructionsFile,
      message: 'Referenced path does not exist: scripts/check.js',
    }],
  });
  assert.match(prompt, new RegExp(fixtures.instructionsFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt, /scripts\/check\.js/);
  assert.match(prompt, /Inspect every listed file read-only first/);
  assert.match(prompt, /timestamped backup/);
  assert.match(prompt, /one file at a time/);
  assert.doesNotMatch(workflowRepairPrompt({ findings: [] }), /timestamped backup/);
});
