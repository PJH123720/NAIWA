# -*- coding: utf-8 -*-
"""核对「谁能跳、谁只能躲」，并算出**在几米外起跳能过去**。

为什么不再只报「容错米数」：容错 1.15 米听起来够，但它对应的是
「必须在障碍距离 3.76~4.91 米之间起跳」—— 一个 1 米宽、位置还反直觉的窗口。
玩家看到障碍就跳（通常 6~8 米外），一定跳太早，落地正好撞上。
所以数字上"能过"，玩起来"百分百不过"。现在报**起跳距离区间**和**窗口秒数**：
秒数才是人反应得过来的量，低于 0.25 秒的「可跳」实际上等于「跳不过」。

参数全部从 game.js 现场读取（CFG / HIT / JUMP_CLEAR_EPS / OB_JUMPABLE /
glbActor 调用 / 手写兜底 hit），不在这里另存一份，避免改了代码脚本还是旧值。
注意这里算的是**解析/离散近似**；game.js 里的 #simtest 用真实碰撞代码跑，
两者应该一致（差 0.1 米以内），不一致以 simtest 为准。

Fail 判定除了「能不能跳」，还看窗口秒数是否 ≥ 0.25 秒 —— 低于这个人类反应不过来。

用法：
    py tools/jump_check.py          # 起步速度
    py tools/jump_check.py --all    # 三档速度都算

退出码 1 = 规则不自洽（说能跳的跳不过，或说跳不过的却跳得过）。
"""
import json
import pathlib
import re
import struct
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
GAME = ROOT / 'game.js'
INDEX = ROOT / 'index.html'
RAW = ROOT / 'res/models/raw'

src = GAME.read_text(encoding='utf-8', errors='ignore')
html = INDEX.read_text(encoding='utf-8', errors='ignore') if INDEX.exists() else ''

DT = 1.0 / 60.0
SPEEDS = [(12.5, '起步'), (18.0, '中段'), (23.5, '满速')]


def num(pattern, default=None, text=None):
    m = re.search(pattern, text if text is not None else src)
    return float(m.group(1)) if m else default


V = num(r'JUMP_V:\s*([\d.]+)')
G = num(r'GRAVITY:\s*([\d.]+)')
HALF_Z = num(r'var HIT = \{[^}]*halfZ:\s*([\d.]+)')
EPS = num(r'var JUMP_CLEAR_EPS\s*=\s*([\d.]+)', 0.06)

m = re.search(r'OB_JUMPABLE\s*=\s*\{([^}]*)\}', src)
JUMPABLE = dict((k, v == 'true') for k, v in re.findall(r'(\w+)\s*:\s*(true|false)', m.group(1)))


# ---------- 从 GLB 读世界尺寸（处理 Blender 的 Z-up → Y-up 旋转）----------
def glb_size(path):
    """返回 (宽, 高, 深)。GLB 顶点是 Z-up，节点常带绕 X +90° 的旋转。"""
    try:
        b = path.read_bytes()
    except OSError:
        return None
    _, _, total = struct.unpack('<III', b[:12])
    off, j = 12, None
    while off < total:
        cl, ct = struct.unpack('<II', b[off:off + 8])
        off += 8
        if ct == 0x4E4F534A:                       # 'JSON'
            j = json.loads(b[off:off + cl].decode('utf-8'))
            break
        off += cl
    if not j:
        return None
    mn, mx = [1e9] * 3, [-1e9] * 3
    for mesh in j.get('meshes', []):
        for prim in mesh.get('primitives', []):
            acc = j['accessors'][prim['attributes']['POSITION']]
            for i in range(3):
                mn[i] = min(mn[i], acc['min'][i])
                mx[i] = max(mx[i], acc['max'][i])
    raw = [mx[i] - mn[i] for i in range(3)]
    rotated = any(abs(n.get('rotation', [0, 0, 0, 1])[0] - 0.7071) < 0.01
                  for n in j.get('nodes', []))
    if rotated:                                    # (x,y,z) → (x, z, y)
        return raw[0], raw[2], raw[1]
    return raw[0], raw[1], raw[2]


# ---------- 组装障碍清单 ----------
ACTOR2KEY = {'DOUBAO': 'bun', 'NIULAI': 'niulai', 'DAODUN': 'shield',
             'LULU': 'lulu', 'ZHUZHUXIA': 'pigman', 'COW': 'cow'}
ACTOR2FILE = {'DOUBAO': 'doubao', 'NIULAI': 'niulai', 'DAODUN': 'daodun',
              'LULU': 'lulu', 'ZHUZHUXIA': 'zhuzhuxia', 'COW': 'cow'}

