// SEC-01 regression tests: user-supplied regexes must not be able to block the
// event loop.
//
// Layer 1: validateSafeRegex rejects the known catastrophic shapes up front.
// Layer 2: IsolatedRegexMatcher is the authoritative guard - it runs the pattern
//          in a worker thread and terminates it when the budget is spent, so a
//          pattern that slips past the static gate still cannot stall the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MyTerminalRuntime } from '../dist/server.js';
import { IsolatedRegexMatcher, REGEX_BATCH_MAX_CHARS, REGEX_MATCH_TIMEOUT_MS, validateSafeRegex } from '../dist/security.js';

const CONNECTOR_KEY = 'test-connector-key-1234567890';
const ACTIONS_TOKEN = 'test-actions-token-12345678901234567890';

// Pattern that is exponential in the number of 'a's, yet structurally boring:
// no group, no alternation, so no static gate can reject it.
const SLOW_PATTERN = 'a*a*a*a*a*a*a*a*a*a*b';
const SLOW_LINE = 'a'.repeat(64);

function tempWorkspace(files = {}) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-sec01-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(workspaceDir, name), content);
  return { workspaceDir, stateDir };
}

async function createRuntime(files = {}) {
  const dirs = tempWorkspace(files);
  const runtime = new MyTerminalRuntime({
    ...dirs,
    settingsPath: path.join(dirs.stateDir, 'test-settings.json'),
    host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN,
    publicBaseUrl: 'http://127.0.0.1:0', maxOutputChars: 20_000, commandTimeoutSec: 10,
    uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false, actionsContinuationMode: 'off',
  });
  await runtime.start();
  return {
    runtime, dirs, baseUrl: `http://127.0.0.1:${runtime.port}`,
    async close() { await runtime.close(); fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); },
  };
}

