const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertSchema } = require('./schema-validator');
const {
  DEFAULT_UI_PREFERENCES,
  normalizeUiPreferences,
  validateUiPreferences,
} = require('./ui-preferences');

const MAX_CONFIG_BACKUPS = 10;
const CURRENT_CONFIG_VERSION = 1;
const SETTINGS_CONFIG_VERSION = 4;
const DEFAULT_AI_WORKFLOW_SETTINGS = Object.freeze({
  enableUsageStats: true,
  coldSkillDays: 45,
  enableSessionFeed: false,
  contextTaxWarnTokens: 8000,
});

function defaultDataDirectory() {
  if (process.platform === 'win32') {
    if (process.env.APPDATA) return path.join(process.env.APPDATA, 'HackersLair');
    return path.join(os.homedir(), 'AppData', 'Roaming', 'HackersLair');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'HackersLair');
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function initializeUserFile({ target, example, legacy }) {
  if (fs.existsSync(target)) return;
  const source = legacy && fs.existsSync(legacy) ? legacy : example;
  if (!source || !fs.existsSync(source)) {
    throw new Error(`Cannot initialize ${target}: no example file exists.`);
  }
  ensureDirectory(path.dirname(target));
  try {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

function atomicWriteJson(file, value) {
  ensureDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function formatConfigError(file, error, source = '') {
  const message = String(error.message || error);
  if (/\bposition \d+/i.test(message)) return `${file}: ${message}`;
  let position = source.length;
  const unexpectedToken = message.match(/Unexpected token '([^']+)'/i);
  if (unexpectedToken) {
    const foundAt = source.indexOf(unexpectedToken[1]);
    if (foundAt >= 0) position = foundAt;
  }
  return `${file}: ${message} (position ${position})`;
}

function compareBackupNamesNewestFirst(left, right) {
  const backupPattern = /^(?<timestamp>\d{4}-\d{2}-\d{2}T[\d-]+Z)(?:-(?<collision>\d+))?\.json$/;
  const leftParts = left.match(backupPattern)?.groups;
  const rightParts = right.match(backupPattern)?.groups;
  if (!leftParts || !rightParts) return right.localeCompare(left);
  return rightParts.timestamp.localeCompare(leftParts.timestamp)
    || Number(rightParts.collision || 0) - Number(leftParts.collision || 0);
}

class JsonConfigStore {
  constructor({
    file,
    fallback,
    validate,
    backupDirectory,
    currentVersion = null,
    migrations = [],
  }) {
    this.file = file;
    this.fallback = fallback;
    this.validate = validate;
    this.backupDirectory = backupDirectory;
    this.currentVersion = currentVersion ?? (migrations.length ? CURRENT_CONFIG_VERSION : null);
    this.migrations = migrations;
    this.lastGood = null;
    this.lastError = null;
  }

  migrate(value) {
    if (this.currentVersion === null) return { value, changed: false };
    let migrated = value;
    let version = Number.isInteger(value?.configVersion) ? value.configVersion : 0;
    if (version > this.currentVersion) return { value, changed: false };

    let changed = false;
    while (version < this.currentVersion) {
      const migration = this.migrations.find((candidate) => candidate.from === version);
      if (!migration || migration.to <= version) {
        throw new Error(`No ordered config migration exists from version ${version}.`);
      }
      migrated = migration.run(migrated);
      version = migration.to;
      migrated = { ...migrated, configVersion: version };
      changed = true;
    }
    return { value: migrated, changed };
  }

  normalizeWrite(value) {
    if (this.currentVersion === null) return value;
    const version = Number.isInteger(value?.configVersion) ? value.configVersion : 0;
    if (version > this.currentVersion) return value;
    return { ...value, configVersion: this.currentVersion };
  }

  read() {
    try {
      const source = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(source);
      const migration = this.migrate(parsed);
      const value = migration.value;
      this.validate(value);
      if (migration.changed) {
        this.backup();
        atomicWriteJson(this.file, value);
      }
      this.lastGood = value;
      this.lastError = null;
    } catch (error) {
      let source = '';
      try { source = fs.readFileSync(this.file, 'utf8'); } catch { /* original error is clearer */ }
      this.lastError = formatConfigError(this.file, error, source);
    }
    return {
      value: this.lastGood ?? this.fallback,
      error: this.lastError,
      file: this.file,
    };
  }

  write(value) {
    const normalized = this.normalizeWrite(value);
    this.validate(normalized);
    this.backup();
    atomicWriteJson(this.file, normalized);
    this.lastGood = normalized;
    this.lastError = null;
    return normalized;
  }

  backup() {
    if (!this.backupDirectory || !fs.existsSync(this.file)) return null;
    ensureDirectory(this.backupDirectory);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    let backupFile = path.join(this.backupDirectory, `${timestamp}.json`);
    let collision = 0;
    while (fs.existsSync(backupFile)) {
      collision += 1;
      backupFile = path.join(this.backupDirectory, `${timestamp}-${collision}.json`);
    }
    fs.copyFileSync(this.file, backupFile);
    const backups = this.listBackups();
    for (const stale of backups.slice(MAX_CONFIG_BACKUPS)) {
      fs.unlinkSync(stale.path);
    }
    return backupFile;
  }

  listBackups() {
    if (!this.backupDirectory || !fs.existsSync(this.backupDirectory)) return [];
    return fs.readdirSync(this.backupDirectory)
      .filter((name) => /^\d{4}-\d{2}-\d{2}T[\d-]+Z(?:-\d+)?\.json$/.test(name))
      .map((name) => {
        const backupPath = path.join(this.backupDirectory, name);
        const stat = fs.statSync(backupPath);
        return { name, path: backupPath, createdAt: stat.mtime.toISOString(), size: stat.size };
      })
      .sort((left, right) => compareBackupNamesNewestFirst(left.name, right.name));
  }

  restore(name) {
    const safeName = path.basename(String(name || ''));
    const backup = this.listBackups().find((item) => item.name === safeName);
    if (!backup) throw new Error('Configuration backup was not found.');
    const value = JSON.parse(fs.readFileSync(backup.path, 'utf8'));
    this.write(value);
    return value;
  }
}

function validateScripts(value) {
  if (!value || typeof value !== 'object') throw new Error('Expected a scripts configuration object.');
  for (const field of ['scriptsDir', 'autoItExe']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw new Error(`${field} must be a string.`);
    }
  }
  if (value.descriptions !== undefined && (
    !value.descriptions
    || typeof value.descriptions !== 'object'
    || Array.isArray(value.descriptions)
  )) {
    throw new Error('descriptions must be an object.');
  }
}

function validateSettings(value) {
  if (!value || typeof value !== 'object') throw new Error('Expected a settings object.');
  if (value.enableSkills !== undefined && typeof value.enableSkills !== 'boolean') {
    throw new Error('enableSkills must be true or false.');
  }
  if (value.enableScripts !== undefined && typeof value.enableScripts !== 'boolean') {
    throw new Error('enableScripts must be true or false.');
  }
  if (value.browserPath !== undefined && typeof value.browserPath !== 'string') {
    throw new Error('browserPath must be a string.');
  }
  if (value.workspaceFolders !== undefined && (
    !Array.isArray(value.workspaceFolders)
    || value.workspaceFolders.some((folder) => (
      typeof folder !== 'string'
      || !folder.trim()
      || !path.isAbsolute(folder)
    ))
  )) {
    throw new Error('workspaceFolders must be an array of absolute folder strings.');
  }
  if (value.uiPreferences !== undefined) validateUiPreferences(value.uiPreferences);
  if (value.zombieAfterHours !== undefined && (
    typeof value.zombieAfterHours !== 'number'
    || value.zombieAfterHours < 1
    || value.zombieAfterHours > 720
  )) {
    throw new Error('zombieAfterHours must be a number from 1 to 720.');
  }
  if (value.aiWorkflow !== undefined) validateAiWorkflowSettings(value.aiWorkflow);
}

function validateSkillRatings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a skill ratings object.');
  }
  if (!value.ratings || typeof value.ratings !== 'object' || Array.isArray(value.ratings)) {
    throw new Error('ratings must be an object.');
  }
  for (const [id, rating] of Object.entries(value.ratings)) {
    if (!id || !rating || typeof rating !== 'object' || Array.isArray(rating)) {
      throw new Error('Each skill rating must be an object.');
    }
    if (
      !Number.isInteger(rating.positive)
      || !Number.isInteger(rating.negative)
      || rating.positive < 0
      || rating.negative < 0
    ) {
      throw new Error('Skill rating tallies must be non-negative integers.');
    }
  }
}

