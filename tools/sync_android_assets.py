# -*- coding: utf-8 -*-
"""把游戏运行时资源同步到 android/app/src/main/assets/www/。

只拷白名单里的文件 —— 项目根目录有 300 MB 的 res/models/raw/*.glb（图生 3D 原始
产物）、ref3d 参考图、.shots 截图和一堆 .c_* 中间图，这些运行时一个都不读，
塞进 APK 只会白胖几十 MB。

同时做三件打包必需的修正：
  1. res/奶娃照片.jpg → res/mascot.jpg（中文路径在部分 WebView 的 file:// 下会 404，
     项目里 laugh.mp3 当年就是为这个改成英文名的）；
  2. 改写 index.html 里那一条 img src；
  3. 校验 index.html 里所有 src/href 相对路径都能在目标目录找到，缺一个就报错。

用法：
    py tools/sync_android_assets.py            # 同步
    py tools/sync_android_assets.py --check     # 只检查是否一致，不写文件
"""
import hashlib
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www')

# 运行时真正会读的文件。新增角色时把 *_glb.js 加到这里 + index.html 的 script 标签。
FILES = [
    'index.html',
    'game.js',
    'lib/three.min.js',
    'lib/glb-lite.js',
    'lib/diag.js',
    'res/bgm.wav',
    'res/laugh.mp3',
    'res/奶娃照片.jpg',
    'res/models/naiwa_ai_glb.js',
    'res/models/mouth_patch.js',
    'res/models/actors/nailong_glb.js',
    'res/models/actors/lulu_glb.js',
    'res/models/actors/zhuzhuxia_glb.js',
    'res/models/actors/doubao_glb.js',
    'res/models/actors/niulai_glb.js',
    'res/models/actors/daodun_glb.js',
    'res/models/actors/cow_glb.js',
]

# 源路径 → 目标路径（相对 DEST）
RENAME = {'res/奶娃照片.jpg': 'res/mascot.jpg'}


def target_of(rel):
    return RENAME.get(rel, rel)


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.digest()


def collect_refs(html_path):
    """抓出 index.html 里所有相对 src/href（跳过 http / data / # / 绝对协议）"""
    text = open(html_path, encoding='utf-8').read()
    refs = []
    for m in re.finditer(r'(?:src|href)\s*=\s*"([^"]+)"', text):
        u = m.group(1)
        if u.startswith(('http:', 'https:', 'data:', '//', '#', 'file:')):
            continue
        refs.append(u.split('#')[0].split('?')[0])
    return refs


def packed_index():
    """打包后的 index.html 内容（只改那一条中文图片路径）"""
    text = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    return text.replace('src="res/奶娃照片.jpg"', 'src="res/mascot.jpg"').encode('utf-8')


def main():
    check = '--check' in sys.argv
    errors, changed = [], []

    for rel in FILES:
        src = os.path.join(ROOT, rel)
        if not os.path.isfile(src):
            errors.append('源文件缺失: %s' % rel)
            continue
        dst = os.path.join(DEST, target_of(rel).replace('/', os.sep))
        if rel == 'index.html':
            if not os.path.isfile(dst) or open(dst, 'rb').read() != packed_index():
                changed.append(rel)
        elif not os.path.isfile(dst) or digest(src) != digest(dst):
            changed.append(rel)

    # 目标目录里不该有白名单之外的残留（比如改过名的旧图）
    if os.path.isdir(DEST):
        allowed = set(target_of(r).replace('/', os.sep) for r in FILES)
        for base, _, names in os.walk(DEST):
            for n in names:
                p = os.path.join(base, n)
                rel = os.path.relpath(p, DEST)
                if rel not in allowed:
                    errors.append('目标目录有残留: %s（用 --prune 清掉）' % rel)

    # index.html 引用完整性：按「打包后」的路径验证
    idx = os.path.join(ROOT, 'index.html')
    for ref in collect_refs(idx):
        # 打包时会把中文图名替换掉
        ref2 = 'res/mascot.jpg' if ref == 'res/奶娃照片.jpg' else ref
        if not os.path.isfile(os.path.join(DEST, ref2.replace('/', os.sep))):
            # --check 之前可能还没同步过，允许落盘后再判；这里只在内容已存在时报错
            if os.path.isdir(DEST) and os.path.isfile(os.path.join(DEST, 'index.html')):
                errors.append('index.html 引用的资源不在包里: %s' % ref2)

    if '--prune' in sys.argv and os.path.isdir(DEST):
        allowed = set(target_of(r).replace('/', os.sep) for r in FILES)
        for base, dirs, names in os.walk(DEST, topdown=False):
            for n in names:
                p = os.path.join(base, n)
                if os.path.relpath(p, DEST) not in allowed:
                    os.remove(p)
            for d in dirs:
                p = os.path.join(base, d)
                if not os.listdir(p):
                    os.rmdir(p)

    if check:
        print('检查完成：%d 个文件需同步，%d 个问题' % (len(changed), len(errors)))
        for e in errors:
            print('  !! ' + e)
        return 1 if errors else 0

    if errors:
        for e in errors:
            print('  !! ' + e)
        print('有错误，未写入。先跑一次 --prune 清残留，或修好上面的路径。')
        return 1

    os.makedirs(DEST, exist_ok=True)
    for rel in FILES:
        src = os.path.join(ROOT, rel)
        dst = os.path.join(DEST, target_of(rel).replace('/', os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if rel == 'index.html':
            # 打包版不需要调试用的 hash 入口，但保留无害，这里不动
            open(dst, 'wb').write(packed_index())
            continue
        shutil.copyfile(src, dst)

    # 落盘后再核一次：index.html 里每一条相对引用都要真的存在于包里
    missing = []
    for ref in collect_refs(os.path.join(ROOT, 'index.html')):
        ref2 = 'res/mascot.jpg' if ref == 'res/奶娃照片.jpg' else ref
        if not os.path.isfile(os.path.join(DEST, ref2.replace('/', os.sep))):
            missing.append(ref2)
    if missing:
        print('  !! 引用了不存在的资源: ' + ', '.join(missing))
        return 1

    total = sum(os.path.getsize(os.path.join(b, n))
                for b, _, ns in os.walk(DEST) for n in ns)
    print('同步完成 → %s' % DEST)
    print('  %d 条 src/href 引用全部命中 ✓' % len(collect_refs(os.path.join(ROOT, 'index.html'))))
    print('  %d 个文件，%.2f MB（APK 里 assets 大致就是这个量级 + 少量 Java/资源）'
          % (len(FILES), total / 1048576.0))
    print('  res/奶娃照片.jpg → res/mascot.jpg（绕开 WebView 中文路径）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
