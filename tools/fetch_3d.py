# -*- coding: utf-8 -*-
"""fetch_3d.py —— 把 res/ref3d/ 里还没有模型的角色，批量跑图生 3D 并压缩好

用法：
    set T_TOKEN=<短期凭证>       # Windows
    py tools/fetch_3d.py                 # 提交 + 等结果 + 压缩 + 接线
    py tools/fetch_3d.py --wait 1500     # 最多等 25 分钟
    py tools/fetch_3d.py --nowire        # 只出模型，不自动改 index.html

会做：
  1. 扫描 res/ref3d/*.png（跳过 _ 开头与 _src/），跳过已有 raw/<同名>.glb 的
  2. 提交图生 3D；**jobid 立刻写进 res/models/raw/_jobs.json**
  3. 轮询到完成，下载 GLB 到 res/models/raw/
  4. 自动调 prep_actor.py 压到 res/models/actors/
  5. 在 index.html 里补 <script src="res/models/actors/<名>_glb.js">

注意：hy-3d 维度有**每日提交次数**上限（5 次/天），这是硬次数限制，
和账户积分/余额是两套账 —— 积分再多，第 6 次也提不上去。
超限返回 HTTP 429 + "daily submit limit exceeded (5/5) for dimension hy-3d"，
按自然日 0 点重置。脚本会把原文打出来。

为什么要有 _jobs.json：
  提交一次就占掉一次当天额度，而生成要 5~15 分钟。如果脚本中途被杀
  （会话结束、超时、断网），没有 jobid 就只能重新提交 —— 白烧一次额度。
  有 _jobs.json 就能「已提交的只查不重提」，下次运行直接接着收结果。
"""
import base64
import importlib.util
import json
import os
import pathlib
import re
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKILL = pathlib.Path(os.environ.get(
    "MMGEN_SCRIPT",
    r"D:/Users/Pjh18/AppData/Local/Programs/WorkBuddy/resources/app.asar.unpacked/"
    r"resources/plugins/workbuddy-builtin/skills/buddy-multimodal-generation/scripts/"
    r"buddy-multimodal-generation.py"))

if not SKILL.exists():
    sys.exit("找不到 buddy-multimodal-generation.py，请用环境变量 MMGEN_SCRIPT 指定")
if "T_TOKEN" not in os.environ:
    sys.exit("缺少环境变量 T_TOKEN")

spec = importlib.util.spec_from_file_location("mmgen", str(SKILL))
mm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mm)

CFG = mm._PROVIDER_MAP["3d"]
EP = mm._DEFAULT_ENDPOINT
TOKEN = os.environ["T_TOKEN"]

RAW = ROOT / "res/models/raw"
REF = ROOT / "res/ref3d"
ACT = ROOT / "res/models/actors"
JOBS_FILE = RAW / "_jobs.json"
RAW.mkdir(parents=True, exist_ok=True)

WAIT = 1500
WIRE = "--nowire" not in sys.argv
if "--wait" in sys.argv:
    WAIT = int(sys.argv[sys.argv.index("--wait") + 1])


def call(action, body):
    return mm._call_api(EP, CFG["provider"], CFG["service"], CFG["version"], action, body, TOKEN)


