/* ============================================================
 * 斗球场 BALL PIT — 主循环 / 状态机 / 集成  (v0.3)
 * 模式：大乱斗 basic / 排位赛 ranked
 * 地图：方阵 square / 圆环 circle
 * 依赖：GameData, BallSim, BallTournament, BallRenderer, BallAudio, BallUI
 * ============================================================ */
(function () {
  'use strict';

  var G = window.GameData;
  var DEFAULT_BASIC_LINEUP = ['B0001', 'B0002', 'B0003', 'B0004', 'B0005', 'B0007'];
  var DEFAULT_RANKED_LINEUP = ['B0001', 'B0002', 'B0003', 'B0004', 'B0005', 'B0006', 'B0008', 'B0009'];
  var FIXED_DT = (G && G.RULES && G.RULES.fixedDt) || 1 / 120;
  var RULES = (G && G.RULES) || {};
  var DUEL = (RULES.duel) || { arenaScale: 0.86, timeLimit: 300, suddenDeath: { start: 60, dpsBase: 1.6, dpsRamp: 2.4 } };
  var MAPS = (G && G.MAPS) || [];
  var MODES = (G && G.MODES) || [];

  var state = {
    screen: 'home',              // home | roster | tournament | battle | result
    mode: 'basic',               // basic | ranked
    map: 'square',               // square | circle
    mechanisms: (G && G.DEFAULT_MECHANISMS) ? Object.assign({}, G.DEFAULT_MECHANISMS) : { suddenDeath: false },
    lineup: DEFAULT_BASIC_LINEUP.slice(),
    seed: null,                  // 当前对局/赛程种子
    match: null,
    matchKind: 'basic',          // basic | ranked
    matchMeta: null,
    tournament: null,
    activeMatch: null,           // {id, roundId, roundName, label, a, b, seed}
    lastReport: null,
    reported: false,
    paused: false,
    speed: 1,
    muted: false,
    intro: false,
    introT: 0,
    countdown: null,
    endDelay: 0,
    overHandled: false,
    suddenAnnounced: false,
    accumulator: 0,
    turbo: false,
    lastFrame: 0,
    fps: 60,
    fpsAcc: 0,
    fpsFrames: 0,
    reducedMotion: false,
    canvas: null,
    rendererReady: false,
    lastSnapshot: null,
    lastAudio: {},
    audioUnlocked: false,
    killChain: {},
    firstBlood: false,
    changelog: { markdown: '', source: 'loading', note: '', version: (G && G.VERSION) || '0.4.4' }
  };

  var params = new URLSearchParams(location.search || '');
  var SKIP_INTRO = params.get('skipintro') === '1';
  var AUTOPLAY = params.get('autoplay') === '1';

  /* ---------------- utils ---------------- */
  function clamp(n, a, b) { return n < a ? a : (n > b ? b : n); }

  function validMode(id) { return id === 'ranked' ? 'ranked' : 'basic'; }
  function validMap(id) {
    if (id && G && G.MAP_BY_ID && G.MAP_BY_ID[id]) return id;
    return 'square';
  }
  function modeDef() { return (G && G.MODE_BY_ID && G.MODE_BY_ID[state.mode]) || { id: state.mode, name: state.mode }; }
  function mapDef() { return (G && G.MAP_BY_ID && G.MAP_BY_ID[state.map]) || { id: state.map, name: state.map, shape: state.map }; }
  function mapName() { return mapDef().name || state.map; }

  function sanitizeMechanisms(input) {
    var defaults = (G && G.DEFAULT_MECHANISMS) || { suddenDeath: false };
    var out = {};
    for (var k in defaults) {
      if (!Object.prototype.hasOwnProperty.call(defaults, k)) continue;
      out[k] = (input && input[k] !== undefined && input[k] !== null) ? !!input[k] : !!defaults[k];
    }
    if (input && input.suddenDeath !== undefined && input.suddenDeath !== null) out.suddenDeath = !!input.suddenDeath;
    return out;
  }

  function uniqueBalls(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (raw) {
      var id = String(raw || '').trim();
      if (!id || seen[id] || !G.BALL_BY_ID[id]) return;
      seen[id] = 1;
      out.push(id);
    });
    return out;
  }

  function sanitizeLineup(list, mode) {
    var out = uniqueBalls(list);
    var min = mode === 'ranked' ? 8 : (RULES.minLineup || 2);
    var max = mode === 'ranked' ? 8 : (RULES.maxLineup || 8);
    if (out.length > max) out = out.slice(0, max);
    if (out.length < min) {
      // 按 roster 顺序补齐（排位赛 / 参数不足时）
      var ids = G.BALLS.map(function (b) { return b.id; });
      for (var i = 0; i < ids.length && out.length < min; i++) {
        if (out.indexOf(ids[i]) < 0) out.push(ids[i]);
      }
    }
    if (mode === 'ranked' && out.length > 8) out = out.slice(0, 8);
    return out;
  }

  function parseLineup(raw) {
    return raw ? uniqueBalls(raw.split(',')) : null;
  }

  function randomSeed() {
    return (Math.floor(Math.random() * 0x7fffffff) >>> 0);
  }

  function sfx(name, gap) {
    if (!window.BallAudio || state.muted) return;
    var now = performance.now() / 1000;
    var last = state.lastAudio[name] || 0;
    if (now - last < (gap || 0.05)) return;
    state.lastAudio[name] = now;
    try { BallAudio.play(name); } catch (e) { /* 静默降级 */ }
  }

  function music(slot) {
    if (!window.BallAudio || typeof BallAudio.playMusic !== 'function') return;
    try { BallAudio.playMusic(slot); } catch (e) { /* 无音乐时静默 */ }
  }

  function stopMusic() {
    if (!window.BallAudio || typeof BallAudio.stopMusic !== 'function') return;
    try { BallAudio.stopMusic(); } catch (e) { /* 静默 */ }
  }

  function entityName(id) {
    if (!state.match) return '?';
    var arr = state.match.entities || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i].name;
    return '?';
  }

  function modeMapMeta(extra) {
    var meta = {
      mode: state.mode,
      modeName: modeDef().name,
      map: state.map,
      mapName: mapName(),
      mapShape: mapDef().shape,
      mechanisms: Object.assign({}, state.mechanisms)
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) meta[k] = extra[k];
    return meta;
  }

  /* ---------------- renderer ---------------- */
  function ensureRenderer() {
    var canvas = document.getElementById('arena');
    if (!canvas || !window.BallRenderer) return false;
    if (state.rendererReady && state.canvas === canvas) {
      try { BallRenderer.resize(); } catch (e) {}
      return true;
    }
    try {
      BallRenderer.init(canvas, { data: G, reducedMotion: state.reducedMotion });
      state.canvas = canvas;
      state.rendererReady = true;
      return true;
    } catch (e) {
      console.error('[BALLPIT] renderer init failed', e);
      state.rendererReady = false;
      return false;
    }
  }

  /* ---------------- 对局启动 ---------------- */
  function baseMatchOptions(lineup, seed) {
    var opts = { lineup: lineup, seed: seed, map: state.map, mechanisms: Object.assign({}, state.mechanisms) };
    var mapInfo = (G && G.MAP_BY_ID && G.MAP_BY_ID[state.map]) || null;
    var mapScale = (mapInfo && mapInfo.sizeScale) ? mapInfo.sizeScale : 1;
    if (state.matchKind !== 'ranked') {
      var sizing = (RULES && RULES.arenaSizing) || { baseScale: 0.86, perBall: 0.06 };
      var n = Math.max(2, Math.min(8, (lineup && lineup.length) || 6));
      opts.arenaScale = (sizing.baseScale + sizing.perBall * (n - 2)) * mapScale;
    }
    if (state.matchKind === 'ranked') {
      opts.arenaScale = DUEL.arenaScale * mapScale;
      opts.timeLimit = DUEL.timeLimit;
      opts.suddenDeath = DUEL.suddenDeath;
      if (DUEL.statMods) opts.statMods = DUEL.statMods;
    }
    return opts;
  }

  function startSimMatch(options) {
    // options: {lineup, seed, kind, meta}
    if (!window.BallSim) { toast('仿真模块未加载'); return false; }
    var ids = options.lineup;
    var s = options.seed;
    state.matchKind = options.kind || 'basic';
    state.seed = s;
    state.matchMeta = options.meta || null;
    // v1.2：每场强制 1×，不记忆上一场（用户在 v1.2 明确要求）
    state.speed = 1;
    try {
      state.match = BallSim.createMatch(baseMatchOptions(ids, s));
    } catch (e) {
      console.error('[BALLPIT] createMatch failed', e);
      toast('开战失败：' + (e && e.message ? e.message : e));
      return false;
    }
    state.screen = 'battle';
    state.paused = false;
    state.overHandled = false;
    state.reported = false;
    state.suddenAnnounced = false;
    state.endDelay = 0;
    state.accumulator = 0;
    state.lastSnapshot = null;
    state.lastAudio = {};
    state.killChain = {};
    state.firstBlood = false;
    state.intro = !state.turbo && !SKIP_INTRO;
    state.introT = state.intro ? 1.9 : 0;
    state.countdown = state.intro ? '3' : null;
    state.lastFrame = performance.now();
    music('battle');

    if (window.BallUI) {
      try {
        BallUI.showBattle(ids, s, options.meta || modeMapMeta());
        BallUI.setPaused(false);
        BallUI.setSpeed(1);
        BallUI.setMuted(state.muted);
        BallUI.setCountdown(state.countdown);
      } catch (e) { console.error('[BALLPIT] showBattle failed', e); }
    }
    ensureRenderer();
    if (state.rendererReady) { try { BallRenderer.reset(); } catch (e) {} }
    var initial = state.match.drainEvents();
    if (initial.length) {
      if (state.rendererReady) { try { BallRenderer.pushEvents(initial); } catch (e) {} }
      mapEvents(initial);
    }
    if (state.turbo) fastForwardToEnd();
    return true;
  }

  function startBasicMatch(lineup, seed) {
    var ids = sanitizeLineup(lineup || state.lineup, 'basic');
    state.lineup = ids;
    var s = (seed === undefined || seed === null || isNaN(seed)) ? randomSeed() : (Number(seed) >>> 0);
    return startSimMatch({
      lineup: ids,
      seed: s,
      kind: 'basic',
      meta: modeMapMeta({ label: '大乱斗', roundName: '' })
    });
  }

  function startRankedMatch(info, opts) {
    if (!info) return false;
    state.lineup = state.tournament ? state.tournament.getLineup() : state.lineup;
    state.activeMatch = info;
    return startSimMatch({
      lineup: [info.a, info.b],
      seed: info.seed,
      kind: 'ranked',
      meta: modeMapMeta({
        label: info.label,
        roundId: info.roundId,
        roundName: info.roundName,
        matchLabel: info.label
      })
    });
  }

  function fastForwardToEnd() {
    if (!state.match) return;
    state.intro = false;
    state.introT = 0;
    state.countdown = null;
    if (window.BallUI) BallUI.setCountdown(null);
    var guard = 0;
    while (state.match.status !== 'over' && guard < 14000) {
      state.match.step(FIXED_DT);
      guard++;
    }
    var evs = state.match.drainEvents();
    if (evs.length) {
      if (state.rendererReady) { try { BallRenderer.pushEvents(evs); } catch (e) {} }
      mapEvents(evs);
    }
    finishBattle();
  }

  /* ---------------- 结算 ---------------- */
  function advanceNote(roundId, isWinner) {
    if (roundId === 'qf') return isWinner ? '晋级半决赛' : '止步八强';
    if (roundId === 'sf') return isWinner ? '晋级决赛' : '进入季军赛';
    if (roundId === 'bronze') return isWinner ? '季军' : '第 4 名';
    if (roundId === 'final') return isWinner ? '冠军' : '亚军';
    return isWinner ? '晋级' : '淘汰';
  }

  function finishBattle() {
    if (!state.match || state.screen === 'result') return;
    stopMusic();
    state.screen = 'result';
    state.paused = false;
    state.intro = false;

    var result;
    if (state.matchKind === 'ranked' && state.tournament && state.activeMatch) {
      if (!state.reported) {
        state.reported = true;
        try {
          state.lastReport = state.tournament.report(state.activeMatch.matchId, {
            winnerId: state.match.winnerId,
            duration: state.match.time,
            stats: state.match.stats,
            standings: state.match.getStandings()
          });
        } catch (e) {
          console.error('[BALLPIT] tournament report failed', e);
          state.lastReport = null;
        }
      }
      var rep = state.lastReport;
      var resolvedId = rep ? rep.winnerId : state.match.winnerId;
      var winner = resolvedId ? (G.BALL_BY_ID[resolvedId] || null) : null;
      var loserId = rep ? rep.loserId : null;
      var label = state.activeMatch.label;
      var roundId = state.activeMatch.roundId;
      result = {
        winner: winner,
        draw: false,
        drawResolved: !!(rep && rep.drawResolved),
        standings: state.match.getStandings(),
        stats: state.match.stats,
        duration: state.match.time,
        seed: state.activeMatch.seed,
        lineup: [state.activeMatch.a, state.activeMatch.b]
      };
      if (winner) sfx('win', 0.2);
      if (window.BallUI) {
        BallUI.setCountdown(null);
        BallUI.setPaused(false);
        try {
          BallUI.showResult(result, {
            mode: 'ranked',
            map: state.map,
            mapName: mapName(),
            mechanisms: Object.assign({}, state.mechanisms),
            tournament: {
              matchId: state.activeMatch.matchId,
              roundId: roundId,
              roundName: state.activeMatch.roundName,
              label: label,
              advanceText: advanceNote(roundId, true),
              loserText: advanceNote(roundId, false),
              isFinal: roundId === 'final',
              isBronze: roundId === 'bronze',
              drawResolved: !!(rep && rep.drawResolved),
              complete: !!(rep && rep.tournamentComplete)
            }
          });
        } catch (e) { console.error('[BALLPIT] showResult failed', e); }
      }
    } else {
      var basicWinnerId = state.match.winnerId;
      var basicWinner = basicWinnerId ? (G.BALL_BY_ID[basicWinnerId] || null) : null;
      result = {
        winner: basicWinner,
        draw: !!state.match.draw,
        standings: state.match.getStandings(),
        stats: state.match.stats,
        duration: state.match.time,
        seed: state.seed,
        lineup: state.lineup.slice()
      };
      if (basicWinner) sfx('win', 0.2);
      if (window.BallUI) {
        BallUI.setCountdown(null);
        BallUI.setPaused(false);
        try {
          BallUI.showResult(result, { mode: 'basic', map: state.map, mapName: mapName(), mechanisms: Object.assign({}, state.mechanisms) });
        } catch (e) { console.error('[BALLPIT] showResult failed', e); }
      }
    }

    if (state.rendererReady) {
      try {
        BallRenderer.render(state.match.getSnapshot(), {
          dt: 0, paused: true, intro: false, fps: state.fps, speed: state.speed,
          stormLevel: state.mechanisms.suddenDeath ? 1 : 0
        });
      } catch (e) {}
    }
  }

  /* ---------------- 赛程 ---------------- */
  function tournamentMeta() {
    return {
      seed: state.tournament ? state.tournament.getSeed() : state.seed,
      map: state.map,
      mapName: mapName(),
      mode: 'ranked',
      mechanisms: Object.assign({}, state.mechanisms),
      lineup: state.tournament ? state.tournament.getLineup() : state.lineup
    };
  }

  function showTournamentScreen() {
    if (!state.tournament) { goHome(); return; }
    state.screen = 'tournament';
    state.match = null;
    state.activeMatch = null;
    state.overHandled = false;
    state.paused = false;
    state.intro = false;
    state.countdown = null;
    if (window.BallUI) {
      BallUI.setCountdown(null);
      BallUI.setPaused(false);
      try { BallUI.showTournament(state.tournament.getView(), tournamentMeta()); }
      catch (e) { console.error('[BALLPIT] showTournament failed', e); }
    }
  }

  function createTournament(lineup, seed) {
    if (!window.BallTournament) {
      toast('赛程模块未加载');
      return false;
    }
    try {
      state.tournament = BallTournament.create({
        lineup: lineup,
        seed: (seed === undefined || seed === null || isNaN(seed)) ? randomSeed() : (Number(seed) >>> 0),
        map: state.map
      });
    } catch (e) {
      console.error('[BALLPIT] createTournament failed', e);
      toast('生成赛程失败：' + (e && e.message ? e.message : e));
      return false;
    }
    state.seed = state.tournament.getSeed();
    state.lineup = state.tournament.getLineup();
    return true;
  }

  function autoplayTournament() {
    if (!state.tournament || !window.BallSim) return;
    var guard = 0;
    while (state.tournament && !state.tournament.isComplete() && guard < 24) {
      var view = state.tournament.getView();
      var id = view.nextMatchId;
      if (!id) break;
      var info = state.tournament.startMatch(id);
      if (!info) break;
      var simOpts = {
        lineup: [info.a, info.b],
        seed: info.seed,
        map: state.map,
        arenaScale: DUEL.arenaScale,
        timeLimit: DUEL.timeLimit,
        suddenDeath: DUEL.suddenDeath,
        statMods: DUEL.statMods,
        mechanisms: Object.assign({}, state.mechanisms)
      };
      var m;
      try { m = BallSim.createMatch(simOpts); } catch (e) { console.error(e); break; }
      var steps = 0;
      while (m.status !== 'over' && steps < 20000) { m.step(FIXED_DT); steps++; }
      state.tournament.report(id, {
        winnerId: m.winnerId,
        duration: m.time,
        stats: m.stats,
        standings: m.getStandings()
      });
      guard++;
    }
  }

  function onTournamentMatch(matchId) {
    if (!state.tournament) return;
    var info = state.tournament.startMatch(matchId);
    if (!info) { toast('该场次还未就绪'); return; }
    state.turbo = false;
    startRankedMatch(info);
    sfx('click', 0.05);
  }

  /* ---------------- 页面跳转 ---------------- */
  function desiredLineupForMode(mode) {
    if (mode === 'ranked') return sanitizeLineup(state.lineup, 'ranked');
    return sanitizeLineup(state.lineup, 'basic');
  }

  function goHome() {
    music('lobby');
    state.screen = 'home';
    state.match = null;
    state.activeMatch = null;
    state.tournament = null;
    state.paused = false;
    state.intro = false;
    state.countdown = null;
    state.reported = false;
    if (window.BallUI) {
      BallUI.setCountdown(null);
      BallUI.setPaused(false);
      try { BallUI.showHome({ mode: state.mode, map: state.map, mechanisms: Object.assign({}, state.mechanisms) }); } catch (e) { console.error(e); }
    }
    sfx('click', 0.05);
  }

  function enterArena(selection) {
    var mode = validMode(selection && selection.mode);
    var map = validMap(selection && selection.map);
    state.mode = mode;
    state.map = map;
    state.mechanisms = sanitizeMechanisms(selection && selection.mechanisms);
    state.lineup = desiredLineupForMode(mode);
    state.screen = 'roster';
    state.tournament = null;
    state.activeMatch = null;
    if (window.BallUI) {
      try { BallUI.showRoster(state.lineup, { mode: state.mode, map: state.map, mapName: mapName(), mechanisms: Object.assign({}, state.mechanisms) }); }
      catch (e) { console.error('[BALLPIT] showRoster failed', e); }
    }
    sfx('click', 0.05);
  }

  function showRosterScreen() {
    state.screen = 'roster';
    state.match = null;
    state.activeMatch = null;
    if (window.BallUI) {
      try { BallUI.showRoster(state.lineup, { mode: state.mode, map: state.map, mapName: mapName(), mechanisms: Object.assign({}, state.mechanisms) }); }
      catch (e) { console.error('[BALLPIT] showRoster failed', e); }
    }
  }

  function exitBattle() {
    if (state.matchKind === 'ranked' && state.tournament) {
      showTournamentScreen();
    } else {
      state.match = null;
      state.overHandled = false;
      showRosterScreen();
    }
    sfx('click', 0.05);
  }

  /* ---------------- 暂停 / 倍速 / 静音 ---------------- */
  function togglePause() {
    if (state.screen !== 'battle' || state.intro) return;
    state.paused = !state.paused;
    if (window.BallUI) BallUI.setPaused(state.paused);
    sfx('click', 0.05);
  }

  function setSpeed(speed) {
    var n = Number(speed);
    if (n !== 0.5 && n !== 1 && n !== 2) n = 1;
    state.speed = n;
    if (window.BallUI) BallUI.setSpeed(n);
    if (state.screen === 'battle') sfx('click', 0.05);
  }

  function setMuted(muted) {
    state.muted = (typeof muted === 'boolean') ? muted : !state.muted;
    if (window.BallUI) BallUI.setMuted(state.muted);
    if (!state.muted) sfx('click', 0.05);
  }

  /* ---------------- 事件播报 ---------------- */
  function mapEvents(events) {
    if (!events || !events.length) return;
    var feed = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      switch (ev.type) {
        case 'cast':
          feed.push({ text: entityName(ev.entityId) + ' · ' + ev.skillName, color: ev.color, tone: 'cast' });
          sfx(ev.skillId === 'singularity' ? 'gravity' : 'cast', 0.07);
          break;
        case 'death':
          var killer = ev.killerId !== null && ev.killerId !== undefined ? entityName(ev.killerId) : '';
          if (!state.firstBlood) {
            state.firstBlood = true;
            feed.push({ text: killer ? '首杀 · ' + killer : '首杀', color: '#FFC24B', tone: 'info' });
          }
          feed.push({
            text: ev.name + ' 出局' + (killer ? ' · 被 ' + killer + ' 淘汰' : ''),
            color: ev.color,
            tone: 'kill'
          });
          trackKill(ev.killerId, killer, ev.color);
          sfx('death', 0.12);
          break;
        case 'hit':
          if (ev.kind === 'hit' || ev.kind === 'zap' || ev.kind === 'chain') sfx('hit', 0.035);
          break;
        case 'bounce':
          sfx('bounce', 0.06);
          break;
        case 'explode':
          sfx('explode', 0.08);
          break;
        case 'heal':
          sfx(ev.kind === 'venom' ? 'venom' : 'heal', 0.1);
          break;
        case 'over':
          sfx('win', 0.2);
          feed.push({
            text: ev.draw ? '同归于尽，没有胜者' : (eventWinnerName(ev.winnerId) + (ev.judged ? ' 判定胜出' : ' 活到最后')),
            tone: 'info',
            color: '#FFC24B'
          });
          break;
        case 'ring':
          if (ev.kind === 'storm') feed.push({ text: '速胜时刻：场地开始消融', tone: 'info', color: '#FF4F6D' });
          if (ev.kind === 'thunder') sfx('thunder', 0.06);
          break;
      }
    }
    if (feed.length && window.BallUI) BallUI.addFeed(feed);
  }

  function eventWinnerName(winnerId) {
    var b = G && G.BALL_BY_ID[winnerId];
    return b ? b.name : '某颗球';
  }

  function trackKill(killerId, killerName, color) {
    if (killerId === null || killerId === undefined || !killerName || !state.match) return;
    var now = state.match.time;
    var rec = state.killChain[killerId];
    if (!rec || now - rec.last > 4) rec = { n: 0, last: now, name: killerName };
    rec.n += 1;
    rec.last = now;
    state.killChain[killerId] = rec;
    if (rec.n >= 2 && window.BallUI) {
      BallUI.addFeed([{
        text: rec.n === 2 ? killerName + ' 双杀！' : (rec.n === 3 ? killerName + ' 三杀！' : killerName + ' 四杀！'),
        color: color || '#FFC24B',
        tone: 'kill'
      }]);
    }
  }

  /* ---------------- 主循环 ---------------- */
  function update(dt, rawDt) {
    if (state.screen !== 'battle' || !state.match) return;

    if (state.intro) {
      state.introT -= Math.min(rawDt == null ? dt : rawDt, 0.5);
      var c = state.introT > 1.35 ? '3' : state.introT > 0.9 ? '2' : state.introT > 0.45 ? '1' : state.introT > 0 ? '开打' : null;
      if (c !== state.countdown) {
        state.countdown = c;
        if (window.BallUI) BallUI.setCountdown(c);
        if (c === '开打') sfx('start', 0.2);
        else if (c) sfx('tick', 0.05);
      }
      if (state.introT <= 0) {
        state.intro = false;
        state.countdown = null;
        if (window.BallUI) BallUI.setCountdown(null);
      }
    }

    if (!state.intro && !state.paused) {
      state.accumulator += dt * state.speed;
      var steps = 0;
      var maxSteps = 24 * state.speed;
      while (state.accumulator >= FIXED_DT && steps < maxSteps) {
        state.match.step(FIXED_DT);
        state.accumulator -= FIXED_DT;
        steps++;
        if (state.match.status === 'over') break;
      }
      if (steps >= maxSteps) state.accumulator = 0;
    }

    var events = state.match.drainEvents();
    if (events.length) {
      if (state.rendererReady) { try { BallRenderer.pushEvents(events); } catch (e) {} }
      mapEvents(events);
    }

    var suddenStart = state.matchKind === 'ranked' ? DUEL.suddenDeath.start : (RULES.suddenDeath ? RULES.suddenDeath.start : 60);
    if (state.mechanisms.suddenDeath && !state.suddenAnnounced && state.match.time >= suddenStart) {
      state.suddenAnnounced = true;
      if (window.BallUI) {
        BallUI.addFeed([{ text: '速胜时刻 — 场地开始消融', tone: 'info', color: '#FF4F6D' }]);
        BallUI.toast('速胜时刻 — 所有球开始掉血');
      }
    }

    if (state.match.status === 'over' && !state.overHandled) {
      state.overHandled = true;
      state.endDelay = state.turbo ? 0 : 1.05;
    }
    if (state.overHandled) {
      state.endDelay -= dt;
      if (state.endDelay <= 0) finishBattle();
    }
  }

  function render(dt) {
    if (state.screen !== 'battle' || !state.match) return;
    var snapshot;
    try { snapshot = state.match.getSnapshot(); } catch (e) { console.error(e); return; }
    state.lastSnapshot = snapshot;
    if (window.BallUI) {
      BallUI.updateBattle(snapshot, {
        paused: state.paused,
        speed: state.speed,
        muted: state.muted,
        countdown: state.intro ? state.countdown : null,
        intro: state.intro
      });
    }
    if (state.rendererReady) {
      try {
        BallRenderer.render(snapshot, {
          dt: dt,
          paused: state.paused || state.intro || state.screen !== 'battle',
          intro: state.intro,
          fps: state.fps,
          speed: state.speed,
          stormLevel: snapshot.stormLevel || 0
        });
      } catch (e) {
        console.error('[BALLPIT] render failed', e);
        state.rendererReady = false;
      }
    }
  }

  function frame(now) {
    var rawDt = (now - state.lastFrame) / 1000;
    state.lastFrame = now;
    if (!isFinite(rawDt) || rawDt < 0) rawDt = 0;
    var dt = Math.min(rawDt, 0.05);

    state.fpsAcc += rawDt;
    state.fpsFrames++;
    if (state.fpsAcc >= 0.5) {
      state.fps = Math.round(state.fpsFrames / state.fpsAcc);
      state.fpsAcc = 0;
      state.fpsFrames = 0;
    }

    update(dt, rawDt);
    render(dt);
    requestAnimationFrame(frame);
  }

  /* ---------------- 键盘 ---------------- */
  function onKey(e) {
    if (e.repeat) return;
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.code === 'Space' || e.key === ' ') {
      if (state.screen === 'battle') { e.preventDefault(); togglePause(); }
    } else if (e.key === '1' || e.key === '2' || e.key === '3') {
      if (state.screen === 'battle') setSpeed(e.key === '1' ? 1 : (e.key === '2' ? 2 : 0.5));
    } else if (e.key === 'm' || e.key === 'M') {
      setMuted(!state.muted);
    } else if (e.key === 'Escape') {
      if (state.screen === 'battle') exitBattle();
      else if (state.screen === 'result') {
        if (state.matchKind === 'ranked' && state.tournament) showTournamentScreen();
        else showRosterScreen();
      } else if (state.screen === 'tournament' || state.screen === 'roster') {
        goHome();
      }
    }
  }

  /* ---------------- 更新日志 ---------------- */
  function setChangelog(payload) {
    state.changelog = payload || state.changelog;
    if (window.BallUI && BallUI.setChangelog) {
      try { BallUI.setChangelog(state.changelog); } catch (e) {}
    }
  }

  function loadChangelog(force) {
    setChangelog({ markdown: '', source: 'loading', note: force ? '正在刷新…' : '加载中…', version: (G && G.VERSION) || '0.4.4' });

    // file:// 下浏览器会直接拒绝 fetch（CORS），不必制造控制台错误：
    // 单文件走内嵌快照；开发版提示改用本地服务器或手动选择文件。
    if (location.protocol === 'file:') {
      if (window.CHANGELOG_EMBEDDED) {
        setChangelog({
          markdown: window.CHANGELOG_EMBEDDED,
          source: 'embedded',
          note: '离线内嵌快照（打包时）；改 CHANGELOG.md 后重新打包，或用「启动本地球场.cmd」实时读取',
          version: (G && G.VERSION) || '0.4.4'
        });
      } else {
        setChangelog({
          markdown: '',
          source: 'error',
          note: 'file:// 下浏览器禁止直接读取 CHANGELOG.md；请用「启动本地球场.cmd」打开，或手动选择文件',
          version: (G && G.VERSION) || '0.4.4'
        });
      }
      return;
    }

    var url = 'CHANGELOG.md?_=' + Date.now();
    var fail = function (err) {
      if (window.CHANGELOG_EMBEDDED) {
        setChangelog({
          markdown: window.CHANGELOG_EMBEDDED,
          source: 'embedded',
          note: '离线内嵌快照（打包时）；改 CHANGELOG.md 后重新打包或改用本地服务器',
          version: (G && G.VERSION) || '0.4.4'
        });
      } else {
        setChangelog({
          markdown: '',
          source: 'error',
          note: '无法读取 CHANGELOG.md' + (err && err.message ? '：' + err.message : '') + '（file:// 下请用本地服务器或手动选择文件）',
          version: (G && G.VERSION) || '0.4.4'
        });
      }
    };
    try {
      fetch(url, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(function (md) {
        if (!md || !md.trim()) throw new Error('文件为空');
        setChangelog({
          markdown: md,
          source: 'live',
          note: '实时读取项目根目录 CHANGELOG.md',
          version: (G && G.VERSION) || '0.4.4'
        });
      }).catch(fail);
    } catch (e) {
      fail(e);
    }
  }

  function pickChangelogFile() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.txt,text/markdown,text/plain';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) { input.remove(); return; }
      if (file.size > 1024 * 1024) {
        toast('文件太大（>1MB）');
        input.remove();
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        setChangelog({
          markdown: String(reader.result || ''),
          source: 'file',
          note: '手动载入：' + file.name,
          version: (G && G.VERSION) || '0.4.4'
        });
        toast('已载入 ' + file.name);
      };
      reader.onerror = function () { toast('读取文件失败'); };
      reader.readAsText(file);
      input.remove();
    });
    input.click();
  }

  /* ---------------- audio ---------------- */
  function unlockAudio() {
    if (state.audioUnlocked) return;
    state.audioUnlocked = true;
    if (window.BallAudio) {
      try {
        if (BallAudio.init) BallAudio.init();
        if (BallAudio.unlock) BallAudio.unlock();
        BallAudio.setMuted(state.muted);
      } catch (e) {}
    }
  }

  /* ---------------- 启动 ---------------- */
  function toast(text) {
    if (window.BallUI) BallUI.toast(text);
  }

  function fatal(msg) {
    var el = document.getElementById('screens');
    if (el) el.innerHTML = '<pre style="color:#FF6B6B;padding:24px;font:14px/1.6 Consolas,monospace;white-space:pre-wrap">' + msg + '</pre>';
    console.error('[BALLPIT]', msg);
  }

  function routeFromParams() {
    var screen = params.get('screen') || 'home';
    var mode = validMode(params.get('mode') || 'basic');
    var map = validMap(params.get('map') || 'square');
    state.mode = mode;
    state.map = map;
    var mechInput = {};
    var sdParam = params.get('suddenDeath');
    if (sdParam === '0' || sdParam === 'off' || sdParam === 'false') mechInput.suddenDeath = false;
    else if (sdParam === '1' || sdParam === 'on' || sdParam === 'true') mechInput.suddenDeath = true;
    var mechParam = params.get('mech');
    if (mechParam) {
      mechParam.split(',').forEach(function (pair) {
        var kv = pair.split(':');
        if (kv.length === 2 && kv[0] === 'suddenDeath') mechInput.suddenDeath = !(kv[1] === '0' || kv[1] === 'off');
      });
    }
    state.mechanisms = sanitizeMechanisms(mechInput);

    var urlLineup = parseLineup(params.get('lineup'));
    if (urlLineup) state.lineup = mode === 'ranked' ? sanitizeLineup(urlLineup, 'ranked') : sanitizeLineup(urlLineup, 'basic');
    else state.lineup = desiredLineupForMode(mode);

    var seedParam = params.get('seed');
    var seed = seedParam !== null && seedParam !== '' ? (Number(seedParam) >>> 0) : null;
    state.seed = seed;

    var autoStart = params.get('autostart') === '1' || screen === 'battle' || screen === 'result';
    state.turbo = params.get('turbo') === '1' || screen === 'result';
    if (screen === 'home' && autoStart) screen = 'battle';

    if (screen === 'battle') {
      if (mode === 'ranked') {
        createTournament(state.lineup, seed === null ? undefined : seed);
        var matchId = params.get('match') || (state.tournament && state.tournament.getView().nextMatchId) || 'qf1';
        var info = state.tournament ? state.tournament.startMatch(matchId) : null;
        if (info) startRankedMatch(info);
        else { showTournamentScreen(); }
      } else {
        startBasicMatch(state.lineup, seed === null ? undefined : seed);
      }
    } else if (screen === 'result') {
      if (mode === 'ranked') {
        createTournament(state.lineup, seed === null ? undefined : seed);
        var rid = params.get('match') || (state.tournament && state.tournament.getView().nextMatchId) || 'qf1';
        var rinfo = state.tournament ? state.tournament.startMatch(rid) : null;
        state.turbo = true;
        if (rinfo) startRankedMatch(rinfo);
        else showTournamentScreen();
      } else {
        state.turbo = true;
        startBasicMatch(state.lineup, seed === null ? undefined : seed);
      }
    } else if (screen === 'tournament') {
      createTournament(state.lineup, seed === null ? undefined : seed);
      if (AUTOPLAY) autoplayTournament();
      showTournamentScreen();
    } else if (screen === 'roster') {
      showRosterScreen();
    } else {
      goHome();
    }
  }

  function unlockMusicOnce() {
    if (!window.BallAudio) return;
    try {
      if (BallAudio.init) BallAudio.init();
      if (BallAudio.unlock) BallAudio.unlock();
    } catch (e) {}
    if (state.screen === 'battle') music('battle');
    else if (state.screen !== 'result') music('lobby');
  }

  function boot() {
    if (!G) { fatal('数据层 js/data.js 加载失败'); return; }
    if (!window.BallSim) { fatal('仿真层 js/sim.js 加载失败'); return; }
    if (!window.BallTournament) { fatal('赛程逻辑 js/tournament.js 加载失败'); return; }
    if (!window.BallUI) { fatal('界面层 js/ui.js 加载失败'); return; }

    state.reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    window.addEventListener('ballpit:reducedmotion', function (ev) {
      if (ev && ev.detail && typeof ev.detail.reduced === 'boolean') state.reducedMotion = ev.detail.reduced;
    });
    state.muted = params.get('mute') === '1';
    var sp = Number(params.get('speed') || '1');
    state.speed = (sp === 0.5 || sp === 1 || sp === 2) ? sp : 1;

    if (window.BallAudio) { try { BallAudio.setMuted(state.muted); } catch (e) {} }

    BallUI.init({
      data: G,
      initialLineup: state.lineup,
      minLineup: RULES.minLineup || 2,
      maxLineup: RULES.maxLineup || 8,
      onEnterArena: function (selection) { unlockAudio(); enterArena(selection); },
      onHome: function () { goHome(); },
      onStart: function (lineup, sel) {
        unlockAudio();
        if (sel) {
          state.mode = validMode(sel.mode || state.mode);
          state.map = validMap(sel.map || state.map);
          state.mechanisms = sanitizeMechanisms(sel.mechanisms || state.mechanisms);
        }
        if (state.mode === 'ranked') {
          var ranked = sanitizeLineup(lineup, 'ranked');
          if (ranked.length !== 8) { toast('排位赛需要正好 8 颗球'); return; }
          state.lineup = ranked;
          if (createTournament(ranked, undefined)) showTournamentScreen();
        } else {
          state.lineup = sanitizeLineup(lineup, 'basic');
          startBasicMatch(state.lineup, undefined);
        }
      },
      onExit: function () { exitBattle(); },
      onPauseToggle: function () { togglePause(); },
      onSpeedChange: function (speed) { setSpeed(speed); },
      onMuteToggle: function (muted) { unlockAudio(); setMuted(muted); },
      onRematch: function () {
        unlockAudio();
        if (state.mode === 'ranked' && state.tournament) { showTournamentScreen(); return; }
        startBasicMatch(state.lineup, undefined);
      },
      onNewLineup: function () {
        if (state.mode === 'ranked') {
          state.lineup = sanitizeLineup(state.lineup, 'ranked');
          showRosterScreen();
        } else {
          showRosterScreen();
        }
      },
      onTournamentMatch: function (matchId) { unlockAudio(); onTournamentMatch(matchId); },
      onTournamentReturn: function () { showTournamentScreen(); },
      onPlayAgainTournament: function () {
        var old = state.tournament;
        if (!old) { goHome(); return; }
        if (createTournament(old.getLineup(), randomSeed())) showTournamentScreen();
      },
      onChangelogRefresh: function () { loadChangelog(true); },
      onChangelogPick: function () { pickChangelogFile(); }
    });
    BallUI.setSpeed(state.speed);
    BallUI.setMuted(state.muted);

    loadChangelog(false);
    routeFromParams();

    ['pointerdown', 'touchstart', 'keydown'].forEach(function (evt) {
      window.addEventListener(evt, unlockAudio, { once: true, passive: true });
    });
    window.addEventListener('resize', function () {
      if (state.rendererReady) { try { BallRenderer.resize(); } catch (e) {} }
    });
    document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', unlockMusicOnce, { once: true, capture: true });
  document.addEventListener('keydown', unlockMusicOnce, { once: true, capture: true });

    window.BALLPIT = {
      get state() { return state; },
      get match() { return state.match; },
      get snapshot() { return state.lastSnapshot || (state.match && state.match.getSnapshot()); },
      get tournament() { return state.tournament; },
      get activeMatch() { return state.activeMatch; },
      startBasic: startBasicMatch,
      startTournamentMatch: onTournamentMatch,
      autoplayTournament: autoplayTournament,
      showTournament: showTournamentScreen,
      showHome: goHome,
      enterArena: enterArena,
      loadChangelog: loadChangelog,
      pickChangelog: pickChangelogFile,
      setSpeed: setSpeed,
      setMuted: setMuted,
      skipIntro: function () {
        state.intro = false;
        state.introT = 0;
        state.countdown = null;
        if (window.BallUI) BallUI.setCountdown(null);
      },
      advance: function (seconds) {
        if (!state.match || state.screen !== 'battle') return;
        state.intro = false;
        state.introT = 0;
        state.countdown = null;
        if (window.BallUI) BallUI.setCountdown(null);
        var steps = Math.min(30000, Math.round((Number(seconds) || 0) / FIXED_DT));
        for (var i = 0; i < steps && state.match.status !== 'over'; i++) state.match.step(FIXED_DT);
        var evs = state.match.drainEvents();
        if (evs.length) {
          if (state.rendererReady) { try { BallRenderer.pushEvents(evs); } catch (e) {} }
          mapEvents(evs);
        }
        var snap = state.match.getSnapshot();
        state.lastSnapshot = snap;
        if (window.BallUI) {
          BallUI.updateBattle(snap, { paused: state.paused, speed: state.speed, muted: state.muted, countdown: null, intro: false });
        }
        if (state.rendererReady) {
          try {
            BallRenderer.render(snap, { dt: 0, paused: false, intro: false, fps: state.fps, speed: state.speed, stormLevel: snap.stormLevel || 0 });
          } catch (e) {}
        }
        if (state.match.status === 'over') finishBattle();
        return snap.time;
      },
      ui: window.BallUI,
      data: G
    };

    state.lastFrame = performance.now();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
