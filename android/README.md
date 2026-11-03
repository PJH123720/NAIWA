# 奶蛙快跑 · 安卓版

一个纯 WebView 壳，把上层目录的游戏原样装进 APK。游戏本体 100% 离线运行：
Three.js + 内嵌 base64 的 GLB 模型 + 本地 wav/mp3，正式玩法下 `setBlockNetworkLoads(true)`
把网络彻底掐死，**不会发出任何请求**。

（清单里声明了 `INTERNET` 权限，只为「开发模式」这一条路径服务 —— 见第四节。
它是普通权限，安装时不弹窗、用户在设置里也看不到；不带开发参数正常启动时
WebView 一个字节都发不出去。）

```
android/
├── app/
│   ├── build.gradle                minSdk 23 · targetSdk 34 · AGP 8.1.4
│   └── src/main/
│       ├── AndroidManifest.xml     锁竖屏 · 硬件加速 · INTERNET（仅开发模式用）
│       ├── java/com/naiwa/runner/MainActivity.java
│       ├── assets/www/             ← 游戏本体（由 tools/sync_android_assets.py 生成）
│       └── res/                    图标 / 主题
├── build.gradle · settings.gradle · gradle.properties
└── README.md                       ← 本文件
```

## 一、出包（最省事：两条命令，不用 Android Studio）

工具链是免安装的 zip，装在 `%USERPROFILE%\naiwa-toolchain`（约 600 MB）：

```bash
py tools/install_toolchain.py    # 一次性：JDK 17 + android-34 + build-tools 34 + adb + 调试签名
py tools/build_apk.py            # 出包 → android/app/build/outputs/apk/奶蛙快跑-v1.1.apk
```

`build_apk.py` 不走 Gradle，直接用 SDK 里的 `aapt2 → javac → d8 → zipalign → apksigner`
手工出包，几秒钟一个，全程不联网（Gradle 路线要额外拉 AGP 几百 MB）。

> **为什么先拷到英文目录再编**：`aapt2.exe` / `zipalign.exe` 在 Windows 上按 ANSI
> 代码页解析参数，项目在「桌面\奶蛙快跑」这种中文路径下会报
> `failed to open directory: 系统找不到指定的文件`。脚本会自动把 `res/assets/java`
> 摆到 `~/naiwa-toolchain/build`（纯 ASCII）里编，最后把 APK 拷回项目。

**装到手机**（数据线 + USB 调试）：

```bash
py tools/install_apk.py          # 自动等设备 → adb install -r → 启动游戏
```

没数据线就把 `奶蛙快跑-v1.1.apk` 发到手机（微信/QQ/网盘），点开安装，
首次要允许「安装未知来源应用」。

## 二、构建（Android Studio，可选）

