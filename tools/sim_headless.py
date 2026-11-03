# -*- coding: utf-8 -*-
"""
把 #simtest 的回归结果抓出来文本内容。

用法:
  py tools/sim_headless.py                 # 跑默认 #simtest
  py tools/sim_headless.py "#bot"          # 跑别的 hash
不需要 Pillow / 截图 —— 只用 --dump-dom 读结果面板的文本。
"""
import os, re, subprocess, sys, tempfile, html, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
URL = "file:///" + os.path.join(ROOT, "index.html").replace("\\", "/")


def run(hash_="#simtest", budget=12000):
    prof = tempfile.mkdtemp(prefix="nwprof_")
    args = [
        CHROME, "--headless=old", "--disable-gpu", "--no-sandbox",
        "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        "--user-data-dir=" + prof,
        "--allow-file-access-from-files",
        "--virtual-time-budget=%d" % budget,
        "--window-size=1280,720",
        "--dump-dom", URL + hash_,
    ]
    p = subprocess.run(args, capture_output=True, timeout=180)
    return p.stdout.decode("utf-8", "replace")


PRE_ID = "simout"


def extract(dom):
    # #simtest 的结果写在一个 <pre id="simOut"> 里
    m = re.search(r'<pre[^>]*id="%s"[^>]*>(.*?)</pre>' % PRE_ID, dom, re.S)
    if not m:
        return None
    txt = re.sub(r"<[^>]+>", "", m.group(1))
    return html.unescape(txt)


if __name__ == "__main__":
    h = sys.argv[1] if len(sys.argv) > 1 else "#simtest"
    b = int(sys.argv[2]) if len(sys.argv) > 2 else 12000
    dom = run(h, b)
    out = extract(dom)
    if out is None:
        print("!! 没找到 id=%s 的结果面板，DOM 长度 %d" % (PRE_ID, len(dom)))
        open(os.path.join(ROOT, ".shots", "_sim_dom.html"), "w", encoding="utf-8").write(dom)
        print("!! DOM 已存到 .shots/_sim_dom.html")
        sys.exit(1)
    print(out)