obs = {}          # key -> dict(name, y1, hz, jumpable, src, model)

# 1) AI 网格角色：读 glbActor 的实际入参
for am in re.finditer(r"glbActor\('ACTOR_(\w+)',\s*\{([^}]*)\}", src):
    actor, args = am.group(1), am.group(2)
    key = ACTOR2KEY.get(actor)
    if not key:
        continue                                   # 奶龙是收集物，不参与
    scripted = ('actors/%s_glb.js' % ACTOR2FILE[actor].replace('zhuzhuxia', 'zhuzhuxia')) in html
    if not scripted:
        continue                                   # 模型没接进页面，跑的是手写兜底
    def arg(k):
        # 支持写成 "hz: OB_HZ.shield || 0.42" 这种带运行时覆盖的表达式
        mm = re.search(r'\b%s:\s*(?:[\w.]+\s*\|\|\s*)?([-\d.]+)' % k, args)
        return float(mm.group(1)) if mm else None

    dims = glb_size(RAW / (ACTOR2FILE[actor] + '.glb'))
    if dims is None:
        print('!! 读不到 res/models/raw/%s.glb，%s 的判定高度无法核对' % (ACTOR2FILE[actor], actor))
        continue
    w, h, d = dims
    if arg('w'):                                   # 按宽度定标
        k = arg('w') / w
    else:                                          # 按身高定标
        k = arg('h') / h
    H = h * k
    y1 = arg('hitH') or H * 0.92
    hz = arg('hz') or (d * k * 0.5)
    hx = arg('hx') or (w * k * 0.5)
    obs[key] = dict(name=(re.search(r"name:\s*'([^']+)'", args) or ['', actor])[1],
                    y1=y1, hz=max(hz, 0.18), hx=max(hx, 0.18),
                    model=(w * k, H, d * k), how='AI 网格')
    obs[key]['y1'] = y1

# 2) 手写几何体角色：读 return 里的 hit（y0 != 0 的是横杆，钻过去，不算）
for hm in re.finditer(r"hit: \{ y0: ([\d.]+), y1: ([\d.]+), hx: ([\d.]+), hz: ([\d.]+) \}, name: '([^']+)'", src):
    y0, y1, hx, hz, name = (float(hm.group(1)), float(hm.group(2)),
                            float(hm.group(3)), float(hm.group(4)), hm.group(5))
    if y0 > 0.05:
        continue
    key = {'豆包': 'bun', '牛来': 'niulai', '奶牛': 'cow',
           '刀盾': 'shield', '噜噜': 'lulu', '猪猪侠': 'pigman'}.get(name)
    if key and key not in obs:
        obs[key] = dict(name=name, y1=y1, hz=max(hz, 0.18), hx=max(hx, 0.18),
                        model=None, how='手写几何体')

ORDER = ['bun', 'shield', 'niulai', 'cow', 'lulu', 'pigman']
LABEL = {'bun': '豆包  doubao', 'shield': '刀盾  daodun', 'niulai': '牛来  niulai',
         'cow': '奶牛  cow', 'lulu': '噜噜  lulu', 'pigman': '猪猪侠 pigman'}


# ---------- 物理 ----------
def y_need(y1, jumpable):
    # 可跳障碍给固定 6 厘米容差（第 5 版起废弃「×0.95 百分比折扣」——
    # 那对矮障碍没收益，规则解释起来还绕）；不可跳的必须真高过判定顶。
    return y1 - (EPS if jumpable else 0.0)


def span(yneed):
    """脚底 >= yneed 的时间区间；够不着返回 None"""
    if yneed > V * V / (2 * G):
        return None
    a, b, c = 0.5 * G, -V, yneed
    disc = b * b - 4 * a * c
    r = disc ** 0.5
    return ((-b - r) / (2 * a), (-b + r) / (2 * a))


def analytic(y1, hz, jumpable, v):
    s = span(y_need(y1, jumpable))
    if s is None:
        return None
    edge = hz + HALF_Z                              # 判定区半长
    lo = edge + v * s[0]
    hi = v * s[1] - edge
    return (lo, hi) if hi > lo else None


def sim(y1, hz, jumpable, d0, v):
    """按游戏真实顺序离散步进：障碍前进 → 玩家物理 → 判定（dt = 1/60）"""
    yneed = y_need(y1, jumpable)
    z, y, vy, grounded = -d0, 0.0, V, False
    for _ in range(int(6.0 / DT)):
        z += v * DT
        if not grounded:
            vy -= G * DT
            y += vy * DT
            if y <= 0:
                y, vy, grounded = 0.0, 0.0, True
        if abs(z) <= hz + HALF_Z and y < yneed:
            return False
        if z > hz + HALF_Z:
            return True
    return True


