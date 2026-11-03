# 奶蛙快跑 · 安卓版

一个纯 WebView 壳，把上层目录的游戏原样装进 APK。游戏本体 100% 离线：
Three.js + 内嵌 base64 的 GLB 模型 + 本地 wav/mp3，**不申请 INTERNET 权限**。

```
android/
├── app/
│   ├── build.gradle                minSdk 23 · targetSdk 34 · AGP 8.1.4
│   └── src/main/
│       ├── AndroidManifest.xml     锁竖屏 · 硬件加速 · 无网络权限
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
py tools/build_apk.py            # 出包 → android/app/build/outputs/apk/奶蛙快跑-v1.0.apk
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

没数据线就把 `奶蛙快跑-v1.0.apk` 发到手机（微信/QQ/网盘），点开安装，
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

## 四、操作方式（安卓版专用）

| 手势 | 动作 |
|---|---|
| 左滑 / 右滑 | 换到左边 / 右边那条道 |
| 上滑 | 跳跃（豆包、刀盾可跳过） |
| 下滑 | 下蹲（钻横杆），并保持约 0.9 秒 |
| 轻点屏幕 | 也能跳（备用） |

手势绑在 `document` 上整屏有效，手指落在 HUD / 覆盖层上也能滑；
`touchmove` 会 `preventDefault`，不会触发 WebView 的下拉刷新和边缘回弹。
开始界面的提示文案就是按这个写的。

## 五、MainActivity 里几个"不做就会出问题"的设置

| 设置 | 不加会怎样 |
|---|---|
| `setMediaPlaybackRequiresUserGesture(false)` | BGM 和开场大笑被自动播放策略拦掉，全程没音乐 |
| `setLayerType(LAYER_TYPE_HARDWARE)` + Manifest `hardwareAccelerated` | Three.js 的 WebGL 拿不到上下文，黑屏 |
| `setAllowFileAccessFromFileURLs(true)` | file:// 页面加载不了同目录的 script / audio |
| `build.gradle` 里 `noCompress 'wav','mp3'`（手工出包时靠 aapt2 默认的免压扩展名列表） | >1MB 的压缩 assets 在部分 WebView 无法 seek，BGM 卡死在开头 |
| `setBlockNetworkLoads(true)` | —（游戏离线，顺手把网络也禁了，省电省心） |
| `onPause/onResume` 里调 `NaiWa.audio.pauseMusic/resumeMusic` | 切后台 BGM 还在响 |
| 双击返回键退出 | 游戏中手滑一按就退出了 |

## 六、真机调试

USB 连接 + 手机开 USB 调试后，电脑 Chrome 打开 `chrome://inspect`，
能看到 WebView 里的页面，控制台、网络、性能都能看（`WebView.setWebContentsDebuggingEnabled`
在 `MainActivity` 里开着，上架前可以关掉）。

`#simtest` 等调试 hash 在 App 里同样可用（adb 里 `am start -n com.naiwa.runner/.MainActivity --es ...`
不方便传 hash，直接用 chrome://inspect 的控制台改 `location.hash` 再刷新即可）。

## 七、常见问题

- **打开白屏 / 黑屏**：多半是设备的「Android System WebView」太老不支持 WebGL，
  到应用商店升级「Android System WebView」和 Chrome 再试。
- **没有声音**：确认不是媒体音量为 0；WebView 的自动播放策略已在代码里放行。
- **Android Studio 报 Gradle/AGP 版本不兼容**：Studio 版本太旧。升级 Studio，
  或把顶层 `build.gradle` 的 AGP 改成 7.4.2、`gradle-wrapper.properties` 的 Gradle 改成 7.5、
  `app/build.gradle` 的 `compileOptions` 改成 `VERSION_11`。
- **正式上架**：换 release keystore 签名（`app/build.gradle` 里现在复用了 debug 签名，只为方便直装），
  把 `WebView.setWebContentsDebuggingEnabled(true)` 改成 false。

## 八、为什么是 WebView 而不是 Capacitor / Cordova

游戏没有任何原生能力需求（无相机 / 推送 / 内购），Capacitor 这类框架引入一大堆
npm 依赖和插件层，收益为零；一个 200 行的 WebView Activity 更好排查问题。
唯一要自己处理的就是上表那些设置——已经都处理好了。