1. 装 [Android Studio](https://developer.android.com/studio)（自带 JDK 和 Android SDK）。
2. `Open` → 选 **本目录**（`android/`，不是上层游戏目录）。
3. 第一次打开会下载 Gradle 8.2 和依赖（几分钟）。
4. 手机插 USB、开「USB 调试」→ 顶部设备下拉框选手机 → 点绿色 ▶ `Run`。
5. 要 APK：`Build → Build APK(s)`，产物在 `app/build/outputs/apk/debug/`。

> `app/build.gradle` 是给 Android Studio 路线用的；手工出包不读它，
> 版本号 / 包名 / minSdk 在 `tools/build_apk.py` 顶部那几行里改。

## 三、改了游戏怎么更新

改完上层目录的 `game.js` / `index.html` / 资源后，重新出包就行 ——
`build_apk.py` 第一步就会自动同步：

```bash
py tools/build_apk.py
py tools/install_apk.py        # 手机插着就顺手装上
```

同步脚本（`tools/sync_android_assets.py`）会自动：跳过 300 MB 的原始 GLB 等无关文件、
把 `res/奶娃照片.jpg` 改名成 `res/mascot.jpg`（中文路径在部分 WebView 的 file:// 下会 404）、
并核对 index.html 里每一条 src/href 引用都能在包里找到。

## 四、开发模式：改 JS 不用重新出包

调手感时一晚上能改二十次，每次都要传 5 MB 到手机太慢。开发模式让 App 直接加载
电脑里的文件，**改完保存、手机上刷新就生效**，不用重装。

```bash
py tools/dev_server.py            # 起服务 → adb reverse → 在手机上打开
py tools/dev_server.py --watch    # 再把源文件盯住，保存就自动重载
py tools/dev_server.py --stop     # 收工，撤销端口映射
```

手机上会多一个右下角的 **DEV ↻** 半透明角标，点一下就是刷新。原来的大文件
（模型、音频）由电脑发过去，所以手机上看到的和正式包完全一样的画面。

**走的是 USB 线，不需要同一个 WiFi。** 原理是 `adb reverse tcp:8000 tcp:8000`：
把电脑的 8000 端口映射到手机的 127.0.0.1:8000，手机访问本机端口就等于访问电脑。
比局域网方案可靠得多 —— 校园网/公司网经常开客户端隔离，WiFi 那条路会连不上。
（实在没有数据线时用 `--lan`，会绑 0.0.0.0 并打印局域网地址。）

**怎么退出开发模式**：直接点桌面上的「奶蛙快跑」图标正常启动。那个 intent 不带
`dev_url`，`MainActivity` 看到就切回离线的 assets 版本 —— 也就是说「是否开发模式」
完全由启动方决定，装给别人的包里这条路径永远走不到，`setBlockNetworkLoads(true)`
照旧把网络锁死。

手动指定地址（想调别的端口、或用 `#simtest` 之类的调试入口时）：

```bash
adb shell am start -n com.naiwa.runner/.MainActivity \
    -e dev_url "http://127.0.0.1:8000/index.html#simtest"
# 也可以只写 -e dev 1，等价于 http://127.0.0.1:8000/index.html
```

几个实现上的注意点（改这块代码时容易踩）：

| 点 | 说明 |
|---|---|
| `setBlockNetworkLoads(false)` 只在 dev 分支开 | 正式模式必须为 true，否则联网权限就真的成了后门 |
| 每次 `loadUrl` 都加 `?_t=<时间戳>` | 同一个 URL 连续 loadUrl，WebView 可能认为「没变化」而不再请求，改完 JS 看不到效果 |
| `onNewIntent` 要按新 intent 重新判定 | `launchMode=singleTask`，点图标启动不会新建 Activity，不带 extra 就等于要求切回离线版 |
| 服务端强制 `Cache-Control: no-store` | 否则改完刷新还是旧代码（已加，别去掉） |
| 高于 1 MB 的 wav 仍是 STORE 不压缩 | 与正式包一致；开发模式下是 HTTP 传输，不受这条影响 |

> 开发模式下页面 origin 是 `http://127.0.0.1:8000`，正式包是 `file://`，
> 两者 localStorage 不互通 —— 最高分在开发模式里是从 0 开始的，正常现象。

## 五、操作方式（安卓版专用）

| 手势 | 动作 |
|---|---|
| 左滑 / 右滑 | 换到左边 / 右边那条道 |
| 上滑 | 跳跃（豆包、刀盾可跳过） |
| 下滑 | 下蹲（钻横杆），并保持约 0.9 秒 |
| 轻点屏幕 | 也能跳（备用） |

手势绑在 `document` 上整屏有效，手指落在 HUD / 覆盖层上也能滑；
`touchmove` 会 `preventDefault`，不会触发 WebView 的下拉刷新和边缘回弹。
开始界面的提示文案就是按这个写的。

## 六、MainActivity 里几个"不做就会出问题"的设置

| 设置 | 不加会怎样 |
|---|---|
| `setMediaPlaybackRequiresUserGesture(false)` | BGM 和开场大笑被自动播放策略拦掉，全程没音乐 |
| `setLayerType(LAYER_TYPE_HARDWARE)` + Manifest `hardwareAccelerated` | Three.js 的 WebGL 拿不到上下文，黑屏 |
| `setAllowFileAccessFromFileURLs(true)` | file:// 页面加载不了同目录的 script / audio |
| `build.gradle` 里 `noCompress 'wav','mp3'`（手工出包时靠 aapt2 默认的免压扩展名列表） | >1MB 的压缩 assets 在部分 WebView 无法 seek，BGM 卡死在开头 |
| `setBlockNetworkLoads(true)`（正式模式） | —（游戏离线，顺手把网络也禁了；开发模式才临时放行，见第四节） |
| `android:usesCleartextTraffic="true"` | 开发模式访问 `http://127.0.0.1` 时被系统当明文拦截 |
| `onPause/onResume` 里调 `NaiWa.audio.pauseMusic/resumeMusic` | 切后台 BGM 还在响 |
| 双击返回键退出 | 游戏中手滑一按就退出了 |

## 七、真机调试

USB 连接 + 手机开 USB 调试后，电脑 Chrome 打开 `chrome://inspect`，
能看到 WebView 里的页面，控制台、网络、性能都能看（`WebView.setWebContentsDebuggingEnabled`
在 `MainActivity` 里开着，上架前可以关掉）。

`#simtest` 这类调试 hash 在开发模式下最方便，直接把 hash 拼进 `dev_url`：

```bash
adb shell am start -n com.naiwa.runner/.MainActivity \
    -e dev_url "http://127.0.0.1:8000/index.html#simtest"
```

（正式包里也能看，但 assets 是只读的、改不了参数，实际只能读那几行结论。）

## 八、常见问题

- **打开白屏 / 黑屏**：多半是设备的「Android System WebView」太老不支持 WebGL，
  到应用商店升级「Android System WebView」和 Chrome 再试。
- **没有声音**：确认不是媒体音量为 0；WebView 的自动播放策略已在代码里放行。
- **Android Studio 报 Gradle/AGP 版本不兼容**：Studio 版本太旧。升级 Studio，
  或把顶层 `build.gradle` 的 AGP 改成 7.4.2、`gradle-wrapper.properties` 的 Gradle 改成 7.5、
  `app/build.gradle` 的 `compileOptions` 改成 `VERSION_11`。
- **正式上架**：换 release keystore 签名（`app/build.gradle` 里现在复用了 debug 签名，只为方便直装），
  把 `WebView.setWebContentsDebuggingEnabled(true)` 改成 false。
  另外把清单里的 `INTERNET` 权限和 `usesCleartextTraffic` 删掉 —— 上架版本用不到开发模式，
  留着会被应用商店的隐私扫描问到。
- **开发模式打不开 / 一直转圈**：先看 `adb reverse --list` 有没有 tcp:8000；没有就重启
  `py tools/dev_server.py`。手机和电脑不同网段不影响（走 USB），但 USB 断过之后映射会失效。

## 九、为什么是 WebView 而不是 Capacitor / Cordova

游戏没有任何原生能力需求（无相机 / 推送 / 内购），Capacitor 这类框架引入一大堆
npm 依赖和插件层，收益为零；一个 200 行的 WebView Activity 更好排查问题。
唯一要自己处理的就是上表那些设置——已经都处理好了。
