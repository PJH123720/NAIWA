# 运行时集成：伪骨骼、贴脸件、坐标反查

AI 生成的网格有三个短板：没有骨骼、五官是画在贴图上的、姿势固定。
这里给三套补法。全部是纯 three 代码，不需要任何插件或额外依赖。

---

## 一、伪骨骼：让无骨骼的腿动起来

核心思路：**不改动作代码**，只读动作代码算出来的角度，按顶点权重手动变形。
这样跑、跳、笑三套节奏自动继承。

### 权重怎么算

两个维度相乘：

1. **高度权重 `wh`**：越靠下越跟着腿走。髋部以上为 0，髋下 `LEG_CUT` 距离内
   平滑过渡到 1（用 smoothstep，线性过渡会在髋部留下折痕）
2. **横向权重 `wx`**：挡住胯缝中线。只按高度算的话，两腿反向摆时中线顶点
   会被左右撕开，肚子下缘起褶

### 角度怎么混

左右腿是相反角度。若按 `x < 0 ? aL : aR` 硬分，中线处角度从 `-a` 突跳到 `+a`，
会在肚子正中撕出一条竖缝。必须按 x 位置平滑混合。

### 完整实现

```js
var skinMesh = null;
model.traverse(function (o) { if (o.isMesh && !skinMesh) skinMesh = o; });

if (skinMesh && skinMesh.geometry) {
  var pa = skinMesh.geometry.attributes.position;
  var na = skinMesh.geometry.attributes.normal;
  var bp = new Float32Array(pa.array);          // 备份原始顶点
  var bn = na ? new Float32Array(na.array) : null;
  var lastL = 1e9, lastR = 1e9;

  /* 高度一律用 h = -z（模型 raw 的 z 轴朝下：脚底 h=-0.95、头顶 h=+0.95，
     对应世界高度 y = h + 0.95）。髋部在世界 y≈0.62 → h = -0.33。
     ⚠ 这里最容易错：直接把世界坐标 0.62 当 h 用，轴心会落到头顶，
       整只身体绕脑袋甩成钟摆。 */
  var HIP_H   = -0.33;      // 髋部高度（h 单位）
  var HIP_Z   = -HIP_H;     // 枢轴在 raw z 上 = +0.33
  var LEG_CUT = 0.22;       // 髋以下多远做完 0→1 的高度权重过渡
  var ANKLE_H = -0.775;     // 踝高
  var ANKLE_Z = -ANKLE_H;
  var FOOT_FLAT = 0.55;     // 踝以下反向回转比例，让脚掌别整只翘起来
  var LEG_GAIN  = 0.80;

  player.aiLegPose = function (aL, aR) {
    if (Math.abs(aL - lastL) < 2e-4 && Math.abs(aR - lastR) < 2e-4) return;  // 没变就不重算
    lastL = aL; lastR = aR;
    var p = pa.array, n = bn ? na.array : null;

    for (var i = 0; i < p.length; i += 3) {
      var x = bp[i], y = bp[i + 1], z = bp[i + 2];
      var h = -z;
      if (h > HIP_H) { p[i] = x; p[i+1] = y; p[i+2] = z; continue; }

      // 高度权重
      var wh = (HIP_H - h) / LEG_CUT;
      if (wh > 1) wh = 1;
      wh = wh * wh * (3 - 2 * wh);

      // 横向权重：挡掉胯缝中线
      var wx = (Math.abs(x) - 0.045) / 0.085;
      if (wx <= 0) { p[i] = x; p[i+1] = y; p[i+2] = z; continue; }
      if (wx > 1) wx = 1;
      wx = wx * wx * (3 - 2 * wx);

      var w = wh * wx;
      if (w < 1e-3) { p[i] = x; p[i+1] = y; p[i+2] = z; continue; }

      // 左右角度平滑混合（0.10 / 0.20 是胯宽的一半，按模型实际宽度调）
      var mix = (x + 0.10) / 0.20;
      if (mix < 0) mix = 0; else if (mix > 1) mix = 1;
      var a = (aL * (1 - mix) + aR * mix) * w * LEG_GAIN;

      var ca = Math.cos(a), sa = Math.sin(a);
      var dy = y, dz = z - HIP_Z;
      var py = dy * ca - dz * sa;
      var pz = dy * sa + dz * ca + HIP_Z;

      // 脚掌：踝点跟随到新位置后反向转一点，脚底不会整只立起来
      if (h < ANKLE_H) {
        var fw = (ANKLE_H - h) / 0.085;
        if (fw > 1) fw = 1;
        fw = fw * fw * (3 - 2 * fw);
        var af = -a * FOOT_FLAT * fw;
        var adz = ANKLE_Z - HIP_Z;
        var ay = -adz * sa, az = adz * ca + HIP_Z;
        var fy = py - ay, fz = pz - az;
        var cf = Math.cos(af), sf = Math.sin(af);
        py = ay + fy * cf - fz * sf;
        pz = az + fy * sf + fz * cf;
        ca = Math.cos(a + af); sa = Math.sin(a + af);
      }

      p[i] = x; p[i+1] = py; p[i+2] = pz;
      if (n) {                                   // 法线同样要转，否则光照不对
        var ny = bn[i+1], nz = bn[i+2];
        n[i+1] = ny * ca - nz * sa;
        n[i+2] = ny * sa + nz * ca;
      }
    }
    pa.needsUpdate = true;
    if (na) na.needsUpdate = true;
  };
}
```

