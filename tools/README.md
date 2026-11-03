# tools/ 用这套流程加一个新角色

从一张图到一个能跑能跳的游戏角色，四步。全程不需要建模软件。

---

## 第 1 步：挑参考图（决定成败的一半）

图生 3D 对**正面、全身、清晰、背景干净、无文字**的图效果最好。实测分档：

| 档 | 特征 | 结果 |
|---|---|---|
| A | 正面全身、大眼、主体占满画面 | 一次成型，五官都对 |
| B | 3/4 视角、或半身、或低分辨率 | 形体对，但眼位/腿脚会偏 |
| C | 只有头肩、带文字水印、表情包截图 | 不能直接用 |
| D | 远景小主体、多个角色同框 | 不能直接用 |

C / D 档不要硬上，先补图（见第 2 步）。

## 第 2 步（可选）：用 image-to-image 补一张干净全身图

原图只有头、或者带水印时，让模型**在原图基础上往下补全身**，而不是凭空重画。
关键是提示词里把已有特征逐条写死（发色、瞳色、衣服、配饰），只补缺失部分。

产出放 `res/ref3d/<名字>.png`，长边缩到 1024。

## 第 3 步：图生 3D

走 `buddy-multimodal-generation` 技能：
- `generate_type = LowPoly`（对应 model 3.0）
- `enable_pbr = true`
- 并发上限 **2**，超了返回 429，要排队

产出原始 GLB 通常 **20~25 MB**（三张 4096² PNG 贴图），放 `res/models/raw/`。

## 第 4 步：处理成游戏资源

```bash
py tools/prep_actor.py res/models/raw/<名字>.glb res/models/actors/<名字> 1024
```

它做四件事：
1. 贴图压到 1024² JPEG —— 22 MB → 0.37 MB
2. 重排 `bufferViews` 写出精简 GLB
3. 转成 base64 的 `.js`（`file://` 下 `fetch` 会被 CORS 拦，只能用 `<script>` 引入）
4. 打印包围盒 / 面数 / 身高轴，供下面算缩放

输出两个文件：
```
res/models/actors/<名字>.glb       精简 GLB（归档用，运行时不读）
res/models/actors/<名字>_glb.js    内嵌 base64，window.ACTOR_<大写名字>
```

## 第 5 步：接进游戏

**a. `index.html`**，在 `game.js` 之前加一行：

```html
<script src="res/models/actors/<名字>_glb.js"></script>
```

**b. `game.js`**，在对应角色的函数开头拦截：

```js
OB.<类型> = function () {
  if (USE_GLB_ACTORS) {
    var a = glbActor('ACTOR_<大写名字>', {
      h:     1.05,    // 目标身高（世界单位）—— 这是个设计决定，不是从 GLB 抄出来的数字
      hitH:  1.00,    // 碰撞盒顶（等于"跳起来脚底要多高才过得去"）
      hitK:  0.80,    // 碰撞盒横向手感系数，模型带张开的手臂时压一压
      name:  '豆包'
    });
    if (a) return a;
  }
  /* 旧的手写几何体原样保留，glbActor 返回 null 时自动兜底 */
};
```

> **别把 GLB 出来的尺寸当成"它该多大"**。豆包曾经直接用了 GLB 的 1.49 米，
> 结果脚底要抬到 1.43 才算越过，窗口窄到玩家跳不过去；回头把它按人设重定到 1.05 米，
> 同一条抛物线上的可用时间立刻翻倍。定尺寸时要问的是「这个角色在游戏里该多高」，
> 而不是「AI 把它生成了多高」。
>
> 顺便：`hitH` 也不等于模型最高点。趴姿角色的刀、盾、举手这类零件不该挡路，
> 判定顶应该取**真正挡路那部分**的高度。

收集物那种不是 `{obj,hit}` 接口的，取 `.obj`：

```js
var a = glbActor('ACTOR_NAILONG', { h: 0.74, name: '奶龙' });
if (a) return a.obj;
```

**c. 核对**：`index.html#auto&show=all` 会开跑并把所有角色摆到镜头前。

