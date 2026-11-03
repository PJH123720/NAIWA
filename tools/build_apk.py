# -*- coding: utf-8 -*-
"""
不装 Android Studio、不跑 Gradle，直接用 SDK 自带工具链把 android/ 编成 APK。

为什么手工编而不是 `gradlew assembleDebug`：
  Gradle 路线要额外拉 AGP + 依赖缓存（几百 MB，且要访问 Google Maven），
  而这个壳子零第三方依赖、只有一个 Activity 和 10 来个资源文件。
  aapt2 → javac → d8 → zipalign → apksigner 五步就够，全程离线、几秒钟。

为什么先拷到英文目录再编：
  aapt2.exe / zipalign.exe 在 Windows 上按 ANSI 代码页解析参数，项目在
  「桌面\奶蛙快跑」这种中文路径下会报 `failed to open directory: 系统找不到指定的文件`。
  所以先把 res/assets/java 摆到 ~/naiwa-toolchain/build（纯 ASCII），
  编完再把 APK 拷回项目目录。

用法：
    py tools/build_apk.py

产物：android/app/build/outputs/apk/奶蛙快跑-v1.1.apk
"""

import os
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJ = os.path.join(ROOT, 'android')
TOOLCHAIN = os.environ.get('NAIWA_TOOLCHAIN') or os.path.join(
    os.path.expanduser('~'), 'naiwa-toolchain')
JDK = os.path.join(TOOLCHAIN, 'jdk')
SDK = os.path.join(TOOLCHAIN, 'android-sdk')
BUILD_TOOLS = os.path.join(SDK, 'build-tools', '34.0.0')
ANDROID_JAR = os.path.join(SDK, 'platforms', 'android-34', 'android.jar')
KEYSTORE = os.path.join(TOOLCHAIN, 'debug.keystore')

APP_NAME = '奶蛙快跑'
PKG = 'com.naiwa.runner'
VERSION_CODE = '3'
VERSION_NAME = '1.2'
MIN_SDK = '23'
TARGET_SDK = '34'

MAIN = os.path.join(PROJ, 'app', 'src', 'main')
RES = os.path.join(MAIN, 'res')
ASSETS = os.path.join(MAIN, 'assets')
JAVA_SRC = os.path.join(MAIN, 'java')
MANIFEST = os.path.join(MAIN, 'AndroidManifest.xml')

# 纯 ASCII 的构建沙箱
WORK = os.path.join(TOOLCHAIN, 'build')
OUT_DIR = os.path.join(PROJ, 'app', 'build', 'outputs', 'apk')


def exe(name):
    p = os.path.join(BUILD_TOOLS, name + '.exe')
    return p if os.path.isfile(p) else os.path.join(BUILD_TOOLS, name)


def run(cmd):
    shown = [os.path.basename(cmd[0])] + cmd[1:]
    print('  $ ' + ' '.join(shown))
    p = subprocess.run(cmd, capture_output=True)
    out = (p.stdout + p.stderr).decode('utf-8', 'replace').strip()
    if p.returncode != 0:
        print(out[-4000:])
        raise SystemExit('!! 失败 (exit %d): %s' % (p.returncode, os.path.basename(cmd[0])))
    if out:
        print('    ' + '\n    '.join(out.splitlines()[-8:]))
    return out


def check_env():
    missing = []
    for p, what in [(os.path.join(JDK, 'bin', 'javac.exe'), 'JDK'),
                    (ANDROID_JAR, 'android.jar (platforms;android-34)'),
                    (exe('aapt2'), 'build-tools 34.0.0/aapt2'),
                    (exe('zipalign'), 'build-tools 34.0.0/zipalign'),
                    (KEYSTORE, 'debug.keystore')]:
        if not os.path.isfile(p):
            missing.append('%s -> %s' % (what, p))
    if missing:
        print('工具链不全，先跑：py tools/install_toolchain.py')
        for m in missing:
            print('  - ' + m)
        raise SystemExit(1)


def stage():
    """把构建输入拷到 ASCII 目录；顺便同步最新的游戏资源"""
    if os.path.isdir(WORK):
        shutil.rmtree(WORK)
    os.makedirs(WORK)
    for d in ('gen', 'classes', 'dex'):
        os.makedirs(os.path.join(WORK, d))

    print('[0/5] 同步游戏资源 (tools/sync_android_assets.py)')
    run([sys.executable, os.path.join(ROOT, 'tools', 'sync_android_assets.py')])

    shutil.copytree(RES, os.path.join(WORK, 'res'))
    shutil.copytree(ASSETS, os.path.join(WORK, 'assets'))
    shutil.copytree(JAVA_SRC, os.path.join(WORK, 'java'))

    # aapt2 link 要求 manifest 里带 package 属性，而 AGP 8 不允许源码里写，
    # 所以只在构建沙箱里注入一份，源文件保持干净。
    text = open(MANIFEST, encoding='utf-8').read()
    if 'package=' not in text:
        text = text.replace(
            '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
            '<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n'
            '    package="%s">' % PKG, 1)
    open(os.path.join(WORK, 'AndroidManifest.xml'), 'w', encoding='utf-8').write(text)


