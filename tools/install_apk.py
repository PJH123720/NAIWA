# -*- coding: utf-8 -*-
"""
手机插上 USB、开好「USB 调试」，跑这一句就能把包装进手机并自动打开。

    py tools/install_apk.py

不需要 Android Studio。前提：
  1. 手机「设置 → 关于手机」连点版本号 7 次打开开发者选项
  2. 开发者选项里打开「USB 调试」
  3. 数据线连电脑，手机上点「允许」授权这台电脑

没有设备时会给出排查提示，不会卡住。
"""

import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLCHAIN = os.environ.get('NAIWA_TOOLCHAIN') or os.path.join(
    os.path.expanduser('~'), 'naiwa-toolchain')
ADB = os.path.join(TOOLCHAIN, 'android-sdk', 'platform-tools', 'adb.exe')
APK_DIR = os.path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk')
PKG = 'com.naiwa.runner'


def adb(*args, **kw):
    p = subprocess.run([ADB] + list(args), capture_output=True,
                       timeout=kw.get('timeout', 120))
    return p.returncode, (p.stdout + p.stderr).decode('utf-8', 'replace').strip()


def find_apk():
    if not os.path.isdir(APK_DIR):
        return None
    apks = [os.path.join(APK_DIR, f) for f in os.listdir(APK_DIR) if f.endswith('.apk')]
    return max(apks, key=os.path.getmtime) if apks else None


def main():
    if not os.path.isfile(ADB):
        print('找不到 adb：%s' % ADB)
        print('先跑 py tools/install_toolchain.py 装工具链。')
        return 1

    apk = find_apk()
    if not apk:
        print('还没出包，先跑 py tools/build_apk.py')
        return 1
    print('安装包: %s  (%.2f MB)' % (os.path.basename(apk),
                                   os.path.getsize(apk) / 1024.0 / 1024.0))

    print('\n等待手机连接（最多 60 秒）…')
    serial = None
    states = ('device', 'offline', 'unauthorized', 'recovery', 'sideload', 'bootloader')
    for _ in range(20):
        rc, out = adb('devices')
        ready, pending = [], []
        # 只认「List of devices attached」之后、第二列是已知状态的行。
        # adb 启动守护进程的 `* daemon not running...` 走的是 stderr，
        # 合并输出后会被误当成设备（第二列恰好是 daemon），必须滤掉。
        body = out.split('List of devices attached')[-1] if 'List of devices attached' in out else out
        for line in body.splitlines():
            cols = line.split()
            if len(cols) < 2 or cols[0].startswith('*') or cols[1] not in states:
                continue
            (ready if cols[1] == 'device' else pending).append(cols)
        if ready:
            serial = ready[0][0]
            break
        for cols in pending:
            print('  检测到设备 %s，状态「%s」—— %s'
                  % (cols[0], cols[1],
                     '请在手机上点「允许 USB 调试」' if cols[1] == 'unauthorized'
                     else '设备还没就绪，稍等'))
        time.sleep(3)

    if not serial:
        print('\n没检测到已授权的设备。检查这几点：')
        print('  · 数据线是不是只能充电（换一根能传数据的）')
        print('  · 手机通知栏的 USB 模式选「传输文件 / MTP」，不是「仅充电」')
        print('  · 开发者选项里「USB 调试」开关是不是开着')
        print('  · 手机上有没有弹出「允许 USB 调试吗」的对话框（勾选「一直允许」）')
        print('\n或者不用数据线：把下面这个 apk 发到手机（微信/QQ/网盘），')
        print('在手机上点开、允许「安装未知来源应用」即可。')
        print('  ' + apk)
        return 1

    print('\n设备: %s' % serial)
    model = adb('-s', serial, 'shell', 'getprop', 'ro.product.model')[1]
    ver = adb('-s', serial, 'shell', 'getprop', 'ro.build.version.release')[1]
    print('机型: %s  Android %s' % (model, ver))

    print('\n安装中…')
    rc, out = adb('-s', serial, 'install', '-r', '-d', apk, timeout=300)
    print(out)
    if rc != 0 or 'Success' not in out:
        if 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' in out:
            print('\n手机上已有一个签名不同的同包名版本，先卸载再装：')
            print('  adb uninstall %s' % PKG)
        return 1

    print('启动…')
    adb('-s', serial, 'shell', 'am', 'start', '-n', '%s/.MainActivity' % PKG)
    print('\n✓ 装好了，手机上应该已经打开「奶蛙快跑」。')
    print('  操作：左右滑换道 · 上滑跳 · 下滑蹲')
    return 0


if __name__ == '__main__':
    sys.exit(main())
