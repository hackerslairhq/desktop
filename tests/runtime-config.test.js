const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  compareBackupNamesNewestFirst,
  createRuntimeConfig,
  CURRENT_CONFIG_VERSION,
  JsonConfigStore,
  SETTINGS_CONFIG_VERSION,
} = require('../lib/runtime-config');
const { DEFAULT_UI_PREFERENCES } = require('../lib/ui-preferences');

test('initializes sanitized runtime configuration outside the repository', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lair-config-root-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lair-config-data-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'projects.example.json'), '{"projects":[]}');
  fs.writeFileSync(path.join(root, 'scripts.example.json'), '{"scriptsDir":"","autoItExe":"","descriptions":{}}');
  fs.writeFileSync(
    path.join(root, 'settings.example.json'),
    JSON.stringify({
      $schema: './settings.schema.json',
      configVersion: 4,
      enableSkills: true,
      enableScripts: false,
      browserPath: '',
      zombieAfterHours: 8,
      workspaceFolders: [],
      uiPreferences: DEFAULT_UI_PREFERENCES,
      aiWorkflow: {
        enableUsageStats: true,
        coldSkillDays: 45,
        enableSessionFeed: false,
        contextTaxWarnTokens: 8000,
      },
    }),
  );
  fs.mkdirSync(path.join(root, 'schemas'));
  for (const schema of ['projects.schema.json', 'settings.schema.json']) {
    fs.copyFileSync(
      path.join(__dirname, '..', 'schemas', schema),
      path.join(root, 'schemas', schema),
    );
  }

  const previous = process.env.PROJECT_MANAGER_DATA_DIR;
  process.env.PROJECT_MANAGER_DATA_DIR = data;
  t.after(() => {
    if (previous === undefined) delete process.env.PROJECT_MANAGER_DATA_DIR;
    else process.env.PROJECT_MANAGER_DATA_DIR = previous;
  });

  const runtime = createRuntimeConfig(root);
  assert.equal(runtime.dataDirectory, data);
  assert.deepEqual(runtime.projects.read().value, {
    configVersion: CURRENT_CONFIG_VERSION,
    $schema: './projects.schema.json',
    projects: [],
  });
  assert.equal(runtime.projects.file, path.join(data, 'projects.json'));
  assert.ok(fs.existsSync(path.join(data, 'scripts.json')));
  assert.ok(fs.existsSync(path.join(data, 'settings.json')));
  assert.ok(fs.existsSync(path.join(data, 'skill-ratings.json')));
  const defaultSettings = runtime.settings.read().value;
  assert.equal(defaultSettings.enableSkills, true);
  assert.equal(defaultSettings.enableScripts, false);
  assert.deepEqual(defaultSettings.uiPreferences, DEFAULT_UI_PREFERENCES);
  assert.deepEqual(defaultSettings.aiWorkflow, {
    enableUsageStats: true,
    coldSkillDays: 45,
    enableSessionFeed: false,
    contextTaxWarnTokens: 8000,
  });
  assert.deepEqual(runtime.skillRatings.read().value, { ratings: {} });
  runtime.skillRatings.write({
    ratings: {
      'personal-workspace-verify': { positive: 2, negative: 1 },
    },
  });
  assert.equal(
    runtime.skillRatings.read().value.ratings['personal-workspace-verify'].positive,
    2,
  );
  assert.throws(() => runtime.skillRatings.write({
    ratings: { bad: { positive: -1, negative: 0 } },
  }), /non-negative integers/i);

  const workspaceFolders = process.platform === 'win32'
    ? ['D:\\Code', 'E:\\Experiments']
    : ['/code', '/experiments'];
  const settings = runtime.settings.write({
    ...defaultSettings,
    enableSkills: false,
    enableScripts: true,
    browserPath: '',
    zombieAfterHours: 8,
    workspaceFolders,
    uiPreferences: {
      theme: 'ice',
      density: 'compact',
      motion: 'reduced',
      fontScale: 110,
    },
  });
  assert.deepEqual(settings.workspaceFolders, workspaceFolders);
  assert.equal(settings.enableScripts, true);
  assert.equal(settings.uiPreferences.theme, 'ice');
  assert.throws(() => runtime.settings.write({
    ...defaultSettings,
    enableScripts: 'yes',
  }), /enableScripts/i);
  assert.throws(() => runtime.settings.write({
    ...defaultSettings,
    workspaceFolders: ['relative-folder'],
  }), /absolute folder strings/i);
  assert.throws(() => runtime.settings.write({
    ...defaultSettings,
    uiPreferences: {
      theme: 'rainbow',
      density: 'comfortable',
      motion: 'full',
      fontScale: 100,
    },
  }), /uiPreferences\.theme/i);
});