def load_jobs():
    if JOBS_FILE.exists():
        try:
            return json.loads(JOBS_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_jobs(d):
    JOBS_FILE.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")


def todo():
    out = []
    for p in sorted(REF.glob("*.png")):
        if p.name.startswith("_"):           # _src/ 里的中间图、草稿不算参考图
            continue
        if (RAW / (p.stem + ".glb")).exists():   # 已经有结果的跳过
            continue
        out.append(p)
    return out


def submit(path):
    b64 = base64.b64encode(path.read_bytes()).decode()
    body = mm._build_3d_body(prompt="", model="3.0", image_base64=b64,
                             enable_pbr=True, generate_type="LowPoly")
    r = call(CFG["submit_action"], body)
    return r.get("JobId"), r


def download(name, job):
    r = call(CFG["query_action"], {"JobId": job})
    for f in (r.get("ResultFile3Ds") or []):
        if f.get("Type") != "GLB":
            continue
        out = RAW / (name + ".glb")
        urllib.request.urlretrieve(f["Url"], out)
        print("  下载", out, out.stat().st_size // 1024, "KB")
        pi = f.get("PreviewImageUrl")
        if pi:
            try:
                urllib.request.urlretrieve(pi, RAW / (name + "_preview.png"))
            except Exception:
                pass
        return True
    return False


def compress(name):
    src = RAW / (name + ".glb")
    if not src.exists():
        return
    dst = ACT / name
    if (dst.parent / (name + "_glb.js")).exists():
        return
    os.system('py "%s" "%s" "%s" 1024' % (ROOT / "tools/prep_actor.py", src, dst))


def wire(name):
    """在 index.html 的最后一个 actors 脚本之后插入一行，幂等。"""
    idx = ROOT / "index.html"
    html = idx.read_text(encoding="utf-8")
    tag = 'res/models/actors/%s_glb.js' % name
    if tag in html:
        return False
    lines = html.split("\n")
    last = -1
    for i, ln in enumerate(lines):
        if "res/models/actors/" in ln and "<script" in ln:
            last = i
    if last < 0:
        print("  !! index.html 里找不到 actors 脚本区，手动加：" + tag)
        return False
    indent = re.match(r"\s*", lines[last]).group(0)
    lines.insert(last + 1, indent + '<script src="%s"></script>' % tag)
    idx.write_text("\n".join(lines), encoding="utf-8")
    print("  + index.html 已接线", name)
    return True


jobs = load_jobs()
print("待生成：", [p.stem for p in todo()] or "无")
print("在飞任务：", jobs or "无")

# ---------- 1) 提交 ----------
quota_hit = None
for p in todo():
    if p.stem in jobs:
        continue
    try:
        job, r = submit(p)
    except SystemExit:
        # _call_api 遇 HTTP_ERROR 会先打印原始 JSON 再 sys.exit，这里只能给个归类提示
        quota_hit = ("提交被拒，原因见上面的原始 JSON："
                     "带 429 / daily limit → 今天的 hy-3d 次数已满（与账户积分无关）；"
                     "带 AUTH_ → 凭证过期，重新取一次再跑")
        break
    if job:
        jobs[p.stem] = job
        save_jobs(jobs)
        print("  已提交", p.stem, job)
        continue
    msg = json.dumps(r, ensure_ascii=False)
    print("  提交失败", p.stem, msg[:200])
    if "daily" in msg.lower() or "429" in msg:
        quota_hit = "今天的 hy-3d 提交次数已用满（5/5），与账户积分无关"
    break

# ---------- 2) 轮询 ----------
deadline = time.time() + WAIT
while jobs and time.time() < deadline:
    progressed = False
    for name, job in list(jobs.items()):
        try:
            r = call(CFG["query_action"], {"JobId": job})
        except Exception as e:
            print(" ", name, "查询异常", str(e)[:120])
            break
        st = r.get("Status") or r.get("JobStatusCode")
        print(" ", name, st)
        if st in ("DONE", 4):
            if download(name, job):
                pass
            else:
                print("  结果里没有 GLB", json.dumps(r, ensure_ascii=False)[:200])
            jobs.pop(name, None)
            save_jobs(jobs)
            progressed = True
        elif st in ("FAIL", "FAILED", 5):
            print("  生成失败", json.dumps(r, ensure_ascii=False)[:200])
            jobs.pop(name, None)
            save_jobs(jobs)
            progressed = True
    if not progressed:
        time.sleep(20)

if jobs:
    print("还有任务没收到（超时），jobid 已存在 %s，下次运行会接着收：" % JOBS_FILE.name)
    for k, v in jobs.items():
        print("  ", k, v)

# ---------- 3) 压缩 + 接线 ----------
print("压缩中……")
for p in sorted(RAW.glob("*.glb")):
    compress(p.stem)
if WIRE:
    for p in sorted(REF.glob("*.png")):
        if not p.name.startswith("_") and (RAW / (p.stem + ".glb")).exists():
            wire(p.stem)

if quota_hit:
    print("\n[额度] " + quota_hit)
print("完成。")
