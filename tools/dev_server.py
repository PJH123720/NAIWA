# -*- coding: utf-8 -*-
"""
开发模式：让手机上的 App 直接加载电脑里的游戏文件。

为什么需要它：
  正式包里游戏是从 APK 内部的 assets 读的，改一行 game.js 就得重新出包（5 MB）
  再传到手机装一遍。调手感的时候一晚上能改二十次，这条路太慢。

怎么做的：
  1. 电脑起一个 HTTP 服务（只绑 127.0.0.1，不暴露到局域网）；
  2. `adb reverse tcp:8000 tcp:8000` 把这个端口反向映射到手机 —— 手机上的
     http://127.0.0.1:8000 就是电脑的 8000 端口。走的是 USB 线，**不需要手机和
     电脑在同一个 WiFi**，也不受校园网/公司网的客户端隔离影响（比局域网方案稳）；
  3. 用 am start 带一个 dev_url extra 拉起 App，MainActivity 看到就加载这个地址，
     而不是 assets；
  4. 手机上右下角会出现 DEV ↻ 角标，点一下刷新。改完 game.js 保存 → 点角标 →
     手机上就是新代码，不用重装。

退出开发模式：直接点桌面上的「奶蛙快跑」图标正常启动即可 —— 那个 intent 不带
extra，App 会切回离线的 assets 版本。

用法：
    py tools/dev_server.py              # 起服务 + 装到手机 + 打开
    py tools/dev_server.py --watch      # 再盯住源文件，改完自动让手机重载
    py tools/dev_server.py --lan        # 没有 USB 时走 WiFi（绑 0.0.0.0）
    py tools/dev_server.py --stop       # 撤销端口映射

前置：手机用 USB 连上并允许了 USB 调试（`adb devices` 能看到）。
"""

import argparse
import http.server
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLCHAIN = os.environ.get('NAIWA_TOOLCHAIN') or os.path.join(
    os.path.expanduser('~'), 'naiwa-toolchain')
ADB = os.path.join(TOOLCHAIN, 'android-sdk', 'platform-tools', 'adb.exe')

COMPONENT = 'com.naiwa.runner/.MainActivity'
PORT = 8000

# --watch 盯这些：改了就通知手机重载
WATCH = ['index.html', 'game.js', 'lib/glb-lite.js']


# ---------------------------------------------------------------- adb

def adb(*args, timeout=25):
    if not os.path.isfile(ADB):
        return 127, '找不到 adb：%s\n先跑 py tools/install_toolchain.py' % ADB
    try:
        p = subprocess.run([ADB] + list(args), capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, 'adb 超时'
    out = (p.stdout + p.stderr).decode('utf-8', 'replace').strip()
    return p.returncode, out


def devices():
    """返回 [(serial, state)]。注意 adb 启动守护进程时会往 stdout 打日志，
    那些行没有两列，必须靠分列过滤掉（上一版就是被这行日志骗了）。"""
    _, out = adb('devices')
    rows = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] in ('device', 'unauthorized', 'offline', 'recovery'):
            rows.append((parts[0], parts[1]))
    return rows


# ---------------------------------------------------------------- HTTP

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # 改完代码必须立刻拿到新版，任何一层缓存都不能吃它
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def list_directory(self, path):
        # 根目录有 300 MB 的模型和中间产物，列目录又慢又没必要
        self.send_error(403, 'directory listing disabled')
        return None

    def log_request(self, code='-', size='-'):
        # 只报错；正常请求静默，否则控制台会被几十条 200 刷掉
        try:
            if int(code) < 400:
                return
        except (TypeError, ValueError):
            pass
        super().log_request(code, size)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def start_server(bind, port):
    """返回 (server, port)；端口被占就往后挪，最多试 20 个"""
    for p in range(port, port + 20):
        try:
            srv = Server((bind, p), Handler)
        except OSError:
            continue
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        return srv, p
    raise SystemExit('!! %d~%d 端口都被占用了' % (port, port + 19))


# ---------------------------------------------------------------- 启动 App

def launch(url, serial=None):
    args = ['-s', serial] if serial else []
    cmd = ['shell', 'am', 'start', '-n', COMPONENT, '-e', 'dev_url', url]
    rc, out = adb(*(args + cmd))
    ok = rc == 0 and 'Error' not in out
    return ok, out


def stop_reverse(port, serial=None):
    args = ['-s', serial] if serial else []
    adb(*(args + ['reverse', '--remove', 'tcp:%d' % port]))


# ---------------------------------------------------------------- main