test('migrates panel visibility to Skills on and Scripts off', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lair-settings-root-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lair-settings-data-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });
  for (const file of ['projects.example.json', 'scripts.example.json', 'settings.example.json']) {
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
  }
  fs.mkdirSync(path.join(root, 'schemas'));
  for (const schema of ['projects.schema.json', 'settings.schema.json']) {
    fs.copyFileSync(
      path.join(__dirname, '..', 'schemas', schema),
      path.join(root, 'schemas', schema),
    );
  }
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    configVersion: 1,
    enableSkills: false,
    browserPath: '',
  }));

  const previous = process.env.PROJECT_MANAGER_DATA_DIR;
  process.env.PROJECT_MANAGER_DATA_DIR = data;
  t.after(() => {
    if (previous === undefined) delete process.env.PROJECT_MANAGER_DATA_DIR;
    else process.env.PROJECT_MANAGER_DATA_DIR = previous;
  });

  const runtime = createRuntimeConfig(root);
  const settings = runtime.settings.read();
  assert.equal(settings.error, null);
  assert.equal(settings.value.configVersion, SETTINGS_CONFIG_VERSION);
  assert.equal(settings.value.enableSkills, true);
  assert.equal(settings.value.enableScripts, false);
  assert.equal(runtime.settings.listBackups().length, 1);
});

test('migrates retired UI themes without losing other preferences', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lair-settings-theme-root-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lair-settings-theme-data-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });
  for (const file of ['projects.example.json', 'scripts.example.json', 'settings.example.json']) {
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
  }
  fs.mkdirSync(path.join(root, 'schemas'));
  for (const schema of ['projects.schema.json', 'settings.schema.json']) {
    fs.copyFileSync(
      path.join(__dirname, '..', 'schemas', schema),
      path.join(root, 'schemas', schema),
    );
  }
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    configVersion: 2,
    enableSkills: true,
    enableScripts: false,
    uiPreferences: {
      theme: 'amber',
      density: 'compact',
      motion: 'reduced',
      fontScale: 110,
    },
  }));

  const previous = process.env.PROJECT_MANAGER_DATA_DIR;
  process.env.PROJECT_MANAGER_DATA_DIR = data;
  t.after(() => {
    if (previous === undefined) delete process.env.PROJECT_MANAGER_DATA_DIR;
    else process.env.PROJECT_MANAGER_DATA_DIR = previous;
  });

  const runtime = createRuntimeConfig(root);
  const settings = runtime.settings.read();
  assert.equal(settings.error, null);
  assert.equal(settings.value.configVersion, SETTINGS_CONFIG_VERSION);
  assert.deepEqual(settings.value.uiPreferences, {
    theme: 'ultraviolet',
    density: 'compact',
    motion: 'reduced',
    fontScale: 110,
  });
  assert.equal(runtime.settings.listBackups().length, 1);
});

test('migrates AI workflow settings without changing an existing Skills choice', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lair-settings-ai-root-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lair-settings-ai-data-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });
  for (const file of ['projects.example.json', 'scripts.example.json', 'settings.example.json']) {
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
  }
  fs.mkdirSync(path.join(root, 'schemas'));
  for (const schema of ['projects.schema.json', 'settings.schema.json']) {
    fs.copyFileSync(
      path.join(__dirname, '..', 'schemas', schema),
      path.join(root, 'schemas', schema),
    );
  }
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    configVersion: 3,
    enableSkills: false,
    enableScripts: false,
    uiPreferences: DEFAULT_UI_PREFERENCES,
  }));

  const previous = process.env.PROJECT_MANAGER_DATA_DIR;
  process.env.PROJECT_MANAGER_DATA_DIR = data;
  t.after(() => {
    if (previous === undefined) delete process.env.PROJECT_MANAGER_DATA_DIR;
    else process.env.PROJECT_MANAGER_DATA_DIR = previous;
  });

  const runtime = createRuntimeConfig(root);
  const settings = runtime.settings.read();
  assert.equal(settings.error, null);
  assert.equal(settings.value.configVersion, 4);
  assert.equal(settings.value.enableSkills, false);
  assert.deepEqual(settings.value.aiWorkflow, {
    enableUsageStats: true,
    coldSkillDays: 45,
    enableSessionFeed: false,
    contextTaxWarnTokens: 8000,
  });
  assert.equal(runtime.settings.listBackups().length, 1);
});

