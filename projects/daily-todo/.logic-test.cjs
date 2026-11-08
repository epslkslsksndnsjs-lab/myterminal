// 临时逻辑测试：用最小 DOM 桩在 Node 中执行 index.html 里的内联脚本
const fs = require('fs');
const vm = require('vm');

function matches(el, sel) {
  const m = /^([a-zA-Z]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(sel);
  if (!m) return false;
  const [, tag, classes, attrs] = m;
  if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  for (const c of classes.split('.').filter(Boolean)) {
    if (!el.classList.contains(c)) return false;
  }
  for (const a of (attrs.match(/\[[^\]]+\]/g) || [])) {
    let key = a.slice(1, -1).split('=')[0];
    if (key.startsWith('data-')) key = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in el.dataset)) return false;
  }
  return true;
}

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.handlers = {};
    this._text = '';
    this.className = '';
    this.value = '';
    this.disabled = false;
    this.title = '';
    const self = this;
    this.classList = {
      contains: (c) => self.className.split(/\s+/).filter(Boolean).includes(c),
      add: (...cs) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); cs.forEach(c => s.add(c)); self.className = [...s].join(' '); },
      remove: (...cs) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); cs.forEach(c => s.delete(c)); self.className = [...s].join(' '); },
      toggle: (c, force) => {
        const has = self.classList.contains(c);
        const on = force === undefined ? !has : !!force;
        if (on) self.classList.add(c); else self.classList.remove(c);
        return on;
      }
    };
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map(c => c.textContent).join('');
  }
  set textContent(v) {
    this._text = String(v);
    this.children.forEach(c => { c.parentNode = null; });
    this.children = [];
  }
  appendChild(node) {
    if (node.isFragment) {
      node.children.forEach(c => this.appendChild(c));
      node.children = [];
      return node;
    }
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  dispatch(type, target) {
    const evt = { target, preventDefault() {}, stopPropagation() {} };
    (this.handlers[type] || []).forEach(fn => fn(evt));
  }
  closest(sel) {
    let n = this;
    while (n) { if (matches(n, sel)) return n; n = n.parentNode; }
    return null;
  }
  focus() {}
}

function makeEnv(storage) {
  const el = (tag) => new Element(tag);
  const byId = {
    composer: el('form'),
    input: el('input'),
    list: el('ul'),
    filters: el('nav'),
    counter: el('span'),
    clearDone: el('button'),
    dateLabel: el('div')
  };
  ['all', 'active', 'done'].forEach((f, i) => {
    const b = el('button');
    b.dataset.filter = f;
    if (i === 0) b.className = 'active';
    byId.filters.appendChild(b);
  });
  byId.composer.appendChild(byId.input);
  const fragmentHolder = el('div');

  const document = {
    getElementById: (id) => byId[id] || null,
    createElement: (t) => new Element(t),
    createDocumentFragment: () => { const f = new Element('div'); f.isFragment = true; return f; }
  };
  const window = { addEventListener() {} };
  const sandbox = { document, window, localStorage: storage, console, Date, Math, JSON, setTimeout };
  sandbox.globalThis = sandbox;
  return { byId, sandbox, document, fragmentHolder };
}

function makeStorage(seed) {
  const map = new Map(seed || []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    dump: () => new Map(map)
  };
}

const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  通过 · ' + name); }
  else { failures++; console.log('  失败 · ' + name + (extra ? ' -> ' + extra : '')); }
}

const storage = makeStorage();
let env = makeEnv(storage);
vm.runInNewContext(script, env.sandbox, { filename: 'inline.js' });

const { byId } = env;
const items = () => byId.list.children.filter(c => c.classList.contains('item'));
const texts = () => items().map(li => li.children[1].textContent);
const clickList = (target) => byId.list.dispatch('click', target);
const submit = (v) => { byId.input.value = v; byId.composer.dispatch('submit', byId.input); };

console.log('① 初始状态');
check('空列表显示空状态占位', byId.list.children.length === 1 && byId.list.children[0].className === 'empty');
check('计数文案为「还没有待办」', byId.counter.textContent === '还没有待办', byId.counter.textContent);
check('清空已完成按钮为禁用', byId.clearDone.disabled === true);

console.log('② 添加待办');
submit('买牛奶');
submit('写周报');
submit('   ');
check('空白内容不会添加', items().length === 2, '实际 ' + items().length);
check('新条目排在最前', texts()[0] === '写周报' && texts()[1] === '买牛奶', texts().join(' | '));
check('文本内部多余空格被压缩', (submit('  看  文档  '), texts()[0] === '看 文档'), texts()[0]);
check('计数显示剩余项数', byId.counter.textContent === '剩余 3 项 · 已完成 0 项', byId.counter.textContent);
check('表单提交后输入框被清空', byId.input.value === '', JSON.stringify(byId.input.value));