def main():
    # 输出被重定向到文件时默认是块缓冲，进度会一直看不到；强制按行刷新
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass

    ap = argparse.ArgumentParser(description='奶蛙快跑 · 开发模式')
    ap.add_argument('--port', type=int, default=PORT, help='本地端口，默认 8000')
    ap.add_argument('--lan', action='store_true',
                    help='绑 0.0.0.0 用 WiFi 访问（没有 USB 时用，需要同一局域网）')
    ap.add_argument('--watch', action='store_true', help='源文件改动后自动让手机重载')
    ap.add_argument('--stop', action='store_true', help='撤销 adb reverse 端口映射后退出')
    ap.add_argument('--no-launch', action='store_true', help='只起服务，不拉起 App')
    args = ap.parse_args()

    if args.stop:
        stop_reverse(args.port)
        print('已撤销 tcp:%d 的反向映射' % args.port)
        return

    rows = devices() if not args.lan else []
    ready = [s for s, st in rows if st == 'device']
    pending = [(s, st) for s, st in rows if st != 'device']

    if not args.lan and not ready:
        print('没有检测到已授权的安卓设备。\n')
        if pending:
            for s, st in pending:
                print('  发现 %s，状态 = %s' % (s, st))
            print('  → 在手机上点「允许 USB 调试」，然后重新运行本脚本\n')
        else:
            print('  · 插上 USB 线，手机选「传输文件/MTP」而不是「仅充电」')
            print('  · 设置 → 关于手机 → 连点版本号 7 次 → 开发者选项 → 打开 USB 调试')
            print('  · 或者加 --lan 走同一个 WiFi（若网络做了客户端隔离会连不上）\n')
        print('这次先只起服务，你可以手动在手机浏览器打开下面的地址。')
        if not pending:
            print('（没有 USB 的话，--lan 才是对的路子）')

    serial = ready[0] if ready else None

    # 服务只绑 127.0.0.1：adb reverse 从手机侧看就是本机端口，不需要暴露到网络
    bind = '0.0.0.0' if args.lan else '127.0.0.1'
    srv, port = start_server(bind, args.port)
    base = 'http://127.0.0.1:%d' % port

    print('\n' + '=' * 58)
    print(' 奶蛙快跑 · 开发模式')
    print('=' * 58)
    print(' 服务目录  %s' % ROOT)
    print(' 本地地址  %s/index.html' % base)

    if args.lan:
        print(' 局域网    http://%s:%d/index.html' % (lan_ip(), port))
        print('           ↑ 手机浏览器直接开这个（需同一 WiFi）')
    else:
        print(' 手机地址  %s/index.html  （经 USB 反向映射）' % base)

    if serial and not args.lan:
        rc, out = adb('-s', serial, 'reverse', 'tcp:%d' % port, 'tcp:%d' % port)
        if rc == 0:
            print(' 端口映射  ✓ tcp:%d → 电脑 tcp:%d' % (port, port))
        else:
            print(' 端口映射  ✗ %s' % out)
            print('           （adb reverse 需要 Android 5.0+ 和较新的 platform-tools）')

    if serial and not args.no_launch:
        ok, out = launch('%s/index.html' % base, serial)
        print(' 拉起 App  %s' % ('✓ 已在手机上打开' if ok else '✗ ' + out))
        if not ok:
            print('           App 装了吗？先跑 py tools/install_apk.py')

    print('-' * 58)
    print(' 改完 game.js / index.html 后：')
    print('   · 手机上点右下角「DEV ↻」立即刷新，或')
    print('   · 本脚本加 --watch，保存文件就自动重载')
    print(' 想回到正式离线版：点桌面上的「奶蛙快跑」图标正常启动即可')
    print(' 退出：Ctrl+C')
    print('=' * 58)

    try:
        if args.watch:
            watch_loop(serial, '%s/index.html' % base)
        else:
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        srv.shutdown()
        if serial and not args.lan:
            stop_reverse(port, serial)
        print('\n已停止（端口映射也撤销了）')


def watch_loop(serial, url):
    """盯着几个源文件的 mtime，变了就再 am start 一次触发重载"""
    def snap():
        d = {}
        for rel in WATCH:
            p = os.path.join(ROOT, rel)
            try:
                d[rel] = os.path.getmtime(p)
            except OSError:
                d[rel] = 0
        return d

    last = snap()
    print('\n[watch] 已开始监视 %s' % ', '.join(WATCH))
    while True:
        time.sleep(0.7)
        cur = snap()
        changed = [k for k in cur if cur[k] != last[k]]
        if not changed:
            continue
        last = cur
        # 编辑器保存常常是「先清空再写入」，稍等一下避免读到半个文件
        time.sleep(0.25)
        last = snap()
        if serial:
            ok, _ = launch(url, serial)
            print('[watch] %s 改了 → %s' % (', '.join(changed),
                                            '手机已重载' if ok else '重载失败'))
        else:
            print('[watch] %s 改了 → 手机上刷新即可' % ', '.join(changed))


if __name__ == '__main__':
    main()
