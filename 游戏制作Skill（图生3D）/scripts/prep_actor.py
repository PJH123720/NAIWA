# -*- coding: utf-8 -*-
"""prep_actor.py —— 把一个原始 GLB 处理成游戏可直接加载的资产

做四件事：
  1. 贴图压到 NNNN² JPEG（原始常是 3 张 4096² PNG，二十几 MB，网页里没法用）
  2. 重排 bufferViews 并做 4 字节对齐，写出精简 GLB
  3. 转成 base64 的 .js（file:// 下 fetch 会被 CORS 拦，只能用 <script> 引入）
  4. 报告包围盒 / 面数 / 最长轴，供游戏里算缩放和碰撞盒

用法：
    py prep_actor.py raw/nailong.glb out/nailong 1024
    py prep_actor.py raw/nailong.glb out/nailong --maxside 1024 --json

输出：
    out/nailong.glb       精简 GLB
    out/nailong_glb.js    window.ACTOR_NAILONG = "<base64>"

依赖：numpy、Pillow（缺了先 pip install numpy pillow）

注意：不限面数。体积能降 50 倍靠的是压贴图，不是减面 —— AI 生成的低模本来
就只有一万面左右，减面反而会把脸减崩。
"""
import argparse
import base64
import io
import json
import os
import struct
import sys

import numpy as np
from PIL import Image

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942


def read_glb(path):
    b = open(path, "rb").read()
    magic, ver, total = struct.unpack("<III", b[:12])
    if magic != GLB_MAGIC:
        sys.exit("不是合法的 GLB：%s" % path)
    off, chunks = 12, []
    while off < total:
        cl, ct = struct.unpack("<II", b[off:off + 8])
        off += 8
        chunks.append((ct, b[off:off + cl]))
        off += cl
    j = json.loads(chunks[0][1].decode("utf-8"))
    bin_ = b""
    for ct, data in chunks:
        if ct == CHUNK_BIN:
            bin_ = data
    if not bin_:
        sys.exit("GLB 缺少 BIN 块：%s" % path)
    return j, bin_


def shrink(data, maxside, q=88):
    im = Image.open(io.BytesIO(data)).convert("RGB")
    w, h = im.size
    s = min(1.0, maxside / max(w, h))
    if s < 1.0:
        im = im.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, "JPEG", quality=q, optimize=True)
    return out.getvalue(), (w, h, im.width, im.height)


def write_glb(j, bin_bytes, dst):
    new_bin = bytearray()
    for bv in j["bufferViews"]:
        while len(new_bin) % 4:
            new_bin.append(0)
        o = bv.get("byteOffset", 0)
        data = bin_bytes[o:o + bv["byteLength"]]
        bv["byteOffset"] = len(new_bin)
        bv["byteLength"] = len(data)
        new_bin.extend(data)
    while len(new_bin) % 4:
        new_bin.append(0)
    j["buffers"] = [{"byteLength": len(new_bin)}]
    for im in j.get("images", []):
        im.pop("uri", None)
    js = json.dumps(j, separators=(",", ":")).encode("utf-8")
    while len(js) % 4:
        js += b" "
    total = 12 + 8 + len(js) + 8 + len(new_bin)
    out = bytearray()
    out += struct.pack("<III", GLB_MAGIC, 2, total)
    out += struct.pack("<II", len(js), CHUNK_JSON) + js
    out += struct.pack("<II", len(new_bin), CHUNK_BIN) + bytes(new_bin)
    open(dst, "wb").write(out)
    return len(out)


