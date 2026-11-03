/* =========================================================
   奶蛙快跑 · 3D 追尾视角无限跑酷
   three.js r150 (本地 lib/three.min.js)
   ========================================================= */
(function () {
  'use strict';
  var T = window.THREE;

  /* ---------------- 基础工具 ---------------- */
  var rand = function (a, b) { return a + Math.random() * (b - a); };
  var randInt = function (a, b) { return Math.floor(a + Math.random() * (b - a + 1)); };
  var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var pick = function (arr) { return arr[(Math.random() * arr.length) | 0]; };

  var MAT = new Map();
  function mat(color, opts) {
    var key = color + '|' + (opts ? JSON.stringify(opts) : '');
    var m = MAT.get(key);
    if (!m) { m = new T.MeshLambertMaterial(Object.assign({ color: color }, opts || {})); MAT.set(key, m); }
    return m;
  }
  var MATB = new Map();
  function matB(color, opacity) {
    var key = 'b' + color + '_' + opacity;
    var m = MATB.get(key);
    if (!m) { m = new T.MeshBasicMaterial({ color: color, transparent: opacity < 1, opacity: opacity, depthWrite: opacity >= 1 }); MATB.set(key, m); }
    return m;
  }
  var GEO = new Map();
  function geo(key, fn) {
    var g = GEO.get(key);
    if (!g) { g = fn(); GEO.set(key, g); }
    return g;
  }
  function sphereGeo(r, w, h) { return geo('s' + r + '_' + w + '_' + h, function () { return new T.SphereGeometry(r, w || 12, h || 9); }); }
  function boxGeo(w, h, d) { return geo('b' + w + '_' + h + '_' + d, function () { return new T.BoxGeometry(w, h, d); }); }
  function cylGeo(rt, rb, h, s) { return geo('c' + rt + '_' + rb + '_' + h + '_' + (s || 10), function () { return new T.CylinderGeometry(rt, rb, h, s || 10); }); }
  function coneGeo(r, h, s) { return geo('k' + r + '_' + h + '_' + (s || 8), function () { return new T.ConeGeometry(r, h, s || 8); }); }
  function torusGeo(r, t, s) { return geo('t' + r + '_' + t + '_' + (s || 8), function () { return new T.TorusGeometry(r, t, 8, s || 16); }); }
  function capGeo(theta, seg) { return geo('p' + theta + '_' + (seg || 24), function () { return new T.SphereGeometry(1, seg || 24, 12, 0, Math.PI * 2, 0, theta); }); }

  // 超椭球（"方球"）：|x|^n + |y|^n + |z|^n = 1。
  // 手掌不能拿球堆：球的顶部会收成一个尖（手指就成了从球顶戳出来的四根角），
  // 拿两三颗球叠又会在接缝处留一圈横向凹沟（像汉堡）。一颗超椭球同时解决两者：
  // n=2 是球，n 越大越方 —— 用 3.2 就得到"平顶、直边、圆角"的掌。
  // topK：顶部相对底部再放宽一点，做出"腕窄指宽"的梯形。
  function boxBall(sx, sy, sz, n, topK, wseg, hseg) {
    var g = new T.SphereGeometry(1, wseg || 22, hseg || 16);
    var p = g.attributes.position, v = new T.Vector3();
    for (var i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      var t = Math.pow(Math.pow(Math.abs(v.x), n) + Math.pow(Math.abs(v.y), n) +
                       Math.pow(Math.abs(v.z), n), -1 / n);
      var k = 1 + (topK || 0) * v.y;          // v.y ∈ [-1,1]
      p.setXYZ(i, v.x * t * sx * k, v.y * t * sy, v.z * t * sz);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }

  // 平底球：把超椭球的下半截**钳平**（y < yCut 的顶点全部搬到 yCut）。
  // 用球压扁做脚掌，底面是一段弧 —— 从下往上看是个蛋：
  // 跳跃时能看到悬空的弧底，落地也只有正中间一小块真正受力。
  // 钳位不会破坏封闭性（下半被压成一个圆盘），所以不需要任何补面。
  function soleBall(sx, sy, sz, n, yCut, wseg, hseg) {
    var g = boxBall(sx, sy, sz, n, 0, wseg, hseg);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      if (p.getY(i) < yCut) p.setY(i, yCut);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }

  // 沿样条放样一根**粗细可变**的管。
  // THREE.TubeGeometry 的半径是常量 —— 用它做手臂，上臂和前臂一样粗、肘和腕一样粗，
  // 远看就是两根等粗的香肠挂在肩上。人类手臂的截面是：
  //   肩(最粗) → 上臂中(略收) → 肘(明显收) → 前臂中段(微微回鼓) → 腕(最细)。
  // 这里用 Frenet 标架逐环生成，半径由 rFn(t) 给出。
  function taperTube(cv, rFn, tSeg, rSeg) {
    var fr = cv.computeFrenetFrames(tSeg, false);
    var pos = [], nor = [], uvs = [], idx = [];
    var P = new T.Vector3(), N = new T.Vector3(), Bv = new T.Vector3(), n = new T.Vector3();
    var i, j;
    for (i = 0; i <= tSeg; i++) {
      var t = i / tSeg;
      cv.getPointAt(t, P);
      N.copy(fr.normals[i]); Bv.copy(fr.binormals[i]);
      var r = rFn(t);
      for (j = 0; j <= rSeg; j++) {
        var a = j / rSeg * Math.PI * 2, si = Math.sin(a), co = -Math.cos(a);
        n.copy(N).multiplyScalar(co).addScaledVector(Bv, si).normalize();
        pos.push(P.x + r * n.x, P.y + r * n.y, P.z + r * n.z);
        nor.push(n.x, n.y, n.z);
        uvs.push(t, j / rSeg);
      }
    }
    for (i = 1; i <= tSeg; i++) {
      for (j = 1; j <= rSeg; j++) {
        var a1 = (rSeg + 1) * (i - 1) + (j - 1), b1 = (rSeg + 1) * i + (j - 1);
        var c1 = (rSeg + 1) * i + j, d1 = (rSeg + 1) * (i - 1) + j;
        idx.push(a1, b1, d1, b1, c1, d1);
      }
    }
    var g = new T.BufferGeometry();
    g.setIndex(idx);
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
    return g;
  }

  function mesh(g, m, x, y, z, sx, sy, sz) {
    var o = new T.Mesh(g, m);
    o.position.set(x || 0, y || 0, z || 0);
    if (sx !== undefined) o.scale.set(sx, sy === undefined ? sx : sy, sz === undefined ? sx : sz);
    return o;
  }

  /* ---------------- 配置 ---------------- */
  var CFG = {
    LANES: [-1.95, 0, 1.95],
    BASE_SPEED: 12.5,
    MAX_SPEED: 23.5,
    RAMP: 1100,
    // 跳跃。最高点 = V²/(2G) = 1.80 米，滞空 = 2V/G = 1.01 秒，离散实测峰值 1.742。
    //
    // ▍为什么这次能过而前四次不能（把教训写死，别再回到老路上）
    //   第 1~3 版：盯着「容错有几米」。误导 —— 1.15 米听着不少，除以 12.5 的速度
    //               只有 0.09 秒，人手做不到。
    //   第 4 版：改成看「窗口几秒」，脑子是对的，但手段选错了：既不敢压判定顶
    //           （怕穿模）、也不敢抬跳跃上限（牛来只有 1.96 高，判定顶 1.88，
    //           峰值必须压在 1.80 以下），于是只能在两头各让一点，最后停在 0.34 秒。
    //   第 5 版：承认**一味抬高抛物线是死路**，改从根上下手 ——
    //           ① 可跳的东西就做成矮的。豆包按 1.05 米重定尺寸，它本来就是矮个设定。
    //           ② 判定顶写成真实可用高度而不是模型全高（刀盾趴姿 1.63 里有半米是
    //              举起的刀和盾，那部分不该挡路）。
    //           ③ 起跳手感补两块：土狼时间 + 跳跃缓冲，按早按晚都不吞输入。
    //           结果：窗口从 0.34 秒 → 0.65 秒以上，接近翻倍，而且满足这个类 QED 直觉：
    //           「我跳起来了，就该能过矮东西」。
    //
    // 峰值上限 1.80 仍然不能抬：牛来 1.88、噜噜 1.90、猪猪侠 1.98、奶牛 2.00 都要跳不过。
    JUMP_V: 7.1,
    GRAVITY: 14,
    // 土狼时间：脚离开地面后这点时间里仍能起跳（防止"明明按了却没跳"）
    COYOTE: 0.10,
    // 跳跃缓冲：落地前这点时间内按下 jump，落地瞬间自动兑现（防止"按早了没反应"）
    JUMP_BUFFER: 0.13,
    DUCK_TIME: 0.62,
    SPAWN_Z: -80,
    DESPAWN_Z: 26,
    THEME_LEN: 520,
    EGG_SCORE: 10
  };
  // halfX 跟着新体宽走（躯干最宽半径 0.707 → 判定 0.58，比视觉略窄一点，手感更宽容）
  var HIT = { standH: 1.45, duckH: 0.92, halfX: 0.58, halfZ: 0.46 };

  // 越线容差：可跳障碍允许脚底比判定顶再低 6 厘米就算越过。
  // 以前写的是「判定顶 × 0.95」这种百分比折扣，毛病在于——障碍越矮，省下来的绝对高度
  // 越少；真正卡人的高个障碍反而几乎没吃到折扣。6 厘米是固定的，对所有角色一视同仁，
  // 而且 6 厘米在第三人称视角里基本看不出来。
  // 这条**只对 OB_JUMPABLE 里标了 true 的角色生效**，不可跳的仍要求脚底真高过判定顶。
  var JUMP_CLEAR_EPS = 0.06;

  // 个别角色的判定深度可以单独覆盖（刀盾是趴姿、纵向 1.44 米长，跳它要「在它上方待更久」，
  // 深度直接决定窗口宽度）。留成表是为了能配合 #simtest&shz= 扫描，不用改源文件反复试。
  var OB_HZ = {};

  /* ---------------- DOM ---------------- */
  var dom = {
    canvas: document.getElementById('game'),
    hud: document.getElementById('hud'),
    score: document.getElementById('scoreVal'),
    egg: document.getElementById('eggVal'),
    toast: document.getElementById('toast'),
    intro: document.getElementById('introScreen'),
    start: document.getElementById('startScreen'),
    over: document.getElementById('overScreen'),
    ad: document.getElementById('adScreen'),
    adCount: document.getElementById('adCount'),
    adRing: document.getElementById('adRing'),
    adBar: document.getElementById('adBar'),
    finalScore: document.getElementById('finalScore'),
    finalEgg: document.getElementById('finalEgg'),
    best: document.getElementById('bestScore'),
    overTip: document.getElementById('overTip'),
    btnStart: document.getElementById('btnStart'),
    btnRevive: document.getElementById('btnRevive'),
    btnRestart: document.getElementById('btnRestart'),
    bgm: document.getElementById('bgm'),
    laugh: document.getElementById('laugh')
  };

  /* ---------------- 状态 ---------------- */
  var G = {
    phase: 'ready',      // ready | playing | dying | ad | over
    distance: 0,
    eggs: 0,
    score: 0,
    speed: CFG.BASE_SPEED,
    worldSpeed: 0,
    t: 0,
    introT: 0,
    theme: 0,
    nextSpawn: 45,
    nextThemeAt: 520,
    reviveUsed: false,
    invT: 0,
    boostT: 0,
    magnetT: 0,
    shake: 0,
    best: (function () { try { return parseInt(localStorage.getItem('naiwa_best') || '0', 10) || 0; } catch (e) { return 0; } })()
  };

  var player = {
    root: null, frog: null, bubble: null, shadow: null, parts: null,
    lane: 1, x: 0, y: 0, vy: 0, grounded: true,
    coyoteT: 0, jumpBufT: 0,            // 土狼剩余时间 / 跳跃缓冲剩余时间
    duckT: 0, duckKey: false, lean: 0, bob: 0, blink: 0
  };

  var entities = [];   // 障碍 / 奶龙 / buff
  var themeSets = [];  // 每个场景的装饰物
  var dashes = [], details = [];

  /* ---------------- 渲染器 / 场景 ---------------- */
  var renderer = new T.WebGLRenderer({ canvas: dom.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  // 移动端 GPU 可能主动丢弃 WebGL 上下文（后台切换、显存紧张），
  // 不接管的话画面会停在最后一帧或者整屏发黑。丢过一次就重载页面。
  dom.canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
  }, false);
  dom.canvas.addEventListener('webglcontextrestored', function () {
    try { location.reload(); } catch (err) { }
  }, false);

  var scene = new T.Scene();
  var camera = new T.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.1, 260);
  camera.position.set(0, 5.0, 9.15);

  var hemi = new T.HemisphereLight(0xFFFFFF, 0xC7D0BE, 0.72);
  scene.add(hemi);
  var sun = new T.DirectionalLight(0xFFFFFF, 0.5);
  sun.position.set(6, 14, 8);
  scene.add(sun);

  /* ---------------- 场景配色 ---------------- */
  var THEMES = [
    {
      name: '城市街道', sky: 0xBFE6F5, fog: 0xBFE6F5, ground: 0xB4C6BF, road: 0x868F94,
      curb: 0xEEF3F5, detail: 0xAEC0C4
    },
    {
      name: '草地森林', sky: 0xCDEDD9, fog: 0xCDEDD9, ground: 0x86CE74, road: 0xD3A876,
      curb: 0xF6EAD0, detail: 0x6FBF62
    },
    {
      name: '云端糖果', sky: 0xFFD6EC, fog: 0xFFD6EC, ground: 0xFFE8F4, road: 0xF5A0C8,
      curb: 0xFFB8D8, detail: 0xFF9CC8
    }
  ];

  /* ---------------- 地面 ---------------- */
  var groundMat = new T.MeshLambertMaterial({ color: THEMES[0].ground });
  var roadMat = new T.MeshLambertMaterial({ color: THEMES[0].road });
  var curbMat = new T.MeshLambertMaterial({ color: THEMES[0].curb });
  var detailMat = new T.MeshLambertMaterial({ color: THEMES[0].detail });

  var groundPlane = new T.Mesh(new T.PlaneGeometry(120, 460), groundMat);
  groundPlane.rotation.x = -Math.PI / 2;
  groundPlane.position.set(0, -0.02, -200);
  scene.add(groundPlane);

  var roadPlane = new T.Mesh(new T.PlaneGeometry(7.8, 460), roadMat);
  roadPlane.rotation.x = -Math.PI / 2;
  roadPlane.position.set(0, 0.005, -200);
  scene.add(roadPlane);

  [-4.0, 4.0].forEach(function (x) {
    var curb = new T.Mesh(boxGeo(0.42, 0.24, 460), curbMat);
    curb.position.set(x, 0.1, -200);
    scene.add(curb);
  });

  // 车道虚线
  (function buildDashes() {
    var g = new T.PlaneGeometry(0.12, 1.5);
    var m = new T.MeshBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.55 });
    for (var side = -1; side <= 1; side += 2) {
      for (var i = 0; i < 12; i++) {
        var d = new T.Mesh(g, m);
        d.rotation.x = -Math.PI / 2;
        d.position.set(side * 1.02, 0.012, 24 - i * 12);
        scene.add(d);
        dashes.push(d);
      }
    }
  })();

  // 地面碎点
  (function buildDetails() {
    for (var i = 0; i < 22; i++) {
      var o = new T.Mesh(sphereGeo(0.22, 8, 6), detailMat);
      var side = Math.random() < 0.5 ? -1 : 1;
      o.position.set(side * rand(4.6, 20), 0.05, 24 - i * 12);
      o.scale.set(rand(0.6, 1.4), rand(0.2, 0.45), rand(0.6, 1.4));
      scene.add(o);
      details.push(o);
    }
  })();

  /* ---------------- 场景装饰物 ---------------- */
  function propCity() {
    var g = new T.Group();
    var colors = [0xF7E7C8, 0xF9D9E0, 0xD9EDF5, 0xE6F3DC, 0xF3E7F8, 0xFFF0D3];
    var h = rand(5, 13), w = rand(2.4, 4), d = rand(2.2, 4);
    var c = pick(colors);
    var b = mesh(boxGeo(w, h, d), mat(c), 0, h / 2, 0);
    g.add(b);
    g.add(mesh(boxGeo(w * 1.08, 0.32, d * 1.08), mat(0xFFFFFF), 0, h + 0.16, 0));
    var win = mat(0x9FDDEE, { emissive: 0x2E7C99, emissiveIntensity: 0.22 });
    var rows = Math.min(4, Math.floor(h / 2.4));
    for (var i = 0; i < rows; i++) {
      for (var j = -1; j <= 1; j += 2) {
        g.add(mesh(boxGeo(0.62, 0.7, 0.08), win, j * w * 0.24, 1.5 + i * 2.1, d / 2 + 0.03));
      }
    }
    return g;
  }

  function propForest() {
    var g = new T.Group();
    var s = rand(0.85, 1.5);
    g.add(mesh(cylGeo(0.16, 0.22, 2.2, 6), mat(0xB9885A), 0, 1.1, 0));
    g.add(mesh(sphereGeo(1.25, 10, 8), mat(0x74C96A), 0, 2.6, 0, 1, 0.95, 1));
    g.add(mesh(sphereGeo(0.85, 9, 7), mat(0x8CDB7E), -0.55, 3.1, 0.2));
    g.add(mesh(sphereGeo(0.7, 9, 7), mat(0x67BE60), 0.6, 2.9, -0.15));
    if (Math.random() < 0.6) {
      g.add(mesh(sphereGeo(0.28, 8, 6), mat(pick([0xFFB3C8, 0xFFE07A, 0xFFFFFF])), 0.75, 1.9, 0.55));
    }
    g.scale.setScalar(s);
    return g;
  }

  function propCandy() {
    var g = new T.Group();
    var r = Math.random();
    if (r < 0.45) {
      // 棒棒糖
      g.add(mesh(cylGeo(0.07, 0.07, 3.4, 6), mat(0xFFFFFF), 0, 1.7, 0));
      var disc = mesh(cylGeo(1.05, 1.05, 0.3, 22), mat(pick([0xFFC2DE, 0xBDE8FF, 0xFFF0A8])), 0, 3.6, 0);
      disc.rotation.x = Math.PI / 2;
      disc.rotation.z = rand(0, 6);
      g.add(disc);
      var ring = mesh(torusGeo(0.62, 0.12, 20), mat(0xFFFFFF), 0, 3.6, 0.18);
      g.add(ring);
      var ring2 = mesh(torusGeo(0.3, 0.1, 16), mat(0xFFFFFF), 0, 3.6, 0.2);
      g.add(ring2);
    } else if (r < 0.78) {
      // 拐杖糖
      var cane = mesh(cylGeo(0.16, 0.16, 3.2, 8), mat(0xFF8FB4), 0, 1.6, 0);
      g.add(cane);
      for (var i = 0; i < 4; i++) {
        var ring2 = mesh(torusGeo(0.19, 0.05, 10), mat(0xFFFFFF), 0, 0.5 + i * 0.75, 0);
        ring2.rotation.x = Math.PI / 2;
        g.add(ring2);
      }
      g.add(mesh(sphereGeo(0.24, 10, 8), mat(0xFF8FB4), 0, 3.22, 0));
    } else {
      // 云朵
      var cloud = new T.Group();
      cloud.add(mesh(sphereGeo(1.0, 10, 8), mat(0xFFFFFF), 0, 0, 0, 1.3, 0.8, 1));
      cloud.add(mesh(sphereGeo(0.8, 10, 8), mat(0xFFFFFF), 1.0, -0.1, 0.1, 1.1, 0.75, 1));
      cloud.add(mesh(sphereGeo(0.7, 10, 8), mat(0xFFFFFF), -1.0, -0.15, -0.05, 1.1, 0.7, 1));
      cloud.position.y = rand(5.5, 8.5);
      g.add(cloud);
    }
    return g;
  }

  var PROP_BUILDERS = [propCity, propForest, propCandy];

  (function buildPropSets() {
    for (var ti = 0; ti < 3; ti++) {
      var group = new T.Group();
      var items = [];
      for (var i = 0; i < 16; i++) {
        var side = i % 2 === 0 ? -1 : 1;
        var obj = PROP_BUILDERS[ti]();
        var x = side * rand(5.6, 13);
        obj.position.set(x, 0, 20 - i * 15);
        if (ti === 2 && obj.children.length === 1) obj.position.y = 0;
        group.add(obj);
        items.push({ obj: obj, z: 20 - i * 15, side: side });
      }
      group.visible = (ti === 0);
      scene.add(group);
      themeSets.push({ group: group, items: items });
    }
  })();

  /* ---------------- 主角：奶蛙（立体版） ---------------- */
  // 胶囊肢：一根圆柱 + 两端球，接缝处半径一致，不会有「香肠节」感
  function capsule(ax, ay, az, bx, by, bz, r, m) {
    var g = new T.Group();
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
    var cyl = new T.Mesh(cylGeo(r, r, len, 16), m);
    cyl.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    cyl.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), new T.Vector3(dx / len, dy / len, dz / len));
    g.add(cyl);
    g.add(mesh(sphereGeo(r, 16, 12), m, ax, ay, az));
    g.add(mesh(sphereGeo(r, 16, 12), m, bx, by, bz));
    return g;
  }

  // ================= 主角：奶蛙（对照 res/奶蛙照片.jpg 还原） =================
  // 参考图是 474x559，主体占 434px 高、274px 宽。三条从像素里量出来、
  // 之前全都做反了的事实：
  //   1. **没有腰、没有脖子**。从头顶到肚子，轮廓是**单调外扩**的一条梨形曲线，
  //      整条轮廓上不存在任何局部收窄。之前做的"收腰 28% + 细颈 0.324"是另一个物种。
  //   2. **头是嵌在肩膀里的**。头半径 0.336、肩 0.545、躯干最宽 0.691 ——
  //      头只有躯干的 49%（之前 0.353/0.500 = 71%，所以怎么看都像柱子）。
  //   3. **没有喙**。脸基本是平的，嘴只是一条细横线；真正凸出来的是**两个眼包**。
  // 颜色也不是橙系：主体是偏绿调的奶黄 #DDD975 → #D1AD5B，手脚是橄榄褐。

  var BODY_Y = 0.560;         // 躯干底（裆部）离地：腿露出 0.56
  var BODY_H = 1.739;         // 躯干自身高度 → 总高 2.30（root.scale 0.98 后约 2.25）
  var BODY_LIFT = 0.0;

  // 侧影：[半径, 相对躯干底的高度]。
  // 这张表是拿参考图**逐行扫描**出来的（474x559 的图，主体 434px 高、左右中心 x=179），
  // 每一行的左右边界都换算成半径，所以它不是"设计"出来的，是量出来的：
  //
  //   y=146 → rel 1.31 → 半宽 62.5px → r 0.331   ← 头两侧
  //   y=156 → rel 1.26 → 65          → 0.344
  //   y=176 → rel 1.16 → 78.5        → 0.416   ← 下颌开始外扩
  //   y=196 → rel 1.05 → 100         → 0.530   ← 肩
  //   y=286 → rel 0.57 → 137         → 0.726   ← 肚子最宽
  //
  // 两个"反直觉但就是事实"的点：
  //   · **头的两侧几乎平行**（rel 1.31→1.53，r 从 0.331 只掉到 0.315），
  //     它是"上端圆弧的竖长圆角柱"，不是球。做成球就会像保龄球瓶。
  //   · **整条轮廓没有任何局部极小** —— 没有腰，也没有脖子。
  var BODY_PROF = [
    // 底部：早先 [0,−0.012] → [0.148, 0.002]，0.014 的高度里半径从 0 拉到 0.148，
    // 等于给肚子加了一个半径 0.148 的平盘，正面和侧面都会看见一圈"裙边"折痕。
    // 改成一条斜率均匀递减的圆弧，底点埋到 −0.034（被两腿夹住看不见）。
    [0.000, -0.034], [0.076, -0.027], [0.146, -0.008], [0.212, 0.020],
    [0.288, 0.054], [0.368, 0.094], [0.440, 0.136], [0.500, 0.180],
    [0.550, 0.226], [0.592, 0.274], [0.628, 0.324], [0.660, 0.376],
    [0.684, 0.428], [0.700, 0.482], [0.706, 0.536], [0.708, 0.588],
    [0.709, 0.632], [0.706, 0.690], [0.702, 0.750],
    // ↓ 溜肩：参考图头两侧只有 0.33 宽，肩膀 0.55，0.20 的高度里收掉 0.20 的半径。
    //   早先这里是 0.44，头就顶在一根细颈上像花瓶；头"显小"其实是肩太窄的错觉。
    //   斜率从 0.34 一路加到 1.15 再减回 0.7，中途没有折角。
    [0.692, 0.805], [0.674, 0.860], [0.652, 0.910], [0.626, 0.952],
    [0.600, 0.988], [0.570, 1.022], [0.534, 1.056], [0.494, 1.090],
    [0.453, 1.124], [0.414, 1.158], [0.381, 1.192], [0.357, 1.226],
    [0.342, 1.260], [0.331, 1.292],
    // ↓ 头：腮 0.323 → 侧壁 0.317（这一段几乎垂直，就是参考图里"方头"的来源）→ 圆顶
    [0.323, 1.350], [0.319, 1.400], [0.3175, 1.440], [0.316, 1.470],
    [0.305, 1.497], [0.292, 1.534], [0.282, 1.570], [0.272, 1.598],
    [0.263, 1.620], [0.249, 1.650], [0.222, 1.675], [0.196, 1.695],
    [0.168, 1.710], [0.128, 1.726], [0.075, 1.740], [0.000, 1.752]
  ];

  // 侧影点太稀，Lathe 表面会出现一圈圈横向硬边；用 Catmull-Rom 重采样到 85 点
  (function resampleProfile() {
    var src = BODY_PROF;
    var P = [src[0]].concat(src, [src[src.length - 1]]);
    var segs = src.length - 1, N = 85, out = [];
    function cr(p0, p1, p2, p3, u) {
      var u2 = u * u, u3 = u2 * u;
      return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
    }
    for (var i = 0; i < N; i++) {
      var t = i / (N - 1) * segs;
      var k = Math.min(Math.floor(t), segs - 1);
      var u = t - k;
      var p0 = P[k], p1 = P[k + 1], p2 = P[k + 2], p3 = P[k + 3];
      out.push([Math.max(0, cr(p0[0], p1[0], p2[0], p3[0], u)), cr(p0[1], p1[1], p2[1], p3[1], u)]);
    }
    BODY_PROF = out;
  })();

  // 某一高度处的身体半径（线性插值）
  function bodyRadius(yw) {
    var y = yw - BODY_Y, P = BODY_PROF, i;
    if (y <= P[0][1]) return P[0][0];
    for (i = 1; i < P.length; i++) {
      if (y <= P[i][1]) {
        var d = P[i][1] - P[i - 1][1];
        return lerp(P[i - 1][0], P[i][0], d > 0.0001 ? (y - P[i - 1][1]) / d : 0);
      }
    }
    return 0;
  }

  function smoothstep(a, b, x) {
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  // 面部的轻微前凸（**不是喙**）。参考图侧脸几乎是一条平滑的弧：
  // 从额头下来只有一点点"口鼻"鼓起，然后收向下巴。量出来幅度约 0.05，
  // 之前那个前伸 0.170 的尖喙是照着另一张图做的，跟这张完全不是一回事。
  var FACE_Y = 1.880;         // 口鼻隆起中心的高度（= 眼睛下方一点）
  var FACE_A = 0.054;         // 前伸量
  function faceBump(x, yw) {
    var dy = yw - FACE_Y;
    var ey = dy > 0 ? Math.exp(-dy / 0.235) : Math.exp(dy / 0.165);
    var t = Math.abs(x) / 0.300;
    if (t > 1.9) return 0;
    return FACE_A * ey * Math.exp(-Math.pow(t, 2.2));
  }

  // 腹部前凸：参考图肚子往前鼓得很明显（侧影上"肚子比后背突出"）
  var BELLY_BULGE = 0.155;
  function bellyZ(yw) {
    // 中心跟着剖面最宽处走（rel 0.36 → abs 0.92），σ 0.345
    return BELLY_BULGE * Math.exp(-Math.pow((yw - 0.955) / 0.345, 2));
  }

  // 脸部曲面：给定 x 与高度，返回正面的 z（面部隆 + 腹部前凸都要算，
  // 否则嘴的下半部分会被肚子"吞"进去）
  function faceZ(x, yw) {
    var r = bodyRadius(yw);
    return 0.996 * Math.sqrt(Math.max(0.0002, r * r - x * x)) + faceBump(x, yw) + bellyZ(yw);
  }

  var BODY_SEG = 168;         // 圆周分段；肚皮柔和边界与眼包交线都靠它压平

  function buildBodyGeo() {
    var pts = BODY_PROF.map(function (p) { return new T.Vector2(p[0], p[1] + BODY_Y); });
    // phiStart 转 180°：Lathe 的接缝默认落在 +Z，正对镜头会看到一条贯穿全身的竖线，
    // 转到身后就看不见了（位移与顶点色都按实际坐标算，不受影响）
    var g = new T.LatheGeometry(pts, BODY_SEG, Math.PI, Math.PI * 2);
    var pos = g.attributes.position;
    var v = new T.Vector3();
    var i, j;

    for (i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      var front = Math.max(0, Math.cos(Math.atan2(v.x, v.z)));
      // 只推正面（front→1）。只按 |x| 衰减的话，后脑勺的 x 也接近 0，会跟着一起鼓出去
      v.z += faceBump(v.x, v.y) * smoothstep(0.06, 0.60, front);
      // 腹部往前鼓、后背略收平 —— 侧面才是"肚子鼓、后背直"的梨形，而不是一颗直立的蛋
      var bf = bellyZ(v.y) / BELLY_BULGE;
      v.z += BELLY_BULGE * bf * Math.pow(front, 2.4);
      var back = Math.max(0, -Math.cos(Math.atan2(v.x, v.z)));
      v.z += -0.012 * bf * Math.pow(back, 2.4);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();

    // 接缝两侧法线取平均，去掉正面那道竖向亮线
    var nrm = g.attributes.normal, M = pts.length, SEG = BODY_SEG;
    for (j = 0; j < M; j++) {
      var i1 = j, i2 = SEG * M + j;
      var nx = (nrm.getX(i1) + nrm.getX(i2)) * 0.5;
      var ny = (nrm.getY(i1) + nrm.getY(i2)) * 0.5;
      var nz = (nrm.getZ(i1) + nrm.getZ(i2)) * 0.5;
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nrm.setXYZ(i1, nx / l, ny / l, nz / l);
      nrm.setXYZ(i2, nx / l, ny / l, nz / l);
    }

    // 顶点色：采样自参考图 —— 头顶 #DDD975（偏绿调的亮黄）→ 脸颊 #D8B95E →
    // 躯干侧面 #D5B65D → 腿根 #BD9F4D。之前用的橙色系(#FCE45C→#E88E2C)完全不对。
    var cTop = new T.Color(0xE4DF7C);   // 头顶：亮奶黄（带一点绿）
    var cMid = new T.Color(0xDEC065);   // 脸颊：暖黄
    var cLow = new T.Color(0xD6B458);   // 躯干：奶黄
    var cBot = new T.Color(0xC79A44);   // 腿根：偏深
    var cBelly = new T.Color(0xD6C7B4); // 肚皮：米色（顶点色还要再低一档，光照会把它提亮约 12%）
    // 肚皮范围：几乎覆盖整个躯干正面。上缘 1.66 到下巴下方，下缘 0.62 到裆部
    var BELLY_Y = 1.150, BELLY_H = 0.505;
    var c = new T.Color();
    var arr = new Float32Array(pos.count * 3);
    for (i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      // 竖直渐变（绝对高度）
      if (v.y < 1.36) c.copy(cBot).lerp(cLow, smoothstep(0.62, 1.36, v.y));
      else if (v.y < 1.88) c.copy(cLow).lerp(cMid, smoothstep(1.36, 1.88, v.y));
      else c.copy(cMid).lerp(cTop, smoothstep(1.88, 2.30, v.y));
      // 肚皮：宽椭圆。注意超出 y 范围时必须直接跳过 —— 早先把 aw 兜底成 0.02，
      // 结果 x=0 那条经线在整条身体上都满足 d=0，从头顶到脚底刷出一道粉白竖线。
      var ang = Math.abs(Math.atan2(v.x, v.z));              // 0 = 正前方
      var ty = (v.y - BELLY_Y) / BELLY_H;
      if (ty > -0.97 && ty < 0.97) {
        var aw = 0.985 * Math.pow(1 - ty * ty, 0.30);        // 中间最宽 56°、上下缓慢收
        var d = ang / Math.max(0.03, aw);
        c.lerp(cBelly, 1 - smoothstep(0.58, 1.02, d));
      }
      arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new T.BufferAttribute(arr, 3));
    return g;
  }

  // 脚趾：压扁的球 = 橄榄褐小扁豆
  function variant_toe(parent, x, y, z, m, sx, sy, sz) {
    var t = mesh(sphereGeo(1, 12, 9), m, x, y, z, sx || 0.032, sy || 0.019, sz || 0.036);
    parent.add(t);
    return t;
  }

  /* ==================================================================
     AI 网格版主角
     ------------------------------------------------------------------
     照片 → 图生 3D → GLB（10,548 面，贴图 1024²）→ lib/glb-lite.js 解析。
     换它是因为：LatheGeometry 是旋转体，数学上左右前后完全对称，
     做不出「肚子只往前鼓、下颌往前伸、肚子往下垂」，四肢也只能「插」不能「长」。
     AI 网格的形体一次就对了，代价是眼睛被压成一条缝、手指糊，且无骨骼。
     所以这里只拿它的身体，眼睛用代码重做（见 buildPlayerAI 里的 eyeRig）。
     想回退：把下面 USE_AI_MODEL 改成 false，原代码原封不动。
     ================================================================== */
  var USE_AI_MODEL = true;
  var AI_MODEL_H = 1.900;       // 模型原始身高（y 从 0 到 1.9）
  var AI_K = 0.920;             // 缩放到游戏里约 1.75 高
  var AI_YAW = 0.00;           // 模型本身是 3/4 侧脸，转正到面朝 +Z

  function buildPlayerAI() {
    if (!window.GLBLite || !window.NAIWA_GLB_B64) return false;

    var root = new T.Group();
    var frog = new T.Group();
    root.add(frog);
    var rig = new T.Group();
    rig.scale.setScalar(AI_K);
    rig.rotation.y = AI_YAW;
    frog.add(rig);

    var model;
    try {
      model = GLBLite.loadB64(window.NAIWA_GLB_B64, function () { });
    } catch (e) {
      console.warn('[奶蛙] AI 模型解析失败，回退到代码版:', e);
      return false;
    }
    model.position.y += AI_MODEL_H * 0.5;   // 包围盒 y[-0.95,0.95] → 脚底落回 0
    model.traverse(function (o) {
      if (o.isMesh && o.material) {
        // 照片是哑光黏土感，不要塑料高光；贴图偏暗，颜色上提一点
        o.material.shininess = 3;
        o.material.specular = new T.Color(0x241E14);
        o.material.color = new T.Color(1.06, 1.02, 0.940);
        o.frustumCulled = false;
      }
    });
    rig.add(model);

    /* ---- 伪骨骼：AI 网格是整块，没有骨骼，腿不会动 ----
       按「离地高度 + 左右侧」给顶点算权重，绕各自的髋点做 X 轴旋转。
       角度直接读动作代码写进 legs[i].g.rotation.x 的值，所以跑动/跳跃/大笑
       三套节奏都自动继承，不用改原动作代码。 */
    var skinMesh = null;
    model.traverse(function (o) { if (o.isMesh && !skinMesh) skinMesh = o; });
    if (skinMesh && skinMesh.geometry) {
      var pa = skinMesh.geometry.attributes.position;
      var na = skinMesh.geometry.attributes.normal;
      var bp = new Float32Array(pa.array);
      var bn = na ? new Float32Array(na.array) : null;
      var lastL = 1e9, lastR = 1e9;
      /* 高度一律用 h = -z（raw 的 z 轴朝下，脚底 h=-0.95、头顶 h=+0.95，
         换算成世界高度是 y = h + 0.95）。髋部在世界 y≈0.62，所以 h = -0.33。
         曾经这里写的是 0.62（世界坐标直接拿来当 h 用），铰点因此落到了头顶附近，
         整只身体被当成一条腿绕着头甩——这就是「跑步很怪」的真正原因。 */
      var HIP_H = -0.33;        // 髋部高度（h 单位）
      var HIP_Z = -HIP_H;       // 枢轴在 raw z 上的位置 = +0.33
      var LEG_CUT = 0.22;       // 髋以下多远做完 0→1 的高度权重过渡
      var ANKLE_H = -0.775;     // 踝高（世界 y≈0.18）
      var ANKLE_Z = -ANKLE_H;
      var FOOT_FLAT = 0.55;     // 踝以下反向回转比例：让脚掌别整只跟着翘起来
      var LEG_GAIN = 0.80;
      player.aiLegPose = function (aL, aR) {
        if (Math.abs(aL - lastL) < 2e-4 && Math.abs(aR - lastR) < 2e-4) return;
        lastL = aL; lastR = aR;
        var p = pa.array, n = bn ? na.array : null;
        for (var i = 0; i < p.length; i += 3) {
          var x = bp[i], y = bp[i + 1], z = bp[i + 2];
          var h = -z;
          if (h > HIP_H) { p[i] = x; p[i + 1] = y; p[i + 2] = z; continue; }
          // 高度权重：越往下越跟着腿走
          var wh = (HIP_H - h) / LEG_CUT;
          if (wh > 1) wh = 1;
          wh = wh * wh * (3 - 2 * wh);
          // 横向权重：挡掉胯缝中线的几个顶点，否则两腿反向摆时中线会被撕开
          var wx = (Math.abs(x) - 0.045) / 0.085;
          if (wx <= 0) { p[i] = x; p[i + 1] = y; p[i + 2] = z; continue; }
          if (wx > 1) wx = 1;
          wx = wx * wx * (3 - 2 * wx);
          var w = wh * wx;
          if (w < 1e-3) { p[i] = x; p[i + 1] = y; p[i + 2] = z; continue; }
          // 左右角度必须平滑混合，不然中线处角度从 -a 跳到 +a
          var mix = (x + 0.10) / 0.20;
          if (mix < 0) mix = 0; else if (mix > 1) mix = 1;
          var a = (aL * (1 - mix) + aR * mix) * w * LEG_GAIN;
          var ca = Math.cos(a), sa = Math.sin(a);
          var dy = y, dz = z - HIP_Z;
          var py = dy * ca - dz * sa;
          var pz = dy * sa + dz * ca + HIP_Z;
          // 脚掌：踝点随腿移动到哪儿，就在那儿再反向转一点，脚底不会整只翘起来
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
          p[i] = x;
          p[i + 1] = py;
          p[i + 2] = pz;
          if (n) {
            var ny = bn[i + 1], nz = bn[i + 2];
            n[i + 1] = ny * ca - nz * sa;
            n[i + 2] = ny * sa + nz * ca;
          }
        }
        pa.needsUpdate = true;
        if (na) na.needsUpdate = true;
      };
      // #legtest 直接给死角度，用来离线核对摆腿变形是否正常
      var LEG_TEST = (location.hash.indexOf("legtest") >= 0) ? [0.62, -0.62] : null;
      skinMesh.onBeforeRender = function () {
        var P = player.parts;
        if (!P || !P.legs) return;
        if (LEG_TEST) { player.aiLegPose(LEG_TEST[0], LEG_TEST[1]); return; }
        player.aiLegPose(P.legs[0].g.rotation.x, P.legs[1].g.rotation.x);
      };
    }

    /* ---- 眼睛：这双眼其实 AI 做得又准又像（绿虹膜 + 黑瞳），不需要盖 ----
       以前盖的那对"大眼球"之所以穿模：整颗头是 3/4 侧转的，贴图里的两颗眼
       在 x = -0.211 / +0.039（实测），根本不对称；用 ±0.132 这种对称值去盖，
       必然一颗浮在头顶、一颗压进脸颊。所以现在不再盖新眼球，
       只在瞳孔上点一颗高光（让它在小屏上也能读出"这是眼睛"），
       闭眼时盖一条深色细缝。坐标全是软光栅化 + z-buffer 反查出来的。 */
    var mGlintAI = new T.MeshBasicMaterial({ color: 0xFFFFFF });
    var mLidAI = new T.MeshBasicMaterial({ color: 0x2A2010 });

    var AI_EYES = [
      { p: [-0.2105, 1.7593, 0.2668], n: [0.14, 0.07, 0.99] },   // 角色的右眼（画面左）
      { p: [0.0387, 1.7636, 0.0911], n: [0.88, -0.07, 0.47] }    // 角色的左眼（画面右，转到侧后方）
    ];
    var eyes = [];
    AI_EYES.forEach(function (d) {
      var p = new T.Vector3(d.p[0], d.p[1], d.p[2]);
      var n = new T.Vector3(d.n[0], d.n[1], d.n[2]).normalize();
      var g = new T.Group();
      g.position.copy(p);
      g.lookAt(p.clone().add(n));           // 局部 +z 朝眼球外表面
      var gl = mesh(sphereGeo(0.0125, 9, 7), mGlintAI, -0.013, 0.018, 0.005);
      g.add(gl);
      var lid = mesh(sphereGeo(1, 14, 8), mLidAI, 0, 0, 0.002, 0.046, 0.008, 0.010);
      lid.visible = false;
      g.add(lid);
      rig.add(g);
      eyes.push({ g: g, glints: [gl], lid: lid, flat: true });
    });

    /* ---- 嘴：实心网格挖不出口腔，"张嘴"只能是一张贴在脸上的凹片 ----
       以前用一颗深色椭球 / 一片球冠，两次都穿模。原因量出来了：笑缝在三维里
       不是一条直线，而是沿脸颊弯下去的一条曲线（从右到左 z 由 +0.18 变到 +0.26，
       深度差 8cm）。任何解析曲面（球、球冠、平面）贴上去，必然一端顶出脸颊、
       一端埋进肉里。
       所以这次不用解析几何：在模型表面按椭圆足迹采样，每个采样点回查真实
       曲面坐标、再沿法线抬 4mm，生成一片「和脸完全同形」的网格。
       数据在 res/models/mouth_patch.js（顶点/索引/中心/切线/副切线/法线）。 */
    var mToothAI = new T.MeshPhongMaterial({ color: 0xFFFBEE, shininess: 40, specular: 0xFFFFFF });
    var mTongueAI = new T.MeshPhongMaterial({ color: 0xC9606E, shininess: 20, specular: 0x5A2A30 });
    var MP = window.MOUTH_PATCH;
    var mouthG = new T.Group();
    mouthG.visible = false;
    var cavity = null, teethG = null, tongue = null;
    if (MP) {
      var cV = new T.Vector3().fromArray(MP.c);
      var nV = new T.Vector3().fromArray(MP.n);
      var tV = new T.Vector3().fromArray(MP.t);
      var bV = new T.Vector3().fromArray(MP.b);
      var mBasis = new T.Matrix4().makeBasis(tV, bV, nV);
      mouthG.position.copy(cV);
      mouthG.quaternion.setFromRotationMatrix(mBasis);

      // 把「世界坐标下的贴片顶点」换算到 mouthG 自己的局部系，
      // 这样 setMouthOpen 里改 mouthG.scale.y 才是绕嘴心张合，而不是绕原点乱飞
      var mg = new T.BufferGeometry();
      mg.setAttribute('position', new T.BufferAttribute(new Float32Array(MP.p), 3));
      mg.setIndex(new T.BufferAttribute(new Uint16Array(MP.i), 1));
      var inv = new T.Matrix4().compose(cV, mouthG.quaternion, new T.Vector3(1, 1, 1)).invert();
      mg.applyMatrix4(inv);
      mg.computeVertexNormals();
      cavity = new T.Mesh(mg, new T.MeshBasicMaterial({ color: 0x2A1014, side: T.DoubleSide }));
      mouthG.add(cavity);

      // 牙与舌都在 mouthG 的局部系里，+y 是嘴的"上"，+z 朝脸外
      teethG = new T.Group();
      for (var ti = 0; ti < 6; ti++) {
        teethG.add(mesh(boxGeo(0.017, 0.011, 0.007), mToothAI, (ti - 2.5) * 0.0295, 0.029, 0.006));
      }
      mouthG.add(teethG);

      // 舌头：尺寸必须烘进几何体 —— setMouthOpen 会直接改写 tongue.scale 当"张嘴脉动"用
      var tongGeo = sphereGeo(1, 16, 12);
      tongGeo.scale(0.034, 0.012, 0.007);
      tongue = new T.Mesh(tongGeo, mTongueAI);
      tongue.position.set(0, -0.024, 0.006);
      mouthG.add(tongue);

      rig.add(mouthG);
    }

    // 平时"微笑"就是贴图里那条缝，动作代码要一个 visible 开关，给个空壳
    var smileDummy = new T.Group();
    rig.add(smileDummy);

    /* ---- 部件占位：动作代码会直接改 legs/arms 的 rotation ---- */
    var legDummy = [];
    [-1, 1].forEach(function (s) {
      var lg = new T.Group();
      lg.position.set(s * 0.24, 0.62, 0);
      rig.add(lg);
      legDummy.push({ g: lg });
    });
    var armDummy = [];
    [-1, 1].forEach(function (s) {
      var ag = new T.Group();
      ag.position.set(s * 0.55, 1.10, 0);
      rig.add(ag);
      armDummy.push(ag);
    });

    root.scale.setScalar(0.98);
    player.root = root;
    player.frog = frog;
    player.parts = {
      eyes: eyes,
      mouth: { g: mouthG, smile: smileDummy, cavity: cavity, teeth: teethG, tongue: tongue },
      arms: armDummy,
      legs: legDummy
    };
    scene.add(root);

    var sh = new T.Mesh(new T.CircleGeometry(1.00, 22),
      new T.MeshBasicMaterial({ color: 0x6B5540, transparent: true, opacity: 0.16, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2;
    sh.position.y = 0.02;
    scene.add(sh);
    player.shadow = sh;

    var bub = new T.Group();
    bub.add(new T.Mesh(sphereGeo(1.62, 18, 14),
      new T.MeshBasicMaterial({ color: 0xAFF0FF, transparent: true, opacity: 0.16, depthWrite: false })));
    bub.add(new T.Mesh(sphereGeo(1.48, 16, 12),
      new T.MeshBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.1, depthWrite: false })));
    bub.visible = false;
    scene.add(bub);
    player.bubble = bub;

    return true;
  }

  function buildPlayer() {
    if (USE_AI_MODEL && buildPlayerAI()) return;
    var root = new T.Group();
    var frog = new T.Group();
    root.add(frog);
    var upper = new T.Group();       // 上身整体（保留分组，方便以后整体微调）
    upper.position.y = BODY_LIFT;
    frog.add(upper);

    var mBody = new T.MeshPhongMaterial({ color: 0xFFFFFF, vertexColors: true, shininess: 5, specular: 0x3A3018 });
    var mSkin = new T.MeshPhongMaterial({ color: 0xD9BA5D, shininess: 30, specular: 0x6B5A28 });   // 手臂：与躯干侧面色一致
    var mLeg = new T.MeshPhongMaterial({ color: 0xD2B057, shininess: 26, specular: 0x5E4B1C });
    var mHand = new T.MeshPhongMaterial({ color: 0x7C6440, shininess: 16, specular: 0x3A3020 });  // 手掌：橄榄褐
    // 脚掌：与腿同色，只有趾端变深 —— 用顶点色在一张皮上渐变，
    // 贴一块深色"鞋头"会让整只脚变成皮鞋。
    var mFootVC = new T.MeshPhongMaterial({ color: 0xFFFFFF, vertexColors: true, shininess: 8, specular: 0x3A2F17 });
    var mToe = new T.MeshPhongMaterial({ color: 0x6E5A36, shininess: 12, specular: 0x2E2618 });   // 趾尖：深橄榄
    var mEye = new T.MeshPhongMaterial({ color: 0x0E1109, shininess: 130, specular: 0xFFFFFF });
    var mEyeG = new T.MeshPhongMaterial({ color: 0x4C7A26, shininess: 70, specular: 0x9FBB63 });
    var mGlint = new T.MeshBasicMaterial({ color: 0xFFFFFF });
    var mCavity = new T.MeshBasicMaterial({ color: 0x2C1116, side: T.DoubleSide });
    var mTooth = new T.MeshPhongMaterial({ color: 0xFFFBEE, shininess: 46, specular: 0xFFFFFF });
    var mTongue = new T.MeshPhongMaterial({ color: 0xD9707C, shininess: 30, side: T.DoubleSide });
    var mLip = new T.MeshBasicMaterial({ color: 0x4A3718, side: T.DoubleSide });
    var UNIT = sphereGeo(1, 24, 18);

    // 身体：一整块旋转体，没有脖子、没有拼接
    var body = new T.Mesh(buildBodyGeo(), mBody);
    upper.add(body);

    /* ---- 眼睛：一个"从脸面鼓出来的抛物面圆顶"，眼包/虹膜/瞳孔用顶点色画 ----
       参考图里眼球不是贴片，是两颗**鼓出来的包**（周围还有一圈略深的眼睑），
       所以必须是从脸面起鼓的几何，而不是穿进脸里的球（后者交线会是锯齿）。
       配色从内到外：黑瞳 → 深绿虹膜 → 深橙眼睑 → 融入皮肤。 */
    var EYE_Y = 2.078, EYE_X = 0.148, EYE_R = 0.114, EYE_BULGE = 0.066;
    var cEyeB = new T.Color(0x0C0F08), cEyeG = new T.Color(0x4C7A26), cEyeR = new T.Color(0x2C4A16);
    var mEyeDome = new T.MeshPhongMaterial({ vertexColors: true, shininess: 92, specular: 0xFFFFFF });

    function eyeDome(cx, cy, ER, bulge, segs, rings) {
      var pos = [], col = [], idx = [], i, j, tc = new T.Color();
      pos.push(0, 0, faceZ(cx, cy) + bulge + 0.004);
      col.push(cEyeB.r, cEyeB.g, cEyeB.b);
      for (i = 1; i <= rings; i++) {
        var u = i / rings, rr = ER * u, zz = bulge * (1 - u * u) + 0.004;
        if (u < 0.46) tc.copy(cEyeB);
        else if (u < 0.64) tc.copy(cEyeB).lerp(cEyeG, smoothstep(0.46, 0.64, u));
        else if (u < 0.86) tc.copy(cEyeG);
        else tc.copy(cEyeG).lerp(cEyeR, smoothstep(0.86, 1.0, u));
        for (j = 0; j < segs; j++) {
          var a = j / segs * Math.PI * 2;
          var x = Math.cos(a) * rr, y = Math.sin(a) * rr;
          pos.push(x, y, faceZ(cx + x, cy + y) + zz);
          col.push(tc.r, tc.g, tc.b);
        }
      }
      for (j = 0; j < segs; j++) idx.push(0, 1 + j, 1 + (j + 1) % segs);
      for (i = 1; i < rings; i++) {
        var r0 = 1 + (i - 1) * segs, r1 = 1 + i * segs;
        for (j = 0; j < segs; j++) {
          var a0 = r0 + j, a1 = r0 + (j + 1) % segs;
          var b0 = r1 + j, b1 = r1 + (j + 1) % segs;
          idx.push(a0, b0, b1, a0, b1, a1);
        }
      }
      var geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      geo.attributes.normal.setXYZ(0, 0, 0, 1);   // 极点法线取正前方，否则圆顶正中会塌成一块平斑
      return geo;
    }

    var eyes = [];
    [-1, 1].forEach(function (s) {
      var g = new T.Group();
      g.position.set(s * EYE_X, EYE_Y, 0);
      g.add(new T.Mesh(eyeDome(s * EYE_X, EYE_Y, EYE_R, EYE_BULGE, 40, 14), mEyeDome));
      // 高光砸在圆顶表面上，z 得按它所在的半径算，不能用一个常数
      var gx = s * -0.036, gy = 0.034, gu = 0.44;
      var gl1 = mesh(sphereGeo(0.0115, 8, 6), mGlint, gx, gy,
                     faceZ(s * EYE_X + gx, EYE_Y + gy) + EYE_BULGE * (1 - gu * gu) + 0.006);
      g.add(gl1);
      upper.add(g);
      eyes.push({ g: g, glints: [gl1], baseY: EYE_Y });
    });

    /* ---- 嘴：参考图里就是一条很细的横线，两端微微上翘，中间略沉。
       脸的曲率被压平之后，不需要再用大偏移把缝"顶"出表面。 ---- */
    var LIP_Y = 1.828;
    function faceShape(build, sx, sy, flat) {
      var sh = new T.Shape();
      build(sh);
      var g2 = new T.ShapeGeometry(sh, 30);
      if (sx) g2.scale(sx, sy === undefined ? sx : sy, 1);
      var ps = g2.attributes.position;
      for (var i2 = 0; i2 < ps.count; i2++) {
        var px = ps.getX(i2), py = ps.getY(i2);
        ps.setZ(i2, faceZ(px, flat ? LIP_Y : LIP_Y + py) + (flat ? 0.026 : 0.016));
      }
      g2.computeVertexNormals();
      return g2;
    }

    // 张开的嘴（最大形态，运行时用 scale.y 控制张合）
    var openGeo = faceShape(function (sh) {
      sh.moveTo(-0.130, 0.002);
      sh.quadraticCurveTo(-0.090, -0.092, 0, -0.108);
      sh.quadraticCurveTo(0.090, -0.092, 0.130, 0.002);
      sh.quadraticCurveTo(0.138, 0.013, 0.120, 0.018);
      sh.quadraticCurveTo(0.064, 0.024, 0, 0.024);
      sh.quadraticCurveTo(-0.064, 0.024, -0.120, 0.018);
      sh.quadraticCurveTo(-0.138, 0.013, -0.130, 0.002);
    }, 1.00, 1.00);
    // 舌头
    var tongueGeo = faceShape(function (sh) {
      sh.moveTo(-0.082, -0.076);
      sh.quadraticCurveTo(0, -0.050, 0.082, -0.076);
      sh.quadraticCurveTo(0, -0.105, -0.082, -0.076);
    }, 1.00, 1.00);
    // 闭合时的唇缝：一条细横线，两端微翘（参考图里嘴角是往上提的）
    var smileGeo = faceShape(function (sh) {
      sh.moveTo(-0.170, 0.013);
      sh.quadraticCurveTo(0, -0.005, 0.170, 0.013);
      sh.quadraticCurveTo(0, -0.030, -0.170, 0.013);
    }, 1.00, 1.00, true);

    var mouthG = new T.Group();
    mouthG.position.set(0, LIP_Y, 0);
    var cavity = new T.Mesh(openGeo, mCavity);
    var teeth = new T.Group();
    for (var ti = 0; ti < 6; ti++) {
      var tx = (ti - 2.5) * 0.0386;
      var tyTop = 0.021 - 0.50 * Math.pow(tx / 0.130, 2) * 0.011;
      var ty = tyTop - 0.012;
      var tz = faceZ(tx, LIP_Y + ty) + 0.012;
      var tb = mesh(boxGeo(0.031, 0.024, 0.011), mTooth, tx, ty, tz);
      tb.rotation.z = -tx * 0.70;
      teeth.add(tb);
    }
    var tongue = new T.Mesh(tongueGeo, mTongue);
    tongue.position.z = 0.006;
    mouthG.add(cavity); mouthG.add(teeth); mouthG.add(tongue);
    upper.add(mouthG);
    mouthG.visible = false;

    var smile = new T.Mesh(smileGeo, mLip);
    smile.position.set(0, LIP_Y, 0);
    upper.add(smile);

    /* ---- 手臂：参考图里胳膊从很宽的肩上垂下，前臂弯向肚子前方，
       手掌是**扁平的、有手指的**（不是圆球掌 + 尖爪），颜色是橄榄褐。
       管状上臂/前臂用一根 TubeGeometry 沿样条放样，避免两段胶囊在肘部留切口。 ---- */
    // 人臂的粗细曲线（t=0 肩 → t=1 腕）：肩最粗 → 上臂中略收 → 肘明显收 →
    // 前臂中段微微回鼓 → 腕最细（0.070，只有肩的 43%）。等半径的管子做不出这个。
    var ARM_R = [
      [0.00, 0.150], [0.16, 0.146], [0.32, 0.140], [0.46, 0.128],
      [0.56, 0.118], [0.70, 0.107], [0.82, 0.089], [0.93, 0.068], [1.00, 0.056]
    ];
    function armR(t) {
      for (var i = 1; i < ARM_R.length; i++) {
        if (t <= ARM_R[i][0]) {
          var u = (t - ARM_R[i - 1][0]) / (ARM_R[i][0] - ARM_R[i - 1][0]);
          u = u * u * (3 - 2 * u);          // smoothstep：关节处不能有折角
          return ARM_R[i - 1][1] + (ARM_R[i][1] - ARM_R[i - 1][1]) * u;
        }
      }
      return ARM_R[ARM_R.length - 1][1];
    }

    var arms = [];
    [-1, 1].forEach(function (s) {
      var ag = new T.Group();
      // 肩点：躯干在 rel 1.0 处半径 0.60，肩关节放在 x 0.44 就埋进去了
      ag.position.set(s * 0.440, 1.525, 0.015);
      /* ★ 上臂必须**先往外走**，到肘再折回来。
         早先这条样条从肩一出来就往内、往前方钻（x 只到 0.157），
         而同一高度肚子半径有 0.70 —— 整根上臂埋在肚子里：
         正面只剩两只手掌浮在肚皮上，从背后看又是两片"肩垫"，怎么调都像没有胳膊。
         参考图的走向是：肩 → 向外下方斜到肘（肘是整条手臂**最外、最低**的点）
         → 前臂贴着肚子斜向前上 → 腕。
         轴向距离（到身体中轴）逐点对照：肘 0.718 vs 肚子 0.704，
         即肘心正好压在体表上 —— 手臂有一半在外面，读起来才是"一条胳膊"。 */
      /* 起点必须压在肩线**以下**（y 0.175 → 0.040）。
         高 0.175 时，管子在肩上鼓出一个拱顶（顶到 y≈1.85，比肩还高），
         整条手臂读成一个"提手"：从身体上方绕出去再兜回来，没有上臂、没有肘。
         现在肩 → 肘是**一条接近直线的下坡**（x 从 0.08 稳增到 0.258、y 单调下降），
         到肘才急转——肘后 0.076 就把 z 从 0.082 甩到 0.190，折角一眼可见。 */
      var cv = new T.CatmullRomCurve3([
        new T.Vector3(s * -0.105, 0.040, -0.070),  // 起点：深埋在肩关节里
        new T.Vector3(s * 0.080, 0.006, -0.014),
        new T.Vector3(s * 0.196, -0.112, 0.030),   // 上臂中段：直着往下
        new T.Vector3(s * 0.258, -0.226, 0.082),   // 肘：全臂最外、最低，直线段到此结束
        new T.Vector3(s * 0.250, -0.298, 0.196),   // 拐角：z 急推 0.114 → 肘角
        new T.Vector3(s * 0.190, -0.372, 0.404),   // 前臂：贴着肚皮斜向前上
        new T.Vector3(s * 0.094, -0.430, 0.584),
        new T.Vector3(s * 0.020, -0.452, 0.676)    // 腕：掌根从这儿接上去
      ]);
      ag.add(new T.Mesh(taperTube(cv, armR, 42, 16), mSkin));
      // 只有肩端需要封口（埋进身体里，防止斜角看到管口）。腕端不封：
      // 掌根是一颗橄榄褐的球，直径比腕大，正好把黄色的管口盖住 ——
      // 参考图里手也是从手腕一圈"手套口"开始的。
      ag.add(mesh(UNIT, mSkin, s * -0.105, 0.040, -0.070, 0.150, 0.150, 0.150));

      /* ---- 手：参考图里是**一双人类的手** —— 掌根窄、指根宽，五指长短分明，
         指根并拢、指尖微张，拇指从内侧斜着伸出去。
         早先是"一块扁椭圆板 + 4 根香肠 + 一颗横支出来的拇指"，看着像青蛙爪。 ---- */
      var hand = new T.Group();
      hand.position.set(s * 0.020, -0.452, 0.676);     // 腕心 = 管口
      // 绕 y 转 0.50（≈29°）：掌心仍朝内贴着肚皮，但把**拇指那一侧**转到前面来。
      // 只转 0.20 的时候，拇指整根藏在掌的侧面，正面只看见四根手指 —— 像一只手套。
      hand.rotation.set(-0.12, s * 0.18, s * -0.08);
      ag.add(hand);

      // 掌根（腕→掌）：窄而厚，同时盖住黄色管口
      // 掌要有"面积"：早先 sy 只有 0.066，从正面看就是一根横着的细条，
      // 四根手指像直接插在手腕上。现在掌高 0.23、掌宽 0.27，接近真正的方形掌。
      // 掌根只比腕（0.070）粗一点点：0.074。再大就从"手的根部"变成
      // 套在手腕上的褐色护腕 —— 正面看是手下面挂着一个球。
      hand.add(mesh(UNIT, mHand, 0, 0.014, 0, 0.072, 0.058, 0.054));
      // 掌身：一颗超椭球（boxBall），平顶、直边、圆角，掌底再放宽 14% 成梯形。
      // 掌宽 0.256、高 0.196、厚 0.108 —— 人手的宽厚比约 2.4。
      hand.add(mesh(boxBall(0.128, 0.088, 0.054, 3.2, 0.16, 24, 16), mHand,
                    0, 0.052, 0.004));

      // 4 根手指：x 负 = 靠身体中线（拇指侧 = 食指），x 正 = 外侧（小指侧）
      var FING = [
        { x: -0.084, l: 0.142, r: 0.025, z: -0.005 },   // 食指（紧邻拇指，靠中线）
        { x: -0.028, l: 0.152, r: 0.026, z: 0.005 },    // 中指（最长，最靠前）
        { x: 0.028, l: 0.140, r: 0.025, z: 0.000 },     // 无名指
        { x: 0.084, l: 0.116, r: 0.023, z: -0.008 }     // 小指（最短，最外侧）
      ];
      // ↑ 长度顺序照参考图：中指 > 食指 ≈ 无名指 > 小指。
      // 每根手指是**一根渐细的弯管**（taperTube），不是"两节胶囊 + 关节球"：
      // 胶囊两端本身就是半球，两节接起来必然鼓出一个核桃大的台阶，
      // 四根手指 = 四串竹节虫。一根弯管则从指根到指尖连续收细，只有末节有个指节弯。
      FING.forEach(function (f) {
        var bx = s * f.x, L = f.l, r = f.r;
        var fc = new T.CatmullRomCurve3([
          new T.Vector3(bx,          0.124, 0.014 + f.z),        // 指根：埋进掌里
          new T.Vector3(bx * 1.04,   0.124 + L * 0.34, 0.006 + f.z),
          new T.Vector3(bx * 1.09,   0.124 + L * 0.66, -0.014 + f.z),
          new T.Vector3(bx * 1.13,   0.124 + L * 0.90, -0.044 + f.z),
          new T.Vector3(bx * 1.16,   0.124 + L, -0.070 + f.z)    // 指尖：向肚皮勾起
        ]);
        // 半径收到 0.62r 就停：再细下去末端就是一根削尖的铅笔，
        // 圆润的指尖靠末尾那颗球来补（球比管端粗 0.1r，正好鼓出指肚）。
        hand.add(new T.Mesh(taperTube(fc, function (t) {
          return r * (1.04 - 0.18 * Math.pow(t, 0.8));
        }, 14, 9), mHand));
        // 封口球只比管端粗一点点（0.90r vs 0.86r），球心抬高 0.010：
        // 球太大就成"蘑菇头"，正好卡住时只是一个圆润的指肚。
        // 指尖球用 12×8 的低面球：这里跟着全身用 UNIT（24×18）会白搭 800 个三角面
        hand.add(mesh(sphereGeo(1, 12, 8), mHand,
                      bx * 1.16, 0.124 + L + 0.006, -0.072 + f.z,
                      r * 0.98, r * 0.94, r * 0.98));
      });

      // 拇指：从掌的**内侧**（靠身体中线）中段斜着伸出，两节、向内上方勾 ——
      // 这是"人手"最强的信号。少了它，四根手指就是一只脚。
      // 位置必须落在掌的中段（y≈0.10）；放到掌下缘（0.076）就会变成一根挂在
      // 手腕旁边的第五根脚趾。
      var thg = new T.Group();
      thg.position.set(s * -0.080, 0.056, 0.040);
      thg.rotation.set(0.32, 0, s * 0.78);             // 向内撇 45°，同时朝前倾
      var tc = new T.CatmullRomCurve3([
        new T.Vector3(0, 0, 0),
        new T.Vector3(0.005, 0.038, 0.004),
        new T.Vector3(0.017, 0.074, 0.000),
        new T.Vector3(0.031, 0.102, -0.010)
      ]);
      thg.add(new T.Mesh(taperTube(tc, function (t) {
        return 0.036 - 0.009 * Math.pow(t, 0.85);
      }, 14, 9), mHand));
      thg.add(mesh(sphereGeo(1, 12, 8), mHand, 0.031, 0.102, -0.010, 0.027, 0.026, 0.027));
      hand.add(thg);

      upper.add(ag);
      arms.push(ag);
    });

    /* ---- 腿：**大腿粗、膝盖收、小腿细、脚踝最细、脚掌扁而大**。
       参考图的腿不是锥形柱，是"葫芦形"：大腿根 0.214 一路收到脚踝只剩 0.083（39%），
       中间在膝下有一个明显的转折。早先做成 0.204→0.144 的直锥，
       小腿就跟大腿一样粗，远看是两根水管，脚掌则像串在管口上的蛋。 ---- */
    var legs = [];

    /* 脚掌：一颗"下半截钳平"的超椭球 + 三道沿脚长的形变。
       ① 钳平 → 真正水平的脚底。球压扁做脚，底面是一段弧，
          从下往上看是个蛋：跳跃时能看到悬空的弧底，落地只有正中间一点受力。
       ② 高度包络 FOOT_HK：后跟圆而低 → 踝下最高（脚背）→ 向前斜降到趾根。
       ③ 宽度包络 FOOT_WK：后跟收窄 → 前掌（跖球处）最宽 → 趾端略收。
          ⚠ 早先宽度只按 sin 给了一个"中段最宽"的鼓包，前后几乎一样宽，
          整只脚就成了一只圆头拖鞋。
       ④ 4 瓣趾垫：把脚趾**雕进同一个曲面**（前缘按 x 分成 4 个瓣，瓣顶前推）。
          早先外挂 4 颗椭球：从侧面看是粘在脚边的四颗豆子，正面又大半埋进脚里。
       配色用顶点色：脚背 = 腿色，趾端渐变到深橄榄。
       参考图的深色是同一张皮上的颜色；贴一块深色"鞋头"会让整只脚变成皮鞋。 */
    function envLook(tab, t) {
      for (var i = 1; i < tab.length; i++) {
        if (t <= tab[i][0]) {
          var u = (t - tab[i - 1][0]) / (tab[i][0] - tab[i - 1][0]);
          u = u * u * (3 - 2 * u);
          return tab[i - 1][1] + (tab[i][1] - tab[i - 1][1]) * u;
        }
      }
      return tab[tab.length - 1][1];
    }
    var FOOT_SX = 0.198, FOOT_SY = 0.132, FOOT_SZ = 0.268;
    var FOOT_CUT = -0.038;               // 钳平的高度（几何自身坐标）
    var FOOT_Y = -0.585 - FOOT_CUT;      // 脚底落到 local −0.585（世界 y ≈ −0.025）
    var cFootBody = new T.Color(0xC9A64D), cFootToe = new T.Color(0x4A3A1E);
    var FOOT_HK = [[0.00, 0.56], [0.12, 0.90], [0.30, 1.06], [0.48, 0.90],
                   [0.66, 0.70], [0.82, 0.54], [1.00, 0.46]];
    var FOOT_WK = [[0.00, 0.60], [0.16, 0.84], [0.40, 0.92], [0.62, 0.98],
                   [0.80, 1.00], [0.92, 0.96], [1.00, 0.90]];
    var footG = geo('footV4', function () {
      // n 只能取 2.5：3.4 时顶面太平，整只脚像一块方板
      var g = boxBall(FOOT_SX, FOOT_SY, FOOT_SZ, 2.5, 0, 44, 26);
      var p = g.attributes.position, cols = [];
      for (var i = 0; i < p.count; i++) {
        var x0 = p.getX(i), y0 = p.getY(i), z = p.getZ(i);
        var t = (z / FOOT_SZ + 1) * 0.5;                    // 0 后跟 → 1 趾端
        var x = x0 * envLook(FOOT_WK, t);                   // 前掌最宽、后跟收窄
        var y = y0;
        // 4 个趾瓣：只作用于最前 ~20%，瓣顶前推、瓣沟后退
        var u0 = x0 / FOOT_SX;                              // −1 外缘 … +1 内缘
        var lobe = 0.5 + 0.5 * Math.cos(4 * Math.PI * (u0 + 0.75));
        var tw = smoothstep(0.78, 1.00, t);
        z += 0.052 * lobe * tw;
        if (y > 0) {
          y *= envLook(FOOT_HK, t);
          y += 0.017 * (lobe - 0.5) * tw;                   // 瓣顶鼓起、趾缝下凹
        }
        if (y < FOOT_CUT) y = FOOT_CUT;                     // 钳平 → 水平脚底
        p.setXYZ(i, x, y, z);
        var m = smoothstep(0.80, 0.98, t);
        cols.push(cFootBody.r + (cFootToe.r - cFootBody.r) * m,
                  cFootBody.g + (cFootToe.g - cFootBody.g) * m,
                  cFootBody.b + (cFootToe.b - cFootBody.b) * m);
      }
      p.needsUpdate = true;
      g.setAttribute('color', new T.Float32BufferAttribute(cols, 3));
      g.computeVertexNormals();
      return g;
    });

    [-1, 1].forEach(function (s) {
      var lg = new T.Group();
      lg.position.set(s * 0.205, BODY_Y, 0.010);
      var LEG_PROF = [
        [0.000, 0.215], [0.096, 0.209], [0.160, 0.196], [0.203, 0.178],
        [0.223, 0.146], [0.231, 0.098], [0.229, 0.045], [0.221, -0.010],
        [0.204, -0.068], [0.180, -0.122],                       // 膝
        [0.155, -0.172], [0.133, -0.220], [0.116, -0.266],
        [0.103, -0.310], [0.094, -0.352], [0.090, -0.396],      // 脚踝
        [0.094, -0.424], [0.090, -0.452],                       // 踝下脚背略鼓
        [0.070, -0.478], [0.036, -0.492], [0.000, -0.500]
      ];
      var lgPts = LEG_PROF.map(function (p) { return new T.Vector2(p[0], p[1]); });
      // 30 段：小腿最细处周长只有 0.52，26 段会出现肉眼可见的多边形棱
      var limb = new T.Mesh(new T.LatheGeometry(lgPts, 30), mLeg);
      limb.position.set(s * 0.035, 0, 0.004);
      // 腿往外撇 11.7°（参考图是 O 型腿，两脚分得很开）。
      // ⚠ 只转**腿**，不转脚：脚跟着一起斜就会变成踮脚，脚底朝天。
      limb.rotation.z = s * 0.205;
      lg.add(limb);

      // 脚：独立一组，只绕 y 轴外八 —— 脚底永远水平贴地。
      var ft = new T.Group();
      // 腿倾斜后踝点会外移：0.035 + 0.500·sin(0.205) = 0.137，脚必须跟到这儿
      ft.position.set(s * 0.137, 0, 0.006);
      ft.rotation.y = s * 0.22;      // 脚尖外八 12.6°（参考图两只脚明显朝外）
      lg.add(ft);
      // 踝点在脚长方向约 40% 处（参考图后跟短、前掌长），所以脚网整体前移 0.046
      ft.add(mesh(footG, mFootVC, 0, FOOT_Y, 0.046));
      frog.add(lg);
      legs.push({ g: lg });
    });

    /* ---- 小尾巴：屁股后面一个小肉尖（参考图背面看不到明显尾巴，做小一点）---- */
    var mTail = new T.MeshPhongMaterial({ color: 0xCFA84E, shininess: 26, specular: 0x5E4715 });
    var tail = mesh(sphereGeo(1, 14, 11), mTail, 0, 1.020, -0.640, 0.080, 0.120, 0.075);
    tail.rotation.x = -0.55;
    upper.add(tail);

    root.scale.setScalar(0.98);
    player.root = root;
    player.frog = frog;
    player.parts = {
      eyes: eyes, mouth: { g: mouthG, smile: smile, cavity: cavity, teeth: teeth, tongue: tongue },
      arms: arms, legs: legs
    };
    scene.add(root);

    // 影子
    var sh = new T.Mesh(new T.CircleGeometry(1.00, 22), new T.MeshBasicMaterial({ color: 0x6B5540, transparent: true, opacity: 0.16, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2;
    sh.position.y = 0.02;
    scene.add(sh);
    player.shadow = sh;

    // 无敌泡泡
    var bub = new T.Group();
    var b1 = new T.Mesh(sphereGeo(1.62, 18, 14), new T.MeshBasicMaterial({ color: 0xAFF0FF, transparent: true, opacity: 0.16, depthWrite: false }));
    var b2 = new T.Mesh(sphereGeo(1.48, 16, 12), new T.MeshBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.1, depthWrite: false }));
    bub.add(b1); bub.add(b2);
    bub.visible = false;
    scene.add(bub);
    player.bubble = bub;
  }
  buildPlayer();

  /* ---------------- 障碍物 ---------------- */
  var OB = {};

  /* ---- 通用：内嵌 GLB → 游戏角色 ----
     AI 图生 3D 的顶点是 Z-up（z 从 −h/2 到 +h/2 就是身高），但节点自带一段
     绕 X 轴 +90° 的旋转把它转成 Y-up，glb-lite 会应用这段 TRS，所以拿到手的
     object3D 已经是 Y 朝上，这里不用再转。
     职责：按目标身高缩放、脚底对齐 y=0、按包围盒给碰撞盒、缓存原型。
     原型只解析一次，之后每次 spawn 都是 clone（共享几何与贴图，不重复上传显存）。 */
  /* 总开关：换成代码拼的旧模型就改成 false（原代码一行未删，会用包围盒自己兜底） */
  var USE_GLB_ACTORS = true;
  var GLB_ACTOR_CACHE = {};
  function glbActor(jsVar, opt) {
    opt = opt || {};
    var b64 = window[jsVar];
    if (!b64 || !window.GLBLite) return null;
    var proto = GLB_ACTOR_CACHE[jsVar];
    if (!proto) {
      var m;
      try { m = GLBLite.loadB64(b64, function () { }); }
      catch (e) { console.warn('[角色] 解析失败 ' + jsVar, e); return null; }
      m.traverse(function (o) {
        if (o.isMesh && o.material) {
          o.material.shininess = 4;
          o.material.specular = new T.Color(0x241E14);
          o.frustumCulled = false;      // 伪骨骼会改顶点，包围球不再可信
        }
      });
      m.updateMatrixWorld(true);
      var box = new T.Box3().setFromObject(m);
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
      H = proto.h * k;          // 身高由宽度反推，碰撞盒顶部跟着对
    } else {
      k = H / Math.max(proto.h, 1e-4);
    }
    var g = new T.Group();
    var inst = proto.obj.clone(true);
    inst.scale.setScalar(k);
    inst.position.y = -proto.minY * k;
    if (opt.yaw) inst.rotation.y = opt.yaw;
    g.add(inst);
    // 碰撞盒：默认按真实包围盒算，只有「故意想让判定比视觉宽/窄」时才用 opt.hx/hz 覆盖。
    // 这条注释原来写的是"必须优先用旧手写模型的值"，那是个坑：旧判定是给胖造型留的，
    // 套到 AI 瘦模型上就变成豆包判定深 1.76 米、模型只有 0.41 米 —— 玩家看着它跑到
    // 身后了还在撞。判定比视觉宽不是"手感宽容"，是"骗人"。
    var hk = opt.hitK || 1;
    var hx = opt.hx !== undefined ? opt.hx : proto.halfX * k * hk;
    var hz = opt.hz !== undefined ? opt.hz : proto.halfZ * k * hk;
    if (opt.yaw && Math.abs(Math.sin(opt.yaw)) > 0.5) { var t = hx; hx = hz; hz = t; }
    return {
      obj: g,
      // 0.18 只是防呆下限（防止极小模型判定塌成一个点），不要为了"宽容"往上加
      hit: { y0: 0, y1: opt.hitH || H * 0.92, hx: Math.max(hx, 0.18), hz: Math.max(hz, 0.18) },
      name: opt.name || ''
    };
  }

  /* ---- 通用表情零件 ---- */
  // 一对圆眼（朝 +Z），r 为眼球半径
  function addEye(g, x, y, z, r, mW, mP, turn) {
    var e = new T.Group();
    e.position.set(x, y, z);
    e.rotation.y = turn || 0;
    e.add(mesh(sphereGeo(r, 14, 12), mW, 0, 0, 0, 1, 1.06, 0.82));
    e.add(mesh(sphereGeo(+(r * 0.66).toFixed(3), 12, 10), mP, 0, 0, r * 0.30));
    e.add(mesh(sphereGeo(+(r * 0.2).toFixed(3), 8, 6), mat(0xFFFFFF), -r * 0.26, r * 0.28, r * 0.72, 1, 1, 0.45));
    g.add(e);
    return e;
  }
  // 斜眉：inner 为内端压低的程度（正数=愤怒）
  function addBrow(g, s, x, y, z, w, m, tilt) {
    var b = mesh(boxGeo(w, w * 0.24, w * 0.26), m, x, y, z);
    b.rotation.z = s * tilt;
    g.add(b);
    return b;
  }

  // 【可跳】豆包：3D 女孩（按 res/豆包.webp 重制）——棕色齐肩波波头 + 黑圆领上衣 + 领口小银扣，矮，可跳过
  // 照片里读到的特征：白皙鹅蛋脸、近黑棕的大眼（上睫毛浓、下睫毛短）、细弧眉、
  // 几乎没有鼻梁的小鼻头、豆沙色小嘴、颧骨淡腮红、深棕内扣波波头到下巴、黑上衣圆领下一枚银扣。
  // 照片只拍到胸口，以下按同一风格补全（黑短裤 + 光腿 + 深色小皮鞋）。
  OB.bun = function () {
    // AI 网格版：res/ref3d/doubao.png → 图生 3D（原图只有头肩，这张是补出来的全身）
    //
    // ⚠ 这里的 hx/hz 曾经照抄旧手写模型的 0.66 / 0.88，那是给一个"胖墩"留的判定。
    // AI 模型实测世界尺寸只有 宽 0.48 × 高 1.90 × 深 0.41，按身高 1.49 缩放后
    // 视觉半宽 0.24、半深 0.21 —— 判定深 1.76 米比模型宽出 1.35 米，
    // 玩家看着豆包已经跑到身后了，判定还锁着，这就是"明明跳过去了还是撞"的直接原因。
    // 现按真实包围盒重算并留 5~6 厘米宽容：半宽 0.30、半深 0.26。
    //  从这里往下是第 5 版的关键修改：豆包按 1.05 米重定尺寸。
    //  理由不是"为了让它能跳而不择手段"，而是它的人设本来就是矮个——
    //  之前被定成 1.49 米只是因为 GLB 出来多大就直接用多大，没人看过它该多高。
    //  1.49 米意味着脚底要抬到 1.43 才算越过，而整条抛物线只有峰值附近 0.3 秒在 1.43 以上；
    //  1.05 米把这个数降到 1.00，能过头的时间段直接翻倍。
    //  玩家 1.45 米、豆包 1.05 米，从她头顶跳过去看着就是「跨过一个小家伙」，不违和。
    if (USE_GLB_ACTORS) {
      var a = glbActor('ACTOR_DOUBAO', { h: 1.05, hitH: 1.00, hx: 0.22, hz: 0.19, name: '豆包' });
      if (a) return a;
    }
    var g = new T.Group();
    var U = sphereGeo(1, 20, 16);
    var U2 = sphereGeo(1, 14, 11);   // 五官等小件用低面数球，省三角面
    var skinM = mat(0xFBE2D2), skinD = mat(0xF3CBB8);
    var hairM = mat(0x3E2A20), hairL = mat(0x523B2C);
    var hairShell = mat(0x3E2A20, { side: T.DoubleSide });
    var topM = mat(0x1E1E22), topD = mat(0x2B2B31);
    var irisM = mat(0x2E1F17), lashM = mat(0x2A1D16), browM = mat(0x422B1E);
    var lipM = mat(0xD28C83), lipD = mat(0xB87068), blushM = mat(0xF9D6C9);
    var shoeM = mat(0x2A262E), silverM = mat(0xD9DEE4), whiteM = mat(0xFFFDF8);

    /* ---- 小皮鞋 + 腿 ---- */
    [-0.060, 0.060].forEach(function (x) {
      g.add(capsule(x, 0.288, 0.004, x, 0.070, 0.004, 0.042, skinM));
      g.add(mesh(U, shoeM, x, 0.030, 0.026, 0.058, 0.033, 0.076));
    });

    /* ---- 黑短裙 ---- */
    g.add(mesh(cylGeo(0.100, 0.128, 0.180, 18), topD, 0, 0.368, 0));

    /* ---- 上衣：圆领黑 T ---- */
    g.add(mesh(U, topM, 0, 0.545, 0, 0.143, 0.181, 0.117));
    var collar = mesh(torusGeo(0.047, 0.0070, 20), topD, 0, 0.7025, 0.004);
    collar.rotation.x = Math.PI / 2;
    g.add(collar);
    // 领口下那枚小银扣
    g.add(mesh(sphereGeo(0.013, 8, 8), silverM, 0.004, 0.630, 0.088));

    /* ---- 手臂 + 手 ---- */
    [-1, 1].forEach(function (s) {
      g.add(capsule(s * 0.100, 0.676, 0.000, s * 0.137, 0.614, 0.004, 0.049, topM));
      g.add(capsule(s * 0.138, 0.604, 0.006, s * 0.156, 0.398, 0.030, 0.0315, skinM));
      g.add(mesh(U2, skinM, s * 0.156, 0.376, 0.036, 0.035, 0.039, 0.032));
    });

    /* ---- 脖子 + 头 ---- */
    g.add(mesh(cylGeo(0.032, 0.036, 0.085, 14), skinM, 0, 0.722, 0));
    g.add(mesh(U, skinM, 0, 0.885, 0, 0.145, 0.157, 0.138));
    [-1, 1].forEach(function (s) {
      g.add(mesh(U2, skinM, s * 0.140, 0.868, -0.012, 0.015, 0.026, 0.021));
    });

    /* ---- 眼睛：眼白 + 近黑棕瞳 + 双高光 + 上下睫毛 ---- */
    var lashU = geo('dBunLashU', function () { return new T.TorusGeometry(0.0388, 0.0033, 5, 16, Math.PI * 0.46); });
    [-1, 1].forEach(function (s) {
      var e = new T.Group();
      e.position.set(s * 0.063, 0.886, 0.118);
      e.rotation.y = s * 0.11;
      e.add(mesh(U2, whiteM, 0, 0, 0, 0.0405, 0.0450, 0.0235));
      e.add(mesh(U2, irisM, 0, -0.001, 0.012, 0.0285, 0.0330, 0.014));
      e.add(mesh(sphereGeo(0.0086, 8, 8), whiteM, -0.010, 0.014, 0.022, 1, 1, 0.55));
      e.add(mesh(sphereGeo(0.0052, 6, 6), whiteM, 0.011, -0.012, 0.023, 1, 1, 0.55));
      var lu = new T.Mesh(lashU, lashM);
      lu.position.set(0, -0.003, 0.013);
      lu.rotation.z = Math.PI * 0.27;
      lu.scale.set(1, 1.12, 1);
      e.add(lu);
      g.add(e);
    });

    /* ---- 细弧眉（两侧弧度镜像对称） ---- */
    var browG = geo('dBunBrow', function () { return new T.TorusGeometry(0.048, 0.0058, 5, 14, Math.PI * 0.46); });
    [-1, 1].forEach(function (s) {
      var br = new T.Mesh(browG, browM);
      br.position.set(s * 0.063, 0.9215, 0.103);
      br.rotation.z = Math.PI * 0.27;   // 弧关于竖直轴对称，两侧无需镜像
      br.scale.set(1, 0.60, 1);
      g.add(br);
    });

    /* ---- 小鼻头 · 小嘴 · 腮红 ---- */
    g.add(mesh(U2, mat(0xF7D8C6), 0, 0.8565, 0.1325, 0.0092, 0.0074, 0.0078));
    g.add(mesh(U2, lipD, 0, 0.8265, 0.1238, 0.0205, 0.0019, 0.005));
    g.add(mesh(U2, lipM, 0, 0.8185, 0.1232, 0.0195, 0.0058, 0.0070));
    [-1, 1].forEach(function (s) {
      g.add(mesh(U2, blushM, s * 0.100, 0.857, 0.0945, 0.026, 0.0145, 0.0052));
    });

    /* ---- 头发：后脑壳 + 头顶 + 侧发 + 刘海 ---- */
    // 后脑勺与两侧（前方 100° 开口露脸）
    var back = new T.Mesh(
      geo('dBunHairBack', function () { return new T.SphereGeometry(1, 28, 18, Math.PI * 0.78, Math.PI * 1.44, 0, Math.PI * 0.94); }),
      hairShell
    );
    back.position.set(0, 0.882, -0.010);
    back.scale.set(0.170, 0.181, 0.158);
    g.add(back);
    // 头顶（前沿抬起 = 发际线，露出额头）
    var crown = new T.Mesh(
      geo('dBunHairCrown', function () { return new T.SphereGeometry(1, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.36); }),
      hairShell
    );
    crown.position.set(0, 0.885, -0.006);
    crown.scale.set(0.1525, 0.1650, 0.1455);
    crown.rotation.x = -0.12;
    g.add(crown);
    // 两侧垂到下巴的侧发（框住脸，同时盖住发壳接缝）
    [-1, 1].forEach(function (s) {
      var lock = mesh(U2, hairM, s * 0.151, 0.844, 0.010, 0.030, 0.108, 0.072);
      lock.rotation.z = -s * 0.05;
      lock.rotation.y = s * 0.16;
      g.add(lock);
    });

    // 放大到约 1.49 高，碰撞盒同步抬到 1.47。
    // 【可跳】判定顶 1.47 < 跳跃上限 1.80，起步速度下容错约 1.15 米 —— 是全场最好跳的一只。
    g.scale.setScalar(1.42);
    // 手写兜底：判定顶必须与 GLB 版一致（1.00）。以前这里是给 1.49 米版本留的 1.47，
    // 一旦 GLB 解析失败回落到这条路径，同一个角色的难度就悄悄变了。
    return { obj: g, hit: { y0: 0, y1: 1.00, hx: 0.30, hz: 0.26 }, name: '豆包' };
  };

  // 【只能躲】牛来：橘红小牛 · 怒眉 + 宽鼻吻（按 res/牛来.webp 重制）——做得比跳跃上限还高
  OB.niulai = function () {
    // AI 网格版：原图带「深渊凝视」文字水印，先用 image-to-image 补了张干净全身图。
    // 生成结果 12,317 面 / 0.50 MB，世界尺寸 宽 1.27 × 高 1.90 × 深 1.45，正面站姿。
    // 身高 1.96（第一版 1.37 → 1.72 → 1.96），宽 1.31 / 深 1.49。
    // 定位从「矮、可跳」改成「挡路、只能躲」：
    //   跳跃最高点是 1.80，判定顶给到 1.88 —— 差 8 厘米，怎么跳都过不去。
    //   模型本身也做到 1.96，不是只把判定偷偷抬上去：
    //   不然玩家看着一块 1.72 米的牛，脚明明高过它头顶却撞死，会以为是 bug。
    // hx/hz 按 1.72→1.96 等比放大（0.62 → 0.66 / 0.72），判定仍比视觉略窄，擦边宽容。
    if (USE_GLB_ACTORS) {
      var a = glbActor('ACTOR_NIULAI', { h: 1.96, hitH: 1.88, hx: 0.66, hz: 0.72, name: '牛来' });
      if (a) return a;
    }
    var g = new T.Group();
    var U = sphereGeo(1, 18, 14);
    var hide = mat(0xC25C2E);      // 橘红牛皮
    var hideD = mat(0xA1461E);     // 暗部
    var belly = mat(0xE7B69C);
    var muzzle = mat(0xEFC9B8);    // 灰粉口鼻
    var nosM = mat(0xAC7A66);
    var hornM = mat(0xE9D8BE);
    var earIn = mat(0xDE8C74);
    var darkM = mat(0x37261C);
    var whiteM = mat(0xFFFBF3);
    var browM = mat(0x5E2C13);

    // 四条短腿
    [-0.29, 0.29].forEach(function (x) {
      [-0.28, 0.28].forEach(function (z) {
        g.add(mesh(cylGeo(0.115, 0.125, 0.34, 9), hideD, x, 0.18, z));
        g.add(mesh(cylGeo(0.135, 0.135, 0.09, 9), darkM, x, 0.045, z));
      });
    });
    // 身体 + 胸腹
    g.add(mesh(U, hide, 0, 0.60, -0.08, 0.58, 0.46, 0.60));
    g.add(mesh(U, belly, 0, 0.44, 0.30, 0.26, 0.20, 0.16));
    // 大头
    g.add(mesh(U, hide, 0, 0.97, 0.22, 0.50, 0.45, 0.44));
    g.add(mesh(U, hideD, 0, 1.33, 0.09, 0.21, 0.09, 0.19));
    // 宽大口鼻（照片里几乎占满下半张脸）
    g.add(mesh(U, muzzle, 0, 0.80, 0.56, 0.36, 0.235, 0.22));
    [-1, 1].forEach(function (s) {
      g.add(mesh(U, nosM, s * 0.135, 0.795, 0.755, 0.052, 0.042, 0.028));
    });
    g.add(mesh(boxGeo(0.15, 0.016, 0.02), nosM, 0, 0.695, 0.735));
    // 眼 + 怒眉
    [-1, 1].forEach(function (s) {
      addEye(g, s * 0.205, 0.955, 0.585, 0.106, whiteM, darkM, s * 0.12);
      addBrow(g, s, s * 0.205, 1.110, 0.578, 0.232, browM, 0.46);
      // 耳（外张）+ 内耳
      var ear = mesh(U, hideD, s * 0.47, 1.03, 0.14, 0.17, 0.115, 0.085);
      ear.rotation.z = s * 0.28;
      g.add(ear);
      g.add(mesh(U, earIn, s * 0.49, 1.02, 0.18, 0.112, 0.072, 0.045));
      // 短角
      var hn = mesh(coneGeo(0.058, 0.19, 8), hornM, s * 0.225, 1.395, 0.10);
      hn.rotation.z = -s * 0.55;
      g.add(hn);
    });
    // 尾巴
    g.add(mesh(coneGeo(0.05, 0.22, 7), hideD, 0, 0.76, -0.66));
    // 兜底路径也得守同一套规则：牛来是「只能躲」，判定顶必须 1.88 > 跳跃上限 1.80。
    // 手写几何体原本只有 1.26 米，直接把判定抬到 1.88 会凭空多出 0.6 米空气墙，
    // 所以连同模型一起放大到 1.96 —— 和第六轮 GLB 版的做法保持一致。
    g.scale.setScalar(1.96 / 1.26);
    return { obj: g, hit: { y0: 0, y1: 1.88, hx: 0.66, hz: 0.72 }, name: '牛来' };
  };

  // 【只能躲】黑白奶牛：「收到」敬礼站姿（按 res/奶牛.jpeg 重制）——高，必须换道
  OB.cow = function () {
    // AI 网格版：res/ref3d/cow.png（ImageGen 从原图重绘的白底全身图，敬礼姿势保住了）
    // → 图生 3D，8,912 面 / 0.45 MB。模型世界尺寸 宽 1.33 × 高 1.90 × 深 1.51，
    // 按身高 2.00 定标（和旧手写模型同高，保持「最高的一排」的层次）。
    // 【只能躲】hitH 2.00 > 跳跃上限 1.74；hx 0.72 ≈ 视觉半宽 0.70，hz 0.70 < 视觉半深 0.80，
    // 判定不比视觉宽，撞上来时玩家正好贴着牛。
    if (USE_GLB_ACTORS) {
      var a = glbActor('ACTOR_COW', { h: 2.00, hitH: 2.00, hx: 0.72, hz: 0.70, name: '奶牛' });
      if (a) return a;
    }
    var g = new T.Group();
    var U = sphereGeo(1, 18, 14);
    var white = mat(0xFCFAF5);
    var black = mat(0x35353F);
    var pinkM = mat(0xF6C0CA);
    var pinkD = mat(0xD98B9B);
    var hoofM = mat(0x2B2B33);
    var darkM = mat(0x241F1D);
    var cream = mat(0xFFF4E6);

    // 两条腿
    [-0.26, 0.26].forEach(function (x) {
      g.add(mesh(cylGeo(0.16, 0.15, 0.50, 10), white, x, 0.28, -0.05));
      g.add(mesh(cylGeo(0.17, 0.17, 0.14, 10), hoofM, x, 0.07, -0.03));
    });
    // 胖身体 + 黑斑
    g.add(mesh(U, white, 0, 0.88, 0, 0.55, 0.58, 0.47));
    g.add(mesh(U, black, -0.28, 1.02, 0.32, 0.21, 0.22, 0.10));
    g.add(mesh(U, black, 0.34, 0.66, 0.26, 0.15, 0.17, 0.10));
    g.add(mesh(U, black, 0.05, 1.26, -0.26, 0.24, 0.13, 0.12));
    g.add(mesh(U, black, -0.33, 0.58, -0.22, 0.14, 0.16, 0.10));
    // 头 + 黑顶（半球壳贴面）
    g.add(mesh(U, white, 0, 1.70, 0.05, 0.45, 0.41, 0.41));
    g.add(mesh(capGeo(Math.PI * 0.42, 20), black, 0, 1.70, 0.05, 0.455, 0.415, 0.415));
    // 口鼻
    g.add(mesh(U, white, 0, 1.540, 0.30, 0.380, 0.260, 0.270));
    g.add(mesh(U, pinkM, 0, 1.578, 0.475, 0.255, 0.155, 0.125));
    [-1, 1].forEach(function (s) {
      g.add(mesh(U, pinkD, s * 0.095, 1.568, 0.578, 0.048, 0.034, 0.02));
    });
    g.add(mesh(boxGeo(0.19, 0.018, 0.02), pinkD, 0, 1.458, 0.552));
    // 眼 + 怒眉 + 耳 + 角
    [-1, 1].forEach(function (s) {
      addEye(g, s * 0.175, 1.675, 0.428, 0.112, cream, darkM, s * 0.2);
      addBrow(g, s, s * 0.175, 1.800, 0.400, 0.215, black, 0.44);
      var ear = mesh(U, white, s * 0.475, 1.700, 0.000, 0.195, 0.135, 0.085);
      ear.rotation.z = s * 0.62;
      g.add(ear);
      g.add(mesh(U, black, s * 0.545, 1.652, 0.000, 0.062, 0.058, 0.042));
      g.add(mesh(coneGeo(0.060, 0.17, 8), cream, s * 0.235, 2.005, 0.02));
    });
    // 右手举起敬礼（「收到」梗）
    g.add(capsule(-0.34, 1.12, 0.06, -0.52, 1.46, 0.12, 0.105, white));
    g.add(capsule(-0.52, 1.46, 0.12, -0.40, 1.72, 0.16, 0.098, white));
    g.add(mesh(U, hoofM, -0.38, 1.79, 0.17, 0.115, 0.10, 0.115));
    // 左手垂下
    g.add(capsule(0.34, 1.12, 0.06, 0.45, 0.86, 0.04, 0.10, white));
    g.add(mesh(U, hoofM, 0.46, 0.80, 0.04, 0.11, 0.095, 0.11));
    // 尾巴
    g.add(capsule(0, 0.92, -0.46, 0, 0.58, -0.56, 0.035, white));
    g.add(mesh(U, black, 0, 0.54, -0.57, 0.06, 0.075, 0.06));
    return { obj: g, hit: { y0: 0, y1: 2.00, hx: 0.72, hz: 0.70 }, name: '奶牛' };
  };

  // 【可跳】我的刀盾：柴犬趴身 · 一手菜刀一手圆盾（按 res/我的刀盾.jpg 重制）——趴得矮，能跳过去
  OB.shield = function () {
    // AI 网格版：res/ref3d/daodun.png 生成，12,527 面 / 0.59 MB。
    // 原图是趴姿，模型世界尺寸 宽 1.90 × 高 1.44 × 深 1.89（x/y/z），
    // 宽高比 1.32 —— 所以这里用 w（目标全宽）定标，不能给 h：
    // 给 h:1.95 会把宽度放大到 2.58 米，一坨趴地蒲团直接压两条道。
    // 按全宽 2.16（沿用旧判定 hx 1.08 的口径）反推身高 ≈ 1.63，
    // 碰撞盒顶部自动取 1.50 —— 【可跳】1.50 < 跳跃上限 1.80。
    // 判定深 hz 0.72 → 0.42：它是趴姿、纵向 1.44 米，深度直接决定跳它要「在上方待多久」，
    // 0.72 时窗口只有 0.16 秒（人类不可能），0.42 后是 0.32 秒。压掉 0.3 米深度的
    // 代价是碰撞触发点从模型中心前 1.18 米缩到 0.88 米 —— 模型鼻子本来就在前 0.95 米，
    // 撞上来时玩家正好贴着它的脸，看不出判定和视觉的差别。
    //  判定顶 1.50 → 1.05：模型那 1.63 米里，上面小半截是竖起来的菜刀和圆盾，
    //  身子本体（趴着的柴犬）远没那么高。把整根 inbox 都算成"挡路"是不必要的，
    //  玩家从 1.05 米掠过时，视觉上是贴着它的背飞过去，不是穿进身体里。
    if (USE_GLB_ACTORS) {
      var a = glbActor('ACTOR_DAODUN', { w: 2.16, hitH: 1.05, hx: 1.08, hz: OB_HZ.shield || 0.42, name: '刀盾' });
      if (a) return a;
    }
    var g = new T.Group();
    var U = sphereGeo(1, 18, 14);
    var fur = mat(0xBF8E5C), furD = mat(0xA07243), furL = mat(0xD6A876);
    var cream = mat(0xF6E8D2), dark = mat(0x241E1A), noseM = mat(0x1F1A17);
    var steel = mat(0xC9D0D8), steelD = mat(0x8E97A1), edge = mat(0xF2F6FA);
    var handle = mat(0x33291F), plate = mat(0x6E7582), rimM = mat(0x8E9099), emb = mat(0xB9AE8A);

    // 趴在地上的肥身体 + 屁股
    g.add(mesh(U, fur, 0, 0.42, -0.14, 0.56, 0.38, 0.50));
    g.add(mesh(U, fur, 0, 0.32, -0.48, 0.40, 0.30, 0.30));
    // 胸口浅毛
    g.add(mesh(U, cream, 0, 0.165, 0.330, 0.215, 0.100, 0.155));
    // 头（比身体还大，Q 版）
    g.add(mesh(U, fur, 0, 0.80, 0.30, 0.50, 0.46, 0.46));
    // 两侧白腮毛（柴犬标志，贴在脸颊外侧）
    [-1, 1].forEach(function (s) {
      g.add(mesh(U, cream, s * 0.300, 0.645, 0.615, 0.145, 0.115, 0.095));
    });
    // 眉心浅色
    g.add(mesh(U, furL, 0, 0.985, 0.745, 0.145, 0.095, 0.070));
    // 吻部 + 鼻 + 嘴
    g.add(mesh(U, cream, 0, 0.660, 0.735, 0.205, 0.135, 0.150));
    g.add(mesh(U, noseM, 0, 0.700, 0.870, 0.075, 0.055, 0.048));
    g.add(mesh(boxGeo(0.075, 0.018, 0.02), noseM, 0, 0.612, 0.868));
    // 眼（黑豆、略下垂）+ 高光 + 白眉点
    [-1, 1].forEach(function (s) {
      g.add(mesh(U, dark, s * 0.165, 0.860, 0.725, 0.058, 0.060, 0.048));
      g.add(mesh(sphereGeo(0.018, 6, 6), mat(0xFFFFFF), s * 0.185, 0.884, 0.755, 1, 1, 0.5));
      g.add(mesh(U, mat(0xFFFCF4), s * 0.145, 0.950, 0.706, 0.050, 0.033, 0.028));
    });
    // 立耳
    [-1, 1].forEach(function (s) {
      var ear = mesh(coneGeo(0.108, 0.235, 6), furD, s * 0.235, 1.150, 0.400);
      ear.rotation.z = -s * 0.34;
      ear.rotation.x = -0.16;
      g.add(ear);
      var earIn = mesh(coneGeo(0.062, 0.140, 6), cream, s * 0.235, 1.140, 0.440);
      earIn.rotation.z = -s * 0.34;
      earIn.rotation.x = -0.16;
      g.add(earIn);
    });
    // 前爪撑地
    [-1, 1].forEach(function (s) {
      g.add(mesh(U, cream, s * 0.310, 0.070, 0.400, 0.130, 0.075, 0.175));
      [-1, 0, 1].forEach(function (k) {
        g.add(mesh(U, cream, s * 0.310 + k * 0.054, 0.045, 0.535, 0.028, 0.026, 0.033));
      });
    });
    /* ---- 菜刀（左） ---- */
    var ax = -0.760;
    g.add(capsule(-0.440, 0.400, 0.060, ax + 0.02, 0.800, 0.140, 0.092, fur));
    g.add(mesh(U, cream, ax + 0.02, 0.845, 0.150, 0.100, 0.088, 0.100));
    g.add(mesh(cylGeo(0.048, 0.048, 0.26, 8), handle, ax, 0.985, 0.150));
    var blade = new T.Group();
    blade.position.set(ax, 1.510, 0.150);
    blade.rotation.y = 0.22;
    blade.add(mesh(boxGeo(0.380, 0.720, 0.075), steel, 0, 0, 0));
    blade.add(mesh(boxGeo(0.052, 0.720, 0.088), steelD, -0.180, 0, 0));
    blade.add(mesh(boxGeo(0.034, 0.720, 0.092), edge, 0.180, 0, 0));
    var tip = mesh(boxGeo(0.250, 0.170, 0.075), steel, 0.060, 0.330, 0);
    tip.rotation.z = 0.6;
    blade.add(tip);
    // 刀面高光斜条
    var hl = mesh(boxGeo(0.055, 0.560, 0.010), edge, -0.075, 0.010, 0.042);
    hl.rotation.z = 0.16;
    blade.add(hl);
    g.add(blade);
    /* ---- 圆盾（右） ---- */
    var bx = 0.860;
    g.add(capsule(0.440, 0.400, 0.060, bx - 0.02, 0.820, 0.120, 0.090, fur));
    g.add(mesh(U, cream, bx - 0.02, 0.860, 0.130, 0.100, 0.088, 0.100));
    g.add(mesh(U, plate, bx, 1.150, 0.080, 0.360, 0.420, 0.058));
    var rim = mesh(torusGeo(0.360, 0.042, 22), rimM, bx, 1.150, 0.090, 1, 1.16, 1);
    g.add(rim);
    g.add(mesh(boxGeo(0.050, 0.560, 0.045), rimM, bx, 1.150, 0.135));
    g.add(mesh(boxGeo(0.420, 0.050, 0.045), rimM, bx, 1.150, 0.135));
    g.add(mesh(U, emb, bx, 1.150, 0.145, 0.095, 0.095, 0.045));
    // 同上：判定顶跟 GLB 版对齐成 1.05。旧值 1.95 会让「可跳」的刀盾在兜底路径下
    // 变成绝对跳不过 —— OB_JUMPABLE 说能跳，实际撞死，玩家只会当成游戏有 bug。
    return { obj: g, hit: { y0: 0, y1: 1.05, hx: 1.08, hz: 0.55 }, name: '刀盾' };
  };

  // 【只能躲】噜噜：水豚 · 头顶橘子 + 芒果色大鼻吻 + 半眯眼（按 res/噜噜.webp 重制）——高，必须换道
  OB.lulu = function () {
    // AI 网格版：原图是 3/4 视角半身，下半身被橘子色裤子挡住，模型腿部会略糊
    if (USE_GLB_ACTORS) {
      var a = glbActor('ACTOR_LULU', { h: 2.06, hitH: 1.90, hx: 0.74, hz: 0.70, name: '噜噜' });
      if (a) return a;
    }
    var g = new T.Group();
    var U = sphereGeo(1, 18, 14);
    var skin = mat(0xF6C64F);      // 芒果黄
    var skinD = mat(0xE3B040);
    var snout = mat(0xEE9C2C);     // 橘黄大鼻吻
    var snoutD = mat(0xD07F1B);
    var pants = mat(0xE88654), pantsD = mat(0xCE6E3E);
    var orange = mat(0xF08A20), leaf = mat(0x7FAE4C);
    var dark = mat(0x33302A), whiteM = mat(0xFFFFFF);

    // 四条短腿
    [-0.28, 0.28].forEach(function (x) {
      [-0.24, 0.24].forEach(function (z) {
        g.add(mesh(cylGeo(0.125, 0.115, 0.30, 9), skinD, x, 0.16, z));
        g.add(mesh(U, skinD, x, 0.04, z + 0.02, 0.13, 0.055, 0.15));
      });
    });
    // 身体
    g.add(mesh(U, skin, 0, 0.80, 0, 0.58, 0.56, 0.52));
    // 短裤
    g.add(mesh(cylGeo(0.56, 0.58, 0.32, 18), pants, 0, 0.44, 0));
    g.add(mesh(cylGeo(0.58, 0.58, 0.06, 18), pantsD, 0, 0.60, 0));
    [-0.17, 0.17].forEach(function (x) {
      g.add(mesh(cylGeo(0.155, 0.170, 0.20, 12), pants, x, 0.30, 0.01));
    });
    // 头（与身体几乎连成一颗蛋）
    g.add(mesh(U, skin, 0, 1.34, 0.04, 0.45, 0.43, 0.41));
    // 大鼻吻（照片里是半张脸的橘色方块）
    g.add(mesh(U, snout, 0, 1.155, 0.330, 0.375, 0.250, 0.250));
    g.add(mesh(U, snout, 0, 1.040, 0.310, 0.320, 0.150, 0.220));
    [-1, 1].forEach(function (s) {
      g.add(mesh(U, snoutD, s * 0.105, 1.258, 0.552, 0.048, 0.034, 0.022));
    });
    g.add(mesh(boxGeo(0.19, 0.018, 0.02), snoutD, 0, 1.075, 0.545));
    // 半眯眼：眼球 + 上眼皮压下来
    [-1, 1].forEach(function (s) {
      g.add(mesh(U, whiteM, s * 0.205, 1.425, 0.335, 0.088, 0.050, 0.070));
      g.add(mesh(U, dark, s * 0.205, 1.418, 0.392, 0.052, 0.036, 0.040));
      g.add(mesh(sphereGeo(0.014, 6, 6), whiteM, s * 0.222, 1.434, 0.420, 1, 1, 0.5));
      // 小圆耳
      g.add(mesh(U, skinD, s * 0.375, 1.545, 0.060, 0.095, 0.080, 0.060));
    });
    // 头顶橘子
    g.add(mesh(U, orange, 0, 1.85, 0.02, 0.115, 0.11, 0.115));
    g.add(mesh(cylGeo(0.014, 0.016, 0.05, 6), mat(0x7A5A32), 0, 1.955, 0.02));
    var lf = mesh(U, leaf, 0.06, 1.96, 0.02, 0.055, 0.018, 0.032);
    lf.rotation.z = -0.5;
    g.add(lf);
    // 尾巴
    g.add(mesh(U, skinD, 0, 0.62, -0.55, 0.07, 0.07, 0.06));
    return { obj: g, hit: { y0: 0, y1: 1.90, hx: 0.74, hz: 0.70 }, name: '噜噜' };
  };

  // 【只能躲】猪猪侠：红色连体衣 + 红头盔 + 猪鼻（按 res/猪猪侠.jpeg 重制）——高，必须换道
  OB.pigman = function () {
    // AI 网格版：原图纯白底、正面全身，是这批里第二好的参考图
    if (USE_GLB_ACTORS) {
      var a = glbActor('ACTOR_ZHUZHUXIA', { h: 2.15, hitH: 1.98, hx: 0.74, hz: 0.64, name: '猪猪侠' });
      if (a) return a;
    }
    var g = new T.Group();
    var U = sphereGeo(1, 18, 14);
    var red = mat(0xE23B2E), redD = mat(0xB92A20), redL = mat(0xF15A48);
    var skin = mat(0xFFD9C4);       // 浅肉粉脸
    var pink = mat(0xF7A8B8), pinkD = mat(0xD07186);
    var yellow = mat(0xFFD23F), yellowD = mat(0xE0AE1E);
    var dark = mat(0x2A1F1B), whiteM = mat(0xFFFFFF);
    var blush = mat(0xF79BA8);

    // 腿 + 靴
    [-0.24, 0.24].forEach(function (x) {
      g.add(mesh(cylGeo(0.155, 0.145, 0.32, 10), red, x, 0.24, 0));
      g.add(mesh(cylGeo(0.150, 0.155, 0.14, 10), redD, x, 0.17, 0));
      g.add(mesh(U, redD, x, 0.075, 0.04, 0.165, 0.100, 0.200));
    });
    // 身体
    g.add(mesh(U, red, 0, 0.80, 0, 0.54, 0.56, 0.46));
    // 胸前猪鼻标志
    g.add(mesh(U, yellow, 0, 0.98, 0.40, 0.13, 0.105, 0.05));
    g.add(mesh(U, redD, -0.045, 0.98, 0.445, 0.028, 0.038, 0.02));
    g.add(mesh(U, redD, 0.045, 0.98, 0.445, 0.028, 0.038, 0.02));
    // 手臂（黄护腕 + 红手套）
    [-1, 1].forEach(function (s) {
      g.add(capsule(s * 0.44, 1.05, 0.04, s * 0.56, 0.74, 0.06, 0.105, red));
      g.add(mesh(cylGeo(0.125, 0.125, 0.09, 12), yellow, s * 0.555, 0.72, 0.06));
      g.add(mesh(U, redD, s * 0.57, 0.62, 0.07, 0.115, 0.10, 0.115));
    });
    // 头（白嫩脸）
    g.add(mesh(U, skin, 0, 1.50, 0.04, 0.46, 0.44, 0.42));
    // 红头盔：半球壳 + 两侧护耳
    g.add(mesh(capGeo(Math.PI * 0.34, 22), red, 0, 1.505, 0.04, 0.478, 0.458, 0.438));
    [-1, 1].forEach(function (s) {
      g.add(mesh(U, red, s * 0.425, 1.50, 0.03, 0.105, 0.205, 0.175));
      g.add(mesh(U, redL, s * 0.425, 1.575, 0.145, 0.070, 0.105, 0.085));
    });
    // 头盔正面黄色眼形装饰
    [-1, 1].forEach(function (s) {
      var dec = mesh(U, yellow, s * 0.150, 1.855, 0.355, 0.115, 0.045, 0.042);
      dec.rotation.z = s * 0.34;
      g.add(dec);
    });
    g.add(mesh(U, redD, 0, 1.90, 0.10, 0.05, 0.05, 0.05));
    // 白猪耳
    [-1, 1].forEach(function (s) {
      var ear = mesh(coneGeo(0.115, 0.20, 7), skin, s * 0.385, 1.795, 0.085, 1, 1, 0.62);
      ear.rotation.z = s * 0.55;
      g.add(ear);
    });
    // 猪鼻
    g.add(mesh(U, pink, 0, 1.35, 0.44, 0.205, 0.155, 0.135));
    [-1, 1].forEach(function (s) {
      g.add(mesh(U, pinkD, s * 0.072, 1.345, 0.555, 0.045, 0.052, 0.022));
    });
    // 眼 + 眉 + 腮红
    [-1, 1].forEach(function (s) {
      addEye(g, s * 0.175, 1.58, 0.375, 0.105, whiteM, dark, s * 0.16);
      addBrow(g, s, s * 0.175, 1.700, 0.448, 0.152, dark, 0.20);
      g.add(mesh(U, blush, s * 0.335, 1.40, 0.325, 0.10, 0.075, 0.05));
    });
    // 微笑
    var mouth = mesh(torusGeo(0.085, 0.014, 14), pinkD, 0, 1.245, 0.44, 1, 0.6, 1);
    mouth.rotation.x = Math.PI * 0.5;
    g.add(mouth);
    return { obj: g, hit: { y0: 0, y1: 1.98, hx: 0.74, hz: 0.64 }, name: '猪猪侠' };
  };

  // 横杆：必须下蹲
  OB.bar = function () {
    var g = new T.Group();
    var post = mat(0xFFF3D6), stripeA = mat(0xFFB3C8), stripeB = mat(0xFFF6E0);
    [-3.65, 3.65].forEach(function (x) {
      g.add(mesh(cylGeo(0.14, 0.14, 3.0, 8), post, x, 1.5, 0));
      g.add(mesh(sphereGeo(0.2, 10, 8), stripeA, x, 3.05, 0));
    });
    for (var i = 0; i < 10; i++) {
      g.add(mesh(boxGeo(0.745, 0.5, 0.44), i % 2 === 0 ? stripeA : stripeB, -3.35 + i * 0.745, 1.68, 0));
    }
    g.add(mesh(boxGeo(7.5, 0.1, 0.52), mat(0xFFFFFF), 0, 1.38, 0));
    return { obj: g, hit: { y0: 1.3, y1: 2.95, hx: 3.9, hz: 0.45 }, name: '横杆' };
  };

  var OB_KEYS = ['bun', 'niulai', 'cow', 'shield', 'lulu', 'pigman'];

  // 哪些障碍「跳得过去」，只有这两个 —— 其余一律只能换道躲开。
  // 这条规则是显式的，不再靠 hit.y1 <= 1.80 反推：
  // 靠高度推断的话，只要有人调了跳跃参数或模型身高，能不能跳就悄悄变了。
  // 可跳的两个共同点：身高都在 1.7 米以下（豆包 1.49、刀盾 1.63），
  // 而跳不过的全在 1.9 米以上 —— 玩家凭大小就能判断该跳还是该躲。
  var OB_JUMPABLE = { bun: true, shield: true, niulai: false, cow: false, lulu: false, pigman: false };

  /* ---------------- 奶龙 & buff ---------------- */
  function buildEgg() {
    // AI 网格版：奶龙（收集物）。原图是全体型正面站姿，是这批里最好的一张参考图
    if (USE_GLB_ACTORS) {
      var a = glbActor('ACTOR_NAILONG', { h: 0.74, hitK: 0.9, name: '奶龙' });
      if (a) return a.obj;
    }
    var g = new T.Group();
    var U = sphereGeo(1, 16, 12);
    var gold = mat(0xFFD23F), goldD = mat(0xEFB92A), lite = mat(0xFFEBB4);
    var horn = mat(0xFFE9A8), dark = mat(0x33302C), blushM = mat(0xFFB49E);
    var whiteM = mat(0xFFFFFF);
    // 头身一体的胖蛋身
    g.add(mesh(U, gold, 0, 0, 0, 0.300, 0.325, 0.290));
    // 浅色肚皮
    g.add(mesh(U, lite, 0, -0.060, 0.130, 0.215, 0.210, 0.170));
    // 头顶两只小圆角
    [-1, 1].forEach(function (s) {
      g.add(mesh(U, horn, s * 0.125, 0.288, 0.010, 0.045, 0.062, 0.045));
    });
    // 背脊小刺
    [0.145, 0.020, -0.105].forEach(function (y, i) {
      var sp = mesh(coneGeo(+(0.045 - i * 0.006).toFixed(3), 0.09, 6), goldD, 0, y, -0.250 + i * 0.014);
      sp.rotation.x = -0.55;
      g.add(sp);
    });
    // 大圆眼 + 腮红
    [-1, 1].forEach(function (s) {
      addEye(g, s * 0.135, 0.075, 0.212, 0.098, whiteM, dark, s * 0.12);
      g.add(mesh(U, blushM, s * 0.205, -0.048, 0.212, 0.050, 0.034, 0.028));
    });
    // 小嘴
    g.add(mesh(boxGeo(0.085, 0.020, 0.02), mat(0x8A6A3C), 0, -0.082, 0.272));
    // 短手短脚
    [-1, 1].forEach(function (s) {
      g.add(mesh(U, gold, s * 0.278, -0.115, 0.030, 0.058, 0.062, 0.055));
      g.add(mesh(U, gold, s * 0.118, -0.285, 0.055, 0.078, 0.048, 0.092));
      // 小翅膀
      g.add(mesh(U, goldD, s * 0.300, 0.010, -0.095, 0.055, 0.115, 0.150));
    });
    // 粗尾巴（上翘）
    var tail = mesh(coneGeo(0.062, 0.24, 8), gold, 0, -0.135, -0.320);
    tail.rotation.x = 0.85;
    g.add(tail);
    return g;
  }

  var EGG_GEO = null;

  function buildBuff(type) {
    var g = new T.Group();
    if (type === 'shield') {
      g.add(mesh(sphereGeo(0.3, 14, 10), new T.MeshLambertMaterial({ color: 0x9FE8FF }), 0, 0, 0));
      var ring = mesh(torusGeo(0.36, 0.04, 20), matB(0xFFFFFF, 0.9), 0, 0, 0);
      g.add(ring);
      g.add(mesh(sphereGeo(0.13, 10, 8), matB(0xFFFFFF, 0.95), 0, 0.05, 0.24, 1, 1, 0.5));
    } else if (type === 'boost') {
      g.add(mesh(coneGeo(0.24, 0.5, 8), mat(0xFF9F43), 0, 0.1, 0));
      g.add(mesh(coneGeo(0.14, 0.3, 8), mat(0xFFE07A), 0, -0.18, 0));
      g.add(mesh(sphereGeo(0.1, 8, 6), matB(0xFFFFFF, 0.9), 0, 0.3, 0.2, 1, 1, 0.4));
    } else {
      g.add(mesh(torusGeo(0.24, 0.09, 16), mat(0xFF7FA8), 0, 0.02, 0, 1, 1, 1));
      g.add(mesh(boxGeo(0.1, 0.22, 0.1), mat(0xFF7FA8), -0.24, 0.14, 0));
      g.add(mesh(boxGeo(0.1, 0.22, 0.1), mat(0xFF7FA8), 0.24, 0.14, 0));
    }
    var halo = new T.Mesh(sphereGeo(0.5, 12, 10), matB(0xFFFFFF, 0.16));
    halo.scale.set(1, 1, 1);
    g.add(halo);
    return g;
  }

  /* ---------------- 起跳提示 ---------------- */
  // 窗口再宽，玩家在屏幕上也量不出「还有几米」。所以把窗口直接画出来：
  // 可跳障碍进入「此刻起跳刚好能过」的距离区间时，它脚下亮一个绿色箭头，看到就按。
  // 这不是降低难度，是把玩家本来就得心算的东西可视化。
  var CUE_GEO = null;
  function buildJumpCue() {
    var g = new T.Group();
    // matB 是缓存共享的，这里必须新建材质：要逐帧改 opacity，共享会污染别处
    var mRing = new T.MeshBasicMaterial({ color: 0x5CFFA8, transparent: true, opacity: 0.9, depthWrite: false });
    var mCone = new T.MeshBasicMaterial({ color: 0xD6FFE9, transparent: true, opacity: 0.95, depthWrite: false });
    if (!CUE_GEO) CUE_GEO = { ring: new T.RingGeometry(0.60, 0.78, 28), cone: new T.ConeGeometry(0.25, 0.50, 14) };
    var ring = new T.Mesh(CUE_GEO.ring, mRing);
    ring.rotation.x = -Math.PI / 2;
    g.add(ring);
    var cone = new T.Mesh(CUE_GEO.cone, mCone);
    cone.position.y = 0.30;
    g.add(cone);
    g.position.y = 0.04;
    g.visible = false;
    g.userData.mRing = mRing;
    g.userData.mCone = mCone;
    return g;
  }

  /* 障碍头顶的「可跳」箭头：半透明绿色，浮在障碍正上方轻轻起伏。
     它和脚下的圆环是两个信号，别混为一谈：
       · 头顶箭头 = 「这个能跳」——远远就挂着，用来分类，任何距离、任何道都显示；
       · 脚下圆环 = 「现在按」  ——只在起跳窗口内、且在本道时亮（updateJumpCue）。
     玩家先靠箭头认出目标，再靠圆环抓时机，两件事分开做才不会互相干扰。 */
  var ARROW_GEO = null;
  function buildJumpArrow() {
    if (!ARROW_GEO) {
      ARROW_GEO = {
        shaft: new T.BoxGeometry(0.17, 0.32, 0.17),
        head: new T.ConeGeometry(0.30, 0.42, 16)
      };
    }
    var g = new T.Group();
    // 同样必须新建材质：要逐帧改 opacity，共享的 matB 会被污染
    var m = new T.MeshBasicMaterial({
      color: 0x35F08A, transparent: true, opacity: 0.34,
      depthWrite: false, side: T.DoubleSide
    });
    var shaft = new T.Mesh(ARROW_GEO.shaft, m);
    shaft.position.y = 0.16;                 // 杆：0 → 0.32
    g.add(shaft);
    var head = new T.Mesh(ARROW_GEO.head, m);
    head.position.y = 0.53;                  // 头：0.32 → 0.74
    g.add(head);
    g.userData.mat = m;
    return g;
  }

  // 返回「现在起跳能过」的距离区间 [lo, hi]（米），算不出来返回 null。
  // 和 simJump 跑出来的一致——两者共用同一套 V/G/hit，改参数时不会漂移。
  function jumpCueRange(e, v) {
    var yNeed = Math.max(0, e.hit.y1 - JUMP_CLEAR_EPS);
    var disc = CFG.JUMP_V * CFG.JUMP_V - 2 * CFG.GRAVITY * yNeed;
    if (disc <= 0) return null;                       // 抛物线根本够不着
    var s = Math.sqrt(disc);
    var t1 = (CFG.JUMP_V - s) / CFG.GRAVITY;          // 升到有效高度的最早时刻
    var t2 = (CFG.JUMP_V + s) / CFG.GRAVITY;          // 掉回该高度的最晚时刻
    var half = e.hit.hz + HIT.halfZ;
    var span = 2 * half / Math.max(v, 0.001);         // 穿越判定区需要的时间
    if (span >= t2 - t1) return null;                 // 怎么跳都来不及
    return { lo: t1 * v + half, hi: (t2 - span) * v + half };
  }

  function updateJumpCue(e, dt) {
    if (!e.cue) return;
    var sameLane = Math.abs(e.obj.position.x - player.x) < 0.75;
    var r = jumpCueRange(e, Math.max(G.speed, 1));
    var d = -e.z;
    var on = !!r && sameLane && !e.dead && d >= r.lo && d <= r.hi &&
             G.phase === 'playing' && player.grounded;
    if (on) e.cueT = (e.cueT || 0) + dt; else e.cueT = 0;
    e.cue.visible = on;
    if (!on) return;
    var pulse = 0.55 + 0.45 * Math.sin(e.cueT * 13);
    e.cue.userData.mRing.opacity = 0.35 + 0.55 * pulse;
    e.cue.userData.mCone.opacity = 0.45 + 0.50 * pulse;
    e.cue.position.y = 0.04 + 0.10 * pulse;
  }

  function updateJumpArrow(e, dt) {
    if (!e.arrow) return;
    var d = -e.z;
    // 离得太近就淡出：玩家马上要从箭头位置穿过去了，糊在脸上反而挡视线
    var show = !e.dead && G.phase === 'playing' && d > 1.0 && d < 34;
    e.arrow.visible = show;
    if (!show) return;
    var nearFade = Math.min(1, (d - 1.0) / 1.8);
    var go = !!(e.cue && e.cue.visible);          // 已进起跳窗口 → 强调
    e.arrowT = (e.arrowT || 0) + dt * (go ? 2.1 : 1.0);
    var pulse = 0.5 + 0.5 * Math.sin(e.arrowT * (go ? 11 : 4.6));
    // 三档亮度：窗口内最亮（按！）> 平时（能跳）> 人在空中（暗下去，按了也没用）
    var base = go ? 0.60 : (player.grounded ? 0.30 : 0.14);
    e.arrowMat.opacity = (base + (go ? 0.30 : 0.10) * pulse) * nearFade;
    var s = (go ? 1.06 : 0.94) + (go ? 0.10 : 0.03) * pulse;
    e.arrow.scale.set(s, s, s);
    e.arrow.position.y = e.arrowY0 + Math.sin(e.arrowT * 3) * (go ? 0.12 : 0.06);
  }

  /* ---------------- 生成物 ---------------- */
  function addEntity(obj, kind, z, extra) {
    obj.position.z = z;
    scene.add(obj);
    var e = { obj: obj, kind: kind, z: z, dead: false, t: Math.random() * 6 };
    if (extra) { for (var k in extra) e[k] = extra[k]; }
    entities.push(e);
    return e;
  }

  function spawnObstacle(type, lane) {
    var o = OB[type]();
    o.obj.position.x = CFG.LANES[lane];
    var e = addEntity(o.obj, 'obstacle', CFG.SPAWN_Z, {
      hit: o.hit,
      name: o.name,
      jumpable: OB_JUMPABLE[type] === true,
      kind0: type
    });
    e.obj.userData.ent = e;
    // 可跳的两件提示：脚下圆环管「现在按」，头顶箭头管「这个能跳」
    if (OB_JUMPABLE[type] === true) {
      // 先量模型，再挂东西 —— 否则包围盒里会算进提示自己
      o.obj.updateMatrixWorld(true);
      var bb = new T.Box3().setFromObject(o.obj);
      var top = (bb && isFinite(bb.max.y)) ? bb.max.y : e.hit.y1;
      // 挂在模型最高点上方：只按判定顶摆会插进刀盾竖起来的刀里，
      // 只按包围盒摆又会飘得太高。取两者的较大值再抬一点最稳。
      e.arrowY0 = Math.max(e.hit.y1, top * 0.85) + 0.30;

      var cue = buildJumpCue();
      o.obj.add(cue);
      e.cue = cue;

      var arrow = buildJumpArrow();
      arrow.position.y = e.arrowY0;
      o.obj.add(arrow);
      e.arrow = arrow;
      e.arrowMat = arrow.userData.mat;
    }
    return e;
  }

  function spawnEgg(lane, z, y) {
    if (!EGG_GEO) EGG_GEO = buildEgg();
    var g = EGG_GEO.clone();
    g.position.x = CFG.LANES[lane];
    g.position.y = y === undefined ? 1.0 : y;
    if (y === undefined) g.userData.baseY = 1.0; else g.userData.baseY = y;
    return addEntity(g, 'egg', z);
  }

  function spawnBuff(type, lane, z) {
    var g = buildBuff(type);
    g.position.x = CFG.LANES[lane];
    g.position.y = 1.05;
    g.userData.baseY = 1.05;
    return addEntity(g, 'buff', z, { buff: type });
  }

  /* ---------------- 关卡生成 ---------------- */
  function spawnPattern() {
    var d = G.distance;
    var diff = clamp(d / 900, 0, 1);
    var r = Math.random();

    // 全宽横杆：练下蹲
    if (d > 220 && r < 0.15) {
      spawnObstacle('bar', 1);
      // 横杆后方给一排奶龙奖励
      if (Math.random() < 0.6) {
        var l = randInt(0, 2);
        for (var i = 0; i < 3; i++) spawnEgg(l, CFG.SPAWN_Z - 8 - i * 3.2, 0.9);
      }
      return;
    }

    var lanes = [0, 1, 2];
    // 洗牌
    for (var s = lanes.length - 1; s > 0; s--) {
      var j = (Math.random() * (s + 1)) | 0;
      var tmp = lanes[s]; lanes[s] = lanes[j]; lanes[j] = tmp;
    }

    var twoBlock = d > 140 && Math.random() < 0.24 + 0.34 * diff;
    var blockers = lanes.slice(0, twoBlock ? 2 : 1);
    var freeLane = lanes[twoBlock ? 2 : 1];

    blockers.forEach(function (l) {
      var type;
      var rr = Math.random();
      if (rr < 0.3) type = 'bun';
      else if (rr < 0.46) type = 'niulai';
      else if (rr < 0.62) type = 'cow';
      else if (rr < 0.76) type = 'shield';
      else if (rr < 0.9) type = 'lulu';
      else type = 'pigman';
      spawnObstacle(type, l);
    });

    // 免费道放奶龙（偶尔是 buff）
    if (Math.random() < 0.82) {
      var n = randInt(3, 5);
      var arc = Math.random() < 0.25;
      for (var k = 0; k < n; k++) {
        var y = 1.0;
        if (arc) y = 0.9 + Math.sin((k / (n - 1)) * Math.PI) * 1.15;
        spawnEgg(freeLane, CFG.SPAWN_Z - 2 - k * 3.1, y);
      }
    }
    if (Math.random() < 0.09) {
      spawnBuff(pick(['shield', 'boost', 'magnet']), freeLane, CFG.SPAWN_Z - 16);
    }
  }

  /* ---------------- 场景切换 ---------------- */
  var themeTween = null;
  function setTheme(idx, instant) {
    G.theme = idx;
    var t = THEMES[idx];
    for (var i = 0; i < themeSets.length; i++) themeSets[i].group.visible = (i === idx);
    if (instant) {
      if (!scene.background) scene.background = new T.Color(t.sky);
      else scene.background.set(t.sky);
      if (scene.fog) scene.fog.color.set(t.fog);
      groundMat.color.set(t.ground);
      roadMat.color.set(t.road);
      curbMat.color.set(t.curb);
      detailMat.color.set(t.detail);
      themeTween = null;
    } else {
      if (!scene.background) scene.background = new T.Color(t.sky);
      themeTween = {
        t: 0,
        from: {
          sky: scene.background.clone(), fog: scene.fog.color.clone(),
          ground: groundMat.color.clone(), road: roadMat.color.clone(),
          curb: curbMat.color.clone(), detail: detailMat.color.clone()
        },
        to: {
          sky: new T.Color(t.sky), fog: new T.Color(t.fog),
          ground: new T.Color(t.ground), road: new T.Color(t.road),
          curb: new T.Color(t.curb), detail: new T.Color(t.detail)
        }
      };
    }
  }

  function updateThemeTween(dt) {
    if (!themeTween) return;
    themeTween.t = Math.min(1, themeTween.t + dt / 0.7);
    var k = themeTween.t, f = themeTween.from, to = themeTween.to;
    scene.background.copy(f.sky).lerp(to.sky, k);
    scene.fog.color.copy(f.fog).lerp(to.fog, k);
    groundMat.color.copy(f.ground).lerp(to.ground, k);
    roadMat.color.copy(f.road).lerp(to.road, k);
    curbMat.color.copy(f.curb).lerp(to.curb, k);
    detailMat.color.copy(f.detail).lerp(to.detail, k);
    if (k >= 1) themeTween = null;
  }

  /* ---------------- 音效（全部程序化合成） ---------------- */
  var AudioSys = (function () {
    var ctx = null, master = null, noiseBuf = null, musicGain = null;
    var musicTimer = null, musicStep = 0, musicNext = 0, musicOn = false;

    function init() {
      if (ctx) return;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.85;
      master.connect(ctx.destination);
      // 噪声缓冲（用于笑声气息 & 打击）
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.6, ctx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    function resume() {
      init();
      if (ctx && ctx.state === 'suspended') ctx.resume();
    }

    // 雷霆大笑：优先播放 res/laugh.mp3 真实音频，文件缺失/解码失败才回退合成
    // 音频本身 10.2s（三段笑），3.8s 是第一段"哈哈哈"收尾的气口，笑到这就淡出
    var LAUGH_HOLD = 3.8, LAUGH_FADE = 0.6;
    var laughFadeTimer = null;
    function scheduleLaughFade(el, baseVol, hold, fade) {
      if (laughFadeTimer) { clearInterval(laughFadeTimer); laughFadeTimer = null; }
      var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
      laughFadeTimer = setInterval(function () {
        var now = (window.performance && performance.now) ? performance.now() : Date.now();
        var t = (now - t0) / 1000;
        if (t < hold) return;
        var k = 1 - (t - hold) / fade;
        if (k <= 0) {
          clearInterval(laughFadeTimer); laughFadeTimer = null;
          try { el.pause(); } catch (e) {}
          return;
        }
        try { el.volume = Math.max(0, Math.min(1, baseVol * k)); } catch (e) {}
      }, 50);
    }

    var fileLaugh = {
      ok: false,
      busyUntil: 0,
      play: function (power) {
        var el = dom.laugh;
        if (!el || !fileLaugh.ok) return false;
        var now = (window.performance && performance.now) ? performance.now() : Date.now();
        // 同一段笑声不叠加：还在响就直接复用，不打断重头播
        if (!el.paused && !el.ended && now < fileLaugh.busyUntil - 150) return true;
        try { el.currentTime = 0; } catch (e) {}
        var vol = Math.max(0, Math.min(1, 0.92 * (power || 1)));
        el.volume = vol;
        var p = el.play();
        if (p && p.catch) {
          p.catch(function () {
            // 被自动播放策略拦下时只跳过这一次，不永久降级
            fileLaugh.busyUntil = 0;
          });
        }
        var dur = (el.duration && isFinite(el.duration)) ? el.duration : 6;
        fileLaugh.busyUntil = now + Math.min(dur, LAUGH_HOLD + LAUGH_FADE) * 1000;
        scheduleLaughFade(el, vol, LAUGH_HOLD, LAUGH_FADE);
        return true;
      },
      stop: function () {
        var el = dom.laugh;
        if (laughFadeTimer) { clearInterval(laughFadeTimer); laughFadeTimer = null; }
        if (!el) return;
        try { el.pause(); el.currentTime = 0; } catch (e) {}
        fileLaugh.busyUntil = 0;
      }
    };
    if (dom.laugh) {
      var markLaughOk = function () { if (dom.laugh.readyState >= 2) fileLaugh.ok = true; };
      dom.laugh.addEventListener('loadeddata', markLaughOk);
      dom.laugh.addEventListener('canplay', markLaughOk);
      dom.laugh.addEventListener('canplaythrough', markLaughOk);
      dom.laugh.addEventListener('error', function () { fileLaugh.ok = false; });
      markLaughOk();
    }

    function laugh(power) {
      power = power || 1;
      if (fileLaugh.play(power)) return;
      synthLaugh(power);
    }

    // 合成笑声：一连串"哈哈哈哈"，带回声（真实音频不可用时的兜底）
    function synthLaugh(power) {
      if (!ctx) return;
      power = power || 1;
      var t0 = ctx.currentTime + 0.02;
      var out = ctx.createGain();
      out.gain.value = 0.5 * power;
      out.connect(master);

      var delay = ctx.createDelay();
      delay.delayTime.value = 0.085;
      var fb = ctx.createGain();
      fb.gain.value = 0.3;
      delay.connect(fb); fb.connect(delay);
      delay.connect(out);

      var n = 6;
      for (var i = 0; i < n; i++) {
        var s = t0 + i * 0.155 + (i > 3 ? 0.01 : 0);
        var dur = 0.135 - i * 0.007;
        var base = 320 - i * 16;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.5 * power, s + 0.014);
        g.gain.exponentialRampToValueAtTime(0.0008, s + dur);

        var o1 = ctx.createOscillator(); o1.type = 'sawtooth';
        o1.frequency.setValueAtTime(base * 1.28, s);
        o1.frequency.exponentialRampToValueAtTime(base * 0.92, s + dur);
        var o2 = ctx.createOscillator(); o2.type = 'square';
        o2.frequency.setValueAtTime(base * 0.52 * 1.2, s);
        o2.frequency.exponentialRampToValueAtTime(base * 0.5, s + dur);

        var bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(760 + i * 30, s);
        bp.Q.value = 1.5;

        var breath = ctx.createBufferSource();
        breath.buffer = noiseBuf;
        var bhp = ctx.createBiquadFilter();
        bhp.type = 'highpass'; bhp.frequency.value = 1400;
        var bg = ctx.createGain();
        bg.gain.setValueAtTime(0.12 * power, s);
        bg.gain.exponentialRampToValueAtTime(0.001, s + dur);

        o1.connect(bp); o2.connect(bp); bp.connect(g); g.connect(out); g.connect(delay);
        breath.connect(bhp); bhp.connect(bg); bg.connect(out);

        o1.start(s); o2.start(s); o1.stop(s + dur + 0.06); o2.stop(s + dur + 0.06);
        breath.start(s); breath.stop(s + dur);
      }
    }

    function blip(freq, dur, type, vol) {
      if (!ctx) return;
      var t = ctx.currentTime;
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'triangle';
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.22, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.14));
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + (dur || 0.14) + 0.05);
    }

    function coin() {
      if (!ctx) return;
      blip(1180, 0.09, 'triangle', 0.16);
      setTimeout(function () { blip(1580, 0.12, 'triangle', 0.14); }, 55);
    }
    function jump() { blip(520, 0.16, 'sine', 0.16); }
    function buff() {
      if (!ctx) return;
      [660, 880, 1100, 1320].forEach(function (f, i) {
        setTimeout(function () { blip(f, 0.13, 'triangle', 0.15); }, i * 70);
      });
    }
    function hit() {
      if (!ctx) return;
      var t = ctx.currentTime;
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(60, t + 0.35);
      g.gain.setValueAtTime(0.3, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + 0.42);
    }

    /* --- 背景音乐：优先用 res/bgm.mp3，否则用内置合成音 --- */
    var synthBGM = {
      notes: [0, 7, 12, 7, 4, 9, 14, 9, 2, 9, 14, 9, 5, 12, 16, 12],
      start: function () {
        if (!ctx || musicOn) return;
        musicOn = true;
        musicStep = 0;
        musicNext = ctx.currentTime + 0.1;
        musicGain = ctx.createGain();
        musicGain.gain.value = 0.0;
        musicGain.connect(master);
        musicGain.gain.linearRampToValueAtTime(0.09, ctx.currentTime + 1.2);
        musicTimer = setInterval(function () {
          // 切到后台时 setInterval 被节流到 1 次/秒，回来时 musicNext 会远远落后于
          // currentTime —— 不重新对齐的话，下面的 while 会把攒下的音符一次性全排进
          // 过去的时间点，回来瞬间"哗"地炸一下。落后超过 0.3 秒就直接对齐到当下。
          if (ctx.currentTime - musicNext > 0.3) musicNext = ctx.currentTime + 0.05;
          while (musicNext < ctx.currentTime + 0.5) {
            var semi = synthBGM.notes[musicStep % synthBGM.notes.length];
            var f = 261.63 * Math.pow(2, semi / 12);
            var o = ctx.createOscillator(), g = ctx.createGain();
            o.type = 'triangle';
            o.frequency.value = f;
            g.gain.setValueAtTime(0.0001, musicNext);
            g.gain.exponentialRampToValueAtTime(0.14, musicNext + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, musicNext + 0.34);
            o.connect(g); g.connect(musicGain);
            o.start(musicNext); o.stop(musicNext + 0.4);
            if (musicStep % 8 === 0) {
              var b = ctx.createOscillator(), bg2 = ctx.createGain();
              b.type = 'sine';
              b.frequency.value = 130.81 * Math.pow(2, (musicStep % 16 === 0 ? 0 : 5) / 12);
              bg2.gain.setValueAtTime(0.0001, musicNext);
              bg2.gain.exponentialRampToValueAtTime(0.2, musicNext + 0.03);
              bg2.gain.exponentialRampToValueAtTime(0.0001, musicNext + 0.6);
              b.connect(bg2); bg2.connect(musicGain);
              b.start(musicNext); b.stop(musicNext + 0.7);
            }
            musicNext += 0.26;
            musicStep++;
          }
        }, 180);
      },
      stop: function () {
        if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
        if (musicGain && ctx) {
          try {
            musicGain.gain.cancelScheduledValues(ctx.currentTime);
            musicGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.15);
          } catch (e) {}
        }
        musicOn = false;
      }
    };

    // 文件音乐的目标音量。笑声是 0.92，BGM 压到 0.42 才不会盖住大笑和碰撞音效
    var FILE_BGM_VOL = 0.42;

    var fileBGM = {
      ok: false,
      fadeTimer: null,
      stopToken: 0,
      // 音量渐变：直接 pause() 会「咔」一声，死亡瞬间尤其明显
      fade: function (to, ms) {
        var el = dom.bgm;
        if (!el) return;
        if (fileBGM.fadeTimer) { clearInterval(fileBGM.fadeTimer); fileBGM.fadeTimer = null; }
        var from = el.volume, t0 = Date.now();
        fileBGM.fadeTimer = setInterval(function () {
          var k = Math.min(1, (Date.now() - t0) / ms);
          try { el.volume = Math.max(0, Math.min(1, from + (to - from) * k)); } catch (e) {}
          if (k >= 1) { clearInterval(fileBGM.fadeTimer); fileBGM.fadeTimer = null; }
        }, 40);
      },
      start: function () {
        var el = dom.bgm;
        if (!el || !el.getAttribute('src')) return synthBGM.start();
        if (fileBGM.fadeTimer) { clearInterval(fileBGM.fadeTimer); fileBGM.fadeTimer = null; }
        fileBGM.stopToken++;                       // 作废上一个「延迟 pause」，别把新音乐掐掉
        try {
          if (el.paused) { el.volume = 0; try { el.currentTime = 0; } catch (e2) {} }
        } catch (e) {}
        var p = el.play();
        if (p && p.catch) p.catch(function () { synthBGM.start(); });
        fileBGM.fade(FILE_BGM_VOL, 900);           // 淡入，跟笑声错开
      },
      stop: function (fadeMs) {
        var el = dom.bgm;
        if (!el || el.paused) return;
        var ms = fadeMs || 420;
        fileBGM.fade(0, ms);
        var my = ++fileBGM.stopToken;
        setTimeout(function () {
          if (my !== fileBGM.stopToken) return;    // 期间又 start 过就别停了
          try { el.pause(); } catch (e) {}
        }, ms + 80);
      },
      hardPause: function () {
        var el = dom.bgm;
        if (!el) return;
        if (fileBGM.fadeTimer) { clearInterval(fileBGM.fadeTimer); fileBGM.fadeTimer = null; }
        fileBGM.stopToken++;
        try { el.pause(); } catch (e) {}
      }
    };

    // 探测 res/bgm.mp3 是否存在（存在则用它，否则用内置合成音乐）
    function probeBGM() {
      if (!dom.bgm) return;
      // file:// 下无法 fetch，直接交给 audio 元素自己报错回退
      if (location.protocol === 'file:' || !window.fetch) { fileBGM.ok = true; return; }
      fetch(dom.bgm.getAttribute('src') || 'res/bgm.wav', { method: 'HEAD' })
        .then(function (r) { if (r && r.ok) fileBGM.ok = true; })
        .catch(function () {});
    }
    if (dom.bgm) {
      dom.bgm.addEventListener('error', function () {
        fileBGM.ok = false;
        if (musicOn === false) synthBGM.start();
      });
    }
    setTimeout(probeBGM, 400);

    // bgmWanted = 「按流程现在应该有音乐」。切后台暂停、回前台恢复都看它，
    // 否则在结算画面切一下标签页回来，音乐会自己响起来。
    var bgmWanted = false;

    return {
      resume: resume, laugh: laugh, coin: coin, jump: jump, buff: buff, hit: hit,
      startMusic: function () {
        bgmWanted = true;
        if (fileBGM.ok) fileBGM.start(); else synthBGM.start();
      },
      stopMusic: function () {
        bgmWanted = false;
        fileBGM.stop(); synthBGM.stop();
      },
      pauseMusic: function () { fileBGM.hardPause(); },
      resumeMusic: function () {
        if (!bgmWanted) return;
        if (fileBGM.ok) fileBGM.start(); else synthBGM.start();
      }
    };
  })();

  /* ---------------- UI ---------------- */
  var lastScore = -1, lastEgg = -1;
  function updateHUD() {
    var sc = Math.floor(G.score);
    if (sc !== lastScore) { dom.score.textContent = sc; lastScore = sc; }
    if (G.eggs !== lastEgg) { dom.egg.textContent = G.eggs; lastEgg = G.eggs; }
  }

  var toastTimer = null;
  function toast(text) {
    dom.toast.textContent = text;
    dom.toast.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { dom.toast.classList.remove('on'); }, 1700);
  }

  function showScreen(el, on) {
    if (on) el.classList.add('show'); else el.classList.remove('show');
  }

  /* ---------------- 生命周期 ---------------- */
  function clearEntities() {
    for (var i = 0; i < entities.length; i++) {
      scene.remove(entities[i].obj);
      if (entities[i].ownGeo && entities[i].obj.geometry) entities[i].obj.geometry.dispose();
    }
    entities.length = 0;
  }

  function resetWorld() {
    clearEntities();
    G.distance = 0;
    G.eggs = 0;
    G.reviveUsed = false;
    G.score = 0;
    G.speed = CFG.BASE_SPEED;
    G.nextSpawn = 42;
    G.nextThemeAt = 520;
    G.invT = 0; G.boostT = 0; G.magnetT = 0; G.shake = 0;
    player.lane = 1; player.x = 0; player.y = 0; player.vy = 0;
    player.grounded = true; player.duckT = 0; player.lean = 0;
    player.coyoteT = 0; player.jumpBufT = 0;
    // #height=1.80 把玩家钉在半空 —— 不受 headless 虚拟时间影响，
    // 配合 #show=all 一张图就能看清「脚底 1.80 米 vs 各障碍头顶」谁高谁低。
    var hm = location.hash.match(/height=([\d.]+)/);
    G.lockY = hm ? parseFloat(hm[1]) : undefined;
    if (hm) { player.y = G.lockY; player.grounded = false; }
    // #hop / #show 这类摆位调试：从第一帧起就不判碰撞、不推进世界。
    // 原来这两项是在 setTimeout(1400) 里才设的，摆位之前的 1.4 秒世界还在跑，
    // 随机生成的障碍足以把玩家撞死 —— 截图里只剩"奶蛙摔了一跤"的结算弹窗。
    if (location.hash.indexOf('hop') >= 0 || location.hash.indexOf('show') >= 0) {
      G.noHit = true;
      G.freeze = true;
    }
    player.frog.scale.set(1, 1, 1);
    player.frog.rotation.set(0, 0, 0);
    player.root.rotation.y = 0;
    setTheme(0, true);
    camera.fov = 68; camera.updateProjectionMatrix();
    updateHUD();
  }

  function startIntro() {
    // #run=1.23 跑姿定格调试（离线核对摆腿，正常启动不会触发）
    var mRun = /run=([\d.]+)/.exec(location.hash);
    if (mRun) { G.poseHold = parseFloat(mRun[1]); G.yawHold = Math.PI; }
    // #yaw=1.57 配合 #run 换观察角度（1.57 正侧面，0 正面，3.14 背面）
    var mYaw = /yaw=([-\d.]+)/.exec(location.hash);
    if (mYaw) G.yawHold = parseFloat(mYaw[1]);
    // #face=1 锁住张嘴、#face=0 锁住闭嘴（离线核对五官位置用）
    var mFace = /face=([\d.]+)/.exec(location.hash);
    if (mFace) G.faceHold = [parseFloat(mFace[1]), 0];
    // #auto 跳过开场直接开跑（离线核对障碍物模型用）
    if (location.hash.indexOf('auto') >= 0) setTimeout(startRun, 260);
    // #show=all 开跑后在镜头前摆齐所有角色，一次截图核对全部模型
    if (location.hash.indexOf('show') >= 0) {
      setTimeout(function () {
        var D = window.NaiWa && window.NaiWa.debug;
        if (!D) return;
        window.NaiWa.G.freeze = true;     // 冻住世界，否则摆好的角色几帧就跑过去了
        window.NaiWa.G.noHit = true;
        D.clear();
        // #show=near 只摆两个、且拉近到镜头前，用来核对单个模型的细节与比例；
        // #show=all 摆齐全部，用来看整体大小关系
        var near = location.hash.indexOf('near') >= 0;
        var types = near ? ['niulai', 'shield']
                         : ['bun', 'niulai', 'lulu', 'pigman', 'cow', 'shield'];
        var lanes = near ? [0, 2] : [0, 2, 0, 2, 0, 2];   // 中间道留空，免得一摆出来就撞死
        var z0 = near ? -4.6 : -8;
        for (var i = 0; i < types.length; i++) {
          D.obstacle(types[i], lanes[i], z0 - Math.floor(i / 2) * 4);
        }
        if (!near) D.egg(1, -6.0, 1.1);
      }, 1400);
    }
    // #bot 自动跑：能跳的障碍就跳、跳不过的就换道，左下角显示「跳成功 / 死亡」计数。
    // 用来实证「跳跃参数到底够不够跳过去」，比手算抛物线有说服力。
    if (location.hash.indexOf('bot') >= 0) {
      var hud = document.createElement('div');
      hud.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:99;background:rgba(0,0,0,.62);' +
                          'color:#8CF59B;font:13px/1.5 ui-monospace,Consolas,monospace;' +
                          'padding:7px 11px;border-radius:8px;pointer-events:none';
      document.body.appendChild(hud);
      var jumps = 0, deaths = 0, wasPlaying = false, cool = 0, crossed = [], botInfo = '';
      // headless / 无人值守验证用：没人点开始就让机器人自己开跑
      setTimeout(function () { if (G.phase !== 'playing') window.NaiWa.start(); }, 900);
      setTimeout(function () {
        function botTick() {
          requestAnimationFrame(botTick);
          try {
          if (G.phase === 'playing') { wasPlaying = true; }
          else if (wasPlaying) { wasPlaying = false; deaths++; startRun(); }

          if (G.phase === 'playing' && cool <= 0) {
            // 每条道前方 14 米内最近的障碍
            var near = [null, null, null];
            for (var i = 0; i < entities.length; i++) {
              var e = entities[i];
              if (e.kind !== 'obstacle' || e.dead || e.z > 0 || e.z < -14) continue;
              // 与 simBot 同款：按判定盒覆盖算，横杆跨三道不能只看中心
              for (var ln = 0; ln < 3; ln++) {
                if (Math.abs(e.obj.position.x - CFG.LANES[ln]) >= e.hit.hx + HIT.halfX) continue;
                if (!near[ln] || e.z > near[ln].z) near[ln] = e;
              }
            }
            var ob = near[player.lane];
            botInfo = ob ? (ob.kind0 + ' j=' + ob.jumpable +
                            ' tIn=' + ((-ob.hit.hz - ob.z) / Math.max(G.speed, 1)).toFixed(2) +
                            ' g=' + player.grounded + ' cool=' + cool) : '本道14米内无障碍';
            if (ob) {
              var v = Math.max(G.speed, 1);
              var half = ob.hit.hz + HIT.halfZ;        // 判定区半宽
              var tIn = (-half - ob.z) / v;            // 还有多久进入判定区
              var span = 2 * half / v;                 // 在判定区里待多久
              if (ob.jumpable && tIn > 0.02 && tIn < 2 && player.grounded) {
                // 欧拉预测（与 updatePlayer 同款积分），解析抛物线在边界帧会差 7 厘米
                var ok = true, yy = 0, vy = CFG.JUMP_V, tf = 0;
                var yNeed = ob.hit.y1 - JUMP_CLEAR_EPS;
                while (tf <= tIn + span + 1e-9) {
                  if (tf >= tIn - 1e-9 && yy < yNeed) { ok = false; break; }
                  vy -= CFG.GRAVITY * (1 / 60); yy += vy * (1 / 60); tf += 1 / 60;
                }
                if (ok) {
                  doJump(); jumps++; cool = 8;
                  (function (ent) {
                    setTimeout(function () {
                      if (!ent.dead && ent.z > 2 && G.phase === 'playing') crossed.push(ent.name);
                    }, 700);
                  })(ob);
                }
              } else if (!ob.jumpable && tIn < 1.2) {
                // 跳不过去 —— 找一条 9 米内没有障碍的道；没有道就持续蹲
                var bestLane = -1;
                for (var l = 0; l < 3; l++) {
                  if (l === player.lane) continue;
                  if (!near[l] || near[l].z < -9) { bestLane = l; break; }
                }
                if (bestLane >= 0) {
                  if (cool <= 0) { moveLane(bestLane > player.lane ? 1 : -1); cool = 20; }
                } else {
                  doDuck();
                }
              }
            }
          }
          if (cool > 0) cool--;
          hud.textContent = '起跳 ' + jumps + ' 次 · 越过 ' + crossed.length +
                            ' 个 · 死亡 ' + deaths + ' 次' +
                            '  [' + G.phase + ' v=' + G.speed.toFixed(1) +
                            ' 距' + (G.distance | 0) + ' 实体' + entities.length + ']' +
                            (botErr ? ' ERR:' + botErr : ' ' + botInfo);
          } catch (err) { botErr = (err && err.message) || String(err); }
        }
        var botErr = '';
        requestAnimationFrame(botTick);
      }, 1200);
    }
    // #hop / #hop=bun|shield|niulai|cow|lulu|pigman
    // 冻住世界，把指定障碍摆在右边道，玩家原地反复起跳 —— 直接看脚底有没有高过它的判定顶。
    // 可跳的那两个（豆包/刀盾）应该越过；其余四个应该明显越不过，正好用来核对规则有没有被改坏。
    if (location.hash.indexOf('hop') >= 0) {
      setTimeout(function () {
        var D = window.NaiWa && window.NaiWa.debug;
        if (!D) return;
        window.NaiWa.G.freeze = true;
        window.NaiWa.G.noHit = true;      // 跳不过的角色摆在跟前也不会撞死，能一直截到腾空帧
        D.clear();
        var m = location.hash.match(/hop=(\w+)/);
        var hopType = (m && OB[m[1]]) ? m[1] : 'bun';
        // z 必须和玩家一样取 0：障碍若摆在 -0.6 米，它的立足点在屏幕上会被透视抬高，
        // 0.6 米的深度差足以吃掉 0.3 米的高度差 —— 那样截出来的图会"看起来跳不过"，
        // 与数值矛盾。同深度并排才能直接比脚底和头顶的高低。
        D.obstacle(hopType, 2, 0);
        // 落地就再跳，保持一直腾空 —— 截图才不会正好抓到站地上的那一帧
        (function hopLoop() {
          requestAnimationFrame(hopLoop);
          if (G.phase === 'playing' && player.grounded) doJump();
        })();
      }, 1500);
    }
    // #cue=bun&z=-6：开跑、冻住世界、在指定距离摆一个可跳障碍 ——
    // 截图看「起跳箭头」的亮灭和距离对不对得上（窗口内必须亮，窗口外必须灭）。
    if (location.hash.indexOf('cue') >= 0) {
      setTimeout(function () {
        window.NaiWa.start();
        setTimeout(function () {
          var D = window.NaiWa.debug;
          D.clear();
          G.noHit = true; G.freeze = true; G.nextSpawn = 1e9;
          var m = location.hash.match(/cue=(\w+)/);
          var t = (m && OB[m[1]]) ? m[1] : 'bun';
          var zm = location.hash.match(/z=(-?[\d.]+)/);
          D.obstacle(t, 1, zm ? parseFloat(zm[1]) : -6);
        }, 80);
      }, 700);
    }
    G.phase = 'intro';
    G.introT = 0;
    dom.intro.classList.add('show');
    dom.start.classList.remove('show');
    dom.over.classList.remove('show');
  }

  function endIntro(withLaugh) {
    if (G.phase !== 'intro') return;
    G.phase = 'ready';
    dom.intro.classList.remove('show');
    dom.start.classList.add('show');
    if (withLaugh) { AudioSys.resume(); AudioSys.laugh(1); }
  }

  function startRun() {
    AudioSys.resume();
    resetWorld();
    G.phase = 'playing';
    showScreen(dom.start, false);
    showScreen(dom.over, false);
    showScreen(dom.ad, false);
    dom.hud.classList.add('on');
    AudioSys.laugh(1);
    // 先让笑声出来，背景音乐稍后再淡入，不抢戏
    setTimeout(function () { if (G.phase === 'playing') AudioSys.startMusic(); }, 800);
  }

  function die() {
    if (G.phase !== 'playing') return;
    G.phase = 'dying';
    G.dyingT = 0;
    G.shake = 0.55;
    AudioSys.hit();
    setTimeout(function () { AudioSys.laugh(0.9); }, 120);
    AudioSys.stopMusic();
  }

  function showGameOver() {
    G.phase = 'over';
    var sc = Math.floor(G.score);
    if (sc > G.best) {
      G.best = sc;
      try { localStorage.setItem('naiwa_best', String(sc)); } catch (e) {}
      dom.overTip.textContent = '新纪录！奶蛙超神了';
    } else {
      dom.overTip.textContent = pick(['再来一次，奶龙在等你', '差一点点，再冲一把', '奶蛙不服气，还想跑']);
    }
    dom.finalScore.textContent = sc;
    dom.finalEgg.textContent = G.eggs;
    dom.best.textContent = G.best;
    dom.btnRevive.style.display = G.reviveUsed ? 'none' : 'flex';
    showScreen(dom.over, true);
    dom.hud.classList.remove('on');
  }

  function revive() {
    G.reviveUsed = true;
    showScreen(dom.over, false);
    // 清掉前方危险物
    for (var i = entities.length - 1; i >= 0; i--) {
      var e = entities[i];
      if (e.kind === 'obstacle' && e.z > -55) {
        scene.remove(e.obj);
        entities.splice(i, 1);
      }
    }
    player.y = 0; player.vy = 0; player.grounded = true;
    player.lane = 1; player.x = CFG.LANES[1];
    G.invT = 3.4;
    G.nextSpawn = G.distance + 55;
    G.phase = 'playing';
    dom.hud.classList.add('on');
    AudioSys.resume();
    AudioSys.startMusic();
    AudioSys.buff();
  }

  function playAd() {
    if (G.phase !== 'over' || G.reviveUsed) return;
    G.phase = 'ad';
    showScreen(dom.ad, true);
    dom.adCount.textContent = '3';
    dom.adBar.style.width = '0%';
    dom.adRing.style.setProperty('--p', '0%');
    var total = 3, left = total;
    var tick = setInterval(function () {
      left -= 0.1;
      var p = 1 - Math.max(0, left) / total;
      dom.adBar.style.width = (p * 100).toFixed(0) + '%';
      dom.adRing.style.setProperty('--p', (p * 100).toFixed(0) + '%');
      dom.adCount.textContent = Math.max(1, Math.ceil(left));
      if (left <= 0) {
        clearInterval(tick);
        showScreen(dom.ad, false);
        revive();
      }
    }, 100);
  }

  /* ---------------- 输入 ---------------- */
  function moveLane(dir) {
    if (G.phase !== 'playing') return;
    var n = clamp(player.lane + dir, 0, 2);
    if (n !== player.lane) player.lane = n;
  }
  // 真正起跳。所有入口（按键 / 缓冲兑现）最后都走这里，保证状态只有一处被改。
  function launchJump() {
    player.vy = CFG.JUMP_V;
    player.grounded = false;
    player.coyoteT = 0;
    player.jumpBufT = 0;
    player.duckT = 0;
    AudioSys.jump();
  }
  function doJump() {
    if (G.phase !== 'playing') return;
    // 站在地上（或刚离地的土狼窗口内）立刻兑现；否则记进缓冲，落地那一帧自动补上。
    if (player.grounded || player.coyoteT > 0) launchJump();
    else player.jumpBufT = CFG.JUMP_BUFFER;
  }
  function doDuck() {
    if (G.phase !== 'playing') return;
    player.duckT = CFG.DUCK_TIME;
    if (!player.grounded) player.vy = Math.min(player.vy, -16); // 空中快速下落
  }

  window.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') { moveLane(-1); e.preventDefault(); }
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') { moveLane(1); e.preventDefault(); }
    else if (k === 'ArrowUp' || k === 'w' || k === 'W' || k === ' ') { doJump(); e.preventDefault(); }
    else if (k === 'ArrowDown' || k === 's' || k === 'S') { player.duckKey = true; doDuck(); e.preventDefault(); }
    else if (k === 'Enter' && G.phase === 'intro') { endIntro(true); e.preventDefault(); }
    else if (k === 'Enter' && (G.phase === 'ready' || G.phase === 'over')) { startRun(); }
  }, { passive: false });
  window.addEventListener('keyup', function (e) {
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') player.duckKey = false;
  });

  /* ---------------- 输入：键盘 + 全屏四向滑动 ----------------
     安卓版靠滑动操作，三条必须守住：
       1. 绑在 document 而不是 canvas —— HUD / 结算卡这些覆盖层会吃掉 canvas 上的触摸，
          手指落在屏幕上半部分就滑不动了；
       2. 一次滑动只出一个动作 —— 旧版每移 30px 就把起点挪到当前点，
          一记长滑能连换两道，手指一抖就跑偏；
       3. 下滑要「按住」—— 横杆横跨三道且通过时间长于 DUCK_TIME(0.62s)，
          点一下蹲会差那 0.07 秒被扫到（bot 全程模拟踩过这个坑）。
     方向在「首次越过阈值」的那一刻定死，斜滑也能稳定归到主轴。 */
  var gesture = { sx: 0, sy: 0, st: 0, active: false, fired: false, dir: '' };
  var duckHoldTimer = null;

  function swipeThreshold() {
    // 按屏幕短边自适应：1080×2400 的手机约 48px，桌面窗口也不会迟钝
    return Math.max(24, Math.min(window.innerWidth, window.innerHeight) * 0.045);
  }

  function swipeAction(dir) {
    if (dir === 'left') moveLane(-1);
    else if (dir === 'right') moveLane(1);
    else if (dir === 'up') doJump();
    else if (dir === 'down') {
      doDuck();
      player.duckKey = true;                 // 持续蹲，覆盖整个横杆通过时间
      if (duckHoldTimer) clearTimeout(duckHoldTimer);
      duckHoldTimer = setTimeout(function () {
        if (!(gesture.active && gesture.dir === 'down')) player.duckKey = false;
      }, 900);
    }
  }

  function gestureStart(x, y) {
    gesture.sx = x; gesture.sy = y; gesture.st = performance.now();
    gesture.active = true; gesture.fired = false; gesture.dir = '';
  }
  function gestureMove(x, y) {
    if (!gesture.active || gesture.fired) return;
    var dx = x - gesture.sx, dy = y - gesture.sy;
    var th = swipeThreshold();
    if (Math.abs(dx) < th && Math.abs(dy) < th) return;
    gesture.fired = true;                    // 抬手之前不再触发第二个动作
    var dir = Math.abs(dx) > Math.abs(dy)
      ? (dx > 0 ? 'right' : 'left')
      : (dy > 0 ? 'down' : 'up');
    gesture.dir = dir;
    swipeAction(dir);
  }
  function gestureEnd(x, y) {
    if (!gesture.active) return;
    var wasFired = gesture.fired, dt = performance.now() - gesture.st;
    var ex = (x === undefined ? gesture.sx : x), ey = (y === undefined ? gesture.sy : y);
    var ddx = ex - gesture.sx, ddy = ey - gesture.sy;
    var dist = Math.sqrt(ddx * ddx + ddy * ddy);
    gesture.active = false;
    if (gesture.dir === 'down' && duckHoldTimer) {
      clearTimeout(duckHoldTimer);
      duckHoldTimer = setTimeout(function () { player.duckKey = false; }, 120);
    }
    // 轻点也能跳（没达到滑动阈值的兜底）。按钮点击不会误触发：
    // 按钮上的触摸没有 move，且非 playing 阶段 doJump 会直接 return。
    if (!wasFired && dt < 300 && dist < swipeThreshold() && G.phase === 'playing') doJump();
  }

  function touchPoint(e, end) {
    var list = end ? (e.changedTouches || e.touches) : e.touches;
    return (list && list.length) ? list[0] : null;
  }
  document.addEventListener('touchstart', function (e) {
    var t = touchPoint(e, false); if (!t) return;
    gestureStart(t.clientX, t.clientY);
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!gesture.active) return;
    // 阻止 WebView 的滚动 / 下拉刷新 / 边缘回弹；必须用 passive:false 才生效
    if (e.cancelable) e.preventDefault();
    var t = touchPoint(e, false); if (!t) return;
    gestureMove(t.clientX, t.clientY);
  }, { passive: false });
  document.addEventListener('touchend', function (e) {
    var t = touchPoint(e, true);
    gestureEnd(t ? t.clientX : undefined, t ? t.clientY : undefined);
  }, { passive: true });
  document.addEventListener('touchcancel', function () { gestureEnd(); }, { passive: true });

  // 桌面鼠标拖拽走同一套逻辑（方便预览 / 调试；安卓上不会触发）
  var mouseDown = false;
  dom.canvas.addEventListener('mousedown', function (e) {
    mouseDown = true; gestureStart(e.clientX, e.clientY);
  });
  window.addEventListener('mousemove', function (e) {
    if (mouseDown) gestureMove(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', function (e) {
    if (mouseDown) { mouseDown = false; gestureEnd(e.clientX, e.clientY); }
  });

  dom.intro.addEventListener('click', function () { endIntro(true); });

  dom.btnStart.addEventListener('click', startRun);
  dom.btnRestart.addEventListener('click', function () {
    G.reviveUsed = false;
    startRun();
  });
  dom.btnRevive.addEventListener('click', playAd);

  /* ---------------- 碰撞 ---------------- */
  function checkCollisions(dt) {
    var px = player.x, py = player.y;
    var ducking = player.duckT > 0 || player.duckKey;
    var ph = ducking ? HIT.duckH : HIT.standH;

    for (var i = entities.length - 1; i >= 0; i--) {
      var e = entities[i];
      if (e.dead) continue;
      // 提示要先更新：它在最后的 continue 之前就必须跑到。
      // 顺序有意义 —— 箭头要先看圆环亮没亮，才能决定自己是不起跳"强调"档。
      if (e.arrow) { updateJumpCue(e, dt); updateJumpArrow(e, dt); }
      var o = e.obj;

      // 收集物
      if (e.kind === 'egg' || e.kind === 'buff') {
        var dx0 = Math.abs(o.position.x - px);
        var dz0 = Math.abs(e.z);
        var dy0 = Math.abs(o.position.y - (py + 0.8));

        // 磁铁吸引
        if (e.kind === 'egg' && G.magnetT > 0 && e.z > -14 && e.z < 3) {
          o.position.x = lerp(o.position.x, px, 1 - Math.exp(-dt * 6));
          o.position.y = lerp(o.position.y, py + 0.9, 1 - Math.exp(-dt * 6));
          o.userData.baseY = o.position.y;
          dx0 = Math.abs(o.position.x - px);
          dy0 = Math.abs(o.position.y - (py + 0.8));
        }
        if (dx0 < 1.1 && dz0 < 1.3 && dy0 < 1.35) {
          e.dead = true;
          scene.remove(o);
          entities.splice(i, 1);
          if (e.kind === 'egg') {
            G.eggs++;
            AudioSys.coin();
            spawnPop(o.position.x, 1.0, 0xFFD75E);
          } else {
            applyBuff(e.buff);
            spawnPop(o.position.x, 1.1, e.buff === 'shield' ? 0x9FE8FF : (e.buff === 'boost' ? 0xFFB347 : 0xFF9EC4));
          }
          continue;
        }
        continue;
      }

      // 障碍
      if (G.noHit) continue;                   // 调试摆位（#hop / #show）只看模型，不判碰撞
      var hb = e.hit;
      if (Math.abs(e.z) > hb.hz + HIT.halfZ) continue;
      if (Math.abs(o.position.x - px) > hb.hx + HIT.halfX) continue;
      if (py + ph <= hb.y0 + 0.02) continue;   // 从下方钻过去
      // 「越过」的判定线：可跳障碍给 6 厘米容差，其余必须真高过判定顶
      var yNeed = e.jumpable ? hb.y1 - JUMP_CLEAR_EPS : hb.y1;
      if (py >= yNeed) continue;

      // 命中
      if (G.invT > 0) {
        // 无敌：撞碎
        e.dead = true;
        scene.remove(o);
        entities.splice(i, 1);
        spawnPop(o.position.x, 1.0, 0x9FE8FF);
        AudioSys.hit();
        continue;
      }
      die();
      return;
    }
  }

  /* ---------------- 收集特效（简易粒子） ---------------- */
  var pops = [];
  function spawnPop(x, y, color) {
    var p = new T.Mesh(sphereGeo(0.12, 8, 6), new T.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.9 }));
    p.position.set(x, y, 0.3);
    scene.add(p);
    pops.push({ m: p, t: 0 });
  }
  function updatePops(dt) {
    for (var i = pops.length - 1; i >= 0; i--) {
      var p = pops[i];
      p.t += dt;
      var k = p.t / 0.4;
      p.m.scale.setScalar(1 + k * 2.2);
      p.m.material.opacity = Math.max(0, 0.9 * (1 - k));
      p.m.position.y += dt * 1.4;
      if (k >= 1) { scene.remove(p.m); p.m.material.dispose(); pops.splice(i, 1); }
    }
  }

  function applyBuff(type) {
    AudioSys.buff();
    if (type === 'shield') { G.invT = Math.max(G.invT, 4.2); toast('无敌 · 4 秒'); }
    else if (type === 'boost') { G.boostT = 5.0; toast('加速 · 5 秒'); }
    else { G.magnetT = 6.0; toast('奶龙磁铁 · 6 秒'); }
  }

  /* ---------------- 主角更新 ---------------- */
  /* ---------------- 表情 ---------------- */
  function setMouthOpen(o) {
    var m = player.parts.mouth;
    o = clamp(o, 0, 1);
    m.smile.visible = o <= 0.09;
    m.g.visible = o > 0.09;
    if (o > 0.09) {
      var k = (o - 0.09) / 0.91;
      m.g.scale.set(1 + k * 0.05, 0.28 + k * 0.72, 1);
      if (m.teeth) m.teeth.visible = k > 0.20;
      m.tongue.visible = k > 0.58;
      m.tongue.scale.set(0.86 + k * 0.14, 0.72 + k * 0.28, 1);
    }
  }
  function setEyesClosed(c) {
    // 睁眼 = 大绿眼；笑眯眼 = 把眼球竖直压成一条缝。
    // 早先是"整颗眼睛隐藏、只留一条 torus 弧"，那两条弧离得太开、又很短，
    // 从游戏镜头看就是两道眉毛，完全不像在笑。
    var es = player.parts.eyes;
    for (var i = 0; i < es.length; i++) {
      var e = es[i];
      // flat：AI 网格那双眼是贴图自带的，不能再压扁（一压高光会沉进脸里），
      // 只切换「高光 / 闭眼细缝」两个开关
      if (!e.flat) e.g.scale.y = c ? 0.17 : 1.00;
      if (e.glints) { for (var k = 0; k < e.glints.length; k++) e.glints[k].visible = !c; }
      if (e.lid) e.lid.visible = !!c;
    }
  }

  function updatePlayer(dt) {
    // 横向
    var tx = CFG.LANES[player.lane];
    var prevX = player.x;
    player.x = lerp(player.x, tx, 1 - Math.exp(-dt * 13));
    var vx = (player.x - prevX) / Math.max(dt, 0.0001);
    player.lean = lerp(player.lean, clamp(-vx * 0.03, -0.35, 0.35), 1 - Math.exp(-dt * 10));

    // 垂直
    if (G.lockY !== undefined) {
      // 调试：#height 把玩家钉死在半空，重力不生效
      player.y = G.lockY; player.vy = 0; player.grounded = false;
    } else if (!player.grounded) {
      player.vy -= CFG.GRAVITY * dt;
      player.y += player.vy * dt;
      if (player.y <= 0) {
        player.y = 0; player.vy = 0; player.grounded = true;
        // 落地瞬间：如果落地前玩家按过跳，这里兑现 —— 手比眼睛快也吃得到
        if (player.jumpBufT > 0) launchJump();
      }
    }
    // 土狼时间 / 跳跃缓冲都按帧衰减；站在地上时土狼时间重置满格
    if (player.grounded) player.coyoteT = CFG.COYOTE;
    else player.coyoteT = Math.max(0, player.coyoteT - dt);
    player.jumpBufT = Math.max(0, player.jumpBufT - dt);
    if (player.jumpBufT > 0 && (player.grounded || player.coyoteT > 0)) launchJump();

    // 下蹲
    if (player.duckKey) player.duckT = Math.max(player.duckT, 0.06);
    if (player.duckT > 0) player.duckT = Math.max(0, player.duckT - dt);
    var ducking = player.duckT > 0 || player.duckKey;

    player.root.position.set(player.x, player.y, 0);

    // 朝向：开场与开始界面正对镜头（看得到捧腹大笑），开跑后转身背对镜头 —— 这才是追尾视角
    var wantYaw = (G.phase === 'intro' || G.phase === 'ready') ? 0 : Math.PI;
    if (G.yawHold !== undefined) wantYaw = G.yawHold;
    player.root.rotation.y = lerp(player.root.rotation.y, wantYaw, 1 - Math.exp(-dt * 7));

    var f = player.frog, P = player.parts;

    if (G.phase === 'intro' || G.phase === 'ready') {
      /* ---------- 捧腹大笑 ---------- */
      var power = G.phase === 'intro' ? 1 : 0.55;
      var pop = 1;
      if (G.phase === 'intro') {
        var k = clamp(G.introT / 0.62, 0, 1);
        pop = 0.30 + 0.70 * (1 - Math.pow(1 - k, 3)) + Math.sin(k * Math.PI) * 0.14;
      }
      var lt = G.t;
      var w = Math.sin(lt * 2 * Math.PI * 4.3);   // 笑到打颤的节拍
      var w2 = Math.abs(w);
      var sq = 1 + 0.06 * power * w2;
      var wide = 1 + 0.045 * power * (1 - w2);
      f.scale.set(wide * pop, sq * pop, wide * pop);
      f.position.y = w2 * 0.085 * power;
      f.rotation.x = (-0.09 - 0.10 * w2) * power;   // 笑到后仰
      f.rotation.z = Math.sin(lt * 8.3) * 0.035 * power;
      f.rotation.y = Math.sin(lt * 1.6) * 0.12 * power;

      // 两只手一按一按地捧肚子
      var pat = 0.06 + 0.22 * power * w2;
      P.arms[0].rotation.set(pat, 0, -0.10 - 0.06 * power);
      P.arms[1].rotation.set(pat, 0, 0.10 + 0.06 * power);

      // 脚跟着节奏轻颠
      P.legs[0].g.rotation.x = 0.15 * power * w2;
      P.legs[1].g.rotation.x = -0.15 * power * w2;

      // 开场是捧腹大笑（张口），开始界面则闭嘴微笑 —— 照片里的常态就是一条笑缝
      setMouthOpen(G.phase === 'intro' ? (0.38 + 0.62 * w2) : 0);
      setEyesClosed(G.phase === 'intro' && G.introT > 0.85);
    } else {
      /* ---------- 跑动 / 跳跃 / 摔倒 ---------- */
      var dying = G.phase === 'dying' || G.phase === 'over';
      var s = lerp(f.scale.y, ducking ? 0.56 : 1, 1 - Math.exp(-dt * 18));
      var sx = 1 + (1 - s) * 0.42, sz = 1 + (1 - s) * 0.28;
      if (!player.grounded) {
        var stretch = clamp(player.vy * 0.012, -0.12, 0.16);
        f.scale.set(sx * (1 - stretch * 0.5), s * (1 + stretch), sx * (1 - stretch * 0.5));
      } else {
        f.scale.set(sx, s, sz);
      }

      var roll = (G.phase === 'playing' && player.grounded) ? Math.sin(G.t * 5.5) * 0.032 : 0;
      f.rotation.z = player.lean + roll;
      f.rotation.y = player.lean * 0.5;
      var leanX = ducking ? 0.10 : -0.07;
      if (!player.grounded) leanX = clamp(-player.vy * 0.006, -0.12, 0.10);
      f.rotation.x = lerp(f.rotation.x, leanX, 1 - Math.exp(-dt * 8));

      // 跑动摆动
      var moving = G.phase === 'playing';
      var t = G.t * (moving ? 1 : 0.25);
      var stride = Math.sin(t * 11);
      f.position.y = player.grounded ? Math.abs(stride) * 0.066 : 0;

      if (player.grounded && !ducking) {
        P.legs[0].g.rotation.x = stride * 0.70;
        P.legs[1].g.rotation.x = -stride * 0.70;
      } else {
        P.legs[0].g.rotation.x = lerp(P.legs[0].g.rotation.x, 0.55, 1 - Math.exp(-dt * 8));
        P.legs[1].g.rotation.x = lerp(P.legs[1].g.rotation.x, 0.55, 1 - Math.exp(-dt * 8));
      }
      P.arms[0].rotation.set(0.05 + stride * 0.10, 0, -0.12);
      P.arms[1].rotation.set(0.05 - stride * 0.10, 0, 0.12);

      if (dying) {
        f.rotation.x = lerp(f.rotation.x, 0.46, 1 - Math.exp(-dt * 7));
        f.rotation.z = Math.sin(G.t * 14) * 0.12;
        f.rotation.y = lerp(f.rotation.y, Math.sin(G.t * 5) * 0.22, 1 - Math.exp(-dt * 4));
        f.scale.set(1.13, 0.84, 1.13);
        f.position.y = 0.06;
        setMouthOpen(0.9);
      } else {
        setMouthOpen(0);
        setEyesClosed(false);
      }
    }

    // 调试用：锁住表情，方便单独观察某个表情（不影响正常流程）
    if (G.faceHold) { setMouthOpen(G.faceHold[0]); setEyesClosed(!!G.faceHold[1]); }

    // 影子
    var shScale = clamp(1 - player.y * 0.22, 0.45, 1);
    player.shadow.position.set(player.x, 0.02, 0.05);
    player.shadow.scale.set(shScale, shScale, 1);
    player.shadow.material.opacity = 0.17 * shScale;

    // 无敌泡泡
    var inv = G.invT > 0;
    player.bubble.visible = inv;
    if (inv) {
      player.bubble.position.set(player.x, player.y + 0.85, 0);
      player.bubble.rotation.y += dt * 1.6;
      var pulse = 1 + Math.sin(G.t * 8) * 0.03;
      player.bubble.scale.setScalar(pulse);
      var blink = G.invT < 1.2 ? (Math.sin(G.t * 22) > 0 ? 0.4 : 1) : 1;
      player.bubble.children[0].material.opacity = 0.18 * blink;
      f.visible = blink > 0.5;
    } else {
      f.visible = true;
    }
  }

  /* ---------------- 主循环 ---------------- */
  var lastT = performance.now();
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var frameAcc = 0, frameCount = 0, adapted = false;

  function updateEntities(dt, ds) {
    for (var i = entities.length - 1; i >= 0; i--) {
      var e = entities[i];
      if (e.dead) continue;
      e.z += ds;
      e.obj.position.z = e.z;
      e.t += dt;

      if (e.kind === 'egg') {
        // 换成了有脸的模型，原地 360° 转圈会像展示台，改成左右摆头 + 上下浮
        e.obj.rotation.y = Math.sin(e.t * 1.7) * 0.55;
        e.obj.position.y = e.obj.userData.baseY + Math.sin(e.t * 2.6) * 0.12;
      } else if (e.kind === 'buff') {
        e.obj.rotation.y += dt * 1.5;
        e.obj.position.y = e.obj.userData.baseY + Math.sin(e.t * 3) * 0.16;
      }

      if (e.z > CFG.DESPAWN_Z) {
        scene.remove(e.obj);
        entities.splice(i, 1);
      }
    }
  }

  function updateWorld(dt, ds) {
    // 虚线
    for (var i = 0; i < dashes.length; i++) {
      var d = dashes[i];
      d.position.z += ds;
      if (d.position.z > 26) d.position.z -= 144;
    }
    // 地面碎点
    for (var j = 0; j < details.length; j++) {
      var o = details[j];
      o.position.z += ds;
      if (o.position.z > 26) {
        o.position.z -= 264;
        o.position.x = (Math.random() < 0.5 ? -1 : 1) * rand(4.6, 20);
      }
    }
    // 场景装饰
    var set = themeSets[G.theme];
    for (var k = 0; k < set.items.length; k++) {
      var it = set.items[k];
      it.z += ds;
      if (it.z > 26) {
        it.z -= 240;
        it.obj.position.x = it.side * rand(5.6, 13);
        it.obj.rotation.y = rand(0, Math.PI * 2);
      }
      it.obj.position.z = it.z;
    }
    // 主题渐变
    updateThemeTween(dt);
  }

  var camLook = new T.Vector3(0, 1.30, 0.10);
  var camTmp = new T.Vector3();

  function updateCamera(dt) {
    if (G.camLock) return;            // 调试用：锁死机位便于观察模型
    var boost = G.boostT > 0 ? 1 : 0;
    var targetFov = 68 + boost * 7;

    if (G.phase === 'intro') {
      // 出场：从稍远处推近到奶蛙跟前
      var k = clamp(G.introT / 1.15, 0, 1);
      var e = 1 - Math.pow(1 - k, 3);
      var sway = Math.sin(G.t * 1.7) * 0.05;
      camTmp.set(lerp(2.35, 0.58, e) + sway, lerp(2.75, 1.62, e), lerp(6.10, 3.05, e));
      camera.position.lerp(camTmp, 1 - Math.exp(-dt * 5.5));
      camTmp.set(0, lerp(1.30, 1.04, e), 0.14);
      camLook.lerp(camTmp, 1 - Math.exp(-dt * 5.5));
      targetFov = 58;
    } else {
      // 开始界面时镜头稍微推近，让奶蛙在卡片下方更醒目
      var ready = G.phase === 'ready';
      var baseZ = ready ? 6.05 : 8.30;
      var baseY = ready ? 3.48 : 4.55;
      camTmp.set(player.x * 0.42, baseY + (player.y > 0 ? 0.3 : 0), baseZ - boost * 0.6);
      camera.position.x = lerp(camera.position.x, camTmp.x, 1 - Math.exp(-dt * 5));
      camera.position.y = lerp(camera.position.y, camTmp.y, 1 - Math.exp(-dt * 4));
      camera.position.z = lerp(camera.position.z, camTmp.z, 1 - Math.exp(-dt * 3));
      camTmp.set(player.x * 0.32, ready ? 1.78 : 2.62, -8);
      camLook.lerp(camTmp, 1 - Math.exp(-dt * 4));
    }

    if (G.shake > 0) {
      G.shake = Math.max(0, G.shake - dt * 1.6);
      var sk = G.shake * 0.5;
      camera.position.x += rand(-sk, sk);
      camera.position.y += rand(-sk, sk);
    }

    if (Math.abs(camera.fov - targetFov) > 0.05) {
      camera.fov = lerp(camera.fov, targetFov, 1 - Math.exp(-dt * 4));
      camera.updateProjectionMatrix();
    }
    camera.lookAt(camLook);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min((now - lastT) / 1000, 0.05);
    lastT = now;
    if (dt <= 0) dt = 0.016;
    G.t += dt;

    /* #run=1.23 定格在跑动的某个相位，用来离线核对跑姿（不影响正常流程） */
    if (G.poseHold !== undefined) {
      G.t = G.poseHold;
      G.phase = "playing";
      G.freeze = true;
      player.grounded = true;
      player.y = 0;
    }

    var playing = G.phase === 'playing';
    var dying = G.phase === 'dying';
    var ready = G.phase === 'ready';
    var intro = G.phase === 'intro';

    // 速度
    var target = (CFG.BASE_SPEED + (CFG.MAX_SPEED - CFG.BASE_SPEED) * Math.min(1, G.distance / CFG.RAMP));
    if (G.boostT > 0) target *= 1.42;
    G.speed = lerp(G.speed, target, 1 - Math.exp(-dt * 2.4));

    var ds = 0;
    if (playing) {
      ds = G.speed * dt;
      G.distance += ds;
      G.score = G.distance + G.eggs * CFG.EGG_SCORE;
      if (G.invT > 0) G.invT -= dt;
      if (G.boostT > 0) G.boostT -= dt;
      if (G.magnetT > 0) G.magnetT -= dt;

      // 场景随机轮换
      if (G.distance >= G.nextThemeAt) {
        var th = G.theme;
        while (th === G.theme) th = randInt(0, 2);
        setTheme(th, false);
        toast('进入 ' + THEMES[th].name);
        G.nextThemeAt = G.distance + CFG.THEME_LEN * rand(0.85, 1.15);
      }

      // 生成
      if (G.distance >= G.nextSpawn) {
        spawnPattern();
        var diff = clamp(G.distance / 900, 0, 1);
        G.nextSpawn = G.distance + lerp(26, 17, diff) * rand(0.9, 1.14);
      }
    } else if (dying) {
      G.dyingT += dt;
      ds = G.speed * dt * Math.max(0, 1 - G.dyingT * 2.2);
      G.speed = lerp(G.speed, 0, 1 - Math.exp(-dt * 3));
      if (G.dyingT > 0.95) showGameOver();
    } else if (ready) {
      G.speed = 5.5;
      ds = G.speed * dt;
      G.t += 0;
    } else if (intro) {
      G.introT += dt;
      if (G.introT > 3.55) endIntro(false);
    }

    if (G.freeze) ds = 0;
    updateWorld(dt, ds);
    updateEntities(dt, ds);
    updatePlayer(dt);
    updatePops(dt);
    if (playing) checkCollisions(dt);
    updateCamera(dt);
    updateHUD();

    renderer.render(scene, camera);

    // 自适应分辨率
    frameAcc += dt; frameCount++;
    if (!adapted && frameCount > 120) {
      var avg = frameAcc / frameCount;
      if (avg > 0.024 && dpr > 1) {
        dpr = Math.max(1, dpr - 0.35);
        renderer.setPixelRatio(dpr);
        renderer.setSize(window.innerWidth, window.innerHeight, false);
      }
      adapted = true;
      frameAcc = 0; frameCount = 0;
    }
  }

  /* ---------------- 尺寸 ---------------- */
  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 200); });
  document.addEventListener('visibilitychange', function () {
    // 切到后台时浏览器会停止 rAF，回到前台按 dt 上限补一帧，不会瞬移
    if (document.hidden) {
      // 画面停了音乐还在响很怪，跟着暂停；回来时只有「本来就在跑」才恢复
      AudioSys.pauseMusic();
    } else {
      if (G.phase === 'playing') { lastT = performance.now(); AudioSys.resumeMusic(); }
    }
  });

  /* ---------------- 启动 ---------------- */
  resetWorld();
  setTheme(0, true);
  scene.background = new T.Color(THEMES[0].sky);
  scene.fog = new T.Fog(THEMES[0].fog, 40, 108);
  camera.position.set(2.35, 2.75, 6.10);
  startIntro();
  requestAnimationFrame(frame);

  // 暴露少量接口便于调试/扩展
  window.NaiWa = {
    G: G, player: player, start: startRun, audio: AudioSys,
    camera: camera, scene: scene, renderer: renderer,
    face: function (mouth, closed) { setMouthOpen(mouth || 0); setEyesClosed(!!closed); },
    debug: {
      clear: function () { clearEntities(); },
      obstacle: function (type, lane, z) { var e = spawnObstacle(type, lane); if (z !== undefined) { e.z = z; e.obj.position.z = z; } return e; },
      egg: function (lane, z, y) { var e = spawnEgg(lane, z, y); return e; },
      buff: function (type, lane, z) { var e = spawnBuff(type, lane, z); return e; },
      setTheme: function (i) { setTheme(i, true); },
      die: die,
      entities: entities,

      /* 量一个障碍在世界里的真实尺寸。判定盒必须照着这个定 ——
         「看着差不多」是这个项目里最贵的一句话：豆包判定深一度写成模型深度的 4 倍。 */
      probe: function (type) {
        var o = OB[type]();
        o.obj.updateMatrixWorld(true);
        var b = new T.Box3().setFromObject(o.obj);
        return {
          name: o.name,
          w: b.max.x - b.min.x, h: b.max.y - b.min.y, d: b.max.z - b.min.z,
          yTop: b.max.y, yBot: b.min.y,
          hit: { y1: o.hit.y1, hx: o.hit.hx, hz: o.hit.hz },
          jumpable: OB_JUMPABLE[type] === true
        };
      },

      /* ---- 跳跃回归：用真实碰撞代码跑「在 D 米外起跳能不能过去」 ----
         不渲染、不依赖 rAF，固定 1/60 步长，所以 headless 里也完全确定。
         公式算出来的窗口只能说明设计意图，这里跑的是玩家真正会撞到的那个判断。 */
      simJump: function (type, D, speed) {
        var sp = speed || CFG.BASE_SPEED;
        clearEntities();
        G.phase = 'playing'; G.dyingT = 0; G.distance = 0;
        G.nextSpawn = 1e9; G.nextThemeAt = 1e9;
        G.invT = 0; G.boostT = 0; G.magnetT = 0;
        G.speed = sp; G.freeze = false; G.lockY = undefined; G.noHit = false;
        player.lane = 1; player.x = 0; player.y = 0; player.vy = 0;
        player.grounded = true; player.duckT = 0; player.lean = 0;

        var e = spawnObstacle(type, 1);
        e.z = -D; e.obj.position.z = -D;
        doJump();

        var dt = 1 / 60, n = 0, peak = 0;
        while (n++ < 600) {
          G.t += dt;
          var ds = sp * dt;
          G.distance += ds;
          updateWorld(dt, ds);
          updateEntities(dt, ds);
          updatePlayer(dt);
          if (player.y > peak) peak = player.y;
          if (G.phase === 'playing') checkCollisions(dt);
          if (G.phase !== 'playing') return { ok: false, peak: peak };
          if (e.dead || e.z > 3) return { ok: true, peak: peak };
        }
        return { ok: true, peak: peak };
      },

      /* 扫一遍起跳距离，返回能过去的区间（连续段） */
      simWindow: function (type, speed, from, to, step) {
        var a = from === undefined ? 0.4 : from;
        var b = to === undefined ? 20 : to;   // 满速 23.5 时窗口上沿能到 17 米，别截断
        var h = step || 0.05;
        var runs = [], cur = null, peak = 0;
        for (var D = a; D <= b + 1e-9; D += h) {
          var r = this.simJump(type, D, speed);
          if (r.peak > peak) peak = r.peak;
          if (r.ok) {
            if (!cur) { cur = { lo: D, hi: D }; runs.push(cur); }
            else cur.hi = D;
          } else cur = null;
        }
        return { runs: runs, peak: peak, speed: speed || CFG.BASE_SPEED };
      },

      /* ---- 全程 bot 模拟：固定步长连跑一整局，bot 自动跳可跳障碍 / 换道躲高障碍 ----
         与 #bot 的区别：不依赖 rAF（headless 的虚拟时间推不动 rAF，跑出来的统计是假的），
         每帧 1/60 步长跑真实 updateWorld / updateEntities / updatePlayer / checkCollisions。
         这是「游戏能不能玩」的端到端证据。 */
      simBot: function (seconds) {
        var dt = 1 / 60, steps = Math.round((seconds || 30) * 60);
        function freshRun() {
          clearEntities();
          G.phase = 'playing'; G.dyingT = 0;
          G.distance = 0; G.eggs = 0; G.score = 0;
          G.nextSpawn = 42; G.nextThemeAt = 1e9; G.theme = 0;
          G.invT = 0; G.boostT = 0; G.magnetT = 0;
          G.speed = CFG.BASE_SPEED; G.freeze = false; G.lockY = undefined; G.noHit = false;
          player.lane = 1; player.x = 0; player.y = 0; player.vy = 0;
          player.grounded = true; player.duckT = 0; player.duckKey = false;
          player.coyoteT = 0; player.jumpBufT = 0; player.lean = 0;
        }
        freshRun();
        var jumps = 0, deaths = 0, cool = 0, reason = '', obSeen = 0, jumpSeen = 0, killers = [];
        for (var n = 0; n < steps; n++) {
          G.t += dt;
          var ds = G.speed * dt;
          G.distance += ds;
          updateWorld(dt, ds);
          updateEntities(dt, ds);
          if (G.distance >= G.nextSpawn) {
            spawnPattern();
            var diff = clamp(G.distance / 900, 0, 1);
            G.nextSpawn = G.distance + lerp(26, 17, diff) * rand(0.9, 1.14);
          }
          updatePlayer(dt);
          if (G.phase !== 'playing') {
            deaths++;
            // 记下凶手：撞的是谁（判定问题还是躲闪策略问题，一眼分清）
            var culprit = '?';
            for (var ci = 0; ci < entities.length; ci++) {
              var ce = entities[ci];
              if (ce.kind === 'obstacle' && !ce.dead && ce.z > -2.5 && ce.z < 2.5) {
                culprit = (ce.kind0 || '?') + (ce.jumpable ? '(可跳!)' : '') +
                          '[g=' + player.grounded + ' d=' + (player.duckT > 0 ? player.duckT.toFixed(2) : '0') +
                          ' y=' + player.y.toFixed(2) + ' z=' + ce.z.toFixed(1) + ']';
                break;
              }
            }
            killers.push(culprit);
            if (!reason) reason = '距' + (G.distance | 0) + '米';
            freshRun();
            continue;
          }
          if (cool > 0) cool--;
          var near = [null, null, null];
          for (var i = 0; i < entities.length; i++) {
            var e = entities[i];
            if (e.kind !== 'obstacle' || e.dead || e.z > 0 || e.z < -14) continue;
            // 按判定盒覆盖算：横杆 hx=3.9 跨三道，只看中心所在道会「看不见它」
            for (var ln = 0; ln < 3; ln++) {
              if (Math.abs(e.obj.position.x - CFG.LANES[ln]) >= e.hit.hx + HIT.halfX) continue;
              if (!near[ln] || e.z > near[ln].z) near[ln] = e;
            }
          }
          var ob = near[player.lane];
          if (ob) { obSeen++; if (ob.jumpable) jumpSeen++; }
          if (ob) {
            var v = Math.max(G.speed, 1);
            var half = ob.hit.hz + HIT.halfZ;
            var tIn = (-half - ob.z) / v;
            var span = 2 * half / v;
            // 跳跃决策不受换道冷却锁死 —— cool 只管换道，跳窗口不该被吞
            if (ob.jumpable && player.grounded && tIn > 0.02 && tIn < 2) {
              // 欧拉预测：跟 updatePlayer 一模一样的积分。
              // 旧版拿解析抛物线算，峰值比真实积分高 7 厘米，边界帧 bot 会
              // 「以为能过」结果一头撞上 —— 人玩家也会被同一件事骗。
              var ok = true, yy = 0, vy = CFG.JUMP_V, tf = 0;
              var yNeed = ob.hit.y1 - JUMP_CLEAR_EPS;
              while (tf <= tIn + span + 1e-9) {
                if (tf >= tIn - 1e-9 && yy < yNeed) { ok = false; break; }
                vy -= CFG.GRAVITY * dt; yy += vy * dt; tf += dt;
              }
              if (ok) { doJump(); jumps++; cool = 8; }
            } else if (!ob.jumpable && tIn < 1.2) {
              var bestLane = -1;
              for (var l = 0; l < 3; l++) {
                if (l === player.lane) continue;
                if (!near[l] || near[l].z < -9) { bestLane = l; break; }
              }
              if (bestLane >= 0) {
                if (cool <= 0) { moveLane(bestLane > player.lane ? 1 : -1); cool = 20; }
              } else {
                doDuck();   // 每帧续蹲 = 玩家按住下蹲键；点一下 0.62s 会差半拍被横杆扫到
              }
            }
          }
          checkCollisions(dt);
        }
        clearEntities();
        G.phase = 'ready';
        return { jumps: jumps, deaths: deaths, firstDeath: reason, killers: killers,
                 obSeen: obSeen, jumpSeen: jumpSeen };
      }
    }
  };

  /* ---- #simtest：把每个障碍的可跳过区间算出来写进 DOM，--dump-dom 直接读 ----
     #simtest&jv=8.05&jg=18&eps=0.06&shz=0.62 可以临时改参数试算，不用动源文件 */
  if (location.hash.indexOf('simtest') >= 0) {
    setTimeout(function () {
      var q = {};
      location.hash.replace(/(\w+)=([\d.]+)/g, function (_, k, v) { q[k] = parseFloat(v); });
      if (q.jv) CFG.JUMP_V = q.jv;
      if (q.jg) CFG.GRAVITY = q.jg;
      if (q.eps !== undefined) JUMP_CLEAR_EPS = q.eps;
      if (q.shz !== undefined) OB_HZ['shield'] = q.shz;

      var TYPES = [['豆包', 'bun'], ['刀盾', 'shield'], ['牛来', 'niulai'],
                   ['奶牛', 'cow'], ['噜噜', 'lulu'], ['猪猪侠', 'pigman']];
      var SPEEDS = [CFG.BASE_SPEED, 18, CFG.MAX_SPEED];
      var out = [], simPre = null;
      out.push('JUMP_V=' + CFG.JUMP_V + '  GRAVITY=' + CFG.GRAVITY +
               '  容差=' + JUMP_CLEAR_EPS + ' 土狼=' + CFG.COYOTE + ' 缓冲=' + CFG.JUMP_BUFFER +
               '  HIT.halfZ=' + HIT.halfZ);
      for (var i = 0; i < TYPES.length; i++) {
        var pb = window.NaiWa.debug.probe(TYPES[i][1]);
        out.push('SIZE ' + pb.name + ' 模型 宽' + pb.w.toFixed(2) + ' 高' + pb.h.toFixed(2) +
                 ' 深' + pb.d.toFixed(2) + ' 顶' + pb.yTop.toFixed(2) +
                 ' | 判定 y1=' + pb.hit.y1.toFixed(2) + ' hx=' + pb.hit.hx.toFixed(2) +
                 ' hz=' + pb.hit.hz.toFixed(2) + ' 可跳=' + pb.jumpable);
        for (var s = 0; s < SPEEDS.length; s++) {
          var w = window.NaiWa.debug.simWindow(TYPES[i][1], SPEEDS[s]);
          var seg = '无', slack = 0;
          if (w.runs.length) {
            seg = w.runs[0].lo.toFixed(2) + '~' + w.runs[0].hi.toFixed(2);
            slack = (w.runs[0].hi - w.runs[0].lo) / SPEEDS[s];
          }
          out.push('RESULT ' + TYPES[i][0] + ' v=' + SPEEDS[s].toFixed(1) +
                   ' 峰=' + w.peak.toFixed(3) + ' 可跳=' + seg +
                   ' 容错=' + slack.toFixed(2) + 's');
        }
      }
      // 收拾现场，别把游戏留在坏状态
      var tj = 0, td = 0, tk = [];
      for (var run = 0; run < 3; run++) {
        var bt = window.NaiWa.debug.simBot(30);
        tj += bt.jumps; td += bt.deaths;
        for (var ki = 0; ki < bt.killers.length; ki++) tk.push(bt.killers[ki]);
      }
      out.push('BOT 3×30秒固定步长全程模拟: 起跳 ' + tj + ' 次 · 死亡 ' + td +
               ' 次' + (tk.length ? ' 凶手:' + tk.join(',') : '') +
               (td === 0 && tj > 0 ? '  ✓ 全程无伤'
                 : (tj === 0 ? '  !! 一次都没跳' : '  △ 有死亡，查判定/策略')));
      // 手势回归：真的造 TouchEvent 派发到 document，验证四向滑动整条链路。
      // 不从 dom.canvas 派发，专挑 HUD 覆盖层当 target —— 这是旧版最容易漏的地方。
      (function () {
        var before = G.phase;
        var hud = document.getElementById('hud') || document.body;
        function ev(type, x, y, el) {
          if (typeof Touch !== 'function' || typeof TouchEvent !== 'function') return false;
          var t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
          var e = new TouchEvent(type, {
            touches: type === 'touchend' ? [] : [t],
            targetTouches: type === 'touchend' ? [] : [t],
            changedTouches: [t], bubbles: true, cancelable: true
          });
          el.dispatchEvent(e);
          return true;
        }
        function reset() {
          G.phase = 'playing';
          player.lane = 1; player.x = CFG.LANES[1];
          player.y = 0; player.vy = 0; player.grounded = true;
          player.duckKey = false; player.duckT = 0; player.jumpBufT = 0; player.coyoteT = 0;
        }
        function swipe(x0, y0, x1, y1, el) {
          reset();
          ev('touchstart', x0, y0, el);
          ev('touchmove', x1, y1, el);
          ev('touchend', x1, y1, el);
          return { lane: player.lane, grounded: player.grounded,
                   duck: player.duckKey || player.duckT > 0 };
        }
        if (typeof Touch !== 'function') {
          out.push('手势自检: 当前浏览器不支持合成 Touch，跳过');
        } else {
          var r = swipe(100, 300, 220, 300, hud);
          var l = swipe(100, 300, -20, 300, hud);
          var u = swipe(100, 300, 100, 180, hud);
          var d = swipe(100, 300, 100, 420, hud);
          var long = swipe(100, 300, 900, 300, hud);    // 一记长滑不该连换两道
          var tap = (function () {
            reset(); ev('touchstart', 100, 300, hud); ev('touchend', 100, 300, hud);
            return !player.grounded;
          })();
          var ok = r.lane === 2 && l.lane === 0 && !u.grounded && d.duck &&
                   long.lane === 2 && tap;
          out.push('手势自检: 右滑→' + r.lane + '道 左滑→' + l.lane + '道 ' +
                   '上滑' + (!u.grounded ? '起跳' : '没跳') + ' 下滑' + (d.duck ? '蹲' : '没蹲') +
                   ' 长滑→' + long.lane + '道(只走1道) 轻点' + (tap ? '跳' : '没跳') +
                   (ok ? '  ✓ 四向 + 覆盖层 + 单次触发全通过' : '  !! 有方向不对'));
          // 下滑的延时释放别留着影响后面
          player.duckKey = false; player.duckT = 0;
        }
        G.phase = before;
      })();

      // BGM 自检：文件在不在、播放请求有没有被拒、进度有没有真的在走
      (function () {
        var el = document.getElementById('bgm');
        if (!el) { out.push('BGM 自检: 页面上没有 #bgm 元素 !!'); return; }
        AudioSys.resume();
        AudioSys.startMusic();
        var t0 = el.currentTime;
        setTimeout(function () {
          var walking = el.currentTime > t0 + 0.2;
          var tail = walking ? '  ✓ 文件音乐在走'
                             : '  · 进度没走（headless 默认禁自动播放，属正常；就绪=4 即文件路径与解码 OK）';
          out.push('BGM 自检: src=' + (el.getAttribute('src') || '无') +
                   ' 状态=' + (el.paused ? 'paused' : 'playing') +
                   ' 就绪=' + el.readyState +
                   ' 进度=' + el.currentTime.toFixed(2) + 's' +
                   (el.error ? ' error=' + el.error.code : '') + tail);
          if (simPre) simPre.textContent = out.join('\n');   // 面板可能已经建好，补一行
        }, 600);
      })();
      clearEntities();
      G.phase = 'ready';
      simPre = document.createElement('pre');
      simPre.id = 'simout';
      simPre.textContent = out.join('\n');
      // --dump-dom 的排版会被 <pre> 之外的空白影响，这条也能顺便说明是跑过 sim 的
      simPre.setAttribute('style', 'position:fixed;left:4px;top:4px;font:12px monospace');
      document.body.appendChild(simPre);
      document.title = 'SIMTEST DONE';
    }, 1200);
  }
})();
