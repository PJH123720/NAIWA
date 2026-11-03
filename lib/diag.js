/* lib/diag.js —— 手机端画面异常自检（v1.3 诊断用）
 *
 * 背景：APK 装到手机上角色和障碍全黑，桌面一切正常。用户手机没有开发者
 * 选项、连不上 adb，看不到 console。所以把关键信息画到 DOM 上 —— canvas
 * 黑掉时 DOM 覆盖层仍然可见，拍张照就能定位。
 *
 * 只在检测到异常时弹面板；正常时完全静默，不影响玩。
 * 连点屏幕左上角 5 次可以手动调出面板。
 */
(function () {
  'use strict';

  var VERSION = '1.4';
  var BUILD = '2026-11-03 14:45';
  var errs = [];
  var lostCount = 0;
  var sample = null;
  var reported = false;

  window.__NW_ERRS = errs;
  window.__NW_DIAG = { version: VERSION };

  /* ---------------- 1. 尽早接管错误 ---------------- */
  window.addEventListener('error', function (e) {
    try {
      var f = (e.filename || '').split('/').pop();
      errs.push('JS ' + (e.message || '') + ' @' + f + ':' + (e.lineno || 0));
      if (errs.length > 40) errs.shift();
    } catch (_) { }
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    try {
      var r = e.reason;
      errs.push('REJ ' + ((r && r.message) || r));
      if (errs.length > 40) errs.shift();
    } catch (_) { }
  });

  var _ce = console.error;
  console.error = function () {
    try {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        parts.push(a && a.message ? a.message : String(a));
      }
      errs.push('ERR ' + parts.join(' ').slice(0, 300));
      if (errs.length > 40) errs.shift();
    } catch (_) { }
    if (_ce) _ce.apply(console, arguments);
  };

  /* ---------------- 2. 采集 GPU / 上下文信息 ---------------- */
  function glInfo(r) {
    var out = {};
    try {
      var gl = r.getContext();
      out.webgl = gl.getParameter(gl.VERSION);
      out.gpu = gl.getParameter(gl.RENDERER);
      out.vendor = gl.getParameter(gl.VENDOR);
      out.glsl = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
      out.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      out.maxUnif = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
      out.w = gl.drawingBufferWidth;
      out.h = gl.drawingBufferHeight;
      out.lost = gl.isContextLost ? gl.isContextLost() : 'n/a';
    } catch (e) {
      out.error = String(e);
    }
    return out;
  }

  /* 读画面上中下三个像素。必须在一帧渲染完、present 之前读，
   * 所以由 game.js 在 renderer.render 之后回调。 */
  function readSky(r) {
    try {
      var gl = r.getContext();
      var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      var px = new Uint8Array(4);
      var pts = [['sky', 0.86], ['mid', 0.50], ['ground', 0.12]];
      var out = {};
      for (var i = 0; i < pts.length; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(Math.floor(w / 2), Math.floor(h * pts[i][1]), 1, 1,
          gl.RGBA, gl.UNSIGNED_BYTE, px);
        out[pts[i][0]] = [px[0], px[1], px[2], px[3]];
      }
      out.glErr = gl.getError();
      out.size = w + 'x' + h;
      return out;
    } catch (e) {
      return { fail: String(e) };
    }
  }

  /* ---------------- 3. 由 game.js 每帧渲染后回调采样 ----------------
   * 原来用「替换 renderer.render」的钩子，实测在部分环境根本不被调用，
   * 导致采样永远是空的。改成 game.js 主动回调，确定性最高。 */
  window.__NW_PROBE = function (r) {
    if (sample) return;
    try {
      sample = readSky(r);
    } catch (e) {
      sample = { fail: String(e) };
    }
  };

  /* ---------------- 4. 面板 ---------------- */
  function panel() {
    var el = document.getElementById('nw-diag');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'nw-diag';
    el.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:999999',
      'max-height:66vh', 'overflow:auto', 'box-sizing:border-box',
      'background:rgba(255,253,247,0.98)', 'border-top:4px solid #E05B5B',
      'font:12px/1.6 ui-monospace,Menlo,Consolas,monospace',
      'color:#2C2318', 'padding:12px 14px 18px',
      'white-space:pre-wrap', 'word-break:break-all',
      'box-shadow:0 -6px 24px rgba(0,0,0,0.22)'
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  function showDiag(bad) {
    var r = window.__NW_RENDERER;
    var g = r ? glInfo(r) : {};
    var lines = [];

    lines.push('奶蛙快跑 诊断  v' + VERSION + '  (' + BUILD + ')');
    lines.push('结论: ' + (bad ? '★ 检测到画面异常' : '画面正常'));
    lines.push('');

    if (!r) {
      lines.push('[渲染器] 未初始化 —— game.js 没有跑起来');
    } else {
      lines.push('[WebGL] ' + (g.webgl || '?'));
      lines.push('[GPU] ' + (g.gpu || '?'));
      lines.push('[厂商] ' + (g.vendor || '?'));
      lines.push('[GLSL] ' + (g.glsl || '?'));
      lines.push('[画布] ' + (g.w || '?') + ' x ' + (g.h || '?')
        + '  dpr=' + (window.devicePixelRatio || 1));
      lines.push('[上限] tex=' + (g.maxTex || '?') + '  uniformVec=' + (g.maxUnif || '?'));
      lines.push('[上下文] ' + (g.lost === true ? '已丢失' : '正常') + '  丢失次数=' + lostCount);
    }

    lines.push('');
    if (sample && sample.sky) {
      var names = [['sky', '天空'], ['mid', '画面中部'], ['ground', '地面/路面']];
      for (var s = 0; s < names.length; s++) {
        var p = sample[names[s][0]];
        var lum = Math.round(0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]);
        lines.push('[' + names[s][1] + '] rgba(' + p.join(',') + ')  亮度=' + lum);
      }
      lines.push('[glError] ' + sample.glErr);
      lines.push('  ↑ 天空正常是 (191,230,245) 亮度 220；全黑就是 (0,0,0) 亮度 0');
    } else if (sample && sample.fail) {
      lines.push('[采样] 失败: ' + sample.fail);
    } else {
      lines.push('[采样] 没拿到（渲染循环没跑，或探针没被调用）');
    }

    lines.push('');
    if (errs.length) {
      lines.push('[错误 ' + errs.length + ' 条]');
      for (var i = 0; i < Math.min(errs.length, 12); i++) lines.push('  - ' + errs[i]);
    } else {
      lines.push('[错误] 无');
    }

    lines.push('');
    var el = panel();
    el.innerHTML = '';

    var txt = document.createElement('div');
    txt.textContent = lines.join('\n');
    el.appendChild(txt);

    /* 两个一键自测：
     * A. 把天空涂红 —— 变红说明 WebGL 输出链路正常，问题只在物体材质/光照
     * B. 材质降级成无光照 —— 变彩色说明是光照或着色器编译的问题 */
    var bar = document.createElement('div');
    bar.style.cssText = 'margin-top:12px;display:flex;gap:8px;flex-wrap:wrap';

    function mkBtn(label, fn) {
      var b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = [
        'flex:1 1 46%', 'min-width:140px', 'padding:11px 8px',
        'border:0', 'border-radius:10px', 'background:#FFD75E',
        'color:#4A3608', 'font:bold 13px/1.2 sans-serif'
      ].join(';');
      b.onclick = function (ev) { ev.stopPropagation(); fn(); };
      return b;
    }

    bar.appendChild(mkBtn('A. 把天空涂成红色', paintSky));
    bar.appendChild(mkBtn('B. 材质改成不受光照', degrade));

    var close = document.createElement('button');
    close.textContent = '关闭面板';
    close.style.cssText = [
      'flex:1 1 100%', 'margin-top:2px', 'padding:10px 8px', 'border:0',
      'border-radius:10px', 'background:#EDE6D8', 'color:#6B5A3C',
      'font:bold 13px/1.2 sans-serif'
    ].join(';');
    close.onclick = function (ev) { ev.stopPropagation(); el.style.display = 'none'; };
    bar.appendChild(close);

    el.appendChild(bar);
    el.style.display = 'block';
    reported = true;
  }

  /* A. 天空涂红 */
  function paintSky() {
    try {
      var S = window.__NW_SCENE, TH = window.THREE;
      if (!S || !TH) { alert('拿不到场景对象'); return; }
      S.background = new TH.Color(0xFF0000);
    } catch (e) { alert('失败: ' + e); }
  }

  /* B. 所有受光材质降级成 MeshBasicMaterial，保留本色 */
  function degrade() {
    try {
      var S = window.__NW_SCENE, TH = window.THREE;
      if (!S || !TH) { alert('拿不到场景对象'); return; }
      var n = 0;
      S.traverse(function (o) {
        if (!o.isMesh || !o.material) return;
        var list = o.material.length ? o.material : [o.material];
        for (var i = 0; i < list.length; i++) {
          var m = list[i];
          if (!m || !(m.isMeshPhongMaterial || m.isMeshLambertMaterial)) continue;
          var b = new TH.MeshBasicMaterial();
          if (m.color) b.color.copy(m.color);
          if (m.map) b.map = m.map;
          if (m.vertexColors) b.vertexColors = true;
          b.side = m.side;
          b.transparent = m.transparent;
          b.opacity = m.opacity;
          if (o.material.length) o.material[i] = b; else o.material = b;
          n++;
        }
      });
      alert('已降级 ' + n + ' 个材质');
    } catch (e) { alert('失败: ' + e); }
  }

  /* ---------------- 5. 判定 ---------------- */
  function report() {
    var r = window.__NW_RENDERER;
    var bad = false;

    if (!r) {
      bad = true;                                  // 渲染器都没起来
    } else if (!sample) {
      bad = true;                                  // 渲染循环没跑
    } else if (sample.fail) {
      bad = true;
    } else if (sample.sky) {
      var p = sample.sky;
      var lum = 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
      if (lum < 45) bad = true;                    // 天空区域发黑
    }

    // 有任何 shader 编译/链接错误也算异常
    for (var i = 0; i < errs.length; i++) {
      if (/shader|program|compile|link|WebGL/i.test(errs[i])) { bad = true; break; }
    }

    if (bad) showDiag(true);
  }

  /* ---------------- 6. 启动 ---------------- */
  function boot() {
    var n = 0;
    var iv = setInterval(function () {
      n++;
      if (sample) clearInterval(iv);
      if (n > 120) clearInterval(iv);             // 最多等 12 秒
    }, 100);

    setTimeout(function () { if (!reported) report(); }, 4200);

    // 调试用：#diag 强制显示面板（本地截图验证面板排版用）
    if (/diag/i.test(location.hash)) {
      setTimeout(function () { showDiag(false); }, 2000);
    }

    // 连点左上角 5 次：手动调面板
    var taps = 0, last = 0;
    document.addEventListener('touchstart', function (e) {
      var t = e.touches && e.touches[0];
      if (!t || t.clientX > 90 || t.clientY > 90) return;
      var now = Date.now();
      taps = (now - last < 900) ? taps + 1 : 1;
      last = now;
      if (taps >= 5) { taps = 0; showDiag(false); }
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