function normalizeAiWorkflowSettings(value = {}) {
  return {
    enableUsageStats: value.enableUsageStats !== false,
    coldSkillDays: Number.isInteger(value.coldSkillDays)
      ? value.coldSkillDays
      : DEFAULT_AI_WORKFLOW_SETTINGS.coldSkillDays,
    enableSessionFeed: value.enableSessionFeed === true,
    contextTaxWarnTokens: Number.isInteger(value.contextTaxWarnTokens)
      ? value.contextTaxWarnTokens
      : DEFAULT_AI_WORKFLOW_SETTINGS.contextTaxWarnTokens,
  };
}

function validateAiWorkflowSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('aiWorkflow must be an object.');
  }
  for (const field of ['enableUsageStats', 'enableSessionFeed']) {
    if (typeof value[field] !== 'boolean') throw new Error(`aiWorkflow.${field} must be true or false.`);
  }
  if (!Number.isInteger(value.coldSkillDays) || value.coldSkillDays < 1 || value.coldSkillDays > 3650) {
    throw new Error('aiWorkflow.coldSkillDays must be an integer from 1 to 3650.');
  }
  if (
    !Number.isInteger(value.contextTaxWarnTokens)
    || value.contextTaxWarnTokens < 1000
    || value.contextTaxWarnTokens > 1_000_000
  ) {
    throw new Error('aiWorkflow.contextTaxWarnTokens must be an integer from 1000 to 1000000.');
  }
}

