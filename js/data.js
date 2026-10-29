/* ============================================================
 * 斗球场 BALL PIT — 数据层 v0.4.4
 * 规则常量 / 配色 / 效果词表 / tag / 技能表 / 小球图鉴 / 数据更新
 * 浏览器：window.GameData；Node：module.exports
 * 所有数值单位：场地坐标（760 x 760），时间单位为秒
 * 平衡基准：400 场 6 球随机阵容，单球胜率 10%–21%，均局 ~21s
 * v0.4.1：能量技能名右侧、蜂群追踪寿命、奇门引爆半径、三角预览/尺寸；B 系列 ID 仅内部使用；
 *       4.1 同时结算 / 4.2 全模式双杀判定由 sim 实现；
 *       默认关闭速胜时刻；数据更新改用日期+序号。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GameData = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '0.4.4';

  /* ---------- 全局规则 ---------- */
  const RULES = {
    version: VERSION,
    arena: { w: 760, h: 760 },
    arenaSizing: { baseScale: 0.86, perBall: 0.06 },
    energy: { perSecond: 1, start: 0 },
    energyPrep: { after: 30, mult: 2 },
    fixedDt: 1 / 120,
    minLineup: 2,
    maxLineup: 8,
    maxHazards: 64,
    maxEvents: 600,
    timeLimit: 300,
    suddenDeath: { start: 60, dpsBase: 1.2, dpsRamp: 1.6 },
    spawn: { ring: 228, jitter: 28, margin: 99, aimJitter: 0.42 },
    obstacles: {
      interval: 10, min: 1, max: 3, life: 3,
      sizeMin: 24, sizeMax: 34, superChance: 0.1, clearance: 60
    },
    collision: {
      pairCooldown: 0.42,
      restitution: 1.0,
      wallRestitution: 1.0,
      defSoftness: 82,
      dmgSpeedBase: 0.82,
      dmgSpeedGain: 0.6,
      dmgSpeedNorm: 420,
      dmgSpeedMin: 0.6,
      dmgSpeedMax: 1.6,
      minRelSpeed: 40,
      separation: 0.5
    },
    /* 排位赛 1v1：场地缩小、速胜时刻 60s。
     * statMods 只作用于排位决斗，key 使用新的 B0001–B0010。
     * v0.3 不改 v0.2 这组数值，仅做版本迁移。
     */
    duel: {
      arenaScale: 0.86,
      timeLimit: 300,
      suddenDeath: { start: 60, dpsBase: 1.6, dpsRamp: 2.4 },
      statMods: {
        B0001: { hpMul: 0.62, atkMul: 0.7, sizeMul: 0.82 },
        B0002: { hpMul: 0.78, atkMul: 0.85 },
        B0003: { hpMul: 0.85, defMul: 0.9 },
        B0004: { hpMul: 1.05, atkMul: 1.05 },
        B0005: { hpMul: 0.85, atkMul: 0.85 },
        B0006: { hpMul: 0.72, atkMul: 0.8 },
        B0007: { hpMul: 1.65, atkMul: 1.2, spdMul: 1.06 },
        B0008: { hpMul: 1.1, defMul: 1.1 },
        B0009: { hpMul: 0.9, atkMul: 0.95 },
        B0010: { hpMul: 1.15, atkMul: 1.05 }
      }
    }
  };

  /* ---------- 模式 ---------- */
  const MODES = [
    {
      id: 'basic', name: '大乱斗', en: 'RUMBLE', minLineup: 2, maxLineup: 8,
      tagline: '2–8 球 · 最后站着赢',
      desc: '把所有球扔进同一块场地，技能全自动，最后活下来的那颗赢。',
      accent: '#FF6B1A', accent2: '#FFC24B'
    },
    {
      id: 'ranked', name: '排位赛', en: 'RANKED', minLineup: 8, maxLineup: 8,
      tagline: '8 球 · 单败淘汰 · 决出 1–8 名',
      desc: '八强 → 半决赛 → 季军赛 → 决赛，全程同一张地图。每场 1v1 单独开打，输一场就定名次。',
      accent: '#B060FF', accent2: '#D9A8FF'
    }
  ];

  /* ---------- 地图 ---------- */
  const MAPS = [
    {
      id: 'square', name: '方阵', en: 'THE SQUARE', shape: 'square',
      tagline: '四面来球', feature: '镜面反弹',
      desc: '经典正方形擂台。边界按入射角镜面反弹，四个角落是杀机也是掩体。',
      accent: '#FF6B1A', accent2: '#FFC24B'
    },
    {
      id: 'circle', name: '圆环', en: 'THE RING', shape: 'circle',
      tagline: '没有死角', feature: '切线反弹',
      desc: '圆形斗兽场。边界沿切线反弹，角度被不断压缩，贴身缠斗会更多。',
      accent: '#54E6FF', accent2: '#B060FF'
    },
    {
      id: 'triangle', name: '三角', en: 'THE TRIANGLE', shape: 'triangle', sizeScale: 1.12,
      tagline: '三点成局', feature: '斜边反弹',
      desc: '等边三角形擂台。三条斜边把球不断折回中心，角落更少，正面碰撞更多。',
      accent: '#7CFF9E', accent2: '#FFC24B'
    }
  ];

  /* ---------- 对战机制 ---------- */
  const MECHANISMS = [
    {
      id: 'suddenDeath', name: '速胜时刻', en: 'SUDDEN WIN', type: 'toggle', default: false,
      tagline: '默认关闭 · 可手动开启',
      desc: '开启后 60 秒全场持续真实伤害，强制逼出胜负。默认关闭；关闭时不再掉血，到 300 秒按剩余生命值判定。',
      accent: '#FF4F6D'
    },
    {
      id: 'energyPrep', name: '能量整备', en: 'ENERGY PREP', type: 'toggle', default: false,
      tagline: '默认关闭 · 30 秒后发动',
      desc: '30 秒后全体能量回复速度翻倍。默认关闭。',
      accent: '#54E6FF'
    },
    {
      id: 'randomObstacles', name: '随机障碍', en: 'RANDOM WALLS', type: 'toggle', default: false,
      tagline: '默认关闭 · 每 10 秒生成',
      desc: '每 10 秒在场地内生成 1–3 个小型边界，持续 3 秒；90% 为普通墙，10% 为超域。普通墙可被虚化/穿墙穿过，超域不能。',
      accent: '#B060FF'
    }
  ];

  /* ---------- 配色 ---------- */
  const PALETTE = {
    ink: '#0A0910',
    ink2: '#100E18',
    panel: '#151220',
    panel2: '#1B1728',
    line: '#312A42',
    cream: '#FFF4DC',
    muted: '#A89DBB',
    orange: '#FF6B1A',
    orange2: '#FFB347',
    violet: '#B060FF',
    violet2: '#D9A8FF',
    cyan: '#54E6FF',
    danger: '#FF4F6D',
    gold: '#FFC24B',
    good: '#7CFF9E'
  };

  /* ---------- 玩家标签（tag） ---------- */
  const TAGS = [
    { name: '消耗', en: 'ATTRITION', color: '#35D6C4', desc: '靠持续伤害和消耗战把对手磨垮。' },
    { name: '冲撞', en: 'RAM', color: '#FF7A1A', desc: '靠高速碰撞和反复撞击制造伤害。' },
    { name: '召唤', en: 'SUMMON', color: '#B060FF', desc: '靠召唤物、机关或布置物替自己出手。' },
    { name: '控场', en: 'CONTROL', color: '#54E6FF', desc: '靠范围控制和减益压缩对手空间。' },
    { name: '恢复', en: 'SUSTAIN', color: '#7CFF9E', desc: '能在战斗中回复自身生命值。' },
    { name: '爆发', en: 'BURST', color: '#FFC24B', desc: '在短时间内把伤害集中打出。' },
    { name: '重装', en: 'HEAVY', color: '#8FA3B8', desc: '靠高生命值、高防御力或反伤站到最后。' },
    { name: '游走', en: 'ROAM', color: '#FF4F6D', desc: '靠高移速和走位拉扯寻找机会。' }
  ];

  /* ---------- 通用效果词表 ----------
   * 战场只显示 name；数值/持续时间在面板和 tooltip 中展示。
   * burn / poison 是技能专属，不放进通用词表。
   */
  const EFFECTS = [
    { id: 'slow', name: '减速', en: 'SLOW', desc: '降低移速。', note: '同类取最强，不叠层，刷新持续时间；不同类可共存；移速下限 10%，无上限。', stackRule: '同类取最强，不叠层，刷新持续时间；不同类可共存。' },
    { id: 'haste', name: '加速', en: 'HASTE', desc: '提高移速。', note: '同类取最强，不叠层，刷新持续时间；与减速共存时按乘区计算。', stackRule: '同类取最强，不叠层，刷新持续时间；不同类可共存。' },
    { id: 'dash', name: '突进', en: 'DASH', desc: '以倍速快速冲向目标。', note: '技能位移效果，不是可叠加状态。', stackRule: '技能位移效果，不是可叠加状态。' },
    { id: 'evade', name: '闪避', en: 'EVADE', desc: '有概率躲避一次伤害。', note: '取最高概率，不做加法叠到 100%。', stackRule: '取最高概率，不做加法叠到 100%。' },
    { id: 'root', name: '定身', en: 'ROOT', desc: '无法主动移动。', note: '不叠层，刷新时长；仍可被击退或碰撞位移。', stackRule: '不叠层，刷新时长；仍可被击退或碰撞位移。' },
    { id: 'immune', name: '免伤', en: 'IMMUNE', desc: '不受到伤害。', note: '不叠层；与虚化同时存在时由虚化覆盖。', stackRule: '不叠层；与虚化同时存在时由虚化覆盖。' },
    { id: 'damageReduction', name: '减伤', en: 'DAMAGE REDUCTION', desc: '按百分比降低受到的伤害。', note: '减伤类效果取最高或按来源叠加；免伤是完全不受伤，不等同于减伤。', stackRule: '减伤类效果按来源结算；免伤是完全不受伤。' },
    { id: 'phase', name: '虚化', en: 'PHASE', desc: '免伤并免疫碰撞。', note: '不叠层；虚化期间同时视为免伤。', stackRule: '不叠层；虚化期间同时视为免伤。' },
    { id: 'superHeavy', name: '超重', en: 'SUPER HEAVY', desc: '被碰撞时自身不反弹。', note: '不叠层；只影响被撞反弹，不等于免伤。', stackRule: '不叠层；只影响被撞反弹，不等于免伤。' },
    { id: 'armorBreak', name: '破甲', en: 'ARMOR BREAK', desc: '降低 50% 防御力。', note: '不可叠加，刷新时长；统一 50%。', stackRule: '不可叠加，刷新时长；统一 50%。' },
    { id: 'weakness', name: '虚弱', en: 'WEAKNESS', desc: '降低 50% 攻击力。', note: '不可叠加，刷新时长；统一 50%。', stackRule: '不可叠加，刷新时长；统一 50%。' },
    { id: 'shield', name: '护盾', en: 'SHIELD', desc: '吸收伤害的临时护盾。', note: '不叠层，取最高护盾值/刷新时长；吸收发生在减伤之后；不受治疗加成影响。', stackRule: '不叠层，取最高护盾值/刷新时长；吸收发生在减伤之后；不受治疗加成影响。' },
    { id: 'heal', name: '回复', en: 'HEAL', desc: '恢复生命值。', note: '不受减伤影响；受治疗加成影响（当前为 1.0）；不会转化为护盾。', stackRule: '不受减伤影响；受治疗加成影响（当前为 1.0）；不会转化为护盾。' },
    { id: 'reflect', name: '反伤', en: 'REFLECT', desc: '反弹受到的撞击伤害或直接伤害的一定比例。', note: '不反持续/真实伤害；无血量召唤物造成的伤害不反伤召唤物与本体；有血量召唤物只反伤召唤物，不反伤本体。', stackRule: '只反撞击/直接伤害；无血量召唤物不反伤召唤物与本体。' },
    { id: 'knockback', name: '击退', en: 'KNOCKBACK', desc: '沿远离来源的方向位移。', note: '位移效果，不是持续状态。', stackRule: '位移效果，不是持续状态。' },
    { id: 'phaseWall', name: '穿墙', en: 'PHASE WALL', desc: '可以穿过普通墙；不能穿过超域。', note: '通用效果，不限于幽灵；从一侧穿出、从另一侧穿入。', stackRule: '可穿普通墙，不能穿超域。' }
  ];

  /* ---------- 伤害类型 ---------- */
  const DAMAGE_TYPES = [
    { id: 'collision', name: '撞击伤害', en: 'IMPACT', desc: '原始伤害 = 攻击力 × 攻击修正 × 速度系数；最终伤害受防御力、减伤与护盾影响。' },
    { id: 'direct', name: '直接伤害', en: 'DIRECT', desc: '原始伤害 = 技能表述伤害；最终伤害受防御力、减伤与护盾影响。' },
    { id: 'dot', name: '持续伤害', en: 'DOT', desc: '原始伤害 = 技能表述伤害；最终伤害受防御力、减伤与护盾影响，也吃闪避。' },
    { id: 'true', name: '真实伤害', en: 'TRUE', desc: '原始伤害 = 最终伤害，无视防御力、减伤与护盾。' }
  ];

  /* ---------- 边界 ---------- */
  const BOUNDARIES = [
    { id: 'wall', name: '普通墙', en: 'WALL', desc: '场地的常规边界。普通球撞上会反弹；获得穿墙或虚化的单位可以穿过。' },
    { id: 'superdomain', name: '超域', en: 'SUPERDOMAIN', desc: '随机障碍中的特殊边界。普通球撞上会反弹；穿墙/虚化也无法穿过。' }
  ];

  /* ---------- 召唤物 ---------- */
  const SUMMON_TAGS = [
    { id: 'independent', name: '独立', en: 'INDEPENDENT', color: '#FFC24B', desc: '拥有独立生命值、攻击力、防御力等完整属性。' },
    { id: 'follower', name: '随从', en: 'FOLLOWER', color: '#54E6FF', desc: '没有独立五维，跟随召唤者行动。' },
    { id: 'device', name: '机关', en: 'DEVICE', color: '#B060FF', desc: '没有独立五维的布置物或装置，可固定或可被移动。' }
  ];

  const SUMMONS = {
    mine: {
      id: 'mine', name: '地雷', en: 'MINE', summonTag: 'device',
      desc: '奇门布设的机关。敌人触碰或与其他地雷碰撞时爆炸。',
      damageType: 'direct', dmg: 5,
      triggerRadius: 18, explosionRadius: 26, activeExplosionRadius: 80,
      root: 0.7, arm: 0.6, life: 14, max: 6, movable: true
    },
    bee: {
      id: 'bee', name: '蜜蜂', en: 'BEE', summonTag: 'follower',
      desc: '蜂群召唤的随从。会绕蜂群盘旋，未追踪时不会消失；开始追踪后普通蜂最多飞行 3 秒、狂暴蜂最多 6 秒；未追上会原地爆炸消失。',
      damageType: 'direct', dmg: 3, frenzyDmg: 8, spawnInterval: 3,
      life: 3, frenzyLife: 6, untrackedLife: '∞', max: 3, trackRadius: 180,
      speed: 'owner', movable: true
    }
  };

  /* ---------- 音乐播放口（v0.4 预留，不内置音频） ----------
   * 之后把音频放到 assets/music/ 或提供 data URI，填入 src 即可；
   * BallAudio 会读取这些槽位，见 README「音乐导入」。
   */
  const MUSIC_SLOTS = [
    { id: 'lobby_paradise', slot: 'lobby', name: '不存在的乐园', src: '', default: true },
    { id: 'lobby_mist', slot: 'lobby', name: '微茫', src: '' },
    { id: 'battle', slot: 'battle', name: '赴大荒', src: '' }
  ];

  /* ---------- 技能表 ----------
   * kind: passive | active
   * sigil: 印章式单字，用于 UI 技能徽记
   * params: 引擎读取的唯一数值来源（文案与数值必须一致）
   * ------------------------------------------------ */
  const SKILLS = {
    burn: {
      id: 'burn', name: '余烬', en: 'EMBER', kind: 'passive', sigil: '灼',
      desc: '碰撞命中时附加灼烧：每秒造成 5 点持续伤害，持续 2 秒；不可叠加，重复命中刷新持续时间。',
      params: { dps: 5, dur: 2, maxStacks: 1 }
    },
    armor: {
      id: 'armor', name: '重甲', en: 'HEAVY PLATING', kind: 'passive', sigil: '甲',
      desc: '获得 15% 减伤；生命值不高于 30% 时，减伤提高至 30%。',
      params: { mult: 0.85, lowHpThreshold: 0.30, lowHpMult: 0.70 }
    },
    trapmaker: {
      id: 'trapmaker', name: '布雷', en: 'MINEFIELD', kind: 'passive', sigil: '埋',
      desc: '每 2.5 秒在脚下布设 1 颗地雷；地雷为机关，详情见召唤物。',
      params: { interval: 2.5, dmg: 5, root: 0.7, arm: 0.6, life: 14, radius: 26, maxMines: 6 }
    },
    frostbite: {
      id: 'frostbite', name: '冰痕', en: 'CHILL', kind: 'passive', sigil: '霜',
      desc: '碰撞命中时，使目标减速 28%，并施加虚弱与破甲，持续 2 秒。',
      params: { slowMult: 0.72, dur: 2, weakMult: 0.5, armorBreakMult: 0.5 }
    },
    thunder: {
      id: 'thunder', name: '天雷', en: 'THUNDER', kind: 'passive', sigil: '雷',
      desc: '每次碰撞后，在场地内随机位置降下 2 道天雷。预警 0.35 秒后，对半径 80 内的敌人造成 5 点直接伤害；同一目标可被同一触发的多道天雷命中，不会命中自身，无内置冷却。',
      params: { strikes: 2, dmg: 5, radius: 80, warn: 0.35, maxHitsPerTarget: 99, selfHit: false, pureRandom: true }
    },
    venom: {
      id: 'venom', name: '腐蚀', en: 'CORROSION', kind: 'passive', sigil: '毒',
      desc: '碰撞命中时附加中毒：每秒造成 4 点持续伤害，持续 2 秒，最多叠加 3 层。巫医造成毒伤后，回复该次毒伤 50% 的生命值，每秒最多回复 10 点；仅毒伤触发（含主动毒雾）。重复命中刷新持续时间。',
      params: { dps: 4, dur: 2, maxStacks: 3, healPct: 0.5, healCapPerSecond: 10 }
    },
    phase: {
      id: 'phase', name: '穿墙', en: 'PHASEWALL', kind: 'passive', sigil: '穿',
      desc: '获得穿墙；获得减伤 12%。每穿过一次普通墙，攻击力 +1；每发生一次碰撞，攻击力 -1。攻击力修正范围 -10 至 +20。',
      params: { dmgMult: 0.88, atkPerWall: 1, atkPerCollision: -1, atkBonusMin: -10, atkBonusMax: 20 }
    },
    gravity: {
      id: 'gravity', name: '质量', en: 'MASS', kind: 'passive', sigil: '引',
      desc: '获得超重；质量提高至 2 倍，撞击时将对方拉向自己。',
      params: { massMult: 2, pull: 130, superHeavy: true }
    },
    thorns: {
      id: 'thorns', name: '反伤', en: 'BARBS', kind: 'passive', sigil: '刺',
      desc: '获得反伤 25%。',
      params: { reflect: 0.25 }
    },
    swarm_hive: {
      id: 'swarm_hive', name: '蜂群召唤', en: 'HIVE CALL', kind: 'passive', sigil: '蜂',
      desc: '每 3 秒召唤 1 只蜜蜂；敌人靠近时开始追踪。蜜蜂为随从，详情见召唤物。',
      params: { spawnInterval: 3, maxBees: 3, trackRadius: 180, beeLife: 3, beeDmg: 3, retargetRadius: 260 }
    },

    meteor_drop: {
      id: 'meteor_drop', name: '陨星撞击', en: 'METEOR DROP', kind: 'active', sigil: '陨',
      desc: '向最近的敌人突进 0.8 秒（移速 ×2.1），沿途留下持续 2.0 秒、半径 42 的火痕；进入火痕的敌人被施加余烬。',
      params: { energyCost: 8, dur: 0.8, speedMult: 2.1, trailLife: 2.0, trailRadius: 42, trailInterval: 0.1, trailBurn: true }
    },
    cage: {
      id: 'cage', name: '连环引爆', en: 'CHAIN DETONATION', kind: 'active', sigil: '爆',
      desc: '引爆场上所有地雷；主动引爆时每颗地雷的溅射范围扩大，命中的敌人被定身。地雷为机关，详情见召唤物。',
      params: { energyCost: 15, detonate: true, dmg: 5, explosionRadius: 60, root: 0.7 }
    },
    bulwark: {
      id: 'bulwark', name: '盾墙', en: 'BULWARK', kind: 'active', sigil: '盾',
      desc: '获得 30 点护盾，持续 5 秒；击退半径 180 内的敌人，并使其减速 40%，持续 0.8 秒。',
      params: { energyCost: 9, shield: 30, dur: 5, knockback: 260, radius: 180, slowMult: 0.6, slowDur: 0.8 }
    },
    blizzard: {
      id: 'blizzard', name: '霜爆', en: 'BLIZZARD', kind: 'active', sigil: '爆',
      desc: '对半径 230 内的敌人造成 14 点直接伤害，并使其减速 45%，持续 2.5 秒；可移动的召唤物也会被减速。',
      params: { energyCost: 9, radius: 230, dmg: 14, slowMult: 0.55, dur: 2.5, slowSummons: true }
    },
    overload: {
      id: 'overload', name: '过载', en: 'OVERLOAD', kind: 'active', sigil: '过',
      desc: '过载 3 秒：加速 55%，移动轨迹电击触碰的敌人，每 0.5 秒造成 9 点直接伤害。',
      params: { energyCost: 8, dur: 3, speedMult: 1.55, zapDmg: 9, zapRadius: 58, zapInterval: 0.5 }
    },
    miasma: {
      id: 'miasma', name: '毒雾', en: 'MIASMA', kind: 'active', sigil: '雾',
      desc: '在当前位置释放毒雾：半径 115，持续 5 秒，每秒造成 9 点持续伤害；毒雾属于毒伤，可触发腐蚀的回复。',
      params: { energyCost: 7, radius: 115, life: 5, dps: 9 }
    },
    wraith: {
      id: 'wraith', name: '虚化', en: 'WRAITH', kind: 'active', sigil: '虚',
      desc: '获得虚化，持续 1.2 秒；加速 25%。',
      params: { energyCost: 8, dur: 1.2, speedMult: 1.25 }
    },
    singularity: {
      id: 'singularity', name: '引力井', en: 'SINGULARITY', kind: 'active', sigil: '井',
      desc: '在当前位置制造引力井：半径 240，持续 2 秒，每秒造成 4.5 点持续伤害并拉扯敌人与召唤物；黑洞在井内获得减伤 20%，被拉到中心的敌人减速 25%，持续 1 秒。',
      params: {
        energyCost: 10, radius: 240, life: 2, pull: 300, dps: 4.5,
        selfDmgTakenMult: 0.8, centerSlowMult: 0.75, centerSlowDur: 1, pullSummons: true
      }
    },
    spike: {
      id: 'spike', name: '尖刺形态', en: 'SPIKE FORM', kind: 'active', sigil: '棘',
      desc: '进入尖刺形态，持续 5 秒：接触的敌人每秒受到 8 点持续伤害；获得反伤 70%。',
      params: { energyCost: 10, dur: 5, contactDps: 8, reflect: 0.7, aura: 18 }
    },
    swarm_rage: {
      id: 'swarm_rage', name: '蜂群暴动', en: 'SWARM RAGE', kind: 'active', sigil: '暴',
      desc: '立即补满蜜蜂并全部转换为狂暴蜂；本次暴动共 6 只狂暴蜂额度。详情见召唤物。',
      params: { energyCost: 12, frenzyCharges: 6, refill: 3, beeLife: 6, beeDmg: 8, retargetRadius: 280 }
    }
  };

  /* ---------- 小球图鉴 ----------
   * id = B0001–B0010（字符串，稳定，不随改名变化）
   * stats.size = 半径（场地单位）；spd = 恒定移速（单位/秒）
   * tags：最多 2 个，主 tag 在前
   * look：渲染器外观原型
   * ------------------------------------------------ */
  const BALLS = [
    {
      id: 'B0001', name: '流星', en: 'METEOR', tags: ['冲撞', '消耗'],
      color: '#FF7A1A', color2: '#FFC24B', look: 'meteor',
      stats: { hp: 155, def: 10, atk: 15, spd: 290, size: 52 },
      skills: ['burn', 'meteor_drop'],
      bio: '它把每一面墙都当成助燃剂。',
      quote: '烧起来才算打过。'
    },
    {
      id: 'B0002', name: '奇门', en: 'TRAPPER', tags: ['召唤', '控场'],
      color: '#B060FF', color2: '#E6B8FF', look: 'trapper',
      stats: { hp: 150, def: 14, atk: 9, spd: 235, size: 58 },
      skills: ['trapmaker', 'cage'],
      summons: ['mine'],
      bio: '它不追你，它让整块场地追你。',
      quote: '踩哪儿，你说了不算。'
    },
    {
      id: 'B0003', name: '装甲', en: 'IRONCLAD', tags: ['重装'],
      color: '#8FA3B8', color2: '#D8E6F2', look: 'iron',
      stats: { hp: 118, def: 20, atk: 15, spd: 205, size: 85 },
      skills: ['armor', 'bulwark'],
      bio: '它不需要躲，它只是把整个战场撞小。',
      quote: '撞。'
    },
    {
      id: 'B0004', name: '霜降', en: 'FROST', tags: ['控场'],
      color: '#54E6FF', color2: '#CFFBFF', look: 'frost',
      stats: { hp: 175, def: 12, atk: 13, spd: 255, size: 51 },
      skills: ['frostbite', 'blizzard'],
      bio: '被它碰过的球，连逃跑都像在慢放。',
      quote: '冷一点，看得清。'
    },
    {
      id: 'B0005', name: '特斯拉', en: 'VOLT', tags: ['爆发', '游走'],
      color: '#FFD642', color2: '#FFF7B8', look: 'volt',
      stats: { hp: 175, def: 12, atk: 18, spd: 315, size: 38 },
      skills: ['thunder', 'overload'],
      bio: '它自己也不知道下一次会电到谁。',
      quote: '噼。'
    },
    {
      id: 'B0006', name: '巫医', en: 'VENOM', tags: ['消耗', '恢复'],
      color: '#4BE38A', color2: '#C8FFD9', look: 'venom',
      stats: { hp: 150, def: 10, atk: 10, spd: 240, size: 53 },
      skills: ['venom', 'miasma'],
      bio: '赢不赢另说，反正你赛后得难受很久。',
      quote: '慢慢来。'
    },
    {
      id: 'B0007', name: '幽灵', en: 'PHANTOM', tags: ['游走'],
      color: '#C9C4FF', color2: '#FFFFFF', look: 'ghost',
      stats: { hp: 102, def: 6, atk: 14, spd: 300, size: 48 },
      skills: ['phase', 'wraith'],
      bio: '边界拦不住它，因为它觉得边界不存在。',
      quote: '借过。'
    },
    {
      id: 'B0008', name: '黑洞', en: 'GRAVITON', tags: ['控场'],
      color: '#FF5CD0', color2: '#FFC7EF', look: 'grav',
      stats: { hp: 185, def: 18, atk: 11, spd: 215, size: 64 },
      skills: ['gravity', 'singularity'],
      bio: '它不撞你，它让所有东西都往它那边倒。',
      quote: '过来。'
    },
    {
      id: 'B0009', name: '荆棘', en: 'THORN', tags: ['重装'],
      color: '#FF4F6D', color2: '#FFC2CB', look: 'thorn',
      stats: { hp: 160, def: 16, atk: 12, spd: 230, size: 56 },
      skills: ['thorns', 'spike'],
      bio: '先动手的那个，通常后悔得最快。',
      quote: '你确定？'
    },
    {
      id: 'B0010', name: '蜂群', en: 'SWARM', tags: ['召唤', '游走'],
      color: '#C6FF3D', color2: '#F2FFC2', look: 'swarm',
      stats: { hp: 120, def: 5, atk: 10, spd: 330, size: 38 },
      skills: ['swarm_hive', 'swarm_rage'],
      summons: ['bee'],
      bio: '落单的时候不可怕，问题是它从来不会落单。',
      quote: '嗡。'
    }
  ];

  /* 旧 ID → 新 ID；只用于迁移/旧链接兼容，不要在新代码里使用旧 ID */
  const LEGACY_ID_MAP = {
    meteor: 'B0001', trapper: 'B0002', iron: 'B0003', frost: 'B0004', volt: 'B0005',
    venom: 'B0006', phantom: 'B0007', graviton: 'B0008', thorn: 'B0009', swarm: 'B0010'
  };

  /* ---------- 数据更新记录（供 UI 数据更新页） ----------
   * tag: heat 升温 / cool 降温 / neutral 平调 / rework 升级 / meta 资料
   * 纯改名/文案用 meta，不占四 tag。
   */
  const DATA_PATCHES = [
  {
    "date": "2026-10-29",
    "seq": 4,
    "entries": [
      {
        "id": "2026-10-29-04-bee-heat",
        "ballId": "B0010",
        "ballName": "蜂群",
        "target": "蜂群召唤",
        "tag": "heat",
        "changes": [
          {
            "field": "追踪半径",
            "before": 150,
            "after": 180,
            "unit": ""
          },
          {
            "field": "普通蜜蜂伤害",
            "before": 2,
            "after": 3,
            "unit": "点"
          },
          {
            "field": "狂暴蜂伤害",
            "before": 6,
            "after": 8,
            "unit": "点"
          }
        ],
        "summary": "追踪半径提高到 180；普通蜂伤害 3、狂暴蜂伤害 8。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      }
    ]
  },
  {
    "date": "2026-10-29",
    "seq": 3,
    "entries": [
      {
        "id": "2026-10-29-03-bee-up",
        "ballId": "B0010",
        "ballName": "蜂群",
        "target": "蜂群召唤",
        "tag": "up",
        "changes": [
          {
            "field": "蜜蜂视觉大小",
            "before": "3.4×",
            "after": "1.7×"
          },
          {
            "field": "环绕距离",
            "before": 58,
            "after": 30,
            "unit": ""
          },
          {
            "field": "追踪半径",
            "before": 90,
            "after": 150,
            "unit": ""
          },
          {
            "field": "追踪动画",
            "before": "原速",
            "after": "平滑插值"
          }
        ],
        "summary": "蜜蜂视觉缩小一倍、环绕更靠近蜂群；追踪半径 150，追踪位置插值更平滑；未追上原地爆炸。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      }
    ]
  },
  {
    "date": "2026-10-29",
    "seq": 2,
    "entries": [
      {
        "id": "2026-10-29-02-bee-track",
        "ballId": "B0010",
        "ballName": "蜂群",
        "target": "蜂群召唤",
        "tag": "cool",
        "changes": [
          {
            "field": "追踪半径",
            "before": 180,
            "after": 90,
            "unit": ""
          }
        ],
        "summary": "蜜蜂追踪半径下调至 90。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      }
    ]
  },
  {
    "date": "2026-10-29",
    "seq": 1,
    "entries": [
      {
        "id": "2026-10-29-01-bee",
        "ballId": "B0010",
        "ballName": "蜂群",
        "target": "蜂群召唤",
        "tag": "heat",
        "changes": [
          {
            "field": "蜜蜂生成间隔",
            "before": 5,
            "after": 3,
            "unit": "秒"
          }
        ],
        "summary": "蜜蜂生成更快：每 3 秒召唤 1 只，仍最多 3 只。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      },
      {
        "id": "2026-10-29-01-phase",
        "ballId": "B0007",
        "ballName": "幽灵",
        "target": "穿墙",
        "tag": "heat",
        "changes": [
          {
            "field": "穿墙攻击力",
            "before": "无",
            "after": "每次穿普通墙 +1"
          },
          {
            "field": "碰撞攻击力",
            "before": "无",
            "after": "每次碰撞 -1"
          },
          {
            "field": "攻击力修正范围",
            "before": "无",
            "after": "-10 至 +20"
          }
        ],
        "summary": "穿墙积累攻击力，碰撞削减攻击力；修正范围 -10 至 +20。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      }
    ]
  },
  {
    "date": "2026-10-28",
    "seq": 4,
    "entries": [
      {
        "id": "2026-10-28-04-bee",
        "ballId": "B0010",
        "ballName": "蜂群",
        "target": "蜂群召唤 / 蜜蜂寿命",
        "tag": "rework",
        "changes": [
          {
            "field": "未追踪寿命",
            "before": "3 秒",
            "after": "无限"
          },
          {
            "field": "追踪后寿命",
            "before": "3 秒（生成计时）",
            "after": "普通蜂 3 秒、狂暴蜂 6 秒（开始追踪后计时）"
          }
        ],
        "summary": "蜜蜂未开始追踪时不会消失；开始追踪后才开始计算 3/6 秒寿命。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      },
      {
        "id": "2026-10-28-04-mine",
        "ballId": "B0002",
        "ballName": "奇门",
        "target": "连环引爆 / 主动引爆溅射范围",
        "tag": "heat",
        "changes": [
          {
            "field": "主动引爆溅射范围",
            "before": 60,
            "after": 80,
            "unit": ""
          }
        ],
        "summary": "主动技能引爆所有地雷时，地雷的爆炸半径由 60 提高到 80；触发半径仍 18、普通爆炸溅射仍 26。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      }
    ]
  },
  {
    "date": "2026-10-28",
    "seq": 3,
    "entries": [
      {
        "id": "2026-10-28-03-mine",
        "ballId": "B0002",
        "ballName": "奇门",
        "target": "布雷 / 连环引爆 / 地雷机制",
        "tag": "rework",
        "changes": [
          {
            "field": "地雷伤害",
            "before": 15,
            "after": 5,
            "unit": "点直接伤害"
          },
          {
            "field": "主动",
            "before": "捕兽夹阵：布设3颗地雷",
            "after": "连环引爆：引爆全部地雷，爆炸范围更大",
            "unit": ""
          },
          {
            "field": "能量需求",
            "before": "冷却 10 秒",
            "after": 15,
            "unit": "能量"
          },
          {
            "field": "地雷碰撞",
            "before": "不碰撞",
            "after": "已待发地雷互相碰撞会爆炸"
          }
        ],
        "summary": "地雷伤害下调；主动改为引爆全场地雷并扩大爆炸范围；地雷可被引力井拉动、互相碰撞引爆。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      },
      {
        "id": "2026-10-28-03-meteor",
        "ballId": "B0001",
        "ballName": "流星",
        "target": "生命值",
        "tag": "cool",
        "changes": [
          {
            "field": "生命值",
            "before": 165,
            "after": 155,
            "unit": ""
          }
        ],
        "summary": "生命值下调 10 点。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      },
      {
        "id": "2026-10-28-03-armor",
        "ballId": "B0003",
        "ballName": "装甲",
        "target": "重甲",
        "tag": "heat",
        "changes": [
          {
            "field": "减伤",
            "before": "15%",
            "after": "15%；生命值 ≤30% 时提高至 30%",
            "unit": ""
          }
        ],
        "summary": "新增低血量强化减伤；减伤术语统一。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      },
      {
        "id": "2026-10-28-03-gravity",
        "ballId": "B0008",
        "ballName": "黑洞",
        "target": "引力井",
        "tag": "heat",
        "changes": [
          {
            "field": "拉扯对象",
            "before": "仅小球",
            "after": "小球与召唤物",
            "unit": ""
          }
        ],
        "summary": "引力井可以拉动召唤物。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      },
      {
        "id": "2026-10-28-03-frost",
        "ballId": "B0004",
        "ballName": "霜降",
        "target": "霜爆",
        "tag": "heat",
        "changes": [
          {
            "field": "减速对象",
            "before": "仅小球",
            "after": "小球与召唤物",
            "unit": ""
          }
        ],
        "summary": "霜爆可以降低召唤物移速。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      }
    ]
  },
  {
    "date": "2026-10-28",
    "seq": 2,
    "entries": [
      {
        "id": "0.3.0-meteor-01",
        "ballId": "B0001",
        "ballName": "流星",
        "target": "基础攻击力 / 余烬 / 陨星撞击",
        "tag": "cool",
        "changes": [
          {
            "field": "攻击力",
            "before": 18,
            "after": 15,
            "unit": ""
          },
          {
            "field": "余烬每秒伤害",
            "before": 6,
            "after": 5,
            "unit": "点/秒"
          },
          {
            "field": "余烬持续时间",
            "before": 3,
            "after": 2,
            "unit": "秒"
          },
          {
            "field": "火痕效果",
            "before": "独立的每秒 10 点持续伤害",
            "after": "进入火痕者被施加余烬"
          }
        ],
        "summary": "攻击力下调；余烬缩短且不可叠加；火痕只施加余烬，不再有独立伤害。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      },
      {
        "id": "0.3.0-volt-01",
        "ballId": "B0005",
        "ballName": "特斯拉",
        "target": "天雷",
        "tag": "neutral",
        "changes": [
          {
            "field": "落点",
            "before": "敌人附近随机",
            "after": "场地内任意位置"
          },
          {
            "field": "半径",
            "before": 60,
            "after": 80,
            "unit": ""
          },
          {
            "field": "命中限制",
            "before": "同一目标一次最多 1 次",
            "after": "同一触发可多次命中同一目标"
          }
        ],
        "summary": "改为真正的场地随机雷击；范围更大、可重复命中，但更容易落空。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      },
      {
        "id": "0.3.0-swarm-01",
        "ballId": "B0010",
        "ballName": "蜂群",
        "target": "闪避 / 狂暴 → 蜂群召唤 / 蜂群暴动",
        "tag": "rework",
        "changes": [
          {
            "field": "被动",
            "before": "闪避（15% 概率免伤）",
            "after": "蜂群召唤（每 5 秒生成蜜蜂，最多 3 只）"
          },
          {
            "field": "主动",
            "before": "狂暴（攻击力/回复）",
            "after": "蜂群暴动（补满并强化 6 只蜜蜂）"
          },
          {
            "field": "tag",
            "before": "游走 / 爆发",
            "after": "召唤 / 游走"
          }
        ],
        "summary": "蜂群改为召唤型：蜜蜂自动生成，近距离追踪；主动强化接下来 6 只蜜蜂。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      }
    ]
  },
  {
    "date": "2026-10-28",
    "seq": 1,
    "entries": [
      {
        "id": "0.2.0-meteor-01",
        "ballId": "B0001",
        "ballName": "流星",
        "target": "余烬 / 陨星撞击",
        "tag": "cool",
        "changes": [
          {
            "field": "余烬叠层上限",
            "before": 2,
            "after": 1,
            "unit": "层"
          },
          {
            "field": "火痕持续时间",
            "before": 2.5,
            "after": 2,
            "unit": "秒"
          }
        ],
        "summary": "被动不再叠层；突进火痕缩短，爆发窗口收紧。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      },
      {
        "id": "0.2.0-venom-01",
        "ballId": "B0006",
        "ballName": "巫医",
        "target": "腐蚀 / 毒雾",
        "tag": "rework",
        "changes": [
          {
            "field": "腐蚀持续时间",
            "before": 4,
            "after": 2,
            "unit": "秒"
          },
          {
            "field": "毒伤回复",
            "before": 0,
            "after": 50,
            "unit": "%"
          },
          {
            "field": "毒伤回复上限",
            "before": 0,
            "after": 10,
            "unit": "/秒"
          }
        ],
        "summary": "腐蚀改为短毒；巫医造成毒伤后回复该次伤害 50%，每秒上限 10 点。毒雾同样算毒伤。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      },
      {
        "id": "0.2.0-volt-01",
        "ballId": "B0005",
        "ballName": "特斯拉",
        "target": "电弧 → 天雷",
        "tag": "rework",
        "changes": [
          {
            "field": "被动",
            "before": "电弧（每 3 次碰撞连锁闪电）",
            "after": "天雷（每次碰撞随机 2 处落雷）"
          },
          {
            "field": "伤害 / 半径",
            "before": "12 / 240",
            "after": "5 / 60",
            "unit": ""
          },
          {
            "field": "预警",
            "before": "无",
            "after": "0.35",
            "unit": "秒"
          }
        ],
        "summary": "每次碰撞触发 2 处天雷；无内置冷却；同一目标一次最多命中一次；不电自己。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      },
      {
        "id": "0.2.0-frost-01",
        "ballId": "B0004",
        "ballName": "霜降",
        "target": "冰痕",
        "tag": "rework",
        "changes": [
          {
            "field": "减速",
            "before": 28,
            "after": 28,
            "unit": "%"
          },
          {
            "field": "新增",
            "before": "—",
            "after": "虚弱 / 破甲（各 50%）"
          },
          {
            "field": "持续时间",
            "before": 1.6,
            "after": 2,
            "unit": "秒"
          }
        ],
        "summary": "碰撞附加虚弱与破甲，持续 2 秒；两者不可叠加，刷新持续时间。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      },
      {
        "id": "0.2.0-graviton-01",
        "ballId": "B0008",
        "ballName": "黑洞",
        "target": "引力井",
        "tag": "rework",
        "changes": [
          {
            "field": "半径",
            "before": 230,
            "after": 240,
            "unit": ""
          },
          {
            "field": "持续时间",
            "before": 1.8,
            "after": 2,
            "unit": "秒"
          },
          {
            "field": "每秒伤害",
            "before": 4,
            "after": 4.5,
            "unit": ""
          },
          {
            "field": "井内减伤",
            "before": 0,
            "after": 20,
            "unit": "%"
          }
        ],
        "summary": "黑洞在井内受到伤害降低 20%；中心敌人减速 25% 1 秒。",
        "modes": [
          "大乱斗",
          "排位赛"
        ]
      },
      {
        "id": "0.2.0-meta-01",
        "ballId": null,
        "ballName": null,
        "target": "图鉴命名 / ID 整理",
        "tag": "meta",
        "changes": [
          {
            "field": "小球 ID",
            "before": "meteor–swarm",
            "after": "B0001–B0010"
          },
          {
            "field": "中文名",
            "before": "流星球 / 陷阱手 / 铁壁 / 霜环 / 电球 / 毒球 / 引力球 / 荆棘球 / 蜂群球",
            "after": "流星 / 奇门 / 装甲 / 霜降 / 特斯拉 / 巫医 / 黑洞 / 荆棘 / 蜂群"
          },
          {
            "field": "装甲被动",
            "before": "装甲",
            "after": "重甲"
          }
        ],
        "summary": "幽灵保留原名；英文名暂不修改；常规球/异种球 tag 取消，改为技能 tag。",
        "modes": [
          "全模式"
        ]
      }
    ]
  }
];

  const BALL_BY_ID = {};
  BALLS.forEach(function (b) { BALL_BY_ID[b.id] = b; });

  const MAP_BY_ID = {};
  MAPS.forEach(function (m) { MAP_BY_ID[m.id] = m; });

  const MODE_BY_ID = {};
  MODES.forEach(function (m) { MODE_BY_ID[m.id] = m; });

  const MECHANISM_BY_ID = {};
  MECHANISMS.forEach(function (m) { MECHANISM_BY_ID[m.id] = m; });

  const DEFAULT_MECHANISMS = {};
  MECHANISMS.forEach(function (m) {
    if (m.type === 'toggle') DEFAULT_MECHANISMS[m.id] = !!m.default;
  });

  const TAG_BY_NAME = {};
  TAGS.forEach(function (t) { TAG_BY_NAME[t.name] = t; });

  return {
    VERSION: VERSION,
    RULES: RULES,
    PALETTE: PALETTE,
    TAGS: TAGS,
    TAG_BY_NAME: TAG_BY_NAME,
    EFFECTS: EFFECTS,
    DAMAGE_TYPES: DAMAGE_TYPES,
    BOUNDARIES: BOUNDARIES,
    SUMMON_TAGS: SUMMON_TAGS,
    SUMMONS: SUMMONS,
    MUSIC_SLOTS: MUSIC_SLOTS,
    SKILLS: SKILLS,
    BALLS: BALLS,
    BALL_BY_ID: BALL_BY_ID,
    LEGACY_ID_MAP: LEGACY_ID_MAP,
    MAPS: MAPS,
    MAP_BY_ID: MAP_BY_ID,
    MODES: MODES,
    MODE_BY_ID: MODE_BY_ID,
    MECHANISMS: MECHANISMS,
    MECHANISM_BY_ID: MECHANISM_BY_ID,
    DEFAULT_MECHANISMS: DEFAULT_MECHANISMS,
    DATA_PATCHES: DATA_PATCHES
  };
});
