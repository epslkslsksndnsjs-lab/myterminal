// Issue #45（ADR-0031 / G9）：cluster.ts 锁 stale 阈值 5000ms vs instances.ts 30000ms 分歧
// 决策块唯一依据：锁 stale 阈值收敛为单一常量单源；两锁的 stale 判定必须一致。
//
// 红灯（修复前应失败）：
//   构造一把"存活进程持有、mtime 落在两阈值之间(10s)的锁"：
//   - cluster.ts 当前用 5000ms → 视 10s 为 stale → 放行（update 不被阻塞）
//   - instances.ts 当前用 30000ms → 视 10s 为 fresh → 阻塞 → 抛 "lock timeout"
//   两锁对同一中间年龄锁做出不同判定 → 分歧被暴露 → 红灯。
//
// 绿灯（修复后应全绿，值无关）：
//   无论统一为 5000 还是 30000，两锁对同一锁必做相同判定（都放行或都阻塞）。
//   本测试只断言"一致性"这一真实需求，不硬编码魔法数字（G6 禁止同义反复）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { PortClusterRegistry, clusterKey } from '../dist/cluster.js';
import { upsertWorkspaceRecord } from '../dist/instances.js';

// 存活进程持有、mtime = 10s 前（严格落在 5000ms 与 30000ms 之间）的锁
function plantStaleLock(lockPath) {
  writeFileSync(lockPath, `${process.pid}:${randomBytes(8).toString('hex')}`, { mode: 0o600 });
  const tenSecAgo = new Date(Date.now() - 10_000);
  utimesSync(lockPath, tenSecAgo, tenSecAgo);
}

test('cluster 与 instances 锁 stale 阈值一致（10s 中间值探针）', () => {
  const clusterDir = mkdtempSync(join(tmpdir(), 'issue45-cluster-'));
  const instDir = mkdtempSync(join(tmpdir(), 'issue45-inst-'));
  try {
    const host = '127.0.0.1';
    const port = 43999; // 仅用于命名锁文件，不绑定端口

    const clusterReg = new PortClusterRegistry(clusterDir, host, port);
    const clusterLock = join(clusterDir, 'clusters', `${clusterKey(host, port)}.json.lock`);
    plantStaleLock(clusterLock);

    const instLock = join(instDir, 'workspaces.json.lock');
    plantStaleLock(instLock);

    let clusterThrew = false;
    try {
      clusterReg.update((state) => state);
    } catch {
      clusterThrew = true;
    }

    let instThrew = false;
    try {
      upsertWorkspaceRecord(instDir, {
        id: 'issue45-test',
        workspaceDir: instDir,
        stateDir: instDir,
        lastSeenAt: new Date().toISOString(),
      });
    } catch {
      instThrew = true;
    }

    // 关键断言：两锁对同一中间年龄锁的判定必须一致（都放行 或 都阻塞）
    assert.equal(
      clusterThrew,
      instThrew,
      `锁 stale 阈值分歧：cluster threw=${clusterThrew}, instances threw=${instThrew} —— 两锁判定不一致（#45 红灯）`,
    );
  } finally {
    rmSync(clusterDir, { recursive: true, force: true });
    rmSync(instDir, { recursive: true, force: true });
  }
});
