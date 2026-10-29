/* ============================================================
 * 斗球场 BALL PIT — 共享像素表情精灵（v0.5 像素五官重制）
 * window.BallFaces（UMD：Node 里 module.exports 可用）
 *
 * 只画「五官/表情层」：32×32 像素网格、最近邻放大、透明背景；
 * 球体本身的渐变/描边/配色仍由调用方绘制（renderer / UI 共用同一套）。
 *
 * v0.5 规则：
 *  - 硬像素：全部 fillRect 整数像素，无渐变/无抗锯齿/无半透明叠色。
 *  - 有限色盘：每个 look 只用 5 色（ink / sclera / pupil / accent / mouth），
 *    所有表情、施法特效都在这 5 色内完成。
 *  - 10 个 look 各有独立眼型 + 眉 + 嘴 + 施法签名（火焰瞳、准星、护目镜、
 *    冰晶、闪电、竖瞳毒泡、空洞、螺旋黑洞、獠牙、复眼）。
 *  - 每状态 2–4 帧：idle 4 帧（眨眼/视线/呼吸），cast 4 帧（技能性格），
 *    victory 3 帧（得意/闭眼笑），dead 3 帧（空洞/X 眼），其余 2 帧。
 *
 * 公共接口（V0.3-CONTRACT §六，v0.5 保持不变）：
 *   BallFaces.states                       // ['calm','idle','low','cast','victory','dead','hurt']
 *   BallFaces.frameCount(ballId, state)    // 帧数
 *   BallFaces.frameDuration(ballId, state) // 每帧毫秒
 *   BallFaces.draw(ctx, ballId, state, frame, x, y, size, opts)
 *   BallFaces.canvas(ballId, state, frame) // 缓存 offscreen canvas（Node 下为 null）
 *   BallFaces.dataURL(ballId, state, frame)
 * 便捷扩展（非契约，UI/renderer 可用）：
 *   BallFaces.faceRatio      // 建议绘制尺寸 = 球直径 × faceRatio
 *   BallFaces.ballIds, BallFaces.grid
 *   BallFaces.colors(ballId) // 该 look 的像素色板
 *   BallFaces.prewarm(ids, states) / clearCache()
 *   BallFaces.drawBee(ctx, x, y, size, frenzy, frame, opts)
 *
 * state 优先级（战斗）：dead > victory > low > cast > hurt > calm；大厅只用 idle。
 * 尺寸：draw 的 size 是「表情区域边长」（当前上下文单位，一般传 球直径×faceRatio）。
 * 传 opts.pixelScale（每 context 单位多少设备像素）时，接近整数倍会自动吸附，
 * 保证像素锐利；不传则按最近邻拉伸（imageSmoothingEnabled=false）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(typeof globalThis !== 'undefined' ? globalThis : root);
  } else {
    root.BallFaces = factory(root);
  }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var GRID = 32;
  var STATES = ['calm', 'idle', 'low', 'cast', 'victory', 'dead', 'hurt'];
  var BALL_IDS = ['B0001', 'B0002', 'B0003', 'B0004', 'B0005', 'B0006', 'B0007', 'B0008', 'B0009', 'B0010'];
  var LOOK_BY_ID = {
    B0001: 'meteor', B0002: 'trapper', B0003: 'iron', B0004: 'frost', B0005: 'volt',
    B0006: 'venom', B0007: 'ghost', B0008: 'grav', B0009: 'thorn', B0010: 'swarm'
  };
  var ALIAS = {
    meteor: 'meteor', trapper: 'trapper', iron: 'iron', frost: 'frost', volt: 'volt',
    venom: 'venom', ghost: 'ghost', phantom: 'ghost', grav: 'grav', graviton: 'grav',
    thorn: 'thorn', swarm: 'swarm'
  };

  /* ============================================================
   * 5 色有限色盘
   *   ink    最深：描边 / 眼窝 / 阴影
   *   sclera 最亮：眼白 / 高光 / 白热核心
   *   pupil  主色：虹膜 / 金属底板
   *   accent 强调：发光 / 能量 / 特效
   *   mouth  暗部：口腔 / 深色结构
   * ============================================================ */
  var PAL = {
    meteor: { ink: '#190A04', sclera: '#FFE9B8', pupil: '#E23A0C', accent: '#FFB020', mouth: '#4A1406' },
    trapper: { ink: '#140A20', sclera: '#EFE2FF', pupil: '#7C3BFF', accent: '#E6B8FF', mouth: '#341A55' },
    iron: { ink: '#0B1118', sclera: '#DCEBF7', pupil: '#3E586B', accent: '#54E6FF', mouth: '#1B2833' },
    frost: { ink: '#061A21', sclera: '#F2FDFF', pupil: '#2D8FA8', accent: '#9FF4FF', mouth: '#0E3A46' },
    volt: { ink: '#1A1504', sclera: '#FFF8D6', pupil: '#8A6A00', accent: '#FFD642', mouth: '#4A3A08' },
    venom: { ink: '#05150B', sclera: '#E8FFEF', pupil: '#1E7A45', accent: '#7CFF9E', mouth: '#0C3A20' },
    ghost: { ink: '#0B0820', sclera: '#FFFFFF', pupil: '#C9C4FF', accent: '#8A84D8', mouth: '#1D1840' },
    grav: { ink: '#170512', sclera: '#FFE6F6', pupil: '#8A2A6E', accent: '#FF5CD0', mouth: '#3E0A28' },
    thorn: { ink: '#18040A', sclera: '#FFE4E9', pupil: '#A31028', accent: '#FF4F6D', mouth: '#44060F' },
    swarm: { ink: '#101604', sclera: '#F6FFD9', pupil: '#5A7A0A', accent: '#C6FF3D', mouth: '#2A3406' }
  };
  var PALOBJ = {};
  (function () {
    for (var k in PAL) {
      var c = PAL[k];
      PALOBJ[k] = { i: c.ink, s: c.sclera, p: c.pupil, a: c.accent, m: c.mouth };
    }
  })();

  /* ---------------- 逐 look 特征配置 ---------------- */
  var CFG = {
    meteor: { base: 'round', iris: 'flame', irisY: 1, brow: 'angry', mouth: 'grin', extra: 'ember', castMouth: 'flame', victory: 'smug' },
    trapper: { base: 'round', iris: 'crosshair', irisY: 1, brow: 'flat', mouth: 'smirk', extra: 'reticle', castMouth: 'grit', victory: 'smug' },
    iron: { base: 'visor', iris: null, irisY: 0, brow: 'heavy', mouth: 'grill', extra: 'rivet', castMouth: 'grill', victory: 'visor' },
    frost: { base: 'diamond', iris: 'crystal', irisY: 1, brow: 'calm', mouth: 'puff', extra: 'snow', castMouth: 'puff', victory: 'closed' },
    volt: { base: 'almond', iris: 'bolt', irisY: 1, brow: 'wild', mouth: 'zigzag', extra: 'spark', castMouth: 'o', victory: 'closed' },
    venom: { base: 'slit', iris: 'slit', irisY: 2, brow: 'lazy', mouth: 'smug', extra: 'bubble', castMouth: 'o', victory: 'smug' },
    ghost: { base: 'socket', iris: null, irisY: 0, brow: 'none', mouth: 'wave', extra: 'wisp', castMouth: 'void', victory: 'closed' },
    grav: { base: 'socket', iris: null, irisY: 0, brow: 'heavy', mouth: 'flat', extra: 'orbit', castMouth: 'grit', victory: 'smug' },
    thorn: { base: 'almond', iris: 'fang', irisY: 1, brow: 'angry', mouth: 'fangs', extra: 'spikes', castMouth: 'roar', victory: 'smug' },
    swarm: { base: 'compound', iris: null, irisY: 0, brow: 'none', mouth: 'mandible', extra: 'antennae', castMouth: 'mandible', victory: 'closed' }
  };

  /* ---------------- 帧数与每帧毫秒 ---------------- */
  var FRAMES = {
    calm: 2, idle: 4, low: 2, cast: 4, victory: 3, dead: 3, hurt: 2
  };
  var DURATION = {
    calm: 1400, idle: 280, low: 380, cast: 120, victory: 340, dead: 850, hurt: 80
  };

  /* ---------------- 布局常量（32×32） ---------------- */
  var EYE_L = 6;      // 左眼框左上 x（框宽 8，右眼框 18..25，关于 15.5 对称）
  var EYE_R = 18;
  var EYE_Y = 11;     // 眼框顶部 y（框高 8）
  var EYE_W = 8;
  var MOUTH_X = 16;   // 嘴中心列
  var MOUTH_Y = 24;   // 嘴上基准行

  /* ---------------- 小工具 ---------------- */
  function clamp(n, a, b) { return n < a ? a : (n > b ? b : n); }
  function keyOf(ballId) {
    if (ballId == null) return 'meteor';
    var s = String(ballId);
    if (LOOK_BY_ID[s]) return LOOK_BY_ID[s];
    if (CFG[s]) return s;
    if (ALIAS[s]) return ALIAS[s];
    return 'meteor';
  }

  /* ---------------- 像素画笔 ---------------- */
  function makeP(g) {
    var P = {
      g: g,
      rect: function (x, y, w, h, col) {
        if (w <= 0 || h <= 0) return;
        g.fillStyle = col;
        g.fillRect(x | 0, y | 0, w | 0, h | 0);
      },
      px: function (x, y, col) {
        g.fillStyle = col;
        g.fillRect(x | 0, y | 0, 1, 1);
      },
      hline: function (x0, x1, y, col) {
        if (x1 < x0) { var t = x0; x0 = x1; x1 = t; }
        P.rect(x0, y, x1 - x0 + 1, 1, col);
      },
      vline: function (x, y0, y1, col) {
        if (y1 < y0) { var t = y0; y0 = y1; y1 = t; }
        P.rect(x, y0, 1, y1 - y0 + 1, col);
      },
      // ASCII 像素图：i=ink s=sclera p=pupil a=accent m=mouth .=透明
      stamp: function (rows, x, y, pal) {
        for (var r = 0; r < rows.length; r++) {
          var line = rows[r];
          for (var i = 0; i < line.length; i++) {
            var ch = line.charAt(i);
            if (ch === '.') continue;
            var col = pal[ch];
            if (col) P.px(x + i, y + r, col);
          }
        }
      }
    };
    return P;
  }

  /* ============================================================
   * 眼睛基准形状（只含描边 + 眼白；虹膜单独叠画）
   * ============================================================ */
  var EYE_BASE = {
    round: [
      '..iiii..',
      '.issssi.',
      'issssssi',
      'issssssi',
      'issssssi',
      'issssssi',
      '.issssi.',
      '..iiii..'
    ],
    diamond: [
      '...ii...',
      '..issi..',
      '.issssi.',
      'issssssi',
      'issssssi',
      '.issssi.',
      '..issi..',
      '...ii...'
    ],
    almond: [
      '..iiii..',
      '.issssi.',
      'issssssi',
      'issssssi',
      'issssssi',
      '.issssi.',
      '..issi..',
      '...ii...'
    ],
    slit: [
      '..iiii..',
      '.ippppi.',
      '.issssi.',
      'issssssi',
      'issssssi',
      '.issssi.',
      '..iiii..',
      '........'
    ],
    socket: [
      '..iiii..',
      '.iiiiii.',
      'iiiiiiii',
      'iiiiiiii',
      'iiiiiiii',
      'iiiiiiii',
      '.iiiiii.',
      '..iiii..'
    ]
  };
  // 眼白遮罩：虹膜只能落在眼白像素上，避免盖住描边
  var EYE_MASK = {};
  (function () {
    for (var name in EYE_BASE) {
      var rows = EYE_BASE[name], mask = [];
      for (var y = 0; y < rows.length; y++) {
        var line = rows[y], row = [];
        for (var x = 0; x < line.length; x++) row.push(line.charAt(x) === 's');
        mask.push(row);
      }
      EYE_MASK[name] = mask;
    }
  })();

  /* ---------------- 虹膜像素图（4 列，由 irisY 决定起始行） ----------------
   * 眼白都是浅色，所以虹膜/纹样统一用深色（pupil）保证对比；
   * accent 只做小面积发光点，避免在浅色眼白上糊成一片。
   * ------------------------------------------------------------ */
  var IRIS = {
    flame: [
      '.pp.',
      '.pp.',
      'pssp',
      'pssp',
      'paap',
      '.aa.'
    ],
    crosshair: [
      '.pp.',
      '.pp.',
      'paap',
      '.pp.',
      '.pp.',
      '....'
    ],
    crystal: [
      '.pp.',
      'pssp',
      'pssp',
      'pssp',
      '.pp.',
      '....'
    ],
    bolt: [
      '.pp.',
      'pp..',
      '.ppp',
      '..pp',
      '.pp.',
      '.pp.'
    ],
    slit: [
      '.pp.',
      '.pp.',
      '.pp.',
      '.pp.'
    ],
    fang: [
      '.pp.',
      '.pp.',
      '.pp.',
      '.pp.',
      '.aa.'
    ]
  };
  var IRIS_CAST = {
    flame: [
      '.pp.',
      'pssp',
      'pssp',
      'pssp',
      '.aa.',
      '.aa.'
    ],
    crystal: [
      'pssp',
      'ssss',
      'ssss',
      'ssss',
      'pssp',
      '....'
    ],
    bolt: [
      '.aa.',
      '.aa.',
      'ss..',
      '.sss',
      '..ss',
      '.aa.'
    ],
    slit: [
      '.pp.',
      'assa',
      'assa',
      '.pp.'
    ],
    fang: [
      '.pp.',
      'pssp',
      'pssp',
      '.pp.',
      '.aa.'
    ]
  };

  /* ============================================================
   * 表情状态的小参数
   * ============================================================ */
  function animOf(state, frame) {
    var a = { gaze: 0, oy: 0, blink: false };
    if (state === 'calm') {
      a.gaze = (frame & 1) ? 1 : 0;
    } else if (state === 'idle') {
      if (frame === 1) { a.gaze = -1; a.oy = -1; }
      else if (frame === 2) { a.blink = true; }
      else if (frame === 3) { a.gaze = 1; a.oy = 1; }
    } else if (state === 'low') {
      // 低血发抖：第二帧整张脸轻微下沉 + 视线涣散
      if (frame === 1) { a.oy = 1; a.gaze = -1; }
    }
    return a;
  }

  /* ---------------- 虹膜 / 眼白绘制 ---------------- */
  function drawIris(P, key, x0, y0, gaze, cast) {
    var cfg = CFG[key];
    if (!cfg.iris) return;
    var map = (cast && IRIS_CAST[cfg.iris]) ? IRIS_CAST[cfg.iris] : IRIS[cfg.iris];
    if (!map) return;
    var mask = EYE_MASK[cfg.base];
    var pal = PALOBJ[key];
    var iy = cfg.irisY || 1;
    for (var r = 0; r < map.length; r++) {
      var row = map[r], mi = iy + r;
      if (mi < 0 || mi >= mask.length) break;
      var mrow = mask[mi];
      for (var i = 0; i < row.length; i++) {
        var ch = row.charAt(i);
        if (ch === '.') continue;
        var col = pal[ch];
        if (!col) continue;
        var mx = 2 + gaze + i;
        if (mx < 0 || mx >= EYE_W || !mrow[mx]) continue;
        P.px(x0 + mx, y0 + mi, col);
      }
    }
  }

  function stampBaseEye(P, key, x0, y0) {
    P.stamp(EYE_BASE[CFG[key].base] || EYE_BASE.round, x0, y0, PALOBJ[key]);
  }

  function drawBlink(P, key, x0, y0) {
    var c = PAL[key];
    if (key === 'iron') {
      P.hline(x0 + 1, x0 + 6, y0 + 4, c.ink);
      P.px(x0 + 2, y0 + 5, c.accent); P.px(x0 + 5, y0 + 5, c.accent);
      return;
    }
    P.hline(x0 + 1, x0 + 6, y0 + 3, c.ink);
    P.hline(x0 + 1, x0 + 6, y0 + 4, c.ink);
    P.px(x0 + 1, y0 + 2, c.ink);
    P.px(x0 + 6, y0 + 2, c.ink);
    P.px(x0 + 3, y0 + 6, c.accent);
    P.px(x0 + 4, y0 + 6, c.accent);
  }

  /* ---------------- 空洞眼（幽灵） ---------------- */
  function drawHollowEye(P, key, x0, y0, state, frame) {
    var c = PAL[key];
    stampBaseEye(P, key, x0, y0);   // socket 全 ink
    if (state === 'dead') {
      // 熄灭：眼窝深处只剩几点冷灰
      P.px(x0 + 2, y0 + 4, c.mouth);
      P.px(x0 + 5, y0 + 4, c.mouth);
      P.px(x0 + 3, y0 + 2, c.mouth);
      P.px(x0 + 4, y0 + 6, c.mouth);
      if (frame === 1) P.px(x0 + 2, y0 + 4, c.accent);
      if (frame === 2) P.px(x0 + 5, y0 + 6, c.accent);
      return;
    }
    if (state === 'blink') {
      // 眨眼：幽光眯成一条线
      P.hline(x0 + 2, x0 + 5, y0 + 4, c.accent);
      P.px(x0 + 1, y0 + 4, c.pupil);
      P.px(x0 + 6, y0 + 4, c.pupil);
      return;
    }
    if (state === 'cast') {
      // 施法：整只眼窝被鬼火点亮（4 帧由暗到亮再回落）
      var bright = frame === 1 || frame === 2;
      P.hline(x0 + 2, x0 + 5, y0 + 2, bright ? c.sclera : c.accent);
      P.hline(x0 + 2, x0 + 5, y0 + 5, bright ? c.sclera : c.accent);
      P.px(x0 + 1, y0 + 3, bright ? c.sclera : c.pupil);
      P.px(x0 + 1, y0 + 4, bright ? c.sclera : c.pupil);
      P.px(x0 + 6, y0 + 3, bright ? c.sclera : c.pupil);
      P.px(x0 + 6, y0 + 4, bright ? c.sclera : c.accent);
      P.rect(x0 + 3, y0 + 3, 2, 2, bright ? c.sclera : c.accent);
      if (frame === 2) {
        P.px(x0 + 2, y0 + 1, c.sclera);
        P.px(x0 + 5, y0 + 1, c.sclera);
        P.px(x0 + 3, y0 + 7, c.accent);
      }
      if (frame === 3) {
        P.px(x0 + 2, y0 + 1, c.accent);
        P.px(x0 + 5, y0 + 6, c.pupil);
      }
      return;
    }
    if (state === 'hurt') {
      // 受击：眼窝炸亮（第一帧先暗一下）
      if (frame === 0) {
        P.hline(x0 + 2, x0 + 5, y0 + 2, c.accent);
        P.px(x0 + 3, y0 + 3, c.accent);
        P.px(x0 + 4, y0 + 4, c.pupil);
        P.px(x0 + 1, y0 + 4, c.pupil);
        P.px(x0 + 6, y0 + 4, c.pupil);
        return;
      }
      P.hline(x0 + 2, x0 + 5, y0 + 2, c.sclera);
      P.px(x0 + 1, y0 + 3, c.sclera); P.px(x0 + 6, y0 + 3, c.sclera);
      P.rect(x0 + 3, y0 + 3, 2, 2, c.sclera);
      P.px(x0 + 2, y0 + 5, c.accent); P.px(x0 + 5, y0 + 5, c.accent);
      return;
    }
    if (state === 'low') {
      // 低血：幽光转暗、眼窝塌陷
      P.hline(x0 + 2, x0 + 5, y0 + 2, c.mouth);
      P.px(x0 + 1, y0 + 3, c.mouth); P.px(x0 + 6, y0 + 4, c.mouth);
      P.px(x0 + 3, y0 + 4, c.accent);
      P.px(x0 + 4, y0 + 4, c.mouth);
      return;
    }
    // calm / idle：一圈幽光 + 灵魂核心
    var pulse = (state === 'idle' && frame % 2) || (state === 'calm' && frame === 1) ? 1 : 0;
    P.hline(x0 + 2, x0 + 5, y0 + 1, c.pupil);
    P.px(x0 + 1, y0 + 3, c.pupil); P.px(x0 + 1, y0 + 4, c.accent);
    P.px(x0 + 6, y0 + 3, c.accent); P.px(x0 + 6, y0 + 4, c.pupil);
    P.hline(x0 + 2, x0 + 5, y0 + 6, c.accent);
    P.rect(x0 + 3, y0 + 3, 2, 2, c.accent);
    P.px(x0 + 3, y0 + 3, c.sclera);
    P.px(x0 + 2, y0 + 2, c.pupil);
    P.px(x0 + 5, y0 + 5, pulse ? c.sclera : c.pupil);
    if (pulse) P.px(x0 + 5, y0 + 2, c.accent);
  }

  /* ---------------- 螺旋眼（黑洞） ---------------- */
  var SPIRAL_MAP = [
    '.aaaa.',
    'a....a',
    '..aa.a',
    '.a..aa',
    'a....a',
    '.aaaa.'
  ];
  function rot6(x, y, turns) {
    for (var t = 0; t < (turns & 3); t++) {
      var nx = y;
      y = 5 - x;
      x = nx;
    }
    return [x, y];
  }
  function drawSpiral(P, key, x0, y0, turns, tone) {
    var c = PAL[key];
    var col = tone === 2 ? c.accent : (tone === 1 ? c.sclera : c.pupil);
    for (var y = 0; y < 6; y++) {
      var row = SPIRAL_MAP[y];
      for (var x = 0; x < 6; x++) {
        if (row.charAt(x) !== 'a') continue;
        var p = rot6(x, y, turns);
        P.px(x0 + 1 + p[0], y0 + 1 + p[1], col);
      }
    }
    // 事件视界：核心留黑，只放一点吸积高光
    P.px(x0 + 3, y0 + 3, c.ink);
    if (tone === 2) {
      P.px(x0 + 2, y0 + 2, c.sclera);
      P.px(x0 + 5, y0 + 5, c.pupil);
    } else if (tone === 1) {
      P.px(x0 + 2, y0 + 2, c.accent);
    } else {
      P.px(x0 + 3, y0 + 2, c.mouth);
    }
  }
  function drawGravEye(P, key, x0, y0, state, frame) {
    var c = PAL[key];
    stampBaseEye(P, key, x0, y0);   // socket 全 ink
    if (state === 'dead') {
      // 坍缩成一点：暗环随时间慢慢熄灭
      P.hline(x0 + 2, x0 + 5, y0 + 3, c.mouth);
      P.hline(x0 + 2, x0 + 5, y0 + 4, c.mouth);
      P.px(x0 + 1, y0 + 4, c.mouth); P.px(x0 + 6, y0 + 4, c.mouth);
      P.px(x0 + 3, y0 + 3, c.pupil);
      if (frame === 1) P.px(x0 + 3, y0 + 3, c.accent);
      if (frame === 2) { P.px(x0 + 2, y0 + 5, c.accent); P.px(x0 + 5, y0 + 2, c.mouth); }
      return;
    }
    if (state === 'blink') {
      // 眨眼：旋涡压成一条线
      P.hline(x0 + 2, x0 + 5, y0 + 4, c.accent);
      P.px(x0 + 1, y0 + 4, c.pupil);
      P.px(x0 + 6, y0 + 4, c.pupil);
      P.px(x0 + 3, y0 + 4, c.sclera);
      return;
    }
    if (state === 'hurt') {
      // 旋涡被打散（散开 → 重新坍缩）
      if (frame === 0) {
        P.px(x0 + 2, y0 + 2, c.accent); P.px(x0 + 5, y0 + 2, c.pupil);
        P.px(x0 + 2, y0 + 5, c.pupil); P.px(x0 + 5, y0 + 5, c.accent);
        P.px(x0 + 1, y0 + 4, c.accent); P.px(x0 + 6, y0 + 4, c.accent);
      } else {
        drawSpiral(P, key, x0, y0, 0, 0);
        P.px(x0 + 3, y0 + 3, c.accent);
        P.px(x0 + 2, y0 + 5, c.sclera);
      }
      return;
    }
    if (state === 'victory') {
      // 得意：旋涡慢慢转，周围抛星
      drawSpiral(P, key, x0, y0, frame, 2);
      P.px(x0 + 2, y0 + 1, c.sclera);
      return;
    }
    if (state === 'cast') {
      drawSpiral(P, key, x0, y0, frame, 2);
      P.px(x0 + 4, y0 + 4, c.pupil);
      if (frame === 1) { P.px(x0 + 2, y0 + 2, c.sclera); }
      if (frame === 2) { P.rect(x0 + 3, y0 + 3, 2, 2, c.sclera); }
      return;
    }
    if (state === 'low') {
      drawSpiral(P, key, x0, y0, 0, 0);
      P.hline(x0 + 1, x0 + 6, y0 + 2, c.ink);
      P.px(x0 + 3, y0 + 4, c.mouth);
      return;
    }
    // calm / idle：旋涡转动
    drawSpiral(P, key, x0, y0, frame, 1);
  }

  /* ---------------- 复眼（蜂群） ---------------- */
  var COMP_FACETS = [];
  (function () {
    for (var y = 1; y <= 6; y++) {
      for (var x = 1; x <= 6; x++) {
        if ((x + y) % 2 === 0) COMP_FACETS.push([x, y]);
      }
    }
  })();
  function drawCompoundCluster(P, key, x0, y0, mode, frame) {
    var c = PAL[key];
    // 深色眼座当复眼底，再用交错晶格铺满
    P.stamp(EYE_BASE.socket, x0, y0, PALOBJ[key]);
    var dim = mode === 'low';
    var dead = mode === 'dead';
    for (var i = 0; i < COMP_FACETS.length; i++) {
      var fx = COMP_FACETS[i][0], fy = COMP_FACETS[i][1];
      if (mode === 'cast') {
        var p = rot6(fx - 1, fy - 1, frame);
        fx = p[0] + 1;
        fy = p[1] + 1;
      } else if (mode === 'hurt') {
        fx += frame ? -1 : 0;
        fy += i % 2 ? 1 : 0;
      } else if (dim && frame === 1) {
        fx += 1;
        fy += i % 2 ? 1 : 0;
      }
      if (fx < 1 || fx > 6 || fy < 1 || fy > 6) continue;
      var col;
      if (dim) col = i % 3 === 0 ? c.mouth : c.pupil;
      else if (dead) col = i % 3 === 0 ? c.pupil : c.mouth;
      else if (mode === 'idle' && frame === 2) col = c.mouth;
      else if (mode === 'calm' && frame === 1) col = i % 3 === 0 ? c.pupil : c.accent;
      else col = i % 3 === 0 ? c.accent : c.pupil;
      P.px(x0 + fx, y0 + fy, col);
    }
    if (mode === 'idle' && frame === 2) {
      // 复眼眨眼：晶格全部熄灭，只留一条发光眼缝
      P.hline(x0 + 2, x0 + 5, y0 + 4, c.accent);
    }
    if (!dead && !dim && !(mode === 'idle' && frame === 2)) {
      P.px(x0 + 2, y0 + 2, c.sclera);
      P.px(x0 + 5, y0 + 2, c.sclera);
      if (mode === 'cast' && frame >= 1) P.px(x0 + 2, y0 + 5, c.sclera);
      if (mode === 'idle' && frame === 3) P.px(x0 + 6, y0 + 6, c.sclera);
    }
    if (mode === 'cast') {
      P.px(x0 - 1, y0 + 2, c.accent);
      P.px(x0 + 8, y0 + 5, c.accent);
    }
    if (mode === 'hurt') {
      P.px(x0 - 1, y0 + 1, c.accent);
      P.px(x0 + 8, y0 + 1, c.accent);
    }
  }
  function drawCompoundVictory(P, key, x0, y0, frame) {
    var c = PAL[key];
    // 复眼弯成笑眼：晶格排成一道上弧
    var arc = [[0, 4], [1, 3], [2, 2], [3, 2], [4, 2], [5, 2], [6, 3], [7, 4]];
    for (var i = 0; i < arc.length; i++) {
      P.px(x0 + arc[i][0], y0 + arc[i][1], i % 2 ? c.accent : c.pupil);
    }
    P.px(x0 + 1, y0 + 5, c.accent);
    P.px(x0 + 6, y0 + 5, c.accent);
    if (frame === 1) { P.px(x0, y0 + 1, c.sclera); P.px(x0 + 7, y0 + 1, c.sclera); }
    if (frame === 2) {
      P.px(x0 - 1, y0 + 2, c.accent);
      P.px(x0 + 8, y0 + 5, c.accent);
      P.px(x0 + 3, y0 + 7, c.sclera);
      P.px(x0 + 4, y0 + 7, c.accent);
    }
  }
  function drawCompoundDead(P, key, x0, y0, frame) {
    var c = PAL[key];
    // 死掉的复眼：暗眼窝 + 几颗熄灭的晶格
    P.stamp(EYE_BASE.socket, x0, y0, PALOBJ[key]);
    var scatter = [[2, 2], [5, 3], [3, 5], [6, 6], [1, 4]];
    for (var i = 0; i < scatter.length; i++) {
      if ((i + frame) % 3 === 0) continue;
      var fx = scatter[i][0] + (frame === 2 ? 1 : 0);
      var fy = scatter[i][1] + (frame === 1 ? 1 : 0);
      P.px(x0 + fx, y0 + fy, i % 2 ? c.pupil : c.mouth);
    }
    if (frame === 1) P.px(x0 + 5, y0 + 1, c.accent);
  }
  function drawCompound(P, key, state, frame) {
    var xs = [EYE_L, EYE_R];
    for (var i = 0; i < 2; i++) {
      var x0 = xs[i];
      if (state === 'dead') drawCompoundDead(P, key, x0, EYE_Y, frame);
      else if (state === 'victory') drawCompoundVictory(P, key, x0, EYE_Y - (frame === 1 ? 1 : 0), frame);
      else if (state === 'hurt') drawCompoundCluster(P, key, x0, EYE_Y, 'hurt', frame);
      else if (state === 'cast') drawCompoundCluster(P, key, x0, EYE_Y, 'cast', frame);
      else drawCompoundCluster(P, key, x0, EYE_Y, state, frame);
    }
  }

  /* ---------------- 护目镜（装甲） ---------------- */
  var VIS_X0 = 4, VIS_X1 = 27, VIS_Y0 = 11, VIS_Y1 = 17;
  function visorHousing(P, c) {
    // 六边形硬边镜体：上下各收一截，像焊在脸上的装甲
    P.hline(VIS_X0 + 2, VIS_X1 - 2, VIS_Y0, c.ink);
    P.rect(VIS_X0, VIS_Y0 + 1, VIS_X1 - VIS_X0 + 1, VIS_Y1 - VIS_Y0 - 1, c.ink);
    P.hline(VIS_X0 + 2, VIS_X1 - 2, VIS_Y1, c.ink);
    // 钢制底板（内缩 1px 留出墨线）
    P.rect(VIS_X0 + 1, VIS_Y0 + 1, VIS_X1 - VIS_X0 - 1, VIS_Y1 - VIS_Y0 - 1, c.pupil);
    // 上下铆钉
    P.px(VIS_X0 + 2, VIS_Y0 + 2, c.sclera);
    P.px(VIS_X1 - 2, VIS_Y0 + 2, c.sclera);
    P.px(VIS_X0 + 2, VIS_Y1 - 1, c.sclera);
    P.px(VIS_X1 - 2, VIS_Y1 - 1, c.sclera);
    // 侧边液压螺栓
    P.px(VIS_X0 + 1, VIS_Y0 + 3, c.accent);
    P.px(VIS_X1 - 1, VIS_Y0 + 3, c.accent);
  }
  function drawVisor(P, key, state, frame) {
    var c = PAL[key];
    var x;
    if (state === 'victory') {
      // 弯成笑弧的护目镜
      visorHousing(P, c);
      P.hline(7, 11, 13, c.accent);
      P.hline(20, 24, 13, c.accent);
      P.hline(12, 19, 14, c.accent);
      P.px(7, 14, c.sclera); P.px(24, 14, c.sclera);
      P.px(13, 13, c.sclera); P.px(18, 13, c.sclera);
      P.px(16, 12, c.sclera);
      if (frame === 2) {
        P.px(2, 8, c.accent); P.px(29, 8, c.accent);
        P.px(6, 6, c.sclera); P.px(25, 6, c.sclera);
      }
      return;
    }
    if (state === 'dead') {
      // 碎屏：中间打穿 + 裂纹 + 短路火花
      visorHousing(P, c);
      P.rect(10, 12, 12, 5, c.ink);
      P.rect(11, 13, 4, 2, c.pupil);
      P.rect(18, 14, 3, 2, c.pupil);
      P.px(13, 15, c.sclera);
      P.px(10, 11, c.mouth); P.px(13, 10, c.mouth);
      P.px(21, 18, c.mouth); P.px(22, 18, c.mouth);
      P.px(7, 12, c.mouth); P.px(24, 16, c.mouth);
      P.px(9, 10, c.accent);
      if (frame === 1) { P.px(13, 12, c.sclera); P.px(7, 17, c.mouth); P.px(20, 11, c.accent); }
      if (frame === 2) { P.px(16, 11, c.accent); P.px(24, 10, c.mouth); P.px(11, 17, c.mouth); }
      return;
    }
    if (state === 'hurt') {
      visorHousing(P, c);
      if (frame === 0) {
        // 白光过曝
        P.rect(6, 13, 20, 2, c.sclera);
        P.px(4, 10, c.accent); P.px(27, 10, c.accent);
      } else {
        // 电流噪声
        for (x = 6; x <= 25; x += 2) {
          P.px(x, 13, c.sclera);
          P.px(x + 1, 13, c.accent);
          P.px(x, 14, c.ink);
          P.px(x + 1, 14, c.pupil);
        }
        P.px(5, 12, c.accent); P.px(26, 15, c.accent);
      }
      return;
    }
    if (state === 'cast') {
      visorHousing(P, c);
      if (frame === 0) {
        P.rect(7, 13, 18, 2, c.pupil);
        P.px(7, 13, c.accent); P.px(24, 13, c.accent);
        P.px(9, 14, c.accent); P.px(22, 14, c.accent);
      } else if (frame === 1) {
        P.rect(6, 13, 20, 2, c.sclera);
      } else {
        P.rect(6, 13, 20, 2, c.accent);
        P.rect(6, 14, 20, 1, c.sclera);
        if (frame === 2) {
          P.px(3, 9, c.sclera); P.px(2, 8, c.sclera);
          P.px(28, 9, c.sclera); P.px(29, 8, c.sclera);
        } else {
          P.px(3, 7, c.accent); P.px(28, 7, c.accent);
          P.px(2, 6, c.sclera); P.px(29, 6, c.sclera);
        }
      }
      P.px(4, 13, c.accent); P.px(27, 13, c.accent);
      return;
    }
    // calm / idle / low
    visorHousing(P, c);
    var low = state === 'low';
    var scan = state === 'idle' ? frame : (state === 'calm' ? frame : 0);
    if (low) {
      P.rect(7, 13, 18, 2, c.mouth);
      P.px(8, 13, c.pupil); P.px(23, 14, c.pupil);
      P.px(11, 12, c.ink); P.px(12, 13, c.ink); P.px(13, 14, c.ink);
      P.px(19, 12, c.ink); P.px(18, 13, c.ink);
      P.px(5, 13, c.pupil); P.px(26, 13, c.pupil);
      if (frame === 1) {
        P.px(4, 10, c.accent); P.px(27, 10, c.accent);
        P.px(9, 12, c.ink); P.px(15, 14, c.ink);
        P.px(3, 15, c.sclera); P.px(28, 15, c.sclera);
      }
      return;
    }
    P.rect(7, 13, 18, 2, c.accent);
    // 机械眨眼：idle 第 3 帧收成一条细缝
    if (state === 'idle' && frame === 2) {
      P.rect(7, 13, 18, 1, c.pupil);
      P.px(9, 13, c.accent);
      P.px(22, 13, c.accent);
      return;
    }
    // 扫描高光
    var sx = 7 + (scan * 5) % 15;
    P.rect(sx, 13, 2, 2, c.sclera);
    // 镜面积灰 / 边角
    P.px(9, 14, c.pupil); P.px(23, 13, c.pupil);
  }

  /* ============================================================
   * 眼睛总入口
   * ============================================================ */
  function drawEyes(P, key, state, frame) {
    if (key === 'iron') { drawVisor(P, key, state, frame); return; }
    if (key === 'swarm') { drawCompound(P, key, state, frame); return; }
    if (state === 'dead') { drawDeadEyes(P, key, frame); return; }
    if (state === 'hurt') { drawHurtEyes(P, key, 'hurt', frame); return; }
    if (state === 'victory') { drawVictoryEyes(P, key, 'victory', frame); return; }
    if (state === 'cast') { drawCastEyes(P, key, 'cast', frame); return; }

    // calm / idle / low
    var c = PAL[key], an = animOf(state, frame);
    var y0 = EYE_Y + an.oy;
    var xs = [EYE_L, EYE_R];
    for (var i = 0; i < 2; i++) {
      var x0 = xs[i];
      if (key === 'ghost') { drawHollowEye(P, key, x0, y0, an.blink ? 'blink' : state, frame); continue; }
      if (key === 'grav') { drawGravEye(P, key, x0, y0, an.blink ? 'blink' : state, frame); continue; }
      if (an.blink) { drawBlink(P, key, x0, y0); continue; }
      stampBaseEye(P, key, x0, y0);
      drawIris(P, key, x0, y0, an.gaze, false);
      if (key === 'thorn') {
        P.px(x0 + 2, y0 + 6, c.accent);
        P.px(x0 + 5, y0 + 6, c.accent);
      }
      if (key === 'volt' && state === 'idle' && frame === 1) {
        P.px(x0, y0 - 1, c.accent);
      }
      if (state === 'low') {
        P.hline(x0 + 1, x0 + 6, y0 + 1, c.ink);
        P.hline(x0 + 1, x0 + 6, y0 + 2, c.ink);
        P.px(x0 + 5, y0 + 3, c.ink);
        P.px(x0 + 6, y0 + 3, c.ink);
        P.hline(x0 + 2, x0 + 5, y0 + 7, c.mouth);
      }
    }
    if (state === 'low') {
      var f = frame & 1;
      P.px(3, 12 - f, c.sclera);
      P.px(2, 13 - f, c.accent);
      P.px(28, 12 + f, c.sclera);
      P.px(29, 13 + f, c.accent);
    }
  }

  /* ---------------- 施法眼（按技能性格） ---------------- */
  function drawCastEyes(P, key, state, frame) {
    var c = PAL[key], y0 = EYE_Y;
    var xs = [EYE_L, EYE_R];
    var i, x0;
    switch (key) {
      case 'meteor':
        // 蓄火 → 爆燃 → 持续 → 回落
        for (i = 0; i < 2; i++) {
          x0 = xs[i];
          stampBaseEye(P, key, x0, y0);
          drawIris(P, key, x0, y0, 0, frame >= 1);
          if (frame === 0) {
            P.hline(x0 + 1, x0 + 6, y0 + 1, c.ink);
            P.hline(x0 + 1, x0 + 6, y0 + 2, c.ink);
          }
          P.px(x0 + 1, y0 - 1, c.accent);
          P.px(x0 + 6, y0 - 1, c.pupil);
          if (frame >= 1) {
            P.px(x0 + 1, y0 - 2, c.pupil);
            P.px(x0 + 2, y0 - 3, c.accent);
            P.px(x0 + 6, y0 - 2, c.accent);
          }
          if (frame === 2) {
            P.px(x0 + 3, y0 - 1, c.sclera);
            P.px(x0 + 4, y0 - 1, c.sclera);
          }
          if (frame === 1 || frame === 3) {
            P.px(x0 + 3, y0 + 7, c.accent);
            P.px(x0 + 4, y0 + 7, c.accent);
          }
        }
        break;
      case 'trapper':
        // 锁定 → 开火 → 引爆 → 余尘
        for (i = 0; i < 2; i++) {
          x0 = xs[i];
          stampBaseEye(P, key, x0, y0);
          drawIris(P, key, x0, y0, 0, frame >= 1);
          var d = frame === 0 ? 1 : (frame === 3 ? 2 : 0);
          var bc = frame === 1 ? c.accent : (frame === 2 ? c.sclera : c.ink);
          P.px(x0 - 1 + d, y0 - 1 + d, bc);
          P.px(x0 + 8 - d, y0 - 1 + d, bc);
          P.px(x0 - 1 + d, y0 + 8 - d, bc);
          P.px(x0 + 8 - d, y0 + 8 - d, bc);
          if (frame === 1) {
            P.px(x0 + 3, y0 + 3, c.sclera);
            P.px(x0 + 4, y0 + 4, c.sclera);
          }
          if (frame === 2) {
            P.px(x0 + 2, y0 + 2, c.sclera);
            P.px(x0 + 5, y0 + 5, c.sclera);
          }
        }
        break;
      case 'frost':
        // 凝霜 → 冰爆 → 碎片外飞 → 落定
        for (i = 0; i < 2; i++) {
          x0 = xs[i];
          stampBaseEye(P, key, x0, y0);
          drawIris(P, key, x0, y0, 0, frame >= 1);
          if (frame >= 1) {
            P.px(x0 - 1, y0 + 4, c.accent);
            P.px(x0 + 8, y0 + 4, c.accent);
            P.px(x0 + 3, y0 - 1, c.sclera);
          }
          if (frame === 1) { P.px(x0 + 4, y0 + 9, c.accent); P.px(x0 + 2, y0 - 2, c.sclera); }
          if (frame === 2) {
            P.px(x0 + 2, y0 - 2, c.accent);
            P.px(x0 + 5, y0 - 2, c.accent);
            P.px(x0 + 3, y0 + 9, c.sclera);
          }
          if (frame === 3) { P.px(x0 + 6, y0 + 8, c.accent); }
        }
        break;
      case 'volt':
        // 蓄电 → 白闪 → 电弧乱窜 → 余电
        for (i = 0; i < 2; i++) {
          x0 = xs[i];
          stampBaseEye(P, key, x0, y0);
          drawIris(P, key, x0, y0, 0, frame === 1 || frame === 2);
          if (frame >= 1) {
            P.px(x0 - 1, y0 - 1, c.accent);
            P.px(x0 + 8, y0 - 1, c.accent);
            P.px(x0 + 2, y0 - 2, c.sclera);
            P.px(x0 + 6, y0 - 2, c.sclera);
          }
          if (frame === 1) { P.px(x0 + 3, y0 + 8, c.sclera); }
          if (frame === 2) {
            P.px(x0 + 9, y0 + 3, c.accent);
            P.px(x0 - 2, y0 + 3, c.accent);
          }
          if (frame === 3) { P.px(x0 + 4, y0 + 8, c.accent); }
        }
        break;
      case 'venom':
        // 半睁蓄毒 → 毒光 → 毒泡上涌 → 回落
        for (i = 0; i < 2; i++) {
          x0 = xs[i];
          stampBaseEye(P, key, x0, y0);
          drawIris(P, key, x0, y0, 0, frame >= 1);
          if (frame >= 1) {
            P.px(x0 - 1, y0 + 3, c.accent);
            P.px(x0 + 8, y0 + 3, c.accent);
          }
          if (frame >= 2) {
            P.px(x0 - 1, y0 + 1, c.pupil);
            P.px(x0 + 8, y0 + 1, c.pupil);
            P.px(x0 + 3, y0 + 8, c.accent);
          }
        }
        break;
      case 'ghost':
        for (i = 0; i < 2; i++) drawHollowEye(P, key, xs[i], y0, 'cast', frame);
        break;
      case 'grav':
        for (i = 0; i < 2; i++) drawGravEye(P, key, xs[i], y0, 'cast', frame);
        break;
      case 'thorn':
        // 怒张 → 獠牙发红 → 咆哮 → 收势
        for (i = 0; i < 2; i++) {
          x0 = xs[i];
          stampBaseEye(P, key, x0, y0);
          drawIris(P, key, x0, y0, 0, frame >= 1);
          P.hline(x0 + 1, x0 + 6, y0 + 7, c.accent);
          if (frame >= 1) {
            P.px(x0 + 2, y0 - 1, c.pupil);
            P.px(x0 + 5, y0 - 1, c.pupil);
          }
          if (frame === 1) { P.px(x0 + 3, y0 + 8, c.accent); }
          if (frame === 2) { P.px(x0 + 1, y0 + 8, c.sclera); P.px(x0 + 6, y0 + 8, c.sclera); }
        }
        break;
      default: break;
    }
    // 通用施法粒子：四帧沿脸周流动，保证每个 look 的 cast 都有动势
    if (key !== 'iron' && key !== 'swarm') {
      var sparks = [[3, 7], [28, 7], [3, 22], [28, 22], [10, 2], [21, 2], [10, 29], [21, 29]];
      var s0 = sparks[frame & 7];
      var s1 = sparks[(frame + 3) & 7];
      P.px(s0[0], s0[1], c.accent);
      P.px(s1[0], s1[1], c.sclera);
      if (frame === 2) P.px(16, 3, c.accent);
    }
  }

  /* ---------------- 胜利眼：得意 / 闭眼笑 ---------------- */
  function drawHappyArc(P, c, x0, y0, col) {
    P.px(x0 + 1, y0 + 4, col);
    P.px(x0 + 2, y0 + 3, col);
    P.px(x0 + 3, y0 + 2, col);
    P.px(x0 + 4, y0 + 2, col);
    P.px(x0 + 5, y0 + 3, col);
    P.px(x0 + 6, y0 + 4, col);
    P.px(x0 + 2, y0 + 4, col);
    P.px(x0 + 3, y0 + 3, col);
    P.px(x0 + 4, y0 + 3, col);
    P.px(x0 + 5, y0 + 4, col);
  }
  function drawVictoryEyes(P, key, state, frame) {
    var c = PAL[key];
    var xs = [EYE_L, EYE_R];
    var i, x0;
    if (key === 'iron') { drawVisor(P, key, 'victory', frame); return; }
    if (key === 'swarm') { drawCompound(P, key, 'victory', frame); return; }
    if (key === 'ghost') {
      for (i = 0; i < 2; i++) {
        x0 = xs[i];
        drawHappyArc(P, c, x0, EYE_Y - (frame === 1 ? 1 : 0), c.sclera);
        P.px(x0 + 2, EYE_Y + 6, c.accent);
        P.px(x0 + 5, EYE_Y + 6, c.accent);
        if (frame === 2) {
          P.px(x0 + 1, EYE_Y + 2, c.accent);
          P.px(x0 + 6, EYE_Y + 7, c.sclera);
        }
      }
      return;
    }
    if (key === 'grav') {
      for (i = 0; i < 2; i++) drawGravEye(P, key, xs[i], EYE_Y, 'victory', frame);
      return;
    }
    var lift = frame === 1 ? -1 : 0;
    var y0 = EYE_Y + lift;
    if (CFG[key].victory === 'smug') {
      for (i = 0; i < 2; i++) {
        x0 = xs[i];
        stampBaseEye(P, key, x0, y0);
        drawIris(P, key, x0, y0, 0, false);
        // 半眯：上眼睑只压一横行，虹膜下半露出来
        P.hline(x0 + 1, x0 + 6, y0 + 2, c.ink);
        P.px(x0 + 1, y0 + 3, c.ink);
        P.px(x0 + 6, y0 + 3, c.ink);
        // 眼角笑纹
        P.px(x0 + 2, y0 + 6, c.accent);
        P.px(x0 + 5, y0 + 6, c.accent);
      }
    } else {
      for (i = 0; i < 2; i++) {
        x0 = xs[i];
        drawHappyArc(P, c, x0, y0, c.ink);
        P.px(x0 + 2, y0 + 6, c.accent);
        P.px(x0 + 5, y0 + 6, c.accent);
      }
    }
    if (frame === 2) {
      P.px(4, 3, c.accent); P.px(5, 2, c.sclera); P.px(3, 4, c.accent);
      P.px(27, 3, c.accent); P.px(26, 2, c.sclera); P.px(28, 4, c.accent);
      P.px(10, 6, c.accent); P.px(21, 6, c.accent);
    }
  }

  /* ---------------- 死亡眼：X / 空洞 ---------------- */
  function drawDeadEyes(P, key, frame) {
    var c = PAL[key];
    var xs = [EYE_L, EYE_R];
    var i, k, x0;
    if (key === 'iron') { drawVisor(P, key, 'dead', frame); return; }
    if (key === 'swarm') { drawCompound(P, key, 'dead', frame); return; }
    if (key === 'ghost') {
      for (i = 0; i < 2; i++) drawHollowEye(P, key, xs[i], EYE_Y, 'dead', frame);
      return;
    }
    if (key === 'grav') {
      for (i = 0; i < 2; i++) drawGravEye(P, key, xs[i], EYE_Y, 'dead', frame);
      return;
    }
    var baseName = CFG[key].base === 'slit' ? 'round' : CFG[key].base;
    for (i = 0; i < 2; i++) {
      x0 = xs[i];
      P.stamp(EYE_BASE[baseName] || EYE_BASE.round, x0, EYE_Y, PALOBJ[key]);
      var xcol = frame === 2 ? c.pupil : c.ink;
      for (k = 0; k < 6; k++) {
        P.px(x0 + 1 + k, EYE_Y + 1 + k, xcol);
        P.px(x0 + 6 - k, EYE_Y + 1 + k, xcol);
      }
      if (frame === 1) { P.px(x0 + 1, EYE_Y + 1, c.sclera); }
      if (frame === 2) { P.px(x0 + 2, EYE_Y + 7, c.mouth); P.px(x0 + 5, EYE_Y + 7, c.accent); }
    }
  }

  /* ---------------- 受击眼：挤压 / 瞪大 ---------------- */
  function drawHurtEyes(P, key, state, frame) {
    var c = PAL[key];
    var xs = [EYE_L, EYE_R];
    var i, x0;
    if (key === 'iron') { drawVisor(P, key, 'hurt', frame); return; }
    if (key === 'swarm') { drawCompound(P, key, 'hurt', frame); return; }
    if (key === 'ghost') {
      for (i = 0; i < 2; i++) drawHollowEye(P, key, xs[i], EYE_Y, 'hurt', frame);
      return;
    }
    if (key === 'grav') {
      for (i = 0; i < 2; i++) drawGravEye(P, key, xs[i], EYE_Y, 'hurt', frame);
      return;
    }
    for (i = 0; i < 2; i++) {
      x0 = xs[i];
      if (frame === 0) {
        // 挤眼 "><"
        if (i === 0) {
          P.px(x0 + 1, EYE_Y + 2, c.ink); P.px(x0 + 2, EYE_Y + 2, c.ink);
          P.px(x0 + 3, EYE_Y + 3, c.ink); P.px(x0 + 4, EYE_Y + 3, c.ink);
          P.px(x0 + 5, EYE_Y + 4, c.ink);
          P.px(x0 + 4, EYE_Y + 5, c.ink); P.px(x0 + 3, EYE_Y + 5, c.ink);
          P.px(x0 + 2, EYE_Y + 6, c.ink); P.px(x0 + 1, EYE_Y + 6, c.ink);
        } else {
          P.px(x0 + 6, EYE_Y + 2, c.ink); P.px(x0 + 5, EYE_Y + 2, c.ink);
          P.px(x0 + 4, EYE_Y + 3, c.ink); P.px(x0 + 3, EYE_Y + 3, c.ink);
          P.px(x0 + 2, EYE_Y + 4, c.ink);
          P.px(x0 + 3, EYE_Y + 5, c.ink); P.px(x0 + 4, EYE_Y + 5, c.ink);
          P.px(x0 + 5, EYE_Y + 6, c.ink); P.px(x0 + 6, EYE_Y + 6, c.ink);
        }
      } else {
        var baseName = CFG[key].base === 'slit' ? 'round' : CFG[key].base;
        P.stamp(EYE_BASE[baseName] || EYE_BASE.round, x0, EYE_Y, PALOBJ[key]);
        P.rect(x0 + 3, EYE_Y + 3, 2, 2, c.pupil);
        P.px(x0 + 3, EYE_Y + 3, c.sclera);
        P.px(x0 - 1, EYE_Y + 1, c.accent);
        P.px(x0 + 8, EYE_Y + 1, c.accent);
      }
    }
  }

  /* ============================================================
   * 眉毛
   * ============================================================ */
  function browPair(P, c, pts, y0) {
    for (var i = 0; i < pts.length; i++) {
      P.px(pts[i][0], y0 + pts[i][1], c.ink);
      P.px(31 - pts[i][0], y0 + pts[i][1], c.ink);
    }
  }
  function drawBrows(P, key, state, frame) {
    var c = PAL[key], style = CFG[key].brow;
    if (style === 'none' || state === 'dead') return;
    var an = animOf(state, frame);
    var y = 8 + an.oy;
    if (key === 'iron') y += 1;   // 装甲：眉毛贴着护目镜上沿
    if (state === 'victory') {
      // 胜利：眉眼一起抬起来（第二帧整体上提 1px 做小跳）
      var vy = y - (frame === 1 ? 1 : 0);
      browPair(P, c, [[4, 1], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 1]], vy);
      return;
    }
    if (state === 'hurt') {
      // 受击：眉毛整体抬高
      browPair(P, c, [[4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0]], y);
      return;
    }
    if (state === 'cast') {
      // 施法：压眉蓄力（更厚更斜）
      browPair(P, c, [[4, 0], [5, 0], [6, 0], [5, 1], [6, 1], [7, 1], [8, 1],
        [7, 2], [8, 2], [9, 2], [10, 2], [7, 3], [9, 3]], y);
      return;
    }
    if (state === 'low') {
      // 低血：怒眉 + 眉心竖纹
      browPair(P, c, [[4, 0], [5, 0], [6, 0], [5, 1], [6, 1], [7, 1], [8, 1],
        [7, 2], [8, 2], [9, 2], [10, 2]], y);
      return;
    }
    switch (style) {
      case 'angry':
        browPair(P, c, [[4, 0], [5, 0], [6, 0], [5, 1], [6, 1], [7, 1], [8, 1],
          [7, 2], [8, 2], [9, 2], [10, 2]], y);
        break;
      case 'heavy':
        browPair(P, c, [[4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0],
          [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1]], y);
        break;
      case 'flat':
        browPair(P, c, [[4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1]], y);
        break;
      case 'wild':
        browPair(P, c, [[4, 1], [6, 1], [8, 1], [10, 1],
          [5, 2], [7, 2], [9, 2]], y);
        break;
      case 'lazy':
        browPair(P, c, [[5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [4, 2]], y);
        break;
      default:
        browPair(P, c, [[5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [4, 2], [10, 2]], y);
        break;
    }
  }

  /* ============================================================
   * 嘴
   * ============================================================ */
  function mouthOval(P, c, cx, cy, fill) {
    P.hline(cx - 2, cx + 2, cy - 2, c.ink);
    P.px(cx - 3, cy - 1, c.ink); P.px(cx + 3, cy - 1, c.ink);
    P.px(cx - 3, cy, c.ink); P.px(cx + 3, cy, c.ink);
    P.px(cx - 3, cy + 1, c.ink); P.px(cx + 3, cy + 1, c.ink);
    P.hline(cx - 2, cx + 2, cy + 2, c.ink);
    P.rect(cx - 2, cy - 1, 5, 3, fill);
  }
  function gritMouth(P, c, cx, cy) {
    P.rect(cx - 4, cy - 1, 9, 3, c.ink);
    P.rect(cx - 3, cy, 7, 1, c.sclera);
    P.px(cx - 1, cy, c.ink);
    P.px(cx + 1, cy, c.ink);
  }
  function drawVictoryMouth(P, key, my, frame) {
    var c = PAL[key];
    var cx = MOUTH_X;
    var lift = frame === 1 ? -1 : 0;
    var y = my + lift;
    switch (key) {
      case 'meteor':
        // 咧嘴大笑（露牙）
        P.hline(cx - 5, cx + 5, y - 2, c.ink);
        P.px(cx - 5, y - 1, c.ink); P.px(cx + 5, y - 1, c.ink);
        P.hline(cx - 4, cx + 4, y - 1, c.sclera);
        P.px(cx - 4, y, c.ink); P.px(cx + 4, y, c.ink);
        P.hline(cx - 3, cx + 3, y, c.mouth);
        P.hline(cx - 4, cx + 4, y + 1, c.ink);
        P.px(cx - 6, y, c.accent); P.px(cx + 6, y, c.accent);
        break;
      case 'trapper':
      case 'venom':
        // 得意斜笑
        P.hline(cx - 5, cx - 3, y + 1, c.ink);
        P.hline(cx - 2, cx + 2, y, c.ink);
        P.hline(cx + 3, cx + 5, y - 1, c.ink);
        P.px(cx - 6, y, c.accent);
        if (key === 'venom') P.px(cx + 2, y + 1, c.accent);
        break;
      case 'iron':
        // 护目镜下的格栅微笑
        P.hline(cx - 4, cx + 4, y - 1, c.ink);
        P.px(cx - 4, y, c.ink); P.px(cx + 4, y, c.ink);
        P.hline(cx - 2, cx + 2, y, c.ink);
        P.px(cx - 1, y, c.pupil); P.px(cx + 1, y, c.pupil);
        break;
      case 'thorn':
        // 獠牙笑
        P.hline(cx - 5, cx + 5, y - 2, c.ink);
        P.px(cx - 5, y - 1, c.ink); P.px(cx + 5, y - 1, c.ink);
        P.rect(cx - 4, y - 1, 2, 3, c.sclera);
        P.rect(cx + 3, y - 1, 2, 3, c.sclera);
        P.rect(cx - 2, y - 1, 5, 2, c.mouth);
        P.hline(cx - 4, cx + 4, y + 1, c.ink);
        break;
      default:
        // 闭眼微笑 + 腮红
        P.px(cx - 5, y - 1, c.ink);
        P.px(cx - 4, y, c.ink);
        P.hline(cx - 3, cx + 3, y + 1, c.ink);
        P.px(cx + 4, y, c.ink);
        P.px(cx + 5, y - 1, c.ink);
        P.px(cx - 6, y, c.accent);
        P.px(cx + 6, y, c.accent);
        if (frame === 1) {
          P.px(cx - 2, y + 1, c.accent);
          P.px(cx + 2, y + 1, c.accent);
        }
        break;
    }
  }
  function drawCastMouth(P, key, my, frame) {
    var c = PAL[key];
    var cx = MOUTH_X;
    switch (CFG[key].castMouth) {
      case 'flame':
        mouthOval(P, c, cx, my, c.mouth);
        if (frame >= 1) {
          P.px(cx - 1, my - 1, c.accent);
          P.px(cx + 1, my - 1, c.accent);
          P.px(cx, my, c.accent);
        }
        if (frame === 2) { P.px(cx - 1, my, c.sclera); P.px(cx + 1, my, c.sclera); }
        break;
      case 'grit':
        gritMouth(P, c, cx, my);
        if (frame === 1) { P.px(cx, my, c.accent); }
        break;
      case 'grill':
        P.rect(cx - 4, my - 1, 9, 3, c.ink);
        P.rect(cx - 3, my, 7, 1, c.pupil);
        P.px(cx - 1, my, c.ink); P.px(cx + 1, my, c.ink);
        if (frame >= 1) P.rect(cx - 2, my, 3, 1, c.accent);
        break;
      case 'puff':
        mouthOval(P, c, cx, my, c.mouth);
        P.px(cx, my, c.accent);
        if (frame >= 1) {
          P.px(cx - 5, my - 1, c.sclera);
          P.px(cx + 5, my - 1, c.sclera);
        }
        if (frame >= 2) {
          P.px(cx - 6, my, c.accent);
          P.px(cx + 6, my, c.accent);
        }
        break;
      case 'o':
        mouthOval(P, c, cx, my, c.mouth);
        if (frame >= 1) P.rect(cx - 1, my, 3, 1, c.accent);
        if (frame === 2) P.px(cx, my, c.sclera);
        break;
      case 'void':
        mouthOval(P, c, cx, my, c.mouth);
        if (frame >= 1) {
          P.px(cx - 4, my - 2, c.pupil);
          P.px(cx + 4, my - 2, c.pupil);
        }
        if (frame >= 2) { P.px(cx, my, c.accent); }
        break;
      case 'roar':
        P.hline(cx - 3, cx + 3, my - 2, c.ink);
        P.px(cx - 4, my - 1, c.ink); P.px(cx + 4, my - 1, c.ink);
        P.px(cx - 4, my + 1, c.ink); P.px(cx + 4, my + 1, c.ink);
        P.hline(cx - 3, cx + 3, my + 2, c.ink);
        P.rect(cx - 3, my - 1, 7, 3, c.mouth);
        P.rect(cx - 2, my - 1, 2, 2, c.sclera);
        P.rect(cx + 1, my - 1, 2, 2, c.sclera);
        if (frame === 1) P.px(cx, my + 1, c.accent);
        break;
      case 'mandible':
        P.px(cx - 5, my - 2, c.ink); P.px(cx - 4, my - 1, c.ink);
        P.px(cx - 4, my, c.ink); P.px(cx - 3, my + 1, c.ink);
        P.px(cx + 5, my - 2, c.ink); P.px(cx + 4, my - 1, c.ink);
        P.px(cx + 4, my, c.ink); P.px(cx + 3, my + 1, c.ink);
        P.px(cx - 2, my + 2, c.mouth); P.px(cx + 2, my + 2, c.mouth);
        if (frame === 1) { P.px(cx, my, c.accent); }
        break;
      default:
        P.hline(cx - 2, cx + 2, my, c.ink);
        break;
    }
  }
  function drawDeadMouth(P, key, my) {
    var c = PAL[key];
    var cx = MOUTH_X;
    if (key === 'iron') {
      P.rect(cx - 4, my - 1, 9, 3, c.ink);
      P.px(cx - 2, my, c.pupil);
      P.px(cx + 2, my, c.pupil);
      return;
    }
    if (key === 'thorn') {
      P.hline(cx - 4, cx + 4, my, c.ink);
      P.px(cx - 2, my + 1, c.sclera);
      P.px(cx + 2, my + 1, c.sclera);
      return;
    }
    if (key === 'swarm') {
      P.px(cx - 4, my + 1, c.ink); P.px(cx - 3, my, c.ink);
      P.px(cx + 4, my + 1, c.ink); P.px(cx + 3, my, c.ink);
      return;
    }
    P.hline(cx - 3, cx + 3, my, c.ink);
    P.px(cx - 4, my + 1, c.ink);
    P.px(cx + 4, my + 1, c.ink);
  }
  function drawMouth(P, key, state, frame) {
    var c = PAL[key], cfg = CFG[key];
    var an = animOf(state, frame);
    var my = MOUTH_Y + an.oy;
    var cx = MOUTH_X;
    if (state === 'dead') { drawDeadMouth(P, key, my); return; }
    if (state === 'hurt') {
      mouthOval(P, c, cx, my, c.mouth);
      P.px(cx, my + 1, c.accent);
      P.px(cx - 5, my - 1, c.accent);
      P.px(cx + 5, my - 1, c.accent);
      return;
    }
    if (state === 'victory') { drawVictoryMouth(P, key, my, frame); return; }
    if (state === 'cast') { drawCastMouth(P, key, my, frame); return; }
    if (state === 'low') { gritMouth(P, c, cx, my); return; }
    switch (cfg.mouth) {
      case 'grin':
        // 大咧嘴：上唇 → 牙 → 口腔 → 下唇
        P.hline(cx - 5, cx + 5, my - 2, c.ink);
        P.px(cx - 5, my - 1, c.ink); P.px(cx + 5, my - 1, c.ink);
        P.hline(cx - 4, cx + 4, my - 1, c.sclera);
        P.px(cx - 4, my, c.ink); P.px(cx + 4, my, c.ink);
        P.hline(cx - 3, cx + 3, my, c.mouth);
        P.hline(cx - 4, cx + 4, my + 1, c.ink);
        break;
      case 'smirk':
        // 一侧挑起的坏笑
        P.hline(cx - 5, cx - 3, my + 1, c.ink);
        P.hline(cx - 2, cx + 2, my, c.ink);
        P.hline(cx + 3, cx + 5, my - 1, c.ink);
        P.px(cx - 6, my, c.accent);
        break;
      case 'grill':
        P.rect(cx - 4, my - 1, 9, 3, c.ink);
        P.rect(cx - 3, my, 7, 1, c.pupil);
        P.px(cx - 1, my, c.ink);
        P.px(cx + 1, my, c.ink);
        break;
      case 'puff':
        P.rect(cx - 1, my - 1, 3, 3, c.ink);
        P.px(cx, my, c.mouth);
        if (state === 'idle' && frame >= 1) {
          P.px(cx - 3, my + 1, c.sclera);
          P.px(cx + 3, my + 1, c.sclera);
          P.px(cx - 4, my + 2, c.accent);
          P.px(cx + 4, my + 2, c.accent);
        }
        break;
      case 'zigzag':
        P.px(cx - 4, my, c.ink);
        P.px(cx - 3, my + 1, c.ink);
        P.px(cx - 2, my, c.ink);
        P.px(cx - 1, my + 1, c.ink);
        P.px(cx, my, c.ink);
        P.px(cx + 1, my + 1, c.ink);
        P.px(cx + 2, my, c.ink);
        P.px(cx + 3, my + 1, c.ink);
        P.px(cx + 4, my, c.ink);
        break;
      case 'smug':
        // 巫医式的阴笑
        P.hline(cx - 3, cx + 1, my, c.ink);
        P.px(cx + 2, my - 1, c.ink);
        P.px(cx + 3, my - 1, c.ink);
        P.px(cx - 4, my + 1, c.ink);
        P.px(cx + 2, my + 1, c.accent);
        break;
      case 'wave':
        // 幽灵的波纹嘴
        P.hline(cx - 5, cx - 4, my, c.ink);
        P.hline(cx - 3, cx - 2, my + 1, c.ink);
        P.hline(cx - 1, cx + 1, my, c.ink);
        P.hline(cx + 2, cx + 3, my + 1, c.ink);
        P.hline(cx + 4, cx + 5, my, c.ink);
        break;
      case 'flat':
        P.hline(cx - 3, cx + 3, my, c.ink);
        break;
      case 'fangs':
        // 上唇 / 獠牙 / 口腔 / 下唇（顺序不能反）
        P.hline(cx - 4, cx + 4, my - 2, c.ink);
        P.px(cx - 5, my - 1, c.ink); P.px(cx + 5, my - 1, c.ink);
        P.rect(cx - 1, my - 1, 3, 2, c.mouth);
        P.rect(cx - 4, my - 1, 2, 3, c.sclera);
        P.rect(cx + 3, my - 1, 2, 3, c.sclera);
        P.hline(cx - 3, cx + 3, my + 1, c.ink);
        break;
      case 'mandible':
        // 蜂群的口器：两片颚 + 中间小口
        P.px(cx - 5, my - 1, c.ink);
        P.px(cx - 4, my, c.ink);
        P.px(cx - 4, my + 1, c.ink);
        P.px(cx - 3, my + 1, c.ink);
        P.px(cx + 5, my - 1, c.ink);
        P.px(cx + 4, my, c.ink);
        P.px(cx + 4, my + 1, c.ink);
        P.px(cx + 3, my + 1, c.ink);
        P.px(cx - 1, my + 2, c.mouth);
        P.px(cx, my + 2, c.mouth);
        P.px(cx + 1, my + 2, c.mouth);
        break;
      default:
        P.hline(cx - 2, cx + 2, my, c.ink);
        break;
    }
  }

  /* ============================================================
   * 性格化小配件 / 施法氛围
   * ============================================================ */
  function drawExtras(P, key, state, frame) {
    var c = PAL[key];
    var i, px, py;
    var idle = state === 'idle', cast = state === 'cast', low = state === 'low', vic = state === 'victory', dead = state === 'dead';
    switch (key) {
      case 'meteor':
        if (dead) {
          P.px(4, 3, c.mouth); P.px(8, 2, c.mouth); P.px(26, 3, c.mouth);
          return;
        }
        var rise = idle ? frame : (cast ? frame % 2 : 0);
        var embers = [[6, 2], [16, 1], [26, 2]];
        for (i = 0; i < embers.length; i++) {
          if (cast && (i % 2) && frame < 2) continue;
          P.px(embers[i][0], embers[i][1] + ((rise + i) % 3), i % 2 ? c.sclera : c.accent);
        }
        if (cast) {
          P.px(8, 4, c.pupil); P.px(9, 3, c.accent); P.px(9, 2, c.accent);
          P.px(23, 4, c.pupil); P.px(22, 3, c.accent); P.px(22, 2, c.accent);
          if (frame >= 1) { P.px(7, 2, c.pupil); P.px(24, 2, c.pupil); }
          if (frame >= 2) { P.px(11, 1, c.accent); P.px(20, 1, c.accent); }
        }
        if (vic) { P.px(5, 4, c.accent); P.px(26, 4, c.accent); P.px(16, 2, c.sclera); }
        if (low) { P.px(2, 10, c.mouth); P.px(29, 12, c.mouth); }
        break;
      case 'trapper':
        var ticks = [[3, 4], [28, 4], [3, 27], [28, 27]];
        var tk = cast ? (frame === 0 ? c.ink : c.accent) : (vic ? c.accent : c.ink);
        for (i = 0; i < ticks.length; i++) {
          px = ticks[i][0]; py = ticks[i][1];
          P.px(px, py, tk);
          P.px(px + (px < 16 ? 1 : -1), py, tk);
          P.px(px, py + (py < 16 ? 1 : -1), tk);
        }
        if (cast) {
          if (frame === 1) { P.px(2, 2, c.accent); P.px(29, 2, c.accent); P.px(2, 29, c.accent); P.px(29, 29, c.accent); }
          if (frame >= 2) {
            var ring = [[4, 8], [27, 8], [4, 23], [27, 23], [8, 3], [23, 3], [8, 28], [23, 28], [1, 16], [30, 16]];
            for (i = 0; i < ring.length; i++) P.px(ring[i][0], ring[i][1], frame === 2 ? c.sclera : c.accent);
          }
        }
        if (low) { P.px(4, 10, c.accent); P.px(27, 10, c.accent); }
        break;
      case 'rivet':
        P.px(2, 11, c.pupil); P.px(2, 14, c.pupil);
        P.px(29, 11, c.pupil); P.px(29, 14, c.pupil);
        if (cast) {
          if (frame >= 2) {
            P.px(2, 8, c.sclera); P.px(1, 7, c.sclera);
            P.px(29, 8, c.sclera); P.px(30, 7, c.sclera);
          }
          if (frame === 3) { P.px(3, 6, c.sclera); P.px(28, 6, c.sclera); }
        }
        if (low) { P.px(3, 8, c.mouth); P.px(28, 8, c.mouth); }
        break;
      case 'snow':
        var dr = idle ? (frame % 2) : 0;
        P.px(2, 5 + dr, c.sclera); P.px(3, 5 + dr, c.accent);
        P.px(29, 6 - dr, c.sclera); P.px(28, 6 - dr, c.accent);
        P.px(2, 24 - dr, c.accent); P.px(29, 23 + dr, c.accent);
        if (cast) {
          P.px(1, 3, c.sclera); P.px(30, 3, c.sclera);
          if (frame >= 1) { P.px(4, 2, c.accent); P.px(27, 2, c.accent); }
          if (frame >= 2) { P.px(1, 8, c.accent); P.px(30, 8, c.accent); P.px(5, 28, c.accent); P.px(26, 28, c.accent); }
        }
        if (vic) { P.px(4, 3, c.sclera); P.px(27, 3, c.sclera); }
        if (low) { P.px(1, 16, c.sclera); P.px(30, 16, c.sclera); }
        break;
      case 'spark':
        var sx = idle ? (3 + (frame % 2) * 21) : 3;
        P.px(sx, 3, c.accent); P.px(sx + 1, 2, c.sclera); P.px(sx + 1, 1, c.accent);
        P.px(sx + 2, 2, c.accent);
        if (cast) {
          if (frame >= 1) {
            var af = frame % 2;
            P.px(2, 8 + af, c.accent); P.px(3, 9 + af, c.sclera); P.px(2, 10 + af, c.accent);
            P.px(29, 8 + af, c.accent); P.px(28, 9 + af, c.sclera); P.px(29, 10 + af, c.accent);
          }
          if (frame === 2) { P.px(1, 5, c.sclera); P.px(30, 5, c.sclera); P.px(4, 29, c.accent); P.px(27, 29, c.accent); }
        }
        if (low) { P.px(3, 4, c.mouth); P.px(28, 4, c.mouth); }
        if (vic) { P.px(6, 2, c.accent); P.px(25, 2, c.accent); }
        break;
      case 'bubble':
        var b = idle ? frame : (cast ? frame : 0);
        var bubbles = [[2, 14], [4, 11], [2, 18], [29, 13], [27, 16], [30, 19]];
        for (i = 0; i < bubbles.length; i++) {
          if (i > 2 && !cast) continue;
          P.px(bubbles[i][0], bubbles[i][1] - ((b + i) % 3), i % 2 ? c.accent : c.sclera);
          if (cast && frame >= 1) P.px(bubbles[i][0], bubbles[i][1] - ((b + i) % 3) - 2, c.accent);
        }
        if (cast) {
          P.px(1, 8, c.accent); P.px(30, 9, c.accent);
          if (frame === 1) { P.px(1, 5, c.sclera); P.px(30, 5, c.sclera); }
        }
        if (low) { P.px(2, 20, c.mouth); P.px(29, 21, c.mouth); }
        if (vic) { P.px(2, 10, c.sclera); P.px(29, 10, c.sclera); }
        break;
      case 'wisp':
        var w = idle ? (frame % 2) : 0;
        P.px(2, 20, c.pupil); P.px(1, 21 + w, c.accent);
        P.px(29, 20, c.pupil); P.px(30, 21 + w, c.accent);
        P.px(8, 3, c.sclera); P.px(23, 3, c.sclera);
        if (cast) {
          P.px(5, 5, c.accent); P.px(4, 3, c.sclera); P.px(6, 2, c.accent);
          P.px(26, 5, c.accent); P.px(27, 3, c.sclera); P.px(25, 2, c.accent);
          if (frame >= 2) { P.px(2, 12, c.pupil); P.px(29, 12, c.pupil); }
        }
        if (dead) { P.px(3, 20, c.mouth); P.px(28, 20, c.mouth); }
        if (vic) { P.px(4, 2, c.sclera); P.px(27, 2, c.sclera); }
        break;
      case 'orbit':
        var seq = [[3, 5], [28, 5], [29, 15], [28, 25], [3, 25], [2, 15], [16, 2], [16, 29]];
        var n = seq.length;
        var rot = idle ? frame : (cast ? frame : 0);
        P.px(seq[rot % n][0], seq[rot % n][1], c.accent);
        P.px(seq[(rot + 3) % n][0], seq[(rot + 3) % n][1], c.pupil);
        if (cast) {
          if (frame >= 1) {
            P.px(11, 6, c.sclera); P.px(21, 6, c.sclera);
            P.px(9, 21, c.accent); P.px(23, 21, c.accent);
          }
          if (frame >= 2) { P.px(7, 12, c.accent); P.px(24, 12, c.pupil); }
        }
        if (vic) { P.px(6, 3, c.sclera); P.px(25, 3, c.sclera); P.px(16, 3, c.sclera); }
        if (low) { P.px(16, 2, c.mouth); P.px(16, 29, c.mouth); }
        break;
      case 'spikes':
        var grow = cast ? (frame >= 1 ? 2 : 1) : 0;
        var spikes = [[2, 8], [1, 9], [2, 13], [1, 14], [2, 19], [1, 20]];
        for (i = 0; i < spikes.length; i++) {
          P.px(spikes[i][0], spikes[i][1], c.accent);
          P.px(31 - spikes[i][0], spikes[i][1], c.accent);
          if (grow && i % 2 === 0) {
            P.px(spikes[i][0] - 1, spikes[i][1], c.pupil);
            P.px(31 - spikes[i][0] + 1, spikes[i][1], c.pupil);
          }
        }
        if (low) { P.px(3, 24, c.mouth); P.px(28, 24, c.mouth); }
        if (vic) { P.px(4, 3, c.accent); P.px(27, 3, c.accent); }
        break;
      case 'antennae':
        var wig = idle ? (frame % 2) : 0;
        P.px(8, 4, c.pupil); P.px(7, 3, c.pupil); P.px(6 + wig, 2, c.pupil); P.px(5 + wig, 1, c.accent);
        P.px(23, 4, c.pupil); P.px(24, 3, c.pupil); P.px(25 - wig, 2, c.pupil); P.px(26 - wig, 1, c.accent);
        if (low) {
          P.px(4, 3, c.pupil); P.px(3, 2, c.pupil);
          P.px(27, 3, c.pupil); P.px(28, 2, c.pupil);
        }
        if (idle && frame === 3) { P.px(29, 7, c.pupil); P.px(30, 7, c.accent); }
        if (cast) {
          var bs = [[3, 6], [28, 6], [4, 19], [27, 19], [15, 2], [16, 25]];
          for (i = 0; i < bs.length; i++) {
            if (i % 2 === frame % 2) {
              P.px(bs[i][0], bs[i][1], c.accent);
              P.px(bs[i][0] + 1, bs[i][1], c.pupil);
            }
          }
        }
        if (vic) { P.px(2, 2, c.accent); P.px(29, 2, c.accent); }
        break;
      default: break;
    }
  }

  /* ============================================================
   * 精灵绘制 / 缓存
   * ============================================================ */
  var doc = (typeof root !== 'undefined' && root.document) || null;
  var cache = {};        // look|state|frame -> canvas
  var dataCache = {};    // look|state|frame -> dataURL
  var beeCache = {};

  /* 脸颊小记号：填满眼/嘴之间的空隙，让每颗球更有脸感 */
  function drawCheeks(P, key, state) {
    var c = PAL[key];
    if (state === 'dead') return;
    switch (key) {
      case 'meteor':
        P.px(4, 18, c.accent); P.px(3, 19, c.pupil);
        P.px(27, 18, c.accent); P.px(28, 19, c.pupil);
        break;
      case 'trapper':
        P.px(4, 18, c.ink); P.px(5, 19, c.accent);
        P.px(27, 18, c.ink); P.px(26, 19, c.accent);
        break;
      case 'iron':
        P.px(6, 19, c.pupil); P.px(7, 19, c.mouth);
        P.px(25, 19, c.pupil); P.px(24, 19, c.mouth);
        break;
      case 'frost':
        P.px(4, 18, c.sclera); P.px(5, 19, c.accent);
        P.px(27, 18, c.sclera); P.px(26, 19, c.accent);
        break;
      case 'volt':
        P.px(4, 18, c.accent); P.px(5, 19, c.sclera);
        P.px(27, 18, c.accent); P.px(26, 19, c.sclera);
        break;
      case 'venom':
        P.px(4, 19, c.accent); P.px(5, 20, c.pupil);
        P.px(27, 19, c.accent); P.px(26, 20, c.pupil);
        break;
      case 'ghost':
        P.px(4, 18, c.pupil); P.px(5, 20, c.accent);
        P.px(27, 18, c.pupil); P.px(26, 20, c.accent);
        break;
      case 'grav':
        P.px(4, 19, c.accent); P.px(5, 20, c.pupil);
        P.px(27, 19, c.pupil); P.px(26, 20, c.accent);
        break;
      case 'thorn':
        P.px(4, 18, c.accent); P.px(5, 19, c.pupil); P.px(5, 20, c.accent);
        P.px(27, 18, c.accent); P.px(26, 19, c.pupil); P.px(26, 20, c.accent);
        break;
      case 'swarm':
        P.px(4, 18, c.pupil); P.px(5, 20, c.accent);
        P.px(27, 18, c.pupil); P.px(26, 20, c.accent);
        break;
      default: break;
    }
  }

  function paintSprite(g, key, state, frame) {
    var P = makeP(g);
    drawExtras(P, key, state, frame);
    drawCheeks(P, key, state);
    drawEyes(P, key, state, frame);
    drawBrows(P, key, state, frame);
    drawMouth(P, key, state, frame);
  }

  function makeCanvas(w, h) {
    if (!doc || !doc.createElement) return null;
    var cv = doc.createElement('canvas');
    cv.width = w;
    cv.height = h;
    return cv;
  }

  function spriteCanvas(ballId, state, frame) {
    if (!doc) return null;
    var k = keyOf(ballId);
    var s = STATES.indexOf(state) >= 0 ? state : 'calm';
    var frames = FRAMES[s] || 1;
    var f = clamp(frame | 0, 0, frames - 1);
    var key = k + '|' + s + '|' + f;
    if (cache[key]) return cache[key];
    var cv = makeCanvas(GRID, GRID);
    if (!cv) return null;
    var g = cv.getContext('2d');
    if (!g) return null;
    paintSprite(g, k, s, f);
    cache[key] = cv;
    return cv;
  }

  function frameCount(ballId, state) {
    var s = STATES.indexOf(state) >= 0 ? state : 'calm';
    return FRAMES[s] || 1;
  }
  function frameDuration(ballId, state) {
    var s = STATES.indexOf(state) >= 0 ? state : 'calm';
    return DURATION[s] || 1000;
  }

  function draw(ctx, ballId, state, frame, x, y, size, opts) {
    opts = opts || {};
    var s = STATES.indexOf(state) >= 0 ? state : 'calm';
    var frames = frameCount(ballId, s);
    var f = clamp(frame | 0, 0, frames - 1);
    var cv = spriteCanvas(ballId, s, f);
    if (!cv) return false;
    var prevSmooth = ctx.imageSmoothingEnabled;
    var alpha = typeof opts.alpha === 'number' ? clamp(opts.alpha, 0, 1) : 1;
    var flip = !!opts.flip;
    var exact = !!opts.exact;
    var drawSize = Math.max(1, size);
    // 整数像素吸附：只有非常接近整数倍时才吸附，
    // 避免小尺寸 UI 被吸到 1x 而缩小、或吸到 2x 而裁边。
    if (!exact && opts.pixelScale > 0) {
      var ps = opts.pixelScale;
      var exactScale = drawSize * ps / GRID;
      var k = Math.round(exactScale);
      if (k >= 1 && Math.abs(k - exactScale) <= 0.14 * exactScale) {
        drawSize = k * GRID / ps;
      }
    }
    ctx.save();
    try { ctx.imageSmoothingEnabled = false; } catch (e) {}
    if (alpha < 1) ctx.globalAlpha *= alpha;
    var ox = opts.offsetX || 0, oy = opts.offsetY || 0;
    var left = x - drawSize / 2 + ox;
    var top = y - drawSize / 2 + oy;
    // 位置也吸附到设备像素，避免半像素采样导致像素块宽度不均
    if (!exact && opts.pixelScale > 0) {
      var ps2 = opts.pixelScale;
      left = Math.round(left * ps2) / ps2;
      top = Math.round(top * ps2) / ps2;
    }
    if (flip) {
      ctx.translate(left + drawSize / 2, top);
      ctx.scale(-1, 1);
      ctx.drawImage(cv, -drawSize / 2, 0, drawSize, drawSize);
    } else {
      ctx.drawImage(cv, left, top, drawSize, drawSize);
    }
    try { ctx.imageSmoothingEnabled = prevSmooth; } catch (e) {}
    ctx.restore();
    return true;
  }

  function dataURL(ballId, state, frame) {
    var k = keyOf(ballId);
    var s = STATES.indexOf(state) >= 0 ? state : 'calm';
    var f = clamp(frame | 0, 0, (FRAMES[s] || 1) - 1);
    var ck = k + '|' + s + '|' + f;
    if (dataCache[ck]) return dataCache[ck];
    var cv = spriteCanvas(ballId, s, f);
    if (!cv || typeof cv.toDataURL !== 'function') return '';
    var url = '';
    try { url = cv.toDataURL('image/png'); } catch (e) { url = ''; }
    dataCache[ck] = url;
    return url;
  }

  function prewarm(ids, states) {
    ids = ids && ids.length ? ids : BALL_IDS;
    states = states && states.length ? states : STATES;
    for (var i = 0; i < ids.length; i++) {
      for (var s = 0; s < states.length; s++) {
        var n = frameCount(ids[i], states[s]);
        for (var f = 0; f < n; f++) spriteCanvas(ids[i], states[s], f);
      }
    }
  }

  function clearCache() {
    cache = {};
    dataCache = {};
    beeCache = {};
  }

  /* ============================================================
   * 像素蜜蜂（战场召唤物，8×8；普通 / 狂暴 两套）
   * ============================================================ */
  var BEE_GRID = 8;
  var BEE_FRAMES = 2;
  var BEE = {
    body: '#FFD642', stripe: '#2A2008', wing: '#EAF6FF', eye: '#141008', outline: '#1B1605',
    fBody: '#FF8A4D', fStripe: '#5A0E04', fWing: '#FFE3D6', fEye: '#FF2A2A', fOutline: '#2A0A02'
  };
  function paintBee(g, frenzy, frame) {
    var wing = frame % 2 === 0 ? 0 : 1;
    var body = frenzy ? BEE.fBody : BEE.body;
    var stripe = frenzy ? BEE.fStripe : BEE.stripe;
    var wingCol = frenzy ? BEE.fWing : BEE.wing;
    var eye = frenzy ? BEE.fEye : BEE.eye;
    var out = frenzy ? BEE.fOutline : BEE.outline;
    // 翅膀（两帧扇动）
    g.fillStyle = wingCol;
    g.fillRect(0, wing ? 1 : 2, 2, 2);
    g.fillRect(6, wing ? 1 : 2, 2, 2);
    g.fillStyle = out;
    if (frame === 1) {
      g.fillRect(0, 3, 2, 1);
      g.fillRect(6, 3, 2, 1);
    }
    // 身体 + 硬边描边
    g.fillStyle = out;
    g.fillRect(2, 1, 4, 6);
    g.fillRect(1, 2, 1, 4);
    g.fillRect(6, 2, 1, 4);
    g.fillStyle = body;
    g.fillRect(2, 2, 4, 4);
    g.fillRect(3, 1, 2, 1);
    g.fillRect(3, 6, 2, 1);
    // 条纹
    g.fillStyle = stripe;
    g.fillRect(2, 3, 4, 1);
    g.fillRect(2, 5, 4, 1);
    // 头部 + 复眼
    g.fillStyle = eye;
    g.fillRect(3, 2, 2, 1);
    g.fillStyle = frenzy ? BEE.fWing : '#FFFFFF';
    g.fillRect(3, 2, 1, 1);
    // 尾刺
    g.fillStyle = stripe;
    g.fillRect(3, 7, 2, 1);
    if (frenzy) {
      // 狂暴：头顶怒气高光
      g.fillStyle = '#FFF3C4';
      g.fillRect(2, 2, 1, 1);
      g.fillStyle = BEE.fStripe;
      g.fillRect(3, 0, 2, 1);
    }
  }
  function beeCanvas(frenzy, frame) {
    if (!doc) return null;
    var key = (frenzy ? 'f' : 'n') + '|' + (frame | 0);
    if (beeCache[key]) return beeCache[key];
    var cv = makeCanvas(BEE_GRID, BEE_GRID);
    if (!cv) return null;
    var g = cv.getContext('2d');
    if (!g) return null;
    paintBee(g, frenzy, frame | 0);
    beeCache[key] = cv;
    return cv;
  }
  function drawBee(ctx, x, y, size, frenzy, frame, opts) {
    opts = opts || {};
    var cv = beeCanvas(!!frenzy, frame | 0);
    if (!cv) return false;
    var prevSmooth = ctx.imageSmoothingEnabled;
    ctx.save();
    try { ctx.imageSmoothingEnabled = false; } catch (e) {}
    if (opts.alpha !== undefined) ctx.globalAlpha *= clamp(opts.alpha, 0, 1);
    var s = Math.max(1, size);
    if (opts.pixelScale > 0) {
      var k = Math.round(s * opts.pixelScale / BEE_GRID);
      if (k >= 1) s = k * BEE_GRID / opts.pixelScale;
    }
    ctx.drawImage(cv, x - s / 2, y - s / 2, s, s);
    try { ctx.imageSmoothingEnabled = prevSmooth; } catch (e) {}
    ctx.restore();
    return true;
  }

  /* ---------------- 导出 ---------------- */
  return {
    grid: GRID,
    beeGrid: BEE_GRID,
    faceRatio: 1.0,         // 建议：绘制尺寸 = 球直径
    states: STATES.slice(),
    ballIds: BALL_IDS.slice(),
    frameCount: frameCount,
    frameDuration: frameDuration,
    frameDurationSeconds: function (ballId, state) { return frameDuration(ballId, state) / 1000; },
    draw: draw,
    canvas: spriteCanvas,
    dataURL: dataURL,
    prewarm: prewarm,
    clearCache: clearCache,
    colors: function (ballId) {
      var k = keyOf(ballId);
      var c = PAL[k];
      return { ink: c.ink, sclera: c.sclera, pupil: c.pupil, accent: c.accent, accent2: c.accent, mouth: c.mouth };
    },
    keyOf: keyOf,
    drawBee: drawBee,
    beeCanvas: beeCanvas,
    beeFrameCount: function () { return BEE_FRAMES; }
  };
});

