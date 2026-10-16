import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 盘面写入的三条纪律（终态可认领的前提）：
 *   1. 机器件一律原子写——同目录 temp + rename，读者永远看不到半截文件；
 *   2. 临时文件用完必清，任何出口都不留 `.tmp` 残留；
 *   3. 终态标记用独占创建（O_EXCL），后到者读到已有标记即退让。
 */

const FILE_MODE = 0o600;

async function ensureParent(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** 原子写：temp（同目录、随机名、0600）+ rename。写入失败清 temp 后原样抛出。 */
export async function writeJsonAtomic(file: string, value: unknown, mode: number = FILE_MODE): Promise<void> {
  await ensureParent(file);
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await open(temp, 'wx', mode);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 读一个 JSON 件；不存在返回 undefined（缺失 ≠ 损坏，损坏照抛）。 */
export async function readJson(file: string): Promise<unknown | undefined> {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * 独占创建：已存在返回 false（调用方据此退让），创建成功返回 true。
 *
 * 发布动作是 link 而不是 rename——rename 会静默覆盖已有目标，那就不是"独占"了：
 * 两个结算者同刻到达会互相盖掉对方的终态声明。link 在目标已存在时失败，
 * 于是"先到者赢、后到者退让"成为磁盘层面的事实。
 */
export async function createExclusive(file: string, content: string, mode: number = FILE_MODE): Promise<boolean> {
  await ensureParent(file);
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await open(temp, 'wx', mode);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temp, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // 存在但不可读：按存在处理，交由后续读取暴露真实错误。
    if ((error as NodeJS.ErrnoException).code === 'EACCES') return true;
    throw error;
  }
}

/** 静默删除（force）：文件本就不存在不是错误，用于重开终态标记 / 释放锁。 */
export async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true }).catch(() => undefined);
}

/** 单写者按行追加：journal 的写入口，每次一行，写完即落盘。 */
export async function appendLine(file: string, line: string, mode: number = FILE_MODE): Promise<void> {
  await ensureParent(file);
  const handle = await open(file, 'a', mode);
  try {
    await handle.writeFile(`${line}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 整文件覆写（journal 截断场景：先写 temp 再原子替换）。 */
export async function replaceLinesAtomic(file: string, lines: string[], mode: number = FILE_MODE): Promise<void> {
  await ensureParent(file);
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temp, lines.length ? `${lines.join('\n')}\n` : '', { mode, flag: 'wx' });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readLines(file: string): Promise<string[]> {
  try {
    const raw = await readFile(file, 'utf8');
    return raw.split('\n').filter((line) => line.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
