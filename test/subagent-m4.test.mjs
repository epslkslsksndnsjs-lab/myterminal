// test/subagent-m4.test.mjs — M4 Subagent 工具系统测试
// ≥ 25 用例：接口/工厂(4) + execute_cli(6) + read/write/edit(8) + glob/grep(4) + task(3) + 集成(1)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 从构建产物导入
import { buildTool, getTool, getAllToolSchemas, getToolNames } from '../dist/subagent/tools.js';

let TMP;

function makeCtx(overrides = {}) {
  return {
    cwd: TMP,
    signal: new AbortController().signal,
    agentId: 'test-agent-m4',
    ...overrides,
  };
}

describe('M4 接口/工厂/注册表', () => {
  it('buildTool 缺 name 抛错', () => {
    assert.throws(
      () => buildTool({ name: '', description: 'desc', inputSchema: { type: 'object', properties: {} }, call: async () => ({}), isReadOnly: true }),
      /name is required/,
    );
  });

  it('buildTool 缺 description 抛错', () => {
    assert.throws(
      () => buildTool({ name: 'test', description: '', inputSchema: { type: 'object', properties: {} }, call: async () => ({}), isReadOnly: true }),
      /description is required/,
    );
  });

  it('buildTool 缺 inputSchema 抛错', () => {
    assert.throws(
      () => buildTool({ name: 'test', description: 'desc', call: async () => ({}), isReadOnly: true }),
      /inputSchema is required/,
    );
  });

  it('isConcurrencySafe 默认跟随 isReadOnly', () => {
    const t1 = buildTool({ name: 'r', description: 'd', inputSchema: {}, call: async () => ({}), isReadOnly: true });
    assert.strictEqual(t1.isConcurrencySafe, true);
    const t2 = buildTool({ name: 'w', description: 'd', inputSchema: {}, call: async () => ({}), isReadOnly: false });
    assert.strictEqual(t2.isConcurrencySafe, false);
  });

  it('isConcurrencySafe 传函数时保留函数', () => {
    const fn = () => true;
    const t = buildTool({ name: 'x', description: 'd', inputSchema: {}, call: async () => ({}), isReadOnly: false, isConcurrencySafe: fn });
    assert.strictEqual(typeof t.isConcurrencySafe, 'function');
    assert.strictEqual(t.isConcurrencySafe, fn);
  });

  it('getToolNames({ readOnly: true }) 返回 5 个只读工具（Bug 2 回归）', () => {
    const names = getToolNames({ readOnly: true });
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('glob'));
    assert.ok(names.includes('grep'));
    assert.ok(names.includes('task_create'));
    assert.ok(names.includes('task_update'));
    assert.strictEqual(names.length, 5);
  });

  it('getAllToolSchemas() 返回 8 个 schema，edit_file 含 replace_all（Bug 3 回归）', () => {
    const schemas = getAllToolSchemas();
    assert.strictEqual(schemas.length, 8);
    const editSchema = schemas.find((s) => s.name === 'edit_file');
    assert.ok(editSchema);
    assert.ok(editSchema.input_schema.properties.replace_all, 'replace_all should be in edit_file schema');
    // old_string 含 minLength:1（决策 36）
    assert.strictEqual(editSchema.input_schema.properties.old_string.minLength, 1);
  });
});

