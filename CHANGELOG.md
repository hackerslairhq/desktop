# Changelog

All notable changes to Hacker's Lair are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](VERSIONING.md).

## [Unreleased]

### Changed

- Local Models actions now use the same Initiate and Terminate language as
  target controls.

## [2.1.0-beta.12] - 2026-08-09

### Added

- Added native Windows Local Models controls for the reviewed llama.cpp Vulkan
  channels, with artifact-aware availability, an exclusive one-model interlock,
  and direct On/Off control from the desktop console.
- Added a machine-aware Agent Prompts library in Settings for extending Targets,
  Skills, Automation, and Local Models after initial setup.
- Added one first-launch setup handoff with Targets, Skills, Automation, and
  Local Models selected by default and independently removable from the prompt.

### Changed

- AI Workflow is enabled by default on new installations while remaining local,
  transcript-free, and independently switchable from Settings.
- Local Models now uses the same single contextual action tray as Targets: On
  while offline and Off while online.

### Fixed

- Motion On no longer continuously repaints the full-window signal-rain canvas,
  eliminating its sustained main-thread rendering cost.
- An empty target registry now offers a recovery prompt even when other setup
  areas already exist, and checks prior registries before rebuilding anything.
- PowerShell updates now wait for short-lived Windows file locks to clear when
  replacing an existing installation, so repeat installs complete in one run.

## [2.1.0-beta.11] - 2026-08-05

### Fixed

- Desktop backend supervision now tolerates brief health-check stalls, never
  health-checks a replacement before it finishes starting, and resumes recovery
  after a bounded cooldown instead of remaining permanently disconnected.
- Backend output and supervisor transitions are retained in capped local logs,
  making unexpected service exits diagnosable without telemetry.

### Security

- Updated vulnerable transitive build dependencies so high-severity production
  audit gates pass without exceptions.

## [2.1.0-beta.10] - 2026-07-31

### Fixed

- Compact desktop windows now stack the system rack below Process Control
  before project cards and view controls become cramped.

## [2.1.0-beta.9] - 2026-07-31

### Added

- New Skill and Add Script now lead with machine-aware, agent-assisted setup
  prompts while retaining manual skill scaffolding and automatic `.au3`
  discovery as equal fallback paths.

### Fixed

- Windows command-channel install and uninstall now tolerate a verified app
  process exiting between process discovery and shutdown without hiding a real
  stop failure.
- Skills and Agent Ops inventory refreshes now expose a settled loading state
  for assistive technology and UI automation.
- Cross-platform release checks now reserve distinct fixture ports so Linux
  ephemeral-port reuse cannot block a valid build.

## [2.1.0-beta.8] - 2026-07-28

### Added

- Added the first AI workflow maintenance foundation: an opt-in Skills privacy
  gate, schema-backed workflow settings, a capped local usage-event reader, and
  manual log compaction.
- Added reviewable Claude Code usage-hook setup with exact JSON copying,
  conflict-safe one-click installation, atomic writes, and timestamped backups.
- Added a machine-aware agent prompt that configures usage tracking with live
  paths and disappears once the hook is detected.
- Added Skills maintenance cards with eight-week usage history, cold and rewrite
  signals, deterministic lint and routing-overlap findings, effectiveness marks,
  and cached Git edit age.
- Added a local context-tax breakdown, lint-clean personal skill scaffolding,
  and backed-up archive/restore actions. Default and plugin skills remain
  read-only.
- Added a local friction log with recurrence grouping, three-strike skill
  nudges, and a zero-network skill-routing tester.
- Added a read-only Instructions view for known `AGENTS.md` and `CLAUDE.md`
  files with safe editor/reveal actions and explicit drift checks for missing
  paths and commands.
- Added a read-only Agent Ops inventory for user/project subagents, slash
  commands, MCP definitions, merged permission rules, and configured hooks.
  MCP environment values are excluded and no server is launched or probed.
- Added stale-content checks, explicit cached link validation, project coverage,
  Doctor workflow-link health, skill-repository publication state, and
  cross-harness skill parity.
- Added read-only memory age, local weekly workflow reports, and local workflow
  bundle export.
- Added safe `?view=` deep links for opening an enabled console panel directly.
- Added a machine-aware agent-assisted path to Add Project that appends targets
  while preserving the existing registry, alongside the manual editor.

### Changed

- New installs keep local Skills scanning disabled until the user opts in.
  Existing saved panel choices are preserved by the settings v4 migration.
- Simplified the website header by keeping Getting Started in the documentation
  navigation instead of repeating it as a global button.
- Simplified Settings by removing four expert AI-workflow tuning controls.
  Usage history, cold detection, and context-cost warnings now use stable
  defaults behind the existing Skills opt-in.
- Removed transcript-session inventory from Agent Ops. Legacy settings remain
  readable for compatibility, but transcript scanning is no longer performed.

### Fixed

- Kept the primary view tabs stationary by moving conditional view actions and
  Agent Ops filters into dedicated control rows beneath search.
- Open-in-editor on Windows now passes instruction paths directly to Explorer,
  so command metacharacters in a legitimate folder name are never interpreted.
- Skills-repository status is cached across rapid UI polls, and hook setup now
  exposes the privacy-safe workspace-instruction fallback beside its JSON.
- Personal Skills discovery now follows verified directory links, including
  Windows junctions, inside the configured shared skill directory.
- Skill linting now accepts folded YAML frontmatter descriptions instead of
  incorrectly reporting them as empty.
- One physical skill linked into multiple harness roots now renders once with
  combined harness labels instead of reporting a self-collision.

