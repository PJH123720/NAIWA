# -*- coding: utf-8 -*-
"""生成跑酷背景音乐 res/bgm.wav。

用 numpy 直接合成一段"欢快"的 8 小节循环：主旋律（带限方波 + 一点点锯齿做身体）
+ 八分音符弹跳贝斯 + 底鼓/军鼓/闭镲。所有素材都是算出来的，不依赖任何音频库或
版权音频 —— 机器里没有 ffmpeg / lameenc，所以输出 WAV（<audio loop> 播 WAV 没有
编码器 padding，能真正做到无缝循环）。

循环无缝的关键在最后：多渲染 TAIL 秒的尾巴，再把尾巴叠回开头，
这样末尾音符的延音会自然绕回第一拍，听不出接缝。

    py tools/make_bgm.py
"""
import os
import struct
import wave

import numpy as np

SR = 44100
BPM = 138.0
BEAT = 60.0 / BPM            # 一拍
S16 = BEAT / 4               # 十六分音符
BARS = 8
LOOP_BARS = BARS
TAIL = 2.2                   # 多渲染的尾巴（秒），用于无缝回绕

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'res', 'bgm.wav')


def midi_hz(m):
    return 440.0 * (2.0 ** ((m - 69) / 12.0))


def band_square(t, f, hmax=9000.0):
    """带限方波（只叠加奇次谐波，超过 hmax 的不要 —— 否则会混叠出刺耳的杂音）"""
    out = np.zeros_like(t)
    k = 1
    while k * f < hmax:
        out += np.sin(2 * np.pi * k * f * t) / k
        k += 2
    return out


def band_saw(t, f, hmax=9000.0):
    out = np.zeros_like(t)
    k = 1
    while k * f < hmax:
        out += np.sin(2 * np.pi * k * f * t) / k
        k += 1
    return out


def adsr(n, sr, a=0.004, d=0.045, sus=0.62, r=0.05):
    """ADSR，n 是总长度（样本）。n 太短时按比例压缩，避免爆音。"""
    A, D, R = int(a * sr), int(d * sr), int(r * sr)
    total = A + D + R
    if n < total:
        k = n / float(total)
        A, D, R = max(1, int(A * k)), max(1, int(D * k)), max(1, int(R * k))
    S = max(1, n - A - D - R)
    e = np.concatenate([
        np.linspace(0.0, 1.0, A, endpoint=False),
        np.linspace(1.0, sus, D, endpoint=False),
        np.full(S, sus, dtype=np.float64),
        np.linspace(sus, 0.0, R),
    ])
    if len(e) < n:
        e = np.concatenate([e, np.zeros(n - len(e))])
    return e[:n]


def add(buf, start, wave, amp):
    """把一段波形叠进 buf（越界自动裁剪）"""
    if start < 0:
        wave = wave[-start:]
        start = 0
    end = min(len(buf), start + len(wave))
    if end <= start:
        return
    buf[start:end] += wave[:end - start] * amp


def noise(n, rng):
    return rng.uniform(-1.0, 1.0, n)


