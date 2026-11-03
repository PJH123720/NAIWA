# -*- coding: utf-8 -*-
"""
一键装齐「命令行出安卓包」的工具链，不需要 Android Studio。

装到 %USERPROFILE%\\naiwa-toolchain（约 600 MB，全部是免安装的 zip）：
  jdk/                     OpenJDK 17（javac / keytool / java）
  android-sdk/             cmdline-tools + platform-tools(adb) + platforms;android-34
                           + build-tools;34.0.0（aapt2 / d8 / zipalign / apksigner）
  debug.keystore           调试签名（口令都是 android）

已经装过的部分会跳过，重复跑是安全的。
    py tools/install_toolchain.py
"""

import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

TOOLCHAIN = os.environ.get('NAIWA_TOOLCHAIN') or os.path.join(
    os.path.expanduser('~'), 'naiwa-toolchain')
JDK = os.path.join(TOOLCHAIN, 'jdk')
SDK = os.path.join(TOOLCHAIN, 'android-sdk')
DL = os.path.join(TOOLCHAIN, 'dl')
KEYSTORE = os.path.join(TOOLCHAIN, 'debug.keystore')

JDK_URL = 'https://mirrors.huaweicloud.com/openjdk/17/openjdk-17_windows-x64_bin.zip'
SDKTOOLS_URL = ('https://dl.google.com/android/repository/'
                'commandlinetools-win-11076708_latest.zip')
PACKAGES = ['platform-tools', 'platforms;android-34', 'build-tools;34.0.0']


def download(url, dst):
    if os.path.isfile(dst) and os.path.getsize(dst) > 1024 * 1024:
        print('  已存在，跳过下载: %s' % os.path.basename(dst))
        return
    print('  下载 %s' % url)
    tmp = dst + '.part'
    with urllib.request.urlopen(url, timeout=60) as r, open(tmp, 'wb') as f:
        total = int(r.headers.get('Content-Length') or 0)
        done = 0
        while True:
            chunk = r.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total:
                pct = done * 100 // total
                print('\r    %d%%  %.1f/%.1f MB' % (pct, done / 1048576.0,
                                                    total / 1048576.0), end='')
    print('\r    完成 %.1f MB' % (os.path.getsize(tmp) / 1048576.0))
    os.replace(tmp, dst)


def java_exe(name):
    return os.path.join(JDK, 'bin', name + '.exe')


def main():
    os.makedirs(DL, exist_ok=True)

    print('[1/3] JDK 17')
    if os.path.isfile(java_exe('javac')):
        print('  已安装，跳过')
    else:
        zp = os.path.join(DL, 'jdk17.zip')
        download(JDK_URL, zp)
        print('  解压…')
        with zipfile.ZipFile(zp) as z:
            z.extractall(TOOLCHAIN)
        # zip 里是 jdk-17/，统一改成 jdk/
        for n in os.listdir(TOOLCHAIN):
            if n.startswith('jdk-') and os.path.isdir(os.path.join(TOOLCHAIN, n)):
                if os.path.isdir(JDK):
                    shutil.rmtree(JDK)
                os.replace(os.path.join(TOOLCHAIN, n), JDK)

    print('[2/3] Android SDK 命令行工具')
    sdkmanager = os.path.join(SDK, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat')
    if not os.path.isfile(sdkmanager):
        zp = os.path.join(DL, 'cmdline-tools.zip')
        download(SDKTOOLS_URL, zp)
        tmp = os.path.join(TOOLCHAIN, 'ct')
        shutil.rmtree(tmp, ignore_errors=True)
        with zipfile.ZipFile(zp) as z:
            z.extractall(tmp)
        target = os.path.join(SDK, 'cmdline-tools')
        os.makedirs(target, exist_ok=True)
        shutil.rmtree(os.path.join(target, 'latest'), ignore_errors=True)
        shutil.move(os.path.join(tmp, 'cmdline-tools'), os.path.join(target, 'latest'))
        shutil.rmtree(tmp, ignore_errors=True)

    print('[3/3] 平台 + 构建工具（约 300 MB，慢一点）')
    env = dict(os.environ, JAVA_HOME=JDK)
    env['PATH'] = os.path.join(JDK, 'bin') + os.pathsep + env.get('PATH', '')

    subprocess.run(['cmd', '/c', sdkmanager, '--sdk_root=' + SDK, '--licenses'],
                   env=env, input=b'y\n' * 40, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)
    for pkg in PACKAGES:
        print('  安装 %s' % pkg)
        subprocess.run(['cmd', '/c', sdkmanager, '--sdk_root=' + SDK, pkg],
                       env=env, input=b'y\n' * 20,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # sdkmanager 偶尔会把解压好的目录留成 xxx.delete（中断后重装），捡回来
    plat = os.path.join(SDK, 'platforms')
    if os.path.isdir(plat):
        for n in list(os.listdir(plat)):
            if n.endswith('.delete'):
                real = os.path.join(plat, n[:-7])
                if not os.path.isdir(real) or not os.listdir(real):
                    shutil.rmtree(real, ignore_errors=True)
                    os.replace(os.path.join(plat, n), real)
                    print('  恢复中断的平台目录: %s' % n)

    if not os.path.isfile(KEYSTORE):
        print('  生成调试签名…')
        subprocess.run([java_exe('keytool'), '-genkeypair', '-keystore', KEYSTORE,
                        '-storepass', 'android', '-keypass', 'android',
                        '-alias', 'androiddebugkey', '-keyalg', 'RSA',
                        '-keysize', '2048', '-validity', '10000',
                        '-dname', 'CN=Android Debug,O=Android,C=US'],
                       check=True, stdout=subprocess.DEVNULL)

    ok = all(os.path.isfile(p) for p in [
        java_exe('javac'),
        os.path.join(SDK, 'platforms', 'android-34', 'android.jar'),
        os.path.join(SDK, 'build-tools', '34.0.0', 'aapt2.exe'),
        os.path.join(SDK, 'platform-tools', 'adb.exe'),
        KEYSTORE])
    print('\n%s  工具链位置: %s' % ('✓ 装好了' if ok else '!! 有组件缺失', TOOLCHAIN))
    print('接下来: py tools/build_apk.py   （出包）')
    print('        py tools/install_apk.py （插上手机直接装）')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
