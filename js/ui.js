/* ============================================================
 * 斗球场 BALL PIT — 界面层 window.BallUI（v0.4）
 * 只操作 DOM：大厅 / 战场准备 / 斗士 / 玩法 / 更新 / 设置
 *             选球 / 战斗 / 结算 + 柜头 / 底部 Tab / 弹层
 * 数据只读 js/data.js、js/lore.js；表情统一走 js/faces.js（BallFaces）
 *
 * v0.4：能量条替代冷却；战斗档案移到右侧战况下方；召唤物栏；
 *       数据更新按日期+序号分组；三角地图 / 随机障碍 / 边界说明。
 * ============================================================ */
(function (root) {
  'use strict';

  var G = null;

  var U = {
    initialized: false,
    screen: null,
    min: 2,
    max: 8,
    data: null,
    cb: {},
    lineup: [],
    activeId: null,
    reduced: false,
    refs: {},
    battle: null,
    modal: null,
    toastTimer: 0,
    resizeRaf: 0,
    arenaSize: 0,
    muted: false,
    speed: 1,
    paused: false,
    countdown: null,
    lastCountdown: null,
    lastFocus: null,
    /* 流程 / 模式 */
    mode: 'basic',
    map: 'square',
    home: { mode: 'basic', map: 'square' },
    mechanisms: null,
    tournament: null,
    tournamentMeta: null,
    battleMeta: null,
    changelog: { markdown: '', source: 'loading', note: '', version: '', updatedAt: '' },
    changelogPickTimer: 0,
    route: 'home',
    detailPinned: false,
    favoriteId: null,                 // 收藏（localStorage 持久化，只在斗士详情切换）
    lobbyViewId: null,                // 大厅当前展示（收藏 / 随机 / 手动换一个）
    lobbyRotateTimer: 0,
    settings: { volume: 70, muted: false, reduced: false, volumeApi: null, musicVolume: 60, musicTrack: '' },
    codex: { q: '', tag: '', sel: null, tab: 'battle' },
    patches: { tab: 'system', tag: '', ball: '', sourceOpen: false },
    guide: { tab: 'controls' },
    prep: { from: 'home' },           // 战场准备返回目标：home | roster
    sheet: null,
    battleInfo: { ballId: null, pinned: false, el: null },
    lastTabbarKey: '',
    hoverFine: true,
    faceRaf: 0,
    faceLastPaint: 0,
    fxTimer: 0,
    fxPressTimer: 0,
    fxTouchDown: false
  };

  var STORE_KEY = 'ballpit.v04.prefs';
  var OLD_STORE_KEYS = ['ballpit.v03.prefs', 'ballpit.v12.prefs'];
  var LEGACY_ALIASES = {
    meteor: 'B0001', trapper: 'B0002', iron: 'B0003', frost: 'B0004', volt: 'B0005',
    venom: 'B0006', phantom: 'B0007', graviton: 'B0008', thorn: 'B0009', swarm: 'B0010'
  };

  var STAT_DEFS = [
    { key: 'hp', label: '生命值', color: '#FF6B1A' },
    { key: 'def', label: '防御力', color: '#54E6FF' },
    { key: 'atk', label: '攻击力', color: '#FF4F6D' },
    { key: 'spd', label: '移速', color: '#FFC24B' },
    { key: 'size', label: '体型', color: '#B060FF' }
  ];

  /* v1.2：战场状态只显示效果名字（来自 GameData.EFFECTS），
   * 下面只是 data 里缺 EFFECTS 时的兜底与旧快照 kind 的兼容。 */
  var STATUS_LABELS = {
    slow: '减速', haste: '加速', root: '定身', immune: '免伤', phase: '虚化',
    superHeavy: '超重', armorBreak: '破甲', weakness: '虚弱', shield: '护盾',
    heal: '回复', reflect: '反伤', knockback: '击退', phaseWall: '穿墙',
    dash: '突进', evade: '闪避', burn: '灼烧', poison: '中毒',
    /* v1.1 旧 kind 兼容 */
    atkUp: '攻击提升', spike: '尖刺', invuln: '虚化'
  };

  var SPEEDS = [0.5, 1, 2];

  var DATA_TAGS = [
    { id: 'heat', name: '升温', en: 'HEAT', color: '#FF7A1A', desc: '纯数值加强。' },
    { id: 'cool', name: '降温', en: 'COOL', color: '#54E6FF', desc: '纯数值削弱。' },
  { id: 'up', name: '升级', en: 'UPGRADE', color: '#FFD642', desc: '机制、召唤物或表现升级。' },
    { id: 'neutral', name: '平调', en: 'NEUTRAL', color: '#B060FF', desc: '同一对象有加有减，且仅为数值调整。' },
    { id: 'rework', name: '升级', en: 'REWORK', color: '#FFC24B', desc: '技能机制或内容重做（即使伴随加强/削弱）。' },
    { id: 'meta', name: '资料', en: 'META', color: '#8C7FA5', desc: '纯改名 / 文案 / 资料整理，不占四 tag。' }
  ];

  /* 系统更新（固定分类；可由 GameData.SYSTEM_UPDATES 覆盖/追加） */
  var SYSTEM_CATEGORIES = [
    { id: 'modes', name: '新增模式', en: 'MODES' },
    { id: 'maps', name: '地图', en: 'MAPS' },
    { id: 'systems', name: '系统优化', en: 'SYSTEMS' },
    { id: 'ux', name: '体验优化', en: 'UX' },
    { id: 'balance', name: '平衡调整', en: 'BALANCE' },
    { id: 'fix', name: '修复', en: 'FIXES' },
    { id: 'multi', name: '多端', en: 'DEVICES' }
  ];

  var SYSTEM_UPDATES_FALLBACK = {
    versions: [
      {
        version: '0.4.4',
        date: '2026-10-29',
        note: '召唤物图案、技能名称精简、蜜蜂显示与追踪半径调整。',
        entries: [
          { cat: 'ux', text: '召唤物栏显示地雷 / 蜜蜂的像素图案。' },
          { cat: 'ux', text: '技能面板不再显示英文技能名。' },
          { cat: 'ux', text: '战场蜜蜂视觉尺寸缩小，减少遮挡。' },
          { cat: 'balance', text: '蜂群蜜蜂视觉缩小一倍、环绕更近；追踪半径 180，普通蜂伤害 3 / 狂暴蜂 8（升温）；追踪后普通 3s / 狂暴 6s，未追上原地爆炸。' }
        ]
      },
      {
        version: '0.4.3',
        date: '2026-10-29',
        note: '能量标注重排、模式卡清理；新增能量整备机制，幽灵穿墙攻击累积与蜂群生成间隔调整。',
        entries: [
          { cat: 'systems', text: '主动技能块把「能量需求 X / 自动释放」移到「主动技能」下方，名称与英文名独立成组；被动不显示能量。' },
          { cat: 'ux', text: '删除大厅模式卡下方的小球色点，保持模式卡布局不变。' },
          { cat: 'systems', text: '新增「能量整备」机制：默认关闭，开启后 30 秒全体能量回复速度翻倍。' },
          { cat: 'balance', text: '幽灵穿墙攻击累积：每次穿普通墙 +1、每次碰撞 -1，修正范围 -10 至 +20。' },
          { cat: 'balance', text: '蜂群召唤间隔调整为 3 秒，仍最多 3 只。' },
          { cat: 'ux', text: '战斗档案显示攻击力基础值 + 当前修正与来源；蜂群召唤物显示生成间隔与场上普通/狂暴数量。' },
          { cat: 'multi', text: '移动端技能标签与档案布局继续适配。' }
        ]
      },
      {
        version: '0.4.2',
        date: '2026-10-29',
        note: '音乐正式接入：大厅可在「不存在的乐园 / 微茫」之间切换，战斗固定「赴大荒」，速胜不切歌。',
        entries: [
          { cat: 'systems', text: '新增真实音乐播放：大厅曲目可选并记住选择，战斗使用固定曲目。' },
          { cat: 'ux', text: '设置页音乐音量启用；大厅音乐下拉即时切换并保存到本地。' },
          { cat: 'ux', text: '速胜时刻沿用战斗曲，不单独切换音乐。' },
          { cat: 'multi', text: '移动端设置页音乐控件保持可点、可读。' }
        ]
      },
      {
        version: '0.4.1',
        date: '2026-10-28',
        note: '技能能量标注右置、选球页上下文精简、大厅水印下移、三角预览统一为细线；蜜蜂寿命与奇门爆炸半径调整。',
        entries: [
          { cat: 'systems', text: '主动技能名称右侧显示「能量需求 X」与「自动释放」，技能说明不再重复能量需求；被动不显示。' },
          { cat: 'systems', text: '奇门「连环引爆」额外提示：场上没有地雷时保留能量；不写入技能说明。' },
          { cat: 'ux', text: '选球页顶部只显示已选地图与已开启的机制；关闭的机制不显示。' },
          { cat: 'ux', text: '大厅展示栏的英文名水印移到卡片底侧，降低对比，不再压住名字与按钮。' },
          { cat: 'maps', text: '三角地图预览改为细线等边三角形，与方阵/圆环预览质感统一。' },
          { cat: 'balance', text: '蜜蜂未追踪时寿命无限；开始追踪后普通蜂 3 秒、狂暴蜂 6 秒。' },
          { cat: 'balance', text: '奇门连环引爆的主动爆炸半径提高至 80。' },
          { cat: 'ux', text: '召唤物栏显示未追踪 ∞、追踪后 3 秒、狂暴追踪 6 秒。' },
          { cat: 'multi', text: '焦点态、留白与移动端档案布局做一轮收口。' }
        ]
      },
      {
        version: '0.4.0',
        date: '2026-10-28',
        note: '主动技能改为能量：满能量自动施放。新增召唤物、三角地图、随机障碍与超域边界；战斗档案移到右侧战况下方。',
        entries: [
          { cat: 'maps', text: '新增三角地图：三条斜边镜面反弹，场地随参战数缩放。' },
          { cat: 'systems', text: '新增随机障碍机制：每 10 秒生成 1–3 个边界，90% 普通墙 / 10% 超域。' },
          { cat: 'systems', text: '新增边界词表：普通墙可被虚化/穿墙穿过，超域不可穿过。' },
          { cat: 'systems', text: '主动技能不再使用冷却，改为能量：每秒 +1，满能量自动施放，施放后扣除能量需求。' },
          { cat: 'systems', text: '新增召唤物数据与召唤物栏：地雷（机关）、蜜蜂（随从）；独立召唤物预留。' },
          { cat: 'balance', text: '地雷伤害下调，主动改为引爆全场地雷；装甲低血量时减伤提高；持续伤害改吃防御/减伤/护盾/闪避。' },
          { cat: 'ux', text: '战斗 HUD 每条球新增能量蓝条，满/即将满有高亮；技能说明改为「能量需求」。' },
          { cat: 'ux', text: '战斗中点击底部血条或球，在右侧战况下方展开战斗档案；点击固定，Esc/关闭恢复。' },
          { cat: 'ux', text: '斗士详情与战斗档案新增召唤物栏，被动/主动/召唤物并排展示。' },
          { cat: 'ux', text: '玩法新增「边界」说明；tag 页只保留定义，不再列出同 tag 斗士。' },
          { cat: 'ux', text: '结算与排位最终排名新增「治疗量」列。' },
          { cat: 'fix', text: '统一减伤/免伤、减速/加速/突进、穿墙等词；减速/加速/突进可查看说明。' },
          { cat: 'multi', text: '移动端战斗档案改为底部覆盖层，保留关闭按钮；其余布局保持 44px 触控目标。' },
          { cat: 'systems', text: '数据更新改用日期 + 当日序号分组，不再使用 v0.x 版本号。' }
        ]
      },
      {
        version: '0.3.0',
        date: '2026-10-28',
        note: '重做大厅动线、斗士档案与像素表情，并加入蜂群与伤害类型。数值改动见「数据更新」。',
        entries: [
          { cat: 'modes', text: '大乱斗与排位赛保持不变；排位赛仍为 8 位单败淘汰。' },
          { cat: 'maps', text: '地图选择前移到「战场准备」，方阵与圆环的说明也放在那里。' },
          { cat: 'systems', text: '像素表情统一：大厅、斗士、战场共用同一套表情与状态。' },
          { cat: 'systems', text: '斗士详情新增「战斗 / 档案」两页，档案收录出生日期、故事、关系与轶闻。' },
          { cat: 'systems', text: '技能里的减速、护盾等通用效果词会高亮，悬停或按住可查看规则说明。' },
          { cat: 'systems', text: '更新记录拆成系统更新与数据更新两页，历史版本默认折叠。' },
          { cat: 'ux', text: '大厅只选模式，之后进入战场准备选择地图与机制，再挑选斗士。' },
          { cat: 'ux', text: '大厅精简：去掉多余标签与说明，喜欢改为在斗士档案中收藏。' },
          { cat: 'ux', text: '选球卡片更紧凑，去掉简介，只保留 tag、属性与技能。' },
          { cat: 'ux', text: '属性名称统一为生命值、防御力、攻击力、移速、体型。' },
          { cat: 'ux', text: '斗士、选球、战斗与结算都不再显示内部编号。' },
          { cat: 'balance', text: '流星攻击力与余烬下调；特斯拉天雷重做；蜂群改为召唤流。' },
          { cat: 'fix', text: '修复部分界面残留的旧称呼与重复说明。' },
          { cat: 'multi', text: '手机端按住效果词查看说明，松开收起；其余布局保持 44px 触控目标。' },
          { cat: 'multi', text: '移动端底部导航与安全区适配继续保留。' }
        ]
      },
      {
        version: '0.2.0',
        date: '2026-10-28',
        note: '大厅、图鉴与选球详情改版；数据层整理内部编号。',
        entries: [
          { cat: 'systems', text: '内部编号整理（界面不显示）；新增通用效果词表与数据更新记录。' },
          { cat: 'systems', text: '默认关闭速胜时刻；同时伤害结算与双杀判定在全部模式生效。' },
          { cat: 'ux', text: '新增赛事大厅、图鉴、玩法与更新页；选球详情改为点击固定。' },
          { cat: 'ux', text: '战斗 HUD 支持查看完整属性；倍速改为 0.5× / 1× / 2×。' },
          { cat: 'balance', text: '流星降温；霜降、特斯拉、巫医、黑洞调整。详见「数据更新」0.2。' }
        ]
      },
      {
        version: '0.1.0',
        date: '2026-10-27',
        note: '第一个可玩的测试版本。',
        entries: [
          { cat: 'modes', text: '排位赛：8 位单败淘汰，决出 1–8 名。' },
          { cat: 'maps', text: '新增圆形地图与赛事大厅。' },
          { cat: 'systems', text: '对战机制开关、更新日志、移动端布局与键盘操作。' },
          { cat: 'balance', text: '大乱斗基础平衡调整，平均对局约 20 秒。' }
        ]
      }
    ]
  };

  var MAX_FEED = 40;

  /* ================= utils ================= */
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $all(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function clamp(n, a, b) { return n < a ? a : (n > b ? b : n); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return pad2(Math.floor(sec / 60)) + ':' + pad2(sec % 60);
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Number(sec) || 0);
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return pad2(m) + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  function hexSeed(seed) {
    if (seed == null || isNaN(seed)) return '----';
    return ('000000' + (Number(seed) >>> 0).toString(16).toUpperCase()).slice(-6);
  }

  function mixColor(hex, blackRatio) {
    var h = String(hex || '#FF6B1A').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return '#000000';
    var r = Math.round(((n >> 16) & 255) * (1 - blackRatio));
    var g = Math.round(((n >> 8) & 255) * (1 - blackRatio));
    var b = Math.round((n & 255) * (1 - blackRatio));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
  }

  function canonicalId(id) {
    if (id === null || id === undefined) return null;
    var s = String(id);
    if (!s) return null;
    if (G && G.BALL_BY_ID && G.BALL_BY_ID[s]) return s;
    var map = (G && G.LEGACY_ID_MAP) || LEGACY_ALIASES;
    if (map && map[s] && G && G.BALL_BY_ID && G.BALL_BY_ID[map[s]]) return map[s];
    return null;
  }
  function ballById(id) {
    var cid = canonicalId(id);
    return (cid && G && G.BALL_BY_ID && G.BALL_BY_ID[cid]) || null;
  }
  function skillById(id) {
    return (G && G.SKILLS && G.SKILLS[id]) || null;
  }

  /* ---------- v1.2 tag / 效果 / 数据更新 ---------- */
  function tagsOf(ball) {
    if (!ball) return [];
    if (Array.isArray(ball.tags) && ball.tags.length) return ball.tags.slice(0, 2);
    return [];
  }
  function tagList() {
    if (G && Array.isArray(G.TAGS) && G.TAGS.length) return G.TAGS;
    return [];
  }
  var FALLBACK_TAG_COLORS = ['#FF7A1A', '#7CFF9E', '#B060FF', '#54E6FF', '#FFC24B', '#8FA3B8', '#FF4F6D'];
  function tagDef(name) {
    var list = tagList();
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
    var byName = G && G.TAG_BY_NAME && G.TAG_BY_NAME[name];
    if (byName) return byName;
    var idx = 0;
    list.forEach(function (t, i) { if (t.name === name) idx = i; });
    return { name: name, en: '', color: FALLBACK_TAG_COLORS[idx % FALLBACK_TAG_COLORS.length], desc: '' };
  }
  function tagsHTML(ball, cls) {
    return tagsOf(ball).map(function (name) {
      var t = tagDef(name);
      return '<span class="tag tag--skill ' + (cls || '') + '" style="--tag-color:' + esc(t.color || '#A89DBB') + '">' + esc(name) + '</span>';
    }).join('');
  }
  function tagChipsHTML(tags, current, actName) {
    var all = '<button type="button" class="filter-chip ' + (!current ? 'is-on' : '') + '" data-act="' + actName + '" data-tag="" aria-pressed="' + (!current ? 'true' : 'false') + '">全部</button>';
    return all + tags.map(function (t) {
      var on = current === t.name;
      return '<button type="button" class="filter-chip ' + (on ? 'is-on' : '') + '" data-act="' + actName + '" data-tag="' + esc(t.name) + '" ' +
        'style="--tag-color:' + esc(t.color || '#A89DBB') + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<i class="filter-chip__dot" aria-hidden="true"></i>' + esc(t.name) + '</button>';
    }).join('');
  }

  function effectsList() {
    return (G && Array.isArray(G.EFFECTS)) ? G.EFFECTS : [];
  }
  function effectById(id) {
    var list = effectsList();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function statusName(kind) {
    var e = effectById(kind);
    if (e && e.name) return e.name;
    return STATUS_LABELS[kind] || String(kind || '状态');
  }
  function statusKindOf(status) {
    return status && (status.kind || status.id || status.type) || '';
  }

  function dataTagDef(tagId) {
    for (var i = 0; i < DATA_TAGS.length; i++) if (DATA_TAGS[i].id === tagId) return DATA_TAGS[i];
    return DATA_TAGS[0];
  }
  function dataPatches() {
    var raw = G && G.DATA_PATCHES;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.patches)) return raw.patches;
    return [raw];
  }
  function versionParts(v) {
    return String(v == null ? '' : v).replace(/^v/i, '').split('.').map(function (n) { return parseInt(n, 10) || 0; });
  }
  function versionDesc(a, b) {
    var pa = versionParts(a), pb = versionParts(b);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var d = (pb[i] || 0) - (pa[i] || 0);
      if (d) return d;
    }
    return 0;
  }
  /* 系统更新版本列表（最新在前）；兼容 GameData.SYSTEM_UPDATES:
   *   {versions:[{version,date,note,entries}]} / [{...}] / {version,date,note,entries} */
  function systemUpdateVersions() {
    var raw = G && G.SYSTEM_UPDATES;
    var list = null;
    if (raw) {
      if (Array.isArray(raw.versions)) list = raw.versions;
      else if (Array.isArray(raw)) list = raw;
      else if (raw.entries) list = [raw];
    }
    if (!list || !list.length) list = SYSTEM_UPDATES_FALLBACK.versions;
    return list.filter(function (v) { return v && Array.isArray(v.entries); }).map(function (v) {
      return { version: v.version || '', date: v.date || '', note: v.note || '', entries: v.entries };
    }).sort(function (a, b) { return versionDesc(a.version, b.version); });
  }

  /* ---------- v0.3 本地偏好（收藏 / 设置） ---------- */
  function storeGet(key, fallback) {
    try {
      var raw = root.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function storeSet(key, value) {
    try { root.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* file:// 或隐私模式静默降级 */ }
  }
  function savePrefs() {
    storeSet(STORE_KEY, {
      volume: U.settings.volume,
      musicVolume: U.settings.musicVolume,
      musicTrack: U.settings.musicTrack || '',
      reduced: !!U.settings.reduced,
      favorite: U.favoriteId || ''
    });
  }
  function loadPrefs() {
    var prefs = storeGet(STORE_KEY, null);
    if (!prefs) {
      for (var i = 0; i < OLD_STORE_KEYS.length; i++) {
        var old = storeGet(OLD_STORE_KEYS[i], null);
        if (old) { prefs = old; break; }
      }
      prefs = prefs || {};
      if (prefs.favorite) savePrefsSoon();
    }
    var vol = Number(prefs.volume);
    U.settings.volume = isFinite(vol) ? clamp(Math.round(vol), 0, 100) : 70;
    var mv = Number(prefs.musicVolume);
    U.settings.musicVolume = isFinite(mv) ? clamp(Math.round(mv), 0, 100) : 60;
    U.settings.musicTrack = typeof prefs.musicTrack === 'string' ? prefs.musicTrack : '';
    var mq = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
    U.settings.reduced = prefs.reduced === true || (prefs.reduced === undefined && !!(mq && mq.matches));
    U.reduced = !!U.settings.reduced;
    var fav = prefs.favorite;
    if (fav) {
      var cid = canonicalId(fav);
      if (cid) U.favoriteId = cid;
    }
    U.lobbyViewId = U.favoriteId || null;
  }
  function savePrefsSoon() {
    root.requestAnimationFrame(function () { savePrefs(); });
  }

  function isNarrow() {
    return !!(root.matchMedia && root.matchMedia('(max-width: 900px)').matches);
  }
  function fmtSpeed(n) {
    n = Number(n) || 1;
    return (n % 1 === 0 ? String(n) : String(n)) + '×';
  }
  function fmtNum(v) {
    if (v === null || v === undefined || v === '') return '—';
    var n = Number(v);
    if (!isFinite(n)) return String(v);
    return String(Math.round(n * 100) / 100);
  }
  function statMaxAll() { return statMax(); }


  /* ---------- v1.1 模式 / 地图 ---------- */
  function modeById(id) {
    if (G && G.MODE_BY_ID && G.MODE_BY_ID[id]) return G.MODE_BY_ID[id];
    var list = (G && G.MODES) || [];
    return list[0] || { id: 'basic', name: '大乱斗', en: 'RUMBLE', minLineup: 2, maxLineup: 8, accent: '#FF6B1A', accent2: '#FFC24B' };
  }
  function mapById(id) {
    if (G && G.MAP_BY_ID && G.MAP_BY_ID[id]) return G.MAP_BY_ID[id];
    var list = (G && G.MAPS) || [];
    return list[0] || { id: 'square', name: '方阵', en: 'THE SQUARE', shape: 'square', accent: '#FF6B1A', accent2: '#FFC24B' };
  }
  function currentMode() { return modeById(U.mode); }
  function currentMap() { return mapById(U.map); }

  function modeIconHTML(mode) {
    var ranked = mode.id === 'ranked';
    return '<span class="mode-glyph mode-glyph--' + (ranked ? 'ranked' : 'rumble') + '" aria-hidden="true">' +
      (ranked ? '<i></i><i></i><b></b>' : '<i></i><i></i><i></i>') + '</span>';
  }
  function mapShapeClass(map) {
    var shape = (map && map.shape) || 'square';
    if (shape !== 'circle' && shape !== 'triangle') shape = 'square';
    return 'map-preview--' + shape;
  }
  function mapPreviewHTML(map, cls) {
    var shape = (map && map.shape) || 'square';
    var extra = cls ? ' ' + cls : '';
    if (shape === 'triangle') {
      return '<span class="map-preview map-preview--triangle' + extra + '" aria-hidden="true">' +
          '<svg class="map-preview__tri" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" focusable="false">' +
            '<polygon class="map-preview__tri-halo" points="50,7.6 93,82 7,82"></polygon>' +
            '<polygon class="map-preview__tri-line" points="50,7.6 93,82 7,82"></polygon>' +
          '</svg>' +
        '</span>';
    }
    var shapeCls = shape === 'circle' ? 'circle' : 'square';
    return '<span class="map-preview map-preview--' + shapeCls + extra + '" aria-hidden="true"><i></i><b></b></span>';
  }
  function mapGlyphHTML(map, cls) {
    var shape = (map && map.shape) || 'square';
    if (shape !== 'circle' && shape !== 'triangle') shape = 'square';
    var extra = cls ? ' ' + cls : '';
    if (shape === 'triangle') {
      return '<span class="map-glyph map-glyph--triangle' + extra + '" aria-hidden="true">' +
          '<svg viewBox="0 0 12 11" focusable="false"><polygon points="6,1.4 10.7,9.8 1.3,9.8"></polygon></svg>' +
        '</span>';
    }
    return '<span class="map-glyph map-glyph--' + shape + extra + '" aria-hidden="true"><i></i></span>';
  }
  function badgeModeHTML(mode) {
    return '<span class="badge badge--mode" style="--ba:' + esc(mode.accent || '#FF6B1A') + '">' +
      '<i aria-hidden="true"></i>' + esc(mode.name) + '<em>' + esc(mode.en || '') + '</em></span>';
  }
  function badgeMapHTML(map) {
    return '<span class="badge badge--map" style="--ba:' + esc(map.accent || '#FF6B1A') + '">' +
      mapGlyphHTML(map, 'map-glyph--xs') + esc(map.name) + '<em>' + esc(map.en || '') + '</em></span>';
  }
  function rosterRules() {
    var mode = currentMode();
    var min = mode.minLineup != null ? mode.minLineup : (U.min || 2);
    var max = mode.maxLineup != null ? mode.maxLineup : (U.max || 8);
    if (U.mode === 'ranked') { min = 8; max = 8; }
    return { min: min, max: max, exact: U.mode === 'ranked' };
  }

  /* ---------- v1.1.1 机制 ---------- */
  function mechanismDefs() {
    return (G && G.MECHANISMS) || [];
  }
  function defaultMechanisms() {
    return Object.assign({}, (G && G.DEFAULT_MECHANISMS) || { suddenDeath: true });
  }
  function sanitizeMechanisms(input) {
    var out = defaultMechanisms();
    if (input && typeof input === 'object') {
      Object.keys(out).forEach(function (k) {
        if (input[k] !== undefined) out[k] = !!input[k];
      });
    }
    return out;
  }
  function mechOn(id) {
    if (!U.mechanisms) U.mechanisms = defaultMechanisms();
    return !!U.mechanisms[id];
  }
  function mechBadgeHTML() {
    return mechBadgesHTML();
  }
  function mechBadgesHTML() {
    var on = mechanismDefs().filter(function (m) {
      return m.type !== 'locked' && !m.locked && mechOn(m.id);
    });
    if (!on.length) return '';
    return on.map(function (m) {
      return '<span class="badge badge--mech is-on">' +
        '<i aria-hidden="true"></i>' + esc(m.name) + '<em>' + esc(m.en || '') + '</em></span>';
    }).join('');
  }
  function mechSummaryText() {
    var on = mechanismDefs().filter(function (m) {
      return m.type !== 'locked' && !m.locked && mechOn(m.id);
    });
    if (!on.length) return '未开启';
    var ep = (G && G.RULES && G.RULES.energyPrep) || { after: 30, mult: 2 };
    return on.map(function (m) {
      if (m.id === 'energyPrep') return esc(m.name) + '（' + esc(ep.after != null ? ep.after : 30) + 's 后 ×' + esc(ep.mult != null ? ep.mult : 2) + '）';
      return esc(m.name);
    }).join(' · ');
  }
  function stormLabelText(sudden) {
    if (!mechOn('suddenDeath')) return esc(mechName('suddenDeath')) + ' 关';
    if (sudden) return esc(mechName('suddenDeath'));
    return esc(mechName('suddenDeath')) + ' ' + suddenStartForBattle() + 's';
  }

  function orbStyle(ball) {
    return '--c:' + esc(ball.color) + ';--c2:' + esc(ball.color2) + ';--cd:' + mixColor(ball.color, 0.55);
  }

  /* ---------- v0.3：共享像素表情（js/faces.js / BallFaces） ---------- */
  function faceCanvasHTML(ball, state, cls) {
    if (!ball) return '';
    var st = state || 'idle';
    return '<canvas class="orb__px ' + (cls || '') + '" data-face-ball="' + esc(ball.id) + '" data-face-state="' + esc(st) + '" width="48" height="48" aria-hidden="true"></canvas>';
  }

  function paintFaceCanvas(cv, now) {
    if (!root.BallFaces || !cv || !cv.getContext) return;
    var ballId = cv.getAttribute('data-face-ball');
    var state = cv.getAttribute('data-face-state') || 'idle';
    if (!ballId) return;
    var count = 1, dur = 500;
    try {
      count = root.BallFaces.frameCount(ballId, state) || 1;
      dur = root.BallFaces.frameDuration(ballId, state) || 500;
    } catch (e) { }
    var frame = U.reduced ? 0 : (Math.floor((now || 0) / Math.max(60, dur)) % count);
    if (cv.getAttribute('data-face-frame') === String(frame) && cv.width > 1) return;
    var rect = cv.getBoundingClientRect ? cv.getBoundingClientRect() : null;
    var dpr = Math.min(2, root.devicePixelRatio || 1);
    var size = Math.max(24, Math.round(((rect && rect.width) || 48) * dpr));
    if (cv.width !== size || cv.height !== size) { cv.width = size; cv.height = size; }
    var ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    try {
      root.BallFaces.draw(ctx, ballId, state, frame, cv.width / 2, cv.height / 2, cv.width * 0.98, { pixelScale: 1 });
    } catch (e) { }
    cv.setAttribute('data-face-frame', String(frame));
  }

  function paintFaceScope(scope) {
    var now = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
    var rootEl = scope || document;
    $all('canvas[data-face-ball]', rootEl).forEach(function (cv) {
      if (cv.offsetParent !== null) paintFaceCanvas(cv, now);
    });
  }

  function requestFacePaint() {
    if (U.resizeRaf) return;
    U.resizeRaf = root.requestAnimationFrame(function () {
      U.resizeRaf = 0;
      paintFaceScope(document);
    });
  }

  function startFaceLoop() {
    if (U.faceRaf) return;
    var loop = function () {
      U.faceRaf = root.requestAnimationFrame(loop);
      var now = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
      if (U.reduced) return;
      if (now - U.faceLastPaint < 90) return;
      U.faceLastPaint = now;
      paintFaceScope(document);
    };
    U.faceRaf = root.requestAnimationFrame(loop);
  }

  /* ---------- v0.3：通用效果词高亮 + 说明浮层 ---------- */
  var FX_INDEX = null;
  function fxIndex() {
    if (FX_INDEX) return FX_INDEX;
    var map = {}, list = [];
    effectsList().forEach(function (e) {
      if (!e || !e.name) return;
      map[e.name] = e;
      list.push(e.name);
    });
    list.sort(function (a, b) { return b.length - a.length; });
    FX_INDEX = { byName: map, names: list, re: list.length ? new RegExp('(' + list.map(function (n) {
      return n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('|') + ')', 'g') : null };
    return FX_INDEX;
  }

  function fxHTML(text) {
    var s = esc(redactIds(text));
    var idx = fxIndex();
    if (!idx.re) return s;
    return s.replace(idx.re, function (name) {
      var ef = idx.byName[name];
      if (!ef) return name;
      return '<button type="button" class="fx-word" data-fx="' + esc(ef.id) + '" aria-label="' +
        esc(name + '：' + (ef.desc || '')) + '">' + esc(name) + '</button>';
    });
  }

  function effectTipHTML(fxId) {
    var e = effectById(fxId);
    if (!e) return '';
    return '<span class="fx-tip__head"><b>' + esc(e.name) + '</b><em>' + esc(e.en || '') + '</em></span>' +
      (e.desc ? '<span class="fx-tip__desc">' + esc(e.desc) + '</span>' : '') +
      (e.stackRule || e.note ? '<span class="fx-tip__rule">' + esc(e.stackRule || e.note) + '</span>' : '');
  }

  function showFxTip(el) {
    var tip = $('#fx-tip');
    if (!tip || !el) return;
    var fxId = el.getAttribute('data-fx');
    var html = effectTipHTML(fxId);
    if (!html) return;
    tip.innerHTML = html;
    tip.hidden = false;
    tip.classList.add('is-on');
    var r = el.getBoundingClientRect();
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var vw = root.innerWidth || 390;
    var left = clamp(r.left + r.width / 2 - tw / 2, 8, Math.max(8, vw - tw - 8));
    var top = r.top - th - 8;
    if (top < 8) top = r.bottom + 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.setAttribute('data-for', fxId);
  }

  function hideFxTip() {
    var tip = $('#fx-tip');
    if (!tip) return;
    tip.hidden = true;
    tip.classList.remove('is-on');
    tip.removeAttribute('data-for');
    root.clearTimeout(U.fxTimer);
    root.clearTimeout(U.fxPressTimer);
  }

  /* ---------- v0.3：斗士档案 / ID 隐藏 ---------- */
  function loreOf(ball) {
    if (!ball) return null;
    var L = root.BallLore;
    if (!L) return null;
    try {
      if (typeof L.get === 'function') return L.get(ball.id) || null;
      if (L.byId) return L.byId[ball.id] || null;
      return L[ball.id] || null;
    } catch (e) { return null; }
  }

  function hasIdToken(text) {
    return /\bB\d{4}\b/i.test(String(text == null ? '' : text));
  }

  function redactIds(text) {
    return String(text == null ? '' : text)
      .replace(/\bB\d{4}\b/gi, '内部编号')
      .replace(/\bmeteor\s*[–\-—]\s*swarm\b/gi, '旧版编号');
  }

  function orbHTML(ball, mod, extra) {
    extra = extra || {};
    var state = extra.state === null ? null : (extra.state || 'idle');
    var face = state ? faceCanvasHTML(ball, state) : '';
    return '<span class="orb ' + (mod || '') + '" style="' + orbStyle(ball) + '" aria-hidden="true">' + face + '</span>';
  }

  function statMax() {
    var max = { hp: 1, def: 1, atk: 1, spd: 1, size: 1 };
    if (!G) return max;
    G.BALLS.forEach(function (b) {
      STAT_DEFS.forEach(function (d) {
        if (b.stats[d.key] > max[d.key]) max[d.key] = b.stats[d.key];
      });
    });
    return max;
  }

  function pct(value, max) {
    return clamp(Math.round((value / (max || 1)) * 100), 4, 100);
  }

  /* ---------- v0.4：能量 / 召唤物 ---------- */
  function skillEnergyCost(skill) {
    var p = (skill && skill.params) || {};
    var n = Number(p.energyCost);
    return isFinite(n) && n > 0 ? n : 0;
  }
  function energyLineHTML(skill) {
    var cost = skillEnergyCost(skill);
    if (!cost) return '';
    var note = skill && skill.id === 'cage' ? ' · 场上没有地雷时保留能量' : '';
    return '<span class="skill-block__energy">能量需求 ' + esc(cost) + ' · 满能量自动施放' + note + '</span>';
  }

  function summonDefs() { return (G && G.SUMMONS) || {}; }
  function summonById(id) { return summonDefs()[id] || null; }
  function summonTagDef(id) {
    var list = (G && G.SUMMON_TAGS) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return { id: id, name: id || '', color: '#8C7FA5' };
  }
  function summonsForBall(ball) {
    if (!ball || !Array.isArray(ball.summons)) return [];
    var out = [];
    ball.summons.forEach(function (id) {
      var s = summonById(id);
      if (s) out.push(s);
    });
    return out;
  }
  function damageTypeName(id) {
    var list = (G && G.DAMAGE_TYPES) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].name;
    return id || '';
  }
  function summonTagChipHTML(summon) {
    var tag = summonTagDef(summon.summonTag);
    return '<span class="summon-tag" style="--st:' + esc(tag.color || '#8C7FA5') + '">' + esc(tag.name) + '</span>';
  }

  var SUMMON_FIELD_DEFS = [
    { key: 'damageType', label: '伤害类型', kind: 'damageType' },
    { key: 'dmg', label: '伤害', unit: '点' },
    { key: 'frenzyDmg', label: '狂暴伤害', unit: '点' },
    { key: 'untrackedLife', label: '未追踪', kind: 'life' },
    { key: 'life', label: '追踪后', unit: '秒' },
    { key: 'frenzyLife', label: '狂暴追踪', unit: '秒' },
    { key: 'triggerRadius', label: '触发半径' },
    { key: 'explosionRadius', label: '普通爆炸溅射范围' },
    { key: 'activeExplosionRadius', label: '主动引爆溅射范围' },
    { key: 'root', label: '定身', unit: '秒' },
    { key: 'arm', label: '待发', unit: '秒' },
    { key: 'max', label: '上限' },
    { key: 'spawnInterval', label: '生成间隔', unit: '秒' },
    { key: 'trackRadius', label: '追踪半径' },
    { key: 'speed', label: '速度', kind: 'speed' },
    { key: 'movable', label: '可移动', kind: 'bool' },
    { key: 'hp', label: '生命值' },
    { key: 'atk', label: '攻击力' },
    { key: 'def', label: '防御力' },
    { key: 'spd', label: '移速' },
    { key: 'size', label: '体型' }
  ];
  var SUMMON_META_KEYS = { id: 1, name: 1, en: 1, desc: 1, summonTag: 1 };

  function summonFieldText(def, value) {
    if (def.kind === 'damageType') return damageTypeName(value);
    if (def.kind === 'bool') return value ? '是' : '否';
    if (def.kind === 'life') return value === '∞' ? '∞' : (isFinite(Number(value)) ? fmtNum(value) + (def.unit ? ' ' + def.unit : '') : String(value));
    if (def.kind === 'speed') return value === 'owner' ? '随召唤者' : (isFinite(Number(value)) ? fmtNum(value) : String(value));
    if (def.kind === 'scope') return value === 'all' ? '全场' : String(value);
    if (typeof value === 'number') return fmtNum(value) + (def.unit ? ' ' + def.unit : '');
    return String(value == null ? '—' : value) + (def.unit && isFinite(Number(value)) ? ' ' + def.unit : '');
  }

  function summonFieldsHTML(summon) {
    var rows = [];
    SUMMON_FIELD_DEFS.forEach(function (def) {
      if (summon[def.key] === undefined || summon[def.key] === null || summon[def.key] === '') return;
      var label = def.label;
      if (summon.id === 'mine' && def.key === 'life') label = '存在';
      rows.push('<div class="summon-row"><span>' + esc(label) + '</span><b>' + esc(summonFieldText(def, summon[def.key])) + '</b></div>');
    });
    Object.keys(summon).forEach(function (key) {
      if (SUMMON_META_KEYS[key]) return;
      var known = SUMMON_FIELD_DEFS.some(function (def) { return def.key === key; });
      if (known) return;
      var val = summon[key];
      if (typeof val === 'object') return;
      rows.push('<div class="summon-row"><span>' + esc(key) + '</span><b>' + esc(val) + '</b></div>');
    });
    return rows.join('');
  }

  var summonIconScheduled = false;
  function paintSummonIcon(cv) {
    if (!cv || !cv.getContext) return;
    var id = cv.getAttribute('data-summon-icon');
    var ctx = cv.getContext('2d');
    var w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    if (id === 'bee' && root.BallFaces && BallFaces.drawBee) {
      BallFaces.drawBee(ctx, w / 2, h / 2, Math.min(w, h) * 0.86, false, 0, { pixelScale: 1 });
      return;
    }
    // 机关地雷：像素盘 + 锯齿 + 红色引信
    var cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.30;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = '#FFC24B';
    ctx.fillStyle = '#24202E';
    ctx.lineWidth = 2;
    for (var i = 0; i < 8; i++) {
      var a = i * Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 1.25, Math.sin(a) * r * 1.25);
      ctx.lineTo(Math.cos(a) * r * 1.62, Math.sin(a) * r * 1.62);
      ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#6B5A86'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#FF4F6D';
    ctx.fillRect(-2, -r - 5, 4, 5);
    ctx.fillStyle = '#FFD642';
    ctx.fillRect(-r + 4, -3, 2, 6);
    ctx.fillRect(r - 6, -3, 2, 6);
    ctx.restore();
  }
  function scheduleSummonIcons() {
    if (summonIconScheduled) return;
    summonIconScheduled = true;
    root.requestAnimationFrame(function () {
      summonIconScheduled = false;
      var list = root.document ? root.document.querySelectorAll('[data-summon-icon]') : [];
      for (var i = 0; i < list.length; i++) paintSummonIcon(list[i]);
    });
  }

  function summonCardHTML(summon, opts) {
    opts = opts || {};
    if (!summon) return '';
    var tag = summonTagDef(summon.summonTag);
    var counts = opts.counts || null;
    scheduleSummonIcons();
    return '<article class="summon-card" style="--st:' + esc(tag.color || '#8C7FA5') + '">' +
        '<header class="summon-card__head">' +
          '<canvas class="summon-card__icon" data-summon-icon="' + esc(summon.id) + '" width="40" height="40" aria-hidden="true"></canvas>' +
          '<span class="summon-card__ident"><b>' + esc(summon.name || '') + '</b><em>' + esc(summon.en || '') + '</em></span>' +
          summonTagChipHTML(summon) +
        '</header>' +
        (summon.desc ? '<p class="summon-card__desc">' + esc(summon.desc) + '</p>' : '') +
        '<div class="summon-grid">' + summonFieldsHTML(summon) + '</div>' +
        (counts ? '<div class="summon-live">' + counts + '</div>' : '') +
      '</article>';
  }

  function summonsPanelHTML(ball, opts) {
    var list = summonsForBall(ball);
    if (!list.length) return '';
    return '<section class="summons-panel">' +
        '<header class="summons-panel__head"><b>召唤物</b><em>SUMMONS</em></header>' +
        '<div class="summons-list">' + list.map(function (s) {
          return summonCardHTML(s, opts && opts.counts ? { counts: opts.counts[s.id] || '' } : {});
        }).join('') + '</div>' +
      '</section>';
  }

  function energyText(entity) {
    if (!entity) return '—';
    var cur = Math.max(0, Math.floor(Number(entity.energy) || 0));
    var max = Math.max(0, Math.round(Number(entity.energyCost != null ? entity.energyCost : entity.energyMax) || 0));
    return cur + ' / ' + max;
  }
  function energyPctOf(entity) {
    if (!entity) return 0;
    var max = Number(entity.energyCost != null ? entity.energyCost : entity.energyMax) || 0;
    if (entity.energyPct != null && isFinite(Number(entity.energyPct))) return clamp(Number(entity.energyPct), 0, 1);
    if (max <= 0) return 0;
    return clamp((Number(entity.energy) || 0) / max, 0, 1);
  }

  function skillCostTagHTML(skill, compact) {
    if (!skill || skill.kind !== 'active') return '';
    var cost = skillEnergyCost(skill);
    if (!cost) return '';
    if (compact) {
      return '<span class="skill-cost skill-cost--mini" aria-label="能量需求 ' + esc(cost) + '，自动释放" title="能量需求 ' + esc(cost) + ' · 自动释放">' +
        '能量需求 ' + esc(cost) + '<em>自动释放</em></span>';
    }
    return '<span class="skill-cost">能量需求 ' + esc(cost) + '<em>自动释放</em></span>';
  }

  function skillLineHTML(skill, compact) {
    if (!skill) return '';
    var active = skill.kind === 'active';
    var cost = active ? skillCostTagHTML(skill, true) : '';
    return '' +
      '<span class="skillline ' + (active ? 'skillline--active' : '') + '">' +
        '<span class="sigil ' + (active ? 'sigil--active' : 'sigil--passive') + '" aria-hidden="true">' + esc(skill.sigil) + '</span>' +
        '<span class="skillline__body">' +
          '<span class="skillline__head">' +
            '<span class="skill-kind skill-kind--mini">' +
              '<span class="skillline__kind">' + (active ? '主动' : '被动') + '</span>' +
              cost +
            '</span>' +
            '<span class="skillline__name">' + esc(skill.name) + '</span>' +
          '</span>' +
          (compact ? '' : '<span class="skillline__desc">' + fxHTML(skill.desc) + '</span>') +
        '</span>' +
      '</span>';
  }

  function skillBlockHTML(skill) {
    if (!skill) return '';
    var active = skill.kind === 'active';
    var hint = active && skill.id === 'cage' ? '<span class="skill-block__hint">场上没有地雷时保留能量</span>' : '';
    var cost = active ? skillCostTagHTML(skill, false) : '';
    return '' +
      '<div class="skill-block ' + (active ? 'skill-block--active' : '') + '">' +
        '<span class="sigil sigil--lg ' + (active ? 'sigil--active' : 'sigil--passive') + '" aria-hidden="true">' + esc(skill.sigil) + '</span>' +
        '<div>' +
          '<div class="skill-block__head">' +
            '<span class="skill-kind">' +
              '<span class="skill-block__kind">' + (active ? '主动技能' : '被动技能') + '</span>' +
              cost +
            '</span>' +
            '<span class="skill-block__name">' + esc(skill.name) + '</span>' +
          '</div>' +
          hint +
          '<p class="skill-block__desc">' + fxHTML(skill.desc) + '</p>' +
        '</div>' +
      '</div>';
  }

  /* ================= 柜头 / 底部 Tab（v1.2：只留品牌与上下文，不再挤满按钮） ================= */
  function buildChrome() {
    var marquee = $('#marquee');
    if (!marquee) return;
    marquee.innerHTML = '' +
      '<div class="marquee__brand">' +
        '<span class="brand-en">BALL <em>PIT</em></span>' +
        '<span class="brand-han">斗球场</span>' +
      '</div>' +
      '<div class="marquee__center" id="marquee-center"></div>' +
      '<div class="marquee__right">' +
        '<button type="button" class="marquee-btn marquee-btn--back" data-act="back-home" id="marquee-back" hidden>' +
          '<span aria-hidden="true">←</span><span class="marquee-btn__txt">返回</span>' +
        '</button>' +
        '<span class="marquee__ver" id="marquee-ver">' + esc('v' + ((G && G.VERSION) || '0.4.4')) + '</span>' +
      '</div>';
    U.refs.marquee = marquee;
    U.refs.marqueeCenter = $('#marquee-center');
    U.refs.backBtn = $('#marquee-back');
    U.refs.ver = $('#marquee-ver');
  }

  var TAB_ITEMS = [
    { id: 'home', label: '大厅', en: 'LOBBY', icon: 'home' },
    { id: 'codex', label: '斗士', en: 'FIGHTERS', icon: 'codex' },
    { id: 'guide', label: '玩法', en: 'GUIDE', icon: 'guide' },
    { id: 'settings', label: '设置', en: 'SETUP', icon: 'setup' }
  ];
  var PAGE_SCREENS = { prep: '战场准备', codex: '斗士', maps: '地图', guide: '玩法', patches: '更新', settings: '设置' };
  var MAIN_SCREENS = { roster: '选球', tournament: '排位赛程', battle: '战斗', result: '结算' };
  var FLOW_SCREENS = { prep: 1, roster: 1, tournament: 1, battle: 1, result: 1 };

  function buildTabbar() {
    var bar = $('#tabbar');
    if (!bar) return;
    bar.innerHTML = TAB_ITEMS.map(function (it) {
      return '<button type="button" class="tabbar__item" data-act="nav" data-screen="' + it.id + '" ' +
        'aria-label="' + esc(it.label) + '">' +
        '<span class="tabbar__icon tabbar__icon--' + it.icon + '" aria-hidden="true"></span>' +
        '<span class="tabbar__label">' + esc(it.label) + '</span>' +
        '<span class="tabbar__en" aria-hidden="true">' + esc(it.en) + '</span>' +
      '</button>';
    }).join('');
    U.refs.tabbar = bar;
    bar.hidden = true;
  }

  function tabbarVisibleFor(name) {
    if (!isNarrow()) return false;
    if (TAB_ITEMS.filter(function (it) { return it.id === name; }).length) return true;
    return name === 'maps' || name === 'patches';
  }

  function updateTabbar(name) {
    var bar = U.refs.tabbar;
    if (!bar) return;
    var show = tabbarVisibleFor(name);
    bar.hidden = !show;
    if (!show) return;
    var active = name === 'maps' ? 'codex' : name;
    $all('.tabbar__item', bar).forEach(function (btn) {
      var on = btn.dataset.screen === active;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-current', on ? 'page' : 'false');
    });
  }

  function updateChromeForScreen(name) {
    var page = PAGE_SCREENS[name];
    if (U.refs.backBtn) U.refs.backBtn.hidden = !page;
    updateTabbar(name);
    if (document.body) document.body.dataset.screen = name;
    if (document.body) document.body.dataset.route = name;
    if (name === 'battle') document.body.dataset.battle = '1';
    else document.body.dataset.battle = '';
  }

  function setMarquee(mode, centerHTML) {
    var marquee = U.refs.marquee;
    if (!marquee) return;
    marquee.className = 'marquee marquee--' + mode;
    if (U.refs.marqueeCenter) U.refs.marqueeCenter.innerHTML = centerHTML || '';
  }

  function setConsoleHint() { /* v1.2：取消底部控制台，提示文案写进各页面内 */ }

  var HINTS = {
    home: '选一张模式卡进入选球页',
    roster: '点击卡牌加入阵容并固定档案 · <kbd>Tab</kbd> 切换 · <kbd>Enter</kbd> 确认 · 至少 <em>2</em> 颗才能开战',
    rosterRanked: '点击卡牌加入阵容并固定档案 · 排位赛必须正好 <em>8</em> 颗 · 输一场就定名次',
    battle: '<kbd>Space</kbd> 暂停 · 倍速 0.5× / 1× / 2× · <kbd>Esc</kbd> 关闭面板或退场',
    battleRanked: '<kbd>Space</kbd> 暂停 · 倍速 0.5× / 1× / 2× · <kbd>Esc</kbd> 退出本场',
    tournament: '点击 ready 场次进入赛事 · <kbd>Esc</kbd> 返回大厅',
    result: '<kbd>Esc</kbd> 返回选球 · 再来一局沿用同阵容，种子重掷',
    resultRanked: '本场结果已写入赛程 · 点「返回赛程」继续 · <kbd>Esc</kbd> 同样返回赛程'
  };

  function suddenStartForBattle() {
    var ranked = (U.battleMeta && U.battleMeta.mode === 'ranked') || U.mode === 'ranked';
    var rule = ranked
      ? (G && G.RULES && G.RULES.duel && G.RULES.duel.suddenDeath)
      : (G && G.RULES && G.RULES.suddenDeath);
    return (rule && rule.start) || 60;
  }


  /* ================= 屏幕切换 ================= */
  var SCREEN_ORDER = ['home', 'prep', 'codex', 'maps', 'guide', 'patches', 'settings', 'roster', 'tournament', 'battle', 'result'];

  function screenEls() {
    return {
      home: $('#screen-home'),
      prep: $('#screen-prep'),
      codex: $('#screen-codex'),
      maps: $('#screen-maps'),
      guide: $('#screen-guide'),
      patches: $('#screen-patches'),
      settings: $('#screen-settings'),
      roster: $('#screen-roster'),
      battle: $('#screen-battle'),
      result: $('#screen-result'),
      tournament: $('#screen-tournament')
    };
  }

  function setScreen(name, opts) {
    opts = opts || {};
    var els = screenEls();
    SCREEN_ORDER.forEach(function (k) {
      var el = els[k];
      if (!el) return;
      var show = k === name || (name === 'result' && k === 'battle');
      if (show) {
        if (el.hidden) {
          el.hidden = false;
          if (k === name && !opts.silent) {
            el.classList.remove('is-enter');
            void el.offsetWidth;
            el.classList.add('is-enter');
          }
        }
      } else {
        el.hidden = true;
        el.classList.remove('is-enter');
      }
    });
    var battle = els.battle;
    if (battle) {
      if (name === 'result') {
        battle.classList.add('is-backdrop');
        if ('inert' in battle) battle.inert = true;
      } else {
        battle.classList.remove('is-backdrop');
        if ('inert' in battle) battle.inert = false;
      }
    }
    if (document.body) document.body.dataset.screen = name;
    U.screen = name;
    U.route = name;
    stopLobbyRotation();
    hideFxTip();
    updateChromeForScreen(name);
    hideToast();
    requestFacePaint();
  }


  /* ================= 选球页 ================= */
  function buildRoster() {
    var host = $('#screen-roster');
    host.innerHTML = '' +
      '<div class="roster">' +
        '<div class="roster__head">' +
          '<div class="roster__title">' +
            '<span class="roster__kicker" id="roster-kicker">ROSTER · 征召<span class="k-en">SELECT YOUR FIGHTERS</span></span>' +
            '<h1 id="roster-title" tabindex="-1">选择斗士<span class="title-mark">.</span></h1>' +
            '<p class="roster__sub" id="roster-sub">选择参战的斗士。</p>' +
          '</div>' +
          '<div class="roster__counter" aria-live="polite">' +
            '<span class="counter__label">已选</span>' +
            '<span class="counter__num" id="sel-count">00</span>' +
            '<span class="counter__max">/ <span id="sel-max">08</span></span>' +
            '<span class="pips" id="sel-pips" aria-hidden="true"></span>' +
          '</div>' +
        '</div>' +
        '<div class="roster__context">' +
          '<div class="roster__summary" id="roster-summary"></div>' +
          '<div class="roster__context-actions">' +
            '<button type="button" class="btn btn--ghost btn--sm" data-act="change-battlefield">更换战场</button>' +
          '</div>' +
        '</div>' +
        '<div class="roster__body">' +
          '<div class="roster__gridcol">' +
            '<div class="roster__grid" id="ball-grid" role="group" aria-label="可选斗士"></div>' +
          '</div>' +
          '<aside class="dossier" id="dossier" aria-label="斗士档案" aria-live="polite"></aside>' +
        '</div>' +
        '<div class="lineup-strip" id="lineup-strip">' +
          '<span class="lineup-strip__label">阵容</span>' +
          '<div class="lineup-strip__slots" id="lineup-slots"></div>' +
        '</div>' +
        '<div class="roster__bar">' +
          '<p class="roster__hint" id="roster-hint">选择参战斗士。</p>' +
          '<div class="roster__actions">' +
            '<button type="button" class="btn btn--ghost" data-act="random">随机阵容</button>' +
            '<button type="button" class="btn btn--ghost" data-act="clear">清空</button>' +
            '<button type="button" class="btn btn--primary" data-act="start" id="btn-start" disabled>开战 <span aria-hidden="true">▶</span></button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var grid = $('#ball-grid');
    var maxStats = statMax();
    grid.innerHTML = G.BALLS.map(function (b) {
      var skills = (b.skills || []).map(skillById).filter(Boolean);
      var statsHTML = STAT_DEFS.map(function (d) {
        var val = b.stats[d.key];
        return '<span class="stat">' +
            '<span class="stat__k">' + d.label + '</span>' +
            '<span class="stat__v">' + esc(val) + '</span>' +
            '<span class="stat__bar" aria-hidden="true"><i style="--fill:' + pct(val, maxStats[d.key]) + '%;--stat-color:' + d.color + '"></i></span>' +
          '</span>';
      }).join('');
      return '' +
        '<div class="card-shell" data-ball="' + esc(b.id) + '">' +
          '<button type="button" class="ball-card" data-act="roster-card" data-ball="' + esc(b.id) + '" aria-pressed="false" ' +
            'style="--ball-color:' + esc(b.color) + '" ' +
            'aria-label="' + esc(b.name + '，' + tagsOf(b).join('、') + '，点击加入或移出阵容') + '">' +
            '<span class="ball-card__top">' +
              orbHTML(b, 'orb--card', { state: 'idle' }) +
              '<span class="ball-card__ident">' +
                '<span class="ball-card__name">' + esc(b.name) + '</span>' +
                '<span class="ball-card__en">' + esc(b.en) + '</span>' +
                '<span class="ball-card__tags">' + tagsHTML(b) + '</span>' +
              '</span>' +
              '<span class="ball-card__order" aria-hidden="true"><b class="order__n"></b><span class="order__t">上场</span></span>' +
            '</span>' +
            '<span class="ball-card__stats">' + statsHTML + '</span>' +
            '<span class="ball-card__skills">' + skills.map(function (s) { return skillLineHTML(s, true); }).join('') + '</span>' +
          '</button>' +
        '</div>';
    }).join('');

    var pips = $('#sel-pips');
    var max = U.max;
    var pipHTML = '';
    for (var i = 0; i < max; i++) pipHTML += '<span class="pip"></span>';
    pips.innerHTML = pipHTML;

    $('#sel-max').textContent = pad2(max);

    U.refs.rosterTitle = $('#roster-title');
    U.refs.rosterKicker = $('#roster-kicker');
    U.refs.rosterSub = $('#roster-sub');
    U.refs.rosterSummary = $('#roster-summary');
    U.refs.grid = grid;
    U.refs.dossier = $('#dossier');
    U.refs.slots = $('#lineup-slots');
    U.refs.count = $('#sel-count');
    U.refs.pips = pips;
    U.refs.hint = $('#roster-hint');
    U.refs.startBtn = $('#btn-start');
    U.refs.cards = $all('.ball-card', grid);

    // hover / 焦点只在没有固定详情时预览；点击/回车会固定详情（见 rosterPick）
    grid.addEventListener('focusin', function (e) {
      var card = e.target.closest && e.target.closest('.ball-card');
      if (card && !U.detailPinned) setActive(card.dataset.ball);
    });
    grid.addEventListener('mouseover', function (e) {
      if (!U.hoverFine) return;
      var card = e.target.closest && e.target.closest('.ball-card');
      if (card && !U.detailPinned) setActive(card.dataset.ball);
    });
  }

  function renderRosterSummary() {
    var host = $('#roster-summary');
    if (!host) return;
    var map = currentMap();
    var enabled = mechanismDefs().filter(function (m) {
      return m.type !== 'locked' && !m.locked && mechOn(m.id);
    });
    var mechChips = enabled.slice(0, 3).map(function (m) {
      return '<span class="rs-chip rs-chip--mech is-on">' + esc(m.name) + '</span>';
    }).join('');
    if (enabled.length > 3) {
      mechChips += '<span class="rs-chip rs-chip--mech is-on rs-chip--more" title="' +
        esc(enabled.map(function (m) { return m.name; }).join('、')) + '">+' + (enabled.length - 3) + ' 项机制</span>';
    }
    host.innerHTML = '' +
      '<span class="rs-chip rs-chip--map" style="--ba:' + esc(map.accent || '#54E6FF') + '">' +
        mapGlyphHTML(map, 'map-glyph--xs') + esc(map.name) + '<em>' + esc(map.feature || '') + '</em></span>' +
      mechChips;
  }

  function selectedIndex(id) {
    for (var i = 0; i < U.lineup.length; i++) if (U.lineup[i] === id) return i;
    return -1;
  }

  function toggleBall(id) {
    var ball = ballById(id);
    if (!ball) return false;
    var rules = rosterRules();
    var idx = selectedIndex(ball.id);
    if (idx >= 0) {
      U.lineup.splice(idx, 1);
      toast('已移出：' + ball.name);
    } else {
      if (U.lineup.length >= rules.max) {
        toast(rules.exact ? '排位赛必须正好 ' + rules.max + ' 位，先移出一位' : '最多 ' + rules.max + ' 位斗士，先移出一位');
        return false;
      }
      U.lineup.push(ball.id);
    }
    U.activeId = ball.id;
    renderDossier(ball.id);
    updateRosterState();
    return true;
  }

  /* 点击 / 回车固定详情（不再只靠 hover）；移动端同时打开 bottom sheet */
  function rosterPick(id) {
    var ball = ballById(id);
    if (!ball) return;
    toggleBall(ball.id);
    U.activeId = ball.id;
    U.detailPinned = true;
    renderDossier(ball.id);
    if (isNarrow()) openBallSheet(ball.id, { mode: 'recruit' });
  }

  function updateRosterState() {
    var rules = rosterRules();
    var n = U.lineup.length;
    U.refs.count.textContent = pad2(n);
    U.refs.count.style.color = n === 0 ? '' : (n < rules.min ? 'var(--danger)' : 'var(--orange-2)');
    var maxEl = $('#sel-max');
    if (maxEl) {
      maxEl.textContent = pad2(rules.max);
      maxEl.parentNode.style.display = rules.exact ? 'none' : '';
    } else if (U.refs.count && U.refs.count.parentNode) {
      var maxWrap = $('.counter__max', U.refs.count.parentNode);
      if (maxWrap) maxWrap.style.display = rules.exact ? 'none' : '';
    }

    $all('.pip', U.refs.pips).forEach(function (pip, i) {
      var id = U.lineup[i];
      var ball = id && ballById(id);
      pip.classList.toggle('is-on', !!ball);
      pip.style.setProperty('--pip-color', ball ? ball.color : '');
    });

    var full = n >= rules.max;
    U.refs.cards.forEach(function (card) {
      var id = card.dataset.ball;
      var idx = selectedIndex(id);
      card.classList.toggle('is-selected', idx >= 0);
      card.classList.toggle('is-locked', full && idx < 0);
      card.setAttribute('aria-pressed', idx >= 0 ? 'true' : 'false');
      var badge = card.querySelector('.ball-card__order .order__n');
      if (badge) badge.textContent = idx >= 0 ? pad2(idx + 1) : '';
    });

    var slots = '';
    for (var i = 0; i < rules.max; i++) {
      var id = U.lineup[i];
      var ball = id && ballById(id);
      if (ball) {
        slots += '<button type="button" class="slot" data-act="slot" data-ball="' + esc(ball.id) + '" ' +
          'aria-label="移出' + esc(ball.name) + '"><span class="slot__orb" style="' + orbStyle(ball) + '" aria-hidden="true"></span>' +
          '<span class="slot__name">' + esc(ball.name) + '</span><span class="slot__x" aria-hidden="true">×</span></button>';
      } else {
        slots += '<span class="slot is-empty" aria-hidden="true">+</span>';
      }
    }
    U.refs.slots.innerHTML = slots;

    var hint = U.refs.hint;
    hint.classList.remove('is-warn', 'is-ready');
    if (rules.exact) {
      if (n < rules.min) {
        hint.textContent = n === 0 ? '挑 8 颗斗士进入排位赛。' : '还差 ' + (rules.min - n) + ' 颗斗士。';
        hint.classList.add('is-warn');
      } else {
        hint.textContent = '八强就位，可以生成赛程。';
        hint.classList.add('is-ready');
      }
    } else if (n < rules.min) {
      hint.textContent = n === 0 ? '至少选择 ' + rules.min + ' 颗斗士。' : '还差 ' + (rules.min - n) + ' 颗斗士。';
      hint.classList.add('is-warn');
    } else if (n >= rules.max) {
      hint.textContent = '阵容已满（' + rules.max + ' 颗）。';
    } else {
      hint.textContent = '阵容就绪：' + n + ' 颗。';
      hint.classList.add('is-ready');
    }

    var enabled = rules.exact ? n === rules.max : n >= rules.min;
    U.refs.startBtn.disabled = !enabled;
    U.refs.startBtn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    U.refs.startBtn.innerHTML = rules.exact
      ? '生成赛程 <span aria-hidden="true">▶</span>'
      : '开战 <span aria-hidden="true">▶</span>';

    // 更新档案里的加入/移出按钮状态
    updateDossierToggle();
  }

  function renderDossier(id, targetEl) {
    var ball = ballById(id);
    var host = targetEl || U.refs.dossier;
    if (!host) return;
    if (!ball) {
      host.innerHTML = '' +
        '<div class="dossier__empty">' +
          '<span class="orb" aria-hidden="true"></span>' +
          '<p>斗士</p>' +
          '<small>选择一位斗士查看资料。</small>' +
        '</div>';
      host.classList.remove('is-pinned');
      return;
    }
    var pinned = !!U.detailPinned;
    host.classList.toggle('is-pinned', pinned);
    host.innerHTML = '' +
      (pinned ? '<div class="dossier__pinned">已固定</div>' : '') +
      recruitDetailHTML(ball);
    requestFacePaint();
  }

  function updateDossierToggle() {
    if (!U.refs.dossier) return;
    var btn = $('.detail-card__actions [data-act="toggle"]', U.refs.dossier);
    if (!btn) return;
    var id = btn.dataset.ball;
    var inLineup = selectedIndex(id) >= 0;
    btn.textContent = inLineup ? '移出阵容' : '加入阵容';
    btn.classList.toggle('btn--primary', !inLineup);
    btn.classList.toggle('btn--ghost', inLineup);
  }

  function setActive(id) {
    if (!id || id === U.activeId || U.detailPinned) return;
    U.activeId = id;
    renderDossier(id);
  }

  function randomLineup() {
    if (!G) return;
    var rules = rosterRules();
    var count;
    if (rules.exact) {
      count = rules.max;
    } else {
      count = clamp(U.lineup.length >= rules.min ? U.lineup.length : 6, rules.min, rules.max);
    }
    var pool = G.BALLS.map(function (b) { return b.id; });
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    U.lineup = pool.slice(0, count);
    U.activeId = U.lineup[0];
    renderDossier(U.activeId);
    updateRosterState();
    toast('随机阵容：' + count + ' 位斗士');
  }

  function clearLineup() {
    U.lineup = [];
    updateRosterState();
    toast('阵容已清空');
  }

  function startFromRoster() {
    var rules = rosterRules();
    var ok = rules.exact ? U.lineup.length === rules.max : U.lineup.length >= rules.min;
    if (!ok) {
      toast(rules.exact
        ? '排位赛必须正好 ' + rules.max + ' 位斗士（还差 ' + (rules.max - U.lineup.length) + ' 位）'
        : '至少选 ' + rules.min + ' 位斗士才能开战');
      if (U.refs.hint) U.refs.hint.classList.add('is-warn');
      return;
    }
    /* v1.2：把选球页选的地图 / 机制一并交给 main（第二参） */
    U.cb.onStart(U.lineup.slice(), {
      mode: U.mode,
      map: U.map,
      mechanisms: Object.assign({}, U.mechanisms || defaultMechanisms())
    });
  }

  function renderRosterMode() {
    var mode = currentMode();
    var map = currentMap();
    var rules = rosterRules();
    document.body.dataset.mode = U.mode;
    if (U.refs.rosterKicker) {
      U.refs.rosterKicker.innerHTML = (rules.exact ? 'RANKED · 排位赛' : 'ROSTER · 选球') +
        '<span class="k-en">' + (rules.exact ? 'SINGLE ELIMINATION' : 'SELECT YOUR FIGHTERS') + '</span>';
    }
    if (U.refs.rosterTitle) {
      U.refs.rosterTitle.innerHTML = (rules.exact ? '挑选八强' : '选择斗士') + '<span class="title-mark">.</span>';
    }
    if (U.refs.rosterSub) {
      U.refs.rosterSub.textContent = rules.exact
        ? '8 颗斗士，单败淘汰，全程同一张地图。'
        : '2–8 颗斗士，最后活着的那颗赢。';
    }
    var maxEl = $('#sel-max');
    if (maxEl) {
      maxEl.textContent = pad2(rules.max);
      if (maxEl.parentNode) maxEl.parentNode.style.display = rules.exact ? 'none' : '';
    }
    renderRosterSummary();
  }

  function showRoster(lineup, ctx) {
    ctx = ctx || {};
    if (ctx.mode) U.mode = ctx.mode === 'ranked' ? 'ranked' : 'basic';
    if (ctx.map) U.map = mapById(ctx.map).id;
    if (ctx.mechanisms) U.mechanisms = sanitizeMechanisms(ctx.mechanisms);
    else if (!U.mechanisms) U.mechanisms = defaultMechanisms();
    var rules = rosterRules();
    if (Array.isArray(lineup)) {
      var seen = {};
      var cleaned = [];
      lineup.forEach(function (raw) {
        var cid = canonicalId(raw);
        if (cid && !seen[cid]) { seen[cid] = 1; cleaned.push(cid); }
      });
      if (cleaned.length) U.lineup = cleaned.slice(0, rules.max);
    }
    closeModal();
    closeSheet();
    U.detailPinned = false;
    setScreen('roster');
    renderRosterMode();
    setMarquee('roster', rosterMarqueeHTML());
    updateRosterState();
    var first = (U.activeId && selectedIndex(U.activeId) >= 0) ? U.activeId : (U.lineup[0] || (G.BALLS[0] && G.BALLS[0].id));
    if (first) { U.activeId = first; renderDossier(first); }
    setPaused(false);
    setCountdown(null);
    if (U.refs.rosterTitle) {
      try { U.refs.rosterTitle.focus({ preventScroll: true }); } catch (e) { }
    }
  }

  /* ---------- v0.3 大厅 / 收藏 / 战场准备 ---------- */
  function mechName(id) {
    var m = (G && G.MECHANISM_BY_ID && G.MECHANISM_BY_ID[id]) || null;
    return m ? m.name : id;
  }

  function selectedBallIds() {
    return (G && G.BALLS) ? G.BALLS.map(function (b) { return b.id; }) : [];
  }

  function randomOtherBall(excludeId) {
    var ids = selectedBallIds().filter(function (id) { return id !== excludeId; });
    if (!ids.length) return null;
    return ids[Math.floor(Math.random() * ids.length)];
  }

  function currentLobbyBall() {
    var ball = ballById(U.lobbyViewId);
    if (!ball) {
      ball = ballById(U.favoriteId);
      if (!ball) {
        var pool = G && G.BALLS ? G.BALLS : [];
        ball = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
      }
      if (ball) U.lobbyViewId = ball.id;
    }
    return ball;
  }

  function stopLobbyRotation() {
    if (U.lobbyRotateTimer) { root.clearInterval(U.lobbyRotateTimer); U.lobbyRotateTimer = 0; }
  }

  function startLobbyRotation() {
    stopLobbyRotation();
    if (U.favoriteId) return;
    U.lobbyRotateTimer = root.setInterval(function () {
      if (U.screen !== 'home' || U.favoriteId) { stopLobbyRotation(); return; }
      var next = randomOtherBall(U.lobbyViewId);
      if (!next) return;
      U.lobbyViewId = next;
      renderFavorite(true);
    }, 5000);
  }

  /* 大厅「换一个」只切换展示，不改变收藏 */
  function cycleLobbyBall() {
    var next = randomOtherBall(U.lobbyViewId);
    if (!next) return;
    U.lobbyViewId = next;
    savePrefs();
    renderFavorite();
    if (!U.favoriteId) startLobbyRotation();
  }

  function setFavorite(id) {
    var ball = ballById(id);
    if (!ball) return;
    if (U.favoriteId === ball.id) {
      U.favoriteId = null;
      toast('已取消收藏');
    } else {
      U.favoriteId = ball.id;
      toast('已收藏：' + ball.name);
    }
    savePrefs();
    if (U.favoriteId) stopLobbyRotation(); else startLobbyRotation();
    if (U.screen === 'home') renderFavorite();
    if (U.screen === 'codex') renderCodex();
    if (U.sheet) refreshSheet();
  }

  function toggleFavorite(id) {
    setFavorite(id);
    if (U.screen === 'codex') renderCodex();
  }

  function rosterMarqueeHTML() {
    var mode = currentMode();
    return '<span class="mode-chip ' + (U.mode === 'ranked' ? 'mode-chip--violet' : 'mode-chip--hot') + '">' +
      esc(mode.name) + '<em class="chip-en">' + esc(mode.en || '') + '</em></span>' +
      '<span class="mode-chip">斗士 ' + pad2(U.lineup.length) + ' / ' + pad2(rosterRules().max) + '</span>';
  }

  function modeCardHTML(mode) {
    var ranked = mode.id === 'ranked';
    return '<button type="button" class="mode-card mode-card--lobby" data-act="lobby-mode" data-mode="' + esc(mode.id) + '" ' +
      'style="--ma:' + esc(mode.accent || '#FF6B1A') + ';--ma2:' + esc(mode.accent2 || '#FFC24B') + '">' +
      '<span class="mode-card__top">' + modeIconHTML(mode) +
        '<span class="mode-card__ident"><span class="mode-card__name">' + esc(mode.name) + '</span>' +
        '<span class="mode-card__en">' + esc(mode.en || '') + '</span></span>' +
        '<span class="mode-card__pick" aria-hidden="true">进入 <b>▶</b></span>' +
      '</span>' +
      '<span class="mode-card__tagline">' + esc(mode.tagline || '') + '</span>' +
      '<span class="mode-card__desc">' + esc(mode.desc || '') + '</span>' +
      '<span class="mode-card__ghost" aria-hidden="true">' + (ranked ? 'KO8' : 'FFA') + '</span>' +
    '</button>';
  }

  var LOBBY_NAV = [
    { screen: 'codex', name: '斗士', en: 'FIGHTERS', glyph: '斗', accent: '#FFB347', desc: '浏览全部斗士' },
    { screen: 'guide', name: '玩法', en: 'GUIDE', glyph: '玩', accent: '#B060FF', desc: '规则与效果说明' },
    { screen: 'patches', tab: 'data', name: '更新', en: 'PATCH NOTES', glyph: '更', accent: '#FFC24B', desc: '版本与数据变动' },
    { screen: 'settings', name: '设置', en: 'SETTINGS', glyph: '设', accent: '#7CFF9E', desc: '音量与动效' }
  ];

  function lobbyNavHTML() {
    return LOBBY_NAV.map(function (n) {
      return '<button type="button" class="nav-card" data-act="nav" data-screen="' + esc(n.screen) + '" ' +
        (n.tab ? 'data-tab="' + esc(n.tab) + '" ' : '') +
        'style="--na:' + esc(n.accent) + '">' +
        '<span class="nav-card__glyph" aria-hidden="true">' + esc(n.glyph) + '</span>' +
        '<span class="nav-card__body">' +
          '<span class="nav-card__head"><b class="nav-card__name">' + esc(n.name) + '</b></span>' +
          '<span class="nav-card__desc">' + esc(n.desc) + '</span>' +
        '</span>' +
      '</button>';
    }).join('');
  }

  function renderFavorite(animate) {
    var host = $('#lobby-fav');
    if (!host) return;
    var ball = currentLobbyBall();
    if (!ball) { host.innerHTML = ''; return; }
    var maxStats = statMax();
    var statsHTML = STAT_DEFS.map(function (d) {
      var val = ball.stats[d.key];
      return '<span class="fstat" title="' + esc(d.label) + '">' +
          '<span class="fstat__k">' + d.label + '</span>' +
          '<span class="fstat__v">' + esc(val) + '</span>' +
          '<span class="fstat__bar" aria-hidden="true"><i style="--fill:' + pct(val, maxStats[d.key]) + '%;--stat-color:' + d.color + '"></i></span>' +
        '</span>';
    }).join('');
    var favSkills = (ball.skills || []).map(skillById).filter(Boolean);
    var isFav = U.favoriteId === ball.id;
    host.innerHTML = '' +
      '<div class="fav-card' + (animate ? ' is-swap' : '') + '" style="' + orbStyle(ball) + '">' +
        '<header class="fav-card__head">' +
          '<span class="fav-card__kicker">' + (isFav ? 'MY FAVORITE' : 'BALL PIT') + '</span>' +
          (isFav ? '<span class="fav-card__state">已收藏</span>' : '<span class="fav-card__state fav-card__state--preview">预览</span>') +
        '</header>' +
        '<div class="fav-card__stage">' +
          '<span class="fav-card__ring" aria-hidden="true"></span>' +
          '<span class="fav-card__halo" aria-hidden="true"></span>' +
          orbHTML(ball, 'orb--hero', { state: 'idle' }) +
          '<div class="fav-card__ident">' +
            '<h1 class="fav-card__name" id="home-title" tabindex="-1">' + esc(ball.name) + '</h1>' +
            '<span class="fav-card__en">' + esc(ball.en) + '</span>' +
            '<span class="fav-card__tags">' + tagsHTML(ball) + '</span>' +
          '</div>' +
        '</div>' +
        '<p class="fav-card__bio">' + esc(ball.bio || '') + '</p>' +
        '<p class="fav-card__quote">“' + esc(ball.quote || '') + '”</p>' +
        '<div class="fav-card__skills">' + favSkills.map(function (s) {
          return '<span class="fav-skill"><i class="' + (s.kind === 'active' ? 'is-active' : '') + '" aria-hidden="true">' + esc(s.sigil) + '</i>' +
            '<span>' + (s.kind === 'active' ? '主动' : '被动') + ' · ' + esc(s.name) + '</span></span>';
        }).join('') + '</div>' +
        '<div class="fav-card__stats" aria-label="基础属性">' + statsHTML + '</div>' +
        '<span class="fav-card__ghost" aria-hidden="true">' + esc(ball.en || '') + '</span>' +
        '<div class="fav-card__actions">' +
          '<button type="button" class="btn btn--ghost" data-act="fav-shuffle">换一个 <span aria-hidden="true">↻</span></button>' +
          '<button type="button" class="btn btn--ghost" data-act="fav-open" data-ball="' + esc(ball.id) + '">查看斗士</button>' +
        '</div>' +
      '</div>';
    requestFacePaint();
  }

  function renderLobby() {
    var modes = (G.MODES && G.MODES.length) ? G.MODES : [modeById('basic'), modeById('ranked')];
    var host = $('#lobby-modes');
    if (host) host.innerHTML = modes.map(modeCardHTML).join('');
    U.refs.modeCards = host ? $all('.mode-card', host) : [];
    renderFavorite();
  }

  function buildLobby() {
    var host = $('#screen-home');
    if (!host) return;
    host.innerHTML = '' +
      '<div class="lobby">' +
        '<div class="lobby__grid">' +
          '<section class="lobby__fav" id="lobby-fav" aria-label="斗士展示"></section>' +
          '<section class="lobby__modes" aria-labelledby="lobby-mode-title">' +
            '<header class="section-head">' +
              '<h2 class="section-head__title" id="lobby-mode-title">选择模式</h2>' +
              '<span class="section-head__en">MODE</span>' +
            '</header>' +
            '<div class="mode-cards mode-cards--lobby" id="lobby-modes"></div>' +
          '</section>' +
        '</div>' +
        '<nav class="lobby__nav" aria-label="更多内容">' +
          '<header class="section-head section-head--nav">' +
            '<h2 class="section-head__title">更多内容</h2>' +
            '<span class="section-head__en">MORE</span>' +
          '</header>' +
          '<div class="nav-cards">' + lobbyNavHTML() + '</div>' +
        '</nav>' +
      '</div>';
    U.refs.lobby = $('.lobby', host);
    U.refs.lobbyFav = $('#lobby-fav');
    renderLobby();
  }

  function showHome(ctx) {
    ctx = ctx || {};
    if (ctx.mode === 'basic' || ctx.mode === 'ranked') U.home.mode = ctx.mode;
    if (ctx.map) U.home.map = mapById(ctx.map).id;
    if (ctx.mechanisms) U.home.mechanisms = sanitizeMechanisms(ctx.mechanisms);
    else if (!U.home.mechanisms) U.home.mechanisms = defaultMechanisms();
    U.mechanisms = Object.assign({}, U.home.mechanisms);
    U.mode = U.home.mode;
    U.map = U.home.map;
    U.lobbyViewId = U.favoriteId || null;
    closeModal();
    closeSheet();
    setScreen('home');
    setMarquee('home', '');
    renderLobby();
    startLobbyRotation();
    setPaused(false);
    setCountdown(null);
    var title = $('#home-title');
    if (title) { try { title.focus({ preventScroll: true }); } catch (e) { } }
    requestFacePaint();
  }

  /* ================= 战场准备 ================= */
  function openPrep(from) {
    U.prep.from = from === 'roster' ? 'roster' : 'home';
    U.prep.saved = {
      map: U.map,
      mechanisms: sanitizeMechanisms(U.mechanisms),
      mode: U.mode,
      homeMap: U.home.map,
      homeMechanisms: sanitizeMechanisms(U.home.mechanisms)
    };
    U.mode = U.home.mode;
    U.map = U.home.map;
    U.mechanisms = sanitizeMechanisms(U.home.mechanisms);
    renderPrep();
    closeSheet();
    setScreen('prep');
    setMarquee('prep', '<span class="mode-chip">' + esc(currentMode().name) + '</span>');
    focusPageTitle('prep-title');
    requestFacePaint();
  }

  function renderPrep() {
    var host = $('#screen-prep');
    if (!host) return;
    var maps = (G.MAPS && G.MAPS.length) ? G.MAPS : [];
    var mode = currentMode();
    var map = currentMap();
    var mech = (G.MECHANISMS || []).filter(function (m) { return m.type !== 'locked' && !m.locked; });
    if (!host.querySelector('.prep')) {
      host.innerHTML = '' +
        '<div class="page page--prep">' +
          pageHeadHTML({
            kicker: 'BATTLEFIELD',
            en: 'BATTLE PREP',
            id: 'prep-title',
            titleHTML: '战场准备<span class="title-mark">.</span>',
            subHTML: '选择地图与机制，然后挑选你的斗士。'
          }) +
          '<div class="prep">' +
            '<section class="prep__maps">' +
              '<header class="prep-block__head"><b>地图</b><em>MAP</em></header>' +
              '<div class="prep-maps" id="prep-maps" role="group" aria-label="选择地图"></div>' +
            '</section>' +
            '<aside class="prep__side">' +
              '<section class="prep__panel">' +
                '<header class="prep-block__head"><b>机制</b><em>MECHANICS</em></header>' +
                '<div class="prep-mechs" id="prep-mechs"></div>' +
              '</section>' +
              '<section class="prep__panel prep__summary" id="prep-summary"></section>' +
              '<button type="button" class="btn btn--primary prep__go" data-act="prep-confirm">选择斗士 <span aria-hidden="true">▶</span></button>' +
            '</aside>' +
          '</div>' +
        '</div>';
    }
    var mapHost = $('#prep-maps');
    if (mapHost) {
      mapHost.innerHTML = maps.map(function (m) {
        var on = U.map === m.id;
        return '<button type="button" class="prep-map' + (on ? ' is-on' : '') + '" data-act="prep-map" data-map="' + esc(m.id) + '" ' +
          'aria-pressed="' + (on ? 'true' : 'false') + '" style="--ma:' + esc(m.accent || '#FF6B1A') + ';--ma2:' + esc(m.accent2 || '#FFC24B') + '">' +
          mapPreviewHTML(m) +
          '<span class="prep-map__body">' +
            '<span class="prep-map__top"><b class="prep-map__name">' + esc(m.name) + '</b><em class="prep-map__en">' + esc(m.en || '') + '</em></span>' +
            '<span class="prep-map__tagline">' + esc(m.tagline || '') + '</span>' +
            '<span class="prep-map__desc">' + esc(m.desc || '') + '</span>' +
            '<span class="prep-map__feature"><i aria-hidden="true"></i>' + esc(m.feature || '') + '</span>' +
          '</span>' +
          '<span class="prep-map__pick" aria-hidden="true">' + (on ? '已选' : '选择') + '</span>' +
        '</button>';
      }).join('');
    }
    var mechHost = $('#prep-mechs');
    if (mechHost) {
      mechHost.innerHTML = mech.map(function (m) {
        var on = !!(U.mechanisms && U.mechanisms[m.id]);
        return '<button type="button" class="prep-mech' + (on ? ' is-on' : '') + '" data-act="prep-mech" data-mech="' + esc(m.id) + '" ' +
          'aria-pressed="' + (on ? 'true' : 'false') + '">' +
          '<span class="prep-mech__switch" aria-hidden="true"><i></i></span>' +
          '<span class="prep-mech__body"><b>' + esc(m.name) + '</b><em>' + esc(m.en || '') + '</em>' +
            '<span>' + esc(m.desc || '') + '</span></span>' +
        '</button>';
      }).join('');
    }
    var sum = $('#prep-summary');
    if (sum) {
      sum.innerHTML = '' +
        '<div class="prep-sum__row"><span>模式</span><b>' + esc(mode.name) + '</b></div>' +
        '<div class="prep-sum__row"><span>地图</span><b>' + esc(map.name) + '</b><em>' + esc(map.feature || '') + '</em></div>' +
        '<div class="prep-sum__row"><span>机制</span><b>' + mechSummaryText() + '</b></div>' +
        '<div class="prep-sum__row"><span>阵容</span><b>' + (rosterRules().exact ? '8 颗' : '2–8 颗') + '</b></div>';
    }
  }

  function prepPickMap(id) {
    var m = mapById(id);
    if (!m) return;
    U.map = m.id;
    renderPrep();
  }

  function prepToggleMech(id) {
    if (!U.mechanisms || U.mechanisms[id] === undefined) return;
    U.mechanisms[id] = !U.mechanisms[id];
    renderPrep();
  }

  function prepConfirm() {
    U.home.mode = U.mode;
    U.home.map = U.map;
    U.home.mechanisms = sanitizeMechanisms(U.mechanisms);
    if (typeof U.cb.onEnterArena === 'function') {
      U.cb.onEnterArena({
        mode: U.mode,
        map: U.map,
        mechanisms: Object.assign({}, U.mechanisms)
      });
    }
  }

  function prepCancel() {
    var s = U.prep.saved;
    if (s) {
      U.mode = s.mode;
      U.map = s.map;
      U.mechanisms = sanitizeMechanisms(s.mechanisms);
      U.home.map = s.homeMap;
      U.home.mechanisms = sanitizeMechanisms(s.homeMechanisms);
    }
    if (U.prep.from === 'roster' && typeof U.cb.onNewLineup === 'function') U.cb.onNewLineup();
    else if (typeof U.cb.onHome === 'function') U.cb.onHome();
    else showHome({ mode: U.home.mode, map: U.home.map, mechanisms: U.home.mechanisms });
  }

  /* ================= 子页面通用 ================= */
  function pageHeadHTML(opts) {
    return '<header class="page__head">' +
        '<div class="page__title-wrap">' +
          '<span class="page__kicker">' + esc(opts.kicker) + '<span class="k-en">' + esc(opts.en || '') + '</span></span>' +
          '<h1 class="page__title" id="' + esc(opts.id || 'page-title') + '" tabindex="-1">' + opts.titleHTML + '</h1>' +
          (opts.subHTML ? '<p class="page__sub">' + opts.subHTML + '</p>' : '') +
        '</div>' +
        (opts.actionsHTML ? '<div class="page__actions">' + opts.actionsHTML + '</div>' : '') +
      '</header>';
  }

  function focusPageTitle(id) {
    var el = document.getElementById(id || 'page-title');
    if (el) { try { el.focus({ preventScroll: true }); } catch (e) { } }
  }

  function openScreen(name) {
    name = String(name || '');
    if (name === 'home') { showHome({ mode: U.home.mode, map: U.home.map, mechanisms: U.home.mechanisms }); return; }
    if (name === 'prep') { openPrep('home'); return; }
    if (!PAGE_SCREENS[name]) return;
    closeModal();
    closeSheet();
    stopLobbyRotation();
    if (name === 'codex') renderCodex();
    else if (name === 'maps') renderMaps();
    else if (name === 'guide') renderGuide();
    else if (name === 'patches') renderPatches();
    else if (name === 'settings') renderSettings();
    setScreen(name);
    setMarquee(name, '<span class="mode-chip">' + esc(PAGE_SCREENS[name]) + '</span>');
    focusPageTitle();
    requestFacePaint();
  }

  /* ================= 斗士详情（斗士 / 选球 / 移动端 sheet 共用） ================= */
  function lineupToggleHTML(ball) {
    if (!ball) return '';
    var inLineup = selectedIndex(ball.id) >= 0;
    return '<button type="button" class="btn ' + (inLineup ? 'btn--ghost' : 'btn--primary') + '" data-act="toggle" data-ball="' +
      esc(ball.id) + '">' + (inLineup ? '移出阵容' : '加入阵容') + '</button>';
  }

  function fighterBattleHTML(ball, opts) {
    opts = opts || {};
    var maxStats = statMax();
    var statsHTML = STAT_DEFS.map(function (d) {
      var val = ball.stats[d.key];
      return '<div class="dstat">' +
          '<span class="dstat__k">' + d.label + '</span>' +
          '<span class="dstat__bar" aria-hidden="true"><i style="--fill:' + pct(val, maxStats[d.key]) + '%;--stat-color:' + d.color + '"></i></span>' +
          '<span class="dstat__v">' + esc(val) + '</span>' +
        '</div>';
    }).join('');
    var skills = (ball.skills || []).map(skillById).filter(Boolean);
    var summons = summonsPanelHTML(ball);
    return '' +
      '<p class="detail-card__bio">' + esc(ball.bio || '') + '</p>' +
      '<p class="detail-card__quote">“' + esc(ball.quote || '') + '”</p>' +
      '<div class="detail-card__stats" aria-label="基础属性">' + statsHTML + '</div>' +
      '<div class="combat-grid' + (summons ? '' : ' combat-grid--solo') + '">' +
        '<div class="combat-skills">' + skills.map(skillBlockHTML).join('') + '</div>' +
        (summons ? '<div class="combat-summons">' + summons + '</div>' : '') +
      '</div>' +
      (opts.actions ? '<div class="detail-card__actions">' + opts.actions + '</div>' : '');
  }

  function fighterProfileHTML(ball) {
    var lore = loreOf(ball);
    if (!lore) {
      return '<div class="lore-empty"><b>档案整理中</b><p>这位斗士的档案还没送到夜场。</p></div>';
    }
    var relations = (lore.relations || []).map(function (r) {
      return '<li><b>' + esc(r.name || '') + '</b><span>' + esc(r.text || '') + '</span></li>';
    }).join('');
    var trivia = (lore.trivia || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
    return '' +
      '<div class="fighter-profile">' +
        '<div class="fp-row"><span class="fp-label">出生日期</span><span class="fp-value">' + esc(lore.birth || '—') + '</span></div>' +
        (lore.profile ? '<div class="fp-block"><span class="fp-label">简介</span><p class="fp-text">' + esc(lore.profile) + '</p></div>' : '') +
        (lore.story ? '<div class="fp-block"><span class="fp-label">小故事</span><p class="fp-text fp-story">' + esc(lore.story) + '</p></div>' : '') +
        (relations ? '<div class="fp-block"><span class="fp-label">关系</span><ul class="fp-relations">' + relations + '</ul></div>' : '') +
        (trivia ? '<div class="fp-block"><span class="fp-label">轶闻</span><ul class="fp-trivia">' + trivia + '</ul></div>' : '') +
        (lore.motto ? '<blockquote class="fp-motto">“' + esc(lore.motto) + '”</blockquote>' : '') +
      '</div>';
  }

  function fighterTabsHTML(tab) {
    tab = tab || 'battle';
    return '<div class="fighter-tabs" role="tablist" aria-label="斗士详情">' +
      '<button type="button" class="ftab' + (tab === 'battle' ? ' is-on' : '') + '" data-act="fighter-tab" data-tab="battle" role="tab" aria-selected="' + (tab === 'battle' ? 'true' : 'false') + '">战斗<em>BATTLE</em></button>' +
      '<button type="button" class="ftab' + (tab === 'profile' ? ' is-on' : '') + '" data-act="fighter-tab" data-tab="profile" role="tab" aria-selected="' + (tab === 'profile' ? 'true' : 'false') + '">档案<em>PROFILE</em></button>' +
    '</div>';
  }

  function favoriteToggleHTML(ball) {
    var fav = U.favoriteId === ball.id;
    return '<button type="button" class="fav-toggle' + (fav ? ' is-on' : '') + '" data-act="favorite" data-ball="' + esc(ball.id) + '" ' +
      'aria-pressed="' + (fav ? 'true' : 'false') + '">' +
      '<span class="fav-toggle__star" aria-hidden="true">' + (fav ? '★' : '☆') + '</span>' +
      '<span>' + (fav ? '已是喜欢的小球' : '设为喜欢的小球') + '</span></button>';
  }

  function fighterDetailHTML(ball, opts) {
    opts = opts || {};
    if (!ball) {
      return '<div class="detail-empty"><span class="orb orb--detail"></span>' +
        '<p>选择一位斗士</p></div>';
    }
    var tab = opts.tab || U.codex.tab || 'battle';
    return '' +
      '<article class="detail-card fighter-detail" style="' + orbStyle(ball) + '">' +
        '<header class="detail-card__head">' +
          '<span class="detail-card__orb">' + orbHTML(ball, 'orb--detail', { state: 'idle' }) + '</span>' +
          '<div class="detail-card__ident">' +
            '<h2 class="detail-card__name">' + esc(ball.name) + '</h2>' +
            '<span class="detail-card__en">' + esc(ball.en) + '</span>' +
            '<span class="detail-card__tags">' + tagsHTML(ball) + '</span>' +
          '</div>' +
        '</header>' +
        favoriteToggleHTML(ball) +
        fighterTabsHTML(tab) +
        (tab === 'profile' ? fighterProfileHTML(ball) : fighterBattleHTML(ball, {})) +
      '</article>';
  }

  function recruitDetailHTML(ball) {
    if (!ball) return '<div class="detail-empty"><span class="orb orb--detail"></span><p>选择一位斗士</p></div>';
    return '<article class="detail-card recruit-detail" style="' + orbStyle(ball) + '">' +
        '<header class="detail-card__head">' +
          '<span class="detail-card__orb">' + orbHTML(ball, 'orb--detail', { state: 'idle' }) + '</span>' +
          '<div class="detail-card__ident">' +
            '<h2 class="detail-card__name">' + esc(ball.name) + '</h2>' +
            '<span class="detail-card__en">' + esc(ball.en) + '</span>' +
            '<span class="detail-card__tags">' + tagsHTML(ball) + '</span>' +
          '</div>' +
        '</header>' +
        fighterBattleHTML(ball, { actions: lineupToggleHTML(ball) }) +
      '</article>';
  }

  function openSheet(title, bodyHTML, opts) {
    closeSheet();
    var mount = $('#modal-root');
    if (!mount) return;
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'sheet';
    el.innerHTML = '' +
      '<div class="sheet__backdrop" data-act="sheet-close" aria-hidden="true"></div>' +
      '<div class="sheet__panel" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1">' +
        '<header class="sheet__head">' +
          '<div class="sheet__head-text">' +
            '<span class="sheet__kicker">' + esc(opts.kicker || '') + '</span>' +
            '<h2 class="sheet__title" id="sheet-title">' + esc(title || '') + '</h2>' +
          '</div>' +
          '<button type="button" class="sheet__close" data-act="sheet-close" aria-label="关闭">×</button>' +
        '</header>' +
        '<div class="sheet__body" id="sheet-body">' + bodyHTML + '</div>' +
      '</div>';
    mount.appendChild(el);
    el.render = opts.render || null;
    el.ballId = opts.ballId || null;
    U.sheet = el;
    U.lastFocus = document.activeElement;
    var cabinet = $('#cabinet');
    if (cabinet && 'inert' in cabinet) cabinet.inert = true;
    var panel = $('.sheet__panel', el);
    root.requestAnimationFrame(function () {
      try { panel.focus({ preventScroll: true }); } catch (e) { }
      paintFaceScope(el);
    });
  }

  function closeSheet() {
    if (!U.sheet) return;
    var el = U.sheet;
    U.sheet = null;
    if (el.parentNode) el.parentNode.removeChild(el);
    var cabinet = $('#cabinet');
    if (cabinet && 'inert' in cabinet) cabinet.inert = false;
    if (U.lastFocus && document.contains(U.lastFocus)) {
      try { U.lastFocus.focus({ preventScroll: true }); } catch (e) { }
    }
    U.lastFocus = null;
  }

  function refreshSheet() {
    if (!U.sheet || !U.sheet.render) return;
    var body = $('#sheet-body');
    if (body) body.innerHTML = U.sheet.render();
    var ball = ballById(U.sheet.ballId);
    if (ball) {
      var title = $('#sheet-title');
      if (title) title.textContent = ball.name;
    }
    paintFaceScope(U.sheet);
  }

  function openBallSheet(ballId, opts) {
    var ball = ballById(ballId);
    if (!ball) return;
    opts = opts || {};
    var mode = opts.mode === 'fighter' ? 'fighter' : 'recruit';
    var render = function () {
      var cur = ballById(ball.id) || ball;
      if (mode === 'fighter') return fighterDetailHTML(cur, { tab: U.codex.tab });
      return recruitDetailHTML(cur);
    };
    openSheet(ball.name, render(), {
      kicker: mode === 'fighter' ? '斗士详情' : '斗士档案',
      render: render,
      ballId: ball.id
    });
  }

  /* ================= 斗士 FIGHTERS ================= */
  function codexFilteredBalls() {
    var q = String(U.codex.q || '').trim().toLowerCase();
    var tag = U.codex.tag;
    return (G.BALLS || []).filter(function (b) {
      var tags = tagsOf(b);
      if (tag && tags.indexOf(tag) < 0) return false;
      if (!q) return true;
      var lore = loreOf(b) || {};
      var hay = [b.name, b.en, b.bio, b.quote, lore.profile || '', lore.story || '', (lore.trivia || []).join(' ')].concat(tags).join(' ');
      (b.skills || []).forEach(function (sid) {
        var s = skillById(sid);
        if (s) hay += ' ' + s.name + ' ' + (s.en || '') + ' ' + (s.desc || '');
      });
      return hay.toLowerCase().indexOf(q) >= 0;
    });
  }

  function codexCardHTML(ball) {
    var fav = U.favoriteId === ball.id;
    return '<button type="button" class="codex-card' + (U.codex.sel === ball.id ? ' is-on' : '') + '" ' +
      'data-act="codex-pick" data-ball="' + esc(ball.id) + '" style="' + orbStyle(ball) + '" ' +
      'aria-pressed="' + (U.codex.sel === ball.id ? 'true' : 'false') + '">' +
      '<span class="codex-card__top">' +
        orbHTML(ball, 'orb--codex', { state: 'idle' }) +
        '<span class="codex-card__ident">' +
          '<span class="codex-card__name">' + esc(ball.name) + '</span>' +
          '<span class="codex-card__en">' + esc(ball.en) + '</span>' +
        '</span>' +
        (fav ? '<span class="codex-card__fav" aria-label="收藏">★</span>' : '') +
      '</span>' +
      '<span class="codex-card__tags">' + tagsHTML(ball) + '</span>' +
      '<span class="codex-card__stats">' +
        '<span>生命值 <b>' + esc(ball.stats.hp) + '</b></span>' +
        '<span>攻击力 <b>' + esc(ball.stats.atk) + '</b></span>' +
        '<span>防御力 <b>' + esc(ball.stats.def) + '</b></span>' +
      '</span>' +
    '</button>';
  }

  function renderCodex() {
    var host = $('#screen-codex');
    if (!host) return;
    var balls = codexFilteredBalls();
    var selBall = ballById(U.codex.sel);
    if (!selBall || balls.indexOf(selBall) < 0) {
      selBall = balls[0] || null;
      U.codex.sel = selBall ? selBall.id : null;
    }
    var grid = $('#codex-grid');
    if (grid) {
      grid.innerHTML = balls.length
        ? balls.map(codexCardHTML).join('')
        : '<div class="empty-state"><b>没有匹配的斗士</b><p>换个关键词，或清除 tag 筛选。</p></div>';
    }
    var count = $('#codex-count');
    if (count) {
      count.innerHTML = '<b>' + balls.length + '</b> / ' + (G.BALLS ? G.BALLS.length : 0) + ' 位' +
        (U.codex.tag ? ' · ' + esc(U.codex.tag) : '');
    }
    var chips = $('#codex-tags');
    if (chips) chips.innerHTML = tagChipsHTML(tagList(), U.codex.tag, 'codex-tag');
    var detail = $('#codex-detail');
    if (detail) {
      detail.innerHTML = selBall
        ? fighterDetailHTML(selBall, { tab: U.codex.tab })
        : '<div class="detail-empty"><p>没有可展示的斗士</p></div>';
    }
    var search = $('#codex-search');
    if (search && search.value !== U.codex.q) search.value = U.codex.q;
    requestFacePaint();
  }

  function buildCodex() {
    var host = $('#screen-codex');
    if (!host) return;
    host.innerHTML = '' +
      '<div class="page page--codex">' +
        pageHeadHTML({
          kicker: 'FIGHTERS',
          en: 'ROSTER',
          titleHTML: '斗士<span class="title-mark">.</span>',
          subHTML: '按 tag 筛选或搜索名字与技能。点击卡片查看战斗资料与档案。'
        }) +
        '<div class="codex__tools">' +
          '<label class="search-box">' +
            '<span class="search-box__icon" aria-hidden="true"></span>' +
            '<input id="codex-search" type="search" placeholder="搜索斗士 / 英文名 / 技能" autocomplete="off" aria-label="搜索斗士">' +
          '</label>' +
          '<div class="filter-row" id="codex-tags" role="group" aria-label="按 tag 筛选"></div>' +
          '<span class="codex__count" id="codex-count" aria-live="polite"></span>' +
        '</div>' +
        '<div class="codex__body">' +
          '<div class="codex__grid" id="codex-grid" role="list"></div>' +
          '<aside class="codex__detail" id="codex-detail" aria-label="斗士详情" aria-live="polite"></aside>' +
        '</div>' +
      '</div>';
    var search = $('#codex-search');
    if (search) {
      search.addEventListener('input', function () {
        U.codex.q = search.value || '';
        renderCodex();
      });
    }
    renderCodex();
  }

  /* ================= 地图图鉴 MAPS ================= */
  function mapShapeLabel(map) {
    var shape = (map && map.shape) || 'square';
    if (shape === 'circle') return '圆形';
    if (shape === 'triangle') return '三角形';
    return '正方形';
  }
  function mapDetailHTML(map) {
    var scale = (G.RULES && G.RULES.duel && G.RULES.duel.arenaScale) || 0.86;
    var duelSize = Math.round(760 * scale);
    return '<article class="map-entry" style="--ma:' + esc(map.accent || '#FF6B1A') + ';--ma2:' + esc(map.accent2 || '#FFC24B') + '">' +
        '<div class="map-entry__preview">' + mapPreviewHTML(map) + '</div>' +
        '<div class="map-entry__body">' +
          '<header class="map-entry__head">' +
            '<h2 class="map-entry__name">' + esc(map.name) + '</h2>' +
            '<span class="map-entry__en">' + esc(map.en || '') + '</span>' +
            '<span class="map-entry__feature"><i aria-hidden="true"></i>' + esc(map.feature || '') + '</span>' +
          '</header>' +
          '<p class="map-entry__tagline">' + esc(map.tagline || '') + '</p>' +
          '<p class="map-entry__desc">' + esc(map.desc || '') + '</p>' +
          '<dl class="map-entry__facts">' +
            '<div><dt>边界形状</dt><dd>' + mapShapeLabel(map) + '</dd></div>' +
            '<div><dt>反弹规则</dt><dd>' + esc(map.feature || '镜面反弹') + '</dd></div>' +
            (map.sizeScale && Number(map.sizeScale) !== 1 ? '<div><dt>场地基础</dt><dd>×' + esc(map.sizeScale) + '（三角加成）</dd></div>' : '') +
            '<div><dt>大乱斗场地</dt><dd>760 × 0.86–1.22（按参战数）</dd></div>' +
            '<div><dt>排位决斗场地</dt><dd>' + duelSize + ' × ' + duelSize + '（×' + esc(scale) + '）</dd></div>' +
          '</dl>' +
        '</div>' +
      '</article>';
  }

  function renderMaps() {
    var host = $('#map-list');
    if (!host) return;
    var maps = (G.MAPS && G.MAPS.length) ? G.MAPS : [];
    host.innerHTML = maps.length ? maps.map(mapDetailHTML).join('') : '<div class="empty-state"><b>暂无地图数据</b></div>';
  }

  function buildMaps() {
    var host = $('#screen-maps');
    if (!host) return;
    host.innerHTML = '' +
      '<div class="page page--maps">' +
        pageHeadHTML({
          kicker: 'MAPS',
          en: 'ARENA GUIDE',
          titleHTML: '地图<span class="title-mark">.</span>',
          subHTML: '三张地图，在战场准备里选择。'
        }) +
        '<div class="maps__list" id="map-list"></div>' +
        '<section class="panel panel--note">' +
          '<header class="panel-head"><span class="panel-head__title">边界</span><span class="panel-head__en">BOUNDARY</span></header>' +
          '<ul class="note-list">' +
            '<li><b>方阵</b>：四面墙按入射角反弹，四个角落既能夹击也能藏身。</li>' +
            '<li><b>圆环</b>：边界沿切线反弹，角度不断被压缩，贴身缠斗更多。</li>' +
            '<li><b>三角</b>：三条斜边把球折回中心，角落更少、正面碰撞更多。</li>' +
            '<li><b>普通墙</b>：普通球反弹；虚化或穿墙单位可以穿过。</li>' +
            '<li><b>超域</b>：普通球反弹；虚化或穿墙单位也不能穿过。</li>' +
          '</ul>' +
        '</section>' +
      '</div>';
    renderMaps();
  }

  /* ================= 玩法介绍 GUIDE ================= */
  var GUIDE_TABS = [
    { id: 'controls', name: '操作', en: 'CONTROLS' },
    { id: 'effects', name: '效果', en: 'EFFECTS' },
    { id: 'modes', name: '模式', en: 'MODES' },
    { id: 'tags', name: 'tag', en: 'TAGS' },
    { id: 'maps', name: '地图', en: 'MAPS' },
    { id: 'boundary', name: '边界', en: 'BOUNDARY' }
  ];

  function guideTabsHTML() {
    return GUIDE_TABS.map(function (t) {
      var on = U.guide.tab === t.id;
      return '<button type="button" class="tab-btn' + (on ? ' is-on' : '') + '" role="tab" aria-selected="' + (on ? 'true' : 'false') + '" ' +
        'data-act="guide-tab" data-tab="' + esc(t.id) + '">' + esc(t.name) + '<em>' + esc(t.en) + '</em></button>';
    }).join('');
  }

  function guideControlsHTML() {
    return '' +
      '<div class="guide-grid">' +
        '<section class="panel guide-panel">' +
          '<header class="panel-head"><span class="panel-head__title">开局流程</span><span class="panel-head__en">FLOW</span></header>' +
          '<ul class="kv-list">' +
            '<li><span class="kv-list__k">选择模式</span><span class="kv-list__v">大厅选择大乱斗或排位赛</span></li>' +
            '<li><span class="kv-list__k">战场准备</span><span class="kv-list__v">选择地图与速胜时刻，然后挑选斗士</span></li>' +
            '<li><span class="kv-list__k">选择斗士</span><span class="kv-list__v">大乱斗 2–8 位；排位赛正好 8 位</span></li>' +
            '<li><span class="kv-list__k">开战</span><span class="kv-list__v">下方按钮开始比赛</span></li>' +
          '</ul>' +
        '</section>' +
        '<section class="panel guide-panel">' +
          '<header class="panel-head"><span class="panel-head__title">斗士</span><span class="panel-head__en">FIGHTERS</span></header>' +
          '<ul class="kv-list">' +
            '<li><span class="kv-list__k">详情</span><span class="kv-list__v">点击卡牌查看战斗资料；顶部切换战斗 / 档案</span></li>' +
            '<li><span class="kv-list__k">档案</span><span class="kv-list__v">出生日期、故事、关系与轶闻</span></li>' +
            '<li><span class="kv-list__k">收藏</span><span class="kv-list__v">在斗士详情设为喜欢；再按一次取消</span></li>' +
            '<li><span class="kv-list__k">效果词</span><span class="kv-list__v">技能里的减速、护盾等可查看说明</span></li>' +
          '</ul>' +
        '</section>' +
        '<section class="panel guide-panel">' +
          '<header class="panel-head"><span class="panel-head__title">战斗</span><span class="panel-head__en">BATTLE</span></header>' +
          '<ul class="kv-list">' +
            '<li><span class="kv-list__k">暂停</span><span class="kv-list__v"><kbd>Space</kbd> 或暂停按钮</span></li>' +
            '<li><span class="kv-list__k">倍速</span><span class="kv-list__v">0.5× / 1× / 2×，每场开始回到 1×</span></li>' +
            '<li><span class="kv-list__k">查看</span><span class="kv-list__v">点击底部血条或球，在右侧展开战斗档案；Esc 或关闭恢复</span></li>' +
            '<li><span class="kv-list__k">能量</span><span class="kv-list__v">每秒 +1，满能量自动施放主动技能</span></li>' +
            '<li><span class="kv-list__k">退场</span><span class="kv-list__v"><kbd>Esc</kbd> 退场（排位赛为退出本场）</span></li>' +
          '</ul>' +
        '</section>' +
        '<section class="panel guide-panel">' +
          '<header class="panel-head"><span class="panel-head__title">键盘与触屏</span><span class="panel-head__en">INPUT</span></header>' +
          '<ul class="kv-list">' +
            '<li><span class="kv-list__k">键盘</span><span class="kv-list__v"><kbd>Tab</kbd> 切换 · <kbd>Enter</kbd> 确认 · <kbd>Esc</kbd> 返回</span></li>' +
            '<li><span class="kv-list__k">效果词</span><span class="kv-list__v">桌面悬停查看，手机按住查看</span></li>' +
            '<li><span class="kv-list__k">移动端</span><span class="kv-list__v">底部导航切换大厅 / 斗士 / 玩法 / 设置</span></li>' +
          '</ul>' +
        '</section>' +
      '</div>';
  }

  function guideEffectsHTML() {
    var list = effectsList();
    var types = (G && G.DAMAGE_TYPES) || [];
    if (!list.length) return '<div class="empty-state"><b>效果尚未载入</b></div>';
    return '' +
      '<div class="effect-grid">' + list.map(function (e) {
        return '<article class="effect-card" id="effect-' + esc(e.id) + '">' +
            '<header class="effect-card__head"><b class="effect-card__name">' + esc(e.name) + '</b>' +
              '<span class="effect-card__en">' + esc(e.en || '') + '</span></header>' +
            '<p class="effect-card__desc">' + esc(e.desc || '') + '</p>' +
            (e.note ? '<p class="effect-card__note"><b>规则</b>' + esc(e.note) + '</p>' : '') +
          '</article>';
      }).join('') + '</div>' +
      (types.length ? '<section class="panel guide-panel damage-panel">' +
        '<header class="panel-head"><span class="panel-head__title">伤害类型</span><span class="panel-head__en">DAMAGE</span></header>' +
        '<div class="mech-list">' + types.map(function (t) {
          return '<div class="mech-row"><span class="mech-row__dot" aria-hidden="true"></span>' +
            '<div class="mech-row__body"><span class="mech-row__name">' + esc(t.name) + '<em>' + esc(t.en || '') + '</em></span>' +
            '<span class="mech-row__desc">' + esc(t.desc || '') + '</span></div></div>';
        }).join('') + '</div></section>' : '');
  }

  function guideModesHTML() {
    var modes = (G.MODES && G.MODES.length) ? G.MODES : [];
    var mechs = mechanismDefs();
    var limit = (G.RULES && G.RULES.timeLimit) || 300;
    return '' +
      '<div class="guide-modes">' + modes.map(function (m) {
        return '<article class="panel mode-guide" style="--ma:' + esc(m.accent || '#FF6B1A') + ';--ma2:' + esc(m.accent2 || '#FFC24B') + '">' +
            '<header class="mode-guide__head">' + modeIconHTML(m) +
              '<div><h3 class="mode-guide__name">' + esc(m.name) + '</h3><span class="mode-guide__en">' + esc(m.en || '') + '</span></div>' +
            '</header>' +
            '<p class="mode-guide__tagline">' + esc(m.tagline || '') + '</p>' +
            '<p class="mode-guide__desc">' + esc(m.desc || '') + '</p>' +
            '<ul class="kv-list kv-list--tight">' +
              '<li><span class="kv-list__k">阵容</span><span class="kv-list__v">' + (m.minLineup || 2) + '–' + (m.maxLineup || 8) + ' 位' +
                (m.id === 'ranked' ? '（正好 8 位）' : '') + '</span></li>' +
              '<li><span class="kv-list__k">胜负</span><span class="kv-list__v">' + (m.id === 'ranked' ? '单败淘汰，决出 1–8 名' : '最后存活的斗士获胜') + '</span></li>' +
              '<li><span class="kv-list__k">时限</span><span class="kv-list__v">' + limit + ' 秒</span></li>' +
            '</ul>' +
          '</article>';
      }).join('') + '</div>' +
      '<section class="panel guide-panel">' +
        '<header class="panel-head"><span class="panel-head__title">对战机制</span><span class="panel-head__en">MECHANICS</span></header>' +
        '<div class="mech-list">' + mechs.map(function (m) {
          var locked = m.type === 'locked' || m.locked;
          return '<div class="mech-row' + (locked ? ' is-locked' : '') + '">' +
              '<span class="mech-row__dot" aria-hidden="true"></span>' +
              '<div class="mech-row__body">' +
                '<span class="mech-row__name">' + esc(m.name) + '<em>' + esc(m.en || '') + '</em>' +
                  '<span class="mech-row__chip ' + (m.default ? 'is-on' : '') + '">默认 ' + (m.default ? '开' : '关') + '</span>' +
                '</span>' +
                '<span class="mech-row__desc">' + esc(m.desc || '') + '</span>' +
              '</div>' +
            '</div>';
        }).join('') + '</div>' +
      '</section>';
  }

  function guideTagsHTML() {
    var tags = tagList();
    if (!tags.length) return '<div class="empty-state"><b>tag 尚未载入</b></div>';
    return '' +
      '<p class="guide-lead">每位斗士最多 2 个 tag，主 tag 在前。</p>' +
      '<div class="tag-guide-grid">' + tags.map(function (t) {
        return '<article class="tag-guide" style="--tag-color:' + esc(t.color || '#A89DBB') + '">' +
            '<header class="tag-guide__head"><span class="tag-guide__dot" aria-hidden="true"></span>' +
              '<b class="tag-guide__name">' + esc(t.name) + '</b><em class="tag-guide__en">' + esc(t.en || '') + '</em></header>' +
            '<p class="tag-guide__desc">' + esc(t.desc || '') + '</p>' +
          '</article>';
      }).join('') + '</div>';
  }

  function guideMapsHTML() {
    var maps = (G.MAPS && G.MAPS.length) ? G.MAPS : [];
    return '' +
      '<p class="guide-lead">地图在战场准备里选择；场地会随参战数量缩放。</p>' +
      '<div class="guide-maps">' + maps.map(function (m) {
        return '<button type="button" class="guide-map" data-act="nav" data-screen="maps" style="--ma:' + esc(m.accent || '#FF6B1A') + ';--ma2:' + esc(m.accent2 || '#FFC24B') + '">' +
            mapPreviewHTML(m) +
            '<span class="guide-map__body"><b>' + esc(m.name) + '</b><em>' + esc(m.en || '') + '</em>' +
              '<span>' + esc(m.tagline || '') + ' · ' + esc(m.feature || '') + '</span></span>' +
            '<span class="guide-map__arrow" aria-hidden="true">›</span>' +
          '</button>';
      }).join('') + '</div>';
  }

  function guideBoundaryHTML() {
    var bounds = (G && G.BOUNDARIES) || [];
    var obstacle = (G && G.MECHANISM_BY_ID && G.MECHANISM_BY_ID.randomObstacles) || null;
    var rules = (G && G.RULES && G.RULES.obstacles) || {};
    return '' +
      '<p class="guide-lead">边界分两种：普通墙与超域。普通球撞上都会反弹，差别在于虚化/穿墙能否穿过。</p>' +
      '<div class="guide-grid">' +
        (bounds.length ? bounds.map(function (b) {
          return '<section class="panel guide-panel">' +
              '<header class="panel-head"><span class="panel-head__title">' + esc(b.name) + '</span><span class="panel-head__en">' + esc(b.en || '') + '</span></header>' +
              '<p class="guide-lead">' + esc(b.desc || '') + '</p>' +
            '</section>';
        }).join('') : '<section class="panel guide-panel"><p class="guide-lead">边界资料尚未载入。</p></section>') +
        '<section class="panel guide-panel">' +
          '<header class="panel-head"><span class="panel-head__title">随机障碍</span><span class="panel-head__en">RANDOM WALLS</span></header>' +
          '<ul class="kv-list">' +
            '<li><span class="kv-list__k">生成</span><span class="kv-list__v">每 ' + esc((rules.interval || 10)) + ' 秒 1–' + esc((rules.max || 3)) + ' 个，持续 ' + esc((rules.life || 3)) + ' 秒</span></li>' +
            '<li><span class="kv-list__k">形状</span><span class="kv-list__v">圆形 / 三角形 / 正方形，尺寸较小</span></li>' +
            '<li><span class="kv-list__k">类型</span><span class="kv-list__v">90% 普通墙，10% 超域</span></li>' +
            '<li><span class="kv-list__k">对象</span><span class="kv-list__v">对球与可移动召唤物都按边界处理</span></li>' +
          '</ul>' +
          (obstacle ? '<p class="guide-foot-note">' + esc(obstacle.desc || '') + '</p>' : '') +
        '</section>' +
      '</div>';
  }

  function renderGuide() {
    var tabs = $('#guide-tabs');
    if (tabs) tabs.innerHTML = guideTabsHTML();
    var body = $('#guide-body');
    if (!body) return;
    if (U.guide.tab === 'effects') body.innerHTML = guideEffectsHTML();
    else if (U.guide.tab === 'modes') body.innerHTML = guideModesHTML();
    else if (U.guide.tab === 'tags') body.innerHTML = guideTagsHTML();
    else if (U.guide.tab === 'maps') body.innerHTML = guideMapsHTML();
    else if (U.guide.tab === 'boundary') body.innerHTML = guideBoundaryHTML();
    else body.innerHTML = guideControlsHTML();
  }

  function buildGuide() {
    var host = $('#screen-guide');
    if (!host) return;
    host.innerHTML = '' +
      '<div class="page page--guide">' +
        pageHeadHTML({
          kicker: 'GUIDE',
          en: 'HOW TO PLAY',
          titleHTML: '玩法<span class="title-mark">.</span>',
          subHTML: '流程、效果、地图与边界。'
        }) +
        '<div class="tabs tabs--guide" id="guide-tabs" role="tablist" aria-label="玩法分类"></div>' +
        '<div class="guide__body" id="guide-body"></div>' +
      '</div>';
    renderGuide();
  }

  /* ================= 设置 SETTINGS ================= */
  function audioHasVolume() {
    return !!(root.BallAudio && typeof root.BallAudio.setVolume === 'function');
  }

  function applySettings() {
    var s = U.settings;
    U.reduced = !!s.reduced;
    if (document.documentElement) document.documentElement.classList.toggle('reduce-motion', U.reduced);
    if (document.body) document.body.classList.toggle('reduce-motion', U.reduced);
    if (root.BallRenderer && typeof root.BallRenderer.setReducedMotion === 'function') {
      try { root.BallRenderer.setReducedMotion(U.reduced); } catch (e) { }
    }
    U.settings.volumeApi = audioHasVolume();
    if (U.settings.volumeApi) {
      try { root.BallAudio.setVolume(clamp(Number(s.volume) || 0, 0, 100) / 100); } catch (e) { }
    }
    if (root.BallAudio && typeof root.BallAudio.setMusicVolume === 'function') {
      try { root.BallAudio.setMusicVolume(clamp(Number(s.musicVolume) || 0, 0, 100) / 100); } catch (e) { }
    }
    applyMusicPrefs(false);
    try {
      var ev;
      if (typeof root.CustomEvent === 'function') {
        ev = new root.CustomEvent('ballpit:reducedmotion', { detail: { reduced: U.reduced } });
      } else {
        ev = document.createEvent('CustomEvent');
        ev.initCustomEvent('ballpit:reducedmotion', false, false, { reduced: U.reduced });
      }
      root.dispatchEvent(ev);
    } catch (e) { }
    savePrefs();
  }

  function switchHTML(act, on, label, extra) {
    return '<button type="button" class="switch' + (on ? ' is-on' : '') + '" data-act="' + act + '" ' +
      'aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + esc(label) + '" ' + (extra || '') + '>' +
      '<span class="switch__track" aria-hidden="true"><i></i></span>' +
      '<span class="switch__state" aria-hidden="true">' + (on ? '开' : '关') + '</span>' +
    '</button>';
  }

  function renderSettings() {
    var host = $('#screen-settings');
    if (!host) return;
    var vol = $('#set-volume');
    if (vol && Number(vol.value) !== Number(U.settings.volume)) vol.value = String(U.settings.volume);
    var volVal = $('#set-volume-val');
    if (volVal) volVal.textContent = String(U.settings.volume);
    var muteBtn = $('#set-mute');
    if (muteBtn) {
      muteBtn.outerHTML = switchHTML('toggle-mute', !!U.muted, '静音开关', 'id="set-mute"');
    }
    var reduceBtn = $('#set-reduced');
    if (reduceBtn) {
      reduceBtn.outerHTML = switchHTML('toggle-reduced', !!U.reduced, '减少动效', 'id="set-reduced"');
    }
    var muteState = $('#set-mute-state');
    if (muteState) muteState.textContent = U.muted ? '已静音' : '音效开启';
    var reduceState = $('#set-reduce-state');
    if (reduceState) reduceState.textContent = U.reduced ? '已减少动效' : '动效正常';
    var musicVol = $('#set-music-volume');
    if (musicVol && Number(musicVol.value) !== Number(U.settings.musicVolume)) musicVol.value = String(U.settings.musicVolume);
    var musicVal = $('#set-music-val');
    if (musicVal) musicVal.textContent = String(U.settings.musicVolume);
    var trackSel = $('#set-lobby-track');
    if (trackSel && $('option', trackSel)) {
      var want = currentLobbyTrackId();
      $all('option', trackSel).forEach(function (opt) { opt.selected = opt.value === want; });
      trackSel.value = want;
    }
    var battleHint = $('#set-battle-music');
    if (battleHint) battleHint.textContent = '战斗音乐：' + (((battleMusicTrack() || {}).name) || '暂无音轨') + ' · 速胜时刻沿用战斗曲';
    var ver = $('#settings-version');
    if (ver) ver.textContent = 'v' + ((G && G.VERSION) || '0.4.4');
    var favState = $('#set-fav-state');
    if (favState) {
      var favBall = ballById(U.favoriteId);
      favState.textContent = favBall ? ('当前：' + favBall.name) : '未收藏';
    }
  }

  /* ---------- v0.4.2 音乐（GameData.MUSIC_SLOTS 驱动） ---------- */
  function musicSlotList() {
    var raw = G && G.MUSIC_SLOTS;
    if (!raw) return [];
    if (Array.isArray(raw)) {
      return raw.filter(Boolean).map(function (s) {
        return {
          id: String(s.id || s.trackId || s.slot || s.name || ''),
          name: String(s.name || s.id || ''),
          src: typeof s.src === 'string' ? s.src : '',
          slot: s.slot || '',
          def: !!s.default
        };
      }).filter(function (s) { return s.id; });
    }
    if (typeof raw === 'object') {
      return Object.keys(raw).map(function (k) {
        var v = raw[k];
        return {
          id: k,
          name: String((v && v.name) || k),
          src: typeof v === 'string' ? v : ((v && v.src) || ''),
          slot: (v && v.slot) || '',
          def: !!(v && v.default)
        };
      });
    }
    return [];
  }
  function musicSlotOf(s) {
    if (s && s.slot) return s.slot;
    if (!s) return '';
    if (s.id === 'battle' || s.id === 'suddenDeath') return 'battle';
    if (s.id === 'lobby' || /^lobby[_-]/i.test(s.id)) return 'lobby';
    return '';
  }
  function lobbyMusicTracks() {
    return musicSlotList().filter(function (s) {
      return musicSlotOf(s) === 'lobby' && String(s.src || '').trim();
    });
  }
  function battleMusicTrack() {
    return musicSlotList().filter(function (s) { return musicSlotOf(s) === 'battle' && String(s.src || '').trim(); })[0] || null;
  }
  function currentLobbyTrackId() {
    var tracks = lobbyMusicTracks();
    if (!tracks.length) return '';
    var want = U.settings.musicTrack;
    for (var i = 0; i < tracks.length; i++) if (tracks[i].id === want) return want;
    for (var j = 0; j < tracks.length; j++) if (tracks[j].def) return tracks[j].id;
    return tracks[0].id;
  }
  function lobbyTrackSelectHTML() {
    var tracks = lobbyMusicTracks();
    if (!tracks.length) return '<span class="setting-hint setting-hint--inline">暂无音轨</span>';
    var current = currentLobbyTrackId();
    return '<select id="set-lobby-track" class="select-box" aria-label="大厅音乐">' + tracks.map(function (t) {
      return '<option value="' + esc(t.id) + '"' + (t.id === current ? ' selected' : '') + '>' + esc(t.name) + '</option>';
    }).join('') + '</select>';
  }
  function applyMusicPrefs(play) {
    var A = root.BallAudio;
    if (!A) return;
    try {
      if (A.setMusicSources && G && G.MUSIC_SLOTS) A.setMusicSources(G.MUSIC_SLOTS);
      if (A.setMusicVolume) A.setMusicVolume(clamp(Number(U.settings.musicVolume) || 0, 0, 100) / 100);
      var id = currentLobbyTrackId();
      U.settings.musicTrack = id;
      if (id && A.setLobbyTrack) A.setLobbyTrack(id);
      if (play && U.screen === 'home' && A.playMusic) A.playMusic('lobby');
    } catch (e) { }
  }
  function selectLobbyTrack(id) {
    var tracks = lobbyMusicTracks();
    var ok = false;
    for (var i = 0; i < tracks.length; i++) if (tracks[i].id === id) ok = true;
    if (!ok) return false;
    U.settings.musicTrack = id;
    savePrefs();
    var A = root.BallAudio;
    if (!A) return true;
    try {
      if (A.unlock) A.unlock();
      if (A.setMusicSources && G && G.MUSIC_SLOTS) A.setMusicSources(G.MUSIC_SLOTS);
      if (A.setLobbyTrack) A.setLobbyTrack(id);
      if (A.setMusicVolume) A.setMusicVolume(clamp(Number(U.settings.musicVolume) || 0, 0, 100) / 100);
      if (A.playMusic) A.playMusic('lobby');
    } catch (e) { }
    return true;
  }

  function buildSettings() {
    var host = $('#screen-settings');
    if (!host) return;
    host.innerHTML = '' +
      '<div class="page page--settings">' +
        pageHeadHTML({
          kicker: 'SETTINGS',
          en: 'SOUND / MOTION / LOCAL',
          titleHTML: '设置<span class="title-mark">.</span>',
          subHTML: '声音、动效与本地偏好。'
        }) +
        '<div class="settings-grid">' +
          '<section class="panel settings-panel" aria-labelledby="set-audio-title">' +
            '<header class="panel-head"><span class="panel-head__title" id="set-audio-title">声音</span><span class="panel-head__en">AUDIO</span></header>' +
            '<div class="setting-row setting-row--slider">' +
              '<label class="setting-row__label" for="set-volume">音量</label>' +
              '<div class="setting-row__control">' +
                '<input id="set-volume" class="range" type="range" min="0" max="100" step="5" value="' + esc(U.settings.volume) + '" aria-label="音量">' +
                '<output class="range__val" id="set-volume-val">' + esc(U.settings.volume) + '</output>' +
                '<button type="button" class="btn btn--ghost btn--sm" data-act="audio-test">试听</button>' +
              '</div>' +
            '</div>' +
            '<div class="setting-row">' +
              '<span class="setting-row__label">静音<span class="setting-row__note" id="set-mute-state"></span></span>' +
              '<div class="setting-row__control">' + switchHTML('toggle-mute', !!U.muted, '静音开关', 'id="set-mute"') + '</div>' +
            '</div>' +
          '</section>' +
          '<section class="panel settings-panel" aria-labelledby="set-music-title">' +
            '<header class="panel-head"><span class="panel-head__title" id="set-music-title">音乐</span><span class="panel-head__en">MUSIC</span></header>' +
            '<div class="setting-row setting-row--slider">' +
              '<label class="setting-row__label" for="set-music-volume">音乐音量</label>' +
              '<div class="setting-row__control">' +
                '<input id="set-music-volume" class="range" type="range" min="0" max="100" step="5" value="' + esc(U.settings.musicVolume) + '" aria-label="音乐音量">' +
                '<output class="range__val" id="set-music-val">' + esc(U.settings.musicVolume) + '</output>' +
              '</div>' +
            '</div>' +
            '<div class="setting-row">' +
              '<label class="setting-row__label" for="set-lobby-track">大厅音乐</label>' +
              '<div class="setting-row__control">' + lobbyTrackSelectHTML() + '</div>' +
            '</div>' +
            '<p class="setting-hint" id="set-battle-music">战斗音乐：' + esc((battleMusicTrack() || {}).name || '暂无音轨') + ' · 速胜时刻沿用战斗曲</p>' +
          '</section>' +
          '<section class="panel settings-panel" aria-labelledby="set-motion-title">' +
            '<header class="panel-head"><span class="panel-head__title" id="set-motion-title">动效</span><span class="panel-head__en">MOTION</span></header>' +
            '<div class="setting-row">' +
              '<span class="setting-row__label">减少动效<span class="setting-row__note" id="set-reduce-state"></span></span>' +
              '<div class="setting-row__control">' + switchHTML('toggle-reduced', !!U.reduced, '减少动效', 'id="set-reduced"') + '</div>' +
            '</div>' +
            '<p class="setting-hint">减少装饰动画与镜头晃动。</p>' +
          '</section>' +
          '<section class="panel settings-panel" aria-labelledby="set-local-title">' +
            '<header class="panel-head"><span class="panel-head__title" id="set-local-title">本地</span><span class="panel-head__en">LOCAL</span></header>' +
            '<div class="setting-row">' +
              '<span class="setting-row__label">喜欢的小球<span class="setting-row__note" id="set-fav-state"></span></span>' +
              '<div class="setting-row__control">' +
                '<button type="button" class="btn btn--ghost btn--sm" data-act="nav" data-screen="codex">去斗士</button>' +
                '<button type="button" class="btn btn--ghost btn--sm" data-act="reset-prefs">清除偏好</button>' +
              '</div>' +
            '</div>' +
          '</section>' +
          '<section class="panel settings-panel" aria-labelledby="set-about-title">' +
            '<header class="panel-head"><span class="panel-head__title" id="set-about-title">关于</span><span class="panel-head__en">ABOUT</span></header>' +
            '<dl class="about-list">' +
              '<div><dt>版本</dt><dd id="settings-version">v' + esc((G && G.VERSION) || '0.4.4') + '</dd></div>' +
              '<div><dt>模式</dt><dd>大乱斗 · 排位赛</dd></div>' +
              '<div><dt>地图</dt><dd>方阵 · 圆环 · 三角</dd></div>' +
              '<div><dt>快捷</dt><dd><kbd>Space</kbd> 暂停 · <kbd>Esc</kbd> 返回</dd></div>' +
            '</dl>' +
            '<div class="settings-links">' +
              '<button type="button" class="btn btn--ghost btn--sm" data-act="nav" data-screen="guide">玩法</button>' +
              '<button type="button" class="btn btn--ghost btn--sm" data-act="nav" data-screen="patches">更新</button>' +
            '</div>' +
          '</section>' +
        '</div>' +
      '</div>';
    var range = $('#set-volume');
    if (range) {
      range.addEventListener('input', function () {
        U.settings.volume = clamp(Math.round(Number(range.value) || 0), 0, 100);
        var out = $('#set-volume-val');
        if (out) out.textContent = String(U.settings.volume);
        applySettings();
      });
    }
    var mrange = $('#set-music-volume');
    if (mrange) {
      mrange.addEventListener('input', function () {
        U.settings.musicVolume = clamp(Math.round(Number(mrange.value) || 0), 0, 100);
        var out = $('#set-music-val');
        if (out) out.textContent = String(U.settings.musicVolume);
        applySettings();
      });
    }
    var trackSel = $('#set-lobby-track');
    if (trackSel) {
      trackSel.addEventListener('change', function () {
        if (selectLobbyTrack(trackSel.value)) renderSettings();
      });
    }
    applyMusicPrefs(false);
    renderSettings();
  }

  function testAudio() {
    var A = root.BallAudio;
    if (!A) { toast('音频模块未加载'); return; }
    try {
      if (A.init) A.init();
      if (A.unlock) A.unlock();
      if (A.play) A.play('start');
    } catch (e) { }
    toast(U.muted ? '当前为静音状态' : '音效试听 · 音量 ' + U.settings.volume);
  }

  function resetPrefs() {
    U.settings.volume = 70;
    U.settings.musicVolume = 60;
    U.settings.musicTrack = '';
    U.settings.reduced = false;
    U.favoriteId = null;
    U.lobbyViewId = null;
    U.muted = false;
    if (typeof U.cb.onMuteToggle === 'function') U.cb.onMuteToggle(false);
    applySettings();
    applyMusicPrefs(false);
    renderSettings();
    if (U.screen === 'home') { U.lobbyViewId = null; renderFavorite(); startLobbyRotation(); }
    toast('本地偏好已清除');
  }

  /* ================= 更新日志 PATCH NOTES ================= */
  var CHANGELOG_SOURCE = {
    loading: { label: '载入中', cls: 'loading' },
    live: { label: '实时同步', cls: 'live' },
    embedded: { label: '离线快照', cls: 'embedded' },
    file: { label: '手动载入', cls: 'file' },
    error: { label: '读取失败', cls: 'error' }
  };

  function patchTagBadge(tagId) {
    var tag = dataTagDef(tagId);
    return '<span class="patch-tag" style="--tag-color:' + esc(tag.color) + '">' + esc(tag.name) + '<em>' + esc(tag.en) + '</em></span>';
  }

  function patchTagChipsHTML() {
    var total = patchEntriesFlat().length;
    return '<button type="button" class="filter-chip ' + (!U.patches.tag ? 'is-on' : '') + '" data-act="patch-tag" data-tag="" aria-pressed="' + (!U.patches.tag ? 'true' : 'false') + '">全部 <b>' + total + '</b></button>' +
      DATA_TAGS.map(function (t) {
        var count = patchEntriesFlat().filter(function (row) { return (row.entry.tag || '') === t.id; }).length;
        var on = U.patches.tag === t.id;
        return '<button type="button" class="filter-chip filter-chip--tag ' + (on ? 'is-on' : '') + '" data-act="patch-tag" data-tag="' + esc(t.id) + '" ' +
          'style="--tag-color:' + esc(t.color) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
          '<i class="filter-chip__dot" aria-hidden="true"></i>' + esc(t.name) + ' <b>' + count + '</b></button>';
      }).join('');
  }

  function patchEntriesFlat() {
    var out = [];
    dataPatches().forEach(function (patch) {
      (patch.entries || []).forEach(function (entry) {
        out.push({ patch: patch, entry: entry });
      });
    });
    return out;
  }

  function patchBallsWithEntries() {
    var map = {}, order = [];
    patchEntriesFlat().forEach(function (row) {
      var id = row.entry.ballId;
      if (!id) return;
      var ball = ballById(id);
      if (!ball) return;
      if (!map[ball.id]) { map[ball.id] = ball; order.push(ball.id); }
    });
    return order.map(function (id) { return map[id]; });
  }

  function patchFilteredEntries() {
    return patchEntriesFlat().filter(function (row) {
      var e = row.entry || {};
      if (U.patches.tag && (e.tag || '') !== U.patches.tag) return false;
      if (U.patches.ball) {
        if (U.patches.ball === '__meta__') { if (e.ballId) return false; }
        else if (e.ballId !== U.patches.ball) return false;
      }
      return true;
    });
  }

  function isNumericLike(v) {
    if (typeof v === 'number') return isFinite(v);
    return /^-?\d+(\.\d+)?$/.test(String(v == null ? '' : v).trim());
  }

  function changeValText(v, unit) {
    if (v === null || v === undefined || v === '') return '—';
    if (isNumericLike(v)) {
      var n = Number(v);
      var text = String(Math.round(n * 100) / 100);
      return unit ? text + ' ' + unit : text;
    }
    return String(v) + (unit ? ' ' + unit : '');
  }

  function changeDirection(before, after) {
    if (!isNumericLike(before) || !isNumericLike(after)) return '';
    var a = Number(after), b = Number(before);
    if (a > b) return ' is-up';
    if (a < b) return ' is-down';
    return ' is-flat';
  }

  function changeRowHTML(c) {
    c = c || {};
    var field = String(c.field || '');
    if (/id|编号/i.test(field) || hasIdToken(c.before) || hasIdToken(c.after)) return '';
    var unit = (c.unit === null || c.unit === undefined) ? '' : String(c.unit);
    var dir = changeDirection(c.before, c.after);
    return '<li class="change-row' + dir + '">' +
        '<span class="change-row__field">' + esc(redactIds(field)) + '</span>' +
        '<span class="change-row__before">' + esc(redactIds(changeValText(c.before, ''))) + '</span>' +
        '<span class="change-row__arrow" aria-hidden="true">→</span>' +
        '<span class="change-row__after">' + esc(redactIds(changeValText(c.after, unit))) + '</span>' +
      '</li>';
  }

  function patchEntryHTML(patch, entry) {
    entry = entry || {};
    var tag = dataTagDef(entry.tag);
    var ball = entry.ballId ? ballById(entry.ballId) : null;
    var full = entry.fullText || entry.full || entry.detail || entry.body || entry.reworkText || '';
    var changes = (entry.changes || []).map(changeRowHTML).filter(Boolean).join('');
    var modes = Array.isArray(entry.modes) && entry.modes.length
      ? '<span class="patch-entry__modes">' + entry.modes.map(function (m) { return '<i>' + esc(m) + '</i>'; }).join('') + '</span>'
      : '';
    var ident = ball
      ? '<span class="patch-entry__orb">' + orbHTML(ball, 'orb--patch', { state: 'idle' }) + '</span>' +
        '<span class="patch-entry__name">' + esc(ball.name) + '<em>' + esc(ball.en) + '</em></span>'
      : '<span class="patch-entry__orb"><span class="orb orb--patch" aria-hidden="true"></span></span>' +
        '<span class="patch-entry__name">' + esc(entry.ballName || '全局') + '<em>ALL</em></span>';
    return '' +
      '<article class="patch-entry" data-tag="' + esc(entry.tag || '') + '">' +
        '<header class="patch-entry__head">' +
          '<span class="patch-entry__ident">' + ident + '</span>' +
          '<span class="patch-entry__target">' + esc(redactIds(entry.target || '')) + '</span>' +
          patchTagBadge(entry.tag) +
        '</header>' +
        (changes ? '<ul class="change-list">' + changes + '</ul>' : '') +
        (entry.summary ? '<p class="patch-entry__summary">' + esc(redactIds(entry.summary)) + '</p>' : '') +
        (full ? '<details class="patch-entry__full"><summary>查看全文 / 重做说明</summary><p>' + esc(redactIds(full)) + '</p></details>' : '') +
        '<footer class="patch-entry__foot">' +
          '<span class="patch-entry__version">' + esc(patch.date || '') + (patch.seq != null ? ' · #' + esc(pad2(patch.seq)) : '') + '</span>' +
          modes +
        '</footer>' +
      '</article>';
  }

  function patchGroupLabel(patch) {
    return esc(patch.date || '') + (patch.seq != null ? ' · #' + esc(pad2(patch.seq)) : '');
  }

  function patchLegendHTML() {
    return '<div class="patch-legend" aria-label="数据更新 tag 图例">' + DATA_TAGS.map(function (t) {
      return '<div class="patch-legend__item" style="--tag-color:' + esc(t.color) + '">' +
          '<span class="patch-legend__name"><i aria-hidden="true"></i>' + esc(t.name) + '<em>' + esc(t.en) + '</em></span>' +
          '<p>' + esc(t.desc) + '</p>' +
        '</div>';
    }).join('') + '</div>';
  }

  function patchVersionSummaryHTML(version, date, count, open) {
    return '<summary class="patch-version__head">' +
        '<span class="patch-version__chev" aria-hidden="true"></span>' +
        '<b class="patch-version__ver">v' + esc(version || '') + '</b>' +
        (date ? '<span class="patch-version__date">' + esc(date) + '</span>' : '') +
        '<span class="patch-version__count">' + count + ' 条</span>' +
      '</summary>';
  }

  function patchGroupSummaryHTML(labelHTML, count) {
    return '<summary class="patch-version__head">' +
        '<span class="patch-version__chev" aria-hidden="true"></span>' +
        '<b class="patch-version__ver">' + labelHTML + '</b>' +
        '<span class="patch-version__count">' + count + ' 条</span>' +
      '</summary>';
  }

  function patchDataGroups() {
    var groups = dataPatches().slice();
    groups.sort(function (a, b) {
      if (a.date !== b.date) return String(b.date || '').localeCompare(String(a.date || ''));
      return (Number(b.seq) || 0) - (Number(a.seq) || 0);
    });
    return groups;
  }

  function patchDataTabHTML() {
    var rows = patchFilteredEntries();
    var balls = patchBallsWithEntries();
    var ballOptions = '<option value="">全部斗士</option>' +
      '<option value="__meta__"' + (U.patches.ball === '__meta__' ? ' selected' : '') + '>全局</option>' +
      balls.map(function (b) {
        return '<option value="' + esc(b.id) + '"' + (U.patches.ball === b.id ? ' selected' : '') + '>' +
          esc(b.name) + '</option>';
      }).join('');
    var patches = patchDataGroups();
    var latest = patches[0] || {};
    var openUsed = false;
    var groups = patches.map(function (patch) {
      var entries = rows.filter(function (row) { return row.patch === patch; });
      if (!entries.length) return '';
      var open = !openUsed;
      openUsed = true;
      return '<details class="patch-version"' + (open ? ' open' : '') + '>' +
          patchGroupSummaryHTML(patchGroupLabel(patch), entries.length) +
          '<div class="patch-version__body">' +
            entries.map(function (row) { return patchEntryHTML(row.patch, row.entry); }).join('') +
          '</div>' +
        '</details>';
    }).join('');
    return '' +
      '<div class="patch-hero">' +
        '<div class="patch-hero__id"><span class="patch-hero__tag">DATA PATCHES</span>' +
          '<b class="patch-hero__ver">' + patchGroupLabel(latest) + '</b></div>' +
        '<p class="patch-hero__note">按日期与当日序号记录数值与机制调整；最新一条默认展开，历史折叠。</p>' +
      '</div>' +
      '<div class="patch-toolbar">' +
        '<div class="filter-row" role="group" aria-label="按数据更新 tag 筛选">' + patchTagChipsHTML() + '</div>' +
        '<label class="select-box">筛选' +
          '<select id="patch-ball">' + ballOptions + '</select>' +
        '</label>' +
        '<span class="patch-count" aria-live="polite">' + rows.length + ' 条</span>' +
      '</div>' +
      patchLegendHTML() +
      (rows.length ? groups : '<div class="empty-state"><b>没有匹配的记录</b><p>切换 tag 或斗士筛选。</p></div>');
  }

  function sysCategoriesHTML(entries, allCategories) {
    return SYSTEM_CATEGORIES.map(function (cat) {
      var items = entries.filter(function (e) { return e.cat === cat.id; });
      if (!items.length && !allCategories) return '';
      return '<section class="sys-cat">' +
          '<header class="sys-cat__head">' +
            '<b class="sys-cat__name">' + esc(cat.name) + '</b>' +
            '<em class="sys-cat__en">' + esc(cat.en) + '</em>' +
            '<span class="sys-cat__count">' + items.length + '</span>' +
          '</header>' +
          (items.length
            ? '<ul class="sys-list">' + items.map(function (it) { return '<li>' + esc(it.text) + '</li>'; }).join('') + '</ul>'
            : '<p class="sys-empty">本轮无此类改动</p>') +
        '</section>';
    }).join('');
  }

  function changelogPanelHTML() {
    var md = U.changelog || {};
    var src = CHANGELOG_SOURCE[md.source] || CHANGELOG_SOURCE.loading;
    var body = md.markdown
      ? '<div class="md changelog-md">' + renderMarkdown(md.markdown) + '</div>'
      : '<p class="sys-empty">' + esc(md.note || 'CHANGELOG.md 尚未载入') + '</p>';
    return '<details class="panel changelog-source">' +
        '<summary class="changelog-summary">' +
          '<span class="changelog-summary__title">CHANGELOG 原文</span>' +
          '<span class="clog__source clog__source--' + src.cls + '"><i aria-hidden="true"></i>' + src.label + '</span>' +
          '<span class="patch-version__chev" aria-hidden="true"></span>' +
        '</summary>' +
        '<div class="changelog-source__bar">' +
          '<span class="changelog-source__note">' + esc(md.note || '项目根目录 CHANGELOG.md') + '</span>' +
          '<span class="changelog-source__tools">' +
            '<button type="button" class="btn btn--ghost btn--sm" data-act="changelog-refresh">刷新</button>' +
            '<button type="button" class="btn btn--ghost btn--sm" data-act="changelog-pick">选择本地文件</button>' +
          '</span>' +
        '</div>' +
        body +
      '</details>';
  }

  function patchSystemTabHTML() {
    var versions = systemUpdateVersions();
    var latest = versions[0] || { version: (G && G.VERSION) || '0.4.4', date: '', note: '', entries: [] };
    var groups = versions.map(function (v, i) {
      var open = i === 0;
      return '<details class="patch-version"' + (open ? ' open' : '') + '>' +
          patchVersionSummaryHTML(v.version, v.date, v.entries.length, open) +
          '<div class="patch-version__body">' +
            (i > 0 && v.note ? '<p class="patch-version__note">' + esc(v.note) + '</p>' : '') +
            '<div class="sys-grid">' + sysCategoriesHTML(v.entries, open) + '</div>' +
          '</div>' +
        '</details>';
    }).join('');
    return '' +
      '<div class="patch-hero">' +
        '<div class="patch-hero__id"><span class="patch-hero__tag">SYSTEM UPDATES</span>' +
          '<b class="patch-hero__ver">v' + esc(latest.version || '0.4.4') + '</b>' +
          '<span class="patch-hero__date">' + esc(latest.date || '') + '</span></div>' +
        (latest.note ? '<p class="patch-hero__note">' + esc(latest.note) + '</p>' : '') +
      '</div>' +
      groups +
      changelogPanelHTML();
  }

  function renderPatches() {
    var host = $('#screen-patches');
    if (!host) return;
    var tabs = $('#patch-tabs');
    if (tabs) {
      tabs.innerHTML = '<button type="button" class="tab-btn' + (U.patches.tab === 'system' ? ' is-on' : '') + '" data-act="patch-tab" data-tab="system" role="tab" aria-selected="' + (U.patches.tab === 'system' ? 'true' : 'false') + '">系统更新<em>SYSTEM</em></button>' +
        '<button type="button" class="tab-btn' + (U.patches.tab === 'data' ? ' is-on' : '') + '" data-act="patch-tab" data-tab="data" role="tab" aria-selected="' + (U.patches.tab === 'data' ? 'true' : 'false') + '">数据更新<em>DATA</em></button>';
    }
    var body = $('#patch-body');
    if (!body) return;
    body.innerHTML = U.patches.tab === 'data' ? patchDataTabHTML() : patchSystemTabHTML();
    var select = $('#patch-ball');
    if (select && !select.dataset.bound) {
      select.dataset.bound = '1';
      select.addEventListener('change', function () {
        U.patches.ball = select.value || '';
        renderPatches();
      });
    }
    requestFacePaint();
  }

  function buildPatches() {
    var host = $('#screen-patches');
    if (!host) return;
    host.innerHTML = '' +
      '<div class="page page--patches">' +
        pageHeadHTML({
          kicker: 'UPDATES',
          en: 'SYSTEM & DATA',
          titleHTML: '更新<span class="title-mark">.</span>',
          subHTML: '系统更新与数据调整记录。'
        }) +
        '<div class="tabs tabs--patches" id="patch-tabs" role="tablist" aria-label="更新日志分类"></div>' +
        '<div class="patch-body" id="patch-body"></div>' +
      '</div>';
    renderPatches();
  }

  /* ================= 战斗页 ================= */
  function buildBattle() {
    var host = $('#screen-battle');
    host.setAttribute('tabindex', '-1');
    host.innerHTML = '' +
      '<div class="battle">' +
        '<div class="battle__main">' +
          '<div class="arena-shell" id="arena-shell">' +
            '<span class="arena-shell__tag arena-shell__tag--l" aria-hidden="true">夜场 01 · NIGHT PIT</span>' +
            '<span class="arena-shell__tag arena-shell__tag--r" aria-hidden="true">FFA · NO MERCY</span>' +
            '<div class="arena-frame" id="arena-frame">' +
              '<canvas id="arena" aria-label="斗球场战场" role="img"></canvas>' +
              '<span class="arena-frame__fx" aria-hidden="true"></span>' +
              '<span class="arena-frame__corner arena-frame__corner--tl" aria-hidden="true"></span>' +
              '<span class="arena-frame__corner arena-frame__corner--tr" aria-hidden="true"></span>' +
              '<span class="arena-frame__corner arena-frame__corner--bl" aria-hidden="true"></span>' +
              '<span class="arena-frame__corner arena-frame__corner--br" aria-hidden="true"></span>' +
              '<div class="overlay overlay--countdown" id="overlay-countdown" hidden aria-live="polite">' +
                '<span class="countdown__stamp">' +
                  '<span class="countdown__num" id="countdown-num">3</span>' +
                  '<span class="countdown__label" id="countdown-label">准备</span>' +
                '</span>' +
              '</div>' +
              '<div class="overlay overlay--pause" id="overlay-pause" hidden>' +
                '<span class="pause__stamp">暂停</span>' +
                '<p class="pause__hint">按 <kbd>SPACE</kbd> 继续 · 或点下方按钮</p>' +
                '<button type="button" class="btn btn--primary" data-act="resume">继续开打</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<section class="hp-board" aria-label="血量监控">' +
            '<header class="panel-head">' +
              '<span class="panel-head__title">存活监控</span>' +
              '<span class="panel-head__en">LIVE</span>' +
              '<span class="alive-count" id="alive-count">0 / 0</span>' +
              '<span class="hp-hint">蓝条=能量 · 点击血条或球查看战斗档案</span>' +
              '<span class="storm-wrap">' +
                '<span class="storm__label" id="storm-label">速胜 60s</span>' +
                '<span class="storm__bar" aria-hidden="true"><i id="storm-fill"></i></span>' +
              '</span>' +
            '</header>' +
            '<div class="hp-grid" id="hp-grid"></div>' +
          '</section>' +
        '</div>' +
        '<aside class="battle__side">' +
          '<section class="panel feed">' +
            '<header class="panel-head">' +
              '<span class="panel-head__title">战况</span>' +
              '<span class="panel-head__en">FEED</span>' +
              '<span class="feed__live" aria-hidden="true"><i></i>LIVE</span>' +
            '</header>' +
            '<ul class="feed__list" id="feed-list" role="log" aria-label="战况记录" aria-live="off"></ul>' +
          '</section>' +
          '<section class="panel roster-mini" aria-label="参战阵容">' +
            '<header class="panel-head">' +
              '<span class="panel-head__title">参战</span>' +
              '<span class="panel-head__en">LINEUP</span>' +
            '</header>' +
            '<div class="roster-mini__list" id="roster-mini-list"></div>' +
          '</section>' +
          '<section class="battle-profile" id="battle-profile" aria-label="战斗档案" hidden></section>' +
        '</aside>' +
      '</div>';

    U.refs.arenaShell = $('#arena-shell');
    U.refs.arenaFrame = $('#arena-frame');
    U.refs.arena = $('#arena');
    U.refs.hpGrid = $('#hp-grid');
    U.refs.feedList = $('#feed-list');
    U.refs.aliveCount = $('#alive-count');
    U.refs.stormFill = $('#storm-fill');
    U.refs.stormLabel = $('#storm-label');
    U.refs.overlayPause = $('#overlay-pause');
    U.refs.overlayCountdown = $('#overlay-countdown');
    U.refs.countdownNum = $('#countdown-num');
    U.refs.countdownLabel = $('#countdown-label');
    U.refs.rosterMini = $('#roster-mini-list');
    U.refs.battleSide = $('.battle__side');
    U.refs.battleInfo = $('#battle-profile');

    if (root.ResizeObserver && U.refs.arenaShell) {
      try {
        U.ro = new ResizeObserver(function () { layoutArena(); });
        U.ro.observe(U.refs.arenaShell);
      } catch (e) { }
    }

    // 点击战场小球 → 战斗档案（与底部血条行一致）
    if (U.refs.arena) {
      U.refs.arena.addEventListener('click', onArenaClick);
    }
    layoutArena();
  }

  function arenaWorldFromEvent(ev) {
    var canvas = U.refs.arena || $('#arena');
    if (!canvas || !U.battle || !U.battle.snap) return null;
    var snap = U.battle.snap;
    var arena = snap.arena || {};
    var worldW = Number(arena.w) || 760;
    var worldH = Number(arena.h) || worldW;
    var rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    if (!rect || !rect.width || !rect.height) return null;
    var clientX = ev.clientX;
    var clientY = ev.clientY;
    var size = Math.min(rect.width, rect.height);
    var offX = (rect.width - size) / 2;
    var offY = (rect.height - size) / 2;
    var x = (clientX - rect.left - offX) / size * worldW;
    var y = (clientY - rect.top - offY) / size * worldH;
    if (x < 0 || y < 0 || x > worldW || y > worldH) return null;
    // 顶点朝上的三角形：粗略过滤外接框内的无效区域
    if (arena.shape === 'triangle' && arena.triangle && arena.triangle.vertices) {
      var v = arena.triangle.vertices;
      var d1 = (x - v[1].x) * (v[0].y - v[1].y) - (v[0].x - v[1].x) * (y - v[1].y);
      var d2 = (x - v[2].x) * (v[1].y - v[2].y) - (v[1].x - v[2].x) * (y - v[2].y);
      var d3 = (x - v[0].x) * (v[2].y - v[0].y) - (v[2].x - v[0].x) * (y - v[0].y);
      var hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      var hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (hasNeg && hasPos) return null;
    }
    return { x: x, y: y };
  }

  function onArenaClick(ev) {
    var pt = arenaWorldFromEvent(ev);
    if (!pt || !U.battle || !U.battle.snap) return;
    var ents = U.battle.snap.entities || [];
    var best = null, bestDist = Infinity;
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (!e) continue;
      var dx = pt.x - e.x;
      var dy = pt.y - e.y;
      var rr = Math.max(18, Number(e.r) || 20) + 8;
      var d = dx * dx + dy * dy;
      if (d <= rr * rr && d < bestDist) { bestDist = d; best = e; }
    }
    if (best && best.ballId) openBattleInfo(best.ballId, true);
  }

  function layoutArena() {
    var shell = U.refs.arenaShell;
    var frame = U.refs.arenaFrame;
    if (!shell || !frame || !U.refs.arenaFrame || U.screen === 'roster') return;
    if (shell.offsetParent === null) return;
    var rect = shell.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var cs = root.getComputedStyle ? root.getComputedStyle(shell) : null;
    var padX = cs ? parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) : 24;
    var padY = cs ? parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) : 24;
    var bdX = cs ? parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth) : 6;
    var bdY = cs ? parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) : 6;
    var innerW = rect.width - padX - bdX;
    var innerH = rect.height - padY - bdY;
    var size = Math.max(140, Math.floor(Math.min(innerW, innerH)));
    if (Math.abs(size - U.arenaSize) < 1) return;
    U.arenaSize = size;
    frame.style.width = size + 'px';
    frame.style.height = size + 'px';
    notifyRendererResize();
  }

  function notifyRendererResize() {
    if (U.resizeRaf) return;
    U.resizeRaf = root.requestAnimationFrame(function () {
      U.resizeRaf = 0;
      if (root.BallRenderer && typeof root.BallRenderer.resize === 'function') {
        try { root.BallRenderer.resize(); } catch (e) { }
      }
    });
  }

  function hpRowHTML(ball) {
    return '' +
      '<button type="button" class="hp-row" data-act="battle-info" data-ball="' + esc(ball.id) + '" ' +
        'aria-label="查看 ' + esc(ball.name) + ' 的战斗档案">' +
        '<span class="hp-dot" style="--c:' + esc(ball.color) + '"></span>' +
        '<span class="hp-ident"><span class="hp-name">' + esc(ball.name) + '</span></span>' +
        '<span class="hp-bars">' +
          '<span class="hp-bar"><i class="hp-bar__fill"></i><i class="hp-bar__shield"></i></span>' +
          '<span class="hp-energy"><i class="hp-energy__fill"></i></span>' +
        '</span>' +
        '<span class="hp-nums"><b class="hp-num">' + esc(ball.stats.hp) + '</b><em class="hp-enum">0 / 0</em></span>' +
        '<span class="hp-status"></span>' +
        '<span class="hp-info" aria-hidden="true">i</span>' +
      '</button>';
  }

  function showBattle(lineup, seed, meta) {
    var ids = Array.isArray(lineup) ? (function () {
      var seen = {}, out = [];
      lineup.forEach(function (raw) {
        var cid = canonicalId(raw);
        if (cid && !seen[cid]) { seen[cid] = 1; out.push(cid); }
      });
      return out;
    })() : [];
    if (ids.length < 2) ids = U.lineup.slice();
    meta = meta || {};
    if (meta.mode) U.mode = meta.mode === 'ranked' ? 'ranked' : 'basic';
    if (meta.map) U.map = mapById(meta.map).id;
    if (meta.mechanisms) U.mechanisms = sanitizeMechanisms(meta.mechanisms);
    else if (!U.mechanisms) U.mechanisms = defaultMechanisms();
    U.battleMeta = meta;
    var mode = currentMode();
    var map = currentMap();
    var ranked = U.mode === 'ranked';
    var matchLabel = meta.matchLabel || meta.label || (ranked ? '排位赛' : '大乱斗');
    closeModal();
    setScreen('battle');

    setMarquee('battle', '' +
      '<div class="timer" id="timer-box" role="timer" aria-label="比赛计时">' +
        '<span class="timer__label">时间</span>' +
        '<span class="timer__value" id="timer-value">00:00</span>' +
      '</div>' +
      '<div class="battle-meta">' +
        '<span class="battle-meta__badges">' + badgeModeHTML(mode) + badgeMapHTML(map) + mechBadgeHTML() + '</span>' +
        '<span class="battle-meta__line"><b>' + esc(matchLabel) + '</b> · ' + ids.length + ' 位 · <span id="battle-seed">SEED ' + hexSeed(seed) + '</span></span>' +
      '</div>' +
      '<div class="battle-controls">' +
        '<button type="button" class="btn btn--ctrl" data-act="pause" id="btn-pause" aria-pressed="false">' +
          '<span class="pause-bars" aria-hidden="true"><i></i><i></i></span><span class="btn__pause-label">暂停</span>' +
        '</button>' +
        '<div class="speed-group" role="group" aria-label="倍速">' +
          '<button type="button" class="speed-btn" data-act="speed" data-speed="0.5" aria-pressed="false" aria-label="零点五倍速">0.5×</button>' +
          '<button type="button" class="speed-btn" data-act="speed" data-speed="1" aria-pressed="true" aria-label="一倍速">1×</button>' +
          '<button type="button" class="speed-btn" data-act="speed" data-speed="2" aria-pressed="false" aria-label="二倍速">2×</button>' +
        '</div>' +
        '<button type="button" class="btn btn--ctrl btn--danger" data-act="exit">' + (ranked ? '退出本场' : '退场') + '</button>' +
      '</div>');
    setConsoleHint(ranked ? HINTS.battleRanked : HINTS.battle);

    // 血条行
    U.refs.hpGrid.classList.toggle('hp-grid--duel', ids.length === 2);
    U.refs.hpGrid.innerHTML = ids.map(function (id) { return hpRowHTML(ballById(id)); }).join('');
    var rows = {};
    $all('.hp-row', U.refs.hpGrid).forEach(function (row) {
      rows[row.dataset.ball] = {
        el: row,
        num: $('.hp-num', row),
        enum: $('.hp-enum', row),
        fill: $('.hp-bar__fill', row),
        shield: $('.hp-bar__shield', row),
        energy: $('.hp-energy__fill', row),
        energyEl: $('.hp-energy', row),
        bar: $('.hp-bar', row),
        status: $('.hp-status', row),
        hp: null,
        hpPct: 0,
        shieldPct: 0,
        energyPct: -1,
        energyText: '',
        alive: true,
        statusKey: '',
        low: false
      };
    });

    // 参战名单（点击也能看详情）
    U.refs.rosterMini.innerHTML = ids.map(function (id) {
      var b = ballById(id);
      return '<button type="button" class="roster-mini__item" data-act="battle-info" data-ball="' + esc(id) + '">' +
        '<i style="--c:' + esc(b.color) + '" aria-hidden="true"></i><span>' + esc(b.name) + '</span></button>';
    }).join('');

    // 战况 feed 初始化
    U.refs.feedList.innerHTML = '';
    addFeed([{ text: '夜场亮灯 · ' + ids.length + ' 位斗士入场', tone: 'info', color: '#FFC24B' }]);
    U.refs.feedList.scrollTop = 0;

    U.battle = {
      ids: ids,
      rows: rows,
      total: ids.length,
      lastTime: -1,
      lastAlive: -1,
      lastStorm: -1,
      lastSudden: null,
      timer: $('#timer-value'),
      timerBox: $('#timer-box'),
      seed: seed
    };
    U.refs.aliveCount.textContent = ids.length + ' / ' + ids.length;
    U.refs.aliveCount.classList.remove('is-danger');
    U.refs.stormFill.style.transform = 'scaleX(0)';
    U.refs.stormLabel.textContent = stormLabelText(false);
    U.refs.stormLabel.classList.remove('is-storm');
    U.refs.stormLabel.classList.toggle('is-off', !mechOn('suddenDeath'));
    U.refs.arenaShell.classList.remove('is-storm');
    if (U.refs.timerBox) U.refs.timerBox.classList.remove('is-storm');

    U.paused = false;
    U.countdown = null;
    closeBattleInfo();
    setBattleProfileOpen(false);
    U.speed = 1;               // v1.2：每场开始强制 1×（不记忆上一场）
    setPaused(false);
    setCountdown(null);
    setSpeed(1);
    setMuted(U.muted);
    layoutArena();
    // 等首帧布局完成后再算一次（柜头字体可能稍后替换）
    root.requestAnimationFrame(layoutArena);
    try { $('#screen-battle').focus({ preventScroll: true }); } catch (e) { }
  }

  /* ---------- 战斗底部：完整属性 / 技能面板（hover 或 点击 pin，Esc 关闭） ---------- */
  function battleCurrentEntity(ballId) {
    var snap = U.battle && U.battle.snap;
    if (!snap) return null;
    var list = snap.entities || [];
    for (var i = 0; i < list.length; i++) if (list[i].ballId === ballId) return list[i];
    return null;
  }

  function statusDetailHTML(entity) {
    var arr = (entity && entity.statuses) || [];
    if (!arr.length) return '<span class="bi-status__none">无状态</span>';
    return arr.map(function (s) {
      var kind = statusKindOf(s);
      var extra = [];
      if (s.stacks && s.stacks > 1) extra.push('×' + s.stacks);
      if (s.remaining != null && isFinite(Number(s.remaining))) extra.push(Number(s.remaining).toFixed(1) + 's');
      return '<span class="bi-status" data-kind="' + esc(kind) + '">' + esc(statusName(kind)) +
        (extra.length ? '<em>' + esc(extra.join(' · ')) + '</em>' : '') + '</span>';
    }).join('');
  }

  function battleSummonCounts(ballId) {
    var out = {};
    var e = battleCurrentEntity(ballId);
    var snap = U.battle && U.battle.snap;
    if (!e || !snap) return out;
    var ownerId = e.id;
    var mines = 0, armed = 0;
    (snap.hazards || []).forEach(function (h) {
      if (h && h.kind === 'mine' && h.ownerId === ownerId) {
        mines += 1;
        if (h.armed) armed += 1;
      }
    });
    if (mines) out.mine = '场上 ' + mines + ' 颗' + (armed ? ' · 待发 ' + armed : '');
    var beeDef = summonById('bee');
    if (beeDef) {
      var bees = 0, frenzy = 0;
      (snap.bees || []).forEach(function (b) {
        if (b && b.ownerId === ownerId) {
          bees += 1;
          if (b.frenzy) frenzy += 1;
        }
      });
      var maxBees = Number(beeDef.max) || 3;
      out.bee = '场上 ' + bees + ' / ' + maxBees + ' 只 · 普通 ' + (bees - frenzy) + ' · 狂暴 ' + frenzy;
    }
    return out;
  }

  function battleProfileHTML(ballId) {
    var ball = ballById(ballId);
    if (!ball) return '';
    var e = battleCurrentEntity(ballId);
    var skills = (ball.skills || []).map(skillById).filter(Boolean);
    var phaseSkill = skills.filter(function (sk) { return sk.id === 'phase'; })[0];
    var phaseP = (phaseSkill && phaseSkill.params) || {};
    var atkBonus = e && isFinite(Number(e.atkBonus)) ? Math.round(Number(e.atkBonus)) : 0;
    var stats = STAT_DEFS.map(function (d) {
      var base = ball.stats[d.key];
      var cur = '';
      var bonus = '';
      if (e && d.key === 'hp') cur = '<i class="bi-stat__cur">' + Math.max(0, Math.ceil(e.hp)) + ' / ' + Math.round(e.maxHp || base) + '</i>';
      if (phaseSkill && d.key === 'atk') bonus = '<i class="bi-stat__bonus">(' + (atkBonus >= 0 ? '+' : '') + atkBonus + ')</i>';
      return '<span class="bi-stat"><b>' + d.label + '</b>' +
        '<span class="bi-stat__val"><em>' + esc(base) + '</em>' + bonus + '</span>' + cur + '</span>';
    }).join('');
    var hpPct = e ? clamp(Number(e.hpPct) || 0, 0, 1) : 1;
    var shield = e && e.shield ? Math.round(e.shield) : 0;
    var energyPct = energyPctOf(e);
    var summonPanel = summonsPanelHTML(ball, { counts: battleSummonCounts(ballId) });
    var fstate = 'calm';
    if (e && !e.alive) fstate = 'dead';
    else if (e && Number(e.hpPct) < 0.3) fstate = 'low';
    var eFull = energyPct >= 0.999;
    return '' +
      '<div class="bp-kicker">战斗档案 <em>PROFILE</em></div>' +
      '<div class="bp-head">' +
        '<span class="battle-info__orb" style="' + orbStyle(ball) + '">' + orbHTML(ball, 'orb--info', { state: fstate }) + '</span>' +
        '<span class="battle-info__ident">' +
          '<b class="battle-info__name">' + esc(ball.name) + '</b>' +
          '<span class="battle-info__en">' + esc(ball.en) + '</span>' +
          '<span class="battle-info__tags">' + tagsHTML(ball) + '</span>' +
        '</span>' +
        '<button type="button" class="bp-close" data-act="battle-info-close" aria-label="关闭战斗档案">×</button>' +
      '</div>' +
      '<div class="bp-vitals">' +
        '<span class="bp-hp">生命值 <b>' + (e ? Math.max(0, Math.ceil(e.hp)) : '?') + '</b><em>/ ' + Math.round((e && e.maxHp) || ball.stats.hp) + '</em>' +
          (shield > 0 ? '<i>护盾 ' + shield + '</i>' : '') + '</span>' +
        '<span class="bp-energy' + (eFull ? ' is-full' : '') + '">能量 <b>' + energyText(e) + '</b>' +
          '<span class="bp-energy__bar" aria-hidden="true"><i style="width:' + (energyPct * 100).toFixed(1) + '%"></i></span></span>' +
      '</div>' +
      '<div class="battle-info__hpbar" aria-hidden="true"><i style="width:' + (hpPct * 100).toFixed(2) + '%"></i></div>' +
      '<div class="battle-info__stats">' + stats + '</div>' +
      (phaseSkill ? '<p class="bp-atk-note">攻击力来源：穿墙 +' + esc(phaseP.atkPerWall != null ? phaseP.atkPerWall : 1) +
        ' / 碰撞 ' + esc(phaseP.atkPerCollision != null ? phaseP.atkPerCollision : -1) +
        ' · 范围 ' + esc(phaseP.atkBonusMin != null ? phaseP.atkBonusMin : -10) + ' ~ +' + esc(phaseP.atkBonusMax != null ? phaseP.atkBonusMax : 20) + '</p>' : '') +
      '<div class="bp-status"><span class="battle-info__sub">状态</span>' + statusDetailHTML(e) + '</div>' +
      '<div class="combat-grid' + (summonPanel ? '' : ' combat-grid--solo') + '">' +
        '<div class="combat-skills">' + skills.map(skillBlockHTML).join('') + '</div>' +
        (summonPanel ? '<div class="combat-summons">' + summonPanel + '</div>' : '') +
      '</div>';
  }

  function setBattleProfileOpen(open) {
    var host = U.refs.battleInfo || $('#battle-profile');
    var side = U.refs.battleSide || $('.battle__side');
    if (host) {
      host.hidden = !open;
      if (!open) host.innerHTML = '';
    }
    if (side) side.classList.toggle('has-profile', !!open);
  }

  function openBattleInfo(ballId, pinned) {
    var host = U.refs.battleInfo || $('#battle-profile');
    if (!host || !ballById(ballId)) return;
    if (U.battleInfo.ballId === ballId) { closeBattleInfo(); return; }
    U.battleInfo.ballId = ballId;
    U.battleInfo.pinned = true;
    setBattleProfileOpen(true);
    host.innerHTML = battleProfileHTML(ballId);
    if (U.refs.hpGrid) {
      $all('.hp-row', U.refs.hpGrid).forEach(function (row) {
        row.classList.toggle('is-info', row.dataset.ball === ballId);
      });
    }
    requestFacePaint();
  }

  function refreshBattleInfo() {
    var host = U.refs.battleInfo || $('#battle-profile');
    if (!host || !U.battleInfo.ballId || host.hidden) return;
    var scrollTop = host.scrollTop;
    host.innerHTML = battleProfileHTML(U.battleInfo.ballId);
    host.scrollTop = scrollTop;
    requestFacePaint();
  }

  function closeBattleInfo() {
    var host = U.refs.battleInfo || $('#battle-profile');
    U.battleInfo.ballId = null;
    U.battleInfo.pinned = false;
    setBattleProfileOpen(false);
    if (U.refs.hpGrid) {
      $all('.hp-row', U.refs.hpGrid).forEach(function (row) { row.classList.remove('is-info'); });
    }
  }

  function statusKeyOf(statuses) {
    if (!statuses || !statuses.length) return '';
    var parts = [];
    for (var i = 0; i < statuses.length; i++) {
      parts.push(statusKindOf(statuses[i]) + ':' + (statuses[i].stacks || 0));
    }
    return parts.join('|');
  }

  /* v1.2：战场状态只显示效果名字（减速 / 灼烧…），不显示数值、时间、单字方框 */
  function renderStatuses(row, entity) {
    var list = row.status;
    if (!list) return;
    var key = entity.alive ? statusKeyOf(entity.statuses) : 'dead';
    if (key === row.statusKey) return;
    row.statusKey = key;
    if (!entity.alive) {
      list.innerHTML = '<span class="st st--out">OUT</span>';
      return;
    }
    var arr = entity.statuses || [];
    var html = '';
    for (var i = 0; i < arr.length && i < 3; i++) {
      var kind = statusKindOf(arr[i]);
      if (!kind) continue;
      var cls = String(kind).replace(/[^a-zA-Z0-9_-]/g, '');
      html += '<span class="st st--' + cls + '">' + esc(statusName(kind)) + '</span>';
    }
    list.innerHTML = html;
  }

  function updateBattle(snapshot, state) {
    if (!snapshot || !U.battle) return;
    var b = U.battle;
    b.snap = snapshot;

    // 计时
    var t = Math.max(0, Math.floor(snapshot.time || 0));
    if (t !== b.lastTime) {
      b.lastTime = t;
      if (b.timer) b.timer.textContent = fmtTime(t);
    }

    // 决胜
    var storm = clamp(Number(snapshot.stormLevel) || 0, 0, 1);
    if (Math.abs(storm - b.lastStorm) > 0.015) {
      b.lastStorm = storm;
      U.refs.stormFill.style.transform = 'scaleX(' + storm.toFixed(3) + ')';
    }
    var suddenStart = suddenStartForBattle();
    var sudden = snapshot.suddenDeath;
    if (sudden !== b.lastSudden) {
      b.lastSudden = sudden;
      if (U.refs.timerBox) U.refs.timerBox.classList.toggle('is-storm', sudden);
      U.refs.arenaShell.classList.toggle('is-storm', sudden);
      U.refs.stormLabel.classList.toggle('is-storm', sudden);
      U.refs.stormLabel.classList.toggle('is-off', !mechOn('suddenDeath'));
      U.refs.stormLabel.textContent = stormLabelText(sudden);
    }

    // 各球血量
    var entities = snapshot.entities || [];
    var alive = 0;
    for (var i = 0; i < entities.length; i++) {
      var e = entities[i];
      var row = b.rows[e.ballId];
      if (!row) continue;
      if (e.alive) alive++;

      if (e.alive !== row.alive) {
        row.alive = e.alive;
        row.el.classList.toggle('is-dead', !e.alive);
        var mini = $('.roster-mini__item[data-ball="' + e.ballId + '"]', U.refs.rosterMini);
        if (mini) mini.classList.toggle('is-dead', !e.alive);
      }

      var hp = Math.max(0, Math.ceil(e.hp));
      if (hp !== row.hp) {
        row.hp = hp;
        row.num.textContent = hp;
        var statusText = (e.statuses || []).map(function (s) { return statusName(statusKindOf(s)); }).join('、');
        row.el.setAttribute('aria-label', e.name + ' 生命 ' + hp + ' / ' + e.maxHp +
          ' 能量 ' + energyText(e) + (statusText ? '，状态：' + statusText : '') + (e.alive ? '' : '，已出局'));
      }
      var hpPct = clamp(Number(e.hpPct) || 0, 0, 1);
      if (Math.abs(hpPct - row.hpPct) > 0.001) {
        row.hpPct = hpPct;
        row.fill.style.transform = 'scaleX(' + hpPct.toFixed(4) + ')';
      }
      // v0.4 能量条：蓝色，满能量/接近满有状态
      var ePct = energyPctOf(e);
      if (Math.abs(ePct - row.energyPct) > 0.002 || row.energyPct < 0) {
        row.energyPct = ePct;
        if (row.energy) row.energy.style.transform = 'scaleX(' + ePct.toFixed(4) + ')';
        if (row.energyEl) {
          row.energyEl.classList.toggle('is-full', ePct >= 0.999);
          row.energyEl.classList.toggle('is-near', ePct >= 0.75 && ePct < 0.999);
        }
        row.el.classList.toggle('is-energy-full', ePct >= 0.999);
      }
      var eTxt = energyText(e);
      if (eTxt !== row.energyText) {
        row.energyText = eTxt;
        if (row.enum) row.enum.textContent = eTxt;
      }
      var shPct = clamp(Number(e.shieldPct) || 0, 0, 1);
      if (Math.abs(shPct - row.shieldPct) > 0.001) {
        row.shieldPct = shPct;
        row.shield.style.transform = 'scaleX(' + shPct.toFixed(4) + ')';
        row.shield.style.opacity = shPct > 0 ? '0.85' : '0';
      }
      var low = e.alive && hpPct < 0.3;
      if (low !== row.low) {
        row.low = low;
        row.bar.classList.toggle('is-low', low);
        row.el.classList.toggle('is-low', low);
      }
      renderStatuses(row, e);
    }
    if (alive !== b.lastAlive) {
      b.lastAlive = alive;
      U.refs.aliveCount.textContent = alive + ' / ' + b.total;
      U.refs.aliveCount.classList.toggle('is-danger', alive <= 2);
    }

    // 战斗详情面板打开时低频刷新（属性 / 护盾 / 当前状态名字）
    if (U.battleInfo.ballId) {
      var nowMs = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
      if (!b.infoPaint || nowMs - b.infoPaint > 180) {
        b.infoPaint = nowMs;
        refreshBattleInfo();
      }
    }

    // 与主循环状态同步（防御性，正常由 setXxx 调用处理）
    if (state) {
      if (!!state.paused !== U.paused) setPaused(!!state.paused);
      if (state.speed && state.speed !== U.speed) setSpeed(state.speed);
      if (typeof state.muted === 'boolean' && state.muted !== U.muted) setMuted(state.muted);
      var cd = state.countdown || null;
      if (cd !== U.countdown) setCountdown(cd);
    }
  }

  function addFeed(entries) {
    var list = U.refs.feedList;
    if (!list || !entries || !entries.length) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e) continue;
      var li = document.createElement('li');
      li.className = 'feed__item feed__item--' + (e.tone || 'info');
      li.style.setProperty('--feed-color', e.color || 'var(--line)');
      li.textContent = e.text == null ? '' : String(e.text);
      frag.insertBefore(li, frag.firstChild);
    }
    list.insertBefore(frag, list.firstChild);
    while (list.children.length > MAX_FEED) list.removeChild(list.lastChild);
    list.scrollTop = 0;
  }

  function setPaused(paused) {
    paused = !!paused;
    U.paused = paused;
    if (U.refs.overlayPause) U.refs.overlayPause.hidden = !paused;
    var btn = $('#btn-pause');
    if (btn) {
      btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
      btn.classList.toggle('is-paused', paused);
      var label = $('.btn__pause-label', btn);
      if (label) label.textContent = paused ? '继续' : '暂停';
    }
  }

  function setSpeed(speed) {
    var n = Number(speed);
    if (SPEEDS.indexOf(n) < 0) n = n >= 2 ? 2 : (n > 0 && n <= 0.5 ? 0.5 : 1);
    U.speed = n;
    $all('[data-act="speed"]').forEach(function (btn) {
      var on = Number(btn.dataset.speed) === n;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('is-on', on);
    });
  }

  function setMuted(muted) {
    muted = !!muted;
    U.muted = muted;
    U.settings.muted = muted;
    if (U.screen === 'settings') renderSettings();
  }

  function setCountdown(text) {
    U.countdown = text || null;
    var overlay = U.refs.overlayCountdown;
    var num = U.refs.countdownNum;
    var label = U.refs.countdownLabel;
    if (!overlay) return;
    if (!text) {
      overlay.hidden = true;
      U.lastCountdown = null;
      return;
    }
    overlay.hidden = false;
    if (text !== U.lastCountdown) {
      var go = text === '开打';
      num.textContent = text;
      num.classList.toggle('is-go', go);
      if (label) label.textContent = go ? 'FIGHT' : '准备';
      // 重启动画
      num.style.animation = 'none';
      void num.offsetWidth;
      num.style.animation = '';
      U.lastCountdown = text;
    }
  }

  /* ================= 排位赛赛程（v1.1） ================= */
  var ROUND_ORDER = { qf: 0, sf: 1, bronze: 2, final: 3 };
  var ROUND_SHORT = { qf: '八强', sf: '半决赛', bronze: '季军赛', final: '决赛' };

  function fighterInfo(f) {
    if (!f) return null;
    var ball = f.ballId ? ballById(f.ballId) : null;
    return {
      ballId: f.ballId,
      name: f.name || (ball && ball.name) || '待定',
      en: f.en || (ball && ball.en) || '',
      color: f.color || (ball && ball.color) || '#4A405D',
      color2: f.color2 || (ball && ball.color2) || '#6E6088',
      archetype: ''
    };
  }

  function matchFighterHTML(f, isWinner, isLoser) {
    var info = fighterInfo(f);
    if (!info) {
      return '<span class="mfighter is-tbd"><span class="mfighter__dot is-tbd" aria-hidden="true"></span>' +
        '<span class="mfighter__name">待定</span><span class="mfighter__en">TBD</span></span>';
    }
    return '<span class="mfighter' + (isWinner ? ' is-winner' : '') + (isLoser ? ' is-loser' : '') + '">' +
      '<span class="mfighter__dot" style="--c:' + esc(info.color) + ';--c2:' + esc(info.color2) + ';--cd:' + mixColor(info.color, 0.55) + '" aria-hidden="true"></span>' +
      '<span class="mfighter__name">' + esc(info.name) + '</span>' +
      '<span class="mfighter__en">' + esc(info.en) + '</span>' +
      (isWinner ? '<span class="mfighter__tag mfighter__tag--win">胜</span>' : '') +
      (isLoser ? '<span class="mfighter__tag mfighter__tag--lose">负</span>' : '') +
    '</span>';
  }

  // tournament.js 的历史 score.dealt 结构是 {a,b}；新结构补充 ballId 键。
  // 优先按 ballId 取，回退到 a/b 槽位键。
  function duelScoreValue(dealt, ballId, sideKey) {
    if (!dealt || typeof dealt !== 'object') return null;
    if (ballId != null && dealt[ballId] != null && isFinite(Number(dealt[ballId]))) return Number(dealt[ballId]);
    if (sideKey && dealt[sideKey] != null && isFinite(Number(dealt[sideKey]))) return Number(dealt[sideKey]);
    return null;
  }

  function matchScoreHTML(m) {
    if (!m.score) return '';
    var a = m.a ? m.a.ballId : null;
    var b = m.b ? m.b.ballId : null;
    var sc = m.score;
    var dealtA = duelScoreValue(sc.dealt, a, 'a');
    var dealtB = duelScoreValue(sc.dealt, b, 'b');
    var out = '<span class="match__score"><b>输出</b><em>' +
      (dealtA != null ? Math.round(dealtA) : '—') + ' : ' + (dealtB != null ? Math.round(dealtB) : '—') + '</em></span>';
    if (sc.duration != null) {
      out += '<span class="match__time"><b>用时</b><em>' + fmtDuration(sc.duration) + '</em></span>';
    }
    return out;
  }

  function matchCardHTML(m) {
    var a = m.a || null;
    var b = m.b || null;
    var winnerIsA = m.status === 'done' && a && m.winnerId === a.ballId;
    var winnerIsB = m.status === 'done' && b && m.winnerId === b.ballId;
    var loserIsA = m.status === 'done' && a && m.loserId === a.ballId;
    var loserIsB = m.status === 'done' && b && m.loserId === b.ballId;
    var statusText = m.status === 'ready' ? '可开打' : (m.status === 'done' ? '已结束' : '待定');
    var foot = '';
    if (m.status === 'ready') {
      foot = '<button type="button" class="btn btn--primary btn--sm match__enter" data-act="match" data-match="' + esc(m.id) + '">' +
        '进入赛事 <span aria-hidden="true">▶</span></button>';
    } else if (m.status === 'done') {
      foot = matchScoreHTML(m) || '<span class="match__wait">已完成</span>';
    } else {
      foot = '<span class="match__wait">等待上一轮结果</span>';
    }
    return '' +
      '<article class="match match--' + esc(m.status || 'locked') + '" data-match="' + esc(m.id) + '">' +
        '<header class="match__head">' +
          '<span class="match__idx">' + pad2(m.index || 0) + '</span>' +
          '<span class="match__label">' + esc(m.label || (m.roundName || '')) + '</span>' +
          '<span class="match__status">' + statusText + '</span>' +
        '</header>' +
        '<div class="match__body">' +
          matchFighterHTML(a, winnerIsA, loserIsA) +
          '<span class="match__vs" aria-hidden="true">VS</span>' +
          matchFighterHTML(b, winnerIsB, loserIsB) +
        '</div>' +
        '<div class="match__foot">' + foot + '</div>' +
      '</article>';
  }

  function bracketHTML(view) {
    var rounds = Array.isArray(view.rounds) ? view.rounds : [];
    var cols = rounds.map(function (round, idx) {
      var cards = (round.matches || []).map(matchCardHTML).join('');
      return '' +
        '<div class="bracket__col bracket__col--' + esc(round.id || idx) + '" data-round="' + esc(round.id || '') + '">' +
          '<header class="bracket__head">' +
            '<span class="bracket__idx">' + pad2(idx + 1) + '</span>' +
            '<span class="bracket__name">' + esc(round.name || '') + '</span>' +
            '<span class="bracket__en">' + esc(round.en || '') + '</span>' +
            '<em class="bracket__count">' + (round.matches ? round.matches.length : 0) + ' 场</em>' +
          '</header>' +
          '<div class="bracket__matches">' + cards + '</div>' +
        '</div>';
    }).join('');
    return '<div class="bracket">' + cols + '</div>';
  }

  function podiumStepHTML(row, place, cls) {
    if (!row) {
      return '<div class="podium__step podium__step--' + place + ' ' + (cls || '') + ' is-empty">' +
        '<span class="podium__place">' + pad2(place) + '</span><span class="podium__name">待定</span></div>';
    }
    var rowBall = ballById(row.ballId);
    return '<div class="podium__step podium__step--' + place + ' ' + (cls || '') + '">' +
      '<span class="podium__place">' + pad2(place) + '</span>' +
      (rowBall ? '<span class="podium__orb">' + orbHTML(rowBall, 'orb--podium', { state: place === 1 ? 'victory' : 'dead' }) + '</span>'
        : '<span class="podium__orb" style="--c:' + esc(row.color) + ';--c2:' + esc(row.color2) + ';--cd:' + mixColor(row.color || '#FF6B1A', 0.55) + '" aria-hidden="true"></span>') +
      '<span class="podium__name">' + esc(row.name || '') + '</span>' +
      '<span class="podium__note">' + esc(row.note || '') + '</span>' +
    '</div>';
  }

  function pathMatchRows(view) {
    var rounds = Array.isArray(view.rounds) ? view.rounds : [];
    var rows = [];
    ['sf', 'bronze', 'final'].forEach(function (rid) {
      var round = rounds.filter(function (r) { return r.id === rid; })[0];
      if (!round) return;
      (round.matches || []).forEach(function (m) {
        if (m.status === 'done' && m.a && m.b) rows.push(m);
      });
    });
    return rows;
  }

  function championPathHTML(view) {
    var rows = pathMatchRows(view);
    if (!rows.length) return '';
    return '<div class="champion__path">' +
      '<div class="champion__rank-head"><span class="champion__rank-title">决胜之路</span><span class="panel-head__en">KNOCKOUT PATH</span></div>' +
      '<ul class="path-list">' + rows.map(function (m) {
        var a = fighterInfo(m.a) || {};
        var b = fighterInfo(m.b) || {};
        var win = m.winnerId === a.ballId ? a : b;
        var lose = m.winnerId === a.ballId ? b : a;
        var sc = m.score || {};
        var dealtA = duelScoreValue(sc.dealt, a.ballId, 'a');
        var dealtB = duelScoreValue(sc.dealt, b.ballId, 'b');
        var score = (dealtA != null && dealtB != null) ? Math.round(dealtA) + ' : ' + Math.round(dealtB) : (sc.duration != null ? fmtDuration(sc.duration) : '—');
        return '<li>' +
          '<span class="path__round">' + esc(m.roundName || '') + '</span>' +
          '<span class="path__win">' + esc((win && win.name) || '') + '</span>' +
          '<span class="path__arrow" aria-hidden="true">胜</span>' +
          '<span class="path__lose">' + esc((lose && lose.name) || '') + '</span>' +
          '<span class="path__score">' + esc(score) + '</span>' +
        '</li>';
      }).join('') + '</ul>' +
    '</div>';
  }

  function championHTML(view, meta) {
    var rankings = Array.isArray(view.rankings) ? view.rankings : [];
    var champ = fighterInfo(view.champion) || fighterInfo(rankings[0]) || null;
    var champBall = champ ? ballById(champ.ballId) : null;
    var map = mapById(view.map || U.map);
    var rows = rankings.map(function (r) {
      var place = r.place || 0;
      var ball = fighterInfo(r) || {};
      var rowBall = ballById(ball.ballId);
      return '<tr class="rank-row rank-row--' + place + (place === 1 ? ' is-champion' : '') + '">' +
        '<td class="rank">' + pad2(place) + '</td>' +
        '<td class="fighter">' +
          '<span class="fighter__wrap">' +
            (rowBall ? orbHTML(rowBall, 'orb--mini', { state: place === 1 ? 'victory' : 'dead' })
              : '<span class="fighter__dot" style="--c:' + esc(ball.color) + ';--c2:' + esc(ball.color2) + ';--cd:' + mixColor(ball.color || '#FF6B1A', 0.55) + '" aria-hidden="true"></span>') +
            '<span class="fighter__name">' + esc(ball.name || '') + '</span>' +
            '<span class="fighter__en">' + esc(ball.en || '') + '</span>' +
          '</span>' +
        '</td>' +
        '<td class="record">' + (r.wins != null ? r.wins + ' 胜 ' + r.losses + ' 负' : '—') + '</td>' +
        '<td class="num num--primary">' + Math.round(r.dealt || 0) + '</td>' +
        '<td class="num">' + Math.round(r.heal || 0) + '</td>' +
        '<td class="note">' + esc(r.note || '') + '</td>' +
      '</tr>';
    }).join('');
    return '' +
      '<div class="champion">' +
        '<div class="champion__grid">' +
          '<div class="champion__hero">' +
            '<span class="champion__kicker">CHAMPION · 冠军<span class="k-en">TOURNAMENT COMPLETE</span></span>' +
            '<div class="champion__stage">' +
              '<span class="champion__crown">WINNER</span>' +
              (champBall ? orbHTML(champBall, 'orb--champion', { state: 'victory' }) : '<span class="orb orb--champion orb--draw" aria-hidden="true"></span>') +
              '<h2 class="champion__title" id="tour-title" tabindex="-1">冠军' +
                '<span class="champion__name">' + esc(champ ? champ.name : '无人') + '</span>' +
                '<span class="champion__en">' + esc(champ ? champ.en : '') + '</span>' +
              '</h2>' +
              '<p class="champion__meta">8 位斗士 · ' + esc(map.name) + ' · 共 ' + (view.totalMatches || 8) + ' 场</p>' +
            '</div>' +
            '<div class="podium">' +
              podiumStepHTML(rankings[1], 2, 'podium__step--left') +
              podiumStepHTML(rankings[0], 1, 'podium__step--center') +
              podiumStepHTML(rankings[2], 3, 'podium__step--right') +
            '</div>' +
          '</div>' +
          '<div class="champion__body">' +
            '<div class="champion__rank-head"><span class="champion__rank-title">最终排名</span><span class="panel-head__en">FINAL RANKINGS 1–8</span></div>' +
            '<table class="standings standings--ranked">' +
              '<caption class="sr-only">排位赛最终排名：名次、斗士、战绩、输出、治疗量、备注</caption>' +
              '<thead><tr><th scope="col">名次</th><th scope="col">斗士</th><th scope="col">战绩</th><th scope="col" class="th-num">输出</th><th scope="col" class="th-num">治疗量</th><th scope="col">备注</th></tr></thead>' +
              '<tbody>' + rows + '</tbody>' +
            '</table>' +
            championPathHTML(view) +
          '</div>' +
        '</div>' +
        '<div class="champion__actions">' +
          '<button type="button" class="btn btn--primary" data-act="play-again">再来一届（同 8 球）</button>' +
          '<button type="button" class="btn btn--ghost" data-act="newlineup">重新选球</button>' +
          '<button type="button" class="btn btn--ghost" data-act="go-home">返回大厅</button>' +
        '</div>' +
      '</div>';
  }

  function renderTournament() {
    var host = $('#screen-tournament');
    if (!host) return;
    var view = U.tournament || {};
    var meta = U.tournamentMeta || {};
    var map = mapById(view.map || meta.map || U.map);
    var total = view.totalMatches || 8;
    var done = view.done || 0;
    var complete = !!view.complete;
    var segs = '';
    for (var i = 0; i < total; i++) {
      segs += '<i class="' + (i < done ? 'is-on' : '') + '" aria-hidden="true"></i>';
    }
    var nowRound = complete ? '已结束' : (view.currentRoundName || '—');
    var head = '' +
      '<div class="tour__head">' +
        '<div class="tour__title">' +
          '<span class="tour__kicker">TOURNAMENT · 排位赛<span class="k-en">SINGLE ELIMINATION</span></span>' +
          '<h1 id="tour-title" tabindex="-1">' + (complete ? '最终战报' : '赛程总览') + '<span class="title-mark">.</span></h1>' +
          '<p class="tour__sub">8 位斗士单败淘汰 · <b>' + esc(map.name) + '</b> · ' + esc(mechName('suddenDeath')) + ' ' + (mechOn('suddenDeath') ? '开' : '关') + ' · SEED ' + hexSeed(meta.seed != null ? meta.seed : view.seed) + ' · 每场 1v1</p>' +
        '</div>' +
        '<div class="tour__progress">' +
          '<div class="tour__count"><span>已完成</span><b>' + done + '</b><em>/ ' + total + '</em></div>' +
          '<div class="tour__bar" role="progressbar" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + done + '" aria-label="赛程进度">' + segs + '</div>' +
          '<div class="tour__now"><span>当前轮次</span><b>' + esc(nowRound) + '</b>' +
            (view.nextMatchId && !complete ? '<em>下一场：' + esc(shortMatchLabel(view)) + '</em>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    host.innerHTML = '<div class="tournament' + (complete ? ' tournament--complete' : '') + '">' +
      head + '<div class="tour__body">' + (complete ? championHTML(view, meta) : bracketHTML(view)) + '</div>' +
      '</div>';
    var title = $('#tour-title');
    if (title) { try { title.focus({ preventScroll: true }); } catch (e) { } }
    requestFacePaint();
  }

  function shortMatchLabel(view) {
    if (!view || !view.nextMatchId) return '';
    var rounds = view.rounds || [];
    for (var i = 0; i < rounds.length; i++) {
      var ms = rounds[i].matches || [];
      for (var j = 0; j < ms.length; j++) {
        if (ms[j].id === view.nextMatchId) return ms[j].label || view.nextMatchId;
      }
    }
    return view.nextMatchId;
  }

  function showTournament(view, meta) {
    view = view || {};
    meta = meta || {};
    U.tournament = view;
    U.tournamentMeta = meta;
    U.mode = 'ranked';
    if (view.map || meta.map) U.map = mapById(view.map || meta.map).id;
    if (meta.mechanisms) U.mechanisms = sanitizeMechanisms(meta.mechanisms);
    else if (!U.mechanisms) U.mechanisms = defaultMechanisms();
    closeModal();
    setScreen('tournament');
    var map = currentMap();
    var seedVal = meta.seed != null ? meta.seed : view.seed;
    setMarquee('tournament', '' +
      '<span class="mode-chip mode-chip--violet">排位赛 <em class="chip-en">RANKED</em></span>' +
      badgeMapHTML(map) +
      mechBadgeHTML() +
      '<span class="mode-chip">SEED <em class="digits">' + hexSeed(seedVal) + '</em></span>' +
      (view.complete ? '<span class="mode-chip mode-chip--gold">冠军诞生</span>' :
        '<span class="mode-chip">已完成 <em class="digits">' + (view.done || 0) + ' / ' + (view.totalMatches || 8) + '</em></span>') +
      '<div class="battle-controls"><button type="button" class="btn btn--ctrl btn--danger" data-act="go-home">退出赛程</button></div>');
    setConsoleHint(HINTS.tournament);
    renderTournament();
    setPaused(false);
    setCountdown(null);
  }

  /* ================= 结算页 ================= */
  function duelFighterHTML(ballId, row, isWinner, statusText, isLoser) {
    var ball = ballById(ballId) || (row ? { name: row.name, en: '', color: row.color, color2: row.color || '#FFC24B' } : null);
    var faceBall = ballById(ballId);
    var color = (ball && ball.color) || (row && row.color) || '#FF6B1A';
    var color2 = (ball && ball.color2) || '#FFC24B';
    var hpPct = row && row.hpPct != null ? Math.round(row.hpPct * 100) : 0;
    var stats = (U.lastStats && U.lastStats[ballId]) || {};
    var taken = stats.taken != null ? Math.round(stats.taken) : (row && row.taken != null ? Math.round(row.taken) : '—');
    var heal = stats.heal != null ? Math.round(stats.heal) : Math.round((row && row.heal) || 0);
    return '' +
      '<div class="duel-fighter' + (isWinner ? ' is-winner' : '') + (isLoser ? ' is-loser' : '') + '"' +
        ' style="--c:' + esc(color) + ';--c2:' + esc(color2) + ';--cd:' + mixColor(color, 0.55) + '">' +
        '<div class="duel-fighter__head">' +
          (faceBall ? '<span class="duel-fighter__face">' + orbHTML(faceBall, 'orb--mini', { state: isWinner ? 'victory' : 'dead' }) + '</span>'
            : '<span class="duel-fighter__dot" aria-hidden="true"></span>') +
          '<span class="duel-fighter__ident">' +
            '<span class="duel-fighter__name">' + esc(ball ? ball.name : '?') + '</span>' +
            '<span class="duel-fighter__en">' + esc(ball ? ball.en : '') + '</span>' +
          '</span>' +
          (isWinner ? '<span class="duel-fighter__tag duel-fighter__tag--win">胜</span>' : '') +
          (isLoser ? '<span class="duel-fighter__tag duel-fighter__tag--lose">负</span>' : '') +
        '</div>' +
        '<div class="duel-fighter__stats">' +
          '<span class="is-primary"><b>输出</b><em>' + Math.round((row && row.dealt) || 0) + '</em></span>' +
          '<span><b>承受</b><em>' + taken + '</em></span>' +
          '<span><b>施法</b><em>' + Math.round((row && row.casts) || 0) + '</em></span>' +
          '<span><b>治疗量</b><em>' + heal + '</em></span>' +
          '<span><b>残余</b><em>' + hpPct + '%</em></span>' +
        '</div>' +
        '<div class="duel-fighter__bar" aria-hidden="true"><i style="width:' + clamp(hpPct, 0, 100) + '%"></i></div>' +
        '<div class="duel-fighter__status">' + esc(statusText || '') + '</div>' +
      '</div>';
  }

  function buildRankedResult(result, opts) {
    result = result || {};
    opts = opts || {};
    if (opts.mechanisms) U.mechanisms = sanitizeMechanisms(opts.mechanisms);
    else if (!U.mechanisms) U.mechanisms = defaultMechanisms();
    var tour = opts.tournament || {};
    var map = mapById(opts.map || U.map);
    var standings = Array.isArray(result.standings) ? result.standings : [];
    var winner = result.winner || null;
    var winnerId = winner ? (winner.ballId || winner.id) : null;
    var winnerRow = winnerId ? standings.filter(function (r) { return r.ballId === winnerId; })[0] : null;
    var lineup = Array.isArray(result.lineup) ? result.lineup.slice(0, 2) : [];
    if (lineup.length < 2) {
      lineup = [winnerId].concat(standings.map(function (r) { return r.ballId; }).filter(function (id) { return id !== winnerId; })).slice(0, 2);
    }
    var rowsById = {};
    standings.forEach(function (r) { rowsById[r.ballId] = r; });
    var loserId = lineup.filter(function (id) { return id !== winnerId; })[0] || null;
    var winnerBall = winner ? (ballById(winnerId) || winner) : null;
    var isFinal = !!tour.isFinal;
    var isBronze = !!tour.isBronze;
    var drawResolved = !!tour.drawResolved;
    var roundName = tour.roundName || '排位赛';
    var label = tour.label || roundName;
    var advanceText = tour.advanceText || '';
    var loserText = tour.loserText || '';
    var durText = fmtDuration(result.duration);
    var seedText = hexSeed(result.seed);
    var hpPct = winnerRow && winnerRow.hpPct != null ? Math.round(winnerRow.hpPct * 100) : null;
    var stampText = winnerId ? (isFinal ? '冠军' : (isBronze ? '季军' : '晋级')) : '待裁决';
    var stampCls = winnerId ? (isFinal ? 'champion' : (isBronze ? 'bronze' : 'win')) : 'draw';

    document.body.dataset.mode = 'ranked';
    setScreen('result');
    setMarquee('result', '' +
      '<span class="mode-chip mode-chip--violet">排位赛 <em class="chip-en">RANKED</em></span>' +
      badgeMapHTML(map) +
      '<span class="mode-chip">' + esc(label) + '</span>' +
      '<span class="mode-chip">用时 <em class="digits">' + durText + '</em></span>' +
      '<span class="mode-chip">SEED <em class="digits">' + seedText + '</em></span>');
    setConsoleHint(HINTS.resultRanked);
    U.lastStats = result.stats || {};

    var heroHTML = '' +
      '<div class="rankedresult__head">' +
        '<span class="rankedresult__round">' + esc(label) + '</span>' +
        badgeMapHTML(map) +
        mechBadgeHTML() +
        (drawResolved ? '<span class="mode-chip mode-chip--gold">平局 · 按表现裁决</span>' : '') +
        (tour.complete ? '<span class="mode-chip mode-chip--gold">赛事结束</span>' : '') +
      '</div>' +
      '<div class="rankedresult__hero">' +
        '<div class="rankedresult__orb-wrap">' +
          '<span class="advance-stamp advance-stamp--' + stampCls + '">' + stampText + '</span>' +
          (winnerBall ? orbHTML(winnerBall, 'orb--winner orb--duel', { state: 'victory' }) :
            '<span class="orb orb--winner orb--draw" aria-hidden="true"></span>') +
        '</div>' +
        '<div class="rankedresult__text">' +
          '<span class="result__kicker">MATCH OVER · 单场结束 <span class="k-en">/ ' + esc(roundName) + '</span></span>' +
          '<h2 class="result__title" id="result-title" tabindex="-1">胜者' +
            '<span class="result__name">' + esc(winner ? winner.name : '无人') +
              '<span class="en">' + esc(winner ? (winner.en || '') : '') + '</span>' +
            '</span>' +
          '</h2>' +
          '<p class="rankedresult__advance">' + esc(advanceText || (winnerId ? '晋级下一轮' : '本场平局，等待裁决')) + '</p>' +
          '<div class="result__meta">' +
            '<span class="meta-chip"><b>轮次</b>' + esc(roundName) + '</span>' +
            '<span class="meta-chip"><b>用时</b><em>' + durText + '</em></span>' +
            '<span class="meta-chip"><b>种子</b><em>#' + seedText + '</em></span>' +
          '</div>' +
        '</div>' +
      '</div>';

    var rowsHtml = lineup.map(function (id) {
      var isWinner = id === winnerId;
      return duelFighterHTML(id, rowsById[id], isWinner, isWinner ? (advanceText || (isFinal ? '夺冠' : '晋级')) : (loserText || '淘汰'), !isWinner);
    }).join('<span class="duel-vs" aria-hidden="true">VS</span>');

    var host = $('#screen-result');
    host.innerHTML = '' +
      '<div class="result result--ranked">' +
        '<div class="result__panel result__panel--ranked">' +
          heroHTML +
          '<div class="duel-board">' + rowsHtml + '</div>' +
          '<div class="result__actions result__actions--ranked">' +
            '<button type="button" class="btn btn--primary" data-act="tournament-return">返回赛程 <span aria-hidden="true">▶</span></button>' +
            '<button type="button" class="btn btn--ghost" data-act="go-home">退出排位赛</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    var title = $('#result-title');
    if (title) { try { title.focus({ preventScroll: true }); } catch (e) { } }
    requestFacePaint();
  }

  function showResult(result, opts) {
    opts = opts || {};
    if (opts.mechanisms) U.mechanisms = sanitizeMechanisms(opts.mechanisms);
    else if (!U.mechanisms) U.mechanisms = defaultMechanisms();
    if (opts.mode === 'ranked' || opts.tournament) { buildRankedResult(result, opts); return; }
    if (opts.map) U.map = mapById(opts.map).id;
    result = result || {};
    closeModal();
    setScreen('result');
    // 用时 / 种子 只解析一次，柜头与结算面板共用，保证完全一致
    var durText = fmtDuration(result.duration);
    var seedText = hexSeed(result.seed);
    document.body.dataset.mode = 'basic';
    setMarquee('result', '' +
      '<span class="mode-chip mode-chip--gold">大乱斗 · 比赛结束</span>' +
      badgeMapHTML(currentMap()) +
      '<span class="mode-chip">用时 <em class="digits">' + durText + '</em></span>' +
      '<span class="mode-chip">SEED <em class="digits">' + seedText + '</em></span>');
    setConsoleHint(HINTS.result);

    var standings = Array.isArray(result.standings) ? result.standings : [];
    var winner = result.winner || null;
    var draw = !!result.draw;
    var winnerId = winner ? (winner.ballId || winner.id) : null;
    var winnerRow = winnerId ? standings.filter(function (r) { return r.ballId === winnerId; })[0] : null;
    var pctLeft = winnerRow && winnerRow.hpPct != null ? Math.round(winnerRow.hpPct * 100) : null;
    var winnerBall = winner ? (ballById(winner.ballId) || winner) : null;
    var total = standings.length || (result.lineup ? result.lineup.length : 0);

    var heroHTML;
    if (winnerBall) {
      heroHTML = '' +
        '<div class="result__orb-wrap">' +
          '<span class="result__crown">WINNER</span>' +
          orbHTML(winnerBall, 'orb--winner', { state: 'victory' }) +
        '</div>' +
        '<div class="result__hero-text">' +
          '<span class="result__kicker">MATCH OVER · 比赛结束 <span class="k-en">/ FINAL RESULT</span></span>' +
          '<h2 class="result__title" id="result-title" tabindex="-1">胜者' +
            '<span class="result__name">' + esc(winner.name || winnerBall.name) +
              '<span class="en">' + esc(winner.en || winnerBall.en) + '</span>' +
            '</span>' +
          '</h2>' +
          '<div class="result__tags">' +
            tagsHTML(winnerBall) +
            '<span class="tag">残余生命 ' + (pctLeft != null ? pctLeft + '%' : '—') + '</span>' +
          '</div>' +
          '<p class="result__quote">“' + esc(winnerBall.quote) + '”</p>' +
          '<div class="result__meta">' +
            '<span class="meta-chip"><b>用时</b><em>' + durText + '</em></span>' +
            '<span class="meta-chip"><b>种子</b><em>#' + seedText + '</em></span>' +
            '<span class="meta-chip"><b>规模</b>' + total + ' 位混战</span>' +
          '</div>' +
        '</div>';
    } else {
      heroHTML = '' +
        '<div class="result__orb-wrap">' +
          '<span class="result__crown">DRAW</span>' +
          '<span class="orb orb--winner orb--draw" aria-hidden="true"><span class="orb__num">--</span></span>' +
        '</div>' +
        '<div class="result__hero-text">' +
          '<span class="result__kicker">MATCH OVER · 比赛结束 <span class="k-en">/ NO SURVIVOR</span></span>' +
          '<h2 class="result__title" id="result-title" tabindex="-1">同归于尽' +
            '<span class="result__name">无人存活<span class="en">DRAW</span></span>' +
          '</h2>' +
          '<p class="result__quote">最后一位斗士也倒下了 —— 夜场没有赢家。</p>' +
          '<div class="result__meta">' +
            '<span class="meta-chip"><b>用时</b><em>' + durText + '</em></span>' +
            '<span class="meta-chip"><b>种子</b><em>#' + seedText + '</em></span>' +
            '<span class="meta-chip"><b>规模</b>' + total + ' 位混战</span>' +
          '</div>' +
        '</div>';
    }

    var rowsHTML = standings.map(function (r, i) {
      var ball = ballById(r.ballId);
      var color = r.color || (ball && ball.color) || '#FF6B1A';
      var color2 = (ball && ball.color2) || '#FFC24B';
      var isWinner = winner && r.ballId === winner.ballId;
      var rank = r.rank || i + 1;
      return '' +
        '<tr class="' + (isWinner ? 'is-winner' : '') + (r.alive ? '' : ' is-out') + (rank === 2 ? ' rank-2' : '') + (rank === 3 ? ' rank-3' : '') + '">' +
          '<td class="rank">' + pad2(rank) + '</td>' +
          '<td class="fighter">' +
            '<span class="fighter__wrap">' +
              (ball ? orbHTML(ball, 'orb--mini', { state: isWinner ? 'victory' : 'dead' })
                : '<span class="fighter__dot" style="--c:' + esc(color) + ';--c2:' + esc(color2) + ';--cd:' + mixColor(color, 0.55) + '" aria-hidden="true"></span>') +
              '<span class="fighter__name">' + esc(r.name || (ball && ball.name) || '?') + '</span>' +
              '<span class="fighter__en">' + esc((ball && ball.en) || '') + '</span>' +
            '</span>' +
          '</td>' +
          '<td class="state">' +
            (r.alive
              ? '<span class="stamp stamp--alive">存活</span>'
              : '<span class="stamp stamp--out" title="淘汰于 ' + (r.deathTime != null ? Number(r.deathTime).toFixed(1) : '?') + ' 秒">出局</span>') +
          '</td>' +
          '<td class="num">' + Math.round(r.dealt || 0) + '</td>' +
          '<td class="num">' + Math.round(r.kills || 0) + '</td>' +
          '<td class="num">' + Math.round(r.casts || 0) + '</td>' +
          '<td class="num">' + Math.round(r.heal || 0) + '</td>' +
        '</tr>';
    }).join('');

    var host = $('#screen-result');
    host.innerHTML = '' +
      '<div class="result">' +
        '<div class="result__panel">' +
          '<div class="result__hero">' + heroHTML + '</div>' +
          '<div class="result__body">' +
            '<table class="standings">' +
              '<caption class="sr-only">完整排名：名次、斗士、存活、输出、击杀、施法、治疗量</caption>' +
              '<thead><tr>' +
                '<th scope="col">名次</th>' +
                '<th scope="col">斗士</th>' +
                '<th scope="col">存活</th>' +
                '<th scope="col" class="th-num">输出</th>' +
                '<th scope="col" class="th-num">击杀</th>' +
                '<th scope="col" class="th-num">施法</th>' +
                '<th scope="col" class="th-num">治疗量</th>' +
              '</tr></thead>' +
              '<tbody>' + rowsHTML + '</tbody>' +
            '</table>' +
          '</div>' +
          '<div class="result__actions">' +
            '<button type="button" class="btn btn--primary" data-act="rematch">再来一局（同阵容）</button>' +
            '<button type="button" class="btn btn--ghost" data-act="newlineup">换阵容</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var title = $('#result-title');
    if (title) { try { title.focus({ preventScroll: true }); } catch (e) { } }
    requestFacePaint();
  }

  /* ================= Toast ================= */
  function hideToast() {
    var el = $('#toast');
    if (!el) return;
    root.clearTimeout(U.toastTimer);
    el.hidden = true;
  }

  function toast(text) {
    var el = $('#toast');
    if (!el || !text) return;
    // 结算页已经有完整胜者信息，重复的「胜者：X」会盖住底部控制台，直接不弹
    if (U.screen === 'result' && String(text).indexOf('胜者：') === 0) return;
    el.textContent = String(text);
    el.hidden = false;
    el.classList.remove('toast--in');
    void el.offsetWidth;
    el.classList.add('toast--in');
    root.clearTimeout(U.toastTimer);
    U.toastTimer = root.setTimeout(function () { el.hidden = true; }, 2400);
  }

  /* ================= 模态 / 指南 / 档案弹层 ================= */
  function focusables(panel) {
    return $all('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', panel)
      .filter(function (el) { return !el.disabled && el.offsetParent !== null; });
  }

  function openModal(opts) {
    closeModal();
    U.lastFocus = document.activeElement;
    var mount = $('#modal-root');
    if (!mount) return;
    var modal = document.createElement('div');
    modal.className = 'modal';
    modal.dataset.modal = opts.modalId || '';
    modal.innerHTML = '' +
      '<div class="modal__panel ' + (opts.wide ? 'modal__panel--wide ' : '') + (opts.panelClass || '') + '" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">' +
        '<div class="modal__head">' +
          '<span class="modal__kicker">' + esc(opts.kicker || '') + '</span>' +
          '<h2 class="modal__title" id="modal-title">' + esc(opts.title || '') + '</h2>' +
          '<button type="button" class="modal__close" data-act="modal-close" aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="modal__body">' + (opts.body || '') + '</div>' +
      '</div>';
    mount.appendChild(modal);
    U.modal = modal;
    var cabinet = $('#cabinet');
    if (cabinet && 'inert' in cabinet) cabinet.inert = true;
    modal.addEventListener('click', function (e) {
      if (e.target === modal) { e.preventDefault(); closeModal(); return; }
      var actEl = e.target.closest && e.target.closest('[data-act]');
      if (!actEl) return;
      var act = actEl.dataset.act;
      if (act === 'modal-close') { e.preventDefault(); closeModal(); return; }
      if (typeof opts.onAction === 'function') {
        e.preventDefault();
        opts.onAction(act, actEl, modal);
      }
    });
    var panel = $('.modal__panel', modal);
    root.requestAnimationFrame(function () {
      try { panel.focus({ preventScroll: true }); } catch (e) { }
    });
    return modal;
  }

  function closeModal() {
    var mount = $('#modal-root');
    if (mount) mount.innerHTML = '';
    var cabinet = $('#cabinet');
    if (cabinet && 'inert' in cabinet) cabinet.inert = false;
    if (U.modal && U.lastFocus && document.contains(U.lastFocus)) {
      try { U.lastFocus.focus({ preventScroll: true }); } catch (e) { }
    }
    U.modal = null;
    U.lastFocus = null;
  }

  function showGuide(open) {
    if (open === false) { closeModal(); return; }
    openScreen('guide');
  }

  /* ================= 更新日志 markdown 渲染 ================= */
  function inlineMarkdown(text) {
    var s = esc(text);
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, function (m, label, url) {
      return '<a href="' + url.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    return s;
  }

  function renderMarkdown(md) {
    var lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    var html = [];
    var listOpen = false;
    var quoteOpen = false;
    var para = [];
    var pendingItem = null;

    function flushItem() {
      if (pendingItem != null) {
        html.push('<li>' + inlineMarkdown(pendingItem) + '</li>');
        pendingItem = null;
      }
    }
    function closeList() {
      flushItem();
      if (listOpen) { html.push('</ul>'); listOpen = false; }
    }
    function closeQuote() {
      if (quoteOpen) { html.push('</blockquote>'); quoteOpen = false; }
    }
    function flushPara() {
      if (para.length) {
        html.push('<p class="md-p">' + para.map(inlineMarkdown).join('<br>') + '</p>');
        para = [];
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = raw.trim();
      if (!line) { closeList(); flushPara(); closeQuote(); continue; }
      if (/^---+$/.test(line) || /^\*\*\*+$/.test(line) || /^___+$/.test(line)) {
        closeList(); flushPara(); closeQuote();
        html.push('<hr class="md-hr">');
        continue;
      }
      var h1 = line.match(/^#\s+(.*)$/);
      if (h1) {
        closeList(); flushPara(); closeQuote();
        html.push('<div class="md-doc-title">' + inlineMarkdown(h1[1]) + '</div>');
        continue;
      }
      var h2 = line.match(/^##\s+(.*)$/);
      if (h2) {
        closeList(); flushPara(); closeQuote();
        var verRaw = h2[1].trim();
        var version = verRaw.split(/\s+/)[0] || verRaw;
        var dateMatch = verRaw.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/);
        html.push('<div class="md-version">' +
          '<span class="md-version__tag">RELEASE</span>' +
          '<b class="md-version__v">' + inlineMarkdown(version) + '</b>' +
          (dateMatch ? '<span class="md-version__date">' + esc(dateMatch[1]) + '</span>' : '') +
          '</div>');
        continue;
      }
      var h3 = line.match(/^###\s+(.*)$/);
      if (h3) {
        closeList(); flushPara(); closeQuote();
        var cat = h3[1].trim();
        var catCls = cat.indexOf('新增') >= 0 ? 'add' : cat.indexOf('优化') >= 0 ? 'opt' : cat.indexOf('修复') >= 0 ? 'fix' : 'other';
        html.push('<h4 class="md-cat md-cat--' + catCls + '"><i aria-hidden="true"></i>' + esc(cat) + '</h4>');
        continue;
      }
      var quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        closeList(); flushPara();
        if (!quoteOpen) { html.push('<blockquote class="md-quote">'); quoteOpen = true; }
        html.push('<p>' + inlineMarkdown(quote[1]) + '</p>');
        continue;
      }
      var item = line.match(/^[-*+]\s+(.*)$/);
      if (item) {
        closeQuote(); flushPara();
        if (!listOpen) { html.push('<ul class="md-list">'); listOpen = true; }
        flushItem();
        pendingItem = item[1];
        continue;
      }
      // markdown 列表续行（缩进两格以上，属于上一条）
      if (/^\s{2,}\S/.test(raw) && (pendingItem != null || listOpen)) {
        if (pendingItem != null) pendingItem += ' ' + line;
        continue;
      }
      closeQuote();
      flushItem();
      closeList();
      para.push(line);
    }
    closeList(); flushPara(); closeQuote();
    return html.join('');
  }

  function changelogVersionLabel(version) {
    if (!version) return 'v?';
    var v = String(version);
    return (v.charAt(0) === 'v' || v.charAt(0) === 'V') ? v : 'v' + v;
  }

  function setChangelog(payload) {
    payload = payload || {};
    U.changelog = {
      markdown: payload.markdown || '',
      source: payload.source || (payload.markdown ? 'live' : 'loading'),
      note: payload.note || '',
      version: payload.version || '',
      updatedAt: payload.updatedAt || ''
    };
    /* 更新日志页打开时刷新「系统更新」里的原文区 */
    if (U.screen === 'patches') renderPatches();
  }

  function trapFocus(e) {
    if (!U.modal) return;
    var panel = $('.modal__panel', U.modal);
    if (!panel) return;
    var list = focusables(panel);
    if (!list.length) return;
    var first = list[0];
    var last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }

  /* ================= 全局事件 ================= */
  function onDocumentClick(e) {
    var target = e.target;
    if (!target || !target.closest) return;
    // 模态层有自己的监听，避免同一次点击被处理两遍（bottom sheet 走通用分支）
    if (U.modal) return;

    // 点击空白处：关闭 hover 打开的战斗详情（固定时不关）
    if (U.screen === 'battle' && U.battleInfo.ballId && !U.battleInfo.pinned) {
      if (!target.closest('.battle-info') && !target.closest('.hp-row')) closeBattleInfo();
    }

    // 选球页卡牌：点击 / 回车固定详情 + 加入或移出阵容
    var card = target.closest('.ball-card');
    if (card && U.screen === 'roster') {
      e.preventDefault();
      rosterPick(card.dataset.ball);
      return;
    }

    // 赛程页：点击 ready 场次卡（或其中按钮）都能开打
    if (U.screen === 'tournament') {
      var readyCard = target.closest('.match--ready');
      if (readyCard && readyCard.dataset.match) {
        e.preventDefault();
        if (typeof U.cb.onTournamentMatch === 'function') U.cb.onTournamentMatch(readyCard.dataset.match);
        return;
      }
    }

    var actEl = target.closest('[data-act]');
    if (!actEl) return;
    var act = actEl.dataset.act;

    switch (act) {
      /* ---- 大厅 / 导航 / 子页面 ---- */
      case 'nav':
        if (actEl.dataset.tab === 'data' || actEl.dataset.tab === 'system') U.patches.tab = actEl.dataset.tab;
        if (actEl.dataset.screen) openScreen(actEl.dataset.screen);
        break;
      case 'back-home':
        if (U.screen === 'prep') prepCancel();
        else openScreen('home');
        break;
      case 'lobby-mode':
        U.home.mode = actEl.dataset.mode === 'ranked' ? 'ranked' : 'basic';
        U.mode = U.home.mode;
        openPrep('home');
        break;
      case 'prep-map': prepPickMap(actEl.dataset.map); break;
      case 'prep-mech': prepToggleMech(actEl.dataset.mech); break;
      case 'prep-confirm': prepConfirm(); break;
      case 'prep-back': prepCancel(); break;
      case 'change-battlefield': openPrep('roster'); break;
      case 'fav-shuffle': cycleLobbyBall(); break;
      case 'fav-open':
        if (actEl.dataset.ball) U.codex.sel = canonicalId(actEl.dataset.ball);
        openScreen('codex');
        break;
      case 'favorite': toggleFavorite(actEl.dataset.ball); break;
      case 'codex-pick':
        if (actEl.dataset.ball) {
          U.codex.sel = canonicalId(actEl.dataset.ball);
          if (isNarrow()) openBallSheet(U.codex.sel, { mode: 'fighter' });
          else renderCodex();
        }
        break;
      case 'fighter-tab':
        U.codex.tab = actEl.dataset.tab === 'profile' ? 'profile' : 'battle';
        if (U.sheet) refreshSheet();
        else if (U.screen === 'codex') renderCodex();
        break;
      case 'codex-open':
        if (actEl.dataset.ball) U.codex.sel = canonicalId(actEl.dataset.ball);
        openScreen('codex');
        break;
      case 'codex-tag':
        U.codex.tag = actEl.dataset.tag || '';
        renderCodex();
        break;
      case 'guide-tab':
        U.guide.tab = actEl.dataset.tab || 'controls';
        renderGuide();
        break;
      case 'patch-tab':
        U.patches.tab = actEl.dataset.tab === 'data' ? 'data' : 'system';
        renderPatches();
        break;
      case 'patch-tag':
        U.patches.tag = actEl.dataset.tag || '';
        renderPatches();
        break;
      case 'patch-source':
        U.patches.sourceOpen = !U.patches.sourceOpen;
        renderPatches();
        break;
      case 'changelog-refresh':
        if (typeof U.cb.onChangelogRefresh === 'function') U.cb.onChangelogRefresh();
        break;
      case 'changelog-pick':
        if (typeof U.cb.onChangelogPick === 'function') U.cb.onChangelogPick();
        break;
      /* ---- 设置 ---- */
      case 'toggle-mute':
        if (typeof U.cb.onMuteToggle === 'function') U.cb.onMuteToggle(!U.muted);
        else setMuted(!U.muted);
        break;
      case 'toggle-reduced':
        U.settings.reduced = !U.settings.reduced;
        applySettings();
        renderSettings();
        break;
      case 'audio-test': testAudio(); break;
      case 'reset-prefs': resetPrefs(); break;
      /* ---- 选球页 ---- */
      case 'random': randomLineup(); break;
      case 'clear': clearLineup(); break;
      case 'start': startFromRoster(); break;
      case 'slot':
        if (actEl.dataset.ball) { toggleBall(actEl.dataset.ball); U.detailPinned = true; }
        break;
      case 'toggle':
        if (actEl.dataset.ball) {
          toggleBall(actEl.dataset.ball);
          if (U.sheet) refreshSheet();
          if (U.screen === 'codex') renderCodex();
        }
        break;
      case 'modal-close': closeModal(); break;
      case 'sheet-close': closeSheet(); break;
      /* ---- 战斗 ---- */
      case 'battle-info':
        if (actEl.dataset.ball) openBattleInfo(canonicalId(actEl.dataset.ball), true);
        break;
      case 'battle-info-pin':
        U.battleInfo.pinned = !U.battleInfo.pinned;
        refreshBattleInfo();
        break;
      case 'battle-info-close': closeBattleInfo(); break;
      case 'pause':
      case 'resume': U.cb.onPauseToggle(); break;
      case 'speed': U.cb.onSpeedChange(Number(actEl.dataset.speed)); break;
      case 'exit': U.cb.onExit(); break;
      case 'rematch': U.cb.onRematch(); break;
      case 'newlineup': U.cb.onNewLineup(); break;
      /* ---- 赛程 / 结算 ---- */
      case 'go-home':
        if (typeof U.cb.onHome === 'function') U.cb.onHome();
        break;
      case 'match':
        if (actEl.dataset.match && typeof U.cb.onTournamentMatch === 'function') U.cb.onTournamentMatch(actEl.dataset.match);
        break;
      case 'tournament-return':
        if (typeof U.cb.onTournamentReturn === 'function') U.cb.onTournamentReturn();
        break;
      case 'play-again':
        if (typeof U.cb.onPlayAgainTournament === 'function') U.cb.onPlayAgainTournament();
        break;
      case 'changelog': openScreen('patches'); break;
      case 'guide': openScreen('guide'); break;
    }
  }

  function onDocumentKey(e) {
    // 1) 模态：Esc 关闭、Tab 圈定、屏蔽主循环快捷键
    if (U.modal) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeModal();
        return;
      }
      if (e.key === 'Tab') { trapFocus(e); return; }
      if (e.key === ' ' || e.key === 'Spacebar' || e.key === '1' || e.key === '2' ||
        e.key === '3' || e.key === 'm' || e.key === 'M') {
        e.stopImmediatePropagation();
      }
      return;
    }

    // 2) 移动端 bottom sheet：Esc 关闭、Tab 圈定
    if (U.sheet) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeSheet();
        return;
      }
      if (e.key === 'Tab') {
        var sheetPanel = $('.sheet__panel', U.sheet);
        if (sheetPanel) {
          var sList = focusables(sheetPanel);
          if (sList.length) {
            var sFirst = sList[0];
            var sLast = sList[sList.length - 1];
            if (e.shiftKey && (document.activeElement === sFirst || document.activeElement === sheetPanel)) { e.preventDefault(); sLast.focus(); }
            else if (!e.shiftKey && document.activeElement === sLast) { e.preventDefault(); sFirst.focus(); }
          }
        }
        return;
      }
      return;
    }

    // 3) 战斗详情面板：Esc 只关面板（不退出战斗）
    if (U.battleInfo.ballId) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeBattleInfo();
        return;
      }
    }

    var tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    // 4) UI 独立子页面 / 战场准备：Esc 返回
    if (PAGE_SCREENS[U.screen] && e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (U.screen === 'prep') prepCancel();
      else showHome({ mode: U.home.mode, map: U.home.map, mechanisms: U.home.mechanisms });
      return;
    }

    // 5) 选球页方向键导航
    if (U.screen === 'roster' && U.refs.grid) {
      var dir = null;
      if (e.key === 'ArrowRight') dir = 1;
      else if (e.key === 'ArrowLeft') dir = -1;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var cols = 5;
        try {
          var tpl = root.getComputedStyle(U.refs.grid).gridTemplateColumns;
          if (tpl && tpl !== 'none') cols = tpl.split(' ').filter(Boolean).length || 5;
        } catch (err) { }
        dir = e.key === 'ArrowDown' ? cols : -cols;
      }
      if (dir !== null && U.refs.cards && U.refs.cards.length) {
        var cards = U.refs.cards;
        var active = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.ball-card') : null;
        var idx = active ? cards.indexOf(active) : -1;
        var next = idx < 0 ? 0 : clamp(idx + dir, 0, cards.length - 1);
        if (idx >= 0 && next !== idx) {
          try { cards[next].focus(); } catch (err2) { }
          if (!U.detailPinned) setActive(cards[next].dataset.ball);
        }
        e.preventDefault();
      }
    }
  }

  function onResize() {
    layoutArena();
  }

  function onFontsReady() {
    layoutArena();
    if (U.refs.arenaShell) notifyRendererResize();
  }

  /* ================= 公开 API ================= */
  function init(opts) {
    opts = opts || {};
    if (U.initialized) return;
    G = opts.data || root.GameData;
    if (!G) { console.error('[BALLUI] GameData 未加载'); return; }
    U.data = G;
    U.min = clamp(opts.minLineup || (G.RULES && G.RULES.minLineup) || 2, 2, 8);
    U.max = clamp(opts.maxLineup || (G.RULES && G.RULES.maxLineup) || 8, U.min, 8);
    U.home.mechanisms = sanitizeMechanisms(opts.mechanisms || null);
    U.mechanisms = Object.assign({}, U.home.mechanisms);

    loadPrefs();
    U.hoverFine = !!(root.matchMedia && root.matchMedia('(hover: hover)').matches);

    U.cb = {
      onStart: typeof opts.onStart === 'function' ? opts.onStart : function () { },
      onExit: typeof opts.onExit === 'function' ? opts.onExit : function () { },
      onPauseToggle: typeof opts.onPauseToggle === 'function' ? opts.onPauseToggle : function () { },
      onSpeedChange: typeof opts.onSpeedChange === 'function' ? opts.onSpeedChange : function () { },
      onMuteToggle: typeof opts.onMuteToggle === 'function' ? opts.onMuteToggle : function () { },
      onRematch: typeof opts.onRematch === 'function' ? opts.onRematch : function () { },
      onNewLineup: typeof opts.onNewLineup === 'function' ? opts.onNewLineup : function () { },
      /* v1.1 / v1.2 */
      onEnterArena: typeof opts.onEnterArena === 'function' ? opts.onEnterArena : function () { },
      onHome: typeof opts.onHome === 'function' ? opts.onHome : function () { },
      onTournamentMatch: typeof opts.onTournamentMatch === 'function' ? opts.onTournamentMatch : function () { },
      onTournamentReturn: typeof opts.onTournamentReturn === 'function' ? opts.onTournamentReturn : function () { },
      onPlayAgainTournament: typeof opts.onPlayAgainTournament === 'function' ? opts.onPlayAgainTournament : function () { },
      onChangelogRefresh: typeof opts.onChangelogRefresh === 'function' ? opts.onChangelogRefresh : function () { },
      onChangelogPick: typeof opts.onChangelogPick === 'function' ? opts.onChangelogPick : function () { }
    };

    if (Array.isArray(opts.initialLineup)) {
      var seen = {}, initLineup = [];
      opts.initialLineup.forEach(function (raw) {
        var cid = canonicalId(raw);
        if (cid && !seen[cid]) { seen[cid] = 1; initLineup.push(cid); }
      });
      U.lineup = initLineup.slice(0, U.max);
    }

    // 确保各 screen 有对应修饰类（样式依赖）
    [['#screen-home', 'home'], ['#screen-prep', 'prep'], ['#screen-codex', 'codex'], ['#screen-maps', 'maps'], ['#screen-guide', 'guide'],
     ['#screen-patches', 'patches'], ['#screen-settings', 'settings'], ['#screen-roster', 'roster'],
     ['#screen-tournament', 'tournament'], ['#screen-battle', 'battle'], ['#screen-result', 'result']].forEach(function (pair) {
      var el = $(pair[0]);
      if (el && !el.classList.contains('screen--' + pair[1])) el.classList.add('screen--' + pair[1]);
    });

    buildChrome();
    buildTabbar();
    buildLobby();
    buildCodex();
    buildMaps();
    buildGuide();
    buildPatches();
    buildSettings();
    buildRoster();
    buildBattle();
    buildResultHost();

    U.settings.volumeApi = audioHasVolume();
    setMuted(false);
    setSpeed(1);
    applySettings();
    renderSettings();
    if (document.body) {
      document.body.dataset.mode = U.mode;
      document.body.dataset.map = U.map;
    }

    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onDocumentKey);
    bindFacesAndFx();
    startFaceLoop();
    root.addEventListener('resize', onResize);
    var mqNarrow = root.matchMedia ? root.matchMedia('(max-width: 900px)') : null;
    if (mqNarrow && mqNarrow.addEventListener) {
      try {
        mqNarrow.addEventListener('change', function () { updateTabbar(U.screen || 'home'); layoutArena(); requestFacePaint(); });
      } catch (e) { }
    }
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(onFontsReady).catch(function () { });
    }
    U.initialized = true;
  }

  function bindFacesAndFx() {
    document.addEventListener('mouseover', function (e) {
      if (!U.hoverFine) return;
      var el = e.target.closest && e.target.closest('.fx-word');
      if (el) showFxTip(el);
    });
    document.addEventListener('mouseout', function (e) {
      if (U.fxTouchDown) return;
      var el = e.target.closest && e.target.closest('.fx-word');
      if (!el) return;
      var to = e.relatedTarget;
      if (to && to.closest && to.closest('.fx-word') === el) return;
      hideFxTip();
    });
    document.addEventListener('focusin', function (e) {
      var el = e.target.closest && e.target.closest('.fx-word');
      if (el) showFxTip(el);
    });
    document.addEventListener('focusout', function (e) {
      if (e.target.closest && e.target.closest('.fx-word')) hideFxTip();
    });
    document.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse') return;
      var el = e.target.closest && e.target.closest('.fx-word');
      if (!el) return;
      U.fxTouchDown = true;
      root.clearTimeout(U.fxPressTimer);
      U.fxPressTimer = root.setTimeout(function () { showFxTip(el); }, 130);
    });
    document.addEventListener('pointerup', function () { U.fxTouchDown = false; root.clearTimeout(U.fxPressTimer); hideFxTip(); });
    document.addEventListener('pointercancel', function () { U.fxTouchDown = false; root.clearTimeout(U.fxPressTimer); hideFxTip(); });
    document.addEventListener('pointermove', function () { root.clearTimeout(U.fxPressTimer); });
    document.addEventListener('contextmenu', function (e) {
      if (e.target.closest && e.target.closest('.fx-word')) e.preventDefault();
    });
  }

  function buildResultHost() {
    var host = $('#screen-result');
    if (host) host.innerHTML = '';
  }

  root.BallUI = {
    init: init,
    /* 页面 / 主流程 */
    showHome: showHome,
    showTournament: showTournament,
    showRoster: showRoster,
    showBattle: showBattle,
    updateBattle: updateBattle,
    showResult: showResult,
    addFeed: addFeed,
    setPaused: setPaused,
    setSpeed: setSpeed,
    setMuted: setMuted,
    setCountdown: setCountdown,
    setChangelog: setChangelog,
    toast: toast,
    showGuide: showGuide,
    /* v1.2 内部页面 / 设置 */
    openScreen: openScreen,
    getSettings: function () {
      return {
        volume: U.settings.volume,
        musicVolume: U.settings.musicVolume,
        musicTrack: U.settings.musicTrack,
        muted: !!U.muted,
        reduced: !!U.reduced,
        favoriteId: U.favoriteId
      };
    },
    setVolume: function (v) {
      U.settings.volume = clamp(Math.round(Number(v) || 0), 0, 100);
      applySettings();
      renderSettings();
      return U.settings.volume;
    },
    getFavorite: function () { return U.favoriteId; },
    setFavorite: function (id) { setFavorite(id); return U.favoriteId; },
    openPrep: openPrep,
    getVersion: function () { return (G && G.VERSION) || '0.4.4'; }
  };

})(typeof self !== 'undefined' ? self : this);

