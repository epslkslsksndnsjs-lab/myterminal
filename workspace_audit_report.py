#!/usr/bin/env python3
"""工作区只读审计报告 CLI。

递归统计指定目录（默认当前目录）的文件数量、总字节数、扩展名分布与最大文件 Top N。
严格只读：不写入/修改任何文件；不跟随符号链接；默认跳过 .git、node_modules、.venv、
__pycache__；无法访问的条目只记告警并继续。仅用标准库，Python 3.8+。

    python3 workspace_audit_report.py ./src --top 5
    python3 workspace_audit_report.py --json > report.json
"""

from __future__ import annotations

import argparse
import heapq
import json
import os
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

DEFAULT_EXCLUDED_DIRS: Tuple[str, ...] = (".git", "node_modules", ".venv", "__pycache__")
DEFAULT_TOP: int = 10
UNKNOWN_EXTENSION: str = "<无扩展名>"
MAX_ERRORS_KEPT: int = 20
MAX_EXTENSIONS_SHOWN: int = 15
BYTE_UNITS: Tuple[str, ...] = ("B", "KB", "MB", "GB", "TB", "PB")


@dataclass
class AuditResult:
    """一次扫描的汇总结果，只含路径与大小等元数据，不含任何文件内容。"""

    root: str
    file_count: int = 0
    total_bytes: int = 0
    extension_counts: Counter = field(default_factory=Counter)
    extension_bytes: Counter = field(default_factory=Counter)
    top_files: List[Tuple[int, str]] = field(default_factory=list)
    skipped_dirs: Counter = field(default_factory=Counter)
    symlinks_skipped: int = 0
    error_count: int = 0
    errors: List[str] = field(default_factory=list)
    elapsed_seconds: float = 0.0


def format_bytes(size: int) -> str:
    """把字节数格式化为易读字符串，例如 ``1536`` -> ``1.5 KB``。"""
    value = float(size)
    for unit in BYTE_UNITS:
        if value < 1024 or unit == BYTE_UNITS[-1]:
            return f"{int(value)} B" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"  # pragma: no cover


def _record_error(result: AuditResult, path: str, exc: OSError) -> None:
    """记录一次访问错误：全部计数，只保留前 MAX_ERRORS_KEPT 条样例。"""
    result.error_count += 1
    if len(result.errors) < MAX_ERRORS_KEPT:
        result.errors.append(f"{path}: {exc.__class__.__name__}: {exc}")


def _keep_top_file(top: List[Tuple[int, str]], size: int, path: str, limit: int) -> None:
    """用小根堆维护“最大的 N 个文件”，避免把所有文件都留在内存里。"""
    if limit <= 0:
        return
    item = (size, path)
    if len(top) < limit:
        heapq.heappush(top, item)
    elif item > top[0]:
        heapq.heapreplace(top, item)


def audit_workspace(
    root: str,
    top_n: int = DEFAULT_TOP,
    excluded_dirs: Sequence[str] = DEFAULT_EXCLUDED_DIRS,
) -> AuditResult:
    """只读扫描 ``root`` 并返回统计结果。

    ``top_n`` 为保留的最大文件数量（0 表示不统计）；``excluded_dirs`` 为按目录名跳过的目录。
    目录不存在抛 FileNotFoundError，存在但不是目录抛 NotADirectoryError。
    """
    root_abs = os.path.abspath(root)
    if not os.path.exists(root_abs):
        raise FileNotFoundError(f"目录不存在: {root_abs}")
    if not os.path.isdir(root_abs):
        raise NotADirectoryError(f"不是目录: {root_abs}")

    excluded, stack = frozenset(excluded_dirs), [root_abs]
    result = AuditResult(root=root_abs)
    started_at = time.perf_counter()
    while stack:  # 显式栈遍历，避免深目录递归爆栈
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except OSError as exc:
            _record_error(result, current, exc)
            continue
        for entry in entries:
            try:
                if entry.is_symlink():  # 符号链接一律不跟随、不统计
                    result.symlinks_skipped += 1
                    continue
                if entry.is_dir(follow_symlinks=False):
                    if entry.name in excluded:
                        result.skipped_dirs[entry.name] += 1
                    else:
                        stack.append(entry.path)
                    continue
                if not entry.is_file(follow_symlinks=False):
                    continue  # FIFO / socket / 设备文件直接忽略
                size = entry.stat(follow_symlinks=False).st_size
            except OSError as exc:
                _record_error(result, entry.path, exc)
                continue
            extension = os.path.splitext(entry.name)[1].lower() or UNKNOWN_EXTENSION
            result.file_count += 1
            result.total_bytes += size
            result.extension_counts[extension] += 1
            result.extension_bytes[extension] += size
            _keep_top_file(result.top_files, size, os.path.relpath(entry.path, root_abs), top_n)
    result.top_files.sort(reverse=True)
    result.elapsed_seconds = time.perf_counter() - started_at
    return result


