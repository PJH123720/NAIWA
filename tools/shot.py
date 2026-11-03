# -*- coding: utf-8 -*-
"""headless 截图小工具。用法: py tools/shot.py <hash> <输出名> [budget_ms]"""
import os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
SHOTS = os.path.join(ROOT, ".shots")
os.makedirs(SHOTS, exist_ok=True)


def shot(hash_, name, budget=9000, size="1280,720"):
    prof = tempfile.mkdtemp(prefix="nwshot_")
    out = os.path.join(SHOTS, name)
    args = [
        CHROME, "--headless=old", "--disable-gpu", "--no-sandbox",
        "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        "--user-data-dir=" + prof, "--allow-file-access-from-files",
        "--hide-scrollbars", "--window-size=" + size,
        "--virtual-time-budget=%d" % budget,
        "--screenshot=" + out,
        "file:///" + os.path.join(ROOT, "index.html").replace("\\", "/") + hash_,
    ]
    subprocess.run(args, capture_output=True, timeout=240)
    return out


if __name__ == "__main__":
    h = sys.argv[1] if len(sys.argv) > 1 else "#cue=bun&z=-6"
    n = sys.argv[2] if len(sys.argv) > 2 else "cue_test.png"
    if not n.endswith(".png"):
        n += ".png"
    b = int(sys.argv[3]) if len(sys.argv) > 3 else 9000
    print(shot(h, n, b))