## [2.1.0-beta.7] - 2026-07-27

### Added

- Added Ultraviolet, a deep ink-and-lilac console theme, and Volt, a restrained
  graphite theme with an acid-lime signal color.

### Changed

- Replaced the Amber and Crimson presets. Existing preferences migrate to
  Ultraviolet and Volt respectively without changing density, motion, or font
  scale.

## [2.1.0-beta.6] - 2026-07-27

### Fixed

- Native dropdown menus now use theme-aware text and surface colors, keeping
  Settings options readable before hover across every included theme.

## [2.1.0-beta.5] - 2026-07-27

### Added

- Added independent Skills and Scripts panel switches to Settings and the
  command palette.

### Changed

- Skills is enabled by default and uses the current user's `.agents/skills`
  folder; existing settings are backed up before the one-time migration.
- The Windows-only Scripts panel is disabled by default and does not enumerate
  or launch scripts until explicitly enabled.

## [2.1.0-beta.4] - 2026-07-27

### Fixed

- Restored the compact gear icon for Settings without removing any settings
  controls or the Release notes action.

## [2.1.0-beta.3] - 2026-07-27

### Added

- Packaged portable, Scoop, and Linux installs now check the official GitHub
  releases feed hourly and show a quiet update badge when an update is
  available; installation remains user-initiated through the detected channel.

### Changed

- Restored the complete Settings panel with theme, density, motion, font scale,
  launch-on-startup, and release-note controls.
- Moved update commands into a focused dialog opened by the update badge, with
  one-click command copying.
- Target cards now show only the action valid for their current state, matching
  the compact Scripts and Port Signals controls.

### Fixed

- PowerShell installs now migrate retired `launcher.vbs` taskbar and desktop
  shortcuts to the packaged executable and remove the obsolete forced-startup
  shortcut after preserving backups.
- PowerShell installs started from an administrator terminal no longer leave an
  elevated tray process that blocks later normal-user launches.

## [2.1.0-beta.2] - 2026-07-26

### Added

- Channel-aware update notices and Squirrel-only automatic update downloads.
- GitHub build-provenance attestations and bundled third-party license notices.
- Backend supervision with bounded restart backoff, visible recovery state, and
  packaged recovery smoke coverage.
- Bounded component logs, runtime failure logs, storage reporting, and an
  in-app clear action.
- Headless Playwright coverage for empty, live, dormant, palette, theme, and
  minimum-window states.
- Project setup warnings that identify the application and PID already using a
  newly configured port before the project is saved.

### Changed

- Moved the public repository, Pages site, release URLs, updater, and install
  channels to the product-owned `hackerslairhq` organization.
- Runtime configuration now carries an ordered migration version.
- Release automation uses immutable action revisions and audits the full npm
  dependency tree.
- Desktop shutdown requests a graceful service flush before the forced-stop
  fallback.
- CI and release jobs now print built-in Node test coverage and run the same UI
  smoke before publishing packages.

## [2.1.0-beta.1] - 2026-07-26

### Added

- Self-contained Electron packages for Windows and Linux.
- Per-user Squirrel installer, portable archives, DEB and RPM packages.
- First-run workspace discovery, project editor, templates, JSON Schema, config
  backups, import/export, and the agent setup prompt.
- Token-protected localhost API, verified service identity, platform process
  adapters, Doctor reports, CLI companion, tray controls, and command palette.
- Static command-first website and complete installation documentation.
- Automated tests, package lifecycle smoke checks, release checksums, Winget
  manifests, Scoop manifests, and GitHub Pages deployment.

### Security

- Moved mutable user data out of the repository.
- Added Host validation, JSON-only mutations, restrictive CSP, origin-checked
  desktop IPC, action locks, and last-known-good config behavior.

[Unreleased]: https://github.com/hackerslairhq/desktop/compare/v2.1.0-beta.12...HEAD
[2.1.0-beta.12]: https://github.com/hackerslairhq/desktop/compare/v2.1.0-beta.11...v2.1.0-beta.12
[2.1.0-beta.11]: https://github.com/hackerslairhq/desktop/compare/v2.1.0-beta.10...v2.1.0-beta.11
[2.1.0-beta.10]: https://github.com/hackerslairhq/desktop/compare/v2.1.0-beta.9...v2.1.0-beta.10
[2.1.0-beta.9]: https://github.com/hackerslairhq/desktop/compare/v2.1.0-beta.8...v2.1.0-beta.9
[2.1.0-beta.8]: https://github.com/hackerslairhq/desktop/compare/v2.1.0-beta.7...v2.1.0-beta.8
[2.1.0-beta.7]: https://github.com/hackerslairhq/desktop/compare/v2.1.0-beta.6...v2.1.0-beta.7
[2.1.0-beta.6]: https://github.com/hackerslairhq/desktop/compare/v2.1.0-beta.5...v2.1.0-beta.6
[2.1.0-beta.5]: https://github.com/hackerslairhq/desktop/compare/v2.1.0-beta.4...v2.1.0-beta.5
[2.1.0-beta.4]: https://github.com/hackerslairhq/desktop/compare/v2.1.0-beta.3...v2.1.0-beta.4
[2.1.0-beta.3]: https://github.com/hackerslairhq/desktop/compare/v2.1.0-beta.2...v2.1.0-beta.3
[2.1.0-beta.2]: https://github.com/hackerslairhq/desktop/compare/v2.1.0-beta.1...v2.1.0-beta.2
[2.1.0-beta.1]: https://github.com/hackerslairhq/desktop/releases/tag/v2.1.0-beta.1
