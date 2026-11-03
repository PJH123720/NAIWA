# -*- coding: utf-8 -*-
"""gen_actor_3d.py —— 批量把参考图跑成游戏可用的 3D 角色

一条命令完成：扫参考图 → 提交图生 3D → 断点续传轮询 → 下载 → 压缩成 base64 js。

用法：
    set T_TOKEN=<clientTempToken>          # Windows，凭证由宿主注入
    py gen_actor_3d.py                     # 用默认目录
    py gen_actor_3d.py --ref ref3d --out res/models/actors
    py gen_actor_3d.py --dry-run           # 只看待办，不提交、不烧额度
    py gen_actor_3d.py --only daodun,niulai
    py gen_actor_3d.py --wait 1800         # 最长等 30 分钟

目录约定（都可用参数覆盖）：
    <ref>   参考图，*.png / *.jpg。文件名以 _ 开头的跳过（放中间产物、草稿用）
    <raw>   原始 GLB 落点，同时存放 _jobs.json（断点续传）与预览图
    <out>   压缩后的产物：<名>.glb + <名>_glb.js

关于额度（务必先读）：
    hy-3d 维度限制的是**每天能提交几次任务**（5 次），不是余额。
    账户积分再多，第 6 次也提不上去，服务端返回 HTTP 429 +
    "daily submit limit exceeded (5/5) for dimension hy-3d"。按自然日 0 点重置。
    因此：
      - 提交顺序有讲究，先跑「图最差、必须补图」的，把一次成型的放后面
      - 提交成功立刻把 JobId 写进 _jobs.json，之后只查不重提
      - 超限立刻停，不要重试循环（重试也是 429，只是把日志刷满）

关于耗时：单个模型 5~15 分钟。多数技能脚本默认轮询 600s 会超时退出，
    但 JobId 已经写盘，重跑本脚本即可接着收，不会重复扣额度。

依赖：需要本机装有 WorkBuddy 内置的 buddy-multimodal-generation 脚本。
    找不到就用环境变量 MMGEN_SCRIPT 指定其绝对路径。
"""
import argparse
import base64
import importlib.util
import json
import os
import pathlib
import sys
import time
import urllib.request

DEFAULT_SKILL = (r"D:/Users/Pjh18/AppData/Local/Programs/WorkBuddy/resources/"
                 r"app.asar.unpacked/resources/plugins/workbuddy-builtin/skills/"
                 r"buddy-multimodal-generation/scripts/buddy-multimodal-generation.py")

IMG_EXT = {".png", ".jpg", ".jpeg", ".webp"}


def find_skill(override):
    cands = [override, os.environ.get("MMGEN_SCRIPT"), DEFAULT_SKILL]
    # 再去常见安装位置兜一下，换机器不用改脚本
    for base in (r"C:/Program Files/WorkBuddy", r"D:/Program Files/WorkBuddy",
                 r"C:/Users/%s/AppData/Local/Programs/WorkBuddy" % os.environ.get("USERNAME", "")):
        cands.append(base + "/resources/app.asar.unpacked/resources/plugins/"
                            "workbuddy-builtin/skills/buddy-multimodal-generation/"
                            "scripts/buddy-multimodal-generation.py")
    for c in cands:
        if c and pathlib.Path(c).exists():
            return pathlib.Path(c)
    sys.exit("找不到 buddy-multimodal-generation.py，请用 --mmgen 或环境变量 MMGEN_SCRIPT 指定")


def load_jobs(p):
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_jobs(p, d):
    p.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")


