# 图生 3D 角色流水线（WorkBuddy 技能）

把一张照片/设定图变成能跑进游戏的 3D 模型。这套流程是从「奶蛙快跑」项目里
实际跑通的方案提炼出来的：四个角色从手写的旋转体换成 AI 网格后，
体积压到 1/50、面数不变、能跑能跳能碰撞。

## 目录

```
游戏制作Skill（图生3D）/
├── SKILL.md                        ← 技能主文档（WorkBuddy 自动读这个）
├── scripts/
│   ├── gen_actor_3d.py             ← 批量：扫图 → 提交 → 轮询 → 下载 → 压缩
│   └── prep_actor.py               ← 单个：GLB 压缩 + base64 内嵌 + bbox 报告
├── references/
│   ├── reference-image.md          ← 参考图标准、补全身 prompt、去水印
│   ├── pitfalls.md                 ← 12 类踩坑：症状 / 真因 / 改法
│   └── runtime-integration.md      ← 伪骨骼、贴脸件、坐标反查的完整代码
├── assets/
│   ├── glb-lite.js                 ← 运行时 GLB 解析器（免 fetch）
│   └── glbActor.template.js        ← 缩放/对齐/碰撞盒/缓存的标准接法
└── README.md                       ← 本文件
```

## 三种用法

**1. 直接说需求**（推荐）

技能已接入 WorkBuddy 用户技能目录，新开会话后直接说：

- 「把这张图做成游戏模型」
- 「这几个角色都换成 AI 网格」
- 「图生 3D 帮我把障碍物重做一下」

**2. 命令行跑**

```bash
# 先看要做什么，不消耗额度
py scripts/gen_actor_3d.py --ref ref3d --dry-run

# 真跑（凭证由 WorkBuddy 会话注入到 T_TOKEN）
py scripts/gen_actor_3d.py --ref ref3d --out res/models/actors

# 单个文件处理
py scripts/prep_actor.py raw/nailong.glb out/nailong 1024
```

**3. 查文档**

遇到怪问题时按这个顺序查：`pitfalls.md`（症状速查表）→ `runtime-integration.md`
（具体代码）→ `reference-image.md`（图的问题）。

## 环境依赖

- Python 3 + `numpy` + `Pillow`（压缩脚本要用）
- 批量生成还需要 WorkBuddy 内置的 `buddy-multimodal-generation` 脚本；
  找不到时用 `--mmgen <绝对路径>` 或环境变量 `MMGEN_SCRIPT` 指定
- 运行时：three.js（GLB 解析器只依赖 `BufferGeometry` / `MeshPhongMaterial`）

## 这个技能怎么"接入"的

WorkBuddy 的技能目录里是一份**真实副本**：

```
C:\Users\Pjh18\.workbuddy\skills\photo-to-3d-game-actor\   ← 机器读这份
C:\Users\Pjh18\Desktop\奶蛙快跑\游戏制作Skill（图生3D）\     ← 人看/人改这份
```

一开始试过用目录联接（Junction）把两者绑在一起，但 Windows 的联接在部分文件
遍历里会被当成"符号链接"而不是"目录"，技能扫描有整个跳过的风险。所以改成
两份实体 + 一个同步脚本，行为确定。

**改完技能后跑一次同步**（在项目根目录）：

```bash
py tools/sync_skill.py            # 覆盖同名文件 + 补新增文件，不删多余
py tools/sync_skill.py --check    # 只看差异，不写盘
py tools/sync_skill.py --prune    # 镜像：删掉目标里多出来的（重命名文件后用）
```

同步脚本会把差异逐条列出来，跑完告诉你改了几个文件。

**看不到技能时**按顺序试：

1. 关掉技能设置页重新打开（页面列表有缓存）
2. 新开一个会话（会话的技能清单是开场时注入的，中途新增的看不到）
3. 重启 WorkBuddy（会重新扫描技能目录）

## 已知边界

- **每天 5 次提交额度**（`hy-3d` 维度），是次数不是余额，自然日 0 点重置
  见 `pitfalls.md` 第 10 条
- 生成结果**无骨骼、无动画**，动起来要靠伪骨骼；大角度的姿势缺陷
  （手举过头顶等）拧不过来，得换参考图重跑
- 单模型生成 5~15 分钟，别指望秒出
