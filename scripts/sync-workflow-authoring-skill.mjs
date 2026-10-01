import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 把 skills/workflow-authoring/SKILL.md 重新生成进 src/skills.ts 的内建技能注册表。
 *
 * 为什么要这个脚本：模型可见的技能必须走既有内建机制（BUILTIN_SKILLS）才"零新安装面"，
 * 而内建正文是 TS 字符串、发布件是 markdown——两份必须逐字同文。手抄必漂，所以生成。
 * 漂移由 test/issue-234-workflow-authoring-skill.test.mjs 的逐字同文锁兜住（改任一处不跑本
 * 脚本即红）；本脚本负责"改了源之后怎么把它落回去"。
 *
 * 用法（仓库根或任意子目录均可）：bun scripts/sync-workflow-authoring-skill.mjs
 * 幂等：按标记块整体替换，可反复跑。
 */

const root = path.resolve(import.meta.dirname, '..');
const SKILL_PATH = path.join(root, 'skills', 'workflow-authoring', 'SKILL.md');
const TARGET_PATH = path.join(root, 'src', 'skills.ts');

const BT = '`';
const SQ = String.fromCharCode(39);
const OPEN = '// >>> 生成件 workflow-authoring（源 = skills/workflow-authoring/SKILL.md；改源后跑 scripts/sync-workflow-authoring-skill.mjs）';
const CLOSE = '// <<< 生成件 workflow-authoring <<<';

const raw = readFileSync(SKILL_PATH, 'utf8');
const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)---\s*\n?/);
if (!frontmatterMatch) throw new Error(`${SKILL_PATH} 缺 frontmatter`);
const body = raw.slice(frontmatterMatch[0].length);
const frontmatter = {};
for (const line of frontmatterMatch[1].split('\n')) {
  const index = line.indexOf(':');
  if (index > 0) frontmatter[line.slice(0, index).trim()] = line.slice(index + 1).trim();
}
for (const field of ['name', 'description', 'when_to_use', 'mode']) {
  if (!frontmatter[field]) throw new Error(`frontmatter 缺 ${field}`);
}

const escape = (value) => value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const reEscape = (value) => value.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
const template = (value) => BT + escape(value) + BT;
const singleQuoted = (value) => SQ + value + SQ;

const contentBlock = [
  OPEN,
  '//     正文与发布件逐字同文由 test/issue-234-workflow-authoring-skill.test.mjs 锁定。>>>',
  'const WORKFLOW_AUTHORING_CONTENT = ', template(body), ';',
  CLOSE,
].join('\n');

const recordBlock = [
  '  ' + OPEN + ' >>>',
  '  // ADR-0052 §23③：随模块发布，零新安装面；改源跑 scripts/sync-workflow-authoring-skill.mjs。',
  '  [' + singleQuoted(frontmatter.name) + ', {',
  '    name: ' + singleQuoted(frontmatter.name) + ',',
  '    description: ' + template(frontmatter.description) + ',',
  '    when_to_use: ' + template(frontmatter.when_to_use) + ',',
  '    mode: ' + singleQuoted(frontmatter.mode) + ',',
  '    content: WORKFLOW_AUTHORING_CONTENT,',
  '  }],',
  '  ' + CLOSE,
].join('\n');

let source = readFileSync(TARGET_PATH, 'utf8');

if (source.includes(OPEN)) {
  // 已生成过：整体替换两个块，不重复插入。
  // 连 OPEN 前的行首空白一起吃掉，替换块自带缩进——否则每跑一次缩进叠一层。
  source = source.replace(new RegExp(`[ \\t]*${reEscape(OPEN)}[\\s\\S]*?${reEscape(CLOSE)}`, 'g'), (match) =>
    (match.includes('const WORKFLOW_AUTHORING_CONTENT') ? contentBlock : recordBlock));
} else {
  const anchor = 'const BUILTIN_SKILLS: Map<string, SkillRecord> = new Map([';
  if (!source.includes(anchor)) throw new Error('BUILTIN_SKILLS 锚点缺失');
  source = source.replace(anchor, contentBlock + '\n\n' + anchor);
  const tail = '  }],\n]);';
  const index = source.indexOf(tail);
  if (index < 0) throw new Error('BUILTIN_SKILLS 表尾锚点缺失');
  source = source.slice(0, index) + '  }],\n' + recordBlock + '\n]);' + source.slice(index + tail.length);
}

writeFileSync(TARGET_PATH, source);
console.log(`已生成：${path.relative(root, TARGET_PATH)} ← ${path.relative(root, SKILL_PATH)}（正文 ${[...body].length} 码点）`);