console.log('③ 标记完成 / 取消完成');
// 每次渲染都会重建列表节点，因此断言时始终重新查询当前节点
clickList(items()[0].children[1]); // 点击文本也可以切换
check('点击条目变为已完成', items()[0].classList.contains('done'), items()[0].className);
check('已完成计数更新', byId.counter.textContent === '剩余 2 项 · 已完成 1 项', byId.counter.textContent);
check('清空已完成按钮启用并带数量', byId.clearDone.disabled === false && byId.clearDone.textContent === '清空已完成 (1)', byId.clearDone.textContent);
clickList(items()[0].children[0]); // 再点勾选圈取消
check('再次点击恢复为进行中', !items()[0].classList.contains('done'), items()[0].className);
check('计数回到全部未完成', byId.counter.textContent === '剩余 3 项 · 已完成 0 项', byId.counter.textContent);

console.log('④ 筛选');
clickList(items()[2].children[0]); // 把「买牛奶」标记完成
byId.filters.dispatch('click', byId.filters.children[1]); // 进行中
check('进行中筛选只显示未完成条目', texts().join(',') === '看 文档,写周报', texts().join(','));
check('进行中视图没有已完成条目', items().every(li => !li.classList.contains('done')));
check('筛选按钮高亮切换', byId.filters.children[1].className === 'active' && byId.filters.children[0].className === '');
byId.filters.dispatch('click', byId.filters.children[2]); // 已完成
check('已完成筛选只显示已完成条目', texts().join(',') === '买牛奶', texts().join(','));
byId.filters.dispatch('click', byId.filters.children[0]); // 全部
check('全部筛选恢复所有条目', texts().length === 3);

console.log('⑤ 删除单条');
const beforeDelete = texts();
clickList(items()[0].children[2]);
check('删除后条目减少', items().length === 2, '实际 ' + items().length);
check('删除的是指定条目', !texts().includes(beforeDelete[0]), texts().join(','));
check('删除结果已写入本地存储', storage.getItem('daily-todo.v1').indexOf(beforeDelete[0]) === -1);

console.log('⑥ 一键清空已完成');
clickList(items()[0].children[0]); // 再标记一条完成
const doneNow = items().filter(li => li.classList.contains('done')).length;
check('存在已完成条目', doneNow === 2, '实际 ' + doneNow);
byId.clearDone.dispatch('click', byId.clearDone);
check('已完成条目被全部移除', items().length === 0 && byId.counter.textContent === '还没有待办', texts().join(','));
check('清空后显示空状态占位', byId.list.children.length === 1 && byId.list.children[0].className === 'empty');
check('清空后按钮回到禁用', byId.clearDone.disabled === true && byId.clearDone.textContent === '清空已完成');

console.log('⑦ localStorage 持久化（模拟刷新页面）');
submit('最后一条');
const snapshotTexts = texts();
const snapshotRaw = storage.getItem('daily-todo.v1');
check('数据已序列化保存', typeof snapshotRaw === 'string' && snapshotRaw.length > 2);
const env2 = makeEnv(storage); // 同一份存储，重新执行脚本 = 刷新
vm.runInNewContext(script, env2.sandbox, { filename: 'inline.js' });
const items2 = env2.byId.list.children.filter(c => c.classList.contains('item'));
const texts2 = items2.map(li => li.children[1].textContent);
check('刷新后条目恢复', texts2.join(',') === snapshotTexts.join(','), texts2.join(',') + ' vs ' + snapshotTexts.join(','));
check('刷新后完成状态保留', items2.map(li => li.classList.contains('done')).join(',') === items().map(li => li.classList.contains('done')).join(','));

console.log('⑧ 脏数据容错');
const dirty = makeStorage([['daily-todo.v1', '{"不是":"数组"}']]);
const env3 = makeEnv(dirty);
vm.runInNewContext(script, env3.sandbox, { filename: 'inline.js' });
check('非数组数据不会崩溃', env3.byId.list.children[0].className === 'empty');
const dirty2 = makeStorage([['daily-todo.v1', 'not-json-at-all']]);
const env4 = makeEnv(dirty2);
vm.runInNewContext(script, env4.sandbox, { filename: 'inline.js' });
check('非法 JSON 不会崩溃', env4.byId.list.children[0].className === 'empty');

console.log('⑨ HTML 结构完整性');
check('存在 viewport 元信息', /name="viewport"/.test(html));
check('声明中文语言', /<html lang="zh-CN">/.test(html));
check('无内联外部依赖', !/<script[^>]+src=/.test(html) && !/<link[^>]+href=/.test(html));
check('使用 textContent 渲染用户输入', !/innerHTML/.test(script));

console.log('');
console.log(failures === 0 ? '全部测试通过' : failures + ' 项测试失败');
process.exit(failures === 0 ? 0 : 1);