def build():
    print('[1/5] 编译资源 (aapt2 compile)')
    run([exe('aapt2'), 'compile', '--dir', os.path.join(WORK, 'res'),
         '-o', os.path.join(WORK, 'res.zip')])

    print('[2/5] 链接资源 + 打包 assets (aapt2 link)')
    unsigned = os.path.join(WORK, 'unsigned.apk')
    run([exe('aapt2'), 'link',
         '-o', unsigned,
         '-I', ANDROID_JAR,
         '--manifest', os.path.join(WORK, 'AndroidManifest.xml'),
         '-A', os.path.join(WORK, 'assets'),
         '--java', os.path.join(WORK, 'gen'),
         '--min-sdk-version', MIN_SDK,
         '--target-sdk-version', TARGET_SDK,
         '--version-code', VERSION_CODE,
         '--version-name', VERSION_NAME,
         os.path.join(WORK, 'res.zip')])

    print('[3/5] 编译 Java (javac)')
    sources = []
    for base, _, files in os.walk(os.path.join(WORK, 'java')):
        sources += [os.path.join(base, f) for f in files if f.endswith('.java')]
    sources.append(os.path.join(WORK, 'gen', PKG.replace('.', os.sep), 'R.java'))
    classes = os.path.join(WORK, 'classes')
    # -source/-target 8 + 自定义 bootclasspath：对着 android.jar 编，
    # 而不是对着 JDK 的 java.* 编（否则会误用手机上不存在的 API）
    run([os.path.join(JDK, 'bin', 'javac.exe'),
         '-source', '8', '-target', '8', '-nowarn', '-encoding', 'UTF-8',
         '-bootclasspath', ANDROID_JAR,
         '-d', classes] + sources)

    print('[4/5] 转 dex (d8)')
    cls_dir = os.path.join(classes, PKG.replace('.', os.sep))
    class_files = [os.path.join(cls_dir, f) for f in os.listdir(cls_dir)
                   if f.endswith('.class')]
    dex_dir = os.path.join(WORK, 'dex')
    run([os.path.join(JDK, 'bin', 'java.exe'),
         '-cp', os.path.join(BUILD_TOOLS, 'lib', 'd8.jar'),
         'com.android.tools.r8.D8',
         '--lib', ANDROID_JAR, '--min-api', MIN_SDK, '--output', dex_dir] + class_files)

    # classes.dex 塞进去。用 zipfile 是为了不动其他条目的压缩方式 ——
    # wav/mp3 在 aapt2 产出里是 STORE，重压后部分 WebView 无法 seek，BGM 会卡开头
    with zipfile.ZipFile(unsigned, 'a', zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(dex_dir, 'classes.dex'), 'classes.dex')

    print('[5/5] 对齐 + 签名 (zipalign / apksigner)')
    aligned = os.path.join(WORK, 'aligned.apk')
    run([exe('zipalign'), '-f', '-p', '4', unsigned, aligned])

    signed = os.path.join(WORK, 'signed.apk')
    run([os.path.join(JDK, 'bin', 'java.exe'),
         '-jar', os.path.join(BUILD_TOOLS, 'lib', 'apksigner.jar'), 'sign',
         '--ks', KEYSTORE, '--ks-key-alias', 'androiddebugkey',
         '--ks-pass', 'pass:android', '--key-pass', 'pass:android',
         '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true',
         '--out', signed, aligned])
    return signed


def verify(apk):
    print('\n=== 产物校验 ===')
    badging = run([exe('aapt2'), 'dump', 'badging', apk])
    for line in badging.splitlines():
        if line.startswith(('package:', 'application-label', 'launchable-activity',
                            'sdkVersion', 'targetSdkVersion', 'uses-permission')):
            print('  ' + line)

    with zipfile.ZipFile(apk) as z:
        info = {i.filename: i for i in z.infolist()}
    for f in ('assets/www/index.html', 'assets/www/game.js',
              'assets/www/res/bgm.wav', 'assets/www/res/mascot.jpg',
              'assets/www/res/models/naiwa_ai_glb.js', 'classes.dex'):
        i = info.get(f)
        if not i:
            raise SystemExit('!! APK 里缺少 %s' % f)
        store = 'STORE 未压缩' if i.compress_type == zipfile.ZIP_STORED else 'DEFLATE'
        print('  %-40s %-12s %8.0f KB' % (f, store, i.file_size / 1024.0))

    sig = run([os.path.join(JDK, 'bin', 'java.exe'),
               '-jar', os.path.join(BUILD_TOOLS, 'lib', 'apksigner.jar'),
               'verify', '--verbose', apk])
    for line in sig.splitlines():
        if line.startswith(('Verifies', 'Verified using')):
            print('  ' + line)


def main():
    check_env()
    stage()
    apk = build()
    verify(apk)

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, '%s-v%s.apk' % (APP_NAME, VERSION_NAME))
    shutil.copyfile(apk, out)
    size = os.path.getsize(out) / 1024.0 / 1024.0
    print('\n✓ 出包成功: %s  (%.2f MB)' % (out, size))


if __name__ == '__main__':
    main()