### 接入动作系统

```js
skinMesh.onBeforeRender = function () {
  var P = player.parts;
  if (!P || !P.legs) return;
  player.aiLegPose(P.legs[0].g.rotation.x, P.legs[1].g.rotation.x);
};
```

读的是动作代码已经算好的值，所以不需要改任何动作逻辑。

### 三个必查项

- [ ] 顶点、法线两个 attribute 都要写 `needsUpdate = true`
- [ ] `frustumCulled = false`（顶点变了，包围球不再可信）
- [ ] 加一个 `#legtest` 之类的手动角度开关，离线核对变形是否正常
      再进游戏，否则很难判断是权重错了还是动作错了

---

## 二、贴脸件：从模型表面抠一块

任何解析曲面贴上去都会有一端顶出脸颊（笑缝在 3D 里是弯的，前后差 8cm）。
正确做法是采样真实曲面。

### 生成流程

```python
# prep_mouth_patch.py 思路（Python 预处理，产物是一个 js 文件）
# 1. 读 GLB，取 face mesh 的 POSITION / NORMAL / 索引
# 2. 正交投影到 XZ 平面（正面视角），三角形光栅化 + z-buffer
#    → 得到 screen(u,v) -> (x,y,z,normal) 的查找表
# 3. 在 u,v 上圈一个椭圆区域（嘴的位置）
# 4. 每个像素沿法线抬 4mm，取为顶点；相邻像素连成三角形
# 5. 顶点坐标减去区域中心（变成局部坐标！见 pitfalls 3），输出 js
```

产出的 js：

```js
window.MOUTH_PATCH = {
  pos: [...],        // 局部坐标，区域中心在原点
  uv:  [...],        // 从原模型贴图上采样，保证颜色一致
  idx: [...],        // 三角形索引
  center: [0, 0.35, 0.24],   // 区域中心在模型里的位置，物体要放在这里
  normalMean: [0, 0.12, 0.99] // 区域加权平均法线
};
```

### 权重两个坑

- **法线用单像素值会被下巴带偏**：取到的是朝下的法线，抬升方向朝下，
  整个薄片沉到笑缝下面——表现为"嘴的位置偏低"。必须用**区域加权平均法线**
- **顶点必须是局部坐标**：否则 `scale.y` 做开合时，缩放绕模型原点进行，
  嘴会瞬移到肚子上

### 开合动画

```js
var g = new THREE.Group();
g.position.fromArray(MOUTH_PATCH.center);
var geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MOUTH_PATCH.pos), 3));
geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(MOUTH_PATCH.uv), 2));
geo.setIndex(MOUTH_PATCH.idx);
geo.computeVertexNormals();
g.add(new THREE.Mesh(geo, mouthMat));

function setMouthOpen(v) {          // v: 0 闭 → 1 张
  g.scale.y = 0.12 + v * 0.88;      // 压扁就是闭嘴，别改 position
  g.visible = v > 0.02;
}
```

---

## 三、坐标反查：定位"屏幕上看到的东西对应模型哪里"

这个工具能把"嘴看起来偏低"从感觉变成数字。改造完成后可以删掉，但排查期必备。

原理：正交投影 + 三角形光栅化 + z-buffer，得到 `像素 → 曲面点` 的映射；
再把结果叠一张坐标网格打印出来，直接读数字。

```js
// 正交投影到 XZ（正面视角），返回查找表
function buildFrontMap(mesh, W, H, size) {
  var pos = mesh.geometry.attributes.position.array;
  var idx = mesh.geometry.index.array;
  var z = new Float32Array(W * H).fill(-1e9);     // z-buffer
  var map = new Array(W * H);                     // 每个像素对应的模型坐标
  var s = size / W;                               // 每像素对应的模型长度

  for (var t = 0; t < idx.length; t += 3) {
    var P = [];
    for (var k = 0; k < 3; k++) {
      var i = idx[t + k] * 3;
      P.push([
        (pos[i]     / s) + W / 2,                 // 屏幕 x
        (-pos[i + 2] / s) + H / 2,                // 屏幕 y：模型 z 朝下 → 取负
        pos[i + 1]                                // 深度：模型 y 朝后，越大越远
      ]);
    }
    // 光栅化这个三角形（略：标准重心坐标填充）
    // 对每个像素：插值深度，若 > z-buffer 则更新 z[i] 和 map[i]
  }
  return map;
}
```

用它回答三类问题：

- "贴图里眼睛到底在哪" → 在图上量像素，查 map 拿模型坐标
  （实测才发现双眼在 x=−0.211 / +0.038，不是对称的 ±0.132）
- "这块颜色对应模型的哪个部位" → 反向查
- "嘴的理想高度是多少" → 在图上找准位置，读 y

**别用截图反推坐标**：截图取景每次不同，贴图烘焙的阴影还会干扰判读，
同一个部位两次测出不同数字。光栅化的结果和模型局部坐标是一一对应的，可复现。

---

## 四、接进游戏的顺序建议

1. 先用**已有模型**把 `glbActor` 全链路跑通（缩放、对齐、碰撞、兜底）
2. 再等新模型生成 —— 生成期间不阻塞开发
3. 新模型到位后只改一行参数（`h` 和碰撞盒），其余逻辑不动
4. 每次替换都保留 `USE_GLB_ACTORS` 开关，出问题能一键回退

不要在链路没验证的情况下等一堆生成任务，等回来了才发现接不进去。