def build():
    rng = np.random.default_rng(20261030)
    sixteenths = LOOP_BARS * 16
    loop_len = int(round(sixteenths * S16 * SR))
    total = loop_len + int(TAIL * SR)
    buf = np.zeros(total, dtype=np.float64)

    def at(step16):
        return int(round(step16 * S16 * SR))

    # ---------------- 主旋律 ----------------
    # 欢快的关键：级进 + 大调琶音骨架，句尾收回主音。数字是 MIDI 音高。
    MEL = [
        (0, 2, 72), (2, 2, 76), (4, 2, 79), (6, 2, 76),
        (8, 3, 77), (11, 1, 76), (12, 2, 74), (14, 2, 72),
        (16, 2, 74), (18, 2, 77), (20, 2, 81), (22, 2, 77),
        (24, 4, 79), (28, 4, 76),
        (32, 2, 72), (34, 2, 76), (36, 2, 79), (38, 2, 84),
        (40, 3, 83), (43, 1, 81), (44, 2, 79), (46, 2, 76),
        (48, 2, 77), (50, 2, 81), (52, 4, 79),
        (56, 2, 76), (58, 2, 74), (60, 4, 72),
        (64, 2, 79), (66, 2, 81), (68, 2, 83), (70, 2, 84),
        (72, 4, 83), (76, 4, 79),
        (80, 2, 81), (82, 2, 79), (84, 2, 77), (86, 2, 76),
        (88, 4, 77), (92, 4, 81),
        (96, 2, 84), (98, 2, 83), (100, 2, 81), (102, 2, 79),
        (104, 4, 77), (108, 4, 76),
        (112, 2, 74), (114, 2, 76), (116, 2, 77), (118, 2, 79),
        (120, 4, 72), (124, 2, 76), (126, 2, 74),   # 小回转，绕回开头的 C5
    ]
    for st, dur, m in MEL:
        n = int(round(dur * S16 * SR))
        t = np.arange(n) / float(SR)
        f = midi_hz(m)
        w = 0.72 * band_square(t, f) + 0.28 * band_saw(t, f)
        w *= adsr(n, SR, a=0.005, d=0.05, sus=0.60, r=0.055)
        add(buf, at(st), w, 0.26)

    # ---------------- 贝斯：根音-五度-八度 弹跳 ----------------
    ROOTS = [48, 43, 48, 43, 48, 41, 43, 48]     # C G C G C F G C
    PAT = [0, 7, 0, 12, 0, 7, 12, 7]
    for bar, root in enumerate(ROOTS):
        for i, off in enumerate(PAT):
            st = bar * 16 + i * 2
            n = int(round(2 * S16 * SR))
            t = np.arange(n) / float(SR)
            f = midi_hz(root + off)
            w = 0.65 * np.sin(2 * np.pi * f * t) + 0.35 * band_square(t, f, 600.0)
            w *= adsr(n, SR, a=0.004, d=0.04, sus=0.55, r=0.035)
            add(buf, at(st), w, 0.30)

    # ---------------- 鼓 ----------------
    def kick(st, amp=0.55):
        n = int(0.16 * SR)
        t = np.arange(n) / float(SR)
        f = 130.0 * np.exp(-t / 0.028) + 45.0        # 频率快速下坠 = 底鼓
        ph = 2 * np.pi * np.cumsum(f) / SR
        w = np.sin(ph) * np.exp(-t / 0.062)
        w *= np.minimum(1.0, t / 0.004)              # 去掉起点的咔哒
        add(buf, at(st), w, amp)

    def snare(st, amp=0.17):
        n = int(0.17 * SR)
        t = np.arange(n) / float(SR)
        hp = noise(n, rng)
        hp = np.diff(hp, prepend=0.0)                # 一阶差分 ≈ 高通，噪声更"脆"
        w = hp * np.exp(-t / 0.045)
        w += 0.30 * np.sin(2 * np.pi * 195.0 * t) * np.exp(-t / 0.030)
        add(buf, at(st), w, amp)

    def hat(st, amp=0.075):
        n = int(0.05 * SR)
        t = np.arange(n) / float(SR)
        hp = np.diff(noise(n, rng), prepend=0.0)
        w = hp * np.exp(-t / 0.012)
        add(buf, at(st), w, amp)

    for bar in range(LOOP_BARS):
        b = bar * 16
        kick(b)
        kick(b + 8)
        if bar % 2 == 1:
            kick(b + 14, 0.40)                       # 偶数小节加一个切分，别太平
        snare(b + 4)
        snare(b + 12)
        for i in range(8):
            hat(b + i * 2, 0.085 if i % 2 == 0 else 0.050)

    # ---------------- 尾巴回绕 + 归一 ----------------
    tail = buf[loop_len:]
    out = buf[:loop_len].copy()
    out[:len(tail)] += tail

    out = np.tanh(out * 1.05)                        # 软限幅，防止叠加后削顶
    peak = float(np.max(np.abs(out)))
    out = out / max(peak, 1e-6) * 0.88

    return out


def write_wav(path, data):
    pcm = np.clip(data, -1.0, 1.0)
    pcm = (pcm * 32000.0).astype('<i2')              # 留一点 headroom，别顶到 0 dBFS
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == '__main__':
    y = build()
    write_wav(OUT, y)
    secs = len(y) / float(SR)
    print('写出 %s' % OUT)
    print('时长 %.2f 秒（%.1f BPM · %d 小节循环）· %.2f MB' %
          (secs, BPM, LOOP_BARS, os.path.getsize(OUT) / 1048576.0))
