import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ['.git', 'dist', 'node_modules'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

test('bilingual documentation links resolve and private archive data is not published', () => {
  const markdown = walk(root).filter((file) => file.endsWith('.md'));
  assert.ok(markdown.some((file) => file.endsWith('README.zh-CN.md')));
  for (const file of markdown) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /Actions-Tutorial|ChatGPT-GPTHomePage/, file);
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
      assert.ok(fs.existsSync(resolved), `${path.relative(root, file)} -> ${target}`);
    }
  }
  const publishedAssets = walk(path.join(root, 'docs', 'assets'));
  assert.equal(publishedAssets.some((file) => /\.(html|css|js)$/i.test(file)), false);
  assert.equal(publishedAssets.filter((file) => file.endsWith('.jpg')).length, 8);
  assert.equal(publishedAssets.filter((file) => file.endsWith('.svg')).length, 6);
  for (const file of publishedAssets.filter((item) => item.endsWith('.jpg'))) {
    const bytes = fs.readFileSync(file);
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8], file);
  }
  for (const file of publishedAssets.filter((item) => item.endsWith('.svg'))) {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /v0\.1\.0/, file);
    assert.doesNotMatch(text, /v1\.0\.1/, file);
  }
});

test('stable release metadata and binary installers stay pinned to v0.1.1', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.1.1');
  // assert.equal(pkg.license, 'Apache-2.0');
  for (const file of ['README.md', 'README.zh-CN.md', 'RELEASE_NOTES.md', 'scripts/install-macos.sh', 'scripts/install-linux.sh', 'scripts/install-windows.ps1']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, /v0\.1\.0/);
  }
});

test('both READMEs explain Chat mode purpose and repeat-launch commands', () => {
  const english = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const chinese = fs.readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8');
  assert.match(english, /normal chat mode a controlled way to work on your local computer/);
  assert.match(chinese, /普通 Chat 对话模式也能以可控方式在本地电脑上工作/);
  assert.match(english, /Start it again later/);
  assert.match(chinese, /第二次及以后快速启动/);
  assert.match(english, /register the global `myterminal` command/);
  assert.match(chinese, /把 `myterminal` 注册成当前用户的全局命令/);
  assert.match(english, /```text\r?\nmyterminal\r?\n```/);
  assert.match(chinese, /```text\r?\nmyterminal\r?\n```/);
});

test('binary installers use versioned releases, checksums, atomic current pointers, and stable launchers', () => {
  const mac = fs.readFileSync(path.join(root, 'scripts', 'install-macos.sh'), 'utf8');
  const linux = fs.readFileSync(path.join(root, 'scripts', 'install-linux.sh'), 'utf8');
  const windows = fs.readFileSync(path.join(root, 'scripts', 'install-windows.ps1'), 'utf8');
  for (const unix of [mac, linux]) {
    assert.match(unix, /releases\/\$version/);
    assert.match(unix, /\.sha256/);
    assert.match(unix, /mv "\$install_dir\/current\.tmp" "\$install_dir\/current"/);
    assert.match(unix, /exec "\\\$root\/releases\/\\\$version\/myterminal"/);
    assert.doesNotMatch(unix, /bun install|run src\/cli\.ts/);
  }
  assert.match(windows, /releases/);
  assert.match(windows, /Get-FileHash -Algorithm SHA256/);
  assert.match(windows, /Move-Item -LiteralPath \$CurrentTmp -Destination \$CurrentPath -Force/);
  assert.match(windows, /myterminal\.cmd/);
  assert.doesNotMatch(windows, /bun install|run src\\cli\.ts/);
});

test('release notes contain substantive Chinese release and verification guidance', () => {
  const notes = fs.readFileSync(new URL('../RELEASE_NOTES.md', import.meta.url), 'utf8');
  assert.match(notes, /## 中文说明/);
  assert.match(notes, /Windows 已知限制/);
  assert.match(notes, /PowerShell 7\.6\.3/);
  assert.match(notes, /keyboard-only compatibility mode/);
  const chinese = notes.match(/[\u3400-\u9fff]/g) || [];
  assert.ok(chinese.length >= 200, `expected substantial Chinese content, got ${chinese.length} characters`);
});

test('harness introduction and architecture match v0.1.0 without stale process reports', () => {
  for (const file of ['docs/GPT_INSTRUCTIONS.md', 'docs/GPT_INSTRUCTIONS.zh-CN.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, /0\.1\.0/);
    assert.match(text, /extensionDiscover/);
    assert.match(text, /extensionCall/);
    assert.match(text, /extensionRegister/);
    assert.match(text, /running/);
    assert.match(text, /completed/);
    assert.match(text, /failed/);
    assert.match(text, /timeout/);
    assert.match(text, /identity:null/);
    assert.match(text, /identity:\{\}/);
    assert.match(text, /next-call/);
    assert.match(text, /lookahead-3/);
    assert.match(text, /200ms/);
    assert.match(text, /task_poll/);
    assert.match(text, /working checkpoint/);
    assert.match(text, /off[\s\S]{0,220}nextCalls (?:is optional|可省略)/);
    assert.doesNotMatch(text, /every working checkpoint (?:must )?use the server continuation contract/);
    assert.doesNotMatch(text, /每个 working checkpoint 都必须使用服务器续执行协议/);
  }
  for (const file of ['docs/ACTIONS_SETUP.md', 'docs/ACTIONS_SETUP.zh-CN.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, /ApiTypeError: Expected identity to be a dict/);
    assert.match(text, /identity:null/);
    assert.match(text, /identity:\{\}/);
    assert.match(text, /CONTINUATION_PLAN_REQUIRED/);
    assert.match(text, /NEXT_CALL_REQUIRED/);
    assert.match(text, /lookahead-3/);
    assert.match(text, /static OpenAPI schema does not need to be re-imported|静态 OpenAPI schema 不需要重新导入/);
  }
  const architecture = fs.readFileSync(path.join(root, 'docs', 'architecture.md'), 'utf8');
  assert.match(architecture, /config\.json/);
  assert.doesNotMatch(architecture, /settings\.json/);
  assert.match(architecture, /450ms/);
  assert.match(architecture, /control-channel\.ts/);
  assert.match(architecture, /200ms/);
  assert.match(architecture, /content-addressed Blob/);
  for (const obsolete of ['docs/issues', 'docs/coupling-analysis.md', 'docs/pre-release-acceptance-2026-07-21.md', 'docs/stability-acceptance-2026-07-21.md', 'docs/manual-acceptance-2026-07-22.zh-CN.md']) {
    assert.equal(fs.existsSync(path.join(root, obsolete)), false, obsolete);
  }
});
