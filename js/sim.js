/* ============================================================
 * 斗球场 BALL PIT — 仿真核心 js/sim.js
 * 纯逻辑：零 DOM、零异步、零 Math.random（全部走种子 RNG）。
 * 浏览器挂 window.BallSim；Node 可 require('./js/sim.js')。
 * 数值唯一来源：js/data.js（RULES / SKILLS / BALLS / EFFECTS / DAMAGE_TYPES）
 *
 * v0.3：
 *  - 时间上限 300s、速胜时刻 60s（均由 data 驱动，sim 按传入 timeLimit 工作）。
 *  - 四种伤害类型：撞击 collision / 直接 direct / 持续 dot / 真实 true；
 *      hit 事件带 damageType；持续伤害只吃 dmgTakenMult（不吃防御/护盾/闪避）。
 *  - 蜂群：swarm_hive（每 5s 召 1 只蜜蜂，最多 3 只，180 内追踪，追上 2 直接伤害）
 *      + swarm_rage（补至 3 只并转狂暴蜂，共 6 只狂暴额度，6 伤害）；snapshot.bees 供渲染。
 *  - 流星火痕只对进入者施加/刷新余烬，不再有独立火痕伤害。
 *  - 特斯拉天雷：场地内纯随机 2 道、半径 80、每道 5 直接伤害、同一目标可被多道命中。
 *  - 旧 evade / frenzy 已从 data 删除，sim 不再引用。
 *
 * v0.4（能量/召唤物/边界）：
 *  - 主动改能量：每秒 +energy.perSecond、满 energyCost 自动施放并扣除；奇门无雷保留能量。
 *  - DOT 吃防御/减伤/护盾/闪避；反伤只反撞击/直接，召唤物伤害不反伤。
 *  - 重甲低血强化；地雷机关（触发/连锁/主动连环引爆/引力拉动）；随机障碍普通墙/超域。
 *  - arenaScale 未传时按球数推导；新增三角形地图；治疗量进 standings。
 *
 * v0.4.1：
 *  - 蜜蜂寿命改为“开始追踪后才计时”：orbit 未追踪时存在时间无限（最多 3 只），
 *    第一次追踪普通蜂 3s / 狂暴蜂 6s，追踪中断回 orbit 继续计时；snapshot.bees 增加 trackedOnce。
 *  - 奇门连环引爆：引爆全场地雷，主动引爆溅射范围 activeExplosionRadius=80。
 *  - 三角地图 sizeScale（1.12）由 main 乘入 arenaScale，sim 只按传入 scale 工作。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./data.js'));
  } else {
    root.BallSim = factory(root.GameData);
  }
})(typeof self !== 'undefined' ? self : this, function (GameData) {
  'use strict';

  if (!GameData || !GameData.RULES || !GameData.SKILLS || !GameData.BALL_BY_ID) {
    throw new Error('[BallSim] 需要先加载 js/data.js');
  }

  /* ---------------- 数据常量 ---------------- */
  const RULES = GameData.RULES;
  const SKILLS = GameData.SKILLS;
  const BALL_BY_ID = GameData.BALL_BY_ID;
  const LEGACY_ID_MAP = GameData.LEGACY_ID_MAP || {};
  const PALETTE = GameData.PALETTE || {};
  const VERSION = GameData.VERSION || '1.0.0';

  /* v1.2 通用效果词表（UI 只显示名字；data.js 缺失时用内置兜底） */
  const EFFECT_BY_ID = Object.create(null);
  if (Array.isArray(GameData.EFFECTS)) {
    GameData.EFFECTS.forEach(function (ef) {
      if (ef && ef.id) EFFECT_BY_ID[ef.id] = ef;
    });
  }
  const STATUS_FALLBACK = {
    slow: '减速', haste: '加速', root: '定身', evade: '闪避', immune: '免伤',
    phase: '虚化', superHeavy: '超重', armorBreak: '破甲', weakness: '虚弱',
    shield: '护盾', heal: '回复', reflect: '反伤', knockback: '击退', phaseWall: '穿墙',
    burn: '灼烧', poison: '中毒', spike: '尖刺', invuln: '免伤'
  };
  function effectName(kind) {
    const ef = EFFECT_BY_ID[kind];
    if (ef && ef.name) return ef.name;
    return STATUS_FALLBACK[kind] || String(kind);
  }

  /* 迁移别名：旧 ID 只用于旧链接兼容，内部统一用 B0001–B0010 */
  function normalizeBallId(raw) {
    const bid = (typeof raw === 'string') ? raw.trim() : String(raw);
    if (BALL_BY_ID[bid]) return bid;
    const legacy = LEGACY_ID_MAP[bid];
    if (legacy && BALL_BY_ID[legacy]) return legacy;
    return bid;
  }

  function hashStr(seed, s) {
    let h = (seed ^ 0x811C9DC5) >>> 0;
    const str = String(s == null ? '' : s);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h || 0x51ED270B) >>> 0;
  }

  const FIXED_DT = RULES.fixedDt || 1 / 120;
  /* 默认场地 / 规则：createMatch 可覆盖；比赛内一律用局部 arena 变量，不再引用模块级固定值 */
  const DEFAULT_ARENA = RULES.arena || { w: 760, h: 760 };
  const ARENA_SIZING = RULES.arenaSizing || { baseScale: 0.86, perBall: 0.06 };
  const ENERGY_RULE = RULES.energy || { perSecond: 1, start: 0 };
  const ENERGY_PREP = RULES.energyPrep || { after: 30, mult: 2 };
  const OBSTACLE_RULE = RULES.obstacles || {
    interval: 10, min: 1, max: 3, life: 3,
    sizeMin: 24, sizeMax: 34, superChance: 0.1, clearance: 60
  };
  const SUMMONS = GameData.SUMMONS || {};
  const COLL = RULES.collision || {};
  const SPAWN = RULES.spawn || { ring: 228, jitter: 28, margin: 99, aimJitter: 0.42 };
  const DEFAULT_SUDDEN = RULES.suddenDeath || { start: 60, dpsBase: 1.2, dpsRamp: 1.6 };
  const MAX_EVENTS = RULES.maxEvents || 600;
  const MAX_HAZARDS = RULES.maxHazards || 64;
  const MIN_LINEUP = RULES.minLineup || 2;
  const MAX_LINEUP = RULES.maxLineup || 8;
  const TIME_LIMIT = RULES.timeLimit || 300;

  /* v0.3 四种伤害类型（data 为唯一来源，缺失时用内置兜底 id；仅用于校验/快照） */
  const DAMAGE_TYPES = (Array.isArray(GameData.DAMAGE_TYPES) ? GameData.DAMAGE_TYPES : [
    { id: 'collision', name: '撞击伤害' },
    { id: 'direct', name: '直接伤害' },
    { id: 'dot', name: '持续伤害' },
    { id: 'true', name: '真实伤害' }
  ]).slice();
  const DAMAGE_TYPE_IDS = Object.create(null);
  DAMAGE_TYPES.forEach(function (dt) {
    if (dt && dt.id) DAMAGE_TYPE_IDS[dt.id] = true;
  });
  function resolveDamageType(id, fallback) {
    return DAMAGE_TYPE_IDS[id] ? id : (DAMAGE_TYPE_IDS[fallback] ? fallback : 'direct');
  }

  const BEE_DEFAULTS = {
    spawnInterval: 3, maxBees: 3, trackRadius: 180, beeLife: 3, beeDmg: 3, retargetRadius: 260,
    rageLife: 6, rageDmg: 8, rageCharges: 6, rageRefill: 3, beeRadius: 7
  };
  /* 蜜蜂环绕（未追踪时围绕蜂群转；三角/均分站位，随全局时间缓慢旋转） */
  const BEE_ORBIT_BASE = 30;       // 轨道半径 = 蜂群半径 + 30 + slot*3（30~36），更靠近蜂群
  const BEE_ORBIT_STEP = 3;
  const BEE_ORBIT_SPIN = 0.55;     // rad/s（约 11.4s 一圈，缓慢）
  const MAP_IDS = ['square', 'circle', 'triangle'];
  const MAP_SHAPES = { square: 'square', circle: 'circle', triangle: 'triangle' };
  const MIN_ARENA_SCALE = 0.3;
  const MAX_ARENA_SCALE = 2;
  const MIN_TIME_LIMIT = 5;
  const DEF_SOFTNESS = COLL.defSoftness || 60;
  const PAIR_COOLDOWN = COLL.pairCooldown || 0.42;
  const MIN_REL_SPEED = COLL.minRelSpeed || 40;
  const WALL_REST = COLL.wallRestitution != null ? COLL.wallRestitution : 1;
  const RESTITUTION = COLL.restitution != null ? COLL.restitution : 1;
  const SEPARATION = COLL.separation != null ? COLL.separation : 0.5;

  const TAU = Math.PI * 2;
  const EPS = 1e-9;
  const DOT_TICK = 0.25;           // 持续伤害结算间隔（契约 4.5.6）
  const DOT_EVENT_GAP = 0.5;       // dot 事件每目标节流
  const STORM_EVENT_GAP = 0.5;     // 决胜真伤事件每目标节流
  const BOUNCE_EVENT_GAP = 0.08;
  const WARP_EVENT_GAP = 0.1;
  const CAST_GLOW_TIME = 0.55;
  const MAX_SUB_STEPS = 64;        // 单次 step 最多吞并的固定步（防卡死）
  const SINGULARITY_CENTER_RADIUS = 75; // 引力井“被拉到中心”的判定半径（减速只挂给中心区敌人）

  const HAZARD_COLORS = {
    mine: PALETTE.orange || '#FF6B1A',
    fire: PALETTE.orange2 || '#FFB347',
    poison: '#4BE38A',
    gravity: PALETTE.violet || '#B060FF'
  };
  const COLOR_CYAN = PALETTE.cyan || '#54E6FF';
  const COLOR_DANGER = PALETTE.danger || '#FF4F6D';
  const COLOR_GOOD = PALETTE.good || '#7CFF9E';
  const COLOR_VIOLET = PALETTE.violet || '#B060FF';
  const COLOR_CREAM = PALETTE.cream || '#FFF4DC';

  /* ---------------- 小工具 ---------------- */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }
  function finiteOr(v, d) { return isFiniteNum(v) ? v : d; }
  function dist2(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
  }

  // mulberry32：确定性、可复现、足够均匀
  function makeRng(seed) {
    let s = (seed >>> 0);
    return function rng() {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let seedCounter = 0;
  function deriveSeed() {
    seedCounter = (seedCounter + 1) >>> 0;
    const now = Date.now() >>> 0;
    return ((now ^ Math.imul(seedCounter, 0x9E3779B1)) >>> 0) || 0x51ED270B;
  }

  /* ---------------- 事件优先级（超限时优先丢不重要的） ---------------- */
  function eventRank(ev) {
    if (!ev) return 0;
    switch (ev.type) {
      case 'over':
      case 'death':
      case 'cast':
      case 'ring':
        return 10; // 永不丢弃
      case 'heal':
        return 6;
      case 'explode':
        return 5;
      case 'chain':
        return 5;
      case 'spawn':
        return 4;
      case 'warp':
        return 3;
      case 'bounce':
        return 2;
      case 'hit':
        if (ev.kind === 'dot' || ev.kind === 'hazard') return 0;
        if (ev.kind === 'storm') return 1;
        return 4;
      default:
        return 2;
    }
  }

  /* ---------------- v1.1 地图参数解析 ---------------- */
  function resolveMapId(value) {
    if (value === undefined || value === null || value === '') return 'square';
    const id = String(value);
    const valid = (GameData.MAP_BY_ID && GameData.MAP_BY_ID[id]) ? true : (MAP_IDS.indexOf(id) >= 0);
    if (!valid) throw new Error('[BallSim] createMatch: 非法 map "' + id + '"，可选 square|circle|triangle');
    return id;
  }

  /* v0.4：未显式传 arenaScale 时按同场球数推导：arenaSizing.baseScale + perBall*(n-2) */
  function deriveArenaScale(ballCount) {
    const base = ARENA_SIZING.baseScale != null ? Number(ARENA_SIZING.baseScale) : 1;
    const per = ARENA_SIZING.perBall != null ? Number(ARENA_SIZING.perBall) : 0;
    const n = isFinite(ballCount) && ballCount >= 2 ? ballCount : 2;
    return base + per * (n - 2);
  }

  function resolveScale(value, ballCount) {
    if (value === undefined || value === null || value === '') return deriveArenaScale(ballCount);
    const n = Number(value);
    if (!isFinite(n) || n < MIN_ARENA_SCALE || n > MAX_ARENA_SCALE) {
      throw new Error('[BallSim] createMatch: arenaScale 必须是 ' + MIN_ARENA_SCALE + '–' + MAX_ARENA_SCALE + ' 之间的数字');
    }
    return n;
  }

  function resolveTimeLimit(value) {
    if (value === undefined || value === null || value === '') return TIME_LIMIT;
    const n = Number(value);
    if (!isFinite(n) || n < MIN_TIME_LIMIT) {
      throw new Error('[BallSim] createMatch: timeLimit 必须是 >= ' + MIN_TIME_LIMIT + ' 的数字');
    }
    return n;
  }

  function resolveSuddenDeath(value) {
    const out = {
      start: DEFAULT_SUDDEN.start,
      dpsBase: DEFAULT_SUDDEN.dpsBase,
      dpsRamp: DEFAULT_SUDDEN.dpsRamp
    };
    if (value === undefined || value === null || value === '') return out;
    if (typeof value !== 'object') throw new Error('[BallSim] createMatch: suddenDeath 必须是对象');
    const keys = ['start', 'dpsBase', 'dpsRamp'];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = value[k];
      if (v === undefined || v === null) continue;
      const n = Number(v);
      if (!isFinite(n) || n < 0) throw new Error('[BallSim] createMatch: suddenDeath.' + k + ' 必须是 >= 0 的数字');
      out[k] = n;
    }
    return out;
  }

  /* 排位决斗专用属性修正（只影响本场；不改变大乱斗的基础数据） */
  function resolveStatMods(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('[BallSim] createMatch: statMods 必须是对象');
    }
    const out = Object.create(null);
    const keys = ['hpMul', 'atkMul', 'defMul', 'spdMul', 'sizeMul'];
    let any = false;
    Object.keys(value).forEach(function (ballId) {
      if (!BALL_BY_ID[ballId]) return;
      const src = value[ballId];
      if (!src || typeof src !== 'object') return;
      const mod = Object.create(null);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (src[k] === undefined || src[k] === null) continue;
        const n = Number(src[k]);
        if (!isFinite(n) || n < 0.25 || n > 2.5) {
          throw new Error('[BallSim] createMatch: statMods.' + ballId + '.' + k + ' 必须在 0.25–2.5 之间');
        }
        mod[k] = n;
      }
      if (Object.keys(mod).length) { out[ballId] = mod; any = true; }
    });
    return any ? out : null;
  }

  /* 对战机制开关（首页选择；目前支持速胜时刻 / 随机障碍）
   * 缺省值以 data.js 的 DEFAULT_MECHANISMS 为准（v0.4 均为关闭）。 */
  function resolveMechanisms(value) {
    const dataDefault = (GameData.DEFAULT_MECHANISMS && GameData.DEFAULT_MECHANISMS.suddenDeath != null)
      ? !!GameData.DEFAULT_MECHANISMS.suddenDeath
      : false;
    const obstacleDefault = (GameData.DEFAULT_MECHANISMS && GameData.DEFAULT_MECHANISMS.randomObstacles != null)
      ? !!GameData.DEFAULT_MECHANISMS.randomObstacles
      : false;
    const energyDefault = (GameData.DEFAULT_MECHANISMS && GameData.DEFAULT_MECHANISMS.energyPrep != null)
      ? !!GameData.DEFAULT_MECHANISMS.energyPrep
      : false;
    const out = { suddenDeath: dataDefault, randomObstacles: obstacleDefault, energyPrep: energyDefault };
    if (value === undefined || value === null) return out;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('[BallSim] createMatch: mechanisms 必须是对象');
    }
    if (value.suddenDeath !== undefined && value.suddenDeath !== null) {
      out.suddenDeath = !!value.suddenDeath;
    }
    if (value.randomObstacles !== undefined && value.randomObstacles !== null) {
      out.randomObstacles = !!value.randomObstacles;
    }
    if (value.energyPrep !== undefined && value.energyPrep !== null) {
      out.energyPrep = !!value.energyPrep;
    }
    return out;
  }

  /* ============================================================
   * createMatch
   * ============================================================ */
  function createMatch(options) {
    options = options || {};

    /* ---- 校验阵容 ---- */
    const lineupInput = options.lineup;
    if (!Array.isArray(lineupInput)) throw new Error('[BallSim] createMatch: lineup 必须是数组');
    const lineup = [];
    const seen = Object.create(null);
    for (let i = 0; i < lineupInput.length; i++) {
      const raw = lineupInput[i];
      const bid = normalizeBallId(raw);
      if (!BALL_BY_ID[bid]) throw new Error('[BallSim] createMatch: 未知球 id "' + String(raw) + '"');
      if (seen[bid]) throw new Error('[BallSim] createMatch: 球 id 重复 "' + bid + '"');
      seen[bid] = true;
      lineup.push(bid);
    }
    if (lineup.length < MIN_LINEUP || lineup.length > MAX_LINEUP) {
      throw new Error('[BallSim] createMatch: 阵容必须是 ' + MIN_LINEUP + '–' + MAX_LINEUP + ' 个球，收到 ' + lineup.length);
    }

    /* ---- 种子 ---- */
    let seed = options.seed;
    if (seed === undefined || seed === null) {
      seed = deriveSeed();
    } else {
      seed = Number(seed);
      if (!isFinite(seed)) throw new Error('[BallSim] createMatch: seed 必须是有限数字');
      seed = (seed >>> 0);
    }

    /* ---- 地图 / 场地 / 时间规则 ---- */
    const mapId = resolveMapId(options.map);
    const mapDef = GameData.MAP_BY_ID ? GameData.MAP_BY_ID[mapId] : null;
    const mapShape = (mapDef && MAP_SHAPES[mapDef.shape]) ? MAP_SHAPES[mapDef.shape]
      : (MAP_SHAPES[mapId] || 'square');
    const shape = mapShape;
    const scale = resolveScale(options.arenaScale, lineup.length);
    const timeLimit = resolveTimeLimit(options.timeLimit);
    const sudden = resolveSuddenDeath(options.suddenDeath);
    const statMods = resolveStatMods(options.statMods);
    const mechanisms = resolveMechanisms(options.mechanisms);
    const arenaW = DEFAULT_ARENA.w * scale;
    const arenaH = DEFAULT_ARENA.h * scale;
    const arenaRadius = Math.min(arenaW, arenaH) * 0.5;
    const cx = arenaW * 0.5;
    const cy = arenaH * 0.5;

    /* ---- 三角形场地：等边三角形，顶点朝上，外接圆半径 = scaled arena 半径 ---- */
    let triangle = null;
    if (shape === 'triangle') {
      const R = arenaRadius;
      const s3 = Math.sqrt(3) / 2;
      const verts = [
        { x: cx, y: cy - R },
        { x: cx + R * s3, y: cy + R * 0.5 },
        { x: cx - R * s3, y: cy + R * 0.5 }
      ];
      const edges = [];
      for (let i = 0; i < 3; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % 3];
        let ex = b.x - a.x;
        let ey = b.y - a.y;
        const len = Math.sqrt(ex * ex + ey * ey) || 1;
        let nx = -ey / len;
        let ny = ex / len;
        // 让法线指向三角形内部（中心方向）
        if (nx * (cx - a.x) + ny * (cy - a.y) < 0) { nx = -nx; ny = -ny; }
        edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, nx: nx, ny: ny, d: nx * a.x + ny * a.y, len: len });
      }
      triangle = {
        vertices: verts,
        edges: edges,
        radius: R,
        inradius: R * 0.5,
        center: { x: cx, y: cy }
      };
    }

    const arenaInfo = {
      w: arenaW,
      h: arenaH,
      shape: shape,
      radius: arenaRadius,
      mapId: mapId,
      scale: scale
    };
    if (triangle) {
      arenaInfo.triangle = {
        vertices: triangle.vertices,
        radius: triangle.radius,
        inradius: triangle.inradius,
        center: triangle.center
      };
    }

    /* ---- 核心状态 ---- */
    const rand = makeRng(seed);
    const entities = [];
    const hazardList = [];
    const obstacleList = [];
    const pendingKills = [];
    const pairCd = Object.create(null);
    let events = [];
    let hazardSeq = 0;
    let obstacleSeq = 0;
    let thunderSeq = 0;              // 天雷触发序号（确定性自增）
    let beeSeq = 0;                  // 蜜蜂序号（确定性自增）
    let accumulator = 0;
    let stormTimer = 0;
    let suddenAnnounced = false;
    let obstacleTimer = 0;

    /* ---- 4.1 同时伤害结算缓冲 ----
     * damageQueue：本帧主伤害（碰撞/AOE 等）先收集，全部球对处理完后统一结算；
     * followUpQueue：受控二次队列（反伤等），只允许统一结算，不允许在伤害管线里递归扣血。 */
    let damageQueue = [];
    let followUpQueue = [];
    let collisionLog = [];           // 本步有效碰撞记录（结算后补挂被动/触发天雷）
    let pendingThunder = [];         // 已预警、等待落下的天雷

    const stats = Object.create(null);
    const skillUsage = Object.create(null);
    Object.keys(SKILLS).forEach(function (sid) { skillUsage[sid] = 0; });

    const match = {
      seed: seed,
      time: 0,
      status: 'running',
      winnerId: null,
      draw: false,
      judged: false,             // 4.2 双杀判定：true 表示胜者由同帧死亡裁决产生
      arena: arenaInfo,
      mapId: mapId,
      timeLimit: timeLimit,
      suddenDeath: sudden,
      mechanisms: mechanisms,
      lineup: lineup.slice(),
      entities: entities,
      hazards: hazardList,
      obstacles: obstacleList,
      stats: stats,
      // 调试用：每个技能实际触发次数（20 个技能全覆盖自查用；UI 不消费）
      skillUsage: skillUsage,
      step: step,
      drainEvents: drainEvents,
      getSnapshot: getSnapshot,
      getStandings: getStandings
    };

    /* ---------------- 事件 ---------------- */
    function pushEvent(ev) {
      if (!ev) return;
      if (events.length >= MAX_EVENTS) {
        let dropIdx = -1;
        let worstRank = 99;
        for (let i = 0; i < events.length; i++) {
          const r = eventRank(events[i]);
          if (r < worstRank) {
            worstRank = r;
            dropIdx = i;
            if (r === 0) break;
          }
        }
        if (dropIdx >= 0 && worstRank < 10) {
          events.splice(dropIdx, 1);
        } else if (eventRank(ev) < 10) {
          return; // 缓冲全是不可丢事件，放弃这条低优先级事件
        }
      }
      events.push(ev);
    }

    function emit(ev) { pushEvent(ev); }

    function drainEvents() {
      const out = events;
      events = [];
      return out;
    }

    /* ---------------- 实体构建 ---------------- */
    function makeEntity(id, ballId) {
      const ball = BALL_BY_ID[ballId];
      const s = ball.stats;
      const mod = statMods && statMods[ballId] ? statMods[ballId] : null;
      const hpMul = mod && mod.hpMul != null ? mod.hpMul : 1;
      const atkMul = mod && mod.atkMul != null ? mod.atkMul : 1;
      const defMul = mod && mod.defMul != null ? mod.defMul : 1;
      const spdMul = mod && mod.spdMul != null ? mod.spdMul : 1;
      const sizeMul = mod && mod.sizeMul != null ? mod.sizeMul : 1;
      const passives = Object.create(null);
      const activeSkills = [];
      const skillList = [];
      for (let i = 0; i < ball.skills.length; i++) {
        const sk = SKILLS[ball.skills[i]];
        if (!sk) continue;
        skillList.push(sk);
        if (sk.kind === 'active') activeSkills.push(sk);
        else passives[sk.id] = sk;
      }

      const e = {
        id: id,
        ballId: ball.id,
        name: ball.name,
        en: ball.en,
        color: ball.color,
        color2: ball.color2,
        look: ball.look,
        tags: Array.isArray(ball.tags) ? ball.tags.slice() : [],
        summons: Array.isArray(ball.summons) ? ball.summons.slice() : [],
        x: 0, y: 0, vx: 0, vy: 0,
        r: s.size * sizeMul,
        baseSpeed: s.spd * spdMul,
        atkBase: s.atk * atkMul,
    atkBonus: 0,
        def: s.def * defMul,
        hp: s.hp * hpMul,
        maxHp: s.hp * hpMul,
        alive: true,
        deathTime: null,
        spawnTime: 0,
        mass: 1,
        invMass: 1,
        dmgTakenMult: 1,               // 静态减伤（phase 等；armor 按血量动态结算）
        flash: 0,
        castGlow: null,
        facing: { x: 0, y: 1 },
        passives: passives,
        skillList: skillList,
        activeSkills: activeSkills,
        activeSkill: activeSkills.length > 0 ? activeSkills[0] : null,
        energy: ENERGY_RULE.start != null ? Number(ENERGY_RULE.start) : 0,
        energyMax: 0,
        energyCost: 0,
        status: Object.create(null),   // burn / poison / weakness / armorBreak
        slows: [],                     // 同类取最强、不叠层、刷新时长
        hastes: [],
        root: null,
        phaseState: null,              // 虚化（免伤 + 免疫碰撞）
        immuneState: null,             // 免伤（与虚化同时存在时由虚化覆盖）
        spike: null,
        spikeTick: 0,
        shield: null,                  // 单条护盾（取最高值/刷新时长）
        shieldTotal: 0,
        dashTime: 0,
        dashTrailTimer: 0,
        dashTrail: null,
        overTimer: 0,
        overParams: null,
        zapTimer: 0,
        trapTimer: 0,
        dotTimer: 0,
        poisonHeal: null,              // 巫医毒伤回复：{sec, used}
        bees: [],                      // 蜂群蜜蜂（swarm_hive / swarm_rage）
        beeTimer: 0,                   // 下一只蜜蜂生成倒计时
        beeRageQuota: 0,               // 狂暴蜂剩余额度
        lastBounceAt: -1,
        lastWarpAt: -1,
        lastDotEvAt: -1,
        lastStormEvAt: -1,
        _pendingDeath: false
      };

      // v0.4 能量：activeSkill 的能量需求即能量上限（多余溢出最多 1 点）
      if (e.activeSkill) {
        const actP = e.activeSkill.params || {};
        const cost = actP.energyCost != null ? Number(actP.energyCost) : 1;
        e.energyCost = cost > 0 ? cost : 1;
        e.energyMax = e.energyCost;
        if (!(e.energy >= 0)) e.energy = 0;
      }

      // 质量（gravity 被动 ×massMult）
      e.mass = e.r * e.r;
      if (passives.gravity) e.mass *= (passives.gravity.params.massMult || 1);
      e.invMass = 1 / e.mass;

      // 静态受伤倍率：phase（armor 在 damageTakenMultOf 中按当前血量结算）
      if (passives.phase) e.dmgTakenMult *= (passives.phase.params.dmgMult != null ? passives.phase.params.dmgMult : 1);

      // 布雷计时
      if (passives.trapmaker) e.trapTimer = passives.trapmaker.params.interval || 2.4;
      // 蜂群召唤计时
      if (passives.swarm_hive) {
        const hp = passives.swarm_hive.params || {};
        e.beeTimer = (hp.spawnInterval != null ? hp.spawnInterval : BEE_DEFAULTS.spawnInterval);
      }

      stats[ball.id] = {
        dealt: 0,
        taken: 0,
        kills: 0,
        casts: 0,
        heal: 0,
        maxHit: 0,          // 单次最大伤害（4.2 双杀判定第三顺位）
        aliveTime: 0,
        hpPct: 1,
        alive: true,
        deathTime: null
      };

      return e;
    }

    /* ---------------- 场地钳制工具（圆/方/三角共用） ---------------- */
    function triangleEdgeDist(edge, x, y) {
      return edge.nx * x + edge.ny * y - edge.d;
    }

    // 把点钳进三角形（内缩 radius）：沿各内法线迭代推出到边界内
    function clampPointToTriangle(px, py, radius) {
      let x = finiteOr(px, cx);
      let y = finiteOr(py, cy);
      const rr = Math.max(0, radius);
      for (let iter = 0; iter < 5; iter++) {
        let moved = false;
        for (let i = 0; i < triangle.edges.length; i++) {
          const edge = triangle.edges[i];
          const d = triangleEdgeDist(edge, x, y);
          if (d < rr) {
            const push = rr - d;
            x += edge.nx * push;
            y += edge.ny * push;
            moved = true;
          }
        }
        if (!moved) break;
      }
      return { x: x, y: y };
    }

    function triangleContains(x, y, margin) {
      const m = margin || 0;
      for (let i = 0; i < triangle.edges.length; i++) {
        if (triangleEdgeDist(triangle.edges[i], x, y) < m) return false;
      }
      return true;
    }

    // 把一个点钳进场地（考虑半径）：square 各边内缩 radius；circle 到圆心距离 <= R-radius；triangle 内缩多边形
    function clampPointToArena(px, py, radius) {
      if (shape === 'triangle') return clampPointToTriangle(px, py, radius);
      const x = finiteOr(px, cx);
      const y = finiteOr(py, cy);
      if (shape === 'circle') {
        const dx = x - cx;
        const dy = y - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const maxD = Math.max(0, arenaRadius - radius);
        if (d > maxD && d > EPS) {
          const k = maxD / d;
          return { x: cx + dx * k, y: cy + dy * k };
        }
        if (d <= maxD) return { x: x, y: y };
        return { x: cx, y: cy };
      }
      return {
        x: clamp(x, radius, Math.max(radius, arenaW - radius)),
        y: clamp(y, radius, Math.max(radius, arenaH - radius))
      };
    }

    /* ---------------- 生成 / 出生（缩放 / 圆形 / 三角 / 1v1 都要可靠） ---------------- */
    // 基础环半径按 arenaScale 缩放，再按“最胖的球”和相邻球半径和收紧，保证初始不越界/不重叠
    const halfSize = shape === 'triangle' ? triangle.inradius : Math.min(arenaW, arenaH) * 0.5;
    const ballRadii = [];
    let maxBallRadius = 0;
    for (let i = 0; i < lineup.length; i++) {
      const sm = statMods && statMods[lineup[i]] && statMods[lineup[i]].sizeMul != null ? statMods[lineup[i]].sizeMul : 1;
      const rr = BALL_BY_ID[lineup[i]].stats.size * sm;
      ballRadii.push(rr);
      if (rr > maxBallRadius) maxBallRadius = rr;
    }
    const baseRing = (SPAWN.ring || 228) * scale;
    const feasibleMax = Math.max(0, halfSize - maxBallRadius - 2);
    // 相邻两球不重叠所需的最小环半径：弦长 2*ring*sin(π/n) >= r_i + r_j
    let requiredRing = 0;
    if (lineup.length === 2) {
      requiredRing = (ballRadii[0] + ballRadii[1]) * 0.5;
    } else if (lineup.length > 2) {
      const sinHalf = Math.sin(Math.PI / lineup.length);
      for (let i = 0; i < lineup.length; i++) {
        const j = (i + 1) % lineup.length;
        const need = (ballRadii[i] + ballRadii[j]) / (2 * sinHalf);
        if (need > requiredRing) requiredRing = need;
      }
    }
    requiredRing = Math.min(requiredRing + 2, feasibleMax);

    let spawnRing = Math.min(baseRing, halfSize - maxBallRadius - 12);
    if (!(spawnRing > 0)) spawnRing = feasibleMax * 0.5;
    // 契约要求 ring >= maxBallRadius + 6；场地过小时以“不出界/不重叠”优先
    spawnRing = Math.max(spawnRing, Math.min(maxBallRadius + 6, feasibleMax));
    let spawnJitter = Math.max(0, (SPAWN.jitter || 0) * scale);
    if (requiredRing > 0) {
      // jitter 只占用剩余空间：jitter 后仍不小于 requiredRing
      spawnJitter = Math.min(spawnJitter, Math.max(0, feasibleMax - requiredRing));
      spawnRing = Math.max(spawnRing, requiredRing + spawnJitter);
    }
    spawnRing = clamp(spawnRing, 0, feasibleMax);
    const ringFloor = Math.min(Math.max(maxBallRadius + 6, requiredRing), feasibleMax);
    const aimJitter = SPAWN.aimJitter != null ? SPAWN.aimJitter : 0.42;
    const twoBallDuel = lineup.length === 2;

    // 极端比例（例如 8 球 + 小 scale）下环形均布可能仍不够：用确定性松弛把初始重叠推开
    function relaxSpawnOverlaps() {
      const n = entities.length;
      let iter = 0;
      let moved = true;
      while (moved && iter < 160) {
        moved = false;
        iter++;
        for (let i = 0; i < n; i++) {
          const a = entities[i];
          for (let j = i + 1; j < n; j++) {
            const b = entities[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let d = Math.sqrt(dx * dx + dy * dy);
            const minD = a.r + b.r + 0.5;
            if (d >= minD) continue;
            if (d < 1e-6) { dx = 1; dy = 0; d = 1e-6; }
            const nx = dx / d;
            const ny = dy / d;
            const need = minD - d;
            const wa = a.invMass / (a.invMass + b.invMass);
            const wb = 1 - wa;
            a.x -= nx * need * wa;
            a.y -= ny * need * wa;
            b.x += nx * need * wb;
            b.y += ny * need * wb;
            const pa = clampPointToArena(a.x, a.y, a.r);
            a.x = pa.x; a.y = pa.y;
            const pb = clampPointToArena(b.x, b.y, b.r);
            b.x = pb.x; b.y = pb.y;
            moved = true;
          }
        }
      }
    }

    for (let i = 0; i < lineup.length; i++) {
      const e = makeEntity(i, lineup[i]);
      // 2 球决斗固定在对径方向（0 / π）；其余均匀分布
      const angle = twoBallDuel ? (i * Math.PI) : (-Math.PI * 0.5 + (i / lineup.length) * TAU);
      let ringDist = spawnRing + (rand() * 2 - 1) * spawnJitter;
      ringDist = clamp(ringDist, ringFloor, feasibleMax);
      const placed = clampPointToArena(cx + Math.cos(angle) * ringDist, cy + Math.sin(angle) * ringDist, e.r);
      e.x = placed.x;
      e.y = placed.y;
      e._aimOffset = (rand() * 2 - 1) * aimJitter;
      entities.push(e);
    }

    relaxSpawnOverlaps();

    // 出生事件在最终位置发（松弛后朝向仍指向场地中心 + 原始 aimJitter）
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      const aim = Math.atan2(cy - e.y, cx - e.x) + (e._aimOffset || 0);
      e.facing.x = Math.cos(aim);
      e.facing.y = Math.sin(aim);
      e.vx = e.facing.x * e.baseSpeed;
      e.vy = e.facing.y * e.baseSpeed;
      emit({ type: 'spawn', x: e.x, y: e.y, entityId: e.id, ballId: e.ballId, color: e.color });
    }

    /* ---------------- 通用查询 ---------------- */
    function byId(id) {
      return (id >= 0 && id < entities.length) ? entities[id] : null;
    }

    function nearestEnemy(e, maxDist) {
      let best = null;
      let bestD = Infinity;
      for (let i = 0; i < entities.length; i++) {
        const o = entities[i];
        if (!o.alive || o === e) continue;
        const d = dist2(e.x, e.y, o.x, o.y);
        if (d < bestD) { bestD = d; best = o; }
      }
      if (!best) return null;
      if (maxDist != null && bestD > maxDist * maxDist) return null;
      return best;
    }

    function markSkill(sid) {
      if (skillUsage[sid] !== undefined) skillUsage[sid] += 1;
    }

    /* ---------------- 状态应用 ---------------- */
    function applyBurn(target, src) {
      const p = src.passives.burn.params;
      const maxStacks = p.maxStacks != null ? p.maxStacks : 1;
      let st = target.status.burn;
      if (!st) st = target.status.burn = { stacks: 0, remaining: 0, dur: p.dur, dps: p.dps, src: src };
      st.stacks = Math.min(maxStacks, st.stacks + 1);
      st.remaining = p.dur;
      st.dur = p.dur;
      st.dps = p.dps;
      st.src = src;
      markSkill('burn');
    }

    function applyPoison(target, src) {
      const p = src.passives.venom.params;
      const maxStacks = p.maxStacks != null ? p.maxStacks : 3;
      let st = target.status.poison;
      if (!st) st = target.status.poison = { stacks: 0, remaining: 0, dur: p.dur, dps: p.dps, src: src };
      st.stacks = Math.min(maxStacks, st.stacks + 1);
      st.remaining = p.dur;
      st.dur = p.dur;
      st.dps = p.dps;
      st.src = src;
      markSkill('venom');
    }

    /* 减速/加速：同类取最强、不叠层、刷新持续时间；不同类可共存 */
    function applySlow(e, mult, dur, sourceId) {
      if (!(mult > 0 && mult < 1) || !(dur > 0)) return;
      const id = sourceId || 'slow';
      const list = e.slows;
      for (let i = 0; i < list.length; i++) {
        if (list[i].id !== id) continue;
        if (mult < list[i].mult) list[i].mult = mult;       // 更强（更慢）
        if (dur > list[i].remaining) list[i].remaining = dur;
        if (dur > list[i].dur) list[i].dur = dur;
        return;
      }
      list.push({ mult: mult, remaining: dur, dur: dur, id: id });
      if (list.length > 12) list.shift();
    }

    function applyHaste(e, mult, dur, sourceId) {
      if (!(mult > 0) || !(dur > 0)) return;
      const id = sourceId || 'haste';
      const list = e.hastes;
      for (let i = 0; i < list.length; i++) {
        if (list[i].id !== id) continue;
        if (mult > list[i].mult) list[i].mult = mult;       // 更强（更快）
        if (dur > list[i].remaining) list[i].remaining = dur;
        if (dur > list[i].dur) list[i].dur = dur;
        return;
      }
      list.push({ mult: mult, remaining: dur, dur: dur, id: id });
      if (list.length > 12) list.shift();
    }

    function applyRoot(e, dur) {
      if (!(dur > 0)) return;
      if (!e.root) e.root = { remaining: dur, dur: dur };
      else {
        if (dur > e.root.remaining) e.root.remaining = dur;
        if (dur > e.root.dur) e.root.dur = dur;
      }
    }

    /* 虚弱/破甲：不可叠加，刷新时长；统一 50% */
    function applyDebuff(e, kind, mult, dur) {
      if (!(dur > 0)) return;
      const cur = e.status[kind];
      if (!cur) { e.status[kind] = { mult: mult, remaining: dur, dur: dur }; return; }
      cur.mult = mult;
      if (dur > cur.remaining) cur.remaining = dur;
      if (dur > cur.dur) cur.dur = dur;
    }

    /* 免伤/虚化：不叠层；同时存在时虚化优先（isImmuneNow 统一判定） */
    function applyImmunity(e, kind, dur) {
      if (!(dur > 0)) return;
      if (kind === 'phase') {
        if (!e.phaseState) e.phaseState = { remaining: dur, dur: dur };
        else {
          if (dur > e.phaseState.remaining) e.phaseState.remaining = dur;
          if (dur > e.phaseState.dur) e.phaseState.dur = dur;
        }
      } else {
        if (!e.immuneState) e.immuneState = { remaining: dur, dur: dur };
        else {
          if (dur > e.immuneState.remaining) e.immuneState.remaining = dur;
          if (dur > e.immuneState.dur) e.immuneState.dur = dur;
        }
      }
    }

    function isImmuneNow(e) {
      return !!((e.phaseState && e.phaseState.remaining > 0) || (e.immuneState && e.immuneState.remaining > 0));
    }

    /* v0.4 穿墙：拥有 phase/phaseWall 被动，或处于虚化状态（wraith）的单位可穿普通墙 */
    function hasPhaseWall(e) {
      return !!(e.passives.phase || e.passives.phaseWall ||
        (e.phaseState && e.phaseState.remaining > 0));
    }

    /* 通用闪避：取所有被动里最高的概率（v0.3 data 已无闪避来源；保留通用规则实现，
     * 不引用任何具体技能 id，未来 data 增加带 chance 的被动即可生效）。 */
    function evasionChanceOf(e) {
      let c = 0;
      const ps = e.passives;
      for (const k in ps) {
        if (!Object.prototype.hasOwnProperty.call(ps, k)) continue;
        const p = ps[k] && ps[k].params;
        if (p && p.chance != null && p.chance > 0 && p.chance <= 1 && p.chance > c) c = p.chance;
      }
      return c;
    }

    function slowFactor(e) {
      let m = 1;
      for (let i = 0; i < e.slows.length; i++) {
        if (e.slows[i].remaining > 0 && e.slows[i].mult < m) m = e.slows[i].mult;
      }
      return m;
    }

    function hasteFactor(e) {
      let m = 1;
      for (let i = 0; i < e.hastes.length; i++) {
        if (e.hastes[i].remaining > 0) m *= e.hastes[i].mult;
      }
      return m;
    }

    function speedMultOf(e) {
      const rooted = e.root && e.root.remaining > 0;
      if (rooted) return 0;
      // 减速下限 10%；加速上限沿用 CONTRACT 的总倍率 2.4
      return clamp(Math.max(0.1, slowFactor(e)) * hasteFactor(e), 0.1, 2.4);
    }

    function desiredSpeedOf(e) {
      return clamp(e.baseSpeed * speedMultOf(e), 0, e.baseSpeed * 2.4);
    }

    /* 护盾：单条；不叠层，取最高护盾值 / 刷新时长 */
    function addShield(e, amount, dur) {
      if (!(amount > 0) || !(dur > 0)) return;
      if (!e.shield) {
        e.shield = { amount: amount, remaining: dur, dur: dur };
      } else {
        if (amount > e.shield.amount) e.shield.amount = amount;
        if (dur > e.shield.remaining) e.shield.remaining = dur;
        if (dur > e.shield.dur) e.shield.dur = dur;
      }
      syncShield(e);
    }

    function syncShield(e) {
      e.shieldTotal = (e.shield && e.shield.amount > 0 && e.shield.remaining > 0) ? e.shield.amount : 0;
    }

    function adjustPhaseAtk(e, delta) {
      if (!e || !e.passives || !e.passives.phase) return;
      const p = e.passives.phase.params || {};
      const lo = p.atkBonusMin != null ? p.atkBonusMin : -10;
      const hi = p.atkBonusMax != null ? p.atkBonusMax : 20;
      e.atkBonus = Math.max(lo, Math.min(hi, (e.atkBonus || 0) + delta));
    }

    function attackMultOf(e) {
      let m = 1;
      if (e.status.weakness && e.status.weakness.remaining > 0) m *= e.status.weakness.mult;
      return m;
    }

    /* 黑洞在自己引力井内：受到伤害降低（data.selfDmgTakenMult） */
    function ownWellOf(e) {
      for (let i = 0; i < hazardList.length; i++) {
        const h = hazardList[i];
        if (h.kind !== 'gravity' || h.ownerId !== e.id) continue;
        if (dist2(e.x, e.y, h.x, h.y) <= h.r * h.r) return h;
      }
      return null;
    }

    function damageTakenMultOf(target) {
      let m = target.dmgTakenMult;
      // v0.4 重甲：常驻 15% 减伤；hp/maxHp <= 30% 时替换为 30% 减伤（不叠加）
      if (target.passives.armor) {
        const ap = target.passives.armor.params || {};
        const baseMult = ap.mult != null ? ap.mult : 0.85;
        const lowThreshold = ap.lowHpThreshold != null ? ap.lowHpThreshold : 0.30;
        const lowMult = ap.lowHpMult != null ? ap.lowHpMult : 0.70;
        const ratio = target.maxHp > 0 ? target.hp / target.maxHp : 1;
        m *= (ratio <= lowThreshold + 1e-9) ? lowMult : baseMult;
      }
      const well = ownWellOf(target);
      if (well && well.selfDmgTakenMult != null) m *= well.selfDmgTakenMult;
      return m;
    }

    /* ============================================================
     * 4.1 伤害管线：收集 → 统一结算 → 受控二次队列
     * opts: { kind, damageType, dot, reflect, trueDamage, canReflect,
     *         ignoreShield, poison, color, x, y, bee, fromSummon, summonId }
     * damageType: 'collision' 撞击 | 'direct' 直接 | 'dot' 持续 | 'true' 真实
     *   - collision：raw = 攻击力 × 攻击修正 × 速度系数（调用方算好）；吃防御/减伤/护盾
     *   - direct：raw = 固定值；吃防御/减伤/护盾
     *   - dot（v0.4）：raw = 固定值；吃防御/减伤/护盾，也吃闪避；不吃反伤
     *   - true：raw = 最终伤害；无视防御/减伤/护盾
     * ============================================================ */
    function queueDamage(src, target, raw, opts) {
      if (match.status === 'over') return null;
      if (!target || !target.alive || target.hp <= 0) return null;
      if (!(raw > 0)) return null;
      const intent = {
        src: src || null,
        target: target,
        raw: raw,
        opts: opts || {},
        total: 0,
        absorbed: 0,
        hpDmg: 0
      };
      damageQueue.push(intent);
      return intent;
    }

    function resolveDamageIntent(intent) {
      const target = intent.target;
      const src = intent.src;
      const opts = intent.opts || {};
      if (!target || !target.alive || target.hp <= 0) return 0;
      if (match.status === 'over') return 0;

      const dmgType = resolveDamageType(
        opts.damageType,
        opts.trueDamage ? 'true' : (opts.dot ? 'dot' : 'direct')
      );
      const isDot = dmgType === 'dot';
      const isTrue = dmgType === 'true';
      const isReflect = !!opts.reflect;
      const kind = opts.kind || 'hit';

      // v0.4：免伤/虚化 = 完全不受伤（含真实伤害；真实伤害只无视防御/减伤/护盾）
      if (isImmuneNow(target)) return 0;

      // 闪避：撞击/直接/持续都可被闪避；取最高概率，不做加法；真实伤害不可闪避
      if (!isTrue && opts.canEvade !== false) {
        const evadeChance = evasionChanceOf(target);
        if (evadeChance > 0 && rand() < evadeChance) {
          markSkill('evade');
          return 0;
        }
      }

      const mitigation = damageTakenMultOf(target);
      let total = intent.raw;
      if (isTrue) {
        // 真实伤害：raw = 最终伤害
        total = intent.raw;
      } else {
        // 撞击 / 直接 / 持续伤害（v0.4）：防御 + 减伤 (+ 破甲)
        let defEff = target.def;
        if (target.status.armorBreak && target.status.armorBreak.remaining > 0) {
          defEff *= (target.status.armorBreak.mult != null ? target.status.armorBreak.mult : 0.5);
        }
        total = intent.raw * mitigation * (1 - defEff / (defEff + DEF_SOFTNESS));
        if (target.passives.armor) markSkill('armor');
      }
      if (!(total > 0)) return 0;

      // 护盾：吸收撞击/直接/持续伤害（真实伤害无视护盾）
      let absorbed = 0;
      if (!isTrue && target.shield && !opts.ignoreShield) {
        const take = Math.min(target.shield.amount, total);
        if (take > 0) {
          target.shield.amount -= take;
          absorbed = take;
          syncShield(target);
        }
      }

      const hpDmg = Math.max(0, total - absorbed);
      intent.total = total;
      intent.absorbed = absorbed;
      intent.hpDmg = hpDmg;

      if (hpDmg > 0) {
        target.hp = Math.max(0, target.hp - hpDmg);
        target.flash = isDot ? Math.max(target.flash, 0.4) : 1;
        stats[target.ballId].taken += hpDmg;
        if (src) {
          if (stats[src.ballId]) {
            stats[src.ballId].dealt += hpDmg;
            if (hpDmg > stats[src.ballId].maxHit) stats[src.ballId].maxHit = hpDmg;
          }
          // 巫医：只有毒伤触发回复；以实际毒伤为基数，每秒累计上限
          if (opts.poison && src.passives.venom) {
            const vp = src.passives.venom.params;
            const healPct = vp.healPct != null ? vp.healPct : 0;
            const cap = vp.healCapPerSecond != null ? vp.healCapPerSecond : 10;
            if (healPct > 0 && src.alive && src.hp > 0 && cap > 0) {
              const sec = Math.floor(match.time + 1e-9);
              if (!src.poisonHeal || src.poisonHeal.sec !== sec) src.poisonHeal = { sec: sec, used: 0 };
              const room = Math.max(0, cap - src.poisonHeal.used);
              const heal = Math.min(hpDmg * healPct, room);
              if (heal > 0) {
                src.hp = Math.min(src.maxHp, src.hp + heal);
                src.poisonHeal.used += heal;
                stats[src.ballId].heal += heal;
                if (heal >= 0.5) {
                  emit({
                    type: 'heal', x: src.x, y: src.y, amount: Math.round(heal * 10) / 10,
                    color: COLOR_GOOD, entityId: src.id, kind: 'venom'
                  });
                }
              }
            }
          }
        }
      }

      // 命中事件（带伤害类型；kind 保持旧值兼容渲染）
      const evColor = opts.color || (src ? src.color : COLOR_DANGER);
      const evX = opts.x != null ? opts.x : target.x;
      const evY = opts.y != null ? opts.y : target.y;
      const srcId = src ? src.id : null;
      if (kind === 'storm') {
        if (match.time - target.lastStormEvAt >= STORM_EVENT_GAP) {
          target.lastStormEvAt = match.time;
          emit({
            type: 'hit', x: evX, y: evY, amount: Math.max(1, Math.round(total)),
            color: COLOR_DANGER, sourceId: null, targetId: target.id,
            kind: 'storm', damageType: dmgType
          });
        }
      } else if (isDot) {
        if (match.time - target.lastDotEvAt >= DOT_EVENT_GAP) {
          target.lastDotEvAt = match.time;
          emit({
            type: 'hit', x: evX, y: evY, amount: Math.round(total * 10) / 10,
            color: evColor, sourceId: srcId, targetId: target.id,
            kind: kind, damageType: dmgType
          });
        }
      } else if (total >= 0.5) {
        const ev = {
          type: 'hit', x: evX, y: evY, amount: Math.round(total),
          color: evColor, sourceId: srcId, targetId: target.id,
          kind: kind, damageType: dmgType
        };
        if (opts.bee) ev.bee = true;
        if (opts.fromSummon) { ev.summon = true; ev.summonId = opts.summonId || 'summon'; }
        emit(ev);
      }

      // 反伤：只反撞击/直接伤害；不反持续/真实；召唤物造成的伤害不触发反伤
      // （无血量召唤物：不反伤召唤物与本体；当前地雷/蜜蜂均无血量）
      if ((dmgType === 'collision' || dmgType === 'direct') && !isReflect &&
          !opts.fromSummon && opts.canReflect !== false && src && src !== target && src.alive) {
        let reflectPct = 0;
        let fromThorns = false;
        if (target.passives.thorns) {
          reflectPct = Math.max(reflectPct, target.passives.thorns.params.reflect || 0);
          fromThorns = true;
        }
        if (target.spike && target.spike.remaining > 0) {
          reflectPct = Math.max(reflectPct, target.spike.reflect || 0);
        }
        if (reflectPct > 0) {
          if (fromThorns && reflectPct === (target.passives.thorns.params.reflect || 0)) markSkill('thorns');
          followUpQueue.push({
            src: target,
            target: src,
            raw: total * reflectPct,
            opts: {
              kind: 'reflect', reflect: true, damageType: 'direct',
              canReflect: false,
              color: target.color, x: src.x, y: src.y
            },
            total: 0, absorbed: 0, hpDmg: 0
          });
        }
      }

      // 延迟死亡：同一步内多人同时死亡也能正确结算
      if (target.hp <= 0 && target.alive && !target._pendingDeath) {
        target._pendingDeath = true;
        pendingKills.push({ e: target, killer: (src && src.alive) ? src : (src || null) });
      }
      return total;
    }

    /* 统一结算：先主队列，再受控二次队列（反伤等），不允许在管线内递归改命。 */
    function settleDamageQueues() {
      if (damageQueue.length === 0 && followUpQueue.length === 0) return;
      let guard = 0;
      let batch = damageQueue;
      damageQueue = [];
      while ((batch.length > 0 || followUpQueue.length > 0) && guard < 8) {
        guard++;
        for (let i = 0; i < batch.length; i++) resolveDamageIntent(batch[i]);
        batch = followUpQueue;
        followUpQueue = [];
      }
      damageQueue = [];
      followUpQueue = [];
    }

    /* 即时伤害（技能/DOT/危险物等）：入队后立刻统一结算 */
    function damageNow(src, target, raw, opts) {
      queueDamage(src, target, raw, opts);
      settleDamageQueues();
    }

    /* ---------------- 死亡 ---------------- */
    function killEntity(e, killer) {
      if (!e.alive) return;
      e.alive = false;
      e.hp = 0;
      e.deathTime = match.time;
      e._pendingDeath = false;
      e.vx = 0;
      e.vy = 0;
      e.dashTime = 0;
      e.overTimer = 0;
      e.spike = null;
      e.phaseState = null;
      e.immuneState = null;
      e.status = Object.create(null);
      e.shield = null;
      e.shieldTotal = 0;
      e.slows = [];
      e.hastes = [];
      e.root = null;
      e.bees = [];
      e.beeRageQuota = 0;

      const st = stats[e.ballId];
      st.alive = false;
      st.deathTime = match.time;
      st.aliveTime = match.time - e.spawnTime;
      st.hpPct = 0;
      if (killer && killer !== e && stats[killer.ballId]) stats[killer.ballId].kills += 1;

      emit({
        type: 'death', x: e.x, y: e.y, entityId: e.id, ballId: e.ballId,
        name: e.name,
        atkBonus: e.atkBonus || 0, color: e.color, killerId: killer ? killer.id : null
      });
      emit({
        type: 'ring', x: e.x, y: e.y, r: 0, maxR: e.r * 4.2,
        color: e.color, kind: 'death'
      });
    }

    function processPendingKills() {
      while (pendingKills.length > 0) {
        const pk = pendingKills.shift();
        pk.e._pendingDeath = false;
        if (pk.e.alive) killEntity(pk.e, pk.killer);
      }
    }

    /* ---------------- 危险物 ---------------- */
    function placeHazard(kind, owner, x, y, cfg) {
      cfg = cfg || {};
      const radius = cfg.radius || 20;
      const hp = clampPointToArena(finiteOr(x, cx), finiteOr(y, cy), radius + 1);
      const h = {
        id: ++hazardSeq,
        kind: kind,
        ownerId: owner ? owner.id : -1,
        x: hp.x,
        y: hp.y,
        r: radius,
        radius: radius,
        life: cfg.life || 1,
        maxLife: cfg.life || 1,
        arm: cfg.arm || 0,
        armed: !(cfg.arm > 0),
        dmg: cfg.dmg || 0,
        root: cfg.root || 0,
        dps: cfg.dps || 0,
        pull: cfg.pull || 0,
        selfDmgTakenMult: cfg.selfDmgTakenMult != null ? cfg.selfDmgTakenMult : null,
        slowMult: cfg.slowMult != null ? cfg.slowMult : null,
        slowDur: cfg.slowDur != null ? cfg.slowDur : null,
        burnOnly: !!cfg.burnOnly,
        explosionRadius: cfg.explosionRadius != null ? cfg.explosionRadius : null,
        activeExplosionRadius: cfg.activeExplosionRadius != null ? cfg.activeExplosionRadius : null,
        movable: !!cfg.movable,
        tick: 0,
        color: cfg.color || HAZARD_COLORS[kind] || COLOR_CREAM,
        src: cfg.src || kind
      };
      hazardList.push(h);
      if (hazardList.length > MAX_HAZARDS) hazardList.shift();
      return h;
    }

    function countHazards(ownerId, src) {
      let n = 0;
      for (let i = 0; i < hazardList.length; i++) {
        if (hazardList[i].ownerId === ownerId && hazardList[i].src === src) n++;
      }
      return n;
    }

    function removeOldestHazard(ownerId, src) {
      for (let i = 0; i < hazardList.length; i++) {
        if (hazardList[i].ownerId === ownerId && hazardList[i].src === src) {
          hazardList.splice(i, 1);
          return true;
        }
      }
      return false;
    }

    /* ---------------- 地雷（机关，v0.4 重做） ---------------- */
    function mineDef() {
      return SUMMONS.mine || {
        dmg: 5, triggerRadius: 18, explosionRadius: 26, activeExplosionRadius: 80,
        root: 0.7, arm: 0.6, life: 14, max: 6, movable: true
      };
    }

    // 引爆一枚地雷：从场上移除，对爆炸范围内敌人造成直接伤害+定身；连锁引燃范围内其它已待发地雷
    function explodeMine(h, radiusOverride, opts) {
      opts = opts || {};
      const idx = hazardList.indexOf(h);
      if (idx < 0) return 0;
      hazardList.splice(idx, 1);
      const md = mineDef();
      const owner = byId(h.ownerId);
      const er = radiusOverride != null ? radiusOverride
        : (h.explosionRadius != null ? h.explosionRadius : (md.explosionRadius || 26));
      const hitList = [];
      for (let i = 0; i < entities.length; i++) {
        const o = entities[i];
        if (!o.alive || o.id === h.ownerId) continue;
        const rr = er + o.r;   // 爆炸半径按“爆炸边缘接触球体”判定
        if (dist2(o.x, o.y, h.x, h.y) > rr * rr) continue;
        queueDamage(owner, o, h.dmg, {
          kind: 'hazard', damageType: 'direct', fromSummon: true, summonId: 'mine',
          canReflect: false, color: h.color, x: o.x, y: o.y
        });
        hitList.push(o);
      }
      settleDamageQueues();
      const rootDur = h.root != null ? h.root : (md.root != null ? md.root : 0.7);
      for (let i = 0; i < hitList.length; i++) {
        if (hitList[i].alive && hitList[i].hp > 0) applyRoot(hitList[i], rootDur);
      }
      emit({
        type: 'explode', x: h.x, y: h.y, radius: er,
        kind: opts.chain ? 'chain' : (opts.active ? 'active' : 'mine'),
        chain: !!opts.chain,
        sourceId: h.ownerId >= 0 ? h.ownerId : null,
        hitCount: hitList.length,
        color: h.color
      });
      // 连锁：爆炸范围内的其它已待发地雷也爆炸（先收集快照，避免列表变动导致索引错位）
      if (opts.chain !== false) {
        const chainCands = [];
        for (let i = 0; i < hazardList.length; i++) {
          const other = hazardList[i];
          if (other.kind !== 'mine' || !other.armed) continue;
          const rr = er + other.r;
          if (dist2(other.x, other.y, h.x, h.y) <= rr * rr) chainCands.push(other);
        }
        for (let i = 0; i < chainCands.length; i++) {
          const other = chainCands[i];
          if (hazardList.indexOf(other) < 0) continue;
          explodeMine(other, other.explosionRadius != null ? other.explosionRadius : (md.explosionRadius || 26), { chain: true });
        }
      }
      return hitList.length;
    }

    // 连环引爆：引爆场上所有地雷（含未待发），主动引爆溅射范围由 activeExplosionRadius 决定
    function detonateAllMines(owner, activeRadius) {
      const mines = [];
      for (let i = 0; i < hazardList.length; i++) {
        if (hazardList[i].kind === 'mine') mines.push(hazardList[i]);
      }
      for (let i = 0; i < mines.length; i++) {
        const h = mines[i];
        if (hazardList.indexOf(h) < 0) continue;
        explodeMine(h, activeRadius != null ? activeRadius : (h.activeExplosionRadius != null ? h.activeExplosionRadius : 80), { chain: false, active: true });
      }
      return mines.length;
    }

    /* ---------------- 技能施放 ---------------- */
    function castSkill(e, skill) {
      if (!skill) return false;
      const p = skill.params || {};
      const targetNeeded = (skill.id === 'meteor_drop');
      const target = targetNeeded ? nearestEnemy(e) : null;
      if (targetNeeded && !target) return false;

      switch (skill.id) {
        case 'meteor_drop': {
          const dx = target.x - e.x;
          const dy = target.y - e.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > EPS) { e.facing.x = dx / d; e.facing.y = dy / d; }
          e.dashTime = p.dur || 0.8;
          e.dashTrailTimer = 0;
          e.dashTrail = {
            interval: p.trailInterval || 0.1,
            life: p.trailLife || 2.0,
            radius: p.trailRadius || 42,
            burnOnly: p.trailBurn !== false
          };
          applyHaste(e, p.speedMult || 2.1, p.dur || 0.8, 'meteor_drop');
          break;
        }
        case 'cage': {
          // 连环引爆：引爆所有地雷；无雷时保留能量、不空放（唯一特例）
          let mineCount = 0;
          for (let i = 0; i < hazardList.length; i++) if (hazardList[i].kind === 'mine') mineCount++;
          if (mineCount <= 0) return false;
          // 主动引爆时每颗地雷的溅射范围由 activeExplosionRadius 决定（当前 80）
          const mdActive = mineDef().activeExplosionRadius;
          detonateAllMines(e, mdActive != null ? mdActive : 80);
          break;
        }
        case 'bulwark': {
          addShield(e, p.shield || 55, p.dur || 5);
          const radius = p.radius || 180;
          for (let i = 0; i < entities.length; i++) {
            const o = entities[i];
            if (!o.alive || o === e) continue;
            const d = Math.sqrt(dist2(e.x, e.y, o.x, o.y));
            if (d > radius) continue;
            const nx = d > EPS ? (o.x - e.x) / d : 1;
            const ny = d > EPS ? (o.y - e.y) / d : 0;
            const push = (p.knockback || 260) * 0.18;
            o.x += nx * push;
            o.y += ny * push;
            keepInArena(o);
            applySlow(o, p.slowMult || 0.6, p.slowDur || 0.8, 'bulwark');
          }
          emit({ type: 'ring', x: e.x, y: e.y, r: 0, maxR: radius, color: e.color, kind: 'bulwark' });
          break;
        }
        case 'blizzard': {
          const radius = p.radius || 210;
          const hitList = [];
          for (let i = 0; i < entities.length; i++) {
            const o = entities[i];
            if (!o.alive || o === e) continue;
            if (dist2(e.x, e.y, o.x, o.y) > radius * radius) continue;
            hitList.push(o);
          }
          // 4.1：AOE 先收集伤害，再统一结算（直接伤害）
          for (let i = 0; i < hitList.length; i++) {
            queueDamage(e, hitList[i], p.dmg || 14, { kind: 'hit', damageType: 'direct', color: e.color });
          }
          settleDamageQueues();
          for (let i = 0; i < hitList.length; i++) {
            if (hitList[i].alive && hitList[i].hp > 0) {
              applySlow(hitList[i], p.slowMult || 0.55, p.dur || 2.5, 'blizzard');
            }
          }
          // 霜爆可降低移动召唤物（蜜蜂等）移速
          if (p.slowSummons !== false) {
            slowSummonsInRadius(e.x, e.y, radius, p.slowMult || 0.55, p.dur || 2.5, 'blizzard');
          }
          emit({ type: 'ring', x: e.x, y: e.y, r: 0, maxR: radius, color: e.color, kind: 'blizzard' });
          break;
        }
        case 'overload': {
          e.overTimer = p.dur || 3;
          e.overParams = p;
          e.zapTimer = 0;
          applyHaste(e, p.speedMult || 1.55, p.dur || 3, 'overload');
          break;
        }
        case 'miasma': {
          placeHazard('poison', e, e.x, e.y, {
            radius: p.radius || 115,
            life: p.life || 5,
            dps: p.dps || 8,
            src: 'miasma'
          });
          // 契约 4.4 的 ring.kind 枚举没有 miasma；用 blizzard（扩散环）承载，颜色仍为技能色
          emit({ type: 'ring', x: e.x, y: e.y, r: 0, maxR: p.radius || 115, color: '#4BE38A', kind: 'blizzard' });
          break;
        }
        case 'wraith': {
          // 虚化：免伤 + 免疫碰撞 + 加速；不叠层，与免伤同时存在时由虚化覆盖
          applyImmunity(e, 'phase', p.dur || 1.2);
          applyHaste(e, p.speedMult || 1.25, p.dur || 1.2, 'wraith');
          break;
        }
        case 'singularity': {
          placeHazard('gravity', e, e.x, e.y, {
            radius: p.radius || 240,
            life: p.life || 2,
            dps: p.dps || 4.5,
            pull: p.pull || 300,
            selfDmgTakenMult: p.selfDmgTakenMult != null ? p.selfDmgTakenMult : 0.8,
            slowMult: p.centerSlowMult != null ? p.centerSlowMult : 0.75,
            slowDur: p.centerSlowDur != null ? p.centerSlowDur : 1,
            src: 'singularity'
          });
          emit({ type: 'ring', x: e.x, y: e.y, r: 0, maxR: p.radius || 240, color: COLOR_VIOLET, kind: 'singularity' });
          break;
        }
        case 'spike': {
          e.spike = {
            remaining: p.dur || 5,
            dur: p.dur || 5,
            contactDps: p.contactDps || 8,
            reflect: p.reflect != null ? p.reflect : 1,
            aura: p.aura || 18
          };
          e.spikeTick = 0;
          break;
        }
        case 'swarm_rage': {
          // 蜂群暴动：补至 3 只并转换为狂暴蜂；共 frenzyCharges 只狂暴额度（含立即补的）
          const hiveP = e.passives.swarm_hive ? e.passives.swarm_hive.params : {};
          const maxBees = hiveP.maxBees != null ? hiveP.maxBees : BEE_DEFAULTS.maxBees;
          const refill = p.refill != null ? p.refill : BEE_DEFAULTS.rageRefill;
          const charges = p.frenzyCharges != null ? p.frenzyCharges : BEE_DEFAULTS.rageCharges;
          const rageLife = p.beeLife != null ? p.beeLife : BEE_DEFAULTS.rageLife;
          const rageDmg = p.beeDmg != null ? p.beeDmg : BEE_DEFAULTS.rageDmg;
          e.beeRageQuota = charges;
          // 已存在的蜜蜂转换为狂暴蜂并消耗额度
          for (let i = 0; i < e.bees.length; i++) {
            const bee = e.bees[i];
            if (bee.frenzy || e.beeRageQuota <= 0) continue;
            bee.frenzy = true;
            bee.dmg = rageDmg;
            bee.life = rageLife;
            bee.maxLife = rageLife;
            bee.remaining = rageLife;
            e.beeRageQuota -= 1;
          }
          // 立即补至 refill 只（狂暴）
          while (e.bees.length < Math.max(1, Math.min(refill, maxBees)) && e.beeRageQuota > 0) {
            spawnBee(e, true);
            e.beeRageQuota -= 1;
          }
          e.beeTimer = hiveP.spawnInterval != null ? hiveP.spawnInterval : BEE_DEFAULTS.spawnInterval;
          break;
        }
        default:
          return false;
      }

      // 统计 + 施法事件（v0.4：能量由 updateSkills 扣除）
      e.castGlow = { skillId: skill.id, name: skill.name, remaining: CAST_GLOW_TIME };
      stats[e.ballId].casts += 1;
      markSkill(skill.id);
      emit({
        type: 'cast', x: e.x, y: e.y, entityId: e.id,
        skillId: skill.id, skillName: skill.name, sigil: skill.sigil, color: e.color,
        energy: e.energy, energyCost: p.energyCost != null ? p.energyCost : e.energyCost
      });
      return true;
    }

    /* ---------------- 命中附带被动 ---------------- */
    function hitPassives(src, target) {
      if (!target || !target.alive || target.hp <= 0) return;
      if (src.passives.burn) applyBurn(target, src);
      if (src.passives.venom) applyPoison(target, src);
      if (src.passives.frostbite) {
        const p = src.passives.frostbite.params;
        const dur = p.dur != null ? p.dur : 2;
        applySlow(target, p.slowMult != null ? p.slowMult : 0.72, dur, 'frostbite');
        applyDebuff(target, 'weakness', p.weakMult != null ? p.weakMult : 0.5, dur);
        applyDebuff(target, 'armorBreak', p.armorBreakMult != null ? p.armorBreakMult : 0.5, dur);
        markSkill('frostbite');
      }
    }

    /* ---------------- 天雷（特斯拉被动）----------------
     * v0.3：每次有效碰撞后，在场地内纯随机位置降下 strikes 道天雷；
     * 预警 warn 秒后，每道对半径 radius 内敌人各造成 dmg 点直接伤害；
     * 同一目标可被同一触发的多道天雷分别命中；不电自己；无内置冷却。 */
    function randomArenaPoint() {
      if (shape === 'circle') {
        const ang = rand() * TAU;
        const rr = Math.sqrt(rand()) * Math.max(0, arenaRadius - 1);
        return { x: cx + Math.cos(ang) * rr, y: cy + Math.sin(ang) * rr };
      }
      if (shape === 'triangle') {
        for (let attempt = 0; attempt < 24; attempt++) {
          const x = rand() * arenaW;
          const y = rand() * arenaH;
          if (triangleContains(x, y, 1)) return { x: x, y: y };
        }
        return { x: cx, y: cy };
      }
      return { x: rand() * arenaW, y: rand() * arenaH };
    }

    function scheduleThunder(e) {
      if (!e.passives.thunder) return;
      const p = e.passives.thunder.params;
      const count = Math.max(1, p.strikes || 2);
      const radius = p.radius || 80;
      const warn = p.warn != null ? p.warn : 0.35;
      const strikes = [];
      for (let k = 0; k < count; k++) strikes.push(randomArenaPoint());
      markSkill('thunder');
      pendingThunder.push({
        id: ++thunderSeq,
        ownerId: e.id,
        ballId: e.ballId,
        strikes: strikes,
        radius: radius,
        dmg: p.dmg || 5,
        warn: warn,
        impactAt: match.time + warn,
        color: '#FFD642',
        maxHits: p.maxHitsPerTarget != null ? p.maxHitsPerTarget : 99,
        selfHit: !!p.selfHit
      });
    }

    function updateThunderStrikes() {
      if (pendingThunder.length === 0) return;
      for (let i = pendingThunder.length - 1; i >= 0; i--) {
        const t = pendingThunder[i];
        if (match.time + 1e-9 < t.impactAt) continue;
        pendingThunder.splice(i, 1);
        const owner = byId(t.ownerId);
        const hitCounts = Object.create(null);
        const maxHits = t.maxHits > 0 ? t.maxHits : 99;
        for (let s = 0; s < t.strikes.length; s++) {
          const pt = t.strikes[s];
          // 落雷视觉：天顶 → 落点的竖向闪电 + 落点冲击环
          emit({ type: 'chain', points: [{ x: pt.x, y: 0 }, { x: pt.x, y: pt.y }], color: t.color });
          emit({ type: 'ring', x: pt.x, y: pt.y, r: 0, maxR: t.radius, color: t.color, kind: 'thunder' });
          for (let j = 0; j < entities.length; j++) {
            const o = entities[j];
            if (!o.alive) continue;
            if (!t.selfHit && o.id === t.ownerId) continue;
            if ((hitCounts[o.id] || 0) >= maxHits) continue;
            if (dist2(o.x, o.y, pt.x, pt.y) > t.radius * t.radius) continue;
            hitCounts[o.id] = (hitCounts[o.id] || 0) + 1;
            // 每道雷独立结算一次直接伤害（同一目标可被多道命中）
            queueDamage(owner, o, t.dmg, {
              kind: 'zap', damageType: 'direct', canReflect: false,
              color: t.color, x: o.x, y: o.y
            });
          }
        }
        settleDamageQueues();
      }
    }

    /* ---------------- 蜜蜂（蜂群）----------------
     * swarm_hive：每 spawnInterval 秒生成 1 只，最多 maxBees 只；与敌人距离无关；
     * 未追踪时围绕蜂群转（state='orbit'，按 120° 均分站位、随全局时间缓慢旋转）；
     * 敌人进入蜜蜂自身 trackRadius 后转为追踪 chase；某只蜂开始追踪时重置生成冷却；
     * 蜜蜂移速 = 蜂群当前移速；存在 <= beeLife 秒；追上造成 beeDmg 直接伤害后消失；
     * 蜜蜂不可被攻击/阻挡，不触发命中被动。
     * swarm_rage：补至 refill 只并转狂暴蜂；共 frenzyCharges 只狂暴额度（含补给）；
     * 狂暴蜂存在 <= rageLife 秒、造成 rageDmg 直接伤害后消失。 */
    function beeParamsOf(e) {
      const p = e.passives.swarm_hive ? e.passives.swarm_hive.params : {};
      const rage = SKILLS.swarm_rage && SKILLS.swarm_rage.params ? SKILLS.swarm_rage.params : {};
      return {
        spawnInterval: p.spawnInterval != null ? p.spawnInterval : BEE_DEFAULTS.spawnInterval,
        maxBees: p.maxBees != null ? p.maxBees : BEE_DEFAULTS.maxBees,
        trackRadius: p.trackRadius != null ? p.trackRadius : BEE_DEFAULTS.trackRadius,
        beeLife: p.beeLife != null ? p.beeLife : BEE_DEFAULTS.beeLife,
        beeDmg: p.beeDmg != null ? p.beeDmg : BEE_DEFAULTS.beeDmg,
        retargetRadius: p.retargetRadius != null ? p.retargetRadius : BEE_DEFAULTS.retargetRadius,
        rageLife: rage.beeLife != null ? rage.beeLife : BEE_DEFAULTS.rageLife,
        rageDmg: rage.beeDmg != null ? rage.beeDmg : BEE_DEFAULTS.rageDmg,
        rageRetarget: rage.retargetRadius != null ? rage.retargetRadius : BEE_DEFAULTS.retargetRadius,
        beeRadius: BEE_DEFAULTS.beeRadius
      };
    }

    function spawnBee(owner, frenzy) {
      const bp = beeParamsOf(owner);
      const isFrenzy = !!frenzy || owner.beeRageQuota > 0;
      const ang = rand() * TAU;
      const rr = owner.r * (0.35 + rand() * 0.5);
      const bee = {
        id: ++beeSeq,
        ownerId: owner.id,
        ballId: owner.ballId,
        x: owner.x + Math.cos(ang) * rr,
        y: owner.y + Math.sin(ang) * rr,
        r: bp.beeRadius,
        state: 'orbit',            // 'orbit' 环绕蜂群 | 'chase' 追踪敌人
        slot: 0,                   // 轨道角度槽（0..n-1）
        angle: 0,                  // 当前轨道角（rad）
        orbitRadius: owner.r + BEE_ORBIT_BASE,
        frenzy: isFrenzy,
        dmg: isFrenzy ? bp.rageDmg : bp.beeDmg,
        life: isFrenzy ? bp.rageLife : bp.beeLife,
        maxLife: isFrenzy ? bp.rageLife : bp.beeLife,
        remaining: isFrenzy ? bp.rageLife : bp.beeLife,
        trackedOnce: false,        // v0.4.1：开始追踪后才开始计寿命；orbit 未追踪时无限
        speed: 0,
        slowMult: 1,
        slowRemaining: 0,
        targetId: null
      };
      owner.bees.push(bee);
      markSkill('swarm_hive');
      return bee;
    }

    function beeNearestEnemy(owner, bee, radius) {
      let best = null;
      let bestD = radius * radius;
      for (let i = 0; i < entities.length; i++) {
        const o = entities[i];
        if (!o.alive || o === owner) continue;
        const d = dist2(bee.x, bee.y, o.x, o.y);
        if (d <= bestD) { bestD = d; best = o; }
      }
      return best;
    }

    /* v0.4 召唤物减速：对半径内移动召唤物（蜜蜂）挂减速（同类取最强、刷新时长） */
    function applyBeeSlow(bee, mult, dur) {
      if (!(mult > 0 && mult < 1) || !(dur > 0)) return;
      if (bee.slowRemaining <= 0) { bee.slowMult = mult; bee.slowRemaining = dur; return; }
      if (mult < bee.slowMult) bee.slowMult = mult;
      if (dur > bee.slowRemaining) bee.slowRemaining = dur;
    }

    function slowSummonsInRadius(x, y, radius, mult, dur, sourceId) {
      const rr = radius * radius;
      for (let i = 0; i < entities.length; i++) {
        const owner = entities[i];
        if (!owner.alive || !owner.bees || owner.bees.length === 0) continue;
        for (let b = 0; b < owner.bees.length; b++) {
          const bee = owner.bees[b];
          if (dist2(bee.x, bee.y, x, y) <= rr) applyBeeSlow(bee, mult, dur);
        }
      }
      markSkillIfExists(sourceId || 'slowSummons');
    }

    function markSkillIfExists(sid) {
      if (skillUsage[sid] !== undefined) skillUsage[sid] += 1;
    }

    /* 未追踪的蜜蜂围绕蜂群转：按当前 orbit 数量均分角度槽，随全局时间缓慢旋转；
     * 轨道半径 = 蜂群半径 + 26~34（slot 0/1/2 对应 +26/+30/+34）。 */
    function layoutOrbitBees(owner) {
      const bees = owner.bees;
      let count = 0;
      for (let i = 0; i < bees.length; i++) if (bees[i].state === 'orbit') count++;
      if (count === 0) return;
      const spin = match.time * BEE_ORBIT_SPIN;
      let slot = 0;
      for (let i = 0; i < bees.length; i++) {
        const bee = bees[i];
        if (bee.state !== 'orbit') continue;
        bee.slot = slot;
        bee.angle = spin + (slot / count) * TAU;
        bee.orbitRadius = owner.r + BEE_ORBIT_BASE + slot * BEE_ORBIT_STEP;
        const pt = clampPointToArena(
          owner.x + Math.cos(bee.angle) * bee.orbitRadius,
          owner.y + Math.sin(bee.angle) * bee.orbitRadius,
          bee.r
        );
        bee.x = pt.x;
        bee.y = pt.y;
        bee.speed = 0;
        slot++;
      }
    }

    function updateBees(dt) {
      for (let i = 0; i < entities.length; i++) {
        const owner = entities[i];
        if (!owner.alive || !owner.passives.swarm_hive) continue;
        const bp = beeParamsOf(owner);

        // 被动生成：每 spawnInterval 秒 1 只，最多 maxBees 只（与敌人距离无关）
        owner.beeTimer -= dt;
        if (owner.beeTimer <= 0) {
          owner.beeTimer += bp.spawnInterval;
          if (owner.beeTimer <= 0) owner.beeTimer = bp.spawnInterval;
          if (owner.bees.length < bp.maxBees) {
            spawnBee(owner, owner.beeRageQuota > 0);
            if (owner.beeRageQuota > 0) owner.beeRageQuota -= 1;
          }
        }

        // 环绕站位：未追踪的蜜蜂绕蜂群转（生成后立即入轨；移除后剩余蜜蜂重新均分）
        layoutOrbitBees(owner);

        // 蜜蜂自身：寿命（v0.4.1：追踪后才计时）/ 环绕→追踪切换 / 追踪移动 / 命中
        for (let b = owner.bees.length - 1; b >= 0; b--) {
          const bee = owner.bees[b];
          if (bee.trackedOnce) {
            // 第一次开始追踪后开始计时：普通蜂 3s、狂暴蜂 6s；追踪中断回 orbit 也继续计时
            bee.remaining -= dt;
            if (bee.remaining <= 0) {
              // 追踪寿命耗尽仍未追上：原地爆炸消失（不额外造成范围伤害）
              emit({
                type: 'explode', kind: 'bee', x: bee.x, y: bee.y, radius: 24,
                chain: false, hitCount: 0,
                sourceId: owner.id >= 0 ? owner.id : null,
                color: owner.color2 || owner.color
              });
              owner.bees.splice(b, 1);
              continue;
            }
          } else {
            // 未追踪时无限寿命（untrackedLife='∞'），保持在满寿命
            bee.remaining = bee.maxLife;
          }

          if (bee.state !== 'chase') {
            // 环绕中：敌人进入蜜蜂自身 trackRadius → 转为追踪（chase），此刻才开始计寿命
            const found = beeNearestEnemy(owner, bee, bp.trackRadius);
            if (found) {
              if (!bee.trackedOnce) { bee.trackedOnce = true; bee.remaining = bee.maxLife; }
              bee.state = 'chase';
              bee.targetId = found.id;
              // 生成冷却从上一只蜜蜂开始追踪时重置
              owner.beeTimer = bp.spawnInterval;
            }
            continue;
          }

          // 追踪中：目标失效/超距则尝试重新锁定；找不到则回到环绕
          const retarget = bee.frenzy ? bp.rageRetarget : bp.retargetRadius;
          let target = bee.targetId != null ? byId(bee.targetId) : null;
          if (target && (!target.alive || target === owner ||
            dist2(bee.x, bee.y, target.x, target.y) > retarget * retarget)) {
            target = null;
          }
          if (!target) {
            const found = beeNearestEnemy(owner, bee, bp.trackRadius);
            if (found) {
              target = found;
              bee.targetId = found.id;
            } else {
              bee.state = 'orbit';
              bee.targetId = null;
              continue;
            }
          }

          // 蜜蜂移速 = 蜂群当前移速（受蜂群减速/加速影响），再乘召唤物自身减速
          if (bee.slowRemaining > 0) {
            bee.slowRemaining -= dt;
            if (bee.slowRemaining <= 0) { bee.slowRemaining = 0; bee.slowMult = 1; }
          }
          const beeSlow = bee.slowRemaining > 0 ? bee.slowMult : 1;
          const spd = Math.sqrt(owner.vx * owner.vx + owner.vy * owner.vy) * beeSlow;
          bee.speed = spd;
          const dx = target.x - bee.x;
          const dy = target.y - bee.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > EPS && spd > 0) {
            bee.x += (dx / d) * spd * dt;
            bee.y += (dy / d) * spd * dt;
            const bpa = clampPointToArena(bee.x, bee.y, bee.r);
            bee.x = bpa.x;
            bee.y = bpa.y;
          }
          const hitR = bee.r + target.r;
          if (dist2(bee.x, bee.y, target.x, target.y) <= hitR * hitR) {
            // 追上：直接伤害（吃防御/减伤/护盾）后消失；不触发命中被动、不吃反伤
            queueDamage(owner, target, bee.dmg, {
              kind: 'hit', damageType: 'direct', bee: true,
              fromSummon: true, summonId: 'bee',
              canReflect: false, color: owner.color2 || owner.color,
              x: target.x, y: target.y
            });
            settleDamageQueues();
            owner.bees.splice(b, 1);
          }
        }

        // 蜜蜂移除/追踪后，剩余环绕蜜蜂重新均分站位
        layoutOrbitBees(owner);
      }
    }

    /* ---------------- 逐帧：计时器 ---------------- */
    function updateTimers(dt) {
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.alive) continue;

        if (e.flash > 0) e.flash = Math.max(0, e.flash - dt * 3.4);
        if (e.castGlow) {
          e.castGlow.remaining -= dt;
          if (e.castGlow.remaining <= 0) e.castGlow = null;
        }

        const st = e.status;
        if (st.burn) {
          st.burn.remaining -= dt;
          if (st.burn.remaining <= 0) e.status.burn = null;
        }
        if (st.poison) {
          st.poison.remaining -= dt;
          if (st.poison.remaining <= 0) e.status.poison = null;
        }
        if (st.weakness) {
          st.weakness.remaining -= dt;
          if (st.weakness.remaining <= 0) st.weakness = null;
        }
        if (st.armorBreak) {
          st.armorBreak.remaining -= dt;
          if (st.armorBreak.remaining <= 0) st.armorBreak = null;
        }

        for (let s = e.slows.length - 1; s >= 0; s--) {
          e.slows[s].remaining -= dt;
          if (e.slows[s].remaining <= 0) e.slows.splice(s, 1);
        }
        for (let h = e.hastes.length - 1; h >= 0; h--) {
          e.hastes[h].remaining -= dt;
          if (e.hastes[h].remaining <= 0) e.hastes.splice(h, 1);
        }

        if (e.root) {
          e.root.remaining -= dt;
          if (e.root.remaining <= 0) e.root = null;
        }
        if (e.phaseState) {
          e.phaseState.remaining -= dt;
          if (e.phaseState.remaining <= 0) e.phaseState = null;
        }
        if (e.immuneState) {
          e.immuneState.remaining -= dt;
          if (e.immuneState.remaining <= 0) e.immuneState = null;
        }
        if (e.spike) {
          e.spike.remaining -= dt;
          if (e.spike.remaining <= 0) e.spike = null;
        }
        if (e.dashTime > 0) e.dashTime = Math.max(0, e.dashTime - dt);

        if (e.shield) {
          e.shield.remaining -= dt;
          if (e.shield.remaining <= 0 || e.shield.amount <= 0) e.shield = null;
        }
        syncShield(e);

        stats[e.ballId].aliveTime += dt;
      }
    }

    /* ---------------- 逐帧：被动 + 能量自动施放（v0.4） ---------------- */
    function updateSkills(dt) {
      var energyPerSec = ENERGY_RULE.perSecond != null ? Number(ENERGY_RULE.perSecond) : 1;
      if (mechanisms.energyPrep && match.time >= (ENERGY_PREP.after != null ? ENERGY_PREP.after : 30)) {
        energyPerSec *= (ENERGY_PREP.mult != null ? ENERGY_PREP.mult : 2);
      }
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.alive) continue;

        // trapmaker：定时在脚下埋雷（机关）
        if (e.passives.trapmaker) {
          const p = e.passives.trapmaker.params;
          const md = mineDef();
          e.trapTimer -= dt;
          if (e.trapTimer <= 0) {
            e.trapTimer += (p.interval || 2.5);
            if (e.trapTimer <= 0) e.trapTimer = p.interval || 2.5;
            const maxMines = p.maxMines != null ? p.maxMines : (md.max != null ? md.max : 6);
            if (countHazards(e.id, 'trapmaker') >= maxMines) {
              removeOldestHazard(e.id, 'trapmaker');
            }
            placeHazard('mine', e, e.x, e.y, {
              radius: md.triggerRadius != null ? md.triggerRadius : 18,
              explosionRadius: md.explosionRadius != null ? md.explosionRadius : 26,
              activeExplosionRadius: md.activeExplosionRadius != null ? md.activeExplosionRadius : 80,
              movable: md.movable !== false,
              life: p.life != null ? p.life : (md.life != null ? md.life : 14),
              arm: p.arm != null ? p.arm : (md.arm != null ? md.arm : 0.6),
              dmg: md.dmg != null ? md.dmg : (p.dmg || 5),
              root: md.root != null ? md.root : (p.root || 0.7),
              src: 'trapmaker'
            });
            markSkill('trapmaker');
          }
        }

        // 能量：每秒 +perSecond；满能量自动尝试施放主动，成功后扣除能量
        if (e.activeSkill && e.energyCost > 0) {
          e.energy += energyPerSec * dt;
          const cap = e.energyCost + 1;      // 允许最多 1 点溢出
          if (e.energy > cap) e.energy = cap;
          if (e.energy >= e.energyCost) {
            if (castSkill(e, e.activeSkill)) {
              e.energy = Math.max(0, e.energy - e.energyCost);
            }
          }
        } else if (!(e.energy >= 0)) {
          e.energy = 0;
        }
      }
    }

    /* ---------------- 逐帧：移动 / 撞墙 ---------------- */
    function bounceEvent(e) {
      if (match.time - e.lastBounceAt < BOUNCE_EVENT_GAP) return;
      e.lastBounceAt = match.time;
      emit({ type: 'bounce', x: e.x, y: e.y, entityId: e.id, color: e.color });
    }

    function warpEvent(e) {
      if (match.time - e.lastWarpAt < WARP_EVENT_GAP) return;
      e.lastWarpAt = match.time;
      emit({ type: 'warp', x: e.x, y: e.y, entityId: e.id, color: e.color });
    }

    // 圆形场地：法向反射（普通球）/ 关于圆心镜像穿墙（幽灵）
    function handleWallsCircle(e) {
      const r = e.r;
      const dx = e.x - cx;
      const dy = e.y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (hasPhaseWall(e)) {
        // 圆心越过边界即穿墙：p' = 2c - p，速度方向不变
        if (d > arenaRadius) {
          let mx = 2 * cx - e.x;
          let my = 2 * cy - e.y;
          const mdx = mx - cx;
          const mdy = my - cy;
          const md = Math.sqrt(mdx * mdx + mdy * mdy);
          // 镜像后保证圆心仍在圆内（只内收极小量，保持镜像点近似精确）
          const maxD = Math.max(0, arenaRadius - 0.5);
          if (md > maxD) {
            if (md > EPS) {
              const k = maxD / md;
              mx = cx + mdx * k;
              my = cy + mdy * k;
            } else {
              mx = cx + maxD;
              my = cy;
            }
          }
          e.x = mx;
          e.y = my;
          markSkill('phase');
          warpEvent(e);
          adjustPhaseAtk(e, 1);
        }
      } else {
        const maxD = Math.max(0, arenaRadius - r);
        if (d > maxD) {
          let nx;
          let ny;
          if (d > EPS) { nx = dx / d; ny = dy / d; }
          else { nx = 1; ny = 0; }
          e.x = cx + nx * maxD;
          e.y = cy + ny * maxD;
          const vn = e.vx * nx + e.vy * ny;
          if (vn > 0) {
            // v' = v - (1+e)(v·n)n，wallRestitution = 1 时即镜面法向反射
            e.vx -= (1 + WALL_REST) * vn * nx;
            e.vy -= (1 + WALL_REST) * vn * ny;
            bounceEvent(e);
          }
        }
      }
    }

    // 三角形场地：三边镜面反弹；穿墙单位按边界法线镜像穿越（位置关于边镜像，速度方向不变）
    function handleWallsTriangle(e) {
      const r = e.r;
      for (let i = 0; i < triangle.edges.length; i++) {
        const edge = triangle.edges[i];
        const d = triangleEdgeDist(edge, e.x, e.y);
        if (hasPhaseWall(e)) {
          if (d < 0) {
            e.x -= 2 * d * edge.nx;
            e.y -= 2 * d * edge.ny;
            markSkill('phase');
            warpEvent(e);
            adjustPhaseAtk(e, 1);
          }
        } else if (d < r) {
          const push = r - d;
          e.x += edge.nx * push;
          e.y += edge.ny * push;
          const vn = e.vx * edge.nx + e.vy * edge.ny;
          if (vn < 0) {
            e.vx -= (1 + WALL_REST) * vn * edge.nx;
            e.vy -= (1 + WALL_REST) * vn * edge.ny;
            bounceEvent(e);
          }
        }
      }
    }

    function handleWalls(e) {
      if (shape === 'circle') { handleWallsCircle(e); return; }
      if (shape === 'triangle') { handleWallsTriangle(e); return; }
      const r = e.r;
      if (hasPhaseWall(e)) {
        // 穿墙：位置跨越到对侧，速度方向保持不变（“穿过”而非“反弹”）
        let wrapped = false;
        if (e.x < -r) { e.x = arenaW + r; wrapped = true; }
        else if (e.x > arenaW + r) { e.x = -r; wrapped = true; }
        if (e.y < -r) { e.y = arenaH + r; wrapped = true; }
        else if (e.y > arenaH + r) { e.y = -r; wrapped = true; }
        if (wrapped) {
          markSkill('phase');
          warpEvent(e);
          adjustPhaseAtk(e, 1);
        }
      } else {
        if (e.x < r) {
          e.x = r;
          if (e.vx < 0) { e.vx = -e.vx * WALL_REST; bounceEvent(e); }
        } else if (e.x > arenaW - r) {
          e.x = arenaW - r;
          if (e.vx > 0) { e.vx = -e.vx * WALL_REST; bounceEvent(e); }
        }
        if (e.y < r) {
          e.y = r;
          if (e.vy < 0) { e.vy = -e.vy * WALL_REST; bounceEvent(e); }
        } else if (e.y > arenaH - r) {
          e.y = arenaH - r;
          if (e.vy > 0) { e.vy = -e.vy * WALL_REST; bounceEvent(e); }
        }
      }
    }

    function keepInArena(e) {
      if (shape === 'triangle') {
        if (hasPhaseWall(e)) {
          // 穿墙单位允许短暂越界（下一步 handleWalls 镜像回内部），仅做外接圆保险钳制
          const dx = finiteOr(e.x, cx) - cx;
          const dy = finiteOr(e.y, cy) - cy;
          const dd = Math.sqrt(dx * dx + dy * dy);
          const lim = triangle.radius + e.r + 2;
          if (dd > lim && dd > EPS) {
            const k = lim / dd;
            e.x = cx + dx * k;
            e.y = cy + dy * k;
          }
          return;
        }
        const pt = clampPointToTriangle(e.x, e.y, e.r);
        e.x = pt.x;
        e.y = pt.y;
        return;
      }
      if (shape === 'circle') {
        const x = finiteOr(e.x, cx);
        const y = finiteOr(e.y, cy);
        const dx = x - cx;
        const dy = y - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        // 普通球严格在圆内 R-r；幽灵允许短暂 d <= R+r（下一步由 handleWalls 镜像）
        const limit = hasPhaseWall(e) ? (arenaRadius + e.r) : Math.max(0, arenaRadius - e.r);
        if (d > limit) {
          if (d > EPS) {
            const k = limit / d;
            e.x = cx + dx * k;
            e.y = cy + dy * k;
          } else {
            e.x = cx;
            e.y = cy;
          }
          return;
        }
        e.x = x;
        e.y = y;
        return;
      }
      const r = e.r;
      if (hasPhaseWall(e)) {
        e.x = clamp(finiteOr(e.x, cx), -r, arenaW + r);
        e.y = clamp(finiteOr(e.y, cy), -r, arenaH + r);
      } else {
        e.x = clamp(finiteOr(e.x, cx), r, arenaW - r);
        e.y = clamp(finiteOr(e.y, cy), r, arenaH - r);
      }
    }

    function updateMovement(dt) {
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.alive) continue;

        const rooted = e.root && e.root.remaining > 0;
        if (rooted) {
          e.vx = 0;
          e.vy = 0;
        } else {
          const desired = desiredSpeedOf(e);
          // 陨星突进：朝最近敌人
          if (e.dashTime > 0) {
            const tgt = nearestEnemy(e);
            if (tgt) {
              const dx = tgt.x - e.x;
              const dy = tgt.y - e.y;
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d > EPS) {
                e.facing.x = dx / d;
                e.facing.y = dy / d;
              }
            }
          }
          const cur = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
          if (cur > 1e-6) {
            e.facing.x = e.vx / cur;
            e.facing.y = e.vy / cur;
          }
          const fl = Math.sqrt(e.facing.x * e.facing.x + e.facing.y * e.facing.y);
          if (fl < 1e-6) { e.facing.x = 1; e.facing.y = 0; }
          else { e.facing.x /= fl; e.facing.y /= fl; }
          e.vx = e.facing.x * desired;
          e.vy = e.facing.y * desired;
          e.x += e.vx * dt;
          e.y += e.vy * dt;
        }

        // 陨星火痕
        if (e.dashTime > 0 && e.dashTrail) {
          e.dashTrailTimer += dt;
          let guard = 0;
          while (e.dashTrailTimer >= e.dashTrail.interval && guard < 4) {
            e.dashTrailTimer -= e.dashTrail.interval;
            placeHazard('fire', e, e.x, e.y, {
              radius: e.dashTrail.radius,
              life: e.dashTrail.life,
              burnOnly: e.dashTrail.burnOnly !== false,
              src: 'meteor_drop'
            });
            guard++;
          }
        }

        handleWalls(e);
        keepInArena(e);
      }
    }

    /* ---------------- 逐帧：球球碰撞 ---------------- */
    function pullToward(grav, other) {
      const p = grav.passives.gravity.params;
      const dx = grav.x - other.x;
      const dy = grav.y - other.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= EPS) return;
      const s = (p.pull || 0) * 0.1;
      other.x += (dx / d) * s;
      other.y += (dy / d) * s;
      keepInArena(other);
      markSkill('gravity');
    }

    function pairKey(a, b) {
      return a < b ? (a * 64 + b) : (b * 64 + a);
    }

    function resolvePair(a, b) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const minD = a.r + b.r;
      const dsq = dx * dx + dy * dy;
      if (dsq >= minD * minD) return;

      let d = Math.sqrt(dsq);
      let nx;
      let ny;
      if (d < 1e-6) { nx = 1; ny = 0; d = 1e-6; }
      else { nx = dx / d; ny = dy / d; }

      const relSpeed = Math.sqrt(
        (b.vx - a.vx) * (b.vx - a.vx) + (b.vy - a.vy) * (b.vy - a.vy)
      );

      // 位置分离（质量加权）
      const posInvA = a.invMass;
      const posInvB = b.invMass;
      const posInvSum = posInvA + posInvB;
      if (posInvSum > 0) {
        const overlap = minD - d;
        const push = overlap * SEPARATION;
        a.x -= nx * push * (posInvA / posInvSum);
        a.y -= ny * push * (posInvA / posInvSum);
        b.x += nx * push * (posInvB / posInvSum);
        b.y += ny * push * (posInvB / posInvSum);
        keepInArena(a);
        keepInArena(b);
      }

      // 弹性冲量（超重：被碰撞时自身不反弹，冲量全给对面）
      const superA = !!(a.passives.gravity && a.passives.gravity.params.superHeavy);
      const superB = !!(b.passives.gravity && b.passives.gravity.params.superHeavy);
      const invA = superA ? 0 : a.invMass;
      const invB = superB ? 0 : b.invMass;
      const invSum = invA + invB;
      const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (vn < 0 && invSum > 0) {
        const j = -(1 + RESTITUTION) * vn / invSum;
        a.vx -= j * nx * invA;
        a.vy -= j * ny * invA;
        b.vx += j * nx * invB;
        b.vy += j * ny * invB;
      }

      // 碰撞伤害（成对冷却 + 最小相对速度）
      const key = pairKey(a.id, b.id);
      const cdUntil = pairCd[key] || -1;
      if (relSpeed >= MIN_REL_SPEED && match.time >= cdUntil) {
        pairCd[key] = match.time + PAIR_COOLDOWN;
        if (a.passives.gravity) pullToward(a, b);
        if (b.passives.gravity) pullToward(b, a);
        const factor = clamp(
          (COLL.dmgSpeedBase != null ? COLL.dmgSpeedBase : 0.55) +
          (COLL.dmgSpeedGain != null ? COLL.dmgSpeedGain : 0.45) * relSpeed / (COLL.dmgSpeedNorm || 420),
          COLL.dmgSpeedMin != null ? COLL.dmgSpeedMin : 0.6,
          COLL.dmgSpeedMax != null ? COLL.dmgSpeedMax : 1.5
        );
        const atkA = a.passives.phase ? Math.max(0, a.atkBase + a.atkBonus) * attackMultOf(a) * factor : a.atkBase * attackMultOf(a) * factor;
        const atkB = b.passives.phase ? Math.max(0, b.atkBase + b.atkBonus) * attackMultOf(b) * factor : b.atkBase * attackMultOf(b) * factor;
        if (a.passives.phase) adjustPhaseAtk(a, -1);
        if (b.passives.phase) adjustPhaseAtk(b, -1);

        // 4.1：只入缓冲，不立刻扣血；双方伤害同帧统一结算
        const intentB = queueDamage(a, b, atkA, { kind: 'hit', damageType: 'collision', color: a.color });
        const intentA = queueDamage(b, a, atkB, { kind: 'hit', damageType: 'collision', color: b.color });
        collisionLog.push({ a: a, b: b, intentA: intentA, intentB: intentB });
      }
    }

    function updateCollisions() {
      collisionLog = [];
      for (let i = 0; i < entities.length; i++) {
        const a = entities[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < entities.length; j++) {
          const b = entities[j];
          if (!b.alive) continue;
          if (isImmuneNow(a) || isImmuneNow(b)) continue;
          resolvePair(a, b);
        }
      }

      // 所有球对处理完后统一结算生命/护盾/死亡（4.1）
      settleDamageQueues();

      // 结算后补挂命中被动 / 触发天雷（这些不会反过来递归改命）
      if (collisionLog.length > 0) {
        const log = collisionLog;
        collisionLog = [];
        for (let k = 0; k < log.length; k++) {
          const rec = log[k];
          const a = rec.a;
          const b = rec.b;
          if (rec.intentB && rec.intentB.total > 0 && b.alive && b.hp > 0) hitPassives(a, b);
          if (rec.intentA && rec.intentA.total > 0 && a.alive && a.hp > 0) hitPassives(b, a);
          // 天雷：每次有效碰撞触发（无内置 CD）
          if (a.alive && a.hp > 0 && a.passives.thunder) scheduleThunder(a);
          if (b.alive && b.hp > 0 && b.passives.thunder) scheduleThunder(b);
        }
        // 命中被动可能让残血目标归零（例如灼烧不致死，但这里只挂状态），统一在 checkEnd 结算
        settleDamageQueues();
      }
    }

    function normalizeSpeeds() {
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.alive) continue;
        if (e.root && e.root.remaining > 0) { e.vx = 0; e.vy = 0; continue; }
        const desired = desiredSpeedOf(e);
        const cur = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
        if (cur > 1e-6) {
          const k = desired / cur;
          e.vx *= k;
          e.vy *= k;
        } else {
          e.vx = e.facing.x * desired;
          e.vy = e.facing.y * desired;
        }
      }
    }

    /* ---------------- 随机障碍（机制，默认关闭） ---------------- */
    function nearestPointOnSegment(px, py, ax, ay, bx, by) {
      const abx = bx - ax;
      const aby = by - ay;
      const len2 = abx * abx + aby * aby;
      if (len2 <= EPS) return { x: ax, y: ay };
      let t = ((px - ax) * abx + (py - ay) * aby) / len2;
      t = clamp(t, 0, 1);
      return { x: ax + abx * t, y: ay + aby * t };
    }

    function obstaclePolyEdges(verts, ox, oy) {
      const edges = [];
      const n = verts.length;
      for (let i = 0; i < n; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % n];
        let ex = b.x - a.x;
        let ey = b.y - a.y;
        const len = Math.sqrt(ex * ex + ey * ey) || 1;
        let nx = -ey / len;
        let ny = ex / len;
        if (nx * (ox - a.x) + ny * (oy - a.y) < 0) { nx = -nx; ny = -ny; }
        edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, nx: nx, ny: ny, d: nx * a.x + ny * a.y });
      }
      return edges;
    }

    function makeObstacleShape(shapeSel, angle, size) {
      if (shapeSel === 'circle') return [];
      const n = shapeSel === 'square' ? 4 : 3;
      const base = shapeSel === 'square' ? Math.PI / 4 : -Math.PI / 2;
      const out = [];
      for (let i = 0; i < n; i++) {
        const a = angle + base + (i / n) * TAU;
        out.push({ x: Math.cos(a) * size, y: Math.sin(a) * size });
      }
      return out;
    }

    function findObstacleSpawn(size) {
      const clearance = OBSTACLE_RULE.clearance != null ? OBSTACLE_RULE.clearance : 60;
      for (let attempt = 0; attempt < 200; attempt++) {
        let x;
        let y;
        if (shape === 'triangle') {
          x = rand() * arenaW;
          y = rand() * arenaH;
          if (!triangleContains(x, y, size + 6)) continue;
        } else if (shape === 'circle') {
          const ang = rand() * TAU;
          const rr = Math.sqrt(rand()) * Math.max(0, arenaRadius - size - 6);
          x = cx + Math.cos(ang) * rr;
          y = cy + Math.sin(ang) * rr;
        } else {
          x = size + 6 + rand() * Math.max(0, arenaW - 2 * size - 12);
          y = size + 6 + rand() * Math.max(0, arenaH - 2 * size - 12);
        }
        let ok = true;
        for (let i = 0; i < entities.length; i++) {
          const e = entities[i];
          if (!e.alive) continue;
          const need = clearance + e.r + size;
          if (dist2(x, y, e.x, e.y) < need * need) { ok = false; break; }
        }
        if (!ok) continue;
        for (let i = 0; i < obstacleList.length; i++) {
          const o = obstacleList[i];
          const rr = o.r + size + 6;
          if (dist2(x, y, o.x, o.y) < rr * rr) { ok = false; break; }
        }
        if (!ok) continue;
        return { x: x, y: y };
      }
      return null;
    }

    function spawnObstacleBatch() {
      const min = OBSTACLE_RULE.min != null ? OBSTACLE_RULE.min : 1;
      const max = OBSTACLE_RULE.max != null ? OBSTACLE_RULE.max : 3;
      const count = min + Math.floor(rand() * (max - min + 1));
      const sizeMin = OBSTACLE_RULE.sizeMin != null ? OBSTACLE_RULE.sizeMin : 24;
      const sizeMax = OBSTACLE_RULE.sizeMax != null ? OBSTACLE_RULE.sizeMax : 34;
      const superChance = OBSTACLE_RULE.superChance != null ? OBSTACLE_RULE.superChance : 0.1;
      const shapes = ['circle', 'triangle', 'square'];
      for (let k = 0; k < count; k++) {
        const shapeSel = shapes[Math.floor(rand() * shapes.length)];
        const size = sizeMin + rand() * (sizeMax - sizeMin);
        const angle = rand() * TAU;
        const pt = findObstacleSpawn(size);
        if (!pt) continue;
        const isSuper = rand() < superChance;
        const localVerts = makeObstacleShape(shapeSel, angle, size);
        const verts = localVerts.map(function (v) { return { x: pt.x + v.x, y: pt.y + v.y }; });
        const life = OBSTACLE_RULE.life != null ? OBSTACLE_RULE.life : 3;
        obstacleList.push({
          id: ++obstacleSeq,
          shape: shapeSel,
          kind: isSuper ? 'superdomain' : 'wall',
          x: pt.x,
          y: pt.y,
          r: size,
          radius: size,
          angle: angle,
          vertices: verts,
          edges: verts.length ? obstaclePolyEdges(verts, pt.x, pt.y) : [],
          life: life,
          maxLife: life,
          color: isSuper ? COLOR_VIOLET : COLOR_CREAM
        });
      }
    }

    function updateObstacles(dt) {
      if (!mechanisms.randomObstacles) return;
      const interval = OBSTACLE_RULE.interval != null ? OBSTACLE_RULE.interval : 10;
      obstacleTimer += dt;
      let guard = 0;
      while (obstacleTimer >= interval && guard < 4) {
        obstacleTimer -= interval;
        guard++;
        spawnObstacleBatch();
      }
      for (let i = obstacleList.length - 1; i >= 0; i--) {
        const o = obstacleList[i];
        o.life -= dt;
        if (o.life <= 0) obstacleList.splice(i, 1);
      }
    }

    // 圆（球/蜜蜂/地雷）与障碍的分离：返回 {x,y,nx,ny} 或 null
    function resolveCircleObstacle(x, y, r, o) {
      if (o.shape === 'circle') {
        const dx = x - o.x;
        const dy = y - o.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const minD = r + o.r;
        if (d >= minD) return null;
        let nx;
        let ny;
        if (d > EPS) { nx = dx / d; ny = dy / d; } else { nx = 1; ny = 0; }
        return { x: o.x + nx * minD, y: o.y + ny * minD, nx: nx, ny: ny };
      }
      const verts = o.vertices;
      if (!verts || verts.length < 3) return null;
      const edges = o.edges;
      let minDist = Infinity;
      let minEdge = null;
      let inside = true;
      for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        const dist = edge.nx * x + edge.ny * y - edge.d;
        if (dist < 0) inside = false;
        if (dist < minDist) { minDist = dist; minEdge = edge; }
      }
      if (inside) {
        if (minDist >= r) return null;
        const push = r - minDist;
        return { x: x + minEdge.nx * push, y: y + minEdge.ny * push, nx: minEdge.nx, ny: minEdge.ny };
      }
      // 圆心在多边形外：找最近边/顶点
      let best = null;
      let bestD = Infinity;
      for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        const p = nearestPointOnSegment(x, y, edge.ax, edge.ay, edge.bx, edge.by);
        const dd = dist2(x, y, p.x, p.y);
        if (dd < bestD) { bestD = dd; best = p; }
      }
      const d = Math.sqrt(bestD);
      if (d >= r) return null;
      let nx;
      let ny;
      if (d > EPS) { nx = (x - best.x) / d; ny = (y - best.y) / d; } else { nx = 1; ny = 0; }
      return { x: best.x + nx * r, y: best.y + ny * r, nx: nx, ny: ny };
    }

    function resolveObstacleCollisions() {
      if (obstacleList.length === 0) return;
      // 小球
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.alive) continue;
        for (let k = 0; k < obstacleList.length; k++) {
          const o = obstacleList[k];
          if (hasPhaseWall(e) && o.kind === 'wall') continue;   // 穿墙/虚化可穿普通墙
          const hit = resolveCircleObstacle(e.x, e.y, e.r, o);
          if (!hit) continue;
          e.x = hit.x;
          e.y = hit.y;
          const vn = e.vx * hit.nx + e.vy * hit.ny;
          if (vn < 0) {
            e.vx -= (1 + WALL_REST) * vn * hit.nx;
            e.vy -= (1 + WALL_REST) * vn * hit.ny;
            bounceEvent(e);
          }
          keepInArena(e);
        }
      }
      // 蜜蜂（随从，所有障碍都阻挡）
      for (let i = 0; i < entities.length; i++) {
        const owner = entities[i];
        if (!owner.alive || !owner.bees || owner.bees.length === 0) continue;
        for (let b = 0; b < owner.bees.length; b++) {
          const bee = owner.bees[b];
          for (let k = 0; k < obstacleList.length; k++) {
            const hit = resolveCircleObstacle(bee.x, bee.y, bee.r, obstacleList[k]);
            if (!hit) continue;
            bee.x = hit.x;
            bee.y = hit.y;
            const pt = clampPointToArena(bee.x, bee.y, bee.r);
            bee.x = pt.x;
            bee.y = pt.y;
          }
        }
      }
      // 地雷（机关；仅被引力井推着移动时才可能碰到障碍）
      for (let i = 0; i < hazardList.length; i++) {
        const h = hazardList[i];
        if (h.kind !== 'mine' || !h.movable) continue;
        for (let k = 0; k < obstacleList.length; k++) {
          const hit = resolveCircleObstacle(h.x, h.y, h.r, obstacleList[k]);
          if (!hit) continue;
          h.x = hit.x;
          h.y = hit.y;
          const pt = clampPointToArena(h.x, h.y, h.r);
          h.x = pt.x;
          h.y = pt.y;
        }
      }
    }

    /* ---------------- 逐帧：危险物 ---------------- */
    function updateHazards(dt) {
      let i, j, h, e;

      // 生命周期 / 计时 / 地雷待发
      for (i = hazardList.length - 1; i >= 0; i--) {
        h = hazardList[i];
        h.life -= dt;
        if (h.life <= 0) { hazardList.splice(i, 1); continue; }
        if (h.kind === 'mine') {
          if (!h.armed && h.arm > 0) {
            h.arm -= dt;
            if (h.arm <= 0) { h.arm = 0; h.armed = true; }
          }
        } else {
          h.tick += dt;
        }
      }

      // 地雷：已待发的雷被小球碰到 → 爆炸（机关，无血量）
      for (i = hazardList.length - 1; i >= 0; i--) {
        h = hazardList[i];
        if (!h) continue;
        if (h.kind !== 'mine' || !h.armed) continue;
        for (j = 0; j < entities.length; j++) {
          e = entities[j];
          if (!e.alive || e.id === h.ownerId) continue;
          if (isImmuneNow(e)) continue;
          const rr = h.r + e.r;
          if (dist2(e.x, e.y, h.x, h.y) > rr * rr) continue;
          explodeMine(h);
          break;
        }
      }

      // 地雷 vs 地雷：两枚都已待发且接触 → 同时爆炸
      const armedMines = [];
      for (i = 0; i < hazardList.length; i++) {
        if (hazardList[i].kind === 'mine' && hazardList[i].armed) armedMines.push(hazardList[i]);
      }
      for (let ai = 0; ai < armedMines.length; ai++) {
        const ma = armedMines[ai];
        if (hazardList.indexOf(ma) < 0) continue;
        for (let bi = ai + 1; bi < armedMines.length; bi++) {
          const mb = armedMines[bi];
          if (hazardList.indexOf(mb) < 0) continue;
          const rr = ma.r + mb.r;
          if (dist2(ma.x, ma.y, mb.x, mb.y) > rr * rr) continue;
          if (hazardList.indexOf(ma) >= 0) explodeMine(ma);
          if (hazardList.indexOf(mb) >= 0) explodeMine(mb);
          break;
        }
      }

      // 区域效果（火痕 / 毒雾 / 引力井）
      for (i = 0; i < hazardList.length; i++) {
        h = hazardList[i];
        if (h.kind === 'mine') continue;
        const owner = byId(h.ownerId);

        if (h.kind === 'gravity') {
          const slowMult = h.slowMult != null ? h.slowMult : 0.75;
          const slowDur = h.slowDur != null ? h.slowDur : 1;
          // 小球：拉扯 + 中心减速
          for (j = 0; j < entities.length; j++) {
            e = entities[j];
            if (!e.alive || e.id === h.ownerId) continue;
            if (isImmuneNow(e)) continue;
            const dx = h.x - e.x;
            const dy = h.y - e.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d > h.r) continue;
            // “被拉到中心”的敌人减速 25%（同类取最强、刷新 1s）：只限中心区
            if (d <= SINGULARITY_CENTER_RADIUS) applySlow(e, slowMult, slowDur, 'singularity');
            if (d <= EPS || h.pull <= 0) continue;
            e.x += (dx / d) * h.pull * dt;
            e.y += (dy / d) * h.pull * dt;
            keepInArena(e);
          }
          // 召唤物：引力井可拉动可移动召唤物（地雷 / 蜜蜂）
          if (h.pull > 0) {
            for (j = 0; j < hazardList.length; j++) {
              const mine = hazardList[j];
              if (mine === h || mine.kind !== 'mine' || !mine.movable) continue;
              const dx = h.x - mine.x;
              const dy = h.y - mine.y;
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d > h.r || d <= EPS) continue;
              mine.x += (dx / d) * h.pull * dt;
              mine.y += (dy / d) * h.pull * dt;
              const pt = clampPointToArena(mine.x, mine.y, mine.r);
              mine.x = pt.x;
              mine.y = pt.y;
            }
            for (j = 0; j < entities.length; j++) {
              const beeOwner = entities[j];
              if (!beeOwner.alive || !beeOwner.bees || beeOwner.bees.length === 0) continue;
              for (let b = 0; b < beeOwner.bees.length; b++) {
                const bee = beeOwner.bees[b];
                const dx = h.x - bee.x;
                const dy = h.y - bee.y;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d > h.r || d <= EPS) continue;
                bee.x += (dx / d) * h.pull * dt;
                bee.y += (dy / d) * h.pull * dt;
                const pt = clampPointToArena(bee.x, bee.y, bee.r);
                bee.x = pt.x;
                bee.y = pt.y;
              }
            }
          }
        }

        if (h.tick >= DOT_TICK - 1e-9) {
          h.tick -= DOT_TICK;
          if (h.tick < 0) h.tick = 0;
          for (j = 0; j < entities.length; j++) {
            e = entities[j];
            if (!e.alive || e.id === h.ownerId) continue;
            if (isImmuneNow(e)) continue;
            const rr = h.r + e.r * 0.5;
            if (dist2(e.x, e.y, h.x, h.y) > rr * rr) continue;
            if (h.kind === 'fire') {
              // 火痕不造成直伤，只对进入者施加/刷新余烬
              if (h.burnOnly !== false && owner && owner.passives.burn) applyBurn(e, owner);
              continue;
            }
            // 毒雾 / 引力井：持续伤害（v0.4：吃防御/减伤/护盾/闪避，不吃反伤）
            queueDamage(owner, e, h.dps * DOT_TICK, {
              dot: true, damageType: 'dot', kind: 'hazard', color: h.color, x: e.x, y: e.y,
              poison: h.kind === 'poison'
            });
          }
          settleDamageQueues();
        }
      }
    }

    /* ---------------- 逐帧：DOT 状态 / 尖刺光环 / 过载 ---------------- */
    function updateDotsAndStates(dt) {
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.alive) continue;

        // burn / poison：每 0.25s 一次（全局节拍）
        e.dotTimer += dt;
        if (e.dotTimer >= DOT_TICK - 1e-9) {
          let ticks = Math.floor(e.dotTimer / DOT_TICK);
          if (ticks < 1) ticks = 1;
          if (ticks > 4) ticks = 4; // 防御：极端 dt 下也不会爆量
          e.dotTimer -= ticks * DOT_TICK;
          if (e.dotTimer < 0) e.dotTimer = 0;

          const st = e.status;
          if (st.burn) {
            const burnP = SKILLS.burn.params;
            const src = st.burn.src && st.burn.src.ballId ? st.burn.src : null;
            queueDamage(src, e, (st.burn.dps || burnP.dps) * st.burn.stacks * DOT_TICK * ticks, {
              dot: true, damageType: 'dot', kind: 'dot',
              color: PALETTE.orange2 || COLOR_CREAM, x: e.x, y: e.y
            });
          }
          if (st.poison) {
            const poisonP = SKILLS.venom.params;
            const src = st.poison.src && st.poison.src.ballId ? st.poison.src : null;
            queueDamage(src, e, (st.poison.dps || poisonP.dps) * st.poison.stacks * DOT_TICK * ticks, {
              dot: true, damageType: 'dot', kind: 'dot', color: '#4BE38A', x: e.x, y: e.y, poison: true
            });
          }
        }

        // spike：接触伤害
        if (e.spike && e.spike.remaining > 0) {
          e.spikeTick += dt;
          if (e.spikeTick >= DOT_TICK - 1e-9) {
            let ticks = Math.floor(e.spikeTick / DOT_TICK);
            if (ticks < 1) ticks = 1;
            if (ticks > 4) ticks = 4;
            e.spikeTick -= ticks * DOT_TICK;
            if (e.spikeTick < 0) e.spikeTick = 0;
            for (let j = 0; j < entities.length; j++) {
              const o = entities[j];
              if (!o.alive || o === e) continue;
              if (isImmuneNow(o)) continue;
              const rr = e.r + o.r + e.spike.aura;
              if (dist2(e.x, e.y, o.x, o.y) > rr * rr) continue;
              queueDamage(e, o, e.spike.contactDps * DOT_TICK * ticks, {
                dot: true, damageType: 'dot', kind: 'dot', color: e.color, x: o.x, y: o.y
              });
            }
          }
        }

        // overload：电击轨迹
        if (e.overTimer > 0) {
          const p = e.overParams;
          e.overTimer -= dt;
          e.zapTimer += dt;
          const interval = (p && p.zapInterval) || 0.5;
          let guard = 0;
          while (e.zapTimer >= interval && guard < 4) {
            e.zapTimer -= interval;
            guard++;
            if (!p) break;
            const radius = p.zapRadius || 58;
            const points = [{ x: e.x, y: e.y }];
            for (let j = 0; j < entities.length; j++) {
              const o = entities[j];
              if (!o.alive || o === e) continue;
              if (isImmuneNow(o)) continue;
              const rr = radius + o.r;
              if (dist2(e.x, e.y, o.x, o.y) > rr * rr) continue;
              queueDamage(e, o, p.zapDmg || 9, {
                damageType: 'direct', kind: 'zap', color: COLOR_CYAN, x: o.x, y: o.y
              });
              points.push({ x: o.x, y: o.y });
            }
            if (points.length > 1) emit({ type: 'chain', points: points, color: COLOR_CYAN });
          }
        }
      }
      // 本帧所有 DOT / 光环伤害统一结算
      settleDamageQueues();
    }

    /* ---------------- 逐帧：决胜时刻 ---------------- */
    function updateStorm(dt) {
      if (!mechanisms.suddenDeath) return;
      if (match.time < sudden.start) return;
      if (!suddenAnnounced) {
        suddenAnnounced = true;
        emit({
          type: 'ring', x: cx, y: cy, r: 0,
          maxR: shape === 'circle' ? arenaRadius * 1.25 : Math.max(arenaW, arenaH) * 0.62,
          color: COLOR_DANGER, kind: 'storm'
        });
      }
      stormTimer += dt;
      if (stormTimer < DOT_TICK - 1e-9) return;
      let ticks = Math.floor(stormTimer / DOT_TICK);
      if (ticks < 1) ticks = 1;
      if (ticks > 4) ticks = 4;
      stormTimer -= ticks * DOT_TICK;
      if (stormTimer < 0) stormTimer = 0;

      const dps = (sudden.dpsBase != null ? sudden.dpsBase : 1.2) +
        (sudden.dpsRamp != null ? sudden.dpsRamp : 1.6) * Math.max(0, match.time - sudden.start);
      const dmg = dps * DOT_TICK * ticks;
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.alive) continue;
        queueDamage(null, e, dmg, { damageType: 'true', kind: 'storm', ignoreShield: true });
      }
      settleDamageQueues();
    }

    /* ---------------- 逐帧：防御性收尾 ---------------- */
    function sanitizeAll() {
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!isFiniteNum(e.x)) e.x = cx;
        if (!isFiniteNum(e.y)) e.y = cy;
        if (!isFiniteNum(e.vx) || !isFiniteNum(e.vy)) { e.vx = 0; e.vy = 0; }
        if (!isFiniteNum(e.hp)) e.hp = 0;
        if (e.hp > e.maxHp) e.hp = e.maxHp;
        if (e.hp < 0) e.hp = 0;
        if (!isFiniteNum(e.shieldTotal) || e.shieldTotal < 0) e.shieldTotal = 0;
        if (!isFiniteNum(e.flash)) e.flash = 0;
        if (!isFiniteNum(e.energy) || e.energy < 0) e.energy = 0;
        if (e.energyCost > 0 && e.energy > e.energyCost + 1) e.energy = e.energyCost + 1;
        if (!isFiniteNum(e.energyCost) || e.energyCost < 0) e.energyCost = 0;
        if (!isFiniteNum(e.energyMax) || e.energyMax < 0) e.energyMax = e.energyCost;
        keepInArena(e);
        // 蜜蜂/召唤物防御性收尾
        if (e.bees && e.bees.length) {
          for (let b = e.bees.length - 1; b >= 0; b--) {
            const bee = e.bees[b];
            if (!isFiniteNum(bee.x) || !isFiniteNum(bee.y) || !isFiniteNum(bee.remaining)) { e.bees.splice(b, 1); continue; }
            const bp = clampPointToArena(bee.x, bee.y, bee.r);
            bee.x = bp.x;
            bee.y = bp.y;
          }
        }
        const st = stats[e.ballId];
        if (!isFiniteNum(st.dealt)) st.dealt = 0;
        if (!isFiniteNum(st.taken)) st.taken = 0;
        if (!isFiniteNum(st.aliveTime)) st.aliveTime = 0;
        if (!isFiniteNum(st.heal)) st.heal = 0;
        if (!isFiniteNum(st.maxHit) || st.maxHit < 0) st.maxHit = 0;
      }
      for (let i = hazardList.length - 1; i >= 0; i--) {
        const h = hazardList[i];
        if (!isFiniteNum(h.x) || !isFiniteNum(h.y) || !isFiniteNum(h.life)) {
          hazardList.splice(i, 1);
        }
      }
      for (let i = obstacleList.length - 1; i >= 0; i--) {
        const o = obstacleList[i];
        if (!isFiniteNum(o.x) || !isFiniteNum(o.y) || !isFiniteNum(o.life)) obstacleList.splice(i, 1);
      }
      if (!isFiniteNum(match.time)) match.time = timeLimit;
      if (accumulator < 0 || !isFiniteNum(accumulator)) accumulator = 0;
    }

    /* ---------------- 结束判定 ---------------- */
    function finishMatch(winner, judged) {
      if (match.status === 'over') return;
      match.status = 'over';
      match.winnerId = winner ? winner.ballId : null;
      match.judged = !!judged && !!winner;
      match.draw = !winner;
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        const st = stats[e.ballId];
        st.alive = e.alive;
        st.deathTime = e.alive ? null : e.deathTime;
        st.hpPct = e.alive ? clamp01(e.hp / e.maxHp) : 0;
        if (e.alive) st.aliveTime = match.time - e.spawnTime;
        // 对局结束时清空所有蜜蜂（快照 bees 必为空）
        e.bees = [];
        e.beeRageQuota = 0;
      }
      emit({
        type: 'over', winnerId: match.winnerId, draw: match.draw,
        time: match.time, judged: match.judged
      });
    }

    /* 4.2 双杀判定：造成伤害高 → 施法次数多 → 最大单次伤害高 → seed 派生确定顺序 */
    function judgeCompare(a, b) {
      const sa = stats[a.ballId];
      const sb = stats[b.ballId];
      if (sa.dealt !== sb.dealt) return sb.dealt - sa.dealt;
      if (sa.casts !== sb.casts) return sb.casts - sa.casts;
      if (sa.maxHit !== sb.maxHit) return sb.maxHit - sa.maxHit;
      const ha = hashStr(seed, a.ballId);
      const hb = hashStr(seed, b.ballId);
      if (ha !== hb) return ha - hb;
      return a.id - b.id;
    }

    function pickJudgedWinner() {
      // 只在本帧同时死亡者之间裁决（不能把更早淘汰的球“复活”成胜者）
      const frameDead = [];
      const allDead = [];
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (e.alive) continue;
        allDead.push(e);
        if (e.deathTime != null && Math.abs(e.deathTime - match.time) <= 1e-6) frameDead.push(e);
      }
      const pool = frameDead.length > 0 ? frameDead : allDead;
      let best = null;
      for (let i = 0; i < pool.length; i++) {
        const e = pool[i];
        if (!best || judgeCompare(e, best) < 0) best = e;
      }
      return best;
    }

    function checkEnd() {
      processPendingKills();

      let aliveCount = 0;
      let lastAlive = null;
      const hpPctMap = Object.create(null);
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        const st = stats[e.ballId];
        st.alive = e.alive;
        st.deathTime = e.alive ? null : e.deathTime;
        st.hpPct = e.alive ? clamp01(e.hp / e.maxHp) : 0;
        hpPctMap[e.ballId] = st.hpPct;
        if (e.alive) { aliveCount++; lastAlive = e; }
      }

      if (match.status === 'over') return;

      if (aliveCount === 0) {
        // 4.2 全模式：同帧全灭不再 draw，按判定顺位选出胜者
        const judgedWinner = pickJudgedWinner();
        finishMatch(judgedWinner, !!judgedWinner);
        return;
      }
      if (aliveCount === 1) {
        finishMatch(lastAlive);
        return;
      }

      // 时间上限强制判定：hpPct → dealt → lineup 顺序
      if (match.time >= timeLimit - 1e-9) {
        let best = null;
        for (let i = 0; i < entities.length; i++) {
          const e = entities[i];
          if (!e.alive) continue;
          if (!best) { best = e; continue; }
          const ep = hpPctMap[e.ballId];
          const bp = hpPctMap[best.ballId];
          if (ep > bp + 1e-9) best = e;
          else if (Math.abs(ep - bp) <= 1e-9) {
            const ed = stats[e.ballId].dealt;
            const bd = stats[best.ballId].dealt;
            if (ed > bd + 1e-9) best = e;
          }
        }
        finishMatch(best);
      }
    }

    /* ---------------- 固定步 ---------------- */
    function fixedStep(dt) {
      match.time += dt;
      updateTimers(dt);
      updateSkills(dt);
      updateMovement(dt);
      updateCollisions();
      normalizeSpeeds();
      updateBees(dt);
      updateHazards(dt);
      updateObstacles(dt);
      resolveObstacleCollisions();
      updateThunderStrikes();
      updateDotsAndStates(dt);
      updateStorm(dt);
      sanitizeAll();
      checkEnd();
    }

    /* ---------------- 对外 step ---------------- */
    function step(dt) {
      if (match.status === 'over') return;
      const input = Number(dt);
      if (!isFinite(input) || input <= 0) return;
      accumulator += Math.min(input, 0.25);
      let guard = 0;
      while (accumulator >= FIXED_DT - 1e-12 && match.status !== 'over' && guard < MAX_SUB_STEPS) {
        accumulator -= FIXED_DT;
        if (accumulator < 0) accumulator = 0;
        fixedStep(FIXED_DT);
        guard++;
      }
      if (guard >= MAX_SUB_STEPS) accumulator = 0;
      if (!isFiniteNum(accumulator) || accumulator < 0) accumulator = 0;
    }

    /* ---------------- 快照 ---------------- */
    function pushStatus(list, kind, stacks, remaining, dur, extra) {
      const entry = {
        kind: kind,
        name: effectName(kind),
        stacks: stacks,
        remaining: remaining,
        dur: dur
      };
      if (extra) {
        Object.keys(extra).forEach(function (k) { entry[k] = extra[k]; });
      }
      list.push(entry);
    }

    function snapshotEntity(e) {
      const st = e.status;
      const statuses = [];
      if (st.burn && st.burn.remaining > 0) {
        pushStatus(statuses, 'burn', st.burn.stacks, st.burn.remaining, st.burn.dur);
      }
      if (st.poison && st.poison.remaining > 0) {
        pushStatus(statuses, 'poison', st.poison.stacks, st.poison.remaining, st.poison.dur);
      }
      let slowCount = 0;
      let slowRem = 0;
      let slowDur = 0;
      for (let i = 0; i < e.slows.length; i++) {
        if (e.slows[i].remaining > 0) {
          slowCount++;
          if (e.slows[i].remaining > slowRem) slowRem = e.slows[i].remaining;
          if (e.slows[i].dur > slowDur) slowDur = e.slows[i].dur;
        }
      }
      if (slowCount > 0) pushStatus(statuses, 'slow', slowCount, slowRem, slowDur);
      if (e.root && e.root.remaining > 0) {
        pushStatus(statuses, 'root', 1, e.root.remaining, e.root.dur);
      }
      if (st.weakness && st.weakness.remaining > 0) {
        pushStatus(statuses, 'weakness', 1, st.weakness.remaining, st.weakness.dur);
      }
      if (st.armorBreak && st.armorBreak.remaining > 0) {
        pushStatus(statuses, 'armorBreak', 1, st.armorBreak.remaining, st.armorBreak.dur);
      }
      let hasteCount = 0;
      let hasteRem = 0;
      let hasteDur = 0;
      for (let i = 0; i < e.hastes.length; i++) {
        if (e.hastes[i].remaining > 0) {
          hasteCount++;
          if (e.hastes[i].remaining > hasteRem) hasteRem = e.hastes[i].remaining;
          if (e.hastes[i].dur > hasteDur) hasteDur = e.hastes[i].dur;
        }
      }
      if (hasteCount > 0) pushStatus(statuses, 'haste', hasteCount, hasteRem, hasteDur);
      if (e.spike && e.spike.remaining > 0) {
        pushStatus(statuses, 'spike', 1, e.spike.remaining, e.spike.dur);
      }
      if (e.phaseState && e.phaseState.remaining > 0) {
        // 虚化优先：与免伤同时存在时只显示虚化
        pushStatus(statuses, 'phase', 1, e.phaseState.remaining, e.phaseState.dur);
      } else if (e.immuneState && e.immuneState.remaining > 0) {
        pushStatus(statuses, 'immune', 1, e.immuneState.remaining, e.immuneState.dur);
      }
      if (e.shield && e.shield.remaining > 0 && e.shield.amount > 0) {
        pushStatus(statuses, 'shield', 1, e.shield.remaining, e.shield.dur, { amount: e.shield.amount });
      }
      const statusNames = [];
      for (let i = 0; i < statuses.length; i++) {
        if (statusNames.indexOf(statuses[i].name) < 0) statusNames.push(statuses[i].name);
      }

      // v0.4：冷却已删除，保留空数组兼容旧读取方；能量为新接口
      const cooldowns = [];

      const shield = Math.max(0, e.shieldTotal);
      const hp = clamp(e.hp, 0, e.maxHp);
      const speed = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
      const immune = isImmuneNow(e);
      const phaseActive = !!(e.phaseState && e.phaseState.remaining > 0);
      return {
        id: e.id,
        ballId: e.ballId,
        name: e.name,
        atkBonus: e.atkBonus || 0,
        en: e.en,
        color: e.color,
        color2: e.color2,
        look: e.look,
        tags: e.tags.slice(),
        summons: e.summons.slice(),
        x: e.x,
        y: e.y,
        vx: e.vx,
        vy: e.vy,
        r: e.r,
        speed: speed,
        hp: hp,
        maxHp: e.maxHp,
        hpPct: e.maxHp > 0 ? clamp01(hp / e.maxHp) : 0,
        shield: shield,
        shieldPct: e.maxHp > 0 ? clamp01(shield / e.maxHp) : 0,
        energy: Math.max(0, e.energy),
        energyMax: e.energyMax,
        energyCost: e.energyCost,
        energyPct: e.energyCost > 0 ? clamp01(e.energy / e.energyCost) : 0,
        alive: e.alive,
        flash: clamp01(e.flash),
        invuln: immune,
        spike: !!(e.spike && e.spike.remaining > 0),
        dashing: e.dashTime > 0,
        ghosting: phaseActive,
        wellGuard: !!ownWellOf(e),
        statuses: statuses,
        statusNames: statusNames,
        cooldowns: cooldowns,
        castGlow: e.castGlow ? { skillId: e.castGlow.skillId, name: e.castGlow.name, remaining: e.castGlow.remaining } : null,
        facing: { x: e.facing.x, y: e.facing.y }
      };
    }

    function snapshotHazard(h) {
      return {
        id: h.id,
        kind: h.kind,
        ownerId: h.ownerId,
        x: h.x,
        y: h.y,
        r: h.r,
        life: h.life,
        maxLife: h.maxLife,
        armed: h.kind === 'mine' ? !!h.armed : true,
        arm: h.arm,
        dmg: h.dmg,
        root: h.root,
        movable: !!h.movable,
        triggerRadius: h.kind === 'mine' ? h.r : null,
        explosionRadius: h.explosionRadius,
        activeExplosionRadius: h.activeExplosionRadius,
        color: h.color,
        radius: h.radius,
        src: h.src,
        burnOnly: !!h.burnOnly
      };
    }

    function snapshotObstacle(o) {
      return {
        id: o.id,
        shape: o.shape,
        kind: o.kind,
        super: o.kind === 'superdomain',
        x: o.x,
        y: o.y,
        r: o.r,
        radius: o.r,
        angle: o.angle,
        vertices: o.vertices.map(function (v) { return { x: v.x, y: v.y }; }),
        life: o.life,
        maxLife: o.maxLife,
        color: o.color
      };
    }

    /* 蜜蜂快照（平面数组，供渲染；蜜蜂不是可攻击实体） */
    function snapshotBees() {
      const out = [];
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.bees || e.bees.length === 0) continue;
        for (let b = 0; b < e.bees.length; b++) {
          const bee = e.bees[b];
          out.push({
            id: bee.id,
            ownerId: bee.ownerId,
            ballId: bee.ballId,
            x: bee.x,
            y: bee.y,
            r: bee.r,
            state: bee.state,                       // 'orbit' 环绕 | 'chase' 追踪
            slot: bee.slot,                         // 轨道角度槽 0..n-1
            angle: bee.angle,                       // 当前轨道角（rad）
            orbitRadius: bee.orbitRadius,           // 轨道半径（蜂群半径 + 58~66）
            frenzy: !!bee.frenzy,
            trackedOnce: !!bee.trackedOnce,          // v0.4.1：是否已开始计寿命
            remaining: Math.max(0, bee.remaining),
            maxLife: bee.maxLife,
            speed: bee.speed,
            targetId: bee.targetId
          });
        }
      }
      return out;
    }

    function stormLevel() {
      if (!mechanisms.suddenDeath) return 0;
      if (match.time <= sudden.start) return 0;
      const span = (timeLimit - sudden.start);
      if (!(span > 0)) return 1;
      return clamp01((match.time - sudden.start) / span);
    }

    function getSnapshot() {
      const snapEntities = [];
      for (let i = 0; i < entities.length; i++) snapEntities.push(snapshotEntity(entities[i]));
      const snapHazards = [];
      for (let i = 0; i < hazardList.length; i++) snapHazards.push(snapshotHazard(hazardList[i]));
      const snapObstacles = [];
      for (let i = 0; i < obstacleList.length; i++) snapObstacles.push(snapshotObstacle(obstacleList[i]));
      // 天雷预警圈（已预警、尚未落下）
      const strikes = [];
      for (let i = 0; i < pendingThunder.length; i++) {
        const t = pendingThunder[i];
        const remain = Math.max(0, t.impactAt - match.time);
        for (let s = 0; s < t.strikes.length; s++) {
          strikes.push({
            id: t.id,
            ownerId: t.ownerId,
            x: t.strikes[s].x,
            y: t.strikes[s].y,
            radius: t.radius,
            remaining: remain,
            warn: t.warn,
            color: t.color
          });
        }
      }
      return {
        version: VERSION,
        time: match.time,
        status: match.status,
        winnerId: match.winnerId,
        draw: match.draw,
        judged: match.judged,
        suddenDeath: mechanisms.suddenDeath && match.time > sudden.start,
        stormLevel: stormLevel(),
        mechanisms: { suddenDeath: mechanisms.suddenDeath, randomObstacles: mechanisms.randomObstacles, energyPrep: mechanisms.energyPrep },
        arena: (function () {
          const ar = {
            w: arenaW,
            h: arenaH,
            shape: shape,
            radius: arenaRadius,
            mapId: mapId,
            scale: scale
          };
          if (triangle) {
            ar.triangle = {
              vertices: triangle.vertices.map(function (v) { return { x: v.x, y: v.y }; }),
              edges: triangle.edges.map(function (ed) {
                return { ax: ed.ax, ay: ed.ay, bx: ed.bx, by: ed.by, nx: ed.nx, ny: ed.ny };
              }),
              radius: triangle.radius,
              inradius: triangle.inradius,
              center: { x: triangle.center.x, y: triangle.center.y }
            };
          }
          return ar;
        })(),
        entities: snapEntities,
        hazards: snapHazards,
        obstacles: snapObstacles,
        strikes: strikes,
        bees: snapshotBees(),
        damageTypes: DAMAGE_TYPES.slice()
      };
    }

    /* ---------------- 排名 ---------------- */
    function getStandings() {
      const rows = [];
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        const st = stats[e.ballId];
        rows.push({
          ballId: e.ballId,
          name: e.name,
        atkBonus: e.atkBonus || 0,
          color: e.color,
          rank: 0,
          alive: e.alive,
          hpPct: e.alive ? clamp01(e.hp / e.maxHp) : 0,
          dealt: st.dealt,
          taken: st.taken,
          kills: st.kills,
          casts: st.casts,
          heal: st.heal,
          deathTime: e.alive ? null : st.deathTime,
          _order: i
        });
      }
      const judgedWinnerId = match.judged ? match.winnerId : null;
      rows.sort(function (a, b) {
        // 4.2 双杀判定：judged 胜者排第 1（即使已死亡）
        if (judgedWinnerId) {
          if (a.ballId === judgedWinnerId) return -1;
          if (b.ballId === judgedWinnerId) return 1;
        }
        if (a.alive !== b.alive) return a.alive ? -1 : 1;
        if (a.alive) {
          if (b.hpPct !== a.hpPct) return b.hpPct - a.hpPct;
          return a._order - b._order;
        }
        const at = a.deathTime == null ? -1 : a.deathTime;
        const bt = b.deathTime == null ? -1 : b.deathTime;
        if (bt !== at) return bt - at;
        return a._order - b._order;
      });
      const out = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        out.push({
          ballId: r.ballId,
          name: r.name,
          color: r.color,
          rank: i + 1,
          alive: r.alive,
          hpPct: r.hpPct,
          dealt: r.dealt,
          taken: r.taken,
          kills: r.kills,
          casts: r.casts,
          heal: r.heal,
          deathTime: r.deathTime
        });
      }
      return out;
    }

    return match;
  }

  /* ---------------- 导出 ---------------- */
  return {
    VERSION: VERSION,
    RULES: RULES,
    createMatch: createMatch
  };
});
