const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const site = path.join(root, 'site');
const publicPages = [
  'index.html',
  'getting-started/index.html',
  'docs/index.html',
  'docs/configuration.html',
  'docs/ai-workflow.html',
  'docs/detection.html',
  'docs/troubleshooting.html',
  'docs/faq.html',
  'docs/uninstall.html',
];

test('static site ships complete metadata, docs navigation, and local assets', () => {
  for (const relative of publicPages) {
    const file = path.join(site, relative);
    const html = fs.readFileSync(file, 'utf8');
    assert.match(html, /<title>[^<]+<\/title>/, relative);
    assert.match(html, /<meta name="description" content="[^"]+"/, relative);
    assert.match(html, /<link rel="canonical" href="https:\/\/hackerslairhq\.github\.io\/desktop\//, relative);
    assert.match(html, /<meta property="og:image" content="https:\/\/hackerslairhq\.github\.io\/desktop\/assets\/og-card\.png">/, relative);
    assert.match(html, /href="[^"]*site\.css"/, relative);
    assert.match(html, /src="[^"]*site\.js"/, relative);
    assert.match(html, /href="[^"]*docs\/?[^"]*"/, relative);
    assert.doesNotMatch(html, /<(?:script|img)[^>]+src="https?:\/\//i, relative);
    assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"[^>]+href="https?:\/\//i, relative);
  }
});

test('primary site navigation omits the redundant Getting Started button', () => {
  for (const relative of [...publicPages, '404.html']) {
    const html = fs.readFileSync(path.join(site, relative), 'utf8');
    const primaryNavigation = html.match(
      /<nav class="site-nav"[^>]*>[\s\S]*?<\/nav>/,
    )?.[0] || '';
    assert.doesNotMatch(primaryNavigation, /getting-started|Getting started/i, relative);
  }
});

test('site typography is self-hosted and uses one deliberate developer-mono family', () => {
  const stylesheet = fs.readFileSync(path.join(site, 'assets', 'site.css'), 'utf8');
  const fontFiles = [
    'jetbrains-mono-regular.ttf',
    'jetbrains-mono-bold.ttf',
  ];
  const licenseFiles = [
    'OFL-JetBrains-Mono.txt',
  ];

  assert.match(stylesheet, /--font-display:\s*"Lair Mono"/);
  assert.match(stylesheet, /--font-body:\s*"Lair Mono"/);
  assert.match(stylesheet, /--font-mono:\s*"Lair Mono"/);
  assert.match(stylesheet, /body\s*\{[\s\S]*font:\s*15px\/1\.68 var\(--font-body\)/);
  assert.match(stylesheet, /\.hero-copy h1\s*\{[\s\S]*font-family:\s*var\(--font-display\)/);
  assert.match(stylesheet, /\.hero-copy h1\s*\{[\s\S]*font-weight:\s*700/);
  assert.match(stylesheet, /\.terminal-window\s*\{[\s\S]*font-family:\s*var\(--font-mono\)/);
  assert.doesNotMatch(stylesheet, /url\(["']?https?:\/\//i);

  for (const fontFile of fontFiles) {
    assert.ok(fs.existsSync(path.join(site, 'assets', 'fonts', fontFile)), fontFile);
    assert.match(stylesheet, new RegExp(fontFile.replaceAll('.', '\\.')));
  }
  for (const licenseFile of licenseFiles) {
    assert.ok(fs.existsSync(path.join(site, 'assets', 'fonts', licenseFile)), licenseFile);
  }
});

test('installation remains command-only and useful without JavaScript', () => {
  const landing = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  const installation = fs.readFileSync(path.join(site, 'docs', 'index.html'), 'utf8');
  const gettingStarted = fs.readFileSync(path.join(site, 'getting-started', 'index.html'), 'utf8');
  const faq = fs.readFileSync(path.join(site, 'docs', 'faq.html'), 'utf8');
  const uninstall = fs.readFileSync(path.join(site, 'docs', 'uninstall.html'), 'utf8');
  const publicInstallationCopy = [
    landing,
    installation,
    gettingStarted,
    faq,
    uninstall,
  ].join('\n');
  assert.doesNotMatch(publicInstallationCopy, /<a[^>]+releases\/download/i);
  assert.doesNotMatch(publicInstallationCopy, /<button[^>]*>\s*download/i);
  assert.doesNotMatch(publicInstallationCopy, /<(?:a|button)[^>]*\sdownload(?:=|\s|>)/i);
  assert.doesNotMatch(
    publicInstallationCopy,
    /<pre class="command-block"><code>winget (?:install|upgrade|uninstall)\b/i,
  );
  assert.match(landing, /data-platform-panel="windows"/);
  assert.match(landing, /data-platform-panel="linux"/);
  assert.doesNotMatch(
    landing,
    /data-platform-panel="(?:windows|linux)"[^>]*hidden/,
  );
  assert.match(landing, /irm https:\/\/hackerslairhq\.github\.io\/desktop\/install\.ps1 \| iex/);
  assert.match(landing, /windows_x64<\/span>[^<]*checksum-verified PowerShell/);
  assert.match(installation, /hackers-lair_amd64\.deb/);
  assert.match(installation, /hackers-lair_x86_64\.rpm/);
  assert.match(installation, /hackers-lair-linux-x64\.tar\.gz/);
  assert.match(installation, /gh attestation verify &lt;file&gt; -R hackerslairhq\/desktop/);
});

test('Linux commands require a distro choice and verify the artifact before elevation', () => {
  const landing = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  const installation = fs.readFileSync(path.join(site, 'docs', 'index.html'), 'utf8');
  const linuxPanel = landing.match(
    /<section class="install-panel" data-platform-panel="linux"[\s\S]*?<\/section>/,
  )?.[0] || '';

  assert.match(linuxPanel, /choose your distribution/i);
  assert.match(linuxPanel, /Debian \/ Ubuntu/);
  assert.match(linuxPanel, /Fedora \/ RHEL/);
  assert.match(linuxPanel, /Distro-neutral/);
  for (const [asset, installer] of [
    ['hackers-lair_amd64\\.deb', 'sudo apt install'],
    ['hackers-lair_x86_64\\.rpm', 'sudo rpm -i'],
    ['hackers-lair-linux-x64\\.tar\\.gz', 'tar -xzf'],
  ]) {
    const integrityFirst = new RegExp(
      `${asset}[\\s\\S]*checksums\\.txt[\\s\\S]*sha256sum[\\s\\S]*${installer}`,
    );
    assert.match(linuxPanel, integrityFirst);
    assert.match(installation, integrityFirst);
  }
});

test('public branding uses the product-owned Winget identity', () => {
  const publicCopy = publicPages
    .map((relative) => fs.readFileSync(path.join(site, relative), 'utf8'))
    .join('\n');
  const visibleProse = publicCopy
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, '')
    .replace(/<[^>]+>/g, ' ');

  assert.match(publicCopy, /hackerslair\.desktop/);
  assert.doesNotMatch(publicCopy, /alfonza1|Alfonza Jones/i);
  assert.doesNotMatch(visibleProse, /alfonza/i);
});

test('landing page gives engineers a concrete contribution path', () => {
  const landing = fs.readFileSync(path.join(site, 'index.html'), 'utf8');

  assert.match(landing, /id="contribute"/);
  assert.match(landing, /Engineers: take a subsystem\./);
  assert.match(landing, /Where help matters/);
  assert.match(landing, /Your first patch/);
  assert.match(landing, /href="https:\/\/github\.com\/hackerslairhq\/desktop\/blob\/main\/CONTRIBUTING\.md"/);
  assert.match(landing, /href="https:\/\/github\.com\/hackerslairhq\/desktop\/issues"/);
  assert.ok(landing.indexOf('id="contribute"') < landing.indexOf('id="release-title"'));
});

test('site scripts stay self-contained and installer mirrors stay exact', () => {
  const javascript = fs.readFileSync(path.join(site, 'assets', 'site.js'), 'utf8');
  const installer = fs.readFileSync(path.join(root, 'install.ps1'), 'utf8');
  assert.equal((javascript.match(/\bfetch\(/g) || []).length, 1);
  assert.match(javascript, /api\.github\.com\/repos\/hackerslairhq\/desktop\/releases\?per_page=1/);
  assert.match(javascript, /aria-pressed/);
  assert.match(javascript, /data-platform-panel="unsupported"|unsupported/);
  assert.doesNotMatch(javascript, /return 'windows';\s*\n\}/);
  assert.match(
    installer,
    /https:\/\/github\.com\/hackerslairhq\/desktop\/releases\/latest\/download/,
  );
  assert.equal(
    installer,
    fs.readFileSync(path.join(site, 'install.ps1'), 'utf8'),
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'uninstall.ps1'), 'utf8'),
    fs.readFileSync(path.join(site, 'uninstall.ps1'), 'utf8'),
  );
});

test('Windows maintenance scripts tolerate processes exiting during verified shutdown', () => {
  for (const relativePath of ['install.ps1', 'uninstall.ps1']) {
    const script = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.match(
      script,
      /try\s*\{[\s\S]*?Stop-Process -Id \$process\.ProcessId -Force -ErrorAction Stop[\s\S]*?\}\s*catch\s*\{\s*if \(Get-Process -Id \$process\.ProcessId -ErrorAction SilentlyContinue\) \{\s*throw\s*\}\s*/,
      `${relativePath} must ignore only the race where a verified process already exited.`,
    );
  }
});

test('Windows command instructions explicitly use a regular PowerShell window', () => {
  for (const relativePath of [
    'index.html',
    'docs/index.html',
    'getting-started/index.html',
  ]) {
    const page = fs.readFileSync(path.join(site, relativePath), 'utf8');
    assert.match(page, /regular PowerShell window/i, relativePath);
    assert.match(page, /administrator privileges are not needed/i, relativePath);
  }
});

test('custom 404 uses project-root links that survive nested missing routes', () => {
  const notFound = fs.readFileSync(path.join(site, '404.html'), 'utf8');
  assert.match(notFound, /href="\/desktop\/assets\/site\.css"/);
  assert.match(notFound, /src="\/desktop\/assets\/command-line-mark\.png"/);
  assert.doesNotMatch(notFound, /href="\/desktop\/getting-started\/"/);
  assert.match(notFound, /href="\/desktop\/docs\/"/);
  assert.doesNotMatch(notFound, /(?:href|src)="\.\//);
});

test('live release notes omit GitHub identities and raw URLs', async () => {
  const javascript = fs.readFileSync(path.join(site, 'assets', 'site.js'), 'utf8');
  const releaseNotes = { textContent: '' };
  const selectors = new Map([
    ['[data-release-version]', [{ textContent: '' }]],
    ['[data-release-notes]', [releaseNotes]],
    ['[data-release-date]', [{ textContent: '' }]],
  ]);
  const context = {
    console,
    Date,
    document: {
      documentElement: { classList: { add() {} } },
      querySelectorAll(selector) {
        return selectors.get(selector) || [];
      },
    },
    fetch: async () => ({
      ok: true,
      json: async () => [{
        tag_name: 'v2.1.0-beta.1',
        published_at: '2026-07-26T00:00:00Z',
        body: "## What's Changed\nDesktop polish by @private-owner in https://github.com/private-owner/project/pull/10\n**Full Changelog**: https://github.com/private-owner/project/compare/v1...v2",
      }],
    }),
    matchMedia: () => ({ matches: true }),
    setTimeout,
  };

  vm.runInNewContext(javascript, context);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(releaseNotes.textContent, /Desktop polish/);
  assert.doesNotMatch(releaseNotes.textContent, /private-owner|github\.com|https?:\/\//i);
});

test('landing page transfer stays below 500 KB before optional release metadata', () => {
  const criticalFiles = [
    'index.html',
    'assets/site.css',
    'assets/site.js',
    'assets/command-line-mark.png',
    'assets/targets.jpg',
    'assets/fonts/jetbrains-mono-regular.ttf',
    'assets/fonts/jetbrains-mono-bold.ttf',
  ];
  const bytes = criticalFiles.reduce((total, relative) => (
    total + fs.statSync(path.join(site, relative)).size
  ), 0);
  assert.ok(bytes < 500 * 1024, `Landing transfer is ${bytes} bytes.`);
});

test('getting started presents the recommended agent path before guided setup', () => {
  const guide = fs.readFileSync(path.join(site, 'getting-started', 'index.html'), 'utf8');
  assert.ok(guide.indexOf('id="agent-setup"') < guide.indexOf('id="wizard"'));
  assert.match(guide, /recommended first option/i);
  assert.doesNotMatch(guide, /second empty-state path/i);
});

test('AI workflow docs state the default-on and offline privacy boundary', () => {
  const guide = fs.readFileSync(path.join(site, 'docs', 'ai-workflow.html'), 'utf8');
  assert.match(guide, /AI Workflow<\/strong> is on for new installs/i);
  assert.match(guide, /can be switched off in Settings/i);
  assert.match(guide, /does not scan agent transcripts/i);
  assert.doesNotMatch(guide, /Session summaries have a separate switch/i);
  assert.match(guide, /normal scans never use the network/i);
  assert.match(guide, /“Check links” is the only workflow-maintenance network action/i);
  assert.match(guide, /does not call an LLM/i);
  assert.match(guide, /never launched or probed/i);
  assert.doesNotMatch(guide, /telemetry enabled|analytics enabled/i);
});
