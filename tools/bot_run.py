# -*- coding: utf-8 -*-
"""跑 #bot 一段虚拟时间，读左下角统计：起跳 / 越过 / 死亡。用法: py tools/bot_run.py [秒]"""
import os, re, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

secs = int(sys.argv[1]) if len(sys.argv) > 1 else 20
prof = tempfile.mkdtemp(prefix="nwbot_")
args = [
    CHROME, "--headless=old", "--disable-gpu", "--no-sandbox",
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--user-data-dir=" + prof, "--allow-file-access-from-files",
    "--virtual-time-budget=%d" % (secs * 1000),
    "--window-size=1280,720",
    "--dump-dom", "file:///" + os.path.join(ROOT, "index.html").replace("\\", "/") + "#bot",
]
dom = subprocess.run(args, capture_output=True, timeout=secs * 4 + 120).stdout.decode("utf-8", "replace")
m = re.search(r"起跳 (\d+) 次 · 越过 (\d+) 个 · 死亡 (\d+) 次", dom)
if not m:
    print("!! 没抓到 bot 统计（游戏可能没启动）")
    sys.exit(2)
j, c, d = (int(x) for x in m.groups())
print("起跳 %d 次 · 越过 %d 个 · 死亡 %d 次" % (j, c, d))
if d == 0 and j > 0:
    print("✓ 机器人在真实游戏循环里全程无伤")
elif j == 0:
    print("!! 一次都没起跳，检查 bot 逻辑")
else:
    print("△ 有死亡，需要看死亡原因（换道失败或判定问题）")
    sys.exit(1)