def fmt_mb(n):
    return "%.2f MB" % (n / 1048576) if n > 1048576 else "%.0f KB" % (n / 1024)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="ref3d")
    ap.add_argument("--raw", default="res/models/raw")
    ap.add_argument("--out", default="res/models/actors")
    ap.add_argument("--maxside", type=int, default=1024)
    ap.add_argument("--wait", type=int, default=1500, help="轮询总时长上限（秒）")
    ap.add_argument("--only", default="", help="只跑这些名字，逗号分隔")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--mmgen", default=None)
    ap.add_argument("--token", default=None)
    a = ap.parse_args()

    ref, raw, out = pathlib.Path(a.ref), pathlib.Path(a.raw), pathlib.Path(a.out)
    raw.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    jobs_file = raw / "_jobs.json"

    only = {s.strip() for s in a.only.split(",") if s.strip()}
    todo = []
    for p in sorted(ref.iterdir()):
        if not p.is_file() or p.suffix.lower() not in IMG_EXT:
            continue
        if p.name.startswith("_"):
            continue
        if only and p.stem not in only:
            continue
        if (raw / (p.stem + ".glb")).exists():
            continue
        todo.append(p)

    jobs = load_jobs(jobs_file)
    print("参考图目录：%s" % ref.resolve())
    print("待生成：  %s" % ([p.stem for p in todo] or "无"))
    print("在飞任务：%s" % (list(jobs.keys()) or "无"))
    if a.dry_run:
        for p in todo:
            print("  [dry] 会提交 %s (%s)" % (p.name, fmt_mb(p.stat().st_size)))
        for k, v in jobs.items():
            print("  [dry] 会继续轮询 %s  job=%s" % (k, v))
        return

    token = a.token or os.environ.get("T_TOKEN")
    if not token:
        sys.exit("缺少凭证：用 --token 传入，或设环境变量 T_TOKEN（由宿主注入，不要写进文件）")

    spec = importlib.util.spec_from_file_location("mmgen", str(find_skill(a.mmgen)))
    mm = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mm)
    CFG = mm._PROVIDER_MAP["3d"]
    EP = mm._DEFAULT_ENDPOINT

    def call(action, body):
        return mm._call_api(EP, CFG["provider"], CFG["service"],
                            CFG["version"], action, body, token)

    MAX_CONCURRENT = 2        # hy-3d 的并发槽位上限，推第 3 个必被 429 拒
    quota_msg = None

    def poll_round():
        """查一遍在飞任务。返回 True 表示本轮有进展（完成/失败/下载）。"""
        moved = False
        for name, job in list(jobs.items()):
            try:
                r = call(CFG["query_action"], {"JobId": job})
            except Exception as e:
                print("  %-12s 查询异常 %s" % (name, str(e)[:120]))
                continue
            st = r.get("Status") or r.get("JobStatusCode")
            print("  %-12s %s" % (name, st))
            if st in ("DONE", 4):
                got = False
                for f in (r.get("ResultFile3Ds") or []):
                    if f.get("Type") != "GLB":
                        continue
                    dst = raw / (name + ".glb")
                    urllib.request.urlretrieve(f["Url"], dst)
                    print("    下载 %s %s" % (dst, fmt_mb(dst.stat().st_size)))
                    pi = f.get("PreviewImageUrl")
                    if pi:
                        try:
                            urllib.request.urlretrieve(pi, raw / (name + "_preview.png"))
                        except Exception:
                            pass
                    got = True
                    break
                if not got:
                    print("    结果里没有 GLB：%s" % json.dumps(r, ensure_ascii=False)[:200])
                jobs.pop(name, None)
                save_jobs(jobs_file, jobs)
                moved = True
            elif st in ("FAIL", "FAILED", 5):
                print("    生成失败：%s" % json.dumps(r, ensure_ascii=False)[:200])
                jobs.pop(name, None)
                save_jobs(jobs_file, jobs)
                moved = True
        return moved

    # ---------- 1) 提交（受并发槽位约束）----------
    submit_deadline = time.time() + a.wait
    for p in todo:
        if p.stem in jobs:
            continue
        # 槽位满先等，别硬推：硬推只会拿到 429，
        # 而且很容易被误判成「今日 5 次已满」而中止整批
        while len(jobs) >= MAX_CONCURRENT and not quota_msg:
            if time.time() > submit_deadline:
                quota_msg = "等并发槽位超时。已提交的会继续查，重跑本脚本可接着提交剩下的"
                break
            if not poll_round():
                time.sleep(15)
        if quota_msg:
            break
        b64 = base64.b64encode(p.read_bytes()).decode()
        body = mm._build_3d_body(prompt="", model="3.0", image_base64=b64,
                                 enable_pbr=True, generate_type="LowPoly")
        try:
            r = call(CFG["submit_action"], body)
        except SystemExit:
            # _call_api 遇 HTTP_ERROR 会先打印原始 JSON 再 sys.exit
            quota_msg = ("提交被拒，看上面的原始 JSON：\n"
                         "  daily limit      → 今天的 5 次已满，改天再跑（与积分无关）\n"
                         "  concurrent slot  → 并发槽位满，等半分钟重跑即可，"
                         "别当成额度用完\n"
                         "  AUTH_            → 凭证过期，重新取一次后查原 JobId，不要重提")
            break
        job = r.get("JobId")
        if job:
            jobs[p.stem] = job
            save_jobs(jobs_file, jobs)
            print("  已提交 %-12s %s" % (p.stem, job))
            continue
        quota_msg = "提交失败：%s" % json.dumps(r, ensure_ascii=False)[:200]
        break

    # ---------- 2) 轮询（只查不重提）----------
    deadline = time.time() + a.wait
    while jobs and time.time() < deadline:
        if not poll_round():
            time.sleep(20)

    if jobs:
        print("\n还有任务没收到（超时）。JobId 已存在 %s，重跑本脚本即可接着收："
              % jobs_file)
        for k, v in jobs.items():
            print("  %-12s %s" % (k, v))

    # ---------- 3) 压缩 ----------
    prep = pathlib.Path(__file__).with_name("prep_actor.py")
    done = []
    for g in sorted(raw.glob("*.glb")):
        js = out / (g.stem + "_glb.js")
        if js.exists():
            continue
        print("\n压缩 %s" % g.stem)
        rc = os.system('py "%s" "%s" "%s" %d' % (prep, g, out / g.stem, a.maxside))
        if rc == 0:
            done.append(g.stem)

    print("\n完成。产出：")
    for n in done:
        print("  %s  →  %s" % (n, out / (n + "_glb.js")))
    print("\n接进游戏：在 HTML 里为每个角色加一行")
    for n in done:
        print('  <script src="%s"></script>' % ((out / (n + "_glb.js")).as_posix()))
    if quota_msg:
        print("\n[额度/凭证] " + quota_msg)


if __name__ == "__main__":
    main()
