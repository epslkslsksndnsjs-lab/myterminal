#!/usr/bin/env python3
"""按扩展名统计目录下文件的数量与总大小，并按总大小降序输出报表。

仅使用 Python 标准库。
"""

import argparse
import os
import sys
import unicodedata
from collections import defaultdict

DEFAULT_DIR = "/Users/Admin/myterminal"
NO_EXT_LABEL = "(无扩展名)"

SIZE_UNITS = ("B", "KB", "MB", "GB", "TB", "PB")


def human_size(num_bytes):
    """把字节数格式化为人类可读的大小字符串。"""
    size = float(num_bytes)
    unit_index = 0
    while size >= 1024.0 and unit_index < len(SIZE_UNITS) - 1:
        size /= 1024.0
        unit_index += 1
    if unit_index == 0:
        return "%d %s" % (int(size), SIZE_UNITS[unit_index])
    return "%.2f %s" % (size, SIZE_UNITS[unit_index])


def display_width(text):
    """计算字符串的终端显示宽度（中日韩全角字符占 2 列）。"""
    width = 0
    for char in text:
        if unicodedata.east_asian_width(char) in ("W", "F", "A"):
            width += 2
        else:
            width += 1
    return width


def pad(text, width, align="left"):
    """按显示宽度补空格，保证含中文的表头对齐。"""
    padding = max(0, width - display_width(text))
    if align == "right":
        return " " * padding + text
    return text + " " * padding


def normalize_ext(filename):
    """提取归一化扩展名；无扩展名时返回占位标签。"""
    _, ext = os.path.splitext(filename)
    ext = ext.lower()
    if not ext or ext == ".":
        return NO_EXT_LABEL
    return ext


def collect_stats(root):
    """遍历目录，返回 {扩展名: [文件数, 总字节数]}。"""
    stats = defaultdict(lambda: [0, 0])
    scanned_files = 0
    total_bytes = 0
    errors = []

    for dirpath, dirnames, filenames in os.walk(root, onerror=errors.append):
        # 稳定遍历顺序，便于结果可复现
        dirnames.sort()
        for name in sorted(filenames):
            full_path = os.path.join(dirpath, name)
            if not os.path.isfile(full_path):
                continue  # 跳过 FIFO、套接字、断链符号链接等
            try:
                size = os.path.getsize(full_path)
            except OSError as exc:
                errors.append(exc)
                continue
            entry = stats[normalize_ext(name)]
            entry[0] += 1
            entry[1] += size
            scanned_files += 1
            total_bytes += size

    return stats, scanned_files, total_bytes, errors


def build_rows(stats):
    """生成 (扩展名, 数量, 字节数) 列表，按总大小降序、数量降序、扩展名升序。"""
    rows = [(ext, count, size) for ext, (count, size) in stats.items()]
    rows.sort(key=lambda row: (-row[2], -row[1], row[0]))
    return rows


def print_report(rows, scanned_files, total_bytes, total_exts, top, root):
    """打印报表正文。"""
    shown = rows if top is None else rows[:top]

    ext_width = max([display_width("扩展名")] + [display_width(r[0]) for r in shown])
    rows_width = max([display_width("排行")] + [len(str(len(shown)))])
    size_texts = [human_size(r[2]) for r in shown] or ["0 B"]
    size_width = max([display_width("总大小")] + [display_width(s) for s in size_texts])
    count_width = max([display_width("数量")] + [len(str(r[1])) for r in shown])

    print("目录: %s" % root)
    print("扫描文件数: %d，扩展名种类: %d，总大小: %s"
          % (scanned_files, total_exts, human_size(total_bytes)))
    print("")

    if not rows:
        print("未发现任何文件。")
        return

    header = "  ".join([
        pad("排行", rows_width),
        pad("扩展名", ext_width),
        pad("数量", count_width, "right"),
        pad("总大小", size_width, "right"),
        pad("占比", 7, "right"),
    ])
    print(header)
    print("-" * display_width(header))

    for index, (ext, count, size) in enumerate(shown, start=1):
        share = (size / total_bytes * 100.0) if total_bytes else 0.0
        print("  ".join([
            pad(str(index), rows_width),
            pad(ext, ext_width),
            pad(str(count), count_width, "right"),
            pad(human_size(size), size_width, "right"),
            pad("%.1f%%" % share, 7, "right"),
        ]))

    if top is not None and top < len(rows):
        print("")
        print("已按 --top %d 限制显示，其余 %d 种扩展名未列出。"
              % (top, len(rows) - top))


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="file-stats.py",
        description="按扩展名统计目录下文件的数量与总大小，并按总大小降序输出报表。",
    )
    parser.add_argument(
        "directory",
        nargs="?",
        default=DEFAULT_DIR,
        help="要统计的目录（默认: %s）" % DEFAULT_DIR,
    )
    parser.add_argument(
        "-n", "--top",
        type=int,
        metavar="N",
        default=None,
        help="只显示总大小最大的前 N 行（默认显示全部）",
    )
    args = parser.parse_args(argv)

    if args.top is not None and args.top < 1:
        parser.error("--top 必须是大于等于 1 的整数")

    return args


def main(argv=None):
    args = parse_args(argv)
    root = os.path.abspath(os.path.expanduser(args.directory))

    if not os.path.exists(root):
        print("错误: 目录不存在: %s" % root, file=sys.stderr)
        return 2
    if not os.path.isdir(root):
        print("错误: 不是目录: %s" % root, file=sys.stderr)
        return 2

    stats, scanned_files, total_bytes, errors = collect_stats(root)
    rows = build_rows(stats)

    if errors:
        print("警告: 有 %d 个路径无法读取（权限等原因），已跳过。" % len(errors),
              file=sys.stderr)

    print_report(rows, scanned_files, total_bytes, len(rows), args.top, root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
