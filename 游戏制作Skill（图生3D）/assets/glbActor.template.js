/* glbActor.template.js —— 把内嵌的 base64 模型接进游戏的参考实现
 *
 * 用法：把下面这段整体粘进你的游戏代码，改掉 GLB_ACTOR_CACHE 的声明位置即可。
 * 前提：已引入 three 与 assets/glb-lite.js，且模型 js 已用 <script> 引入
 *       （window.ACTOR_名字 = "<base64>"，由 prep_actor.py 生成）。
 *
 * 设计要点（每一条都踩过坑，别删）：
 *   1. 解析结果按 jsVar 缓存原型，每次 clone(true)
 *      —— 重复解析 = 重复解码贴图，一屏十几个角色直接卡死
 *   2. 按目标身高 h 缩放，而不是写死 scale
 *      —— 同一批模型尺寸能差 2 倍
 *   3. position.y = -min.y * k 把脚底压到 y=0
 *      —— 忘了这行，模型半截埋地或整体悬空
 *   4. 碰撞盒允许外部覆盖 (hx/hz/hitH)
 *      —— 旧手写模型的判定通常比视觉宽得多；改用视觉包围盒会导致
 *         "擦身而过不算撞"，手感直接崩
 *   5. 解析失败返回 null
 *      —— 调用方必须有 fallback 到旧模型的路径，否则模型没生成出来游戏就白屏
 *   6. frustumCulled = false
 *      —— 伪骨骼会改顶点，包围球不再可信，跑出屏幕就整只消失
 */

var GLB_ACTOR_CACHE = {};          // jsVar -> { obj, minY, halfX, halfZ, h }

/**
 * 用内嵌 GLB 构建一个角色实例。
 * @param {string} jsVar  window 上的变量名，如 'ACTOR_NAILONG'
 * @param {object} opt    { h, w, yaw, hitH, hx, hz, hitK, name }
 *                        h = 目标身高（站姿模型用）
 *                        w = 目标全宽（趴姿/横长模型用，优先于 h）
 * @returns {{obj: THREE.Group, hit: object, name: string} | null}
 */
function glbActor(jsVar, opt) {
  opt = opt || {};
  var b64 = window[jsVar];
  if (!b64 || !window.GLBLite) return null;          // 兜底：让调用方走旧模型

  var proto = GLB_ACTOR_CACHE[jsVar];
  if (!proto) {
    var m;
    try {
      m = GLBLite.loadB64(b64, function () {});
    } catch (e) {
      console.warn('[actor] 解析失败 ' + jsVar, e);
      return null;
    }
    m.traverse(function (o) {
      if (o.isMesh && o.material) {
        // 生成出来的贴图偏塑料，压一点高光更像手绘
        o.material.shininess = 4;
        o.material.specular = new THREE.Color(0x241E14);
        o.frustumCulled = false;
      }
    });
    m.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(m);
    proto = {
      obj: m,
      minY: box.min.y,
      halfX: (box.max.x - box.min.x) * 0.5,
      halfZ: (box.max.z - box.min.z) * 0.5,
      h: box.max.y - box.min.y
    };
    GLB_ACTOR_CACHE[jsVar] = proto;
  }

  var H = opt.h || 1.6;
  var k;
  if (opt.w) {
    // 按「目标全宽」定标。趴姿 / 横长的模型必须走这条：
    // 这类模型宽是高的 1.6 倍以上，按身高缩放会把宽度一起放大成一团趴地蒲团。
    k = opt.w / Math.max(proto.halfX * 2, 1e-4);
    H = proto.h * k;                                 // 身高由宽度反推
  } else {
    k = H / Math.max(proto.h, 1e-4);                 // 注意：模型可能是 Z-up，
                                                     // 那就换成 halfX/halfZ 里
                                                     // 正确的那个轴，见 prep 报告
  }
  var g = new THREE.Group();
  var inst = proto.obj.clone(true);
  inst.scale.setScalar(k);
  inst.position.y = -proto.minY * k;                 // 脚底对齐 y=0
  if (opt.yaw) inst.rotation.y = opt.yaw;
  g.add(inst);

  var hk = opt.hitK || 1;
  var hx = opt.hx !== undefined ? opt.hx : proto.halfX * k * hk;
  var hz = opt.hz !== undefined ? opt.hz : proto.halfZ * k * hk;
  if (opt.yaw && Math.abs(Math.sin(opt.yaw)) > 0.5) { // 转了 90° 就交换宽深
    var t = hx; hx = hz; hz = t;
  }

  return {
    obj: g,
    hit: {
      y0: 0,
      y1: opt.hitH || H * 0.92,
      hx: Math.max(hx, 0.3),                         // 太小的盒子会判定漏掉
      hz: Math.max(hz, 0.3)
    },
    name: opt.name || ''
  };
}

/* ---------------- 调用示例 ----------------
 *
 * // 障碍物：模型缺失时回退到手写版本
 * OB.bun = function () {
 *   if (USE_GLB_ACTORS) {
 *     var a = glbActor('ACTOR_DOUBAO', {
 *       h: 1.49, hitH: 1.47, hx: 0.66, hz: 0.88, name: '豆包'
 *     });
 *     if (a) return a;
 *   }
 *   return buildBunOld();        // 原来的手写几何体，一行都不用删
 * };
 *
 * // 收集物：换成有脸的模型后别再 360° 旋转（像展示台），改摆头 + 浮动
 * var egg = glbActor('ACTOR_NAILONG', { h: 0.62, name: '奶龙' });
 * egg.obj.userData.tick = function (t) {
 *   egg.obj.rotation.y = Math.sin(t * 2.2) * 0.55;   // 摆头
 *   egg.obj.position.y = Math.sin(t * 3.0) * 0.06;   // 浮
 * };
 */