async function action(server, endpoint, body) {
  const response = await fetch(`${server.baseUrl}/actions/extensions/${endpoint}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function call(server, tool, input = {}, identity) { return action(server, 'call', { tool, input, ...(identity ? { identity } : {}) }); }
async function root(server, name = 'main') {
  const response = await call(server, 'session_register', { mode: 'root', name, role: 'lead' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.ok, true);
  return response.body.data.result;
}

// ---- Layer 1: static gate (dangerous repetition structures) ----
test('static gate rejects dangerous repetition structures', () => {
  const dangerous = [
    '(a+)+', '(a*)*', '([a-z]+){2,}', '(a+)?', '(\\d+)+$', '((a+))+', '([a-zA-Z]+)+\\d',
    // overlapped-branch repetition: exponential although star height is 1
    '(a|aa)+', '(a|ab)*', '(x|x)+', '(?:a|aa)+', '(ab|a)+$', '(a|)+', '(\\d|\\d\\d){2,}',
  ];
  for (const source of dangerous) {
    assert.throws(() => validateSafeRegex(source), `expected rejection: ${source}`);
  }
});

test('static gate still accepts ordinary patterns', () => {
  const safe = [
    'abc', '\\d+', '(\\w+)\\s+(\\w+)', '^https?://', '[a-z]{2,5}', '(\\d{4})-(\\d{2})-(\\d{2})',
    'function\\s+(\\w+)\\s*\\(', '(foo|bar)+', '(?:ab|cd)+', '(a|b)', '(cat|dog|bird)',
    '^\\s*async\\s+function', 'import\\s+.*from\\s+[\'"].*[\'"]',
  ];
  for (const source of safe) {
    assert.doesNotThrow(() => validateSafeRegex(source), `expected accepted: ${source}`);
  }
});

test('static gate bounds finite input (length and balance)', () => {
  assert.throws(() => validateSafeRegex('a'.repeat(1001)), /limit/);
  assert.doesNotThrow(() => validateSafeRegex('a'.repeat(1000)));
  assert.throws(() => validateSafeRegex('(abc'), /Unbalanced/);
  assert.throws(() => validateSafeRegex('abc)'), /Unbalanced/);
});

// ---- Layer 2: isolated, interruptible execution ----
test('isolated matcher returns match indices for a benign pattern', async () => {
  const matcher = await IsolatedRegexMatcher.create('needle', { flags: 'i', timeoutMs: 2_000 });
  try {
    const outcome = await matcher.testLines(['haystack', 'NEEDLE here', 'nothing', 'needle twice needle']);
    assert.deepEqual(outcome, { status: 'ok', matched: [1, 3] });
  } finally {
    await matcher.dispose();
  }
});

test('isolated matcher honours stopAfter', async () => {
  const matcher = await IsolatedRegexMatcher.create('needle', { flags: 'i', timeoutMs: 2_000 });
  try {
    const outcome = await matcher.testLines(['needle', 'needle', 'needle'], { stopAfter: 2 });
    assert.deepEqual(outcome, { status: 'ok', matched: [0, 1] });
  } finally {
    await matcher.dispose();
  }
});

test('isolated matcher chunks long input and keeps match offsets', async () => {
  const longLine = 'x'.repeat(REGEX_BATCH_MAX_CHARS * 2 + 7);
  const lines = [longLine, 'needle after a huge line', longLine, 'tail needle'];
  const matcher = await IsolatedRegexMatcher.create('needle', { flags: 'i', timeoutMs: 5_000 });
  try {
    const outcome = await matcher.testLines(lines);
    assert.deepEqual(outcome, { status: 'ok', matched: [1, 3] });
  } finally {
    await matcher.dispose();
  }
});

test('catastrophic pattern times out and does not block the event loop', async () => {
  const matcher = await IsolatedRegexMatcher.create(SLOW_PATTERN, { flags: 'i', timeoutMs: 300 });
  const heartbeats = [];
  const heartbeat = setInterval(() => heartbeats.push(Date.now()), 10);
  const startedAt = Date.now();
  let outcome;
  try {
    outcome = await matcher.testLines([SLOW_LINE]);
  } finally {
    clearInterval(heartbeat);
    await matcher.dispose();
  }
  const elapsed = Date.now() - startedAt;
  assert.equal(outcome.status, 'timeout', `expected timeout, got ${JSON.stringify(outcome)}`);
  assert.ok(elapsed < 2_000, `timeout must be bounded, took ${elapsed}ms`);
  // The main thread kept running while the worker was stuck: the event loop was
  // never blocked by the regex.
  assert.ok(heartbeats.length >= 5, `event loop must stay responsive, saw ${heartbeats.length} heartbeats`);
});

test('per-request budget is honoured for the default timeout constant', async () => {
  const matcher = await IsolatedRegexMatcher.create(SLOW_PATTERN, { flags: 'i', timeoutMs: 100 });
  try {
    const startedAt = Date.now();
    const outcome = await matcher.testLines([SLOW_LINE]);
    const elapsed = Date.now() - startedAt;
    assert.equal(outcome.status, 'timeout');
    assert.ok(elapsed < 1_500, `budget overshoot: ${elapsed}ms`);
  } finally {
    await matcher.dispose();
  }
  assert.ok(REGEX_MATCH_TIMEOUT_MS >= 100, 'default budget must be a sane positive number');
});

test('batch deadline stops a long list of lines early', async () => {
  const matcher = await IsolatedRegexMatcher.create('needle', { flags: 'i', timeoutMs: 2_000 });
  try {
    const lines = Array.from({ length: 4_000 }, () => 'needle');
    const outcome = await matcher.testLines(lines, { deadline: Date.now() - 1 });
    // A deadline that has already passed yields a timeout instead of scanning on.
    assert.equal(outcome.status, 'timeout');
  } finally {
    await matcher.dispose();
  }
});

test('matcher rejects unusable sources instead of compiling them on the event loop', async () => {
  await assert.rejects(() => IsolatedRegexMatcher.create('a'.repeat(1_001)), /limit/);
  await assert.rejects(() => IsolatedRegexMatcher.create('(unterminated'), /Invalid|Unterminated|Unbalanced|parenthes/i);
  await assert.rejects(() => IsolatedRegexMatcher.create(''), /non-empty/);
});

// ---- End to end: search_text ----
test('search_text returns promptly when a regex exhausts its budget', async () => {
  const server = await createRuntime({ 'slow.txt': `${SLOW_LINE}\n` });
  try {
    const identity = (await root(server, 'sec01-timeout')).identity;
    const startedAt = Date.now();
    const res = await call(server, 'search_text', { query: SLOW_PATTERN, regex: true }, identity);
    const elapsed = Date.now() - startedAt;
    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    const result = res.body.data.result;
    // The pattern is not statically rejectable, so the isolated matcher is what
    // stops it: the call is truncated by the budget rather than hanging.
    assert.equal(result.truncated, true, `expected truncated result, got ${JSON.stringify(result)}`);
    assert.ok(elapsed < 10_000, `search_text must not hang, took ${elapsed}ms`);
  } finally {
    await server.close();
  }
}, { timeout: 30_000 });

test('search_text rejects statically dangerous regex before executing it', async () => {
  const server = await createRuntime({ 'a.txt': `${SLOW_LINE}\n` });
  try {
    const identity = (await root(server, 'sec01-static')).identity;
    for (const query of ['(a+)+', '(a|aa)+$', '(\\d+)+$']) {
      const res = await call(server, 'search_text', { query, regex: true }, identity);
      assert.equal(res.body.ok, false, `must reject ${query}: ${JSON.stringify(res.body)}`);
    }
  } finally {
    await server.close();
  }
});

test('search_text still matches with regex over long input', async () => {
  const longLine = `prefix ${'y'.repeat(REGEX_BATCH_MAX_CHARS + 32)} needle-suffix`;
  const server = await createRuntime({ 'big.txt': [longLine, 'plain line', 'needle two'].join('\n') });
  try {
    const identity = (await root(server, 'sec01-long')).identity;
    const res = await call(server, 'search_text', { query: 'needle(-|\\s)', regex: true }, identity);
    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    const result = res.body.data.result;
    assert.equal(result.truncated, false, JSON.stringify(result));
    const lines = result.matches.map((match) => match.line).sort((a, b) => a - b);
    assert.deepEqual(lines, [1, 3], JSON.stringify(result.matches));
  } finally {
    await server.close();
  }
}, { timeout: 30_000 });

test('search_text regex results are case-insensitive and capped by limit', async () => {
  const server = await createRuntime({ 'a.txt': 'Needle one\nneedle two\nNEEDLE three\nnothing\n' });
  try {
    const identity = (await root(server, 'sec01-limit')).identity;
    const all = await call(server, 'search_text', { query: 'needle', regex: true }, identity);
    assert.equal(all.body.ok, true, JSON.stringify(all.body));
    assert.deepEqual(all.body.data.result.matches.map((match) => match.line), [1, 2, 3]);

    const capped = await call(server, 'search_text', { query: 'needle', regex: true, limit: 2 }, identity);
    assert.equal(capped.body.ok, true, JSON.stringify(capped.body));
    assert.equal(capped.body.data.result.matches.length, 2);
    assert.equal(capped.body.data.result.truncated, true);
  } finally {
    await server.close();
  }
});