def _sorted_extensions(result: AuditResult) -> List[Tuple[str, int, int]]:
    """按字节数降序返回 ``(扩展名, 文件数, 字节数)`` 列表。"""
    rows = [(e, n, result.extension_bytes.get(e, 0)) for e, n in result.extension_counts.items()]
    return sorted(rows, key=lambda row: (-row[2], -row[1], row[0]))


def render_text(result: AuditResult, top_n: int) -> str:
    """把扫描结果渲染成人类可读的文本报告。"""
    skipped = ", ".join(f"{k}({v})" for k, v in sorted(result.skipped_dirs.items())) or "无"
    rows = _sorted_extensions(result)
    lines = [
        "=" * 62,
        "工作区审计报告（只读扫描）",
        "=" * 62,
        f"根目录:       {result.root}",
        f"扫描耗时:     {result.elapsed_seconds:.3f} 秒",
        f"文件总数:     {result.file_count}",
        f"总字节数:     {format_bytes(result.total_bytes)} ({result.total_bytes} 字节)",
        f"跳过目录:     {skipped}",
        f"跳过符号链接: {result.symlinks_skipped} 个",
        f"访问错误:     {result.error_count} 个",
        "",
        f"扩展名分布（按字节数排序，最多 {MAX_EXTENSIONS_SHOWN} 项）:",
    ]
    if rows:
        lines.append(f"  {'扩展名':<16}{'文件数':>10}{'字节数':>16}")
        lines += [f"  {e[:16]:<16}{n:>10}{format_bytes(s):>16}" for e, n, s in rows[:MAX_EXTENSIONS_SHOWN]]
        rest = rows[MAX_EXTENSIONS_SHOWN:]
        if rest:
            lines.append(
                f"  {f'(其他 {len(rest)} 项)':<16}{sum(r[1] for r in rest):>10}"
                f"{format_bytes(sum(r[2] for r in rest)):>16}"
            )
    else:
        lines.append("  （没有找到文件）")
    lines += ["", f"最大的 {top_n} 个文件:" if top_n > 0 else "最大的文件: 未统计（--top 0）"]
    if top_n > 0 and not result.top_files:
        lines.append("  （没有找到文件）")
    lines += [f"  {i:>3}. {format_bytes(s):>10}  {p}" for i, (s, p) in enumerate(result.top_files, 1)]
    if result.errors:
        lines += ["", f"访问告警（最多显示 {MAX_ERRORS_KEPT} 条）:"]
        lines += [f"  - {message}" for message in result.errors]
    return "\n".join(lines)


def build_json_payload(result: AuditResult, top_n: int) -> Dict[str, Any]:
    """构造 ``--json`` 输出所需的可序列化字典。"""
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "root": result.root,
        "elapsed_seconds": round(result.elapsed_seconds, 6),
        "file_count": result.file_count,
        "total_bytes": result.total_bytes,
        "total_human": format_bytes(result.total_bytes),
        "skipped_dirs": dict(sorted(result.skipped_dirs.items())),
        "symlinks_skipped": result.symlinks_skipped,
        "extensions": [
            {"extension": e, "file_count": n, "bytes": s} for e, n, s in _sorted_extensions(result)
        ],
        "largest_files": [
            {"size_bytes": s, "path": p} for s, p in result.top_files[: max(top_n, 0)]
        ],
        "errors": {"count": result.error_count, "samples": list(result.errors)},
    }


def build_parser() -> argparse.ArgumentParser:
    """构造命令行参数解析器。"""
    parser = argparse.ArgumentParser(
        prog="workspace_audit_report.py",
        description="只读统计工作区：文件数量、总字节数、扩展名分布、最大文件 Top N。",
    )
    parser.add_argument("directory", nargs="?", default=".", help="要审计的目录，默认当前目录")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出（默认输出可读文本）")
    parser.add_argument(
        "--top", type=int, default=DEFAULT_TOP, metavar="N",
        help=f"输出最大的 N 个文件，默认 {DEFAULT_TOP}；0 表示不统计",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    """CLI 入口，返回退出码：0 成功，1 运行错误，2 路径/参数错误。"""
    args = build_parser().parse_args(argv)
    if args.top < 0:
        print("错误: --top 需要大于等于 0 的整数", file=sys.stderr)
        return 2
    try:
        result = audit_workspace(args.directory, top_n=args.top)
    except (FileNotFoundError, NotADirectoryError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("已中断。", file=sys.stderr)
        return 130
    except OSError as exc:
        print(f"错误: 无法扫描 {args.directory}: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(build_json_payload(result, args.top), ensure_ascii=False, indent=2))
    else:
        print(render_text(result, args.top))
    return 0


if __name__ == "__main__":
    sys.exit(main())
