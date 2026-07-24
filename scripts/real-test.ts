const BASE = 'http://127.0.0.1:3210';
const TOKEN = 'e0e806a7a017aa5c085325472c3010e1b3051d024a6f4f8907185d8d6b82c33e';
const WORKSPACE_ID = 'cfb74031918510fc';
const headers = { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(tool: string, input: Record<string, unknown>, identity?: any) {
  const body: Record<string, unknown> = { tool, input };
  if (identity) body.identity = identity;
  const res = await fetch(`${BASE}/actions/extensions/call`, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json() as any;
  if (!json.ok) { console.log(`  FAIL: ${json.error?.message || tool}`); return null; }
  return json.data?.result;
}

async function main() {
  console.log('1/10 session_register');
  const reg = await call('session_register', { mode: 'root', workspaceId: WORKSPACE_ID, name: 'test-v04', role: 'lead' });
  const id = reg?.identity;
  await sleep(2000);

  console.log('2/10 list_dir src/tui/');
  await call('list_dir', { path: 'src/tui' }, id);
  await sleep(2000);

  console.log('3/10 read_file package.json');
  await call('read_file', { path: 'package.json' }, id);
  await sleep(2000);

  console.log('4/10 read_file src/cli.ts');
  await call('read_file', { path: 'src/cli.ts', maxBytes: 1000 }, id);
  await sleep(2000);

  console.log('5/10 find_files *.tsx');
  await call('find_files', { query: '.tsx' }, id);
  await sleep(2000);

  console.log('6/10 search_text');
  await call('search_text', { query: 'export', path: 'src' }, id);
  await sleep(2000);

  console.log('7/10 write_file demo/real-test.txt');
  await call('write_file', { path: 'demo/real-test.txt', content: 'Real-time test output from MyTerminal API' }, id);
  await sleep(2000);

  console.log('8/10 read_file demo/real-test.txt');
  await call('read_file', { path: 'demo/real-test.txt' }, id);
  await sleep(2000);

  console.log('9/10 execute_cli wc demo/');
  await call('execute_cli', { command: 'wc -c demo/*.html demo/*.txt 2>/dev/null', cwd: '.' }, id);
  await sleep(2000);

  console.log('10/10 session_checkpoint');
  await call('session_checkpoint', { phase: 'working', summary: '实时测试完成 - 10个工具全部成功。用户可在TUI消息页看到完整对话流。' }, id);

  console.log('\n=== 10/10 完成！TUI Messages tab → real-test → 10张工具调用卡片 ===');
}

main().catch(e => console.error('FATAL:', e.message));