describe('M4 execute_cli', () => {
  it('echo hello → stdout 含 hello，非 is_error', async () => {
    const tool = getTool('execute_cli');
    const result = await tool.call({ command: 'echo hello' }, makeCtx());
    assert.ok(result.stdout.includes('hello'));
    assert.strictEqual(result.exitCode, 0);
    assert.ok(!result.is_error);
  });

  it('grep nonexistent → grep exit 1 非 is_error（决策 32）', async () => {
    writeFileSync(join(TMP, 'test.txt'), 'line1\nline2\n');
    const tool = getTool('execute_cli');
    // grep 搜索不存在的模式——exit 1 = 无匹配
    const result = await tool.call({ command: 'grep nonexistent test.txt' }, makeCtx());
    // grep exit 1 = "无匹配" 非错误（决策 32）
    assert.ok(!result.is_error);
  });

  it('ls; rm -rf / → checkPermissions deny', () => {
    const tool = getTool('execute_cli');
    const decision = tool.checkPermissions({ command: 'ls; rm -rf /' }, makeCtx());
    assert.strictEqual(decision, 'deny');
  });

  it('大输出截断', async () => {
    const tool = getTool('execute_cli');
    const result = await tool.call({ command: 'node -e "console.log(\'x\'.repeat(60000))"' }, makeCtx());
    // stdout 可能被截断
    const out = result.stdout;
    assert.ok(out.includes('Result truncated') || out.length < 60000);
  });

  it('isConcurrencySafe 函数：安全命令 true，危险命令 false（决策 31）', () => {
    const tool = getTool('execute_cli');
    // execute_cli 的 isConcurrencySafe 是函数
    const safeFn = tool.isConcurrencySafe;
    assert.strictEqual(typeof safeFn, 'function');
    assert.strictEqual(safeFn({ command: 'ls' }), true);
    assert.strictEqual(safeFn({ command: 'cat file.txt' }), true);
    assert.strictEqual(safeFn({ command: 'echo hello' }), true);
    // rm 不在 SAFE_PATTERNS 中 → false
    assert.strictEqual(safeFn({ command: 'rm file.txt' }), false);
  });

  it('checkPermissions 在 readOnly 模式下拒绝非安全命令', () => {
    const tool = getTool('execute_cli');
    // echo 是所有子命令命中 SAFE → allow
    const decision = tool.checkPermissions({ command: 'echo safe' }, makeCtx({ readOnly: true }));
    assert.strictEqual(decision, 'allow');

    // ark 不在 SAFE_PATTERNS → readOnly=true 时 deny（决策 17）
    const denyDecision = tool.checkPermissions({ command: 'node script.js' }, makeCtx({ readOnly: true }));
    assert.strictEqual(denyDecision, 'deny');
  });
});

