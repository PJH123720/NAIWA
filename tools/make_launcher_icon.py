# -*- coding: utf-8 -*-
"""生成 android/app/src/main/res/mipmap-*/ic_launcher*.png（API < 26 的旧图标）。

API 26+ 走 mipmap-anydpi-v26 里的 adaptive-icon（矢量，不会糊）；
这里给老设备补一套位图。图案和矢量版一致：黄底 + 奶蛙脸。

    py tools/make_launcher_icon.py
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')

CANVAS = 1024
V = 108.0                      # 与 ic_launcher_foreground.xml 的 viewport 一致


def s(v):
    return int(round(v * CANVAS / V))


def ellipse(d, cx, cy, r, fill, outline=None, width=0):
    d.ellipse([s(cx - r), s(cy - r), s(cx + r), s(cy + r)],
              fill=fill, outline=outline, width=width)


def face(d):
    # 眼泡
    for cx in (40, 68):
        ellipse(d, cx, 30, 11, '#8FBF4D')
    # 脸：用 ellipse 近似矢量里的圆润椭圆
    d.ellipse([s(24), s(30), s(84), s(88)], fill='#9BD45F')
    # 眼白 / 瞳孔
    for cx in (40, 68):
        ellipse(d, cx, 32, 7, '#FFFFFF')
    for cx in (41, 67):
        ellipse(d, cx, 33, 3.2, '#3B3327')
    # 腮红
    for cx in (34, 74):
        ellipse(d, cx, 63, 5, '#FF9FBE')
    # 微笑：二次贝塞尔 Q(44,66) (54,76) (64,66)，用折线近似
    pts = []
    for i in range(41):
        t = i / 40.0
        x = (1 - t) ** 2 * 44 + 2 * (1 - t) * t * 54 + t ** 2 * 64
        y = (1 - t) ** 2 * 66 + 2 * (1 - t) * t * 76 + t ** 2 * 66
        pts.append((s(x), s(y)))
    d.line(pts, fill='#4A3728', width=s(3.2), joint='curve')


def build(size, round_icon):
    img = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    # 背景：方形圆角 / 纯圆
    bg = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bg)
    if round_icon:
        bd.ellipse([0, 0, CANVAS, CANVAS], fill='#FFC93C')
    else:
        bd.rounded_rectangle([0, 0, CANVAS, CANVAS], radius=int(CANVAS * 0.22),
                             fill='#FFC93C')
    img.alpha_composite(bg)
    face(ImageDraw.Draw(img))
    # 圆形版把圆外裁掉（系统其实还会再裁一次，这里保证干净）
    if round_icon:
        mask = Image.new('L', (CANVAS, CANVAS), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, CANVAS, CANVAS], fill=255)
        img.putalpha(Image.composite(Image.new('L', (CANVAS, CANVAS), 255),
                                     Image.new('L', (CANVAS, CANVAS), 0), mask))
    return img.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    dirs = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
    for name, px in dirs.items():
        folder = os.path.join(RES, 'mipmap-' + name)
        os.makedirs(folder, exist_ok=True)
        build(px, False).save(os.path.join(folder, 'ic_launcher.png'))
        build(px, True).save(os.path.join(folder, 'ic_launcher_round.png'))
    print('已生成 %d 套 × 2 个 PNG 图标 → %s' % (len(dirs), RES))
