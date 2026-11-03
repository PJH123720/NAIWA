/* glb-lite.js —— 极简 GLB 解析器（只依赖 three 的 BufferGeometry / 材质）
 * 用途：纯 file:// 环境下加载 .glb，不引入 GLTFLoader，不依赖 fetch/XHR。
 * 支持：单个或多个 mesh、POSITION/NORMAL/TEXCOORD_0、uint16/uint32 索引、
 *       baseColorTexture / normalTexture、node 的 TRS 变换。不支持骨骼与动画。
 */
(function (global) {
  var T = global.THREE;

  function bufFromB64(b64) {
    var bin = global.atob(b64), n = bin.length, u8 = new Uint8Array(n);
    for (var i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }

  var CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  var NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

  function readComp(dv, off, ct) {
    if (ct === 5126) return dv.getFloat32(off, true);
    if (ct === 5125) return dv.getUint32(off, true);
    if (ct === 5123) return dv.getUint16(off, true);
    if (ct === 5121) return dv.getUint8(off);
    if (ct === 5122) return dv.getInt16(off, true);
    return dv.getInt8(off);
  }

  function accessor(json, bin, idx) {
    var a = json.accessors[idx];
    var bv = json.bufferViews[a.bufferView];
    var Arr = CT[a.componentType], nc = NC[a.type];
    var base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    var stride = bv.byteStride || 0;
    var esz = Arr.BYTES_PER_ELEMENT;
    var out = new Arr(a.count * nc);
    if (!stride || stride === nc * esz) {
      var dv0 = new DataView(bin);
      for (var i0 = 0; i0 < a.count * nc; i0++) out[i0] = readComp(dv0, base + i0 * esz, a.componentType);
    } else {
      var dv = new DataView(bin);
      for (var i = 0; i < a.count; i++) {
        for (var c = 0; c < nc; c++) {
          out[i * nc + c] = readComp(dv, base + i * stride + c * esz, a.componentType);
        }
      }
    }
    return out;
  }

  function b64FromU8(u8) {
    var CHUNK = 0x8000, parts = '';
    for (var i = 0; i < u8.length; i += CHUNK) {
      parts += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(parts);
  }

  function imageTexture(json, bin, texInfo, srgb, onReady) {
    if (!texInfo || texInfo.index == null) return null;
    var tex = json.textures[texInfo.index];
    var img = json.images[tex.source];
    if (!img || img.bufferView == null) return null;
    var bv = json.bufferViews[img.bufferView];
    var bytes = new Uint8Array(bin, bv.byteOffset || 0, bv.byteLength);
    var mime = img.mimeType || 'image/png';

    /* 关键：用 data: URL，不要用 blob: URL。
     * 原因有两个，都会让纹理变成空的：
     *   1. Android WebView 在 file:// 页面里会拒绝加载 blob: 图像（安全策略）；
     *   2. 原来在 onLoad 里立刻 revokeObjectURL，手机 GPU 上传慢，图像数据
     *      可能在上传进显存前就被释放。
     * 纹理为空时，three 会把带 map 的材质渲染成纯黑 —— 手机端「角色和障碍
     * 全黑」就是这个原因，跟光照无关，加多少环境光都没用。 */
    var url = 'data:' + mime + ';base64,' + b64FromU8(bytes);

    var t = new T.TextureLoader().load(
      url,
      function () { if (onReady) onReady(t); },
      undefined,
      function () { t.__nwFailed = true; if (onReady) onReady(t); }
    );
    t.flipY = false;
    t.wrapS = t.wrapT = T.RepeatWrapping;
    // 注意：这里故意不设 sRGB 编码。r150 下纹理编码和 renderer.outputEncoding
    // 必须成对设置，只设一边会让画面整体偏暗。当前效果是用户认可的，
    // 不做色彩管线改动，避免「修好了黑屏但颜色变样」。
    if (srgb && T.SRGBColorSpace) t.colorSpace = T.SRGBColorSpace;
    return t;
  }

  function buildMaterial(json, bin, matIndex, onTexture) {
    var mt = (json.materials && json.materials[matIndex]) || {};
    var pbr = mt.pbrMetallicRoughness || {};
    var col = 0xffffff;
    if (pbr.baseColorFactor) {
      col = new T.Color(pbr.baseColorFactor[0], pbr.baseColorFactor[1], pbr.baseColorFactor[2]);
      if (T.SRGBColorSpace && col.convertSRGBToLinear) { /* glTF 的 factor 已是线性值，保持不动 */ }
    }
    var m = new T.MeshPhongMaterial({
      color: col,
      shininess: 4,
      specular: 0x241E14,
      side: mt.doubleSided ? T.DoubleSide : T.FrontSide
    });
    var map = imageTexture(json, bin, pbr.baseColorTexture, true, function (t) {
      if (t && t.__nwFailed) {
        // 纹理彻底加载失败时退回纯色，至少不会是一团黑
        m.map = null;
        m.color.setHex(0xD8C49A);
      }
      m.needsUpdate = true;
      if (onTexture) onTexture();
    });
    if (map) m.map = map;
    var nrm = imageTexture(json, bin, mt.normalTexture, false);
    if (nrm) m.normalMap = nrm;
    return m;
  }

  function applyTRS(node, obj) {
    if (node.matrix) {
      var mm = new T.Matrix4().fromArray(node.matrix);
      mm.decompose(obj.position, obj.quaternion, obj.scale);
      return;
    }
    if (node.translation) obj.position.fromArray(node.translation);
    if (node.rotation) obj.quaternion.fromArray(node.rotation);
    if (node.scale) obj.scale.fromArray(node.scale);
  }

  function parse(buf, onTexture) {
    var dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('不是合法的 GLB 文件');
    var total = dv.getUint32(8, true), off = 12, json = null, bin = null;
    while (off < total) {
      var cl = dv.getUint32(off, true), ct = dv.getUint32(off + 4, true);
      off += 8;
      if (ct === 0x4E4F534A) {
        json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off, cl)));
      } else if (ct === 0x004E4942) {
        bin = buf.slice(off, off + cl);
      }
      off += cl;
    }
    if (!json || !bin) throw new Error('GLB 缺少 JSON 或 BIN 块');

    var root = new T.Group();
    var mats = [];
    function getMat(i) {
      if (mats[i] === undefined) mats[i] = buildMaterial(json, bin, i, onTexture);
      return mats[i];
    }

    function buildNode(ni) {
      var node = json.nodes[ni];
      var g = new T.Group();
      applyTRS(node, g);
      if (node.mesh != null) {
        var meshes = json.meshes[node.mesh].primitives;
        for (var p = 0; p < meshes.length; p++) {
          var pr = meshes[p];
          var geo = new T.BufferGeometry();
          var pos = accessor(json, bin, pr.attributes.POSITION);
          geo.setAttribute('position', new T.BufferAttribute(pos, 3));
          if (pr.attributes.NORMAL != null) {
            geo.setAttribute('normal', new T.BufferAttribute(accessor(json, bin, pr.attributes.NORMAL), 3));
          } else {
            geo.computeVertexNormals();
          }
          if (pr.attributes.TEXCOORD_0 != null) {
            geo.setAttribute('uv', new T.BufferAttribute(accessor(json, bin, pr.attributes.TEXCOORD_0), 2));
          }
          if (pr.indices != null) {
            geo.setIndex(new T.BufferAttribute(accessor(json, bin, pr.indices), 1));
          }
          var im = (pr.material != null) ? getMat(pr.material) : new T.MeshPhongMaterial({ color: 0xcccccc });
          var mh = new T.Mesh(geo, im);
          mh.name = (json.meshes[node.mesh].name || 'mesh') + '_' + p;
          g.add(mh);
        }
      }
      if (node.children) {
        for (var c = 0; c < node.children.length; c++) g.add(buildNode(node.children[c]));
      }
      return g;
    }

    var scene = json.scenes[json.scene || 0];
    var list = (scene && scene.nodes) || json.nodes.map(function (_, i) { return i; });
    for (var i = 0; i < list.length; i++) root.add(buildNode(list[i]));
    return root;
  }

  global.GLBLite = {
    bufFromB64: bufFromB64,
    parse: parse,
    loadB64: function (b64, onTexture) { return parse(bufFromB64(b64), onTexture); }
  };
})(window);
