# -*- coding: utf-8 -*-
"""sync_skill.py —— 把项目里的技能目录同步到 WorkBuddy 用户技能目录

技能有两处存在：
    A. 项目里（人看、人改）     C:\\Users\\Pjh18\\Desktop\\奶蛙快跑\\游戏制作Skill（图生3D）
    B. WorkBuddy 技能目录（机器读） C:\\Users\\Pjh18\\.workbuddy\\skills\\photo-to-3d-game-actor

为什么不直接做个目录链接：Windows 的目录联接（Junction）在部分文件遍历里
会被当成"符号链接"而不是"目录"，技能扫描有可能整个跳过它。用真实目录 + 显式
同步，行为是确定的。

改完技能记得跑一次：
    py tools/sync_skill.py

默认只覆盖同名文件、补新增文件，不删目标里多出来的东西（安全）。
加 --prune 才做镜像删除 —— 适合确认过"目标里的东西都是旧版本残留"时用。
"""
import argparse
import filecmp
import os
import pathlib
import shutil
import sys

HOME = pathlib.Path(os.environ.get("USERPROFILE", pathlib.Path.home()))
SRC = pathlib.Path(__file__).resolve().parent.parent / "游戏制作Skill（图生3D）"
DST = HOME / ".workbuddy" / "skills" / "photo-to-3d-game-actor"

SKIP_DIRS = {"__pycache__", ".git"}
SKIP_FILES = {".DS_Store", "Thumbs.db"}


def walk(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in filenames:
            if f in SKIP_FILES:
                continue
            p = pathlib.Path(dirpath) / f
            out.append(p.relative_to(root))
    return sorted(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prune", action="store_true", help="删除目标里多出来的文件（镜像）")
    ap.add_argument("--check", action="store_true", help="只报告差异，不写盘")
    a = ap.parse_args()

    if not SRC.exists():
        sys.exit("源目录不存在：%s" % SRC)
    if not DST.exists():
        if a.check:
            print("目标目录不存在：%s" % DST)
            return
        DST.mkdir(parents=True, exist_ok=True)

    src_files = walk(SRC)
    dst_files = walk(DST)
    added, changed, same = [], [], []
    for rel in src_files:
        s, d = SRC / rel, DST / rel
        if not d.exists():
            added.append(rel)
        elif filecmp.cmp(s, d, shallow=False):
            same.append(rel)
        else:
            changed.append(rel)
    extra = [r for r in dst_files if r not in set(src_files)]

    print("源：%s" % SRC)
    print("目标：%s\n" % DST)
    for rel in added:
        print("  + %s" % rel)
    for rel in changed:
        print("  ~ %s" % rel)
    for rel in extra:
        print("  - %s%s" % (rel, "  (将被删除)" if a.prune else "  (目标多出，未删)"))
    print("\n共 新增 %d / 更新 %d / 相同 %d / 多余 %d"
          % (len(added), len(changed), len(same), len(extra)))

    if a.check:
        print("\n[--check] 只报告，未写盘")
        return
    if not added and not changed and not (a.prune and extra):
        print("\n已是最新，无需同步。")
        return

    for rel in added + changed:
        d = DST / rel
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SRC / rel, d)
    if a.prune:
        for rel in extra:
            (DST / rel).unlink()
    print("\n同步完成。技能目录已是真实目录，改动即时对 WorkBuddy 生效。")
    print("若设置页仍看不到，重启 WorkBuddy 让它重新扫描技能目录。")


if __name__ == "__main__":
    main()
