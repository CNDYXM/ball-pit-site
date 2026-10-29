/* ============================================================
 * 斗球场 BALL PIT — Canvas 战场渲染 v0.4
 * window.BallRenderer = { init, resize, pushEvents, render, reset, setReducedMotion }
 * 只画 #arena 内部：世界逻辑坐标（snapshot.arena.w/h），等比 letterbox；不画页面其它 UI。
 * 纯 Canvas2D，无外部依赖；所有事件/状态字段做容错。
 *
 * v0.4（V0.4-CONTRACT §八/九）：
 *  - 三角地图：arena.triangle.vertices（apex→right→left）画地面/网格裁剪/三条边/
 *    顶点角标/边长刻度/场外暗底；缺 triangle 字段时按等边外接圆兜底。
 *  - 随机障碍 snapshot.obstacles：圆形/三角形/正方形，普通墙（钢灰实体板）
 *    与超域（紫红高亮+旋转符文）区分；带生成/消散动画，绘制在球之前不遮球。
 *  - 地雷机关：可移动装置外观（滑橇/天线/引信），触发/爆炸半径，引力拉拽拖尾，
 *    主动「连环引爆」全场地雷闪光；explode 事件（mine/active/chain）冲击波+碎片+震屏。
 *  - 球体仍不画生命数字/血条；能量条由 UI 负责（renderer 不画）。
 * v0.3（历史）：
 *  - 共享像素表情 js/faces.js（BallFaces），战场态 calm/low/cast/hurt/victory/dead；
 *    UI 大厅/选球/斗士共用同一缓存。
 *  - 状态只显示效果名字，名字优先读 GameData.EFFECTS。
 *  - 蜂群像素蜜蜂、流星火痕余烬地面、特斯拉纯随机天雷、速胜时刻红边脉冲。
 * ============================================================ */
