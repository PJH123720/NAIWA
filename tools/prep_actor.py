# -*- coding: utf-8 -*-
"""
prep_actor.py —— 把一个 GLB 处理成游戏可直接用的资源

做三件事：
  1. 贴图压到 NNNN² JPEG（原始常是 3 张 4096² PNG，几十 MB，网页里没法用）
  2. 重排 bufferViews 写出精简 GLB
  3. 转成 base64 的 .js（file:// 下 fetch 会被 CORS 拦，只能用 <script> 引入）
  4. 报告包围盒 / 面数 / 主轴方向，供游戏里算缩放和碰撞盒

用法：
    py tools/prep_actor.py res/models/raw/nailong.glb res/models/actors/nailong 1024
"""
import struct, json, io, sys, os, base64
import numpy as np
from PIL import Image


def read_glb(path):
    b = open(path, "rb").read()
    _, _, total = struct.unpack("<III", b[:12])
    off, chunks = 12, []
    while off < total:
        cl, ct = struct.unpack("<II", b[off:off + 8])
        off += 8
        chunks.append([ct, b[off:off + cl]])
        off += cl
    j = json.loads(chunks[0][1].decode("utf-8"))
    bin_ = b""
    for ct, data in chunks:
        if ct == 0x004E4942:
            bin_ = data
    return j, bin_


def shrink(data, maxside, q=88):
    im = Image.open(io.BytesIO(data)).convert("RGB")
    w, h = im.size
    s = min(1.0, maxside / max(w, h))
    if s < 1.0:
        im = im.resize((int(w * s), int(h * s)), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, "JPEG", quality=q, optimize=True)
    print("  tex %dx%d %.0fKB -> %dx%d %.0fKB" % (
        w, h, len(data) / 1024, im.width, im.height, out.tell() / 1024))
    return out.getvalue()


def write_glb(j, bin_bytes, dst):
    new_bin = bytearray()
    for idx, bv in enumerate(j["bufferViews"]):
        while len(new_bin) % 4:
            new_bin.append(0)
        data = bin_bytes[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
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
    out += struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(js), 0x4E4F534A) + js
    out += struct.pack("<II", len(new_bin), 0x004E4942) + bytes(new_bin)
    open(dst, "wb").write(out)
    return len(out)


def main():
    src, stem, maxside = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 1024
    j, bin_ = read_glb(src)

    # 1) 压贴图：按 bufferView 索引替换
    img_bv = {}
    for im in j.get("images", []):
        bv = im["bufferView"]
        o = j["bufferViews"][bv].get("byteOffset", 0)
        img_bv[bv] = shrink(bin_[o:o + j["bufferViews"][bv]["byteLength"]], maxside)
        im["mimeType"] = "image/jpeg"

    new_bin = bytearray()
    for idx, bv in enumerate(j["bufferViews"]):
        while len(new_bin) % 4:
            new_bin.append(0)
        if idx in img_bv:
            data = img_bv[idx]
        else:
            data = bin_[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
        bv["byteOffset"] = len(new_bin)
        bv["byteLength"] = len(data)
        new_bin.extend(data)
    while len(new_bin) % 4:
        new_bin.append(0)

    os.makedirs(os.path.dirname(stem), exist_ok=True)
    lite = stem + ".glb"
    size = write_glb(j, bytes(new_bin), lite)
    print("  glb %.2f MB -> %.2f MB" % (os.path.getsize(src) / 1048576, size / 1048576))

    # 2) base64 成 js
    b64 = base64.b64encode(open(lite, "rb").read()).decode()
    name = os.path.basename(stem)
    jid = "ACTOR_" + name.upper()
    js = ('/* %s —— 由 AI 图生 3D 生成，tools/prep_actor.py 压缩后内嵌\n'
          '   面数/尺寸见 res/models/actors/README 或 prep 输出 */\n'
          'window.%s = "%s";\n') % (name, jid, b64)
    jsp = stem + "_glb.js"
    open(jsp, "w", encoding="utf-8").write(js)
    print("  js  %s  %.0f KB" % (jsp, len(js) / 1024))

    # 3) 统计：bbox / 面数。注意不同模型的"上"轴未必一样，这里如实打印
    pr = j["meshes"][0]["primitives"][0]
    a = j["accessors"][pr["attributes"]["POSITION"]]
    mn, mx = np.array(a["min"]), np.array(a["max"])
    tris = j["accessors"][pr["indices"]]["count"] // 3 if "indices" in pr else 0
    print("  bbox  min %s  max %s" % (np.round(mn, 3), np.round(mx, 3)))
    print("  size  x %.3f  y %.3f  z %.3f" % tuple(mx - mn))
    print("  tris  %d   meshes %d  mats %d" % (tris, len(j.get("meshes", [])), len(j.get("materials", []))))
    print("  AXIS  最长轴 = %s （游戏里以它为身高方向）" % "xyz"[int(np.argmax(mx - mn))])


if __name__ == "__main__":
    main()