function createRuntimeConfig(rootDirectory) {
  const dataDirectory = ensureDirectory(
    process.env.PROJECT_MANAGER_DATA_DIR || defaultDataDirectory(),
  );
  const projectsFile = process.env.PROJECTS_FILE || path.join(dataDirectory, 'projects.json');
  const scriptsFile = process.env.SCRIPTS_FILE || path.join(dataDirectory, 'scripts.json');
  const settingsFile = process.env.LAIR_SETTINGS_FILE || path.join(dataDirectory, 'settings.json');
  const skillRatingsFile = path.join(dataDirectory, 'skill-ratings.json');
  const schemaFile = path.join(dataDirectory, 'projects.schema.json');
  const settingsSchemaFile = path.join(dataDirectory, 'settings.schema.json');
  const bundledSchemaFile = path.join(rootDirectory, 'schemas', 'projects.schema.json');
  const bundledSettingsSchemaFile = path.join(rootDirectory, 'schemas', 'settings.schema.json');

  initializeUserFile({
    target: projectsFile,
    example: path.join(rootDirectory, 'projects.example.json'),
    legacy: path.join(rootDirectory, 'projects.json'),
  });
  if (!fs.existsSync(schemaFile)) fs.copyFileSync(bundledSchemaFile, schemaFile);
  else if (fs.readFileSync(schemaFile, 'utf8') !== fs.readFileSync(bundledSchemaFile, 'utf8')) {
    fs.copyFileSync(bundledSchemaFile, schemaFile);
  }
  if (!fs.existsSync(settingsSchemaFile)) fs.copyFileSync(bundledSettingsSchemaFile, settingsSchemaFile);
  else if (
    fs.readFileSync(settingsSchemaFile, 'utf8')
    !== fs.readFileSync(bundledSettingsSchemaFile, 'utf8')
  ) {
    fs.copyFileSync(bundledSettingsSchemaFile, settingsSchemaFile);
  }
  initializeUserFile({
    target: scriptsFile,
    example: path.join(rootDirectory, 'scripts.example.json'),
    legacy: path.join(rootDirectory, 'scripts.json'),
  });
  initializeUserFile({
    target: settingsFile,
    example: path.join(rootDirectory, 'settings.example.json'),
    legacy: path.join(rootDirectory, 'settings.json'),
  });
  if (!fs.existsSync(skillRatingsFile)) atomicWriteJson(skillRatingsFile, { ratings: {} });

  const projectsSchema = JSON.parse(fs.readFileSync(bundledSchemaFile, 'utf8'));
  const settingsSchema = JSON.parse(fs.readFileSync(bundledSettingsSchemaFile, 'utf8'));
  const backupRoot = ensureDirectory(path.join(dataDirectory, 'backups'));
  const projectsMigrations = [{
    from: 0,
    to: 1,
    run: (value) => ({
      $schema: './projects.schema.json',
      ...value,
    }),
  }];
  const scriptsMigrations = [{
    from: 0,
    to: 1,
    run: (value) => ({ ...value }),
  }];
  const settingsMigrations = [
    {
      from: 0,
      to: 1,
      run: (value) => ({
        zombieAfterHours: 8,
        workspaceFolders: [],
        uiPreferences: DEFAULT_UI_PREFERENCES,
        ...value,
      }),
    },
    {
      from: 1,
      to: 2,
      run: (value) => ({
        ...value,
        enableSkills: true,
        enableScripts: false,
      }),
    },
    {
      from: 2,
      to: 3,
      run: (value) => ({
        ...value,
        uiPreferences: normalizeUiPreferences(value.uiPreferences),
      }),
    },
    {
      from: 3,
      to: 4,
      run: (value) => ({
        ...value,
        $schema: './settings.schema.json',
        aiWorkflow: normalizeAiWorkflowSettings(value.aiWorkflow),
      }),
    },
  ];
  const runtime = {
    dataDirectory,
    identityFile: path.join(dataDirectory, 'api-token'),
    projectsSchema,
    projectsSchemaFile: schemaFile,
    settingsSchema,
    settingsSchemaFile,
    projects: new JsonConfigStore({
      file: projectsFile,
      fallback: { $schema: './projects.schema.json', projects: [] },
      validate: (value) => assertSchema(value, projectsSchema),
      backupDirectory: path.join(backupRoot, 'projects'),
      migrations: projectsMigrations,
    }),
    scripts: new JsonConfigStore({
      file: scriptsFile,
      fallback: { scriptsDir: '', autoItExe: '', descriptions: {} },
      validate: validateScripts,
      backupDirectory: path.join(backupRoot, 'scripts'),
      migrations: scriptsMigrations,
    }),
    settings: new JsonConfigStore({
      file: settingsFile,
      fallback: {
        $schema: './settings.schema.json',
        enableSkills: true,
        enableScripts: false,
        browserPath: '',
        zombieAfterHours: 8,
        workspaceFolders: [],
        uiPreferences: DEFAULT_UI_PREFERENCES,
        aiWorkflow: DEFAULT_AI_WORKFLOW_SETTINGS,
      },
      validate: (value) => {
        assertSchema(value, settingsSchema);
        validateSettings(value);
      },
      backupDirectory: path.join(backupRoot, 'settings'),
      currentVersion: SETTINGS_CONFIG_VERSION,
      migrations: settingsMigrations,
    }),
    skillRatings: new JsonConfigStore({
      file: skillRatingsFile,
      fallback: { ratings: {} },
      validate: validateSkillRatings,
      backupDirectory: path.join(backupRoot, 'skill-ratings'),
    }),
  };
  runtime.projects.read();
  runtime.scripts.read();
  runtime.settings.read();
  runtime.skillRatings.read();
  return runtime;
}

module.exports = {
  JsonConfigStore,
  atomicWriteJson,
  compareBackupNamesNewestFirst,
  CURRENT_CONFIG_VERSION,
  createRuntimeConfig,
  DEFAULT_AI_WORKFLOW_SETTINGS,
  defaultDataDirectory,
  formatConfigError,
  MAX_CONFIG_BACKUPS,
  normalizeAiWorkflowSettings,
  SETTINGS_CONFIG_VERSION,
};