test('validates AI workflow settings through the bundled schema', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lair-settings-schema-root-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lair-settings-schema-data-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });
  for (const file of ['projects.example.json', 'scripts.example.json', 'settings.example.json']) {
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
  }
  fs.mkdirSync(path.join(root, 'schemas'));
  for (const schema of ['projects.schema.json', 'settings.schema.json']) {
    fs.copyFileSync(
      path.join(__dirname, '..', 'schemas', schema),
      path.join(root, 'schemas', schema),
    );
  }
  const previous = process.env.PROJECT_MANAGER_DATA_DIR;
  process.env.PROJECT_MANAGER_DATA_DIR = data;
  t.after(() => {
    if (previous === undefined) delete process.env.PROJECT_MANAGER_DATA_DIR;
    else process.env.PROJECT_MANAGER_DATA_DIR = previous;
  });

  const runtime = createRuntimeConfig(root);
  assert.throws(() => runtime.settings.write({
    ...runtime.settings.read().value,
    aiWorkflow: {
      enableUsageStats: true,
      coldSkillDays: 0,
      enableSessionFeed: false,
      contextTaxWarnTokens: 8000,
    },
  }), /coldSkillDays.*at least 1/i);
});

test('migrates legacy config after snapshotting and tolerates newer config fields', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lair-config-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const backupDirectory = path.join(directory, 'backups');
  const file = path.join(directory, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ projects: [], legacyField: true }));
  const store = new JsonConfigStore({
    file,
    fallback: { configVersion: 1, projects: [] },
    validate(value) {
      if (!Array.isArray(value.projects)) throw new Error('projects required');
    },
    backupDirectory,
    currentVersion: 1,
    migrations: [{
      from: 0,
      to: 1,
      run: (value) => ({ ...value, migratedField: 'ready' }),
    }],
  });

  const upgraded = store.read();
  assert.equal(upgraded.error, null);
  assert.equal(upgraded.value.configVersion, 1);
  assert.equal(upgraded.value.migratedField, 'ready');
  const [snapshot] = store.listBackups();
  assert.ok(snapshot);
  assert.deepEqual(JSON.parse(fs.readFileSync(snapshot.path, 'utf8')), {
    projects: [],
    legacyField: true,
  });

  const future = {
    configVersion: 99,
    projects: [],
    futureField: { retained: true },
  };
  fs.writeFileSync(file, JSON.stringify(future));
  const downgraded = store.read();
  assert.equal(downgraded.error, null);
  assert.deepEqual(downgraded.value, future);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), future);
});

test('validates nested project fields and retains ten restorable backups', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lair-config-root-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lair-config-data-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });
  for (const file of ['projects.example.json', 'scripts.example.json', 'settings.example.json']) {
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
  }
  fs.mkdirSync(path.join(root, 'schemas'));
  for (const schema of ['projects.schema.json', 'settings.schema.json']) {
    fs.copyFileSync(
      path.join(__dirname, '..', 'schemas', schema),
      path.join(root, 'schemas', schema),
    );
  }

  const previous = process.env.PROJECT_MANAGER_DATA_DIR;
  process.env.PROJECT_MANAGER_DATA_DIR = data;
  t.after(() => {
    if (previous === undefined) delete process.env.PROJECT_MANAGER_DATA_DIR;
    else process.env.PROJECT_MANAGER_DATA_DIR = previous;
  });

  const runtime = createRuntimeConfig(root);
  assert.throws(() => runtime.projects.write({
    projects: [{ name: 'bad', components: [{ name: 'web', port: 70000 }] }],
  }), /maximum|65535/i);

  for (let index = 0; index < 12; index += 1) {
    runtime.projects.write({
      $schema: './projects.schema.json',
      projects: [{ name: `version-${index}`, components: [{ name: 'web' }] }],
    });
  }
  const backups = runtime.projects.listBackups();
  assert.equal(backups.length, 10);
  const restored = runtime.projects.restore(backups.at(-1).name);
  assert.match(restored.projects[0].name, /^version-/);
});

test('orders same-millisecond backup collisions by their write sequence', () => {
  const names = [
    '2026-07-26T08-00-00-000Z-2.json',
    '2026-07-26T08-00-00-000Z.json',
    '2026-07-26T08-00-00-000Z-11.json',
    '2026-07-26T08-00-00-001Z.json',
  ];
  assert.deepEqual(names.sort(compareBackupNamesNewestFirst), [
    '2026-07-26T08-00-00-001Z.json',
    '2026-07-26T08-00-00-000Z-11.json',
    '2026-07-26T08-00-00-000Z-2.json',
    '2026-07-26T08-00-00-000Z.json',
  ]);
});

test('keeps the last known-good value when JSON becomes invalid', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lair-last-good-'));
  const file = path.join(directory, 'config.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(file, '{"projects":[{"name":"safe"}]}');
  const store = new JsonConfigStore({
    file,
    fallback: { projects: [] },
    validate(value) {
      if (!Array.isArray(value.projects)) throw new Error('projects required');
    },
  });

  assert.equal(store.read().value.projects[0].name, 'safe');
  fs.writeFileSync(file, '{"projects": [}');
  const result = store.read();
  assert.equal(result.value.projects[0].name, 'safe');
  assert.match(result.error, /config\.json.*position/i);
});