describe('M4 read_file / write_file / edit_file', () => {
  before(() => {
    writeFileSync(join(TMP, 'hello.txt'), 'line1\nline2\nline3\nline4\nline5');
    writeFileSync(join(TMP, 'binary.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    mkdirSync(join(TMP, 'subdir'));
  });

  it('read_file 带行号格式 + totalLines/startLine/endLine 正确', async () => {
    const tool = getTool('read_file');
    const result = await tool.call({ path: 'hello.txt' }, makeCtx());
    assert.ok(result.content.startsWith('1\tline1'));
    assert.strictEqual(result.totalLines, 5);
    assert.strictEqual(result.startLine, 1);
    assert.strictEqual(result.endLine, 5);
  });

  it('read_file 二进制文件拒绝 + 文案含 binary file（决策 35）', async () => {
    const tool = getTool('read_file');
    const result = await tool.call({ path: 'binary.png' }, makeCtx());
    assert.strictEqual(result.is_error, true);
    assert.ok(result.message.includes('binary'), `Expected 'binary' in message: ${result.message}`);
  });

  it('read_file 目录路径 → 拒绝 + 文案含 directory（决策 35）', async () => {
    const tool = getTool('read_file');
    const result = await tool.call({ path: 'subdir' }, makeCtx());
    assert.strictEqual(result.is_error, true);
    assert.ok(result.message.includes('directory'));
  });

  it('read_file 不存在 → 文案含 File not found（决策 35）', async () => {
    const tool = getTool('read_file');
    const result = await tool.call({ path: 'nonexistent.txt' }, makeCtx());
    assert.strictEqual(result.is_error, true);
    assert.ok(result.message.includes('File not found'));
  });

  it('write_file 新文件 → action: created + 自动建父目录', async () => {
    const tool = getTool('write_file');
    const result = await tool.call({ path: 'nested/deep/test.js', content: 'const x = 1;\n' }, makeCtx());
    assert.strictEqual(result.action, 'created');
    const fileContent = readFileSync(join(TMP, 'nested/deep/test.js'), 'utf8');
    assert.strictEqual(fileContent, 'const x = 1;\n');
  });

  it('write_file 重复写入 → action: overwritten', async () => {
    writeFileSync(join(TMP, 'overwrite-me.txt'), 'old');
    const tool = getTool('write_file');
    const result = await tool.call({ path: 'overwrite-me.txt', content: 'new' }, makeCtx());
    assert.strictEqual(result.action, 'overwritten');
  });

  it('edit_file 未先 read → 拒绝（M2 file-state integration）', async () => {
    writeFileSync(join(TMP, 'no-read.txt'), 'hello world');
    const tool = getTool('edit_file');
    const result = await tool.call({ path: 'no-read.txt', old_string: 'hello', new_string: 'hi' }, makeCtx());
    assert.strictEqual(result.is_error, true);
    assert.ok(result.message.includes('not been read'));
  });

  it('edit_file 先读后改成功，diff 预览含 -/+ 行；replace_all 全替换', async () => {
    writeFileSync(join(TMP, 'edit-test.txt'), 'function foo() {\n  return 1;\n}\nfunction foo() {\n  return 2;\n}');
    // 先 read_file
    const readTool = getTool('read_file');
    await readTool.call({ path: 'edit-test.txt' }, makeCtx());

    // old_string 出现 2 次，不传 replace_all → 报错
    const editTool = getTool('edit_file');
    const r1 = await editTool.call({ path: 'edit-test.txt', old_string: 'foo', new_string: 'bar' }, makeCtx());
    assert.strictEqual(r1.is_error, true);

    // replace_all 替换全部
    const r2 = await editTool.call({ path: 'edit-test.txt', old_string: 'foo', new_string: 'bar', replace_all: true }, makeCtx());
    assert.strictEqual(r2.is_error, undefined);
    assert.strictEqual(r2.success, true);
    assert.ok(r2.diff.includes('-') || r2.diff.includes('+'));

    // 验证文件内容
    const content = readFileSync(join(TMP, 'edit-test.txt'), 'utf8');
    assert.ok(!content.includes('foo'));
    assert.ok(content.includes('bar'));
  });

  it('edit_file old_string 空字符串 → schema minLength:1（决策 36）', () => {
    const editTool = getTool('edit_file');
    assert.strictEqual(editTool.inputSchema.properties.old_string.minLength, 1);
  });

  it('resolvePath 防穿越：../../etc/passwd 抛错', async () => {
    const tool = getTool('read_file');
    await assert.rejects(
      () => tool.call({ path: '../../etc/passwd' }, makeCtx()),
      /outside working directory/,
    );
  });

  it('ADR-0015 resolvePath symlink 逃逸拒绝（#20 核心）', async () => {
    // 在 cwd 内创建指向 /etc/passwd 的 symlink
    const symlinkPath = join(TMP, 'escape-link');
    try { symlinkSync('/etc/passwd', symlinkPath); } catch { /* 已存在 */ }
    const tool = getTool('read_file');
    await assert.rejects(
      () => tool.call({ path: 'escape-link' }, makeCtx()),
      /symlink|outside/,
    );
    try { unlinkSync(symlinkPath); } catch { /* ignore */ }
  });
});

describe('M4 glob / grep', () => {
  before(() => {
    mkdirSync(join(TMP, 'src'), { recursive: true });
    mkdirSync(join(TMP, 'src', 'utils'), { recursive: true });
    mkdirSync(join(TMP, 'node_modules'), { recursive: true });
    mkdirSync(join(TMP, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(TMP, 'src', 'index.ts'), 'export {};');
    writeFileSync(join(TMP, 'src', 'utils', 'helper.ts'), 'export function help() {}');
    writeFileSync(join(TMP, 'node_modules', 'pkg', 'index.js'), '');
    writeFileSync(join(TMP, 'README.md'), '# Test');
  });

  it('glob **/*.ts 排除 node_modules（决策 33）+ 返回相对路径', async () => {
    const tool = getTool('glob');
    const result = await tool.call({ pattern: '**/*.ts' }, makeCtx());
    const files = result.files;
    assert.ok(files.includes('src/index.ts'), `Expected src/index.ts in: ${files}`);
    assert.ok(files.includes('src/utils/helper.ts'), `Expected src/utils/helper.ts in: ${files}`);
    // node_modules 应被排除
    assert.ok(!files.includes('node_modules'));
    // 返回相对路径
    assert.ok(!files.includes(TMP));
  });

  it('glob 超 200 个文件 → truncated: true + header 含真实总数（决策 34）', async () => {
    mkdirSync(join(TMP, 'many'), { recursive: true });
    for (let i = 0; i < 250; i++) {
      writeFileSync(join(TMP, 'many', `file_${i}.txt`), 'content');
    }
    const tool = getTool('glob');
    const result = await tool.call({ pattern: 'many/*.txt' }, makeCtx());
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.matchCount, 250);
    const files = result.files;
    assert.ok(files.includes('(showing first 200)'));
    assert.ok(files.includes('Found 250 files'));
  });

  it('grep 命中返回 file:line:text；无命中 → 非 is_error', async () => {
    const tool = getTool('grep');
    const r1 = await tool.call({ pattern: 'export' }, makeCtx());
    assert.ok(r1.matchCount > 0);
    assert.ok(r1.results.includes('src/index.ts'));
    assert.ok(r1.results.includes(':'));
    assert.ok(!r1.is_error);

    const r2 = await tool.call({ pattern: 'nonexistent_xyzzy_12345' }, makeCtx());
    assert.strictEqual(r2.matchCount, 0);
    assert.ok(!r2.is_error);
  });

  it('grep 非法正则 → 友好错误', async () => {
    const tool = getTool('grep');
    const result = await tool.call({ pattern: '[unclosed' }, makeCtx());
    assert.strictEqual(result.is_error, true);
    assert.ok(result.message.includes('Invalid regex'));
  });

  it('grep include *.ts 过滤生效', async () => {
    const tool = getTool('grep');
    // 带 include:*.ts 不应匹配 README.md
    const r = await tool.call({ pattern: 'export', include: '*.ts' }, makeCtx());
    assert.ok(!r.results.includes('README.md'));
  });
});

describe('M4 task_create / task_update', () => {
  it('task_create → 返回 id/subject', async () => {
    const tool = getTool('task_create');
    const result = await tool.call({ subject: 'Test task', description: 'A test' }, makeCtx());
    const task = result.task;
    assert.ok(task);
    assert.ok(task.id);
    assert.strictEqual(task.subject, 'Test task');
    assert.ok(task.id.startsWith('task_'));
  });

  it('task_update 状态机：pending→in_progress→completed 正常流转', async () => {
    const agentCtx = makeCtx({ agentId: 'test-agent-flow' });
    const createTool = getTool('task_create');
    const created = await createTool.call({ subject: 'Flow test', description: 'Testing flow' }, agentCtx);
    const taskId = created.task.id;

    // pending → in_progress
    const updateTool = getTool('task_update');
    const r1 = await updateTool.call({ taskId, status: 'in_progress' }, agentCtx);
    assert.ok(!r1.is_error);
    assert.strictEqual(r1.task.status, 'in_progress');

    // in_progress → completed
    const r2 = await updateTool.call({ taskId, status: 'completed' }, agentCtx);
    assert.ok(!r2.is_error);
    assert.strictEqual(r2.allDone, true);
    assert.ok(r2.message.includes('All tasks completed'));
  });

  it('task_update 非法跳转报 Invalid transition', async () => {
    const agentCtx = makeCtx({ agentId: 'test-agent-invalid' });
    const createTool = getTool('task_create');
    const created = await createTool.call({ subject: 'Invalid test', description: 'desc' }, agentCtx);
    const taskId = created.task.id;

    // pending → completed 直接跳
    const updateTool = getTool('task_update');
    const r = await updateTool.call({ taskId, status: 'completed' }, agentCtx);
    assert.strictEqual(r.is_error, true);
    assert.ok(r.message.includes('Invalid transition'));
  });
});

describe('M4 集成用例', () => {
  it('模拟 LLM 操作序列：glob → read_file ×2 → edit_file → task_create → task_update → execute_cli', async () => {
    const agentCtx = makeCtx({ agentId: 'integ-test-agent' });

    writeFileSync(join(TMP, 'a.ts'), 'const hello = "world";\n');
    writeFileSync(join(TMP, 'b.ts'), 'const foo = "bar";\n');

    // 1. glob
    const globTool = getTool('glob');
    const globResult = await globTool.call({ pattern: '*.ts' }, agentCtx);
    assert.ok(globResult.files.includes('a.ts'));

    // 2. read_file ×2
    const readTool = getTool('read_file');
    const r1 = await readTool.call({ path: 'a.ts' }, agentCtx);
    const r2 = await readTool.call({ path: 'b.ts' }, agentCtx);
    assert.ok(!r1.is_error);
    assert.ok(!r2.is_error);

    // 3. edit_file
    const editTool = getTool('edit_file');
    const e1 = await editTool.call({ path: 'a.ts', old_string: 'world', new_string: '地球' }, agentCtx);
    assert.strictEqual(e1.success, true);

    // 4. task_create + task_update
    const createTool = getTool('task_create');
    const task = await createTool.call({ subject: 'Integration task', description: 'desc' }, agentCtx);
    const updateTool = getTool('task_update');
    await updateTool.call({ taskId: task.task.id, status: 'in_progress' }, agentCtx);
    const updated = await updateTool.call({ taskId: task.task.id, status: 'completed' }, agentCtx);
    assert.strictEqual(updated.allDone, true);

    // 5. execute_cli 验证（跨平台：echo 在所有 shell 都可用）
    const execTool = getTool('execute_cli');
    const execResult = await execTool.call({ command: 'echo hello-from-shell' }, agentCtx);
    assert.ok(execResult.stdout.includes('hello-from-shell'), `echo failed: ${JSON.stringify(execResult)}`);
    // 用 read_file 验证编辑结果（避免 shell 编码问题）
    const verifyResult = await readTool.call({ path: 'a.ts' }, agentCtx);
    assert.ok(verifyResult.content.includes('地球'));
    assert.ok(verifyResult.content.includes('hello'));
  });
});

// ── 测试前后 ──
before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'm4-test-'));
});

after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* cleanup */ }
});