def stats(j):
    """遍历所有 primitive 统计 bbox / 面数。只看 meshes[0] 会漏掉分件模型。"""
    mn = np.array([1e9, 1e9, 1e9])
    mx = np.array([-1e9, -1e9, -1e9])
    tris = 0
    prims = 0
    for m in j.get("meshes", []):
        for pr in m.get("primitives", []):
            prims += 1
            a = j["accessors"][pr["attributes"]["POSITION"]]
            if "min" in a and "max" in a:
                mn = np.minimum(mn, np.array(a["min"]))
                mx = np.maximum(mx, np.array(a["max"]))
            if "indices" in pr:
                tris += j["accessors"][pr["indices"]]["count"] // 3
            else:
                tris += a["count"] // 3
    size = mx - mn
    axis = "xyz"[int(np.argmax(size))]
    return {
        "min": mn.tolist(), "max": mx.tolist(), "size": size.tolist(),
        "tris": tris, "prims": prims,
        "meshes": len(j.get("meshes", [])), "mats": len(j.get("materials", [])),
        "axis": axis,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="原始 GLB")
    ap.add_argument("out", help="输出前缀，不带扩展名，如 res/models/actors/nailong")
    ap.add_argument("maxside", nargs="?", type=int, default=1024, help="贴图长边上限，默认 1024")
    ap.add_argument("--maxside", dest="maxside2", type=int, default=None)
    ap.add_argument("--quality", type=int, default=88, help="JPEG 质量，默认 88")
    ap.add_argument("--json", action="store_true", help="末尾输出一行机器可读 JSON")
    a = ap.parse_args()
    maxside = a.maxside2 or a.maxside

    j, bin_ = read_glb(a.src)

    # 1) 压贴图：记录每个 image 占用的 bufferView 索引 -> 新字节
    img_bv = {}
    for im in j.get("images", []):
        bv_i = im.get("bufferView")
        if bv_i is None:
            continue                      # 外部 uri 贴图，跳过（正常生成结果不会有）
        bv = j["bufferViews"][bv_i]
        o = bv.get("byteOffset", 0)
        new, wh = shrink(bin_[o:o + bv["byteLength"]], maxside, a.quality)
        img_bv[bv_i] = new
        im["mimeType"] = "image/jpeg"
        im.pop("uri", None)
        if not a.json:
            print("  tex %dx%d %5.0fKB -> %dx%d %5.0fKB" % (
                wh[0], wh[1], bv["byteLength"] / 1024, wh[2], wh[3], len(new) / 1024))

    # 2) 重排 bin
    new_bin = bytearray()
    for idx, bv in enumerate(j["bufferViews"]):
        while len(new_bin) % 4:
            new_bin.append(0)
        if idx in img_bv:
            data = img_bv[idx]
        else:
            o = bv.get("byteOffset", 0)
            data = bin_[o:o + bv["byteLength"]]
        bv["byteOffset"] = len(new_bin)
        bv["byteLength"] = len(data)
        new_bin.extend(data)
    while len(new_bin) % 4:
        new_bin.append(0)

    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or ".", exist_ok=True)
    lite = a.out + ".glb"
    size = write_glb(j, bytes(new_bin), lite)

    # 3) base64 成 js
    b64 = base64.b64encode(open(lite, "rb").read()).decode()
    name = os.path.basename(a.out)
    jid = "ACTOR_" + name.upper().replace("-", "_")
    js = ('/* %s —— AI 图生 3D 生成，prep_actor.py 压缩后内嵌。\n'
          '   原始 %s，压缩后 %s。运行时用 GLBLite.loadB64 解析。 */\n'
          'window.%s = "%s";\n') % (
        name, _fmt(os.path.getsize(a.src)), _fmt(size), jid, b64)
    jsp = a.out + "_glb.js"
    open(jsp, "w", encoding="utf-8").write(js)

    st = stats(j)
    if a.json:
        st.update({"src": a.src, "glb": lite, "js": jsp, "var": jid,
                   "src_bytes": os.path.getsize(a.src), "glb_bytes": size,
                   "js_bytes": len(js)})
        print(json.dumps(st, ensure_ascii=False))
        return

    print("  glb  %.2f MB -> %.2f MB" % (os.path.getsize(a.src) / 1048576, size / 1048576))
    print("  js   %s  %.0f KB   变量名 %s" % (jsp, len(js) / 1024, jid))
    print("  bbox min %s  max %s" % (np.round(st["min"], 3), np.round(st["max"], 3)))
    print("  size x %.3f  y %.3f  z %.3f" % tuple(st["size"]))
    print("  tris %d   prims %d   meshes %d   mats %d"
          % (st["tris"], st["prims"], st["meshes"], st["mats"]))
    print("  AXIS 最长轴 = %s  ← 游戏里以它为身高方向（别假设是 y）" % st["axis"].upper())


def _fmt(n):
    return "%.2f MB" % (n / 1048576) if n > 1048576 else "%.0f KB" % (n / 1024)


if __name__ == "__main__":
    main()
