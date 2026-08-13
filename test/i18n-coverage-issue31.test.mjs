// #31（批5 第 10 刀 / ADR-0032 / G4）i18n 单一来源 + 去 zh prop-drilling —— seam 锁定
//
// 主理人裁定（2026-07-31）：范围取方案 A（只做 seam），并纳入 src/workspace-selection.ts。
// 全量字典化（把 224 条字符串键值化搬进 copy/en.ts + zh-CN.ts）不在本刀范围。
//
// 本文件两部分性质不同，分开声明避免混淆：
//
// (a) 行为锁 —— 重构前先绿，重构后必须原样绿。
//     方案 A 只改变字符串的「承载形式」（zh ? Z : E  →  t(E, Z)），不改变字符串本身，
//     也不跨文件搬运字符串。因此「每个文件的字符串字面量多重集」是零假阴性的行为快照：
//     任何错字、漏搬、串行、误删都会让某个文件的多重集与基线不等。
//     测试跑在 dist/ 上、无终端渲染器，做不了渲染快照，所以行为锁只能走源码级字面量比对——
//     这是本刀行为锁的真实强度边界，不粉饰。
//     基线：test/fixtures/i18n-literals-issue31.json，最初生成自重构前 HEAD(198214e)，
//     现 55 文件 / 1758 条字面量。收割逻辑与生成器共用 test/fixtures/i18n-harvest.mjs（单源）。
//
//     重锁记录（2026-07-31，#70 门禁下）：本轮对 #14（致命错误屏不再泄漏开发指令）、
//     #17（设置字段两份 11 分支级联收敛为单一注册表）做了正当改动，二者都触碰了 TUI 层
//     文件，使字面量多重集发生预期内漂移，打破了原始冻结基线。经逐条人工核对，三条漂移
//     均非 i18n 回归（无 zh/CJK 串被改、无 t() 参数颠倒——那些由本文件其余子测试继续守住，
//     且全绿）：
//       · FatalErrorBoundary.tsx 新增 DevInvariantError + 两语用户向兜底文案（#14 新功能）
//       · context.tsx 新增 DevInvariantError 类名字面量（#14）
//       · controller-logic.ts 删 11 字段标识的重复副本（两份级联→注册表，2→1 份；
//         运行期行为不变，已由 tui-controller-logic-issue29 的 16 例锁证明）、新增 3 处
//         workspace-unavailable（注册表内出现 3 处）。净变化 1762→1758。
//     本锁是「重新审查后重锁」路径（测试注释预留：字面量总数变化需重新审查后重锁），
//     重锁后继续作为 TUI 层字面量回归护栏。
//
//     重锁记录（2026-08-13，#22 / ADR-0046 D2）：Home.tsx SessionGroupRow 挂载实时 token 计数器
//     （↑N），新增 6 条字面量——两个模板体（↑${k.toFixed(1).replace(/\.0$/, '')}k、↑${total}）、
//     completed/failed/aborted 状态比较、none（新 text 节点 wrapMode）。净变化 1760→1766。
//     逐条核对：均为新功能引入的用户向/状态字面量，无 zh/CJK 串被改、无 t() 参数颠倒
//     （由其余子测试守住且全绿），属预期内漂移，重新审查后重锁。
//
// (b) 覆盖率断言 —— 重构前红、重构后绿。这是本刀的目标指标，不是锁。
//     断言 seam 作用域内不再存在 `zh ? … : …` 三元与 `zh: boolean` / `zh={zh}` prop 传递。

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, FIXTURE, scopeFiles, stripComments, snapshotScope } from './fixtures/i18n-harvest.mjs';
import * as harvest from './fixtures/i18n-harvest.mjs';

/** i18n 机制本体所在文件，允许出现语言判定（含 context.tsx 里 I18n 类型的 `zh: boolean`）。
 *  键一律 POSIX 分隔符，与 scopeFiles() 的产出口径一致（见 PLATFORM-LOCK-1）。 */
const MECHANISM_FILES = new Set([
  'src/tui/copy/index.ts',
  'src/tui/copy/i18n.ts',
  'src/tui/copy/context.tsx',
]);

function readScope(file) {
  const full = path.join(ROOT, file);
  return fs.existsSync(full) ? stripComments(fs.readFileSync(full, 'utf8')) : undefined;
}