def sim_window(y1, hz, jumpable, v):
    ok = []
    d = 0.20
    while d <= 20.0:          # 满速 23.5 时窗口上沿能到 17 米，别截断
        if sim(y1, hz, jumpable, d, v):
            ok.append(d)
        d += 0.02
    return (min(ok), max(ok)) if ok else None


def peak_real():
    """按游戏的真实积分（先减速度再加位移，欧拉）测跳跃峰值。
    这个值比 V²/(2G) 低约 7 厘米 —— 所有"按 1.80 算"的结论都偏乐观。"""
    y, vy, mx = 0.0, V, 0.0
    while True:
        vy -= G * DT
        y += vy * DT
        if y > mx:
            mx = y
        if y <= 0 and vy < 0:
            return mx


# ---------- 报告 ----------
print('跳跃参数   V=%.2f  G=%.1f   （从 game.js 现场读取）' % (V, G))
print('理想峰值 %.3f 米   实测峰值 %.3f 米（欧拉积分，差 %.3f）   滞空 %.3f 秒' %
      (V * V / (2 * G), peak_real(), V * V / (2 * G) - peak_real(), 2 * V / G))
print('越过容差 %.2f 米   玩家半深 %.2f' % (EPS, HALF_Z))
can = [LABEL[k].split()[0] for k in ORDER if JUMPABLE.get(k)]
print('设计规则   可跳：%s ｜ 其余只能躲' % '、'.join(can))
if len(sys.argv) > 1 and sys.argv[1] == '--all':
    speeds = SPEEDS
else:
    speeds = SPEEDS[:1]

SLACK_MIN = 0.25          # 「可跳」的窗口秒数下限：低于这个人类基本反应不过来

fails = []
for v, tag in speeds:
    print()
    print('—— %s %.1f m/s ——' % (tag, v))
    print('%-16s %6s %6s %6s | %-26s | %-6s %s' %
          ('障碍', '判定顶', '越过线', '判定深', '在几米外起跳能过去', '规则', '核对'))
    print('-' * 104)
    for key in ORDER:
        o = obs.get(key)
        if not o:
            print('%-16s   !! 没抓到参数，检查 game.js' % LABEL[key])
            fails.append(key)
            continue
        jumpable = JUMPABLE.get(key, False)
        need = y_need(o['y1'], jumpable)
        w = sim_window(o['y1'], o['hz'], jumpable, v)
        a = analytic(o['y1'], o['hz'], jumpable, v)
        if jumpable:
            slack = (w[1] - w[0]) / v if w else 0.0
            ok = w is not None and a is not None and slack >= SLACK_MIN
            if not ok:
                fails.append(key)
            verdict, mark = '可跳', 'OK' if ok else ('OK' if w else '!! 说能跳，实际跳不过')
            if w and slack < SLACK_MIN:
                mark = '!! 窗口只有 %.2f 秒，玩家反应不过来' % slack
        else:
            ok = w is None
            if not ok:
                fails.append(key)
            verdict, mark = '只能躲', 'OK' if ok else '!! 规则说只能躲，实际跳得过'
        rng = '够不着（最高点不够）' if w is None else \
              '%.2f ~ %.2f 米（窗口 %.2f 米 = %.2f 秒）' % (w[0], w[1], w[1] - w[0], (w[1] - w[0]) / v)
        print('%-16s %6.2f %6.2f %6.2f | %-26s | %-6s %s' %
              (LABEL[key], o['y1'], need, o['hz'] * 2, rng, verdict, mark))
        if a and w:
            delta = abs(a[0] - w[0]) + abs(a[1] - w[1])
            # 阈值放宽到 1.0：解析抛物线的峰值比欧拉积分高 ~6 厘米，
            # 越过线越接近峰值，落点差得越多，这是建模误差不是物理被改
            if delta > 1.0:
                print('        ! 解析解 %.2f~%.2f 与离散模拟差 %.2f 米，物理被改过？'
                      % (a[0], a[1], delta))

print()
if fails:
    print('✗ %d 个角色和规则不符：%s' % (len(fails), '、'.join(sorted(set(fails)))))
    print('  去对 game.js 的 hitH/hz、CFG 的 JUMP_V/GRAVITY，或 OB_JUMPABLE。')
    sys.exit(1)
print('✓ 规则自洽：豆包、刀盾能跳，其余只能躲。')
print('  判据是"在几米外起跳能过去"—— 这个区间要落在人看得见的范围内，才算真能跳。')