(function (root) {
  'use strict';

  var TAU = Math.PI * 2;
  var LOGIC = 1000;   // 地面烘焙参考尺寸（不是世界尺寸）
  var WORLD = 1000;   // 当前场地逻辑宽高（随 snapshot.arena 更新）
  var SHAPE = 'square';
  var ARENA_RADIUS = 500;
  var MAP_ID = 'square';
  var MAP_THEME = { accent: '#FF6B1A', accent2: '#FFC24B' };
  var MAX_PARTICLES = 400;
  var MAX_FLOATS = 60;
  var MAX_RINGS = 24;
  var MAX_CHAINS = 16;
  var MAX_STAMPS = 6;
  var MAX_WARPS = 10;
  var MAX_BOLTS = 10;      // 落雷（天雷）
  var MAX_WARNS = 14;      // 天雷预警圈（v0.3 纯随机可多道重叠）
  var MAX_BEES = 24;       // 蜂群召唤物上限（正常 3 / 暴动 6）
  var MAX_OBSTACLES = 16;  // 随机障碍上限（引擎每波 1–3，留容错）
  var TRI = null;          // 三角地图几何 {v:[{x,y}×3], cx, cy, radius, inradius}
  var MAX_STATUS_NAMES = 3; // 球下效果名最多几条，移动端更少

  var DEFAULT_PAL = {
    ink: '#0A0910', ink2: '#100E18', panel: '#151220', panel2: '#1B1728',
    line: '#312A42', cream: '#FFF4DC', muted: '#A89DBB',
    orange: '#FF6B1A', orange2: '#FFB347', violet: '#B060FF', violet2: '#D9A8FF',
    cyan: '#54E6FF', danger: '#FF4F6D', gold: '#FFC24B', good: '#7CFF9E'
  };

  var FONT_EN = '"BallArcade","BallPixel","Consolas",monospace';
  var FONT_ZH = '"BallPixel","BallArcade","Microsoft YaHei",sans-serif';

  /* ---------------- 数学 / 工具 ---------------- */
  function num(v, d) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : (d === undefined ? 0 : d);
  }
  function clamp(n, a, b) { return n < a ? a : (n > b ? b : n); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }

  /* 地图主题（方形橙 / 圆形青） */
  function themeForMap(mapId, shape) {
    try {
      var gd = root.GameData;
      var m = gd && gd.MAP_BY_ID ? gd.MAP_BY_ID[mapId] : null;
      if (m && m.accent) {
        return { accent: m.accent, accent2: m.accent2 || m.accent };
      }
    } catch (e) {}
    if (shape === 'circle') return { accent: '#54E6FF', accent2: '#B060FF' };
    if (shape === 'triangle') return { accent: '#7CFF9E', accent2: '#FFC24B' };
    return { accent: '#FF6B1A', accent2: '#FFC24B' };
  }
  function easeOutCubic(p) { var q = 1 - p; return 1 - q * q * q; }
  function easeOutQuad(p) { return 1 - (1 - p) * (1 - p); }
  function easeOutBack(p) {
    var c1 = 1.70158, c3 = c1 + 1, q = p - 1;
    return 1 + c3 * q * q * q + c1 * q * q;
  }
  function hashStr(s) {
    var h = 2166136261 >>> 0, i;
    s = String(s == null ? 'x' : s);
    for (i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function rnd(seed, i) {
    var x = Math.sin(seed * 0.0001 + i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  /* ---------------- 地图几何：三角（v0.4） ----------------
   * 优先用 snapshot.arena.triangle.vertices（apex→right→left，sim 精确坐标）；
   * 缺字段时按等边三角形外接圆兜底（顶点朝上）。
   */
  function triPointOf(p) {
    if (!p) return null;
    if (Array.isArray(p) && p.length >= 2) return { x: num(p[0], 0), y: num(p[1], 0) };
    if (typeof p.x === 'number' || typeof p.y === 'number') {
      return { x: num(p.x, 0), y: num(p.y, 0) };
    }
    return null;
  }
  function buildTriangle(arenaInfo) {
    var info = arenaInfo || {};
    var tri = info.triangle || {};
    var v = null, i;
    var raw = tri.vertices || info.triangleVertices;
    if (raw && raw.length >= 3) {
      v = [];
      for (i = 0; i < 3; i++) {
        var p = triPointOf(raw[i]);
        if (p) v.push(p);
      }
      if (v.length < 3) v = null;
    }
    if (!v) {
      var pa = triPointOf(tri.apex || tri.top), pr = triPointOf(tri.right), pl = triPointOf(tri.left);
      if (pa && pr && pl) v = [pa, pr, pl];
    }
    if (!v) {
      var W = num(info.w, WORLD) || WORLD;
      var H = num(info.h, WORLD) || WORLD;
      var rad = num(tri.radius, num(info.radius, Math.min(W, H) / 2));
      if (!(rad > 0)) rad = Math.min(W, H) / 2;
      rad *= 0.985;
      var ccx = num(tri.center && tri.center.x, W / 2);
      var ccy = num(tri.center && tri.center.y, H / 2);
      v = [];
      for (i = 0; i < 3; i++) {
        var ang = -Math.PI / 2 + i * (TAU / 3);
        v.push({ x: ccx + Math.cos(ang) * rad, y: ccy + Math.sin(ang) * rad });
      }
    }
    var gx = (v[0].x + v[1].x + v[2].x) / 3;
    var gy = (v[0].y + v[1].y + v[2].y) / 3;
    var radius = 0;
    for (i = 0; i < 3; i++) {
      var dx = v[i].x - gx, dy = v[i].y - gy;
      radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy));
    }
    var inradius = num(tri.inradius, radius * 0.5) || radius * 0.5;
    return { v: v, cx: gx, cy: gy, radius: radius, inradius: inradius };
  }

  /* 三角形顶点向重心内缩 inset（世界单位） */
  function trianglePoints(t, inset) {
    var out = [], i;
    inset = num(inset, 0);
    for (i = 0; i < 3; i++) {
      var v = t.v[i];
      var dx = t.cx - v.x, dy = t.cy - v.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-6) { out.push({ x: v.x, y: v.y }); continue; }
      var k = clamp(inset / d, 0, 0.98);
      out.push({ x: v.x + dx * k, y: v.y + dy * k });
    }
    return out;
  }
  function triPathAt(ctx, pts) {
    if (!pts || pts.length < 3) return false;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    ctx.closePath();
    return true;
  }
  function triPathWorld(ctx, inset) {
    if (!TRI) return false;
    return triPathAt(ctx, trianglePoints(TRI, inset));
  }
  /* 世界坐标 → 竞技场屏幕坐标（0..S，drawBoundary/overlay 用） */
  function triScreenPoints(S, inset) {
    if (!TRI) return null;
    var pts = trianglePoints(TRI, inset), out = [], i;
    var k = S / WORLD;
    for (i = 0; i < 3; i++) out.push({ x: pts[i].x * k, y: pts[i].y * k });
    return out;
  }
  function distPoint(ax, ay, bx, by) {
    var dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* ---------------- 颜色 ---------------- */
  var rgbCache = {};
  function parseColor(c) {
    if (typeof c !== 'string' || !c) return [255, 244, 220];
    if (rgbCache[c]) return rgbCache[c];
    var out = [255, 244, 220], s = c.trim();
    if (s.charAt(0) === '#') {
      if (s.length === 4) {
        out = [parseInt(s.charAt(1) + s.charAt(1), 16), parseInt(s.charAt(2) + s.charAt(2), 16), parseInt(s.charAt(3) + s.charAt(3), 16)];
      } else if (s.length >= 7) {
        out = [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
      }
    } else {
      var m = s.match(/rgba?\(([^)]+)\)/);
      if (m) {
        var p = m[1].split(',');
        out = [Math.round(num(p[0], 255)), Math.round(num(p[1], 244)), Math.round(num(p[2], 220))];
      }
    }
    for (var i = 0; i < 3; i++) if (!isFinite(out[i])) out[i] = 255;
    rgbCache[c] = out;
    return out;
  }
  function rgba(c, a) {
    var p = parseColor(c);
    return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + (a === undefined ? 1 : Math.round(a * 1000) / 1000) + ')';
  }
  var mixCache = {};
  function mix(a, b, t) {
    var key = a + '|' + b + '|' + (Math.round(t * 100) / 100);
    if (mixCache[key]) return mixCache[key];
    var p = parseColor(a), q = parseColor(b);
    var r = Math.round(lerp(p[0], q[0], t)), g = Math.round(lerp(p[1], q[1], t)), bl = Math.round(lerp(p[2], q[2], t));
    var s = 'rgb(' + r + ',' + g + ',' + bl + ')';
    mixCache[key] = s;
    return s;
  }
  function shade(c, amt) {
    return amt >= 0 ? mix(c, '#FFF4DC', amt) : mix(c, '#0A0910', -amt);
  }

  /* ---------------- 状态 ---------------- */
  var R = {
    canvas: null,
    ctx: null,
    data: null,
    pal: DEFAULT_PAL,
    inited: false,
    reducedMotion: false,
    view: { cssW: 0, cssH: 0, dpr: 1, size: 0, offX: 0, offY: 0, scale: 1 },
    snapshot: null,
    lastView: null,
    clock: 0,
    lastTime: 0,
    frame: 0,
    shake: 0,
    stormPulse: 0,
    overInfo: null,
    particles: [],
    floats: [],
    rings: [],
    chains: [],
    stamps: [],
    warps: [],
    bolts: [],
    warns: [],
    beeTrail: {},
    obsPrev: {},
    minePos: {},
    mineTrail: {},
    detonateAt: -99,
    flash: 0,
    suddenSeen: false,
    faceSt: {},
    faceSeen: 0,
    labelW: {},
    fontKey: '',
    trails: {},
    trailSeen: 0,
    bounceAt: {},
    emberAcc: 0,
    scanPattern: null,
    floorCanvas: null,
    fontsReady: false,
    needsRepaint: false,
    debug: false,
    ro: null,
    _warned: {}
  };

  function warnOnce(key, err) {
    if (R._warned[key]) return;
    R._warned[key] = true;
    if (root.console && root.console.warn) root.console.warn('[BALLPIT render]', key, err || '');
  }

  function statusKind(e, kind) {
    var st = e && e.statuses;
    if (!st || !st.length) return null;
    for (var i = 0; i < st.length; i++) {
      if (st[i] && st[i].kind === kind) return st[i];
    }
    return null;
  }
  function hasStatus(e, kind) { return !!statusKind(e, kind); }

  /* ---------------- 效果名：优先读 GameData.EFFECTS ----------------
   * 战场只显示名字，不显示数值/时间/方框；颜色按 id 固定，保证辨识度。
   * pri 越大越先显示（受控效果优先于增益），最多显示 MAX_STATUS_NAMES 条。
   */
  var EFFECT_COLORS = {
    slow: '#54E6FF', haste: '#FFD642', dash: '#FFC24B', evade: '#D9A8FF',
    root: '#FFC24B', immune: '#FFF4DC', phase: '#D9A8FF', superHeavy: '#8FA3B8',
    armorBreak: '#FF9B57', weakness: '#C58BFF', shield: '#54E6FF', heal: '#7CFF9E',
    reflect: '#FF4F6D', knockback: '#FFC24B', phaseWall: '#D9A8FF'
  };
  var STATUS_PRI = {
    root: 10, slow: 9, armorBreak: 9, weakness: 9, phase: 8,
    burn: 7, poison: 7, immune: 6, superHeavy: 5, reflect: 4,
    spike: 3, invuln: 3, evade: 3, haste: 2, atkUp: 2, shield: 1, heal: 1
  };
  // 不在通用词表里的技能专属/旧状态兜底名
  var STATUS_FALLBACK = {
    burn: { name: '灼烧', color: '#FF6B1A' },
    poison: { name: '中毒', color: '#7CFF9E' },
    spike: { name: '尖刺', color: '#FF4F6D' },
    atkUp: { name: '狂暴', color: '#FF4F6D' },
    invuln: { name: '无敌', color: '#FFF4DC' }
  };
  var STATUS_META = null;
  function effectTable() {
    var gd = R.data || root.GameData;
    return (gd && gd.EFFECTS && gd.EFFECTS.length) ? gd.EFFECTS : null;
  }
  function statusMeta(kind) {
    if (!STATUS_META) {
      STATUS_META = {};
      var table = effectTable();
      var i, id;
      // 先铺兜底（旧字段/技能专属）
      for (id in STATUS_FALLBACK) {
        STATUS_META[id] = { name: STATUS_FALLBACK[id].name, color: STATUS_FALLBACK[id].color, pri: STATUS_PRI[id] || 0 };
      }
      // 再用 EFFECTS 覆盖（唯一文案来源）
      if (table) {
        for (i = 0; i < table.length; i++) {
          var ef = table[i];
          if (!ef || !ef.id) continue;
          STATUS_META[ef.id] = {
            name: typeof ef.name === 'string' && ef.name ? ef.name : ef.id,
            color: EFFECT_COLORS[ef.id] || R.pal.cream,
            pri: STATUS_PRI[ef.id] || 1
          };
        }
      }
      // 通用 id 即使 data 没有 EFFECTS 也用规范名
      for (id in EFFECT_COLORS) {
        if (!STATUS_META[id]) {
          STATUS_META[id] = {
            name: (STATUS_FALLBACK[id] && STATUS_FALLBACK[id].name) || id,
            color: EFFECT_COLORS[id],
            pri: STATUS_PRI[id] || 1
          };
        }
      }
    }
    return STATUS_META[kind] || null;
  }

  /* ============================================================
   * 生命周期
   * ============================================================ */
  function init(canvas, opts) {
    opts = opts || {};
    if (!canvas || typeof canvas.getContext !== 'function') {
      warnOnce('no-canvas');
      return;
    }
    var ctx = null;
    try { ctx = canvas.getContext('2d'); } catch (e) { ctx = null; }
    if (!ctx) { warnOnce('no-ctx'); return; }

    R.canvas = canvas;
    R.ctx = ctx;
    R.data = opts.data || root.GameData || {};
    var dp = R.data.PALETTE || {};
    R.pal = {};
    for (var k in DEFAULT_PAL) R.pal[k] = (typeof dp[k] === 'string' && dp[k]) ? dp[k] : DEFAULT_PAL[k];
    R.reducedMotion = !!(opts.reducedMotion || (root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches));
    R.inited = true;
    R.debug = !!(opts.debug);

    reset();
    resize();
    bakeFloor();

    /* 字体：加载完成后重烘焙地面 + 重绘一帧 */
    var onFonts = function () {
      R.fontsReady = true;
      R.labelW = {};   // 字体换了，状态名宽度缓存作废
      try { bakeFloor(); } catch (e) {}
      repaintOnce();
    };
    if (root.document && root.document.fonts) {
      try {
        var fd = root.document.fonts;
        if (fd.load) {
          var p1 = fd.load('16px "BallArcade"');
          var p2 = fd.load('16px "BallPixel"');
          if (p1 && p1.then && p2 && p2.then) {
            Promise.all([p1, p2]).then(onFonts, function () {});
          }
        }
        if (fd.ready && fd.ready.then) fd.ready.then(onFonts, function () {});
      } catch (e) { R.fontsReady = true; }
    } else {
      R.fontsReady = true;
    }

    /* 尺寸监听：UI 的 .arena-frame 改变时自动 resize */
    if (root.ResizeObserver) {
      try {
        R.ro = new root.ResizeObserver(function () { resize(); });
        R.ro.observe(canvas);
      } catch (e) { R.ro = null; }
    }
    if (root.addEventListener) root.addEventListener('resize', resize, { passive: true });
    try {
      var mq = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)');
      if (mq && mq.addEventListener) {
        mq.addEventListener('change', function (ev) { R.reducedMotion = !!ev.matches; });
      }
    } catch (e) {}
  }

  function repaintOnce() {
    if (!R.snapshot || !R.ctx) return;
    try { render(R.snapshot, R.lastView || {}); } catch (e) { warnOnce('repaint', e); }
  }

  function resize() {
    var c = R.canvas;
    if (!c) return;
    var cssW = c.clientWidth, cssH = c.clientHeight;
    if (!cssW || !cssH) {
      try {
        var rect = c.getBoundingClientRect();
        cssW = rect.width; cssH = rect.height;
      } catch (e) {}
    }
    if (!cssW || !cssH) { cssW = cssW || 800; cssH = cssH || 800; }
    var dpr = clamp(num(root.devicePixelRatio, 1), 1, 2);
    var bw = Math.max(1, Math.round(cssW * dpr));
    var bh = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
    var size = Math.min(cssW, cssH);
    R.view = {
      cssW: cssW, cssH: cssH, dpr: dpr,
      size: size, scale: size / WORLD,
      offX: (cssW - size) / 2, offY: (cssH - size) / 2
    };
    buildScanPattern();
  }

  function buildScanPattern() {
    if (!R.ctx || !root.document || !root.document.createElement) return;
    try {
      var cv = root.document.createElement('canvas');
      cv.width = 1; cv.height = 3;
      var cx = cv.getContext('2d');
      cx.fillStyle = 'rgba(4,3,9,0.16)';
      cx.fillRect(0, 2, 1, 1);
      cx.fillStyle = 'rgba(255,244,220,0.018)';
      cx.fillRect(0, 0, 1, 1);
      R.scanPattern = R.ctx.createPattern(cv, 'repeat');
    } catch (e) { R.scanPattern = null; }
  }

  function reset() {
    R.particles.length = 0;
    R.floats.length = 0;
    R.rings.length = 0;
    R.chains.length = 0;
    R.stamps.length = 0;
    R.warps.length = 0;
    R.bolts.length = 0;
    R.warns.length = 0;
    R.beeTrail = {};
  R.beeSmooth = {};
    R.obsPrev = {};
    R.minePos = {};
    R.mineTrail = {};
    R.detonateAt = -99;
    R.flash = 0;
    R.suddenSeen = false;
    R.faceSt = {};
    R.faceSeen = 0;
    R.labelW = {};
    R.trails = {};
    R.bounceAt = {};
    R.shake = 0;
    R.stormPulse = 0;
    R.overInfo = null;
    R.clock = 0;
    R.lastTime = 0;
    R.emberAcc = 0;
    R.overCleaned = false;
    R.snapshot = null;
    R.lastView = null;
  }

  function setReducedMotion(on) {
    R.reducedMotion = !!on;
    if (R.reducedMotion) {
      R.shake = 0;
      if (R.particles.length > 120) R.particles.length = 120;
    }
  }

  /* ============================================================
   * 特效对象池 / 生成器
   * ============================================================ */
  function addParticle(p) {
    if (R.particles.length >= MAX_PARTICLES) R.particles.shift();
    R.particles.push(p);
  }
  function addFloat(f) {
    var i, o;
    // 同一目标 0.35s 内的伤害数字合并，避免 -21/-20/-22 叠成一团
    if (f.type === 'dmg' && f.mergeKey) {
      for (i = R.floats.length - 1; i >= 0; i--) {
        o = R.floats[i];
        if (o.type !== 'dmg' || o.mergeKey !== f.mergeKey) continue;
        if (o.maxLife - o.life > 0.35) continue;
        o.amount = (o.amount || 0) + (f.amount || 0);
        o.text = '-' + Math.round(o.amount);
        o.life = Math.min(o.maxLife, o.life + 0.18);
        o.size = clamp(13 + o.amount * 0.5, 14, 32);
        if (o.kind !== 'storm') {
          o.color = o.amount >= 20 ? R.pal.orange : o.baseColor;
        }
        o.y = Math.min(o.y, f.y);
        return;
      }
    }
    // 巫医毒伤回复按 0.25s 一跳，回复数字合并成一条，避免刷屏
    if (f.type === 'heal' && f.mergeKey) {
      for (i = R.floats.length - 1; i >= 0; i--) {
        o = R.floats[i];
        if (o.type !== 'heal' || o.mergeKey !== f.mergeKey) continue;
        if (o.maxLife - o.life > 0.62) continue;
        o.amount = (o.amount || 0) + (f.amount || 0);
        o.text = '+' + Math.round(o.amount);
        o.life = Math.min(1.15, o.life + 0.22);
        o.maxLife = Math.max(o.maxLife, o.life);
        o.size = clamp(15 + o.amount * 0.35, 15, 22);
        return;
      }
    }
    // 与附近飘字错位，保持可读（伤害/治疗/施法名都参与）
    if (f.type === 'dmg' || f.type === 'heal' || f.type === 'cast') {
      for (i = 0; i < R.floats.length; i++) {
        o = R.floats[i];
        if (o.type !== 'dmg' && o.type !== 'heal' && o.type !== 'cast') continue;
        if (f.type === 'cast' && o.type === 'cast') continue;
        if (Math.abs(o.x - f.x) < 60 && Math.abs(o.y - f.y) < 34) {
          f.x += (f.x >= o.x ? 1 : -1) * (34 + (i % 3) * 12);
          f.y -= 16 + (i % 3) * 9;
          f.vx = (f.x >= 500 ? 1 : -1) * 10;
          break;
        }
      }
    }
    if (R.floats.length >= MAX_FLOATS) R.floats.shift();
    R.floats.push(f);
  }

  function findEntity(id) {
    var arr = (R.snapshot && R.snapshot.entities) || [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id === id) return arr[i];
    }
    return null;
  }
  function addRing(g) {
    if (R.rings.length >= MAX_RINGS) R.rings.shift();
    R.rings.push(g);
  }
  function addChain(c) {
    if (R.chains.length >= MAX_CHAINS) R.chains.shift();
    R.chains.push(c);
  }
  function addStamp(s) {
    // 多球同时出局时错开印章，避免叠成一团（双杀可能同帧出局）
    for (var i = 0; i < R.stamps.length; i++) {
      var o = R.stamps[i];
      if (Math.abs(o.x - s.x) < 150 && Math.abs(o.y - s.y) < 90) {
        s.x += (s.x >= o.x ? 1 : -1) * (92 + i * 40);
        s.y -= 30 + i * 16;
        break;
      }
    }
    if (R.stamps.length >= MAX_STAMPS) R.stamps.shift();
    R.stamps.push(s);
  }
  function addWarp(w) {
    if (R.warps.length >= MAX_WARPS) R.warps.shift();
    R.warps.push(w);
  }
  function addWarn(w) {
    if (R.warns.length >= MAX_WARNS) R.warns.shift();
    R.warns.push(w);
  }
  function addBolt(b) {
    if (R.bolts.length >= MAX_BOLTS) R.bolts.shift();
    R.bolts.push(b);
  }
  /* 落雷：闪电折线 + 地面冲击；用于天雷（特斯拉被动） */
  function makeBoltPath(x, y) {
    var pts = [{ x: x + rand(-14, 14), y: -40 }];
    var segs = 7;
    for (var i = 1; i < segs; i++) {
      var p = i / segs;
      pts.push({
        x: x + rand(-1, 1) * (26 * (1 - p) + 5),
        y: -40 + (y + 40) * p
      });
    }
    pts.push({ x: x, y: y });
    return pts;
  }
  function spawnLightning(x, y, radius, color) {
    color = color || R.pal.gold;
    var r = Math.max(18, num(radius, 60));
    var bolt = {
      x: x, y: y, r: r, color: color,
      life: 0.3, maxLife: 0.3,
      main: makeBoltPath(x, y),
      branch: [], branch2: []
    };
    // 两条分叉（固定的折线，闪一下就好）
    for (var b = 0; b < 3; b++) {
      var t = rand(0.15, 0.7);
      var sx = lerp(bolt.main[0].x, x, t), sy = lerp(-40, y, t);
      var ang = rand(-1.2, 1.2) + (b % 2 ? Math.PI : 0);
      var len = rand(28, 70);
      var seg = [{ x: sx, y: sy }];
      for (var s = 1; s <= 3; s++) {
        seg.push({
          x: sx + Math.cos(ang) * len * (s / 3) + rand(-12, 12),
          y: sy + Math.abs(Math.sin(ang)) * len * (s / 3) * 0.6 + rand(-8, 8)
        });
      }
      if (b === 2) bolt.branch2.push(seg); else bolt.branch.push(seg);
    }
    addBolt(bolt);
    addRing({ x: x, y: y, r0: 6, r1: r * 1.15, life: 0.3, maxLife: 0.3, color: color, width: 3, kind: 'thunder' });
    addRing({ x: x, y: y, r0: r * 0.4, r1: r * 0.75, life: 0.45, maxLife: 0.45, color: '#FFF7E6', width: 1.6, kind: 'thunderInner' });
    spawnSparks(x, y, 10, color, { speed: 240, grav: 90 });
    // 近处预警圈立刻让位（避免预警还在，雷已落）
    for (var i = R.warns.length - 1; i >= 0; i--) {
      var w = R.warns[i];
      if (Math.abs(w.x - x) < Math.max(30, w.r * 0.5) && Math.abs(w.y - y) < Math.max(30, w.r * 0.5)) {
        R.warns.splice(i, 1);
      }
    }
    R.flash = Math.max(R.flash, R.reducedMotion ? 0.06 : 0.15);
    shake(4);
  }

  /* ---------------- 情绪/表情状态机（v0.3） ----------------
   * 战斗态（V0.3-CONTRACT §六）：
   *   dead > victory > low > cast > hurt > calm
   * hurt  : 直接命中后 0.2s（或 flash 高）；DoT 不打断表情
   * cast  : 施法后保持 1.05s；频繁施法只续期，动画相位连续
   * low   : hpPct < 30% 进入，> 38% 退出（滞回，防抖）
   * victory/dead 只在 snapshot.status==='over' 时出现
   */
  var FACE_HURT_HOLD = 0.2;
  var FACE_CAST_HOLD = 1.05;
  function ensureFace(id) {
    var st = R.faceSt[id];
    if (!st) {
      st = R.faceSt[id] = {
        hurtAt: -99, castAt: -99, castHold: FACE_CAST_HOLD,
        low: false, seed: hashStr(id || 'ball'),
        faceState: '', faceAt: 0,
        burnAcc: 0, poisonAcc: 0, healAcc: 0
      };
    }
    return st;
  }
  function markHurt(id) {
    if (id === null || id === undefined) return;
    ensureFace(id).hurtAt = R.clock;
  }
  function markCast(id, hold) {
    if (id === null || id === undefined) return;
    var st = ensureFace(id);
    st.castAt = R.clock;
    st.castHold = Math.max(FACE_CAST_HOLD, num(hold, FACE_CAST_HOLD));
  }
  function faceStateOf(e, hpPct, flash, over, isWinner) {
    var st = ensureFace(e.id !== undefined ? e.id : (e.ballId || 'ball'));
    var now = R.clock;
    // 低血量滞回
    if (hpPct < 0.30) st.low = true;
    else if (hpPct > 0.38) st.low = false;
    var hurt = flash > 0.5 || (now - st.hurtAt) < FACE_HURT_HOLD;
    var cast = !!(e.castGlow && num(e.castGlow.remaining, 0) > 0) ||
      (now - st.castAt) < st.castHold;
    var state;
    if (over) state = isWinner ? 'victory' : 'dead';
    else if (st.low) state = 'low';
    else if (cast) state = 'cast';
    else if (hurt) state = 'hurt';
    else state = 'calm';
    return { state: state, low: st.low, hurt: hurt, cast: cast, st: st, seed: st.seed, dead: !e.alive };
  }

  function shake(amount) {
    if (R.reducedMotion) return;
    R.shake = Math.min(18, R.shake + amount);
  }
  function pScale() { return R.reducedMotion ? 0.4 : 1; }

  function spawnSparks(x, y, count, color, opt) {
    opt = opt || {};
    var n = Math.max(1, Math.round(count * pScale()));
    var speed = opt.speed || 190;
    for (var i = 0; i < n; i++) {
      var a = rand(0, TAU), s = rand(speed * 0.25, speed);
      addParticle({
        kind: 'spark', x: x + rand(-3, 3), y: y + rand(-3, 3),
        vx: Math.cos(a) * s + (opt.vx || 0), vy: Math.sin(a) * s + (opt.vy || 0),
        life: rand(0.18, 0.5), maxLife: 0.5, size: rand(2, 4.6),
        color: color || R.pal.cream, grav: opt.grav === undefined ? 40 : opt.grav,
        drag: 2.6, add: false
      });
    }
  }

  function spawnHealSparkles(x, y, count) {
    var n = Math.max(2, Math.round(count * pScale()));
    for (var i = 0; i < n; i++) {
      addParticle({
        kind: 'ember', x: x + rand(-12, 12), y: y + rand(-6, 6),
        vx: rand(-14, 14), vy: rand(-70, -34), life: rand(0.4, 0.8), maxLife: 0.8,
        size: rand(2, 4), color: R.pal.good, grav: -10, drag: 0.6
      });
    }
  }

  function spawnDebris(x, y, count, color, color2) {
    var n = Math.max(2, Math.round(count * pScale()));
    for (var i = 0; i < n; i++) {
      var a = rand(0, TAU), s = rand(60, 320);
      addParticle({
        kind: i % 3 === 0 ? 'debris' : 'spark',
        x: x + rand(-4, 4), y: y + rand(-4, 4),
        vx: Math.cos(a) * s, vy: Math.sin(a) * s - 20,
        life: rand(0.45, 0.95), maxLife: 0.95, size: rand(3, 7),
        color: i % 3 === 0 ? shade(color, -0.25) : (i % 2 ? color2 : color),
        grav: 260, drag: 1.2
      });
    }
  }

  /* ============================================================
   * pushEvents → 特效
   * ============================================================ */
  function pushEvents(events) {
    if (!events || !events.length) return;
    var n = events.length;
    for (var i = 0; i < n; i++) {
      var ev = events[i];
      if (!ev || typeof ev !== 'object') continue;
      try { handleEvent(ev); } catch (e) { warnOnce('evt-' + ev.type, e); }
    }
  }

  function handleEvent(ev) {
    switch (ev.type) {
      case 'hit': onHit(ev); break;
      case 'heal': onHeal(ev); break;
      case 'cast': onCast(ev); break;
      case 'death': onDeath(ev); break;
      case 'chain': onChain(ev); break;
      case 'ring': onRing(ev); break;
      case 'bounce': onBounce(ev); break;
      case 'warp': onWarp(ev); break;
      case 'spawn': onSpawn(ev); break;
      case 'over': onOver(ev); break;
      /* v0.4 新增：地雷爆炸（普通/连锁/主动引爆） */
      case 'explode':
      case 'explosion':
      case 'detonate':
        onExplode(ev); break;
      /* 新技能事件：天雷（兼容多种命名，缺字段也不崩） */
      case 'thunder':
      case 'thunderWarn':
      case 'thunderwarn':
      case 'lightning':
      case 'lightningWarn':
      case 'thunderStrike':
      case 'thunderstrike':
      case 'bolt':
      case 'strike':
      case 'mark':
        onThunder(ev); break;
      /* debuff/状态施加（sim 不一定会发，容忍） */
      case 'debuff':
      case 'status':
      case 'statusApply':
      case 'slow':
      case 'weakness':
      case 'armorBreak':
      case 'root':
        onDebuff(ev); break;
      default: break;
    }
  }

  /* 天雷：可能是预警（带 warn/delay）也可能是一道落雷；两种都吃 */
  function onThunder(ev) {
    var x = num(ev.x, WORLD / 2), y = num(ev.y, WORLD / 2);
    var color = (typeof ev.color === 'string' && ev.color) ? ev.color : R.pal.gold;
    var radius = Math.max(10, num(ev.radius != null ? ev.radius : ev.r, 60));
    var warn = num(ev.warn != null ? ev.warn : (ev.delay != null ? ev.delay : (ev.preview != null ? ev.preview : 0)), 0);
    var isWarn = !!ev.warn || warn > 0.02 || ev.type === 'thunderWarn' || ev.type === 'lightningWarn' ||
      ev.type === 'mark' || ev.phase === 'warn' || ev.stage === 'warn';
    if (isWarn) {
      addWarn({ x: x, y: y, r: radius, life: warn > 0.02 ? warn : 0.35, maxLife: warn > 0.02 ? warn : 0.35, color: color, auto: true });
      return;
    }
    spawnLightning(x, y, radius, color);
  }

  /* 状态施加：给目标一点小反馈（具体状态名由快照画；这里只做火花/上浮表现） */
  function onDebuff(ev) {
    var target = findEntity(ev.targetId || ev.entityId);
    var x = num(ev.x, target ? target.x : WORLD / 2);
    var y = num(ev.y, target ? target.y : WORLD / 2);
    var kind = ev.kind || ev.effect || ev.status || ev.type || '';
    var meta = statusMeta(kind) || { name: '', color: R.pal.violet2 };
    var tr = target ? Math.max(10, num(target.r, 30)) : 24;
    spawnSparks(x, y - tr * 0.3, 5, meta.color, { speed: 90, grav: -20 });
    if (meta.name) {
      addFloat({
        text: meta.name, x: x, y: y - tr - 16, vy: -18, vx: 0,
        life: 0.7, maxLife: 0.7, color: meta.color, size: 13, type: 'debuff'
      });
    }
  }

  function onHit(ev) {
    var x = num(ev.x, WORLD / 2), y = num(ev.y, WORLD / 2);
    var amount = num(ev.amount, 0);
    var kind = ev.kind || 'hit';
    var evColor = (typeof ev.color === 'string' && ev.color) ? ev.color : null;
    var target = findEntity(ev.targetId);
    var tr = target ? Math.max(10, num(target.r, 30)) : 24;
    var baseY = y - tr * (amount >= 20 ? 0.95 : 0.82) - 10;

    // 只有直接命中才触发表情「受击」；持续伤害（毒/火/场地）不打断表情，
    // 否则中毒球会永久卡在 X 眼（dot 每 0.25s 一跳）
    var flinch = kind === 'hit' || kind === 'reflect' || kind === 'chain' ||
      kind === 'zap' || kind === 'thunder' || kind === 'lightning' || kind === 'bolt';
    if (flinch && ev.targetId != null) markHurt(ev.targetId);

    if (amount < 1) {
      if (kind === 'miss' || ev.miss) {
        addFloat({
          text: 'MISS', x: x + rand(-6, 6), y: baseY, vy: -42,
          life: 0.75, maxLife: 0.75, color: R.pal.muted, size: 14, type: 'miss'
        });
        if (ev.targetId != null) markCast(ev.targetId, 0.3); // 闪避：得意一下
      }
      return;
    }

    // v0.3 伤害类型：collision 米白 / direct 金 / dot 绿 / true 红
    var dtype = ev.damageType || '';
    var isBeeHit = !!ev.bee;
    if (isBeeHit) dtype = 'direct';
    var typeColor = dtype === 'true' ? R.pal.danger
      : dtype === 'dot' ? R.pal.good
        : dtype === 'direct' ? R.pal.gold
          : null;

    var col, size;
    if (kind === 'storm') {
      // 真伤：红
      col = R.pal.danger;
      size = clamp(13 + amount * 0.35, 14, 22);
    } else if (kind === 'thunder' || kind === 'lightning' || kind === 'bolt') {
      // 天雷：金
      col = evColor || R.pal.gold;
      size = clamp(12 + amount * 0.5, 13, 20);
    } else if (kind === 'zap' || kind === 'chain') {
      // 电击/连锁：金青
      col = evColor || R.pal.gold;
      size = clamp(11 + amount * 0.4, 12, 18);
    } else if (kind === 'poison' || kind === 'venom' || kind === 'dot') {
      // 毒伤：绿；持续伤害整体压小
      col = (kind === 'poison' || kind === 'venom') ? (evColor || R.pal.good) : R.pal.cream;
      size = clamp(10 + amount * 0.4, 12, 16);
      if (kind === 'dot' || kind === 'hazard') col = R.pal.cream;
    } else if (typeColor) {
      // 按伤害类型上色（直接伤害金 / 持续伤害绿 / 真实伤害红）
      col = typeColor;
      size = clamp(12 + amount * 0.45, 13, dtype === 'true' ? 26 : 22);
    } else if (amount >= 20) {
      // 大伤害：橙
      col = R.pal.orange;
      size = clamp(15 + amount * 0.5, 18, 32);
    } else if (kind === 'hazard') {
      // 场地持续伤害：米白偏小
      col = R.pal.cream;
      size = clamp(11 + amount * 0.35, 12, 18);
    } else {
      // 普通命中：米白
      col = R.pal.cream;
      size = clamp(13 + amount * 0.5, 14, 24);
    }

    addFloat({
      text: '-' + Math.round(amount),
      x: x + rand(-tr * 0.3, tr * 0.3), y: baseY, vy: -52,
      vx: 0, life: 0.76, maxLife: 0.76, color: col, size: size, type: 'dmg',
      big: amount >= 20, amount: amount, kind: kind,
      baseColor: (kind === 'storm') ? R.pal.danger : (kind === 'poison' || kind === 'venom' ? R.pal.good : R.pal.cream),
      mergeKey: ev.targetId || (Math.round(x / 50) + ':' + Math.round(y / 50))
    });

    if (kind === 'dot' || kind === 'hazard' || kind === 'poison' || kind === 'venom') {
      spawnSparks(x, y, 4, col, { speed: 110 });
      if (kind === 'poison' || kind === 'venom') {
        addParticle({
          kind: 'ember', x: x + rand(-tr * 0.4, tr * 0.4), y: y - rand(0, tr * 0.5),
          vx: rand(-10, 10), vy: rand(-40, -22), life: rand(0.35, 0.6), maxLife: 0.6,
          size: rand(1.6, 2.8), color: R.pal.good, grav: -14, drag: 0.8
        });
      }
    } else if (kind === 'storm') {
      spawnSparks(x, y, 5, R.pal.danger, { speed: 130, grav: -30 });
    } else if (kind === 'thunder' || kind === 'lightning' || kind === 'bolt') {
      spawnSparks(x, y, 7, R.pal.gold, { speed: 190, grav: 30 });
    } else if (isBeeHit) {
      // 蜜蜂命中：黄黑小碎片 + 一点点蜜色光
      spawnSparks(x, y, 4, '#FFD642', { speed: 150, grav: 60 });
      spawnSparks(x, y, 3, '#1B1408', { speed: 120, grav: 40 });
    } else if (kind === 'chain' || kind === 'zap') {
      spawnSparks(x, y, 6, evColor || R.pal.cyan, { speed: 160 });
    } else {
      spawnSparks(x, y, 8, col, { speed: 210 });
    }
    if (kind === 'hit' || kind === 'reflect') {
      addRing({ x: x, y: y, r0: 4, r1: 14 + Math.min(amount, 30), life: 0.2, maxLife: 0.2, color: col, width: 2, kind: 'hit' });
    }
  }

  function onHeal(ev) {
    var x = num(ev.x, WORLD / 2), y = num(ev.y, WORLD / 2);
    var amount = num(ev.amount, 0);
    if (amount < 0.5) return;
    var kind = ev.kind || ev.source || '';
    var target = findEntity(ev.entityId);
    var isVenom = kind === 'venom' || kind === 'poison' ||
      (target && (target.look === 'venom' || target.ballId === 'B0006'));
    var color = (typeof ev.color === 'string' && ev.color) ? ev.color :
      (isVenom ? '#7CFF9E' : R.pal.good);
    var tr = target ? Math.max(10, num(target.r, 30)) : 24;
    addFloat({
      text: '+' + Math.round(amount), x: x + rand(-tr * 0.2, tr * 0.2), y: y - tr * 0.78 - 6,
      vy: -44, vx: 0, life: 0.9, maxLife: 0.9, color: color, size: isVenom ? 16 : 17,
      type: 'heal', mergeKey: ev.entityId || null, amount: amount, venom: isVenom
    });
    if (isVenom) {
      // 巫医毒伤回复：绿色气泡上浮 + 从中毒目标吸过来的毒能（毒伤 → 回血）
      spawnHealSparkles(x, y - tr * 0.4, 4);
      for (var i = 0; i < 3; i++) {
        addParticle({
          kind: 'ember', x: x + rand(-tr * 0.5, tr * 0.5), y: y + rand(-tr * 0.2, tr * 0.5),
          vx: rand(-8, 8), vy: rand(-46, -26), life: rand(0.4, 0.75), maxLife: 0.75,
          size: rand(1.8, 3.2), color: color, grav: -12, drag: 0.5
        });
      }
      // 找最近的中毒目标，画一串被吸向巫医的毒能粒子（视觉上把「毒伤→回血」串起来）
      var src = null, srcD = Infinity;
      var ents = (R.snapshot && R.snapshot.entities) || [];
      for (var s2 = 0; s2 < ents.length; s2++) {
        var oe = ents[s2];
        if (!oe || !oe.alive || oe.id === ev.entityId) continue;
        if (!hasStatus(oe, 'poison')) continue;
        var ddx = num(oe.x, 0) - x, ddy = num(oe.y, 0) - y;
        var dd = ddx * ddx + ddy * ddy;
        if (dd < srcD) { srcD = dd; src = oe; }
      }
      if (src && srcD > 1) {
        var dist = Math.sqrt(srcD);
        var lifeTo = clamp(dist / 620, 0.18, 0.42);
        for (var b2 = 0; b2 < 3; b2++) {
          var bxp = num(src.x, 0) + rand(-8, 8), byp = num(src.y, 0) + rand(-8, 8);
          addParticle({
            kind: 'ember', x: bxp, y: byp,
            vx: (x - bxp) / lifeTo, vy: (y - byp) / lifeTo,
            life: lifeTo * rand(0.75, 1), maxLife: lifeTo,
            size: rand(1.6, 2.8), color: color, grav: 0, drag: 0.2
          });
        }
      }
      addRing({ x: x, y: y, r0: tr * 1.05, r1: tr * 0.55, life: 0.42, maxLife: 0.42, color: color, width: 1.8, kind: 'heal' });
    } else {
      spawnHealSparkles(x, y - tr * 0.4, 6);
    }
  }

  function onCast(ev) {
    var x = num(ev.x, WORLD / 2), y = num(ev.y, WORLD / 2);
    var color = (typeof ev.color === 'string' && ev.color) ? ev.color : R.pal.violet2;
    var name = ev.skillName || '技能';
    var target = findEntity(ev.entityId);
    var tr = target ? Math.max(10, num(target.r, 30)) : 24;

    if (ev.entityId != null) markCast(ev.entityId);

    // v0.4 奇门主动「连环引爆」：让全场地雷先闪一下（爆炸本身走 explode 事件）
    if (ev.skillId === 'cage' || ev.skillName === '连环引爆') {
      R.detonateAt = R.clock;
      if (!R.reducedMotion) spawnSparks(x, y, 12, R.pal.gold, { speed: 230, grav: -20 });
    }

    // 施法频繁的球：同一条施法标签只续命不重置，避免「技能名」闪烁堆叠
    var merged = false;
    for (var i = R.floats.length - 1; i >= 0; i--) {
      var o = R.floats[i];
      if (o.type !== 'cast' || o.mergeKey !== ev.entityId) continue;
      if (o.maxLife - o.life > 0.72) continue;
      o.text = String(name);
      o.sigil = ev.sigil || o.sigil || '';
      o.color = color;
      o.life = Math.min(1.5, o.life + 0.32);
      o.maxLife = Math.max(o.maxLife, o.life);
      merged = true;
      break;
    }
    if (!merged) {
      addFloat({
        text: String(name), x: x, y: y - tr - 26, vy: -26, vx: 0,
        life: 0.95, maxLife: 0.95, color: color, size: 15, type: 'cast',
        sigil: ev.sigil || '', mergeKey: ev.entityId
      });
    }
    addRing({ x: x, y: y, r0: 6, r1: 44, life: 0.34, maxLife: 0.34, color: color, width: 2.4, kind: 'cast' });
    spawnSparks(x, y, 9, color, { speed: 160, grav: -40 });
  }

  /* 地雷爆炸（v0.4）：普通 mine / 连锁 chain / 主动 active 三种强度 */
  function onExplode(ev) {
    var x = num(ev.x, WORLD / 2), y = num(ev.y, WORLD / 2);
    var radius = Math.max(16, num(ev.radius, num(ev.r, 30)));
    var kind = ev.kind || 'mine';
    var active = kind === 'active' || ev.active === true;
    var chain = !!ev.chain || kind === 'chain';
    var color = active ? R.pal.gold : (typeof ev.color === 'string' && ev.color ? ev.color : R.pal.orange);
    // 冲击环
    var ringLife = active ? 0.42 : 0.3;
    addRing({
      x: x, y: y, r0: radius * 0.18, r1: radius * 1.15,
      life: ringLife, maxLife: ringLife, color: color,
      width: active ? 5 : 3.2, kind: 'explode'
    });
    addRing({
      x: x, y: y, r0: 4, r1: radius * 0.62,
      life: 0.22, maxLife: 0.22, color: '#FFF7E6', width: 2, kind: 'explodeInner'
    });
    if (active) {
      addRing({
        x: x, y: y, r0: radius * 0.55, r1: radius * 1.5,
        life: 0.5, maxLife: 0.5, color: R.pal.orange2, width: 1.8, kind: 'explodeOuter'
      });
    }
    if (chain) {
      addRing({
        x: x, y: y, r0: 6, r1: radius * 0.8,
        life: 0.2, maxLife: 0.2, color: R.pal.orange2, width: 1.6, kind: 'chainPop'
      });
    }
    spawnDebris(x, y, active ? 18 : 10, color, '#FFE9A8');
    spawnSparks(x, y, active ? 16 : 8, color, { speed: active ? 330 : 250, grav: 120 });
    for (var i = 0; i < (active ? 5 : 2); i++) {
      addParticle({
        kind: 'smoke', x: x + rand(-radius * 0.3, radius * 0.3), y: y + rand(-radius * 0.25, radius * 0.25),
        vx: rand(-30, 30), vy: rand(-50, -10), life: rand(0.4, 0.9), maxLife: 0.9,
        size: rand(radius * 0.25, radius * 0.5), color: '#0A0910', grav: -20, drag: 1.4
      });
    }
    shake(active ? 7 : 3);
    if (active) R.flash = Math.max(R.flash, R.reducedMotion ? 0.04 : 0.12);
  }

  function onDeath(ev) {
    var x = num(ev.x, WORLD / 2), y = num(ev.y, WORLD / 2);
    var color = (typeof ev.color === 'string' && ev.color) ? ev.color : R.pal.orange;
    spawnDebris(x, y, 26, color, '#FFF4DC');
    for (var i = 0; i < 6; i++) {
      addParticle({
        kind: 'smoke', x: x + rand(-10, 10), y: y + rand(-10, 10),
        vx: rand(-30, 30), vy: rand(-45, 10), life: rand(0.5, 1.1), maxLife: 1.1,
        size: rand(8, 18), color: '#0A0910', grav: -20, drag: 1.4
      });
    }
    addRing({ x: x, y: y, r0: 8, r1: 110, life: 0.5, maxLife: 0.5, color: color, width: 4, kind: 'death' });
    addRing({ x: x, y: y, r0: 3, r1: 58, life: 0.7, maxLife: 0.7, color: R.pal.cream, width: 1.8, kind: 'deathInner' });
    addStamp({ x: x, y: y - 6, text: 'OUT', color: R.pal.danger, life: 1.1, maxLife: 1.1 });
    shake(9);
  }

  function onChain(ev) {
    var pts = ev.points;
    if (!pts || !pts.length) return;
    var clean = [];
    for (var i = 0; i < pts.length; i++) {
      if (!pts[i]) continue;
      clean.push({ x: num(pts[i].x, 0), y: num(pts[i].y, 0) });
    }
    if (clean.length < 2) return;
    var color = (typeof ev.color === 'string' && ev.color) ? ev.color : R.pal.cyan;
    var jags = [clean[0]];
    for (var j = 1; j < clean.length; j++) {
      var a = clean[j - 1], b = clean[j];
      var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = -dy / len, ny = dx / len;
      var segs = Math.max(3, Math.min(10, Math.round(len / 18)));
      for (var s = 1; s <= segs; s++) {
        var t = s / segs, wob = (s === segs) ? 0 : rand(-10, 10);
        jags.push({ x: a.x + dx * t + nx * wob, y: a.y + dy * t + ny * wob });
      }
    }
    addChain({ points: jags, color: color, life: 0.34, maxLife: 0.34 });
    // 竖直两点的 chain 是天雷的落雷线（engine 的约定），单独加强表现
    var verticalBolt = clean.length === 2 &&
      Math.abs(clean[1].x - clean[0].x) < 6 &&
      Math.abs(clean[1].y - clean[0].y) > 60;
    if (verticalBolt) {
      R.chains[R.chains.length - 1].kind = 'verticalBolt';
      R.chains[R.chains.length - 1].life = R.chains[R.chains.length - 1].maxLife = 0.4;
      var lx = clean[1].x, ly = clean[1].y;
      addRing({ x: lx, y: ly, r0: 6, r1: 44, life: 0.24, maxLife: 0.24, color: color, width: 2.6, kind: 'thunder' });
      R.flash = Math.max(R.flash, R.reducedMotion ? 0.05 : 0.1);
      shake(3);
    }
    for (var k = 0; k < clean.length; k++) spawnSparks(clean[k].x, clean[k].y, 3, color, { speed: 120 });
  }

  function onRing(ev) {
    var kind = ev.kind || 'ring';
    var x = num(ev.x, WORLD / 2), y = num(ev.y, WORLD / 2);
    var color = (typeof ev.color === 'string' && ev.color) ? ev.color : kindColor(kind);
    var r0 = clamp(num(ev.r, 12), 0, 800);
    var r1 = num(ev.maxR, r0 > 0 ? r0 * 3 : 200);
    if (r1 <= r0) r1 = r0 + Math.max(40, r0 * 2);
    r1 = clamp(r1, 20, 900);
    var life = kind === 'storm' ? 1.0 : clamp(0.45 + (r1 - r0) / 1600, 0.4, 1.0);
    if (kind === 'storm') {
      R.stormPulse = Math.max(R.stormPulse, 1);
      shake(5);
    }
    if (kind === 'thunder' || kind === 'lightning') {
      // 天雷命中环：短促、金色、带一点屏幕闪（叠加取最大值，避免连闪洗白画面）
      R.flash = Math.max(R.flash, R.reducedMotion ? 0.04 : 0.09);
      shake(3);
    }
    addRing({ x: x, y: y, r0: Math.max(2, r0), r1: r1, life: life, maxLife: life, color: color, width: kind === 'death' ? 4 : 3, kind: kind });
  }

  function kindColor(kind) {
    switch (kind) {
      case 'blizzard': return R.pal.cyan;
      case 'bulwark': return R.pal.gold;
      case 'singularity': return R.pal.violet;
      case 'death': return R.pal.danger;
      case 'storm': return R.pal.danger;
      case 'spawn': return R.pal.cream;
      case 'thunder': return R.pal.gold;
      case 'thunderInner': return '#FFF7E6';
      case 'heal': return R.pal.good;
      default: return R.pal.cream;
    }
  }

  function onBounce(ev) {
    var x = num(ev.x, 0), y = num(ev.y, 0);
    var id = ev.entityId || 'wall';
    var t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    if (R.bounceAt[id] && t - R.bounceAt[id] < 0.045) return;
    R.bounceAt[id] = t;
    var color = (typeof ev.color === 'string' && ev.color) ? ev.color : R.pal.cream;
    // 火花朝场内飞
    var vx = x < WORLD / 2 ? rand(20, 120) : rand(-120, -20);
    var vy = y < WORLD / 2 ? rand(20, 120) : rand(-120, -20);
    if (Math.abs(x - WORLD / 2) > Math.abs(y - WORLD / 2)) vx = x < WORLD / 2 ? Math.abs(vx) : -Math.abs(vx);
    else vy = y < WORLD / 2 ? Math.abs(vy) : -Math.abs(vy);
    spawnSparks(x, y, 4, color, { speed: 150, vx: vx, vy: vy, grav: 30 });
    addRing({ x: x, y: y, r0: 3, r1: 13, life: 0.18, maxLife: 0.18, color: color, width: 1.6, kind: 'bounce' });
  }

  function onWarp(ev) {
    var x = num(ev.x, 0), y = num(ev.y, 0);
    var color = (typeof ev.color === 'string' && ev.color) ? ev.color : R.pal.violet2;
    var vertical = (x < 80 || x > WORLD - 80) && !(y < 80 || y > WORLD - 80);
    addWarp({ x: x, y: y, vertical: vertical, color: color, life: 0.42, maxLife: 0.42 });
    spawnSparks(x, y, 7, color, { speed: 170, grav: -20 });
  }

  function onSpawn(ev) {
    var x = num(ev.x, WORLD / 2), y = num(ev.y, WORLD / 2);
    var color = (typeof ev.color === 'string' && ev.color) ? ev.color : R.pal.cream;
    addRing({ x: x, y: y, r0: 2, r1: 66, life: 0.55, maxLife: 0.55, color: color, width: 2.2, kind: 'spawn' });
    spawnSparks(x, y, 10, color, { speed: 150 });
  }

  function onOver(ev) {
    R.overInfo = {
      winnerId: ev.winnerId || null,
      draw: !!ev.draw,
      time: num(ev.time, 0)
    };
    R.stormPulse = 0;
  }

  /* ============================================================
   * 每帧更新特效
   * ============================================================ */
  function updateEffects(dt, storm, snapshot) {
    var i, p;
    // 震屏衰减
    if (R.shake > 0.05) R.shake *= Math.exp(-dt * 7);
    else R.shake = 0;
    if (R.stormPulse > 0) R.stormPulse = Math.max(0, R.stormPulse - dt * 1.3);

    // 粒子
    for (i = R.particles.length - 1; i >= 0; i--) {
      p = R.particles[i];
      p.life -= dt;
      if (p.life <= 0) { R.particles.splice(i, 1); continue; }
      var drag = p.drag === undefined ? 1 : p.drag;
      var damp = Math.max(0, 1 - drag * dt);
      p.vx *= damp;
      p.vy = p.vy * damp + (p.grav || 0) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 'smoke') { p.size += dt * 22; }
    }

    // 飘字
    for (i = R.floats.length - 1; i >= 0; i--) {
      var f = R.floats[i];
      f.life -= dt;
      if (f.life <= 0) { R.floats.splice(i, 1); continue; }
      f.y += f.vy * dt;
      f.vy *= Math.max(0, 1 - dt * 1.9);
      if (f.vx) {
        f.x += f.vx * dt;
        f.vx *= Math.max(0, 1 - dt * 2.4);
      }
    }

    // 扩散环
    for (i = R.rings.length - 1; i >= 0; i--) {
      var g = R.rings[i];
      g.life -= dt;
      if (g.life <= 0) R.rings.splice(i, 1);
    }
    // 闪电
    for (i = R.chains.length - 1; i >= 0; i--) {
      var c = R.chains[i];
      c.life -= dt;
      if (c.life <= 0) R.chains.splice(i, 1);
    }
    // 印章
    for (i = R.stamps.length - 1; i >= 0; i--) {
      var s = R.stamps[i];
      s.life -= dt;
      if (s.life <= 0) R.stamps.splice(i, 1);
    }
    // 穿墙闪
    for (i = R.warps.length - 1; i >= 0; i--) {
      var w = R.warps[i];
      w.life -= dt;
      if (w.life <= 0) R.warps.splice(i, 1);
    }
    // 落雷
    for (i = R.bolts.length - 1; i >= 0; i--) {
      var bo = R.bolts[i];
      bo.life -= dt;
      if (bo.life <= 0) R.bolts.splice(i, 1);
    }
    // 预警圈：到点自动落雷（事件式兜底；快照 strikes 由 drawStrikes 直接画）
    for (i = R.warns.length - 1; i >= 0; i--) {
      var wn = R.warns[i];
      wn.life -= dt;
      if (wn.life <= 0) {
        R.warns.splice(i, 1);
        if (wn.auto) spawnLightning(wn.x, wn.y, wn.r, wn.color);
      }
    }
    // 屏幕闪衰减
    if (R.flash > 0.002) R.flash *= Math.exp(-dt * 7.5);
    else R.flash = 0;

    // 状态氛围粒子（灼烧火星 / 中毒气泡 / 巫医回复），限频避免刷爆粒子池
    if (dt > 0 && !R.reducedMotion) {
      var entsAmb = (snapshot && snapshot.entities) || [];
      for (i = 0; i < entsAmb.length; i++) {
        var ea = entsAmb[i];
        if (!ea || !ea.alive) continue;
        var fsa = ensureFace(ea.id || ea.ballId || 'ball');
        var hpa = clamp(num(ea.hpPct, num(ea.hp, 1) / Math.max(1, num(ea.maxHp, 1))), 0, 1);
        var ra = Math.max(12, num(ea.r, 30));
        var nowBurn = hasStatus(ea, 'burn');
        if (nowBurn && !fsa.wasBurn) {
          // 刚被施加余烬（碰撞或走进火痕）：名字短提示 + 一撮火星
          if (!R.reducedMotion) {
            addFloat({
              text: '余烬', x: num(ea.x, 0), y: num(ea.y, 0) - ra - 10,
              vy: -16, vx: 0, life: 0.6, maxLife: 0.6,
              color: R.pal.orange2, size: 12, type: 'debuff'
            });
            spawnSparks(num(ea.x, 0), num(ea.y, 0), 3, R.pal.orange2, { speed: 80, grav: -20 });
          }
        }
        fsa.wasBurn = nowBurn;
        if (nowBurn) {
          fsa.burnAcc += dt;
          if (fsa.burnAcc > 0.16) {
            fsa.burnAcc = 0;
            addParticle({
              kind: 'ember', x: num(ea.x, 0) + rand(-ra * 0.7, ra * 0.7), y: num(ea.y, 0) - ra * 0.2,
              vx: rand(-8, 8), vy: rand(-64, -30), life: rand(0.25, 0.5), maxLife: 0.5,
              size: rand(1.4, 2.6), color: Math.random() < 0.5 ? R.pal.orange : R.pal.orange2,
              grav: -8, drag: 0.9
            });
          }
        }
        if (hasStatus(ea, 'poison')) {
          fsa.poisonAcc += dt;
          if (fsa.poisonAcc > 0.2) {
            fsa.poisonAcc = 0;
            addParticle({
              kind: 'ember', x: num(ea.x, 0) + rand(-ra * 0.6, ra * 0.6), y: num(ea.y, 0) + rand(-ra * 0.2, ra * 0.4),
              vx: rand(-6, 6), vy: rand(-40, -22), life: rand(0.3, 0.55), maxLife: 0.55,
              size: rand(1.6, 2.6), color: R.pal.good, grav: -10, drag: 0.7
            });
          }
        }
      }
      // 低血量球随呼吸冒一两点暗色尘埃（省粒子时也可关）
      if (R.particles.length < MAX_PARTICLES * 0.8) {
        for (i = 0; i < entsAmb.length; i++) {
          var ec = entsAmb[i];
          if (!ec || !ec.alive) continue;
          var hpc = clamp(num(ec.hpPct, 1), 0, 1);
          if (hpc > 0.24) continue;
          var fsc = ensureFace(ec.id || ec.ballId || 'ball');
          fsc.healAcc += dt;
          if (fsc.healAcc > 0.45) {
            fsc.healAcc = 0;
            var rc = Math.max(10, num(ec.r, 30));
            addParticle({
              kind: 'ember', x: num(ec.x, 0) + rand(-rc, rc), y: num(ec.y, 0) + rand(-rc * 0.4, rc * 0.4),
              vx: rand(-12, 12), vy: rand(-26, -10), life: rand(0.3, 0.6), maxLife: 0.6,
              size: rand(1.2, 2.2), color: mix(ec.color || R.pal.orange, '#0A0910', 0.35), grav: 4, drag: 1.2
            });
          }
        }
      }
    }
    // 表情状态清理（死掉/离场的实体）
    if (dt > 0) {
      R.faceSeen += dt;
      if (R.faceSeen > 2.5) {
        R.faceSeen = 0;
        var alive = {};
        var entsF = (snapshot && snapshot.entities) || [];
        for (i = 0; i < entsF.length; i++) if (entsF[i] && entsF[i].alive) alive[entsF[i].id] = 1;
        for (var fk in R.faceSt) if (!alive[fk]) delete R.faceSt[fk];
      }
    }

    // 拖影
    if (!R.reducedMotion && dt > 0) {
      var ents = (snapshot && snapshot.entities) || [];
      var seen = {};
      for (i = 0; i < ents.length; i++) {
        var e = ents[i];
        if (!e || !e.alive) continue;
        seen[e.id] = 1;
        var tr = R.trails[e.id];
        if (!tr) { tr = R.trails[e.id] = { list: [], acc: 0 }; }
        tr.acc += dt;
        if (tr.acc >= 0.03 && num(e.speed, 0) > 40) {
          tr.acc = 0;
          tr.list.push({
            x: num(e.x, 0), y: num(e.y, 0), r: num(e.r, 30),
            color: e.color || R.pal.cream, age: 0
          });
          if (tr.list.length > 4) tr.list.shift();
        }
        for (var j = 0; j < tr.list.length; j++) tr.list[j].age += dt;
        while (tr.list.length && tr.list[0].age > 0.2) tr.list.shift();
      }
      R.trailSeen += dt;
      if (R.trailSeen > 0.9) {
        R.trailSeen = 0;
        for (var key in R.trails) if (!seen[key]) delete R.trails[key];
      }
    }

    // 决胜时刻：红色余烬从上方落下
    if (dt > 0 && storm > 0.04 && !R.reducedMotion) {
      R.emberAcc += dt * (10 + 26 * storm);
      while (R.emberAcc >= 1) {
        R.emberAcc -= 1;
        addParticle({
          kind: 'ember', x: rand(0, WORLD), y: rand(-30, 90),
          vx: rand(-20, 20), vy: rand(20, 70), life: rand(0.7, 1.6), maxLife: 1.6,
          size: rand(1.5, 3.5), color: Math.random() < 0.4 ? R.pal.orange : R.pal.danger,
          grav: 10, drag: 0.2
        });
      }
    }
  }

  /* ============================================================
   * 主渲染
   * ============================================================ */
  function render(snapshot, view) {
    if (!R.inited || !R.ctx) return;
    try {
      renderInner(snapshot, view);
    } catch (e) {
      warnOnce('render', e);
    }
  }

  function renderInner(snapshot, view) {
    view = view || {};
    R.lastView = view;
    var now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    var rawDt = num(view.dt, R.lastTime ? now - R.lastTime : 1 / 60);
    rawDt = clamp(rawDt, 0, 0.05);
    R.lastTime = now;
    if (snapshot) R.snapshot = snapshot;
    snapshot = snapshot || R.snapshot || { entities: [], hazards: [] };
    R.lastView = view;

    /* ---- 动态世界：跟随当前地图/决斗缩尺 ---- */
    var arenaInfo = snapshot.arena || {};
    WORLD = num(arenaInfo.w, 1000);
    if (!(WORLD > 0)) WORLD = 1000;
    var rawShape = arenaInfo.shape;
    SHAPE = rawShape === 'circle' ? 'circle' : (rawShape === 'triangle' ? 'triangle' : 'square');
    ARENA_RADIUS = num(arenaInfo.radius, WORLD * 0.5) || WORLD * 0.5;
    TRI = SHAPE === 'triangle' ? buildTriangle(arenaInfo) : null;
    MAP_ID = arenaInfo.mapId || SHAPE;
    MAP_THEME = themeForMap(MAP_ID, SHAPE);
    if (R.view && R.view.size) R.view.scale = R.view.size / WORLD;

    var paused = !!view.paused;
    var dt = paused ? 0 : rawDt;
    R.clock += dt;
    R.frame++;

    var storm = clamp(num(view.stormLevel, snapshot.stormLevel || 0), 0, 1);
    if (snapshot.suddenDeath) storm = Math.max(storm, 0.35);
    // 速胜时刻（v0.3：60s 开始）：首次进入时给一圈红环 + 震屏，标出节奏变化
    if (snapshot.suddenDeath) {
      if (!R.suddenSeen) {
        R.suddenSeen = true;
        R.stormPulse = 1;
        if (!R.reducedMotion) {
          addRing({
            x: WORLD / 2, y: WORLD / 2, r0: WORLD * 0.18, r1: WORLD * 0.72,
            life: 0.85, maxLife: 0.85, color: R.pal.danger, width: 4, kind: 'storm'
          });
          shake(6);
        }
      }
    } else {
      R.suddenSeen = false;
    }

    // 结算冻结帧：清理一次性炫技残留，保证终场画面干净（turbo 快进时尤其重要）
    if (snapshot.status === 'over' && dt === 0) {
      if (!R.overCleaned) {
        R.overCleaned = true;
        R.shake = 0;
        if (R.particles.length > 90) R.particles.length = 90;
        if (R.rings.length > 4) R.rings.splice(0, R.rings.length - 4);
        if (R.chains.length > 2) R.chains.splice(0, R.chains.length - 2);
        if (R.stamps.length > 2) R.stamps.splice(0, R.stamps.length - 2);
        R.bolts.length = 0;
        R.warns.length = 0;
        R.floats.length = 0;
      }
    } else if (snapshot.status !== 'over') {
      R.overCleaned = false;
    }

    updateEffects(dt, storm, snapshot);

    // 尺寸兜底检查（每 20 帧读一次布局）
    if (R.frame % 20 === 0 || R.view.size < 40) {
      var c = R.canvas;
      if (c && (Math.abs(c.clientWidth - R.view.cssW) > 1 || Math.abs(c.clientHeight - R.view.cssH) > 1)) resize();
    }

    var ctx = R.ctx;
    var v = R.view;
    var dpr = v.dpr, S = v.size, ox = v.offX, oy = v.offY;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // 画布留白（letterbox）底色
    ctx.fillStyle = '#06050B';
    ctx.fillRect(0, 0, v.cssW, v.cssH);

    // 震屏偏移
    var shx = 0, shy = 0;
    if (R.shake > 0.05) {
      var amp = R.shake;
      shx = rand(-amp, amp);
      shy = rand(-amp, amp);
    }

    ctx.save();
    ctx.translate(ox + shx, oy + shy);
    ctx.save();
    ctx.scale(S / WORLD, S / WORLD);

    // --- 世界空间（世界逻辑单位）---
    drawFloor(ctx, snapshot, storm);
    drawHazards(ctx, snapshot, dt);
    drawObstacles(ctx, snapshot, dt);
    drawStrikes(ctx, snapshot);
    drawTrails(ctx);
    drawBalls(ctx, snapshot, dt);
    drawBees(ctx, snapshot);
    drawParticles(ctx);
    drawRings(ctx);
    drawChains(ctx);
    drawBolts(ctx);
    drawWarps(ctx);
    drawFloats(ctx);
    drawStamps(ctx);

    ctx.restore(); // 回到竞技场屏幕坐标（0..S）

    drawBoundary(ctx, snapshot, storm);
    ctx.restore(); // 震屏

    // --- 屏幕空间覆盖层 ---
    drawArenaOverlay(ctx, snapshot, storm);
    if (R.debug) drawDebug(ctx, snapshot, view);
  }

  /* ============================================================
   * 地面烘焙（网格 / 徽记 / 颗粒 / 水印），只生成一次（字体就绪后重烘）
   * ============================================================ */
  function bakeFloor() {
    if (!root.document || !root.document.createElement) return;
    try {
      var sc = 1.2, size = Math.round(LOGIC * sc);
      var cv = root.document.createElement('canvas');
      cv.width = size; cv.height = size;
      var g = cv.getContext('2d');
      if (!g) return;
      g.save();
      g.scale(sc, sc);

      // 底色：暖调深紫黑
      var base = g.createRadialGradient(500, 430, 40, 500, 500, 780);
      base.addColorStop(0, '#151021');
      base.addColorStop(0.5, '#0D0A17');
      base.addColorStop(1, '#07050D');
      g.fillStyle = base;
      g.fillRect(0, 0, LOGIC, LOGIC);

      // 中央钠灯暖光
      var warm = g.createRadialGradient(500, 545, 20, 500, 500, 560);
      warm.addColorStop(0, 'rgba(255,107,26,0.09)');
      warm.addColorStop(0.6, 'rgba(255,107,26,0.025)');
      warm.addColorStop(1, 'rgba(255,107,26,0)');
      g.fillStyle = warm;
      g.fillRect(0, 0, LOGIC, LOGIC);

      // 两角黑灯紫
      var vt = g.createRadialGradient(80, 60, 10, 80, 60, 420);
      vt.addColorStop(0, 'rgba(176,96,255,0.10)');
      vt.addColorStop(1, 'rgba(176,96,255,0)');
      g.fillStyle = vt; g.fillRect(0, 0, LOGIC, LOGIC);
      var vb = g.createRadialGradient(930, 950, 10, 930, 950, 420);
      vb.addColorStop(0, 'rgba(176,96,255,0.08)');
      vb.addColorStop(1, 'rgba(176,96,255,0)');
      g.fillStyle = vb; g.fillRect(0, 0, LOGIC, LOGIC);

      // 40px 网格
      var i, gx;
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(255,244,220,0.038)';
      g.beginPath();
      for (gx = 40; gx < LOGIC; gx += 40) {
        g.moveTo(gx + 0.5, 0); g.lineTo(gx + 0.5, LOGIC);
        g.moveTo(0, gx + 0.5); g.lineTo(LOGIC, gx + 0.5);
      }
      g.stroke();
      // 200px 主网格
      g.strokeStyle = 'rgba(255,244,220,0.068)';
      g.beginPath();
      for (gx = 200; gx < LOGIC; gx += 200) {
        g.moveTo(gx + 0.5, 0); g.lineTo(gx + 0.5, LOGIC);
        g.moveTo(0, gx + 0.5); g.lineTo(LOGIC, gx + 0.5);
      }
      g.stroke();

      // 中央徽记（十字 + 圆环）
      g.save();
      g.translate(500, 500);
      g.strokeStyle = 'rgba(255,244,220,0.07)';
      g.lineWidth = 2;
      g.beginPath(); g.arc(0, 0, 168, 0, TAU); g.stroke();
      g.strokeStyle = 'rgba(255,244,220,0.045)';
      g.beginPath(); g.arc(0, 0, 118, 0, TAU); g.stroke();
      g.setLineDash([10, 16]);
      g.strokeStyle = 'rgba(255,107,26,0.12)';
      g.beginPath(); g.arc(0, 0, 226, 0, TAU); g.stroke();
      g.setLineDash([]);
      g.strokeStyle = 'rgba(255,244,220,0.055)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(-252, 0); g.lineTo(-92, 0);
      g.moveTo(92, 0); g.lineTo(252, 0);
      g.moveTo(0, -252); g.lineTo(0, -92);
      g.moveTo(0, 92); g.lineTo(0, 252);
      g.stroke();
      // 四向刻度
      for (i = 0; i < 8; i++) {
        var a = i / 8 * TAU;
        g.beginPath();
        g.moveTo(Math.cos(a) * 168, Math.sin(a) * 168);
        g.lineTo(Math.cos(a) * 152, Math.sin(a) * 152);
        g.stroke();
      }
      g.fillStyle = 'rgba(255,107,26,0.10)';
      g.beginPath(); g.arc(0, 0, 6, 0, TAU); g.fill();
      g.restore();

      // 水印
      if (R.fontsReady) {
        g.save();
        g.font = '96px ' + FONT_EN;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = 'rgba(255,244,220,0.018)';
        g.fillText('BALL PIT', 500, 628);
        g.restore();
      }

      // 地面颗粒 / 污渍
      var sseed = 1337;
      for (i = 0; i < 170; i++) {
        var px = rnd(sseed, i * 3) * LOGIC;
        var py = rnd(sseed, i * 3 + 1) * LOGIC;
        var pr = 0.8 + rnd(sseed, i * 3 + 2) * 2.4;
        var pick = i % 4;
        g.fillStyle = pick === 0 ? 'rgba(255,244,220,0.05)'
          : pick === 1 ? 'rgba(176,96,255,0.05)'
          : pick === 2 ? 'rgba(255,107,26,0.05)'
          : 'rgba(84,230,255,0.035)';
        g.fillRect(px, py, pr, pr);
      }
      for (i = 0; i < 16; i++) {
        var ex = rnd(sseed, 500 + i * 3) * LOGIC;
        var ey = rnd(sseed, 501 + i * 3) * LOGIC;
        var ew = 18 + rnd(sseed, 502 + i * 3) * 80;
        g.fillStyle = 'rgba(0,0,0,' + (0.06 + rnd(sseed, i) * 0.06).toFixed(3) + ')';
        g.beginPath();
        g.ellipse(ex, ey, ew, ew * 0.5, rnd(sseed, i + 40) * TAU, 0, TAU);
        g.fill();
      }

      // 四角斜向刻线
      var corners = [[0, 0, 1], [LOGIC, 0, -1], [0, LOGIC, 1], [LOGIC, LOGIC, -1]];
      for (i = 0; i < corners.length; i++) {
        var cx0 = corners[i][0], cy0 = corners[i][1], sx = corners[i][2];
        g.save();
        g.translate(cx0, cy0);
        g.strokeStyle = 'rgba(255,244,220,0.035)';
        g.lineWidth = 2;
        for (var k = 0; k < 4; k++) {
          g.beginPath();
          g.moveTo(sx * (40 + k * 26), 0);
          g.lineTo(0, sx * (40 + k * 26));
          g.stroke();
        }
        g.restore();
      }

      g.restore();
      R.floorCanvas = cv;
    } catch (e) {
      warnOnce('bake-floor', e);
      R.floorCanvas = null;
    }
  }

  function drawFloor(ctx, snapshot, storm) {
    var cxW = WORLD * 0.5;
    var shape = SHAPE;
    var clipped = shape === 'circle' || (shape === 'triangle' && TRI);
    if (clipped) {
      ctx.save();
      if (shape === 'circle') {
        ctx.beginPath();
        ctx.arc(cxW, cxW, ARENA_RADIUS, 0, TAU);
        ctx.clip();
      } else {
        triPathWorld(ctx, 0);
        ctx.clip();
      }
    }
    if (R.floorCanvas) ctx.drawImage(R.floorCanvas, 0, 0, WORLD, WORLD);
    else {
      ctx.fillStyle = '#0B0814';
      ctx.fillRect(0, 0, WORLD, WORLD);
    }
    // 决胜时刻：场地边缘泛红
    if (storm > 0.01) {
      var pulse = 0.65 + 0.35 * Math.sin(R.clock * 5.5);
      var g = ctx.createRadialGradient(cxW, cxW, WORLD * 0.24, cxW, cxW, WORLD * 0.73);
      g.addColorStop(0, 'rgba(255,79,109,0)');
      g.addColorStop(0.72, 'rgba(255,79,109,' + (0.06 * storm * pulse).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(255,79,109,' + (0.20 * storm * pulse).toFixed(3) + ')');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, WORLD, WORLD);
    }
    if (shape === 'circle') {
      // 圆环地图：边缘冷光 + 同心刻度环
      var eg = ctx.createRadialGradient(cxW, cxW, ARENA_RADIUS * 0.68, cxW, cxW, ARENA_RADIUS);
      eg.addColorStop(0, 'rgba(84,230,255,0)');
      eg.addColorStop(0.82, 'rgba(84,230,255,0.045)');
      eg.addColorStop(1, 'rgba(84,230,255,0.14)');
      ctx.fillStyle = eg;
      ctx.fillRect(0, 0, WORLD, WORLD);
      ctx.strokeStyle = rgba(MAP_THEME.accent, 0.18);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cxW, cxW, ARENA_RADIUS * 0.94, 0, TAU); ctx.stroke();
      ctx.setLineDash([10, 16]);
      ctx.strokeStyle = rgba(MAP_THEME.accent2, 0.12);
      ctx.beginPath(); ctx.arc(cxW, cxW, ARENA_RADIUS * 0.82, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    } else if (shape === 'triangle' && TRI) {
      drawTriangleFloorDeco(ctx, TRI, storm);
    }
    if (clipped) ctx.restore();
  }

  /* 三角地面装饰：内缩三条边线 / 角部楔形光 / 重心徽记 */
  function drawTriangleFloorDeco(ctx, tri, storm) {
    var i;
    // 边缘暖光：三层内缩描边
    var insets = [10, 22, 40];
    var alphas = [0.075, 0.05, 0.028];
    for (i = 0; i < insets.length; i++) {
      triPathWorld(ctx, insets[i]);
      ctx.strokeStyle = rgba(MAP_THEME.accent, alphas[i] + (storm || 0) * 0.02);
      ctx.lineWidth = i === 0 ? 14 : (i === 1 ? 4 : 1.6);
      ctx.stroke();
    }
    // 虚线内圈（安全区示意）
    triPathWorld(ctx, tri.inradius * 0.42);
    ctx.setLineDash([12, 18]);
    ctx.strokeStyle = rgba(MAP_THEME.accent2, 0.1);
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.setLineDash([]);
    // 三个角部楔形
    for (i = 0; i < 3; i++) {
      var v = tri.v[i];
      var a = tri.v[(i + 1) % 3], b = tri.v[(i + 2) % 3];
      var da = Math.atan2(a.y - v.y, a.x - v.x);
      var db = Math.atan2(b.y - v.y, b.x - v.x);
      ctx.beginPath();
      ctx.moveTo(v.x + Math.cos(da) * tri.radius * 0.02, v.y + Math.sin(da) * tri.radius * 0.02);
      ctx.arc(v.x, v.y, tri.radius * 0.3, Math.min(da, db), Math.max(da, db));
      ctx.closePath();
      ctx.fillStyle = rgba(MAP_THEME.accent, 0.022);
      ctx.fill();
    }
    // 重心徽记：同心环 + 三向刻度
    var c = tri, R0 = tri.inradius * 0.34;
    ctx.save();
    ctx.translate(c.cx, c.cy);
    ctx.strokeStyle = rgba(R.pal.cream, 0.07);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, R0, 0, TAU); ctx.stroke();
    ctx.strokeStyle = rgba(R.pal.cream, 0.045);
    ctx.beginPath(); ctx.arc(0, 0, R0 * 0.62, 0, TAU); ctx.stroke();
    ctx.setLineDash([8, 12]);
    ctx.strokeStyle = rgba(MAP_THEME.accent2, 0.1);
    ctx.beginPath(); ctx.arc(0, 0, R0 * 1.32, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    for (i = 0; i < 3; i++) {
      var aa = -Math.PI / 2 + i * (TAU / 3);
      ctx.beginPath();
      ctx.moveTo(Math.cos(aa) * R0 * 0.2, Math.sin(aa) * R0 * 0.2);
      ctx.lineTo(Math.cos(aa) * R0 * 0.9, Math.sin(aa) * R0 * 0.9);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(Math.cos(aa) * R0 * 1.05, Math.sin(aa) * R0 * 1.05);
      ctx.lineTo(Math.cos(aa) * R0 * 1.22, Math.sin(aa) * R0 * 1.22);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(MAP_THEME.accent, 0.16);
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, TAU); ctx.fill();
    ctx.restore();
  }

  /* ============================================================
   * 危险物
   * ============================================================ */
  function drawHazards(ctx, snapshot, dt) {
    var arr = (snapshot && snapshot.hazards) || [];
    if (!arr.length) {
      if (R.minePos && Object.keys(R.minePos).length) { R.minePos = {}; R.mineTrail = {}; }
      return;
    }
    var mineSeen = null;
    // 两遍：先画地面类（火痕/毒雾/引力井），再画地雷装置，避免装置被地面特效压暗
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < arr.length; i++) {
        var h = arr[i];
        if (!h) continue;
        var isMine = h.kind === 'mine';
        if (isMine) {
          if (!mineSeen) mineSeen = {};
          var mid = h.id != null ? h.id : ('m' + i);
          mineSeen[mid] = 1;
          trackMineMotion(h, mid);
        }
        if ((pass === 0) === isMine) continue;   // pass0 只画非地雷，pass1 只画地雷
        try { drawHazard(ctx, h); } catch (e) { warnOnce('hazard', e); }
      }
    }
    if (mineSeen) {
      for (var k in R.mineTrail) {
        if (!mineSeen[k]) { delete R.mineTrail[k]; delete R.minePos[k]; }
      }
    }
  }

  /* 地雷被引力井拉动时没有 vx/vy：用上一帧位置差做短拖尾 */
  function trackMineMotion(h, id) {
    var nx = num(h.x, 0), ny = num(h.y, 0);
    var prev = R.minePos[id];
    R.minePos[id] = { x: nx, y: ny };
    if (!prev) return;
    var dx = nx - prev.x, dy = ny - prev.y;
    if (dx * dx + dy * dy > 0.25) {
      var list = R.mineTrail[id] || (R.mineTrail[id] = []);
      list.push({ x: prev.x, y: prev.y, t: R.clock });
      if (list.length > 6) list.shift();
    }
    var l = R.mineTrail[id];
    if (l) {
      for (var i = l.length - 1; i >= 0; i--) {
        if (R.clock - l[i].t > 0.3) l.splice(i, 1);
      }
    }
  }

  /* ============================================================
   * 随机障碍（v0.4 机制 randomObstacles）
   * snapshot.obstacles = [{id, shape:'circle'|'triangle'|'square', kind:'wall'|'superdomain',
   *                        x, y, r, radius, angle, vertices:[{x,y}...], life, maxLife, color}]
   *  - 普通墙：钢灰板 + 橙色角标，虚化/穿墙可穿
   *  - 超域：紫红高亮 + 旋转符文 + 扫描纹，任何单位不可穿
   *  - 场地边界实体：画在球之前（不遮球）；生成/消失有环与碎片
   * ============================================================ */
  function obstacleKindOf(o) {
    if (o && (o.kind === 'superdomain' || o.super === true)) return 'superdomain';
    return 'wall';
  }
  function polyPathLocal(ctx, pts) {
    if (!pts || !pts.length) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }
  function insetPoly(pts, inset) {
    if (!(inset > 0)) return pts;
    var out = [], i;
    for (i = 0; i < pts.length; i++) {
      var dx = -pts[i].x, dy = -pts[i].y;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      var k = clamp(inset / d, 0, 0.9);
      out.push({ x: pts[i].x + dx * k, y: pts[i].y + dy * k });
    }
    return out;
  }
  function drawObstacles(ctx, snapshot, dt) {
    var arr = (snapshot && snapshot.obstacles) || null;
    var prev = R.obsPrev || (R.obsPrev = {});
    var seen = {};
    var i, id;
    if (arr && arr.length) {
      var n = Math.min(arr.length, MAX_OBSTACLES);
      for (i = 0; i < n; i++) {
        var o = arr[i];
        if (!o) continue;
        id = o.id != null ? o.id : ('o' + i);
        seen[id] = 1;
        if (!prev[id]) obstacleSpawnFx(o);
        prev[id] = {
          x: num(o.x, 0), y: num(o.y, 0),
          r: num(o.r, num(o.radius, 26)), shape: o.shape, kind: obstacleKindOf(o)
        };
        try { drawObstacle(ctx, o, i); } catch (e) { warnOnce('obstacle', e); }
      }
    }
    for (id in prev) {
      if (seen[id]) continue;
      var old = prev[id];
      delete prev[id];
      obstacleDespawnFx(old);
    }
  }
  function obstacleSpawnFx(o) {
    if (R.reducedMotion) return;
    var x = num(o.x, 0), y = num(o.y, 0);
    var rr = Math.max(8, num(o.r, num(o.radius, 26)));
    var col = obstacleKindOf(o) === 'superdomain' ? '#FF5CD0' : '#8FA3B8';
    addRing({ x: x, y: y, r0: rr * 0.3, r1: rr * 1.7, life: 0.32, maxLife: 0.32, color: col, width: 2.2, kind: 'obstacleSpawn' });
    spawnSparks(x, y, 6, col, { speed: 130, grav: 0 });
  }
  function obstacleDespawnFx(p) {
    if (!p || R.reducedMotion) return;
    var col = p.kind === 'superdomain' ? '#FF5CD0' : '#8FA3B8';
    addRing({ x: p.x, y: p.y, r0: p.r * 1.1, r1: p.r * 0.35, life: 0.24, maxLife: 0.24, color: col, width: 2, kind: 'obstacleDespawn' });
    spawnDebris(p.x, p.y, 5, col, '#FFF4DC');
  }
  function drawObstacle(ctx, o, idx) {
    var shape = (o.shape === 'square' || o.shape === 'triangle') ? o.shape : 'circle';
    var kind = obstacleKindOf(o);
    var superD = kind === 'superdomain';
    var x = num(o.x, 0), y = num(o.y, 0);
    var rr = Math.max(6, num(o.r, num(o.radius, 26)));
    var angle = num(o.angle, 0);
    var life = num(o.life, 1);
    var maxLife = Math.max(0.05, num(o.maxLife, 3));
    var p = clamp(1 - life / maxLife, 0, 1);
    var fadeIn = clamp(p / 0.16, 0, 1);
    var fadeOut = clamp(life / 0.22, 0, 1);
    var alpha = Math.min(fadeIn, fadeOut);
    if (alpha <= 0.02) return;
    var grow = 0.82 + 0.18 * easeOutCubic(clamp(p / 0.22, 0, 1));
    var t = R.clock;
    var accent = superD ? '#FF5CD0' : '#8FA3B8';
    var accent2 = superD ? '#D9A8FF' : '#FFF4DC';

    // 多边形顶点：优先引擎给的世界坐标（转成相对中心），否则按 r/angle 生成
    var pts = null, hasVerts = false;
    if (shape !== 'circle') {
      var cnt = shape === 'square' ? 4 : 3;
      var vs = o.vertices;
      if (vs && vs.length >= cnt) {
        hasVerts = true;
        pts = [];
        for (var vi = 0; vi < cnt; vi++) {
          var vp = vs[vi] || {};
          pts.push({ x: num(vp.x, 0) - x, y: num(vp.y, 0) - y });
        }
      } else {
        pts = [];
        var start = shape === 'square' ? Math.PI / 4 : -Math.PI / 2;
        for (var pi = 0; pi < cnt; pi++) {
          var pa = start + pi * (TAU / cnt);
          pts.push({ x: Math.cos(pa) * rr, y: Math.sin(pa) * rr });
        }
      }
    }
    function pathAt(inset) {
      if (shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(2, rr - inset), 0, TAU);
      } else {
        polyPathLocal(ctx, insetPoly(pts, inset));
      }
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha *= alpha;
    // 地面投影
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, rr * 0.55, rr * 1.02, rr * 0.34, 0, 0, TAU);
    ctx.fill();

    ctx.scale(grow, grow);
    if (shape !== 'circle' && !hasVerts) ctx.rotate(angle);

    // --- 主体填充（普通墙=实心钢灰板；超域=半透紫红光） ---
    pathAt(0);
    if (superD) {
      var sg = ctx.createRadialGradient(0, 0, rr * 0.08, 0, 0, rr);
      sg.addColorStop(0, 'rgba(226,130,255,0.62)');
      sg.addColorStop(0.5, 'rgba(160,64,224,0.56)');
      sg.addColorStop(0.85, 'rgba(96,32,158,0.5)');
      sg.addColorStop(1, 'rgba(52,14,92,0.46)');
      ctx.fillStyle = sg;
    } else {
      var wg = ctx.createRadialGradient(-rr * 0.28, -rr * 0.34, rr * 0.06, 0, 0, rr);
      wg.addColorStop(0, 'rgba(150,166,184,0.95)');
      wg.addColorStop(0.5, 'rgba(96,110,126,0.95)');
      wg.addColorStop(0.86, 'rgba(52,62,74,0.96)');
      wg.addColorStop(1, 'rgba(24,30,38,0.97)');
      ctx.fillStyle = wg;
    }
    ctx.fill();

    // 普通墙：顶部斜向高光 + 底部暗边，读出厚度
    if (!superD) {
      ctx.save();
      pathAt(0);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,244,220,0.16)';
      ctx.beginPath();
      ctx.moveTo(-rr, -rr * 0.15);
      ctx.lineTo(-rr * 0.15, -rr);
      ctx.lineTo(rr * 0.35, -rr);
      ctx.lineTo(-rr, rr * 0.35);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(6,8,12,0.32)';
      ctx.beginPath();
      ctx.ellipse(0, rr * 0.55, rr * 0.9, rr * 0.45, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // --- 内部纹理（裁剪） ---
    ctx.save();
    pathAt(1);
    ctx.clip();
    var k, q;
    if (superD) {
      ctx.strokeStyle = rgba(accent2, 0.32);
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 6]);
      ctx.lineDashOffset = -t * 26;
      ctx.beginPath(); ctx.arc(0, 0, rr * 0.62, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = rgba('#7C3BFF', 0.22);
      ctx.beginPath(); ctx.arc(0, 0, rr * 0.4, 0, TAU); ctx.stroke();
      for (k = 0; k < 3; k++) {
        var ra = t * 1.6 + k * (TAU / 3);
        var rd = rr * 0.62;
        ctx.save();
        ctx.translate(Math.cos(ra) * rd, Math.sin(ra) * rd);
        ctx.rotate(ra);
        ctx.fillStyle = rgba(accent2, 0.7);
        ctx.fillRect(-2.2, -2.2, 4.4, 4.4);
        ctx.restore();
      }
      var scan = ((t * 0.9) % 1) * rr * 2 - rr;
      ctx.fillStyle = rgba('#FFC7EF', 0.1);
      ctx.fillRect(-rr, scan, rr * 2, Math.max(2, rr * 0.08));
    } else {
      // 深色条纹 + 橙色警示刻度
      ctx.strokeStyle = 'rgba(18,20,26,0.35)';
      ctx.lineWidth = 4;
      for (k = -rr; k < rr; k += 11) {
        ctx.beginPath();
        ctx.moveTo(k, -rr);
        ctx.lineTo(k + rr * 1.5, rr);
        ctx.stroke();
      }
      ctx.strokeStyle = rgba(R.pal.orange, 0.35);
      ctx.lineWidth = 2;
      for (k = 0; k < 6; k++) {
        var ka = k / 6 * TAU + Math.PI / 6;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ka) * rr * 0.62, Math.sin(ka) * rr * 0.62);
        ctx.lineTo(Math.cos(ka) * rr * 0.86, Math.sin(ka) * rr * 0.86);
        ctx.stroke();
      }
      // 四颗亮铆钉
      for (k = 0; k < 4; k++) {
        var ba = k / 4 * TAU + Math.PI / 4;
        var bx = Math.cos(ba) * rr * 0.68, by = Math.sin(ba) * rr * 0.68;
        ctx.fillStyle = 'rgba(220,232,244,0.85)';
        ctx.beginPath();
        ctx.arc(bx, by, Math.max(1.6, rr * 0.06), 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(10,12,18,0.5)';
        ctx.beginPath();
        ctx.arc(bx + rr * 0.015, by + rr * 0.02, Math.max(0.8, rr * 0.028), 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();

    // --- 硬边描边 ---
    pathAt(0);
    if (superD) {
      ctx.strokeStyle = rgba('#FF5CD0', 0.3 + 0.16 * Math.sin(t * 6));
      ctx.lineWidth = Math.max(9, rr * 0.24);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = Math.max(1.2, rr * 0.04);
      ctx.stroke();
      ctx.strokeStyle = rgba('#FF7DE0', 0.98);
      ctx.lineWidth = Math.max(2.4, rr * 0.09);
      ctx.stroke();
      pathAt(Math.max(3, rr * 0.1));
      ctx.setLineDash([6, 7]);
      ctx.lineDashOffset = -t * 18;
      ctx.strokeStyle = rgba('#FF5CD0', 0.55);
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = 'rgba(8,10,14,0.95)';
      ctx.lineWidth = Math.max(4, rr * 0.16);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(214,228,242,0.92)';
      ctx.lineWidth = Math.max(2, rr * 0.065);
      ctx.stroke();
      pathAt(Math.max(3, rr * 0.1));
      ctx.strokeStyle = rgba(R.pal.orange, 0.42);
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    // --- 剩余时间弧 / 角标 ---
    if (shape === 'circle') {
      ctx.strokeStyle = rgba(accent, 0.5);
      ctx.lineWidth = Math.max(1.4, rr * 0.07);
      ctx.beginPath();
      ctx.arc(0, 0, rr * 1.12, -Math.PI / 2, -Math.PI / 2 + (1 - p) * TAU);
      ctx.stroke();
    } else {
      for (q = 0; q < pts.length; q++) {
        var vx = pts[q].x, vy = pts[q].y;
        var va = Math.atan2(vy, vx);
        ctx.strokeStyle = rgba(superD ? accent2 : R.pal.orange, 0.85);
        ctx.lineWidth = Math.max(2, rr * 0.08);
        ctx.beginPath();
        ctx.arc(vx, vy, Math.max(3, rr * 0.16), va + Math.PI * 0.35, va + Math.PI * 1.65);
        ctx.stroke();
      }
    }
    // 生成瞬间高亮
    if (p < 0.18) {
      ctx.globalAlpha = alpha * (1 - p / 0.18) * 0.8;
      pathAt(0);
      ctx.strokeStyle = superD ? '#FFFFFF' : '#FFF4DC';
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ============================================================
   * 天雷（特斯拉被动）：预警圈 + 落雷
   *  - 预警优先用 snapshot.strikes（engine 提供，per-frame）
   *  - 事件式 warn / thunderWarn 兜底走 R.warns，到点自动落雷
   * ============================================================ */
  function clipArena(ctx) {
    ctx.beginPath();
    if (SHAPE === 'circle') ctx.arc(WORLD / 2, WORLD / 2, ARENA_RADIUS, 0, TAU);
    else if (SHAPE === 'triangle' && TRI) triPathWorld(ctx, 0);
    else ctx.rect(0, 0, WORLD, WORLD);
    ctx.clip();
  }

  function drawStrikes(ctx, snapshot) {
    var strikes = (snapshot && snapshot.strikes) || null;
    var hasSnap = strikes && strikes.length;
    var hasWarn = R.warns.length > 0;
    if (!hasSnap && !hasWarn) return;
    ctx.save();
    clipArena(ctx);
    if (hasSnap) {
      var n = Math.min(strikes.length, MAX_WARNS + 6);
      for (var i = 0; i < n; i++) {
        var s = strikes[i];
        if (!s) continue;
        var warn = Math.max(0.05, num(s.warn, 0.35));
        var rem = clamp(num(s.remaining, warn), 0, warn);
        drawThunderMark(
          ctx,
          num(s.x, 0), num(s.y, 0),
          Math.max(8, num(s.radius != null ? s.radius : s.r, 60)),
          1 - rem / warn,
          (typeof s.color === 'string' && s.color) ? s.color : R.pal.gold
        );
      }
    }
    for (var j = 0; j < R.warns.length; j++) {
      var w = R.warns[j];
      var p = 1 - clamp(w.life / Math.max(0.0001, w.maxLife), 0, 1);
      drawThunderMark(ctx, w.x, w.y, w.r, p, w.color || R.pal.gold);
    }
    ctx.restore();
  }

  function drawThunderMark(ctx, x, y, rr, p, color) {
    var t = R.clock;
    p = clamp(p, 0, 1);
    var hot = p > 0.86;
    ctx.save();
    ctx.translate(x, y);
    // 地面光斑（尽量轻，多道重叠时不脏）
    ctx.fillStyle = rgba(color, 0.018 + 0.03 * p);
    ctx.beginPath(); ctx.arc(0, 0, rr, 0, TAU); ctx.fill();
    // 外圈虚线（旋转）
    ctx.save();
    ctx.rotate(t * (0.9 + p * 1.8));
    ctx.setLineDash([Math.max(3, rr * 0.13), Math.max(3, rr * 0.1)]);
    ctx.strokeStyle = rgba(color, 0.26 + 0.34 * p);
    ctx.lineWidth = Math.max(1, rr * 0.03);
    ctx.beginPath(); ctx.arc(0, 0, rr * (1.02 - 0.04 * p), 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    // 蓄能内环
    var cr = rr * (0.22 + 0.72 * p);
    ctx.strokeStyle = rgba('#FFF7E6', 0.16 + (hot ? 0.5 : 0.28 * p));
    ctx.lineWidth = Math.max(1.2, rr * 0.04);
    ctx.beginPath(); ctx.arc(0, 0, cr, 0, TAU); ctx.stroke();
    // 进度弧
    ctx.strokeStyle = rgba(color, 0.78);
    ctx.lineWidth = Math.max(1.6, rr * 0.06);
    ctx.beginPath();
    ctx.arc(0, 0, rr * 0.86, -Math.PI / 2, -Math.PI / 2 + p * TAU);
    ctx.stroke();
    // 中心雷符号
    var bs = rr * 0.2;
    ctx.fillStyle = rgba('#FFF7E6', 0.3 + 0.62 * p);
    ctx.beginPath();
    ctx.moveTo(bs * 0.35, -bs);
    ctx.lineTo(-bs * 0.45, bs * 0.12);
    ctx.lineTo(bs * 0.08, bs * 0.12);
    ctx.lineTo(-bs * 0.3, bs);
    ctx.lineTo(bs * 0.5, -bs * 0.16);
    ctx.lineTo(bs * 0.02, -bs * 0.16);
    ctx.closePath();
    ctx.fill();
    // 快落雷时上方光柱（只在最后 35% 出现，避免多道雷时满屏光柱）
    if (p > 0.65) {
      var beam = clamp((p - 0.65) / 0.35, 0, 1);
      var g = ctx.createLinearGradient(0, -rr * 4.2, 0, 0);
      g.addColorStop(0, rgba(color, 0));
      g.addColorStop(1, rgba(color, 0.1 * beam));
      ctx.fillStyle = g;
      ctx.fillRect(-rr * 0.17, -rr * 4.2, rr * 0.34, rr * 4.2);
    }
    if (hot) {
      ctx.strokeStyle = rgba('#FFF7E6', 0.6);
      ctx.lineWidth = Math.max(1.2, rr * 0.045);
      ctx.beginPath(); ctx.arc(0, 0, rr * 1.05, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }

  function strokePolyline(ctx, pts) {
    if (!pts || pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  function drawBolts(ctx) {
    if (!R.bolts.length) return;
    var t = R.clock;
    ctx.save();
    clipArena(ctx);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var i = 0; i < R.bolts.length; i++) {
      var b = R.bolts[i];
      var p = 1 - clamp(b.life / Math.max(0.0001, b.maxLife), 0, 1);
      var a = clamp(1 - p * 0.85, 0, 1);
      var flick = 0.62 + 0.38 * Math.sin(t * 46 + i * 2.7);
      ctx.globalAlpha = a * flick;
      // 外层辉光
      ctx.strokeStyle = rgba(b.color, 0.28);
      ctx.lineWidth = 12;
      strokePolyline(ctx, b.main);
      // 主闪电
      ctx.strokeStyle = rgba(b.color, 0.92);
      ctx.lineWidth = 3.6;
      strokePolyline(ctx, b.main);
      // 白芯
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      strokePolyline(ctx, b.main);
      // 分叉
      ctx.globalAlpha = a * flick * 0.85;
      ctx.strokeStyle = rgba(b.color, 0.6);
      ctx.lineWidth = 1.7;
      for (var j = 0; j < b.branch.length; j++) strokePolyline(ctx, b.branch[j]);
      ctx.lineWidth = 1.2;
      for (var k = 0; k < b.branch2.length; k++) strokePolyline(ctx, b.branch2[k]);
      // 落点冲击
      ctx.globalAlpha = a;
      ctx.fillStyle = rgba(b.color, 0.32 * a);
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, b.r * (0.55 + 0.5 * p), b.r * (0.16 + 0.22 * p), 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,247,230,' + (0.55 * a).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(b.x, b.y, Math.max(2, b.r * 0.2 * (1 - p * 0.4)), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawHazard(ctx, h) {
    var kind = h.kind || 'mine';
    var x = num(h.x, 0), y = num(h.y, 0);
    var rr = Math.max(4, num(h.r, num(h.radius, 30)));
    var life = num(h.life, 1), maxLife = Math.max(num(h.maxLife, 1), 0.01);
    var fadeIn = clamp((maxLife - life) / 0.15, 0.55, 1);
    var fadeOut = clamp(life / 0.3, 0, 1);
    var alpha = Math.min(fadeIn, fadeOut);
    if (alpha <= 0.02) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha *= alpha;
    if (kind === 'mine') drawMine(ctx, h, rr);
    else if (kind === 'fire') drawFire(ctx, h, rr);
    else if (kind === 'poison') drawPoison(ctx, h, rr);
    else if (kind === 'gravity') drawGravity(ctx, h, rr);
    else {
      ctx.fillStyle = rgba(R.pal.orange, 0.12);
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  /* 地雷（v0.4 机关）：可移动装置外观
   *  - 金属圆盘 + 三条滑橇/履带 + 天线 → 一眼是「可被移动的装置」
   *  - 未待发：旋转虚线 + 金色引信；已待发：红色引信 + 触发/爆炸半径淡环
   *  - 被引力井拉动：沿上一帧位置差分画淡拖尾
   *  - 主动「连环引爆」：全场地雷先闪一下
   */
  function drawMine(ctx, h, rr) {
    var t = R.clock;
    var sd = hashStr(h.id || 'mine');
    var owner = (typeof h.color === 'string' && h.color) ? h.color : R.pal.orange;
    var armed = h.armed !== false;
    var triggerR = Math.max(rr, num(h.triggerRadius, rr));
    var explodeR = Math.max(triggerR, num(h.explosionRadius, triggerR * 1.45));
    var activeR = Math.max(explodeR, num(h.activeExplosionRadius, explodeR * 2.3));
    var detonating = R.clock - R.detonateAt < 0.3;
    var dt01 = clamp((R.clock - R.detonateAt) / 0.3, 0, 1);
    var moving = false;
    var trail = R.mineTrail[h.id != null ? h.id : 'm'];
    if (trail && trail.length) moving = true;

    // 被引力井拉动 / 浮空移动的拖尾（位置差生成，无 vx/vy 也能画）
    if (moving) {
      ctx.save();
      ctx.lineCap = 'round';
      for (var i = 1; i < trail.length; i++) {
        var age = clamp(1 - (R.clock - trail[i].t) / 0.3, 0, 1);
        var x0 = trail[i - 1].x - num(h.x, 0), y0 = trail[i - 1].y - num(h.y, 0);
        var x1 = trail[i].x - num(h.x, 0), y1 = trail[i].y - num(h.y, 0);
        ctx.globalAlpha = age * 0.42;
        ctx.strokeStyle = rgba(R.pal.violet2, 0.9);
        ctx.lineWidth = Math.max(1.2, triggerR * 0.12 * age);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = rgba(R.pal.violet2, 0.9);
      var last = trail[trail.length - 1];
      if (last) {
        ctx.beginPath();
        ctx.arc(last.x - num(h.x, 0), last.y - num(h.y, 0), Math.max(1.2, triggerR * 0.1), 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    // 触发半径（很淡的虚线）
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.setLineDash([4, 8]);
    ctx.strokeStyle = rgba(armed ? R.pal.danger : R.pal.gold, 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, triggerR, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    // 爆炸半径（待发时淡淡一圈，让玩家知道范围）
    if (armed) {
      ctx.globalAlpha = 0.12;
      ctx.strokeStyle = rgba(R.pal.orange, 0.8);
      ctx.beginPath(); ctx.arc(0, 0, explodeR, 0, TAU); ctx.stroke();
    }
    ctx.restore();

    // 悬停暗示：地面阴影 + 外圈微光
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath(); ctx.ellipse(0, triggerR * 0.55, triggerR * 0.88, triggerR * 0.3, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = rgba(owner, 0.07 + (armed ? 0.05 : 0.02) * Math.sin(t * 4 + sd));
    ctx.beginPath(); ctx.arc(0, 0, triggerR * 1.18, 0, TAU); ctx.fill();

    // 滑橇 / 履带（偏移到装置底部，读作可移动）
    ctx.fillStyle = 'rgba(20,18,28,0.92)';
    ctx.strokeStyle = rgba(R.pal.cream, 0.22);
    ctx.lineWidth = 1;
    for (var k = -1; k <= 1; k += 2) {
      var sy = triggerR * 0.58;
      var sw = triggerR * 0.82, sh = triggerR * 0.3;
      ctx.beginPath();
      ctx.rect(-triggerR * 0.5 + k * triggerR * 0.34 - sw / 2, sy - sh / 2, sw, sh);
      ctx.fill();
      ctx.stroke();
      // 履带纹
      ctx.strokeStyle = rgba(R.pal.cream, 0.16);
      for (var tr = 0; tr < 3; tr++) {
        var tx = -triggerR * 0.5 + k * triggerR * 0.34 - sw / 2 + sw * (tr + 0.5) / 3;
        ctx.beginPath();
        ctx.moveTo(tx, sy - sh / 2);
        ctx.lineTo(tx, sy + sh / 2);
        ctx.stroke();
      }
    }

    // 金属外圈
    var g = ctx.createRadialGradient(-triggerR * 0.2, -triggerR * 0.25, triggerR * 0.1, 0, 0, triggerR * 0.85);
    g.addColorStop(0, '#3A4050');
    g.addColorStop(0.55, '#1E222E');
    g.addColorStop(1, '#0E1016');
    ctx.beginPath(); ctx.arc(0, 0, triggerR * 0.85, 0, TAU);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = rgba(owner, 0.9);
    ctx.lineWidth = Math.max(1.4, triggerR * 0.09);
    ctx.stroke();
    // 外圈锯齿（危险感）
    ctx.beginPath();
    for (var z = 0; z < 10; z++) {
      var za = z / 10 * TAU + sd * 0.1;
      var za1 = za - 0.1, za2 = za + 0.1;
      ctx.moveTo(Math.cos(za1) * triggerR * 0.82, Math.sin(za1) * triggerR * 0.82);
      ctx.lineTo(Math.cos(za) * triggerR * 0.98, Math.sin(za) * triggerR * 0.98);
      ctx.lineTo(Math.cos(za2) * triggerR * 0.82, Math.sin(za2) * triggerR * 0.82);
    }
    ctx.strokeStyle = rgba(owner, 0.45);
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // 内盘 + 螺栓
    ctx.fillStyle = 'rgba(26,22,36,0.95)';
    ctx.beginPath(); ctx.arc(0, 0, triggerR * 0.56, 0, TAU); ctx.fill();
    ctx.strokeStyle = rgba(R.pal.cream, 0.22);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = rgba(R.pal.cream, 0.4);
    for (var b = 0; b < 4; b++) {
      var ba = b / 4 * TAU + Math.PI / 4;
      ctx.beginPath();
      ctx.arc(Math.cos(ba) * triggerR * 0.43, Math.sin(ba) * triggerR * 0.43, Math.max(1, triggerR * 0.05), 0, TAU);
      ctx.fill();
    }

    // 天线 + 顶端灯（可移动装置的标志）
    var antH = triggerR * 1.25;
    ctx.strokeStyle = rgba(R.pal.cream, 0.72);
    ctx.lineWidth = Math.max(1.2, triggerR * 0.06);
    ctx.beginPath();
    ctx.moveTo(triggerR * 0.3, -triggerR * 0.15);
    ctx.lineTo(triggerR * 0.52, -antH);
    ctx.stroke();
    ctx.fillStyle = rgba(R.pal.cream, 0.25);
    ctx.beginPath();
    ctx.arc(triggerR * 0.3, -triggerR * 0.15, Math.max(1, triggerR * 0.06), 0, TAU);
    ctx.fill();
    var blink = 0.5 + 0.5 * Math.sin(t * (armed ? 12 : 4) + sd);
    ctx.fillStyle = rgba(armed ? R.pal.danger : R.pal.gold, 0.6 + 0.4 * blink);
    ctx.beginPath(); ctx.arc(triggerR * 0.5, -antH, Math.max(1.4, triggerR * 0.1), 0, TAU); ctx.fill();

    // 中央引信灯
    var led = armed ? R.pal.danger : R.pal.gold;
    ctx.fillStyle = rgba(led, 0.22 + 0.5 * blink);
    ctx.beginPath(); ctx.arc(0, 0, triggerR * 0.3, 0, TAU); ctx.fill();
    ctx.fillStyle = rgba(led, 0.6 + 0.4 * blink);
    ctx.beginPath(); ctx.arc(0, 0, triggerR * 0.13, 0, TAU); ctx.fill();

    // 未待发：旋转虚线 + 待发进度感
    if (!armed) {
      ctx.save();
      ctx.rotate(t * 1.8);
      ctx.setLineDash([5, 6]);
      ctx.strokeStyle = rgba(R.pal.gold, 0.55);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, triggerR * 0.72, 0, TAU); ctx.stroke();
      ctx.restore();
    }

    // 主动「连环引爆」：每颗雷先闪一下再炸
    if (detonating) {
      ctx.save();
      var flash = (1 - dt01) * (0.7 + 0.3 * Math.sin(t * 60));
      ctx.globalAlpha = 0.5 + 0.5 * flash;
      ctx.strokeStyle = rgba('#FFF7E6', flash);
      ctx.lineWidth = Math.max(2, triggerR * 0.14);
      ctx.beginPath(); ctx.arc(0, 0, triggerR * (1.0 + dt01 * 0.7), 0, TAU); ctx.stroke();
      ctx.strokeStyle = rgba(R.pal.danger, flash * 0.9);
      ctx.lineWidth = Math.max(1.4, triggerR * 0.08);
      ctx.beginPath(); ctx.arc(0, 0, triggerR * (0.6 + dt01 * 0.5), 0, TAU); ctx.stroke();
      ctx.restore();
    }
  }

  function flamePath(ctx, x, y, w, h, wob) {
    ctx.beginPath();
    ctx.moveTo(x - w * 0.5, y);
    ctx.bezierCurveTo(x - w * 0.66 + wob * 0.4, y - h * 0.3,
      x - w * 0.12 + wob, y - h * 0.56, x - w * 0.03 + wob, y - h);
    ctx.bezierCurveTo(x + w * 0.14 + wob, y - h * 0.6,
      x + w * 0.56 + wob * 0.3, y - h * 0.26, x + w * 0.5, y);
    ctx.closePath();
  }

  /* 火痕（v0.3）：不再有独立伤害，只对进入者施加余烬 → 画成焦痕 + 余烬地面 */
  function drawFire(ctx, h, rr) {
    var t = R.clock;
    var sd = hashStr(h.id || 'fire');
    var burnOnly = h.burnOnly === true || h.src === 'meteor_drop';
    // 焦痕：火痕用多层低透明度椭圆，相邻段叠起来才看得像一整条
    if (burnOnly) {
      ctx.fillStyle = 'rgba(8,5,8,0.10)';
      ctx.beginPath(); ctx.ellipse(0, rr * 0.08, rr * 1.18, rr * 0.9, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(8,5,8,0.15)';
      ctx.beginPath(); ctx.ellipse(0, rr * 0.1, rr * 0.9, rr * 0.66, 0, 0, TAU); ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(8,5,8,0.42)';
      ctx.beginPath(); ctx.ellipse(0, rr * 0.1, rr * 0.95, rr * 0.62, 0, 0, TAU); ctx.fill();
    }
    // 热光
    var glow = 0.04 + (burnOnly ? 0.03 : 0.035) * (0.5 + 0.5 * Math.sin(t * 3 + sd));
    ctx.fillStyle = 'rgba(255,107,26,' + glow.toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(0, 0, rr * 1.12, 0, TAU); ctx.fill();
    // 低矮火苗（火痕的火势压低，读作“还在烧的余烬”）
    var flames = burnOnly ? 3 : 5;
    for (var i = 0; i < flames; i++) {
      var bx = (i - (flames - 1) / 2) * rr * (burnOnly ? 0.4 : 0.26);
      var wave = Math.sin(t * 7 + i * 1.9 + sd) * 0.5 + 0.5;
      var hh = rr * (burnOnly ? 0.18 + 0.26 * wave : 0.32 + 0.46 * wave);
      var wob = Math.sin(t * 8 + i * 2.1) * rr * 0.07;
      ctx.fillStyle = rgba(R.pal.orange, burnOnly ? 0.28 : 0.42);
      flamePath(ctx, bx, rr * 0.4, rr * (burnOnly ? 0.4 : 0.66), hh, wob);
      ctx.fill();
      ctx.fillStyle = rgba(R.pal.orange2, burnOnly ? 0.34 : 0.5);
      flamePath(ctx, bx, rr * 0.4, rr * (burnOnly ? 0.25 : 0.44), hh * 0.62, wob * 0.8);
      ctx.fill();
    }
    // 余烬亮点（缓慢闪烁）
    var emberCount = burnOnly ? 6 : 4;
    for (var e = 0; e < emberCount; e++) {
      var ax = (rnd(sd, e + 11) - 0.5) * rr * 1.25;
      var ay = (rnd(sd, e + 21) - 0.3) * rr * 0.6;
      var blink = 0.45 + 0.45 * Math.sin(t * 2.3 + e * 2 + sd);
      ctx.fillStyle = rgba('#FFE9A8', 0.3 + 0.4 * blink);
      ctx.fillRect(ax, ay, 2.4, 2.4);
    }
    // 上升火星
    var sparks = burnOnly ? 6 : 5;
    for (var k = 0; k < sparks; k++) {
      var ex = (rnd(sd, k) - 0.5) * rr * 1.2;
      var ey = rr * 0.2 - ((t * (burnOnly ? 16 : 30) + rnd(sd, k + 5) * rr) % (rr * 1.1));
      ctx.fillStyle = rgba(k % 2 ? R.pal.gold : R.pal.orange2, 0.7);
      ctx.fillRect(ex, ey, 2.2, 2.2);
    }
  }

  function drawPoison(ctx, h, rr) {
    var t = R.clock;
    var sd = hashStr(h.id || 'poison');
    var col = (typeof h.color === 'string' && h.color) ? h.color : '#4BE38A';
    // 毒云
    ctx.fillStyle = rgba(col, 0.07);
    ctx.beginPath(); ctx.arc(0, 0, rr * 0.98, 0, TAU); ctx.fill();
    ctx.fillStyle = rgba(col, 0.06);
    ctx.beginPath(); ctx.arc(0, 0, rr * 0.72, 0, TAU); ctx.fill();
    ctx.fillStyle = rgba(col, 0.05);
    ctx.beginPath(); ctx.arc(0, 0, rr * 0.46, 0, TAU); ctx.fill();
    // 外圈虚线（旋转）
    ctx.save();
    ctx.rotate(t * 0.25 + sd);
    ctx.setLineDash([rr * 0.12, rr * 0.09]);
    ctx.strokeStyle = rgba(col, 0.35);
    ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.arc(0, 0, rr * 0.88, 0, TAU); ctx.stroke();
    ctx.restore();
    // 气泡
    for (var i = 0; i < 7; i++) {
      var bx = (rnd(sd, i * 2) - 0.5) * rr * 1.5;
      var byBase = (rnd(sd, i * 2 + 1) - 0.5) * rr * 1.3;
      var rise = rr * 1.2;
      var by = byBase + rr * 0.6 - ((t * (14 + i * 2) + rnd(sd, i + 30) * rise) % rise);
      var br = rr * (0.05 + rnd(sd, i + 20) * 0.09);
      ctx.fillStyle = rgba(mix(col, '#FFFFFF', 0.35), 0.42);
      ctx.beginPath(); ctx.arc(bx, by, br, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(8,10,9,0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath(); ctx.arc(bx - br * 0.3, by - br * 0.35, br * 0.24, 0, TAU); ctx.fill();
    }
    // 上方漂浮小团
    ctx.fillStyle = rgba(col, 0.16);
    for (var k = 0; k < 3; k++) {
      var a = t * 0.5 + k * 2.1;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * rr * 0.4, Math.sin(a) * rr * 0.3 - rr * 0.2, rr * 0.14, 0, TAU);
      ctx.fill();
    }
  }

  function drawGravity(ctx, h, rr) {
    var t = R.clock;
    var sd = hashStr(h.id || 'gravity');
    var life = num(h.life, 1), maxLife = Math.max(num(h.maxLife, 1), 0.01);
    var lp = clamp(1 - life / maxLife, 0, 1);          // 0 出现 → 1 消失
    var grow = clamp(lp / 0.14, 0, 1);
    var Rr = rr * (0.35 + 0.65 * easeOutCubic(grow));
    // 井体：径向暗紫渐变（吸光）
    var g0 = ctx.createRadialGradient(0, 0, Rr * 0.04, 0, 0, Rr);
    g0.addColorStop(0, 'rgba(4,2,10,0.94)');
    g0.addColorStop(0.42, 'rgba(22,9,40,0.58)');
    g0.addColorStop(0.8, 'rgba(70,26,104,0.2)');
    g0.addColorStop(1, 'rgba(10,6,18,0)');
    ctx.fillStyle = g0;
    ctx.beginPath(); ctx.arc(0, 0, Rr, 0, TAU); ctx.fill();
    // 引力边界
    ctx.strokeStyle = rgba(R.pal.violet2, 0.16 + 0.1 * Math.sin(t * 3.2));
    ctx.lineWidth = Math.max(1.2, Rr * 0.012);
    ctx.beginPath(); ctx.arc(0, 0, Rr * 0.97, 0, TAU); ctx.stroke();
    // 旋转吸积环
    for (var i = 0; i < 3; i++) {
      ctx.save();
      ctx.rotate(t * (0.7 + i * 0.5) * (i % 2 ? -1 : 1) + sd * 0.1);
      ctx.setLineDash([Rr * (0.09 + i * 0.03), Rr * (0.05 + i * 0.02)]);
      ctx.strokeStyle = rgba(i === 1 ? R.pal.violet2 : R.pal.violet, 0.32 - i * 0.06 + 0.1 * Math.sin(t * 4 + i));
      ctx.lineWidth = Math.max(1.1, Rr * 0.014);
      ctx.beginPath(); ctx.arc(0, 0, Rr * (0.36 + i * 0.2), 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    // 螺旋吸积臂
    ctx.save();
    ctx.rotate(t * 0.85);
    ctx.strokeStyle = rgba(R.pal.violet2, 0.3);
    ctx.lineWidth = Math.max(1.1, Rr * 0.012);
    for (var arm = 0; arm < 3; arm++) {
      ctx.beginPath();
      for (var k = 0; k <= 26; k++) {
        var q = k / 26;
        var ang = arm * TAU / 3 + q * 2.4;
        var rad = Rr * (0.22 + q * 0.72);
        var px = Math.cos(ang) * rad, py = Math.sin(ang) * rad;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.restore();
    // 被吸入的星屑（确定性，跟时钟走，不额外开池）
    if (!R.reducedMotion) {
      ctx.fillStyle = rgba(R.pal.violet2, 0.6);
      for (var q2 = 0; q2 < 10; q2++) {
        var per = 1.15 + rnd(sd, q2) * 1.1;
        var pr = ((t / per + rnd(sd, q2 + 20)) % 1);
        var pang = rnd(sd, q2 + 40) * TAU + t * (0.3 + 0.15 * (q2 % 3));
        var prad = Rr * (1 - pr * 0.85);
        ctx.globalAlpha = (1 - pr) * 0.7;
        ctx.fillRect(Math.cos(pang) * prad - 1.4, Math.sin(pang) * prad - 1.4, 2.8, 2.8);
      }
      ctx.globalAlpha = 1;
    }
    // 中心黑洞 + 事件视界光环（引力井的核心辨识点）
    var core = Math.max(4, Rr * 0.17);
    ctx.fillStyle = '#040208';
    ctx.beginPath(); ctx.arc(0, 0, core, 0, TAU); ctx.fill();
    ctx.strokeStyle = rgba(R.pal.violet2, 0.5 + 0.25 * Math.sin(t * 6));
    ctx.lineWidth = Math.max(1.4, core * 0.3);
    ctx.beginPath(); ctx.arc(0, 0, core * 1.06, 0, TAU); ctx.stroke();
    ctx.strokeStyle = rgba('#FFC7EF', 0.32);
    ctx.lineWidth = Math.max(1, core * 0.15);
    ctx.beginPath(); ctx.arc(0, 0, core * 1.3, -2.6, -0.6); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, core * 1.3, 0.6, 2.6); ctx.stroke();
    // 井口高光（提示这是「范围内减伤」的场，不是纯伤害区）
    var shimmer = 0.5 + 0.5 * Math.sin(t * 5);
    ctx.strokeStyle = rgba(R.pal.violet, 0.1 + 0.09 * shimmer);
    ctx.lineWidth = Math.max(2, Rr * 0.02);
    ctx.beginPath(); ctx.arc(0, 0, Rr * 0.97, 0, TAU); ctx.stroke();
  }

  /* ============================================================
   * 拖影
   * ============================================================ */
  function drawTrails(ctx) {
    ctx.save();
    for (var id in R.trails) {
      var list = R.trails[id].list;
      for (var i = 0; i < list.length; i++) {
        var g = list[i];
        var a = clamp(1 - g.age / 0.16, 0, 1);
        if (a <= 0.01) continue;
        ctx.globalAlpha = a * 0.13;
        ctx.fillStyle = g.color;
        ctx.beginPath(); ctx.arc(g.x, g.y, g.r * 0.86, 0, TAU); ctx.fill();
        ctx.globalAlpha = a * 0.16;
        ctx.strokeStyle = g.color;
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(g.x, g.y, g.r * 0.86, 0, TAU); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ============================================================
   * 蜜蜂（v0.3 蜂群召唤物）：小像素蜂，普通/狂暴两套外观
   * snapshot.bees = [{id,ownerId,x,y,r,state:'orbit'|'chase',slot,angle,orbitRadius,
   *                   frenzy,remaining,maxLife,speed,targetId}]
   *  - orbit：绕蜂群本体飞（sim 摆在轨道上）→ 画淡轨道弧 + 切向拖影
   *  - chase：追踪敌人 → 画一段虚线拖尾
   * ============================================================ */
  function drawBees(ctx, snapshot) {
    var bees = (snapshot && snapshot.bees) || null;
    if (!bees || !bees.length) return;
    var F = root.BallFaces;
    var t = R.clock;
    var n = Math.min(bees.length, MAX_BEES);
    var orbitOwners = {};
    for (var i = 0; i < n; i++) {
      var b = bees[i];
      if (!b) continue;
      var bx = num(b.x, 0), by = num(b.y, 0);
      var br = Math.max(3, num(b.r, 7));
      // 追踪/环绕位置做帧间插值，减少跳点
      var sm = R.beeSmooth || (R.beeSmooth = {});
      var bk = b.id != null ? b.id : ('i' + i);
      var sr = sm[bk];
      if (!sr) { sr = sm[bk] = { x: bx, y: by }; }
      else {
        sr.x += (bx - sr.x) * 0.28;
        sr.y += (by - sr.y) * 0.28;
        bx = sr.x; by = sr.y;
      }
      var life = num(b.remaining, 1), maxLife = Math.max(0.01, num(b.maxLife, 3));
      var dieFade = clamp(life / 0.25, 0, 1);
      var frenzy = !!b.frenzy;
      var frame = Math.floor(t * 14 + i) % 2;
      var state = b.state || 'orbit';
      // 追踪开始时 remaining=maxLife，不能再用“出生淡入”判透明；只在死亡前 0.25s 淡出
      var alpha = dieFade;
      if (alpha <= 0.02) continue;

      // 只画清晰蜂体；不再画轨道/拖尾/暗色圆点
      if (F && typeof F.drawBee === 'function') {
        F.drawBee(ctx, bx, by, br * 1.7, frenzy, frame, {
          alpha: alpha,
          pixelScale: (R.view.scale || 1) * (R.view.dpr || 1)
        });
      } else {
        // 兜底：没有 faces.js 时画个双色小点
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = frenzy ? '#FF8A4D' : '#FFD642';
        ctx.beginPath(); ctx.arc(bx, by, br * 0.6, 0, TAU); ctx.fill();
        ctx.fillStyle = '#1B1408';
        ctx.fillRect(bx - br * 0.6, by - br * 0.15, br * 1.2, br * 0.3);
        ctx.restore();
      }
    }
  }

  /* ============================================================
   * 小球
   * ============================================================ */
  function drawBalls(ctx, snapshot, dt) {
    var ents = (snapshot && snapshot.entities) || [];
    var over = !!(snapshot && snapshot.status === 'over');
    prewarmFaces();
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (!e) continue;
      // 战斗：只画存活；结束画面：死亡球也画（dead 表情），胜者 victory
      if (!e.alive && !over) continue;
      var isWinner = over && snapshot.winnerId != null &&
        (e.ballId === snapshot.winnerId || e.id === snapshot.winnerId);
      try { drawBall(ctx, e, over, isWinner); } catch (err) { warnOnce('ball', err); }
    }
  }

  /* 当前实体所在的引力井（黑洞：井内减伤 / 中心减速） */
  function gravityInfoFor(e) {
    var hz = (R.snapshot && R.snapshot.hazards) || null;
    if (!hz || !hz.length) return null;
    var ex = num(e.x, 0), ey = num(e.y, 0);
    for (var i = 0; i < hz.length; i++) {
      var h = hz[i];
      if (!h || h.kind !== 'gravity') continue;
      var rad = num(h.radius != null ? h.radius : h.r, 200);
      if (!(rad > 0)) continue;
      var dx = ex - num(h.x, 0), dy = ey - num(h.y, 0);
      var d2 = dx * dx + dy * dy;
      if (d2 > rad * rad) continue;
      var owner = (h.ownerId != null && h.ownerId === e.id);
      return { h: h, d: Math.sqrt(d2), rad: rad, owner: owner, cx: num(h.x, 0), cy: num(h.y, 0) };
    }
    return null;
  }

  function drawBall(ctx, e, over, isWinner) {
    var r = num(e.r, 30);
    if (r < 2) return;
    var x = num(e.x, 0), y = num(e.y, 0);
    var color = (typeof e.color === 'string' && e.color) ? e.color : R.pal.orange;
    var color2 = (typeof e.color2 === 'string' && e.color2) ? e.color2 : R.pal.cream;
    var look = e.look || 'meteor';
    var t = R.clock;
    var hpPct = clamp(num(e.hpPct, num(e.hp, 1) / Math.max(1, num(e.maxHp, 1))), 0, 1);
    var flash = clamp(num(e.flash, 0), 0, 1);
    var fx = 0, fy = 0;
    if (e.facing && isFinite(e.facing.x) && isFinite(e.facing.y)) { fx = e.facing.x; fy = e.facing.y; }
    var ghosting = !!e.ghosting;
    var invuln = !!e.invuln;
    var spikeOn = !!statusKind(e, 'spike');
    var dashing = !!e.dashing;
    var sd = hashStr(e.ballId || e.id || 'ball');
    var reduced = R.reducedMotion;
    var speed = num(e.speed, 0);
    var fst = faceStateOf(e, hpPct, flash, !!over, !!isWinner);
    var state = fst.state;
    var well = gravityInfoFor(e);
    var deadLook = !!over && !isWinner;      // 结束画面里的尸体：半透明、不画状态字

    // ---- 动作参数：calm 呼吸、受击抖动、施法鼓胀、低血量发抖 ----
    var bob = 0, squashX = 1, squashY = 1, jitterX = 0;
    if (!reduced) {
      if (state === 'calm') {
        if (speed < 60) {
          bob = Math.sin(t * 2.0 + (sd % 41) * 0.1) * r * 0.035;
          squashY = 1 + Math.sin(t * 2.0 + (sd % 41) * 0.1) * 0.012;
        }
      } else if (state === 'hurt') {
        jitterX = Math.sin(t * 62 + sd) * r * 0.035;
        squashX = 1.035; squashY = 0.965;
      } else if (state === 'cast') {
        squashX = 1 + 0.025 + Math.sin(t * 18 + sd) * 0.012;
        squashY = 1 + 0.025 + Math.sin(t * 18 + sd + 1.2) * 0.012;
      } else if (state === 'low') {
        jitterX = Math.sin(t * 11 + sd) * r * 0.012;
      }
    }
    // 高速时沿运动方向轻微拉伸（挤压拉长，保持方向感）
    if (!reduced && speed > 120) {
      var st2 = clamp((speed - 120) / 520, 0, 1) * 0.055;
      squashX += st2; squashY -= st2;
    }

    ctx.save();
    ctx.translate(x, y);
    if (ghosting) ctx.globalAlpha *= 0.62;
    if (deadLook) ctx.globalAlpha *= 0.52;

    // 冲刺速度线
    if (dashing || speed > 345) {
      var spd = Math.max(1, speed);
      var dirX = num(e.vx, 0) / spd, dirY = num(e.vy, 0) / spd;
      var dl = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
      dirX /= dl; dirY /= dl;
      ctx.strokeStyle = rgba(color2, 0.26);
      ctx.lineWidth = Math.max(1.4, r * 0.065);
      for (var si = 0; si < 3; si++) {
        var off = (si - 1) * r * 0.52;
        var st = r * 0.72 + si * 4 + (reduced ? 0 : (t * 90 + si * 17) % 10);
        var len = r * (0.5 + 0.22 * si);
        ctx.beginPath();
        ctx.moveTo(-dirX * st - dirY * off, -dirY * st + dirX * off);
        ctx.lineTo(-dirX * (st + len) - dirY * off, -dirY * (st + len) + dirX * off);
        ctx.stroke();
      }
    }

    // 投影（不跟随呼吸浮动）
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.beginPath();
    ctx.ellipse(0, r * 0.9, r * 0.82, r * 0.26, 0, 0, TAU);
    ctx.fill();

    ctx.save();
    ctx.translate(bob * 0.35 + jitterX, bob);
    ctx.scale(squashX, squashY);

    // 施法 / 无敌光晕
    if (!reduced) {
      var scale = 1;
      if (flash > 0.01) scale += flash * 0.075;
      if (e.castGlow || state === 'cast') scale += 0.02 + 0.018 * Math.sin(t * 24 + sd);
      if (scale !== 1) ctx.scale(scale, scale);
    }

    if (e.castGlow || state === 'cast') {
      var cg = 0.5 + 0.5 * Math.sin(t * 20);
      var castCol = color2;
      ctx.fillStyle = rgba(castCol, 0.05 + 0.05 * cg);
      ctx.beginPath(); ctx.arc(0, 0, r * 1.2, 0, TAU); ctx.fill();
      ctx.strokeStyle = rgba(castCol, 0.22 + 0.16 * cg);
      ctx.lineWidth = Math.max(1.3, r * 0.045);
      ctx.beginPath(); ctx.arc(0, 0, r * 1.08, 0, TAU); ctx.stroke();
      // 施法能量刻度
      for (var ck = 0; ck < 6; ck++) {
        var ca = ck / 6 * TAU + t * 1.2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ca) * r * 1.12, Math.sin(ca) * r * 1.12);
        ctx.lineTo(Math.cos(ca) * r * 1.22, Math.sin(ca) * r * 1.22);
        ctx.stroke();
      }
    }
    if (invuln || ghosting) {
      ctx.save();
      ctx.rotate(t * 1.5);
      ctx.setLineDash([r * 0.22, r * 0.18]);
      ctx.strokeStyle = rgba(R.pal.violet2, 0.62);
      ctx.lineWidth = Math.max(1.4, r * 0.05);
      ctx.beginPath(); ctx.arc(0, 0, r * 1.16, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 引力井内：黑洞的减伤护壁 / 敌对球被拉扯的力场
    if (well) {
      ctx.save();
      if (well.owner) {
        var wg = 0.55 + 0.35 * Math.sin(t * 5.5);
        ctx.strokeStyle = rgba(R.pal.violet2, 0.35 + 0.2 * wg);
        ctx.lineWidth = Math.max(1.6, r * 0.06);
        ctx.beginPath(); ctx.arc(0, 0, r * 1.12, -2.4, -0.6); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, r * 1.12, 0.75, 2.35); ctx.stroke();
        ctx.fillStyle = rgba(R.pal.violet, 0.06 + 0.04 * wg);
        ctx.beginPath(); ctx.arc(0, 0, r * 1.14, 0, TAU); ctx.fill();
      } else {
        var kx = (well.cx - x) / Math.max(1, well.d);
        var ky = (well.cy - y) / Math.max(1, well.d);
        ctx.strokeStyle = rgba(R.pal.violet2, 0.28 + 0.14 * Math.sin(t * 8));
        ctx.lineWidth = Math.max(1.1, r * 0.035);
        for (var wk = 0; wk < 3; wk++) {
          var wo = (wk - 1) * r * 0.5;
          var wa = t * 3 + wk * 2.1;
          ctx.beginPath();
          ctx.moveTo(kx * r * 1.25 - ky * wo, ky * r * 1.25 + kx * wo);
          ctx.lineTo(kx * r * 1.6 - ky * wo, ky * r * 1.6 + kx * wo);
          ctx.stroke();
          if (!reduced) {
            ctx.globalAlpha = 0.55 + 0.45 * Math.sin(wa);
            ctx.fillStyle = rgba(R.pal.violet2, 0.7);
            ctx.fillRect(kx * r * 1.5 - 1.2, ky * r * 1.5 - 1.2, 2.4, 2.4);
            ctx.globalAlpha = 1;
          }
        }
      }
      ctx.restore();
    }

    // ------- 球体 -------
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.closePath();
    ctx.save();
    ctx.clip();

    var isGhost = look === 'ghost';
    var grad = ctx.createRadialGradient(-r * 0.36, -r * 0.42, r * 0.06, 0, 0, r * 1.12);
    grad.addColorStop(0, mix(color2, '#FFFFFF', 0.45));
    grad.addColorStop(0.34, mix(color2, color, isGhost ? 0.35 : 0.45));
    grad.addColorStop(0.7, isGhost ? mix(color, '#FFFFFF', 0.2) : mix(color, '#FFFFFF', 0.06));
    grad.addColorStop(1, shade(color, isGhost ? -0.12 : -0.3));
    ctx.fillStyle = grad;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    // 内侧色环，增强体积
    ctx.strokeStyle = rgba(color2, 0.14);
    ctx.lineWidth = Math.max(1.5, r * 0.06);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.9, 0, TAU); ctx.stroke();

    // 底部内阴影（先画阴影，再叠图案，保证图案不被压暗）
    var shadowA = isGhost ? 0.28 : 0.5;
    var sg = ctx.createRadialGradient(0, r * 0.8, r * 0.1, 0, r * 0.15, r * 1.15);
    sg.addColorStop(0, 'rgba(8,6,12,' + shadowA + ')');
    sg.addColorStop(0.55, 'rgba(8,6,12,' + (shadowA * 0.3).toFixed(3) + ')');
    sg.addColorStop(1, 'rgba(8,6,12,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(-r, -r, r * 2, r * 2);

    drawPattern(ctx, look, r, t, e, color, color2, sd);
    // 虚弱：球体表面覆一层灰紫（降攻的直观表现）
    if (hasStatus(e, 'weakness')) {
      ctx.fillStyle = 'rgba(150,90,210,0.10)';
      ctx.fillRect(-r, -r, r * 2, r * 2);
    }
    // 低血量：内部暗角加深（不显示血条，用画面表达濒死）
    if (hpPct < 0.32) {
      var dg = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r);
      dg.addColorStop(0, 'rgba(10,6,14,0)');
      dg.addColorStop(1, 'rgba(10,4,10,' + (0.34 * (0.32 - hpPct) / 0.32 + 0.12).toFixed(3) + ')');
      ctx.fillStyle = dg;
      ctx.fillRect(-r, -r, r * 2, r * 2);
    }

    // 受击白闪（收敛一点，表情不被闪糊）
    if (flash > 0.01) {
      ctx.globalAlpha = Math.min(0.6, flash * 0.72);
      ctx.fillStyle = '#FFF6E4';
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.globalAlpha = 1;
    }
    ctx.restore(); // clip

    // 深色描边
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU);
    ctx.lineWidth = Math.max(2, r * 0.085);
    ctx.strokeStyle = mix(color, '#0A0910', 0.74);
    ctx.stroke();
    ctx.restore(); // body

    // 左上高光弧
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.89, Math.PI * 1.04, Math.PI * 1.54);
    ctx.strokeStyle = rgba(mix(color2, '#FFFFFF', 0.55), 0.55);
    ctx.lineWidth = Math.max(1.6, r * 0.065);
    ctx.stroke();

    // 荆棘 look 的静态尖刺
    if (look === 'thorn' && !spikeOn) drawThornSpikes(ctx, r, color, color2, sd);
    if (spikeOn) drawSpikeAura(ctx, r, sd);

    // 各 look 的外圈道具（轮廓之外，远看也能认出性格）
    drawLookAura(ctx, look, r, t, color, color2, sd);

    // 低血量裂纹
    if (hpPct < 0.32) drawCracks(ctx, r, hpPct, sd);
    // 霜降 debuff：破甲崩口 / 虚弱下坠残影
    drawDebuffMarks(ctx, e, r, t, sd);

    // 表情：共享像素精灵（calm/low/cast/hurt/victory/dead）
    drawBallFace(ctx, e, r, fst);

    // 护盾六边形（护盾仍是视觉指示，不是生命条）
    var shield = num(e.shield, 0);
    if (shield > 0.05) drawShieldHex(ctx, r, shield, t, color2);

    ctx.restore(); // 呼吸 / 挤压
    ctx.restore(); // translate

    // 效果名（只名字，无数值、无方框；DOM HUD 另有完整面板）
    if (!deadLook) drawStatusNames(ctx, e, x, y + r, r, fst);
  }

  /* ---------------- look 图案 ---------------- */
  function drawPattern(ctx, look, r, t, e, color, color2, sd) {
    switch (look) {
      case 'meteor': patternMeteor(ctx, r, t, color, color2, sd); break;
      case 'trapper': patternTrapper(ctx, r, t, color, color2, sd); break;
      case 'iron': patternIron(ctx, r, t, color, color2, sd); break;
      case 'frost': patternFrost(ctx, r, t, color, color2, sd); break;
      case 'volt': patternVolt(ctx, r, t, color, color2, sd); break;
      case 'venom': patternVenom(ctx, r, t, color, color2, sd); break;
      case 'ghost': patternGhost(ctx, r, t, color, color2, sd); break;
      case 'grav': patternGrav(ctx, r, t, color, color2, sd); break;
      case 'thorn': patternThorn(ctx, r, t, color, color2, sd); break;
      case 'swarm': patternSwarm(ctx, r, t, color, color2, sd); break;
      default: patternGeneric(ctx, r, t, color, color2, sd); break;
    }
  }

  function patternMeteor(ctx, r, t, color, color2, sd) {
    ctx.fillStyle = 'rgba(10,6,10,0.30)';
    ctx.beginPath();
    ctx.ellipse(0, r * 0.64, r * 0.95, r * 0.6, 0, 0, TAU);
    ctx.fill();
    var layers = [
      { c: rgba(R.pal.orange, 0.62), w: 0.38, h: 0.9 },
      { c: rgba(R.pal.orange2, 0.78), w: 0.26, h: 0.62 },
      { c: rgba('#FFF2C8', 0.85), w: 0.14, h: 0.38 }
    ];
    for (var L = 0; L < layers.length; L++) {
      var lay = layers[L];
      for (var i = 0; i < 4; i++) {
        var off = (i - 1.5) * r * 0.3;
        var wob = Math.sin(t * (6 + L * 2) + i * 1.9 + sd) * r * 0.07;
        var hh = r * (0.42 + lay.h * 0.62 + 0.16 * Math.sin(t * (8 + i) + L * 2 + sd));
        ctx.fillStyle = lay.c;
        flamePath(ctx, off, r * 0.8, r * lay.w * (2.1 - i * 0.16), hh, wob);
        ctx.fill();
      }
    }
    for (var k = 0; k < 6; k++) {
      var px = (rnd(sd, k) - 0.5) * r * 1.5;
      var py = -r * 0.15 - ((t * 22 + rnd(sd, k + 9) * r) % (r * 1.05));
      ctx.fillStyle = rgba(k % 2 ? R.pal.orange2 : R.pal.gold, 0.65);
      ctx.fillRect(px, py, 2.6, 2.6);
    }
    ctx.fillStyle = 'rgba(10,6,10,0.22)';
    for (var m = 0; m < 3; m++) {
      var mx = (rnd(sd, m + 40) - 0.5) * r * 1.4;
      var my = (rnd(sd, m + 50) - 0.3) * r * 1.2;
      ctx.beginPath(); ctx.arc(mx, my, r * (0.1 + rnd(sd, m + 60) * 0.1), 0, TAU); ctx.fill();
    }
  }

  function patternTrapper(ctx, r, t, color, color2, sd) {
    var rot = R.reducedMotion ? 0 : t * 0.3;
    ctx.save();
    // 齿轮外圈（贴在描边内侧）
    ctx.fillStyle = rgba(color2, 0.42);
    for (var i = 0; i < 14; i++) {
      ctx.save();
      ctx.rotate(i / 14 * TAU + rot * 0.3);
      ctx.fillRect(r * 0.8, -r * 0.045, r * 0.11, r * 0.09);
      ctx.restore();
    }
    // 准星大环
    ctx.rotate(rot);
    ctx.strokeStyle = rgba(color2, 0.78);
    ctx.lineWidth = Math.max(1.5, r * 0.052);
    ctx.setLineDash([r * 0.24, r * 0.14]);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.7, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    // 十字贯穿
    ctx.beginPath();
    ctx.moveTo(-r * 0.86, 0); ctx.lineTo(-r * 0.72, 0);
    ctx.moveTo(r * 0.72, 0); ctx.lineTo(r * 0.86, 0);
    ctx.moveTo(0, -r * 0.86); ctx.lineTo(0, -r * 0.72);
    ctx.moveTo(0, r * 0.72); ctx.lineTo(0, r * 0.86);
    ctx.stroke();
    // 对角刻线
    for (i = 0; i < 4; i++) {
      var a = i / 4 * TAU + Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.56, Math.sin(a) * r * 0.56);
      ctx.lineTo(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8);
      ctx.stroke();
    }
    ctx.restore();
    // 中心红点（数字下方隐约）
    ctx.fillStyle = 'rgba(255,79,109,0.55)';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.045, 0, TAU); ctx.fill();
  }

  function patternIron(ctx, r, t, color, color2, sd) {
    // 板缝
    ctx.strokeStyle = 'rgba(10,9,16,0.35)';
    ctx.lineWidth = Math.max(1.4, r * 0.05);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.71, Math.PI * 0.14, Math.PI * 0.86); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.71, Math.PI * 1.14, Math.PI * 1.86); ctx.stroke();
    // 铆钉
    for (var i = 0; i < 8; i++) {
      var a = i / 8 * TAU + Math.PI / 8;
      var rx = Math.cos(a) * r * 0.8, ry = Math.sin(a) * r * 0.8;
      ctx.fillStyle = shade(color, 0.5);
      ctx.beginPath(); ctx.arc(rx, ry, r * 0.088, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(10,9,16,0.6)';
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath(); ctx.arc(rx - r * 0.024, ry - r * 0.024, r * 0.028, 0, TAU); ctx.fill();
    }
    // 斜向高光板
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = r * 0.07;
    ctx.beginPath();
    ctx.moveTo(-r * 0.52, -r * 0.3);
    ctx.lineTo(-r * 0.15, -r * 0.62);
    ctx.stroke();
    // 螺丝十字
    var sx = r * 0.42, sy = r * 0.55;
    ctx.strokeStyle = 'rgba(10,9,16,0.5)';
    ctx.lineWidth = Math.max(1, r * 0.035);
    ctx.beginPath();
    ctx.moveTo(sx - r * 0.06, sy); ctx.lineTo(sx + r * 0.06, sy);
    ctx.moveTo(sx, sy - r * 0.06); ctx.lineTo(sx, sy + r * 0.06);
    ctx.stroke();
  }

  function drawSnowflake(ctx, x, y, size, color, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = rgba(color, alpha);
    ctx.lineWidth = Math.max(1.1, size * 0.14);
    ctx.lineCap = 'round';
    for (var i = 0; i < 6; i++) {
      ctx.save();
      ctx.rotate(i / 6 * TAU);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -size); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.52); ctx.lineTo(size * 0.28, -size * 0.74);
      ctx.moveTo(0, -size * 0.52); ctx.lineTo(-size * 0.28, -size * 0.74);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  function patternFrost(ctx, r, t, color, color2, sd) {
    drawSnowflake(ctx, -r * 0.44, r * 0.44, r * 0.36, color2, 0.95);
    drawSnowflake(ctx, r * 0.52, r * 0.16, r * 0.19, color2, 0.75);
    // 冰晶
    ctx.fillStyle = rgba(color2, 0.3);
    for (var i = 0; i < 3; i++) {
      var a = -0.6 + i * 1.9 + sd * 0.01;
      var cx = Math.cos(a) * r * 0.62, cy = Math.sin(a) * r * 0.62;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 0.15);
      ctx.lineTo(cx + r * 0.1, cy + r * 0.07);
      ctx.lineTo(cx - r * 0.1, cy + r * 0.07);
      ctx.closePath();
      ctx.fill();
    }
    // 霜边
    ctx.strokeStyle = rgba('#FFFFFF', 0.4);
    ctx.lineWidth = Math.max(1.2, r * 0.055);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.82, -2.5, -1.7); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.82, 0.7, 1.5); ctx.stroke();
  }

  function patternVolt(ctx, r, t, color, color2, sd) {
    var jit = R.reducedMotion ? 0 : Math.sin(t * 18 + sd) * r * 0.022;
    var i;
    ctx.save();
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'butt';
    function bolt(pts, w1, w2, w3) {
      ctx.beginPath();
      for (var k = 0; k < pts.length; k++) {
        var px = pts[k][0] + (k % 2 ? jit : -jit), py = pts[k][1];
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = 'rgba(10,9,16,0.52)';
      ctx.lineWidth = w1;
      ctx.stroke();
      ctx.strokeStyle = rgba(color2, 0.95);
      ctx.lineWidth = w2;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.lineWidth = w3;
      ctx.stroke();
    }
    // 主闪电（贴右边缘，避开数字与描边）
    bolt([
      [r * 0.38, -r * 0.8], [r * 0.78, -r * 0.32], [r * 0.55, -r * 0.16],
      [r * 0.82, r * 0.3], [r * 0.62, -r * 0.02], [r * 0.8, r * 0.34]
    ], Math.max(3.5, r * 0.17), Math.max(2.2, r * 0.09), Math.max(1, r * 0.036));
    // 副闪电（贴左边缘）
    bolt([
      [-r * 0.44, -r * 0.72], [-r * 0.78, -r * 0.24], [-r * 0.54, -r * 0.08], [-r * 0.8, r * 0.36]
    ], Math.max(2.4, r * 0.11), Math.max(1.5, r * 0.058), Math.max(0.8, r * 0.024));
    // 顶部支线
    ctx.beginPath();
    ctx.moveTo(r * 0.78, -r * 0.32);
    ctx.lineTo(r * 0.5, -r * 0.62);
    ctx.strokeStyle = rgba(color2, 0.75);
    ctx.lineWidth = Math.max(1.4, r * 0.05);
    ctx.stroke();
    ctx.restore();
    // 电弧火花点
    for (i = 0; i < 5; i++) {
      ctx.fillStyle = rgba(R.pal.cream, 0.5 + 0.4 * Math.sin(t * 9 + i));
      ctx.fillRect((rnd(sd, i) - 0.5) * r * 1.5, (rnd(sd, i + 7) - 0.5) * r * 1.5, 2.4, 2.4);
    }
  }

  function patternVenom(ctx, r, t, color, color2, sd) {
    for (var i = 0; i < 8; i++) {
      var bx = (rnd(sd, i * 2) - 0.5) * r * 1.44;
      var by = (rnd(sd, i * 2 + 1) - 0.5) * r * 1.22;
      var br = r * (0.07 + rnd(sd, i + 21) * 0.13);
      var yy = by + Math.sin(t * 1.4 + i * 1.3) * r * 0.05;
      ctx.fillStyle = rgba(color2, 0.62);
      ctx.beginPath(); ctx.arc(bx, yy, br, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(10,9,16,0.4)';
      ctx.lineWidth = Math.max(1, br * 0.25);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath(); ctx.arc(bx - br * 0.3, yy - br * 0.34, br * 0.27, 0, TAU); ctx.fill();
    }
    // 底部滴液
    ctx.fillStyle = rgba(shade(color, -0.3), 0.6);
    ctx.beginPath();
    ctx.ellipse(0, r * 0.78, r * 0.2, r * 0.14, 0, 0, TAU);
    ctx.fill();
    // 粘液弧
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = Math.max(1.2, r * 0.055);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.72, -2.6, -1.85); ctx.stroke();
  }

  function patternGhost(ctx, r, t, color, color2, sd) {
    ctx.fillStyle = 'rgba(220,220,255,0.08)';
    ctx.fillRect(-r, -r, r * 2, r * 2);
    // 虚线内圈
    ctx.setLineDash([r * 0.13, r * 0.11]);
    ctx.strokeStyle = rgba(color2, 0.55);
    ctx.lineWidth = Math.max(1.3, r * 0.045);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.8, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    // 裙摆波纹
    for (var k = 0; k < 3; k++) {
      var y0 = r * (0.34 + k * 0.17);
      ctx.strokeStyle = rgba(color2, 0.26 - k * 0.055);
      ctx.lineWidth = Math.max(1.1, r * 0.045);
      ctx.beginPath();
      for (var i = 0; i <= 12; i++) {
        var xx = -r * 0.72 + i / 12 * r * 1.44;
        var yy = y0 + Math.sin(i / 12 * TAU + t * 1.2 + k) * r * 0.04;
        if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
    }
    // 上方柔光
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    ctx.beginPath();
    ctx.ellipse(-r * 0.3, -r * 0.46, r * 0.46, r * 0.26, -0.4, 0, TAU);
    ctx.fill();
  }

  function patternGrav(ctx, r, t, color, color2, sd) {
    var rot = R.reducedMotion ? 0 : t * 0.6;
    // 轨道环
    for (var i = 0; i < 3; i++) {
      ctx.save();
      ctx.rotate(i * Math.PI / 3 + rot * (i % 2 ? -0.5 : 0.5));
      ctx.strokeStyle = rgba(color2, 0.45 - i * 0.08);
      ctx.lineWidth = Math.max(1.2, r * 0.04);
      ctx.beginPath();
      ctx.ellipse(0, 0, r * (0.7 - i * 0.08), r * (0.26 - i * 0.02), 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
    // 轨道星点
    for (i = 0; i < 3; i++) {
      var a = t * 1.5 + i * 2.1;
      ctx.save();
      ctx.rotate(i * Math.PI / 3);
      var ox = Math.cos(a) * r * 0.68, oy = Math.sin(a) * r * 0.24;
      ctx.fillStyle = rgba(color2, 0.95);
      ctx.beginPath(); ctx.arc(ox, oy, r * 0.065, 0, TAU); ctx.fill();
      ctx.restore();
    }
    // 中心暗核
    ctx.fillStyle = 'rgba(8,5,14,0.5)';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.34, 0, TAU); ctx.fill();
    ctx.strokeStyle = rgba(color2, 0.3);
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  function patternThorn(ctx, r, t, color, color2, sd) {
    // 内部裂纹
    ctx.strokeStyle = 'rgba(10,9,16,0.42)';
    ctx.lineWidth = Math.max(1.2, r * 0.05);
    for (var i = 0; i < 3; i++) {
      var a = rnd(sd, i) * TAU;
      var x0 = Math.cos(a) * r * 0.88, y0 = Math.sin(a) * r * 0.88;
      var x1 = Math.cos(a + 0.4) * r * 0.5, y1 = Math.sin(a + 0.4) * r * 0.5;
      var x2 = Math.cos(a + 0.15) * r * 0.3, y2 = Math.sin(a + 0.15) * r * 0.3;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(color2, 0.1);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.56, 0, TAU); ctx.fill();
  }

  function patternSwarm(ctx, r, t, color, color2, sd) {
    // 蜂窝点阵
    var sp = r * 0.27;
    ctx.strokeStyle = rgba(shade(color, -0.5), 0.62);
    ctx.lineWidth = Math.max(1.1, r * 0.032);
    for (var row = -2; row <= 2; row++) {
      for (var col = -2; col <= 2; col++) {
        var hx = col * sp * 1.72 + (row % 2 ? sp * 0.86 : 0);
        var hy = row * sp * 1.48;
        if (Math.sqrt(hx * hx + hy * hy) > r * 0.78) continue;
        ctx.beginPath();
        for (var k = 0; k < 6; k++) {
          var a = k / 6 * TAU + Math.PI / 6;
          var vx = hx + Math.cos(a) * sp * 0.42;
          var vy = hy + Math.sin(a) * sp * 0.42;
          if (k === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
        }
        ctx.closePath();
        ctx.stroke();
        if ((row + col + 10) % 4 === 0) {
          ctx.fillStyle = rgba(color2, 0.3);
          ctx.fill();
        }
      }
    }
    // 小蜂点
    for (var i = 0; i < 3; i++) {
      var ba = t * 2 + i * 2.1;
      var bx = Math.cos(ba) * r * 0.6, by = Math.sin(ba) * r * 0.42;
      ctx.fillStyle = 'rgba(10,9,16,0.75)';
      ctx.beginPath(); ctx.arc(bx, by, r * 0.06, 0, TAU); ctx.fill();
      ctx.fillStyle = rgba(color2, 0.55);
      ctx.fillRect(bx - r * 0.12, by - r * 0.1, r * 0.09, r * 0.04);
      ctx.fillRect(bx + r * 0.03, by - r * 0.1, r * 0.09, r * 0.04);
    }
  }

  function patternGeneric(ctx, r, t, color, color2, sd) {
    ctx.strokeStyle = 'rgba(10,9,16,0.3)';
    ctx.lineWidth = Math.max(1.2, r * 0.045);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.68, 0.3, 2.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.68, 3.4, 5.4); ctx.stroke();
  }

  /* ============================================================
   * 脸（v0.3）：共享像素表情 BallFaces（js/faces.js）
   *  - 只画五官层；球体渐变/描边/图案保持原样，不整体像素化
   *  - 战斗态由 faceStateOf 决定：calm / low / cast / hurt / victory / dead
   *  - 帧数据来自 BallFaces 缓存，UI 大厅/选球/斗士详情用的是同一套精灵
   * ============================================================ */
  var FACE_PREWARMED = false;
  function facesReady() {
    return !!(root.BallFaces && typeof root.BallFaces.draw === 'function');
  }
  function prewarmFaces() {
    if (FACE_PREWARMED || !facesReady()) return;
    FACE_PREWARMED = true;
    try {
      var ids = [];
      var data = R.data || root.GameData || {};
      var balls = data.BALLS || [];
      for (var i = 0; i < balls.length; i++) {
        if (balls[i] && balls[i].id) ids.push(balls[i].id);
      }
      if (!ids.length) {
        ids = ['B0001', 'B0002', 'B0003', 'B0004', 'B0005',
          'B0006', 'B0007', 'B0008', 'B0009', 'B0010'];
      }
      root.BallFaces.prewarm(ids, ['calm', 'low', 'cast', 'hurt', 'victory', 'dead']);
      root.BallFaces.prewarm(ids, ['idle']);
    } catch (e) { warnOnce('faces-prewarm', e); }
  }

  /* 战场上给球贴共享像素脸：尺寸 = 球直径 × BallFaces.faceRatio */
  function drawBallFace(ctx, e, r, fst) {
    var F = root.BallFaces;
    if (!F || typeof F.draw !== 'function') { warnOnce('no-faces'); return; }
    var id = e.ballId || e.look || 'B0001';
    var state = fst.state;
    var st = fst.st;
    if (st.faceState !== state) {
      st.faceState = state;
      st.faceAt = R.clock;
    }
    var frames = F.frameCount(id, state) || 1;
    var dur = Math.max(0.04, (F.frameDuration(id, state) || 1000) / 1000);
    var frame = (frames > 1 && !R.reducedMotion) ? Math.floor((R.clock - st.faceAt) / dur) % frames : 0;
    var ratio = F.faceRatio || 0.85;
    var size = r * 2 * ratio;
    var ps = (R.view.scale || 1) * (R.view.dpr || 1);
    var fx = 0, fy = 0;
    if (e.facing && isFinite(e.facing.x) && isFinite(e.facing.y)) {
      fx = clamp(e.facing.x, -1, 1);
      fy = clamp(e.facing.y, -1, 1);
    }
    // 视线：极轻微的整体偏移（BallFaces 内部会把位置吸附到设备像素）
    F.draw(ctx, id, state, frame, 0, -r * 0.02, size, {
      alpha: fst.dead ? 0.55 : 1,
      offsetX: fx * r * 0.03,
      offsetY: fy * r * 0.02,
      pixelScale: ps
    });
  }

  /* ---------------- 效果名：只显示名字（无数值/时间/方框） ---------------- */
  function collectStatusNames(e) {
    var out = [], seen = {}, i;
    var st = e && e.statuses;
    var names = e && e.statusNames;
    if (!st || !st.length) {
      if (names && names.length) {
        for (i = 0; i < names.length && i < MAX_STATUS_NAMES; i++) {
          out.push({ name: String(names[i] || ''), color: R.pal.cream, pri: 1 });
        }
      }
      return out;
    }
    var useNames = !!(names && names.length === st.length);
    for (i = 0; i < st.length; i++) {
      var it = st[i];
      if (!it || !it.kind || seen[it.kind]) continue;
      // 护盾有六边形罩、回复有特效，不重复占文字行
      if (it.kind === 'shield' || it.kind === 'heal') continue;
      var meta = statusMeta(it.kind);
      if (!meta) continue;
      seen[it.kind] = 1;
      var nm = (useNames && names[i]) ? String(names[i]) : meta.name;
      if (!nm) continue;
      out.push({ name: nm, color: meta.color || R.pal.cream, pri: meta.pri || 1 });
    }
    out.sort(function (a, b) { return b.pri - a.pri; });
    return out;
  }

  function labelFont(px) {
    var key = 's' + Math.round(px * 2);
    if (R.fontKey !== key) {
      R.fontKey = key;
      R.fontStr = '700 ' + (Math.round(px * 2) / 2) + 'px ' + FONT_ZH;
    }
    return R.fontStr;
  }

  function drawStatusNames(ctx, e, x, yEdge, r, fst) {
    var list = collectStatusNames(e);
    if (!list.length) return;
    var S = R.view.size || 1;
    var pxPerWorld = (S > 0 && WORLD > 0) ? WORLD / S : 1;   // 1 屏幕像素 = N 世界单位
    var compact = S < 560;
    var maxN = compact ? 1 : MAX_STATUS_NAMES;               // 小屏只留最紧要的一条，避免糊成一团
    if (list.length > maxN) list.length = maxN;
    var sf = compact ? 9 : (S < 820 ? 10 : 10.5);            // 屏幕像素字号
    var gap = 9 * pxPerWorld, sep = 6 * pxPerWorld;
    ctx.save();
    ctx.translate(x, yEdge + Math.max(10, r * 0.2) * 1.0);
    ctx.scale(pxPerWorld, pxPerWorld);  // 文字按屏幕像素绘制，不随球场缩放糊掉
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = labelFont(sf);
    var widths = [], total = 0, i;
    for (i = 0; i < list.length; i++) {
      var key = sf + '|' + list[i].name;
      var w = R.labelW[key];
      if (w === undefined) {
        w = ctx.measureText(list[i].name).width;
        R.labelW[key] = w;
      }
      widths.push(w);
      total += w + (i ? sep : 0);
    }
    var cx = -total / 2;
    for (i = 0; i < list.length; i++) {
      var lx = cx + widths[i] / 2;
      ctx.lineWidth = Math.max(2.2, sf * 0.32);
      ctx.strokeStyle = 'rgba(6,4,11,0.92)';
      ctx.strokeText(list[i].name, lx, 0);
      ctx.fillStyle = list[i].color;
      ctx.fillText(list[i].name, lx, 0);
      // 名字下细色条：不画方框，只留一点颜色标识
      ctx.fillStyle = rgba(list[i].color, 0.8);
      ctx.fillRect(lx - widths[i] / 2, sf * 0.66, widths[i], Math.max(1.2, sf * 0.1));
      cx += widths[i] + sep;
    }
    ctx.restore();
  }

  /* 破甲：外圈崩口；虚弱：两侧下坠的紫色残影（霜降 debuff 的视觉反馈） */
  function drawDebuffMarks(ctx, e, r, t, sd) {
    if (hasStatus(e, 'armorBreak')) {
      ctx.save();
      var pulse = 0.55 + 0.45 * Math.sin(t * 6 + (sd % 13));
      ctx.strokeStyle = rgba('#FF9B57', 0.38 + 0.28 * pulse);
      ctx.lineWidth = Math.max(1.3, r * 0.05);
      for (var i = 0; i < 3; i++) {
        var a = (sd % 17) * 0.37 + i * 2.1 + t * 0.2;
        ctx.beginPath(); ctx.arc(0, 0, r * 0.99, a - 0.34, a + 0.26); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9);
        ctx.lineTo(Math.cos(a) * r * 1.04, Math.sin(a) * r * 1.04);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (hasStatus(e, 'weakness')) {
      ctx.save();
      ctx.fillStyle = rgba('#C58BFF', 0.5);
      for (var w2 = 0; w2 < 2; w2++) {
        var side = w2 ? 1 : -1;
        var ph = ((t * 0.9 + w2 * 0.5) % 1);
        var yy = r * 0.15 + ph * r * 1.15;
        var xx = side * r * 0.92;
        ctx.globalAlpha = 0.65 * (1 - ph);
        ctx.beginPath();
        ctx.moveTo(xx - r * 0.09, yy);
        ctx.lineTo(xx + r * 0.09, yy);
        ctx.lineTo(xx, yy + r * 0.13);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawShieldHex(ctx, r, shield, t, color2) {
    var hr = r + Math.max(6, r * 0.2);
    var strength = clamp(shield / 55, 0, 1);
    var shimmer = 0.5 + 0.5 * Math.sin(t * 5);
    var col = mix(color2, '#54E6FF', 0.55);
    ctx.save();
    ctx.beginPath();
    for (var i = 0; i < 6; i++) {
      var a = -Math.PI / 2 + i / 6 * TAU;
      var px = Math.cos(a) * hr, py = Math.sin(a) * hr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = rgba(col, 0.08 + 0.06 * shimmer * strength);
    ctx.fill();
    ctx.strokeStyle = rgba(col, 0.5 + 0.3 * shimmer);
    ctx.lineWidth = Math.max(1.4, r * 0.05);
    ctx.stroke();
    // 旋转内罩
    ctx.rotate(t * 0.6);
    ctx.setLineDash([Math.max(3, r * 0.16), Math.max(2.5, r * 0.13)]);
    ctx.strokeStyle = 'rgba(255,244,220,0.25)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (i = 0; i < 6; i++) {
      var a2 = i / 6 * TAU;
      var qx = Math.cos(a2) * hr * 0.82, qy = Math.sin(a2) * hr * 0.82;
      if (i === 0) ctx.moveTo(qx, qy); else ctx.lineTo(qx, qy);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function drawThornSpikes(ctx, r, color, color2, sd) {
    ctx.save();
    for (var i = 0; i < 10; i++) {
      var a = i / 10 * TAU + sd % 17 * 0.01;
      var len = r * (0.13 + rnd(sd, i) * 0.1);
      var b1 = a - 0.115, b2 = a + 0.115;
      ctx.beginPath();
      ctx.moveTo(Math.cos(b1) * r * 0.96, Math.sin(b1) * r * 0.96);
      ctx.lineTo(Math.cos(a) * (r + len), Math.sin(a) * (r + len));
      ctx.lineTo(Math.cos(b2) * r * 0.96, Math.sin(b2) * r * 0.96);
      ctx.closePath();
      ctx.fillStyle = rgba(mix(color, color2, 0.35), 0.92);
      ctx.fill();
      ctx.strokeStyle = 'rgba(10,9,16,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSpikeAura(ctx, r, sd) {
    var t = R.clock;
    ctx.save();
    for (var i = 0; i < 12; i++) {
      var a = i / 12 * TAU + (R.reducedMotion ? 0 : Math.sin(t * 3 + i) * 0.03);
      var len = r * (0.17 + 0.07 * Math.sin(t * 9 + i * 1.7 + sd));
      var b1 = a - 0.1, b2 = a + 0.1;
      ctx.beginPath();
      ctx.moveTo(Math.cos(b1) * r * 0.98, Math.sin(b1) * r * 0.98);
      ctx.lineTo(Math.cos(a) * (r + len), Math.sin(a) * (r + len));
      ctx.lineTo(Math.cos(b2) * r * 0.98, Math.sin(b2) * r * 0.98);
      ctx.closePath();
      ctx.fillStyle = rgba(R.pal.danger, 0.85);
      ctx.fill();
      ctx.strokeStyle = 'rgba(10,9,16,0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------- 外圈性格道具 ---------------- */
  function drawLookAura(ctx, look, r, t, color, color2, sd) {
    var i, a, rad, px, py;
    switch (look) {
      case 'meteor': {
        for (i = 0; i < 5; i++) {
          a = t * 1.3 + i * 1.35 + (sd % 10);
          rad = r * (1.12 + 0.06 * Math.sin(t * 2.2 + i));
          px = Math.cos(a) * rad;
          py = Math.sin(a) * rad * 0.92 - r * 0.05;
          ctx.fillStyle = rgba(i % 2 ? R.pal.gold : R.pal.orange, 0.35 + 0.3 * Math.sin(t * 6 + i));
          ctx.fillRect(px - 1.7, py - 1.7, 3.4, 3.4);
        }
        break;
      }
      case 'trapper': {
        // 四角锁定括号
        ctx.strokeStyle = rgba(color2, 0.6);
        ctx.lineWidth = Math.max(1.6, r * 0.055);
        for (i = 0; i < 4; i++) {
          a = i / 4 * TAU + Math.PI / 4;
          ctx.save();
          ctx.translate(Math.cos(a) * r * 1.16, Math.sin(a) * r * 1.16);
          ctx.rotate(a);
          ctx.beginPath();
          ctx.moveTo(-r * 0.12, -r * 0.12);
          ctx.lineTo(0, 0);
          ctx.lineTo(r * 0.12, -r * 0.12);
          ctx.stroke();
          ctx.restore();
        }
        break;
      }
      case 'iron': {
        // 外层装甲六角
        ctx.strokeStyle = rgba(shade(color, 0.32), 0.42);
        ctx.lineWidth = Math.max(1.4, r * 0.05);
        ctx.beginPath();
        for (i = 0; i < 6; i++) {
          a = -Math.PI / 2 + i / 6 * TAU;
          px = Math.cos(a) * r * 1.03;
          py = Math.sin(a) * r * 1.03;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
        // 六角铆钉
        ctx.fillStyle = rgba(R.pal.cream, 0.5);
        for (i = 0; i < 6; i++) {
          a = -Math.PI / 2 + i / 6 * TAU;
          ctx.fillRect(Math.cos(a) * r * 1.03 - 1.4, Math.sin(a) * r * 1.03 - 1.4, 2.8, 2.8);
        }
        break;
      }
      case 'frost': {
        for (i = 0; i < 3; i++) {
          a = t * 0.5 + i * 2.09 + sd % 7;
          drawSnowflake(ctx, Math.cos(a) * r * 1.2, Math.sin(a) * r * 1.2, r * 0.15, color2, 0.6);
        }
        // 冷雾弧
        ctx.strokeStyle = rgba(color2, 0.22);
        ctx.lineWidth = Math.max(1.2, r * 0.04);
        ctx.beginPath(); ctx.arc(0, 0, r * 1.13, -2.7, -1.9); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, r * 1.13, 0.5, 1.3); ctx.stroke();
        break;
      }
      case 'volt': {
        // 环绕电弧
        for (i = 0; i < 3; i++) {
          a = t * 1.7 + i * 2.1 + sd % 5;
          var flick = Math.sin(t * 20 + i * 3) > -0.2 ? 1 : 0.3;
          var x0 = Math.cos(a) * r * 1.08, y0 = Math.sin(a) * r * 1.08;
          var x1 = Math.cos(a + 0.35) * r * 1.22, y1 = Math.sin(a + 0.35) * r * 1.22;
          var xm = (x0 + x1) / 2 + Math.cos(a + 1.57) * r * 0.12;
          var ym = (y0 + y1) / 2 + Math.sin(a + 1.57) * r * 0.12;
          ctx.strokeStyle = rgba(color2, 0.75 * flick);
          ctx.lineWidth = Math.max(1.4, r * 0.045);
          ctx.lineJoin = 'miter';
          ctx.beginPath();
          ctx.moveTo(x0, y0); ctx.lineTo(xm, ym); ctx.lineTo(x1, y1);
          ctx.stroke();
        }
        break;
      }
      case 'venom': {
        // 底部滴液
        for (i = 0; i < 3; i++) {
          a = -0.5 + i * 0.5;
          var dy = Math.sin(t * 1.6 + i * 2) * r * 0.03;
          ctx.fillStyle = rgba(mix(color, '#FFFFFF', 0.25), 0.55);
          ctx.beginPath();
          ctx.ellipse(Math.cos(a) * r * 0.8, r * 0.99 + r * 0.1 + dy, r * 0.07, r * 0.11, 0, 0, TAU);
          ctx.fill();
        }
        // 外圈气泡
        var by = r * 0.2 - ((t * 14 + (sd % 20)) % (r * 1.7));
        ctx.fillStyle = rgba(color2, 0.4);
        ctx.beginPath();
        ctx.arc(r * 1.1, by, r * 0.07, 0, TAU);
        ctx.fill();
        break;
      }
      case 'ghost': {
        // 虚线轨道
        ctx.save();
        ctx.rotate(t * 0.35);
        ctx.setLineDash([r * 0.16, r * 0.16]);
        ctx.strokeStyle = rgba(color2, 0.3);
        ctx.lineWidth = Math.max(1.2, r * 0.035);
        ctx.beginPath(); ctx.arc(0, 0, r * 1.15, 0, TAU); ctx.stroke();
        ctx.restore();
        // 两侧幽光
        ctx.strokeStyle = rgba(color2, 0.35);
        ctx.lineWidth = Math.max(1.2, r * 0.04);
        ctx.beginPath(); ctx.arc(0, 0, r * 1.06, -1.1, -0.2); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, r * 1.06, 2.1, 3.0); ctx.stroke();
        break;
      }
      case 'grav': {
        // 外圈轨道
        for (i = 0; i < 2; i++) {
          ctx.save();
          ctx.rotate(i * Math.PI / 2.2 + t * 0.25 * (i % 2 ? -1 : 1));
          ctx.strokeStyle = rgba(color2, 0.42 - i * 0.1);
          ctx.lineWidth = Math.max(1.2, r * 0.035);
          ctx.beginPath();
          ctx.ellipse(0, 0, r * 1.24, r * 0.4, 0, 0, TAU);
          ctx.stroke();
          ctx.restore();
        }
        // 轨道星点
        for (i = 0; i < 2; i++) {
          a = t * 1.1 + i * 3.14;
          ctx.save();
          ctx.rotate(i * Math.PI / 2.2);
          ctx.fillStyle = rgba(color2, 0.9);
          ctx.beginPath();
          ctx.arc(Math.cos(a) * r * 1.24, Math.sin(a) * r * 0.4, r * 0.045, 0, TAU);
          ctx.fill();
          ctx.restore();
        }
        break;
      }
      case 'thorn': {
        ctx.strokeStyle = rgba(color2, 0.3);
        ctx.lineWidth = Math.max(1.6, r * 0.05);
        ctx.beginPath(); ctx.arc(0, 0, r * 1.12, 0, TAU); ctx.stroke();
        break;
      }
      case 'swarm': {
        // 外圈小蜜蜂
        for (i = 0; i < 3; i++) {
          a = t * 1.4 + i * 2.09;
          px = Math.cos(a) * r * 1.22;
          py = Math.sin(a) * r * 1.22;
          ctx.fillStyle = 'rgba(10,9,16,0.8)';
          ctx.beginPath(); ctx.arc(px, py, r * 0.05, 0, TAU); ctx.fill();
          ctx.fillStyle = rgba(color2, 0.65);
          ctx.fillRect(px - r * 0.09, py - r * 0.1, r * 0.07, r * 0.035);
          ctx.fillRect(px + r * 0.02, py - r * 0.1, r * 0.07, r * 0.035);
        }
        break;
      }
      default:
        break;
    }
  }

  function drawCracks(ctx, r, hpPct, sd) {
    var intensity = clamp((0.32 - hpPct) / 0.32, 0, 1);
    ctx.save();
    ctx.strokeStyle = 'rgba(10,9,16,' + (0.35 + 0.4 * intensity).toFixed(3) + ')';
    ctx.lineWidth = Math.max(1.1, r * 0.04);
    ctx.lineCap = 'butt';
    for (var i = 0; i < 3; i++) {
      var a = rnd(sd, i + 70) * TAU;
      var rad = r * 0.92;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
      var steps = 3;
      for (var k = 1; k <= steps; k++) {
        rad = r * (0.92 - k * 0.15);
        a += (rnd(sd, i * 7 + k) - 0.5) * 0.5;
        ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ============================================================
   * 特效渲染
   * ============================================================ */
  function drawParticles(ctx) {
    if (!R.particles.length) return;
    ctx.save();
    for (var i = 0; i < R.particles.length; i++) {
      var p = R.particles[i];
      var a = clamp(p.life / p.maxLife, 0, 1);
      if (p.kind === 'smoke') {
        ctx.globalAlpha = a * 0.32;
        ctx.fillStyle = 'rgba(10,9,16,1)';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
      } else if (p.kind === 'ember') {
        ctx.globalAlpha = a;
        ctx.fillStyle = rgba(p.color, 1);
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, p.size * 0.5), 0, TAU); ctx.fill();
      } else {
        ctx.globalAlpha = a;
        ctx.fillStyle = rgba(p.color, 1);
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    ctx.restore();
  }

  function drawRings(ctx) {
    if (!R.rings.length) return;
    for (var i = 0; i < R.rings.length; i++) {
      var g = R.rings[i];
      var p = clamp(1 - g.life / Math.max(0.0001, g.maxLife), 0, 1);
      var rad = lerp(g.r0, g.r1, easeOutCubic(p));
      var alpha = clamp(1 - p, 0, 1);
      var col = g.color || R.pal.cream;
      ctx.save();
      if (g.kind === 'blizzard' || g.kind === 'singularity' || g.kind === 'spawn') {
        ctx.setLineDash(g.kind === 'singularity' ? [5, 11] : [10, 9]);
      }
      // 外发光
      ctx.globalAlpha = alpha * 0.22;
      ctx.strokeStyle = rgba(col, 1);
      ctx.lineWidth = Math.max(2, g.width * 2.6);
      ctx.beginPath(); ctx.arc(g.x, g.y, rad, 0, TAU); ctx.stroke();
      // 主环
      ctx.globalAlpha = alpha * 0.9;
      ctx.lineWidth = Math.max(1.2, g.width * (1 - p * 0.5));
      ctx.beginPath(); ctx.arc(g.x, g.y, rad, 0, TAU); ctx.stroke();
      // 特性
      if (g.kind === 'bulwark') {
        ctx.globalAlpha = alpha * 0.45;
        ctx.lineWidth = Math.max(1, g.width * 0.6);
        ctx.beginPath(); ctx.arc(g.x, g.y, rad * 0.94, 0, TAU); ctx.stroke();
      } else if (g.kind === 'storm') {
        ctx.globalAlpha = alpha * 0.5;
        ctx.lineWidth = Math.max(2, g.width * 1.4);
        ctx.beginPath(); ctx.arc(g.x, g.y, rad, 0, TAU); ctx.stroke();
      } else if (g.kind === 'spawn') {
        ctx.setLineDash([]);
        ctx.globalAlpha = alpha * 0.8;
        ctx.lineWidth = 1.6;
        for (var k = 0; k < 4; k++) {
          var a = k / 4 * TAU;
          ctx.beginPath();
          ctx.moveTo(g.x + Math.cos(a) * rad * 0.88, g.y + Math.sin(a) * rad * 0.88);
          ctx.lineTo(g.x + Math.cos(a) * rad * 1.08, g.y + Math.sin(a) * rad * 1.08);
          ctx.stroke();
        }
      } else if (g.kind === 'thunder') {
        // 天雷落点：金色冲击环 + 地面的十字电痕
        ctx.setLineDash([]);
        ctx.globalAlpha = alpha * 0.85;
        ctx.lineWidth = Math.max(2, g.width * 1.5);
        ctx.strokeStyle = rgba('#FFF7E6', 1);
        ctx.beginPath(); ctx.arc(g.x, g.y, rad * 0.82, 0, TAU); ctx.stroke();
        ctx.globalAlpha = alpha * 0.55;
        ctx.lineWidth = 1.4;
        for (var q = 0; q < 8; q++) {
          var qa = q / 8 * TAU + (R.reducedMotion ? 0 : R.clock * 2);
          ctx.beginPath();
          ctx.moveTo(g.x + Math.cos(qa) * rad * 0.35, g.y + Math.sin(qa) * rad * 0.35);
          ctx.lineTo(g.x + Math.cos(qa) * rad * 0.92, g.y + Math.sin(qa) * rad * 0.92);
          ctx.stroke();
        }
      } else if (g.kind === 'heal') {
        // 巫医毒伤回复：向内收束的绿色细环
        ctx.setLineDash([]);
        ctx.globalAlpha = alpha * 0.7;
        ctx.lineWidth = Math.max(1, g.width * 0.7);
        ctx.beginPath(); ctx.arc(g.x, g.y, rad * 0.7, 0, TAU); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawChains(ctx) {
    if (!R.chains.length) return;
    for (var i = 0; i < R.chains.length; i++) {
      var c = R.chains[i];
      var pts = c.points;
      if (!pts || pts.length < 2) continue;
      var alpha = clamp(c.life / Math.max(0.0001, c.maxLife), 0, 1);
      var flick = 0.78 + 0.22 * Math.random();
      var isBolt = c.kind === 'verticalBolt';
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
      if (isBolt) {
        // 天雷落雷线：金色辉光 + 白芯 + 分叉 + 落点电弧
        var last = pts[pts.length - 1];
        var first = pts[0];
        ctx.globalAlpha = alpha * flick * 0.3;
        ctx.strokeStyle = rgba(c.color || R.pal.gold, 1);
        ctx.lineWidth = 16;
        ctx.stroke();
        ctx.globalAlpha = alpha * flick * 0.95;
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.globalAlpha = alpha * flick;
        ctx.strokeStyle = 'rgba(255,255,255,0.96)';
        ctx.lineWidth = 2;
        ctx.stroke();
        // 分叉（沿主线取 2 个点向外撇）
        ctx.globalAlpha = alpha * flick * 0.8;
        ctx.strokeStyle = rgba(c.color || R.pal.gold, 0.85);
        ctx.lineWidth = 1.6;
        for (var f = 0; f < 2; f++) {
          var idx = 2 + f * 2;
          if (!pts[idx]) continue;
          var bx = pts[idx].x, by = pts[idx].y;
          var sgn = f ? 1 : -1;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + sgn * 22, by + 26);
          ctx.lineTo(bx + sgn * 12, by + 46);
          ctx.stroke();
        }
        // 天空方向淡出（避免生硬的起点）
        var sg = ctx.createLinearGradient(0, first.y, 0, last.y);
        sg.addColorStop(0, rgba(c.color || R.pal.gold, 0));
        sg.addColorStop(0.3, rgba(c.color || R.pal.gold, 0.16));
        sg.addColorStop(1, rgba(c.color || R.pal.gold, 0));
        ctx.globalAlpha = alpha * 0.8;
        ctx.fillStyle = sg;
        ctx.fillRect(last.x - 14, first.y, 28, Math.max(1, last.y - first.y));
        // 落点椭圆电痕
        ctx.globalAlpha = alpha * flick * 0.9;
        ctx.fillStyle = rgba('#FFF7E6', 0.5);
        ctx.beginPath();
        ctx.ellipse(last.x, last.y, 30, 9, 0, 0, TAU);
        ctx.fill();
      } else {
        ctx.globalAlpha = alpha * flick * 0.25;
        ctx.strokeStyle = rgba(c.color, 1);
        ctx.lineWidth = 10;
        ctx.stroke();
        ctx.globalAlpha = alpha * flick * 0.9;
        ctx.lineWidth = 3.8;
        ctx.stroke();
        ctx.globalAlpha = alpha * flick;
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawWarps(ctx) {
    if (!R.warps.length) return;
    for (var i = 0; i < R.warps.length; i++) {
      var w = R.warps[i];
      var p = clamp(1 - w.life / Math.max(0.0001, w.maxLife), 0, 1);
      var alpha = clamp(1 - p, 0, 1);
      ctx.save();
      var col = w.color || R.pal.violet2;
      if (w.vertical) {
        var ex = w.x < WORLD / 2 ? 5 : WORLD - 5;
        var yy = clamp(w.y, 100, WORLD - 100);
        for (var k = 0; k < 5; k++) {
          var hh = 28 + rnd(hashStr(w.x + ':' + i), k) * 90;
          var y0 = yy - 110 + k * 52;
          ctx.globalAlpha = alpha * (0.2 + 0.12 * k);
          ctx.fillStyle = rgba(col, 1);
          ctx.fillRect(ex - 5, y0 - hh / 2, 10, hh);
        }
      } else if (w.vertical === false) {
        var ey = w.y < WORLD / 2 ? 5 : WORLD - 5;
        var xx = clamp(w.x, 100, WORLD - 100);
        for (var m = 0; m < 5; m++) {
          var ww = 28 + rnd(hashStr(w.y + ':' + i), m) * 90;
          var x0 = xx - 110 + m * 52;
          ctx.globalAlpha = alpha * (0.2 + 0.12 * m);
          ctx.fillStyle = rgba(col, 1);
          ctx.fillRect(x0 - ww / 2, ey - 5, ww, 10);
        }
      }
      // 中心闪光
      ctx.globalAlpha = alpha * 0.35;
      ctx.fillStyle = rgba(col, 1);
      ctx.beginPath();
      ctx.arc(clamp(w.x, 0, WORLD), clamp(w.y, 0, WORLD), 14 + 16 * p, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawFloats(ctx) {
    if (!R.floats.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < R.floats.length; i++) {
      var f = R.floats[i];
      var p = clamp(1 - f.life / Math.max(0.0001, f.maxLife), 0, 1);
      var alpha = f.life < 0.28 ? clamp(f.life / 0.28, 0, 1) : 1;
      ctx.globalAlpha = alpha;
      if (f.type === 'cast') {
        var fs = f.size;
        ctx.font = Math.round(fs) + 'px ' + FONT_ZH;
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(2.5, fs * 0.34);
        ctx.strokeStyle = 'rgba(8,6,14,0.92)';
        ctx.strokeText(f.text, f.x, f.y);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y);
      } else if (f.type === 'miss') {
        ctx.font = '600 ' + Math.round(f.size) + 'px ' + FONT_EN;
        ctx.lineWidth = Math.max(2, f.size * 0.22);
        ctx.strokeStyle = 'rgba(8,6,14,0.85)';
        ctx.strokeText(f.text, f.x, f.y);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y);
      } else if (f.type === 'debuff') {
        // 状态施加提示（虚弱/破甲等）：效果名小字，无数值
        var fsb = Math.round(f.size);
        ctx.font = '700 ' + fsb + 'px ' + FONT_ZH;
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(2, fsb * 0.3);
        ctx.strokeStyle = 'rgba(8,6,14,0.9)';
        ctx.strokeText(f.text, f.x, f.y);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y);
      } else {
        var pop = f.type === 'dmg' ? 0.72 + 0.45 * easeOutBack(clamp(p / 0.2, 0, 1)) : 1;
        var fsD = f.size * (p < 0.12 ? 1.12 : 1);
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.scale(pop, pop);
        ctx.font = Math.round(fsD) + 'px ' + FONT_EN;
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(2, fsD * 0.26);
        ctx.strokeStyle = 'rgba(10,9,16,0.92)';
        ctx.strokeText(f.text, 0, 0);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, 0, 0);
        if (f.type === 'heal') {
          ctx.fillStyle = rgba(R.pal.good, 0.35);
          ctx.fillText(f.text, 0, -1.5);
        }
        ctx.restore();
      }
    }
    ctx.restore();
  }

  function drawStamps(ctx) {
    if (!R.stamps.length) return;
    for (var i = 0; i < R.stamps.length; i++) {
      var s = R.stamps[i];
      var p = clamp(1 - s.life / Math.max(0.0001, s.maxLife), 0, 1);
      var pop = 0.4 + 0.6 * easeOutBack(clamp(p / 0.22, 0, 1));
      var alpha = s.life < 0.3 ? clamp(s.life / 0.3, 0, 1) : 1;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(clamp(s.x, 70, WORLD - 70), clamp(s.y, 60, WORLD - 60));
      ctx.rotate(-0.085);
      ctx.scale(pop, pop);
      // 硬阴影框
      ctx.fillStyle = 'rgba(8,6,14,0.5)';
      ctx.fillRect(-66, -20, 132, 48);
      ctx.fillStyle = rgba(s.color, 0.14);
      ctx.fillRect(-70, -24, 140, 48);
      ctx.strokeStyle = rgba(s.color, 0.92);
      ctx.lineWidth = 3;
      ctx.strokeRect(-70, -24, 140, 48);
      ctx.strokeStyle = 'rgba(10,9,16,0.6)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-64, -18, 128, 36);
      // 角标
      ctx.fillStyle = rgba(s.color, 0.95);
      ctx.fillRect(-70, -24, 12, 3);
      ctx.fillRect(-70, 21, 12, 3);
      ctx.fillRect(58, -24, 12, 3);
      ctx.fillRect(58, 21, 12, 3);
      // 文字
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '34px ' + FONT_EN;
      ctx.strokeStyle = 'rgba(10,9,16,0.9)';
      ctx.lineWidth = 6;
      ctx.lineJoin = 'round';
      ctx.strokeText(s.text || 'OUT', 0, 2);
      ctx.fillStyle = s.color;
      ctx.fillText(s.text || 'OUT', 0, 2);
      ctx.fillStyle = 'rgba(255,244,220,0.5)';
      ctx.font = '11px ' + FONT_ZH;
      ctx.fillText('出局', 0, 24);
      ctx.restore();
    }
  }

  /* ============================================================
   * 边界 / 屏幕覆盖层
   * ============================================================ */
  function drawBoundary(ctx, snapshot, storm) {
    if (SHAPE === 'circle') {
      drawCircleBoundary(ctx, snapshot, storm);
      return;
    }
    if (SHAPE === 'triangle' && TRI) {
      drawTriangleBoundary(ctx, snapshot, storm);
      return;
    }
    var S = R.view.size;
    if (S <= 4) return;
    var t = R.clock;
    var danger = clamp(storm, 0, 1);
    var pulse = 0.5 + 0.5 * Math.sin(t * (4 + danger * 5));
    var outer = mix(R.pal.cream, R.pal.danger, danger * 0.9);
    var inner = mix(R.pal.orange, R.pal.danger, danger);
    ctx.save();

    // 外辉光
    var glows = [[16, 0.05], [9, 0.08], [4.5, 0.14]];
    for (var i = 0; i < glows.length; i++) {
      ctx.strokeStyle = rgba(danger > 0.04 ? R.pal.danger : R.pal.orange, glows[i][1] * (0.7 + 0.6 * danger * pulse));
      ctx.lineWidth = glows[i][0];
      ctx.strokeRect(1, 1, S - 2, S - 2);
    }
    // 米白主线 3px
    ctx.strokeStyle = rgba(outer, 0.92);
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, S - 3, S - 3);
    // 橙色内线 1.5px
    ctx.strokeStyle = rgba(inner, 0.8);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(7, 7, S - 14, S - 14);

    // 四角角标
    var L = Math.max(26, Math.min(78, S * 0.075));
    var corners = [
      [0, 0, 1, 1], [S, 0, -1, 1], [0, S, 1, -1], [S, S, -1, -1]
    ];
    for (i = 0; i < corners.length; i++) {
      var cx = corners[i][0], cy = corners[i][1], sx = corners[i][2], sy = corners[i][3];
      ctx.beginPath();
      ctx.moveTo(cx + sx * L, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + sy * L);
      ctx.strokeStyle = rgba(danger > 0.04 ? R.pal.danger : R.pal.orange, 0.95);
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.strokeStyle = rgba(R.pal.cream, 0.98);
      ctx.lineWidth = 3;
      ctx.stroke();
      // 铆钉
      ctx.fillStyle = rgba(R.pal.cream, 0.6);
      ctx.beginPath();
      ctx.arc(cx + sx * 8, cy + sy * 8, 2.8, 0, TAU);
      ctx.fill();
    }

    // 边缘刻度
    var stepPx = S / 10;
    ctx.strokeStyle = rgba(R.pal.cream, 0.16);
    ctx.lineWidth = 1.5;
    for (i = 1; i < 10; i++) {
      var len = i === 5 ? 11 : 6;
      var q = i * stepPx;
      ctx.beginPath();
      ctx.moveTo(q, 1); ctx.lineTo(q, 1 + len);
      ctx.moveTo(q, S - 1); ctx.lineTo(q, S - 1 - len);
      ctx.moveTo(1, q); ctx.lineTo(1 + len, q);
      ctx.moveTo(S - 1, q); ctx.lineTo(S - 1 - len, q);
      ctx.stroke();
    }

    // 决战时红色脉冲内框
    if (danger > 0.03) {
      ctx.strokeStyle = rgba(R.pal.danger, danger * (0.25 + 0.45 * pulse));
      ctx.lineWidth = 5;
      ctx.strokeRect(4, 4, S - 8, S - 8);
      ctx.strokeStyle = rgba('#FFB347', danger * 0.35 * pulse);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(12, 12, S - 24, S - 24);
    }
    ctx.restore();
  }

  /* 三角地图边界（屏幕空间）：三条边辉光 + 米白主线 + 内缩强调线 + 三角角标 + 边长刻度 */
  function drawTriangleBoundary(ctx, snapshot, storm) {
    var S = R.view.size;
    if (S <= 4 || !TRI) return;
    var t = R.clock;
    var danger = clamp(storm, 0, 1);
    var pulse = 0.5 + 0.5 * Math.sin(t * (4 + danger * 5));
    var outer = mix(R.pal.cream, R.pal.danger, danger * 0.9);
    var accent = mix(MAP_THEME.accent, R.pal.danger, danger);
    var k = S / WORLD;
    var pts = triScreenPoints(S, 0);
    var innerPts = triScreenPoints(S, 10 * k);
    if (!pts || !innerPts) return;
    ctx.save();

    // 外辉光（三条边）
    var glows = [[16, 0.05], [9, 0.085], [4.5, 0.15]];
    for (var g = 0; g < glows.length; g++) {
      triPathAt(ctx, pts);
      ctx.strokeStyle = rgba(danger > 0.04 ? R.pal.danger : MAP_THEME.accent,
        glows[g][1] * (0.7 + 0.6 * danger * pulse));
      ctx.lineWidth = glows[g][0];
      ctx.stroke();
    }
    // 米白主线
    triPathAt(ctx, pts);
    ctx.strokeStyle = rgba(outer, 0.92);
    ctx.lineWidth = 3;
    ctx.stroke();
    // 内缩强调线
    triPathAt(ctx, innerPts);
    ctx.strokeStyle = rgba(accent, 0.8);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 三个顶点角标（沿两条边各伸出一段）
    var L = Math.max(26, Math.min(78, S * 0.075));
    for (var i = 0; i < 3; i++) {
      var v = pts[i];
      var a = pts[(i + 1) % 3], b = pts[(i + 2) % 3];
      var da = Math.atan2(a.y - v.y, a.x - v.x);
      var db = Math.atan2(b.y - v.y, b.x - v.x);
      ctx.beginPath();
      ctx.moveTo(v.x + Math.cos(da) * L, v.y + Math.sin(da) * L);
      ctx.lineTo(v.x, v.y);
      ctx.lineTo(v.x + Math.cos(db) * L, v.y + Math.sin(db) * L);
      ctx.strokeStyle = rgba(danger > 0.04 ? R.pal.danger : MAP_THEME.accent, 0.95);
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.strokeStyle = rgba(R.pal.cream, 0.98);
      ctx.lineWidth = 3;
      ctx.stroke();
      // 顶点铆钉
      var inx = (v.x * 2 + a.x + b.x) / 4 - v.x;
      var iny = (v.y * 2 + a.y + b.y) / 4 - v.y;
      var il = Math.sqrt(inx * inx + iny * iny) || 1;
      ctx.fillStyle = rgba(R.pal.cream, 0.6);
      ctx.beginPath();
      ctx.arc(v.x + inx / il * 8, v.y + iny / il * 8, 2.8, 0, TAU);
      ctx.fill();
    }

    // 每条边 10 等分刻度（朝内）
    var cxs = pts[0].x + pts[1].x + pts[2].x;
    var cys = pts[0].y + pts[1].y + pts[2].y;
    ctx.strokeStyle = rgba(R.pal.cream, 0.16);
    ctx.lineWidth = 1.5;
    for (var e = 0; e < 3; e++) {
      var p0 = pts[e], p1 = pts[(e + 1) % 3];
      for (var q = 1; q < 10; q++) {
        var tt = q / 10;
        var qx = p0.x + (p1.x - p0.x) * tt;
        var qy = p0.y + (p1.y - p0.y) * tt;
        var nx = cxs / 3 - qx, ny = cys / 3 - qy;
        var nl = Math.sqrt(nx * nx + ny * ny) || 1;
        nx /= nl; ny /= nl;
        var len = q === 5 ? 11 : 6;
        ctx.beginPath();
        ctx.moveTo(qx, qy);
        ctx.lineTo(qx + nx * len, qy + ny * len);
        ctx.stroke();
      }
    }

    // 决战脉冲红边
    if (danger > 0.03) {
      triPathAt(ctx, triScreenPoints(S, 4 * k));
      ctx.strokeStyle = rgba(R.pal.danger, danger * (0.25 + 0.45 * pulse));
      ctx.lineWidth = 5;
      ctx.stroke();
      triPathAt(ctx, triScreenPoints(S, 12 * k));
      ctx.strokeStyle = rgba('#FFB347', danger * 0.35 * pulse);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  /* 圆形地图边界（屏幕空间）：辉光环 + 米白主线 + 内圈 + 圆周刻度 */
  function drawCircleBoundary(ctx, snapshot, storm) {
    var v = R.view, S = v.size;
    if (S <= 4) return;
    var ox = v.offX, oy = v.offY;
    var cx = ox + S / 2, cy = oy + S / 2;
    var Rr = S / 2 - 2;
    var t = R.clock;
    var danger = clamp(storm, 0, 1);
    var pulse = 0.5 + 0.5 * Math.sin(t * (4 + danger * 5));
    var accent = mix(MAP_THEME.accent, R.pal.danger, danger);
    var outer = mix(R.pal.cream, R.pal.danger, danger * 0.9);
    ctx.save();

    // 外辉光
    var glows = [[18, 0.035], [10, 0.06], [5, 0.12]];
    for (var i = 0; i < glows.length; i++) {
      ctx.strokeStyle = rgba(danger > 0.04 ? R.pal.danger : MAP_THEME.accent, glows[i][1] * (0.7 + 0.6 * danger * pulse));
      ctx.lineWidth = glows[i][0];
      ctx.beginPath(); ctx.arc(cx, cy, Rr, 0, TAU); ctx.stroke();
    }
    // 米白主线 3px
    ctx.strokeStyle = rgba(outer, 0.92);
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, Rr, 0, TAU); ctx.stroke();
    // 地图强调色内线
    ctx.strokeStyle = rgba(accent, 0.8);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, Rr - 7, 0, TAU); ctx.stroke();

    // 圆周刻度：每 10° 一格，主刻度更长
    ctx.strokeStyle = rgba(R.pal.cream, 0.18);
    ctx.lineWidth = 1.5;
    for (var d = 0; d < 36; d++) {
      var a = d / 36 * TAU;
      var major = d % 9 === 0;
      var len = major ? 13 : 6;
      var r1 = Rr - 1, r2 = Rr - 1 - len;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
    }
    // 四个主刻度小方块
    for (var q = 0; q < 4; q++) {
      var aa = q / 4 * TAU - Math.PI / 2;
      var px = cx + Math.cos(aa) * (Rr - 18);
      var py = cy + Math.sin(aa) * (Rr - 18);
      ctx.fillStyle = rgba(R.pal.cream, 0.45);
      ctx.fillRect(px - 2, py - 2, 4, 4);
    }

    // 决战脉冲红环
    if (danger > 0.03) {
      ctx.strokeStyle = rgba(R.pal.danger, danger * (0.25 + 0.45 * pulse));
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(cx, cy, Rr - 4, 0, TAU); ctx.stroke();
      ctx.strokeStyle = rgba('#FFB347', danger * 0.35 * pulse);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, Rr - 12, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }

  function drawArenaOverlay(ctx, snapshot, storm) {
    var v = R.view, S = v.size, ox = v.offX, oy = v.offY;
    if (S <= 4) return;
    var t = R.clock;
    var cx = ox + S / 2, cy = oy + S / 2;
    ctx.save();

    // 圆形 / 三角场地外：更暗的底
    if (SHAPE === 'circle') {
      ctx.beginPath();
      ctx.rect(ox, oy, S, S);
      ctx.arc(cx, cy, S / 2 - 2, 0, TAU, true);
      ctx.fillStyle = 'rgba(3,2,7,0.5)';
      ctx.fill('evenodd');
    } else if (SHAPE === 'triangle' && TRI) {
      var tp = triScreenPoints(S, 0);
      if (tp) {
        ctx.beginPath();
        ctx.rect(ox, oy, S, S);
        ctx.moveTo(ox + tp[0].x, oy + tp[0].y);
        ctx.lineTo(ox + tp[1].x, oy + tp[1].y);
        ctx.lineTo(ox + tp[2].x, oy + tp[2].y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(3,2,7,0.5)';
        ctx.fill('evenodd');
      }
    }

    // 暗角
    var vg = ctx.createRadialGradient(cx, cy, S * 0.3, cx, cy, S * 0.76);
    vg.addColorStop(0, 'rgba(5,4,10,0)');
    vg.addColorStop(0.68, 'rgba(5,4,10,0.14)');
    vg.addColorStop(1, 'rgba(5,4,10,0.5)');
    ctx.fillStyle = vg;
    ctx.fillRect(ox, oy, S, S);

    // 扫描线
    if (R.scanPattern) {
      ctx.fillStyle = R.scanPattern;
      ctx.fillRect(ox, oy, S, S);
    }

    // 决胜时刻红色边缘
    if (storm > 0.01) {
      var pulse = 0.6 + 0.4 * Math.sin(t * 6);
      var sg = ctx.createRadialGradient(cx, cy, S * 0.3, cx, cy, S * 0.72);
      sg.addColorStop(0, 'rgba(255,79,109,0)');
      sg.addColorStop(1, 'rgba(255,79,109,' + (0.26 * storm * pulse).toFixed(3) + ')');
      ctx.fillStyle = sg;
      ctx.fillRect(ox, oy, S, S);
      ctx.strokeStyle = rgba(R.pal.danger, 0.18 + 0.3 * storm * pulse);
      ctx.lineWidth = 2;
      if (SHAPE === 'circle') {
        ctx.beginPath(); ctx.arc(cx, cy, S / 2 - 12, 0, TAU); ctx.stroke();
      } else if (SHAPE === 'triangle' && TRI) {
        var tps = triScreenPoints(S, 10 * (S / WORLD));
        if (tps) {
          ctx.beginPath();
          ctx.moveTo(ox + tps[0].x, oy + tps[0].y);
          ctx.lineTo(ox + tps[1].x, oy + tps[1].y);
          ctx.lineTo(ox + tps[2].x, oy + tps[2].y);
          ctx.closePath();
          ctx.stroke();
        }
      } else {
        ctx.strokeRect(ox + 10.5, oy + 10.5, S - 21, S - 21);
      }
    }

    // 天雷落雷：极短的屏幕闪（reduced motion 更弱；不叠加，避免多道雷同时洗白）
    if (R.flash > 0.004) {
      var fa = Math.min(0.13, R.flash * (R.reducedMotion ? 0.3 : 0.55));
      ctx.fillStyle = 'rgba(255,247,230,' + fa.toFixed(3) + ')';
      ctx.fillRect(ox, oy, S, S);
    }

    // 结束暗场 + 胜者聚光
    if (snapshot && snapshot.status === 'over') {
      ctx.fillStyle = 'rgba(6,4,11,0.55)';
      ctx.fillRect(ox, oy, S, S);
      var win = null, ents = snapshot.entities || [];
      for (var i = 0; i < ents.length; i++) {
        if (ents[i] && (ents[i].ballId === snapshot.winnerId || ents[i].id === snapshot.winnerId) && ents[i].alive) { win = ents[i]; break; }
      }
      if (win) {
        var wx = ox + num(win.x, WORLD / 2) / WORLD * S;
        var wy = oy + num(win.y, WORLD / 2) / WORLD * S;
        var wg = ctx.createRadialGradient(wx, wy, S * 0.015, wx, wy, S * 0.3);
        wg.addColorStop(0, rgba(win.color || R.pal.gold, 0.3));
        wg.addColorStop(1, rgba(win.color || R.pal.gold, 0));
        ctx.fillStyle = wg;
        ctx.fillRect(ox, oy, S, S);
      }
    }
    ctx.restore();
  }

  function drawDebug(ctx, snapshot, view) {
    var v = R.view;
    ctx.save();
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(124,255,158,0.85)';
    ctx.fillRect(4, 4, 250, 40);
    ctx.fillStyle = '#0A0910';
    ctx.fillText('FPS ' + Math.round(num(view.fps, 0)) + '  dt ' + (num(view.dt, 0) * 1000).toFixed(1) + 'ms', 8, 8);
    ctx.fillText('P ' + R.particles.length + '  F ' + R.floats.length + '  R ' + R.rings.length + '  C ' + R.chains.length, 8, 22);
    if (v.size > 0) {
      ctx.fillText('ARENA ' + Math.round(v.cssW) + 'x' + Math.round(v.cssH) + ' dpr ' + v.dpr.toFixed(2), 8, 36);
    }
    ctx.restore();
  }

  /* ============================================================
   * 导出
   * ============================================================ */
  root.BallRenderer = {
    init: init,
    resize: resize,
    pushEvents: pushEvents,
    render: render,
    reset: reset,
    setReducedMotion: setReducedMotion,
    /* QA 用调试统计（下划线内部接口，不属于契约） */
    _stats: function () {
      var trails = 0;
      for (var k in R.trails) trails += R.trails[k].list.length;
      return {
        particles: R.particles.length,
        floats: R.floats.length,
        rings: R.rings.length,
        chains: R.chains.length,
        stamps: R.stamps.length,
        bolts: R.bolts.length,
        warns: R.warns.length,
        bees: (R.snapshot && R.snapshot.bees) ? R.snapshot.bees.length : 0,
        obstacles: (R.snapshot && R.snapshot.obstacles) ? R.snapshot.obstacles.length : 0,
        mines: (function () {
          var hz = (R.snapshot && R.snapshot.hazards) || [], n = 0;
          for (var i = 0; i < hz.length; i++) if (hz[i] && hz[i].kind === 'mine') n++;
          return n;
        })(),
        trails: trails,
        shake: Math.round(R.shake * 100) / 100,
        clock: Math.round(R.clock * 100) / 100,
        scale: Math.round(R.view.scale * 1000) / 1000,
        cssW: R.view.cssW, cssH: R.view.cssH, dpr: R.view.dpr,
        reducedMotion: R.reducedMotion,
        fontsReady: R.fontsReady,
        canvasW: R.canvas ? R.canvas.width : 0,
        canvasH: R.canvas ? R.canvas.height : 0
      };
    }
  };
})(typeof self !== 'undefined' ? self : this);