function diffMultiset(from, to) {
  const pool = [...to];
  const missing = [];
  for (const item of from) {
    const at = pool.indexOf(item);
    if (at === -1) missing.push(item);
    else pool.splice(at, 1);
  }
  return missing;
}

describe('#31 i18n seam', () => {

  // ─── (a) 行为锁 ───
  test('behaviour lock: per-file string literal multiset matches frozen baseline', () => {
    assert.ok(fs.existsSync(FIXTURE), `基线缺失：${FIXTURE}`);
    const baseline = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const current = snapshotScope();

    const drift = [];
    for (const [file, expected] of Object.entries(baseline)) {
      const actual = current[file];
      if (!actual) { drift.push(`${file}: 文件消失`); continue; }
      const missing = diffMultiset(expected, actual);
      const added = diffMultiset(actual, expected);
      if (missing.length || added.length) {
        drift.push(`${file}\n    丢失: ${JSON.stringify(missing)}\n    新增: ${JSON.stringify(added)}`);
      }
    }
    assert.equal(drift.length, 0, `字面量漂移（行为锁破裂）:\n  ${drift.join('\n  ')}`);
  });

  test('behaviour lock: baseline scope stays intact', () => {
    const baseline = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    for (const file of Object.keys(baseline)) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `基线文件被删除：${file}`);
    }
    assert.equal(Object.keys(baseline).length, 55, '基线文件数变化，行为锁作用域被改动');
    const total = Object.values(baseline).reduce((sum, list) => sum + list.length, 0);
    assert.equal(total, 1766, '基线字面量总数变化，需重新审查后重锁');
  });

  // ─── (b) 覆盖率断言：红 → 绿 ───
  test('coverage: no `zh ? … : …` ternary outside the i18n mechanism', () => {
    const offenders = [];
    for (const file of scopeFiles()) {
      if (MECHANISM_FILES.has(file)) continue;
      const source = readScope(file);
      if (!source) continue;
      source.split('\n').forEach((line, index) => {
        // 只拦「内联字符串翻译三元」zh ? 'x' : 'y'（含模板串）。
        // 放行 BottomNav 那种基于 context 语言标志选标签数组的 zh ? A : B（非翻译三元）。
        if (/\bzh\s*\?\s*(['"`])/.test(line)) offenders.push(`${file}:${index + 1}  ${line.trim()}`);
      });
    }
    assert.equal(offenders.length, 0, `残留 zh 三元 ${offenders.length} 处:\n  ${offenders.join('\n  ')}`);
  });

  test('coverage: no boolean `zh` prop drilled through the component tree', () => {
    const offenders = [];
    for (const file of scopeFiles()) {
      if (MECHANISM_FILES.has(file)) continue;
      const source = readScope(file);
      if (!source) continue;
      source.split('\n').forEach((line, index) => {
        if (/\bzh\s*:\s*boolean/.test(line) || /\bzh=\{/.test(line)) {
          offenders.push(`${file}:${index + 1}  ${line.trim()}`);
        }
      });
    }
    assert.equal(offenders.length, 0, `残留 zh prop ${offenders.length} 处:\n  ${offenders.join('\n  ')}`);
  });

  // ─── 参数顺序护栏：t(en, zh) 必须 en 在前、zh 在后 ───
  // `zh ? Z : E` → `t(E, Z)` 是纯机械变换，唯一会悄悄写错的就是把参数颠成 `t(Z, E)`。
  // 字面量行为锁抓不到这种交换（en/zh 两个字符串都还在），所以用「CJK 必须在第二参」做硬护栏。
  test('coverage: t(en, zh) keeps CJK in the second argument (en-first / zh-second)', () => {
    const offenders = [];
    const T_CALL = /\bt\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)\s*,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)\s*\)/g;
    const hasCjk = (s) => /[㐀-鿿]/.test(s);
    for (const file of scopeFiles()) {
      if (MECHANISM_FILES.has(file)) continue;
      const source = readScope(file);
      if (!source) continue;
      let m;
      while ((m = T_CALL.exec(source))) {
        const a = m[1].slice(1, -1);
        const b = m[2].slice(1, -1);
        if (hasCjk(a) && !hasCjk(b)) {
          offenders.push(`${file}: t(...) 顺序颠倒（en 应在前、zh 在后）—— t('${a}', '${b}')`);
        }
      }
    }
    assert.equal(offenders.length, 0, `t() 参数顺序错误 ${offenders.length} 处:\n  ${offenders.join('\n  ')}`);
  });

  // ─── i18n 单源契约 ───
  test('i18nFor returns a memoized single instance per language', async () => {
    const { i18nFor } = await import('../dist/tui/copy/i18n.js');
    const zh = i18nFor('zh-CN');
    const en = i18nFor('en');
    assert.equal(i18nFor('zh-CN'), zh, 'i18nFor 必须记忆化，否则每帧新对象会击穿 React memo');
    assert.equal(i18nFor('en'), en);
    assert.equal(zh.zh, true);
    assert.equal(en.zh, false);
    assert.equal(zh.lang, 'zh-CN');
    assert.equal(en.lang, 'en');
    assert.equal(zh.t('English', '中文'), '中文');
    assert.equal(en.t('English', '中文'), 'English');
  });

  test('i18nFor.copy stays identical to the legacy copyFor output', async () => {
    const { i18nFor } = await import('../dist/tui/copy/i18n.js');
    const { copyFor } = await import('../dist/tui/copy/index.js');
    assert.equal(i18nFor('zh-CN').copy, copyFor(true));
    assert.equal(i18nFor('en').copy, copyFor(false));
  });

  test('unknown language falls back to en, matching config validation', async () => {
    const { i18nFor } = await import('../dist/tui/copy/i18n.js');
    assert.equal(i18nFor('fr'), i18nFor('en'));
  });

  // ─── 跨平台护栏（Windows CI 回归，2026-07-31）───
  // 症状：Windows CI 上行为锁报 55 个文件全部「文件消失」，macOS/Ubuntu 全绿。
  // 根因：作用域键用 path.relative/path.join 生成，Windows 上是 `src\tui\App.tsx`，
  //       而基线 JSON 在 POSIX 平台生成、键是 `src/tui/App.tsx` —— 键全体对不上。
  // 这两条锁把「键口径」与「换行口径」固定成平台无关，避免同类平台差异再次咬人。

  test('PLATFORM-LOCK-1: 作用域键一律 POSIX 分隔符（平台无关，Windows CI 防线）', () => {
    assert.equal(
      typeof harvest.toPosixKey, 'function',
      '收割器必须导出 toPosixKey()，作为作用域键的唯一归一化入口',
    );
    // 归一化语义：Windows 分隔符必须被折成 POSIX；POSIX 输入原样不动。
    assert.equal(harvest.toPosixKey('src\\tui\\App.tsx'), 'src/tui/App.tsx');
    assert.equal(harvest.toPosixKey('src\\workspace-selection.ts'), 'src/workspace-selection.ts');
    assert.equal(harvest.toPosixKey('src/tui/App.tsx'), 'src/tui/App.tsx');

    // 实际产出的键不得含反斜杠，且必须与基线键集合完全一致。
    const keys = scopeFiles();
    const backslashed = keys.filter((k) => k.includes('\\'));
    assert.equal(backslashed.length, 0, `作用域键含平台分隔符: ${JSON.stringify(backslashed)}`);

    const baselineKeys = Object.keys(JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))).sort();
    assert.deepEqual(keys.slice().sort(), baselineKeys, '作用域键与基线键不一致（平台差异或作用域漂移）');

    // 机制文件豁免名单必须与作用域键同口径，否则 Windows 上豁免会静默失效。
    for (const mech of MECHANISM_FILES) {
      assert.ok(!mech.includes('\\'), `机制文件名单含平台分隔符: ${mech}`);
      assert.ok(keys.includes(mech), `机制文件不在作用域内（口径不一致）: ${mech}`);
    }
  });

  test('PLATFORM-LOCK-2: 字面量收割对 CRLF 与 LF 源产出一致（换行口径平台无关）', () => {
    // 无 .gitattributes 时 Windows checkout 可能落 CRLF；跨行模板字面量会把 \r 收进多重集。
    const lf = "const a = 'x';\nconst b = `line1\nline2`;\n";
    const crlf = lf.replace(/\n/g, '\r\n');
    assert.deepEqual(
      harvest.harvestLiterals(crlf),
      harvest.harvestLiterals(lf),
      'CRLF 源与 LF 源的字面量多重集必须相同，否则行为锁在 Windows 上假红',
    );
  });
});