> **量模型要在挂提示之前**。给可跳障碍挂头顶箭头时要读一次包围盒，
> 如果先 `add(cue)` 再量，包围盒就把提示本身也算进去了，箭头会越挂越高。

---

## 调试 / 验证脚本

| 命令 | 用途 |
|---|---|
| `py tools/jump_check.py --all` | 静态核对每个障碍的判定顶 / 窗口秒数是否符合「谁能跳」规则 |
| `py tools/sim_headless.py` | 跑 `#simtest`：量各角色真实尺寸 + 各速度起跳区间 + bot 全程模拟 + 手势/BGM 自检 |
| `py tools/shot.py "<hash>" <out.png> <预算ms> "<宽,高>"` | headless 截图（`#cue=` / `#hop=` / `#show=`） |
| `py tools/make_bgm.py` | 合成 `res/bgm.wav`（138 BPM 8 小节无缝循环） |
| `py tools/sync_android_assets.py` | 把游戏同步进 `android/.../assets/www/` 并校验引用（`--check` / `--prune`） |
| `py tools/install_toolchain.py` | 一次性装齐出包工具链（JDK 17 + android-34 + build-tools 34 + adb + 调试签名） |
| `py tools/build_apk.py` | 不用 Gradle 直接出 APK（aapt2 → javac → d8 → zipalign → apksigner） |
| `py tools/install_apk.py` | 手机插 USB 后一条命令装机并启动（自动等设备、查授权） |
| `py tools/dev_server.py [--watch] [--lan] [--stop]` | 开发模式：HTTP 服务 + `adb reverse`，App 直接加载电脑上的文件，改完刷新即生效 |
| `py tools/make_launcher_icon.py` | 重新生成 App 启动图标 PNG（API < 26 用） |

`sim_headless.py` 末尾现在还会打一行 **BGM 自检**（文件是否加载成功、进度是否在走），
headless 默认禁自动播放，所以要判「文件能不能用」看 `就绪=4` 就够，
`状态=playing` 需要额外加 `--autoplay-policy=no-user-gesture-required` 才会出现。

`dev_server.py` 三条容易踩的：

- 默认只绑 `127.0.0.1`，靠 `adb reverse` 让手机访问 —— **别改成 0.0.0.0**，
  否则同网段谁都能翻你的项目目录；确实要 WiFi 直连再用 `--lan`。
- 响应头必须带 `Cache-Control: no-store`（已在 `Handler.end_headers` 里），
  否则改完刷新还是旧代码，会误以为是「代码没生效」查半天。
- `adb reverse` 在 USB 断开后就没了，重插线要重启脚本；`--stop` 可手动清。

## 坐标系（改代码前必须知道）

AI 生成的 GLB **顶点是 Z-up**：`z` 从 −0.95 到 +0.95 就是身高。
但节点自带一段绕 X 轴 **+90°** 的四元数旋转，把它转成 Y-up。`glb-lite.js` 会应用这段 TRS，
所以拿到手的 `object3D` 已经是 **Y 朝上**，游戏里不用再转。

但在 Python 里直接读顶点时，必须自己换算：`世界 y = -raw_z + 高度/2`。
写错这一条，伪骨骼的髋部高度会落到头上，整个身体会绕着脑袋甩。

## 主角那套额外还有两步

角色当主角时，还缺五官和腿：

- **伪骨骼**：整块网格没有骨骼。按「离地高度 × 侧向距离」给顶点算权重，
  绕左右髋点做 X 轴旋转；踝以下再反向回转 55%，脚掌才不会跟着翘。
  角度直接读原动作代码写进 `legs[i].rotation.x` 的值，跑/跳/笑三套节奏自动继承。
- **五官**：AI 在小目标上会翻车（眼睛被压成缝）。用自写正交光栅化 + z-buffer
  反查贴图上的"真实眼睛/嘴线"三维坐标，再决定是盖掉重做、还是只补高光。
  张嘴那张"贴片"必须**从模型表面采样生成**，不能用球冠/椭球：
  嘴线在三维里是弯的，任何解析曲面贴上去都会一端穿出脸颊。

详细过程见主 README 的第二、三轮章节。
