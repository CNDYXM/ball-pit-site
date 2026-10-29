/* ============================================================
 * 斗球场 BALL PIT — 排位赛赛程逻辑 js/tournament.js
 * 8 球单败淘汰：八强 4 场 → 半决赛 2 场 → 季军赛 1 场 → 决赛 1 场
 * 纯逻辑：零 DOM、零异步、零 Math.random（全部确定性）
 * 浏览器挂 window.BallTournament；Node 可 require
 * v0.4：排位赛每场 2 球使用 arenaScale 0.86（data 驱动）；时间上限 300s / 速胜 60s；
 *       sim 能量/召唤物/新地图规则不影响赛程逻辑，judged 胜者直接采用。
 *       小球 ID B0001–B0010（旧 ID 仅作迁移别名）；ballInfo 去 archetype/species、加 tags。
 * v0.4.4：版本号同步 data 0.4.4（赛程逻辑不变，蜜蜂寿命/爆炸半径/三角 sizeScale 均由 sim/data 处理）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./data.js'));
  } else {
    root.BallTournament = factory(root.GameData);
  }
})(typeof self !== 'undefined' ? self : this, function (GameData) {
  'use strict';

  if (!GameData || !GameData.BALL_BY_ID) {
    throw new Error('[BallTournament] 需要先加载 js/data.js');
  }

  var VERSION = '0.4.4';
  var SIZE = 8;

  var ROUNDS = [
    { id: 'qf', name: '八强赛', en: 'QUARTERFINALS' },
    { id: 'sf', name: '半决赛', en: 'SEMIFINALS' },
    { id: 'bronze', name: '季军赛', en: 'THIRD PLACE' },
    { id: 'final', name: '决赛', en: 'FINAL' }
  ];
  var ROUND_BY_ID = {};
  ROUNDS.forEach(function (r) { ROUND_BY_ID[r.id] = r; });

  /* ---------------- 工具 ---------------- */
  function mulberry32(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeed(seed, tag) {
    var h = (seed ^ 0x811C9DC5) >>> 0;
    var s = String(tag || '');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h || 0x51ED270B) >>> 0;
  }

  function ballInfo(id) {
    if (!id) return null;
    var b = GameData.BALL_BY_ID[id];
    if (!b) return null;
    return {
      ballId: b.id, name: b.name, en: b.en,
      color: b.color, color2: b.color2,
      tags: Array.isArray(b.tags) ? b.tags.slice() : [], look: b.look
    };
  }

  /* v1.2：旧 ID 只作迁移别名，内部统一 B0001–B0010 */
  function normalizeBallId(raw) {
    var id = String(raw == null ? '' : raw).trim();
    if (GameData.BALL_BY_ID[id]) return id;
    var map = GameData.LEGACY_ID_MAP || {};
    if (map[id] && GameData.BALL_BY_ID[map[id]]) return map[id];
    return id;
  }

  function shuffle(list, rnd) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }

  /* ============================================================
   * create
   * ============================================================ */
  function create(options) {
    options = options || {};
    var lineupInput = options.lineup;
    if (!Array.isArray(lineupInput) || lineupInput.length !== SIZE) {
      throw new Error('[BallTournament] 排位赛阵容必须是 ' + SIZE + ' 个球');
    }
    var lineup = [], seen = Object.create(null);
    for (var i = 0; i < lineupInput.length; i++) {
      var id = normalizeBallId(lineupInput[i]);
      if (!GameData.BALL_BY_ID[id]) throw new Error('[BallTournament] 未知球 id "' + id + '"');
      if (seen[id]) throw new Error('[BallTournament] 球 id 重复 "' + id + '"');
      seen[id] = 1;
      lineup.push(id);
    }
    var map = options.map === 'circle' ? 'circle' : 'square';
    var seed = options.seed;
    if (seed === undefined || seed === null || !isFinite(Number(seed))) {
      seed = (Date.now() >>> 0);
    }
    seed = Number(seed) >>> 0;

    var rnd = mulberry32(hashSeed(seed, 'draw'));
    var slots = shuffle(lineup, rnd);

    /* ---- 建立 8 场比赛 ---- */
    var matches = [];
    var byId = Object.create(null);

    function makeMatch(id, roundId, index, a, b, from) {
      var m = {
        id: id,
        roundId: roundId,
        index: index,
        a: a || null,
        b: b || null,
        from: from || null,     // [{matchId, type:'winner'|'loser'}]
        winnerId: null,
        loserId: null,
        done: false,
        score: null,
        seed: hashSeed(seed, id)
      };
      matches.push(m);
      byId[id] = m;
      return m;
    }

    for (var q = 0; q < 4; q++) {
      makeMatch('qf' + (q + 1), 'qf', q + 1, slots[q * 2], slots[q * 2 + 1]);
    }
    makeMatch('sf1', 'sf', 1, null, null, [
      { matchId: 'qf1', type: 'winner' }, { matchId: 'qf2', type: 'winner' }
    ]);
    makeMatch('sf2', 'sf', 2, null, null, [
      { matchId: 'qf3', type: 'winner' }, { matchId: 'qf4', type: 'winner' }
    ]);
    makeMatch('bronze', 'bronze', 1, null, null, [
      { matchId: 'sf1', type: 'loser' }, { matchId: 'sf2', type: 'loser' }
    ]);
    makeMatch('final', 'final', 1, null, null, [
      { matchId: 'sf1', type: 'winner' }, { matchId: 'sf2', type: 'winner' }
    ]);

    /* ---- 内部查询 ---- */
    function m(id) { return byId[id] || null; }

    function matchStatus(mm) {
      if (!mm) return 'locked';
      if (mm.done) return 'done';
      if (mm.a && mm.b) return 'ready';
      return 'locked';
    }

    function pendingDependents(finishedId) {
      var out = [];
      for (var i = 0; i < matches.length; i++) {
        var mm = matches[i];
        if (mm.done || !mm.from) continue;
        for (var j = 0; j < mm.from.length; j++) {
          if (mm.from[j].matchId === finishedId) { out.push(mm); break; }
        }
      }
      return out;
    }

    function propagate(finished) {
      var winners = pendingDependents(finished.id);
      for (var i = 0; i < winners.length; i++) {
        var mm = winners[i];
        for (var slot = 0; slot < 2; slot++) {
          var dep = mm.from[slot];
          if (!dep || dep.matchId !== finished.id) continue;
          var value = dep.type === 'winner' ? finished.winnerId : finished.loserId;
          if (slot === 0) mm.a = value; else mm.b = value;
        }
      }
    }

    function statOf(result, ballId, key) {
      var st = result && result.stats ? result.stats[ballId] : null;
      if (st && isFiniteNum(st[key])) return st[key];
      var standings = result && result.standings;
      if (Array.isArray(standings)) {
        for (var i = 0; i < standings.length; i++) {
          if (standings[i].ballId === ballId) {
            if (isFiniteNum(standings[i][key])) return standings[i][key];
            if (key === 'hpPct' && isFiniteNum(standings[i].hpPct)) return standings[i].hpPct;
          }
        }
      }
      return 0;
    }

    function resolveDraw(mm, result) {
      // 平局：输出 > 施法 > 剩余生命 > 先手顺序
      var aScore = statOf(result, mm.a, 'dealt') * 1000 + statOf(result, mm.a, 'casts') * 10 + statOf(result, mm.a, 'hpPct');
      var bScore = statOf(result, mm.b, 'dealt') * 1000 + statOf(result, mm.b, 'casts') * 10 + statOf(result, mm.b, 'hpPct');
      if (aScore !== bScore) return aScore > bScore ? mm.a : mm.b;
      return mm.a;
    }

    function viewMatch(mm) {
      var st = matchStatus(mm);
      var round = ROUND_BY_ID[mm.roundId];
      return {
        id: mm.id,
        roundId: mm.roundId,
        roundName: round.name,
        roundEn: round.en,
        index: mm.index,
        label: round.name + ' · 第 ' + mm.index + ' 场',
        status: st,
        playable: st === 'ready',
        a: ballInfo(mm.a),
        b: ballInfo(mm.b),
        winnerId: mm.winnerId,
        loserId: mm.loserId,
        judged: !!(mm.done && mm.score && mm.score.judged),
        score: mm.score,
        seed: mm.seed
      };
    }

    function buildRoundsView() {
      var out = [];
      for (var r = 0; r < ROUNDS.length; r++) {
        var round = ROUNDS[r];
        var arr = [];
        for (var i = 0; i < matches.length; i++) {
          if (matches[i].roundId === round.id) arr.push(viewMatch(matches[i]));
        }
        out.push({ id: round.id, name: round.name, en: round.en, matches: arr });
      }
      return out;
    }

    function doneCount() {
      var n = 0;
      for (var i = 0; i < matches.length; i++) if (matches[i].done) n++;
      return n;
    }

    function isComplete() { return doneCount() === matches.length; }

    function nextReadyMatchId() {
      for (var i = 0; i < matches.length; i++) {
        if (!matches[i].done && matchStatus(matches[i]) === 'ready') return matches[i].id;
      }
      return null;
    }

    function currentRound() {
      for (var r = 0; r < ROUNDS.length; r++) {
        var round = ROUNDS[r];
        for (var i = 0; i < matches.length; i++) {
          var mm = matches[i];
          if (mm.roundId === round.id && !mm.done) return round;
        }
      }
      return null;
    }

    /* ---- 排名 ---- */
    function computeRankings() {
      if (!isComplete()) return [];
      var finalM = m('final'), bronzeM = m('bronze');
      var rows = [];
      var place = 1;

      function push(ballId, note, wins, losses, heal, dealt) {
        var ball = GameData.BALL_BY_ID[ballId];
        rows.push({
          place: place++,
          ballId: ballId,
          name: ball ? ball.name : ballId,
          en: ball ? ball.en : '',
          color: ball ? ball.color : '#FFF4DC',
          color2: ball ? ball.color2 : '#FFF4DC',
          tags: ball && Array.isArray(ball.tags) ? ball.tags.slice() : [],
          note: note,
          wins: wins || 0,
          losses: losses || 0,
          heal: isFiniteNum(heal) ? heal : 0,
          dealt: isFiniteNum(dealt) ? dealt : 0   // v0.4.4：全部场次总输出（主指标）
        });
      }

      function record(ballId) {
        var w = 0, l = 0, heal = 0, dealt = 0;
        for (var i = 0; i < matches.length; i++) {
          if (matches[i].winnerId === ballId) w++;
          if (matches[i].loserId === ballId) l++;
          var sc = matches[i].score;
          if (sc && sc.heal && isFiniteNum(sc.heal[ballId])) heal += sc.heal[ballId];
          if (sc && sc.dealt && isFiniteNum(sc.dealt[ballId])) dealt += sc.dealt[ballId];
        }
        return { wins: w, losses: l, heal: heal, dealt: dealt };
      }

      // 1 / 2
      var recFinalW = record(finalM.winnerId);
      var recFinalL = record(finalM.loserId);
      push(finalM.winnerId, '冠军', recFinalW.wins, recFinalW.losses, recFinalW.heal, recFinalW.dealt);
      push(finalM.loserId, '亚军', recFinalL.wins, recFinalL.losses, recFinalL.heal, recFinalL.dealt);
      // 3 / 4
      var recBronzeW = record(bronzeM.winnerId);
      var recBronzeL = record(bronzeM.loserId);
      push(bronzeM.winnerId, '季军', recBronzeW.wins, recBronzeW.losses, recBronzeW.heal, recBronzeW.dealt);
      push(bronzeM.loserId, '第 4 名', recBronzeL.wins, recBronzeL.losses, recBronzeL.heal, recBronzeL.dealt);

      // 5–8：八强赛负者，按当场输出 > 施法 > 存活时长排序
      var qfLosers = [];
      for (var i = 0; i < matches.length; i++) {
        var mm = matches[i];
        if (mm.roundId !== 'qf') continue;
        var sc = mm.score || {};
        qfLosers.push({
          ballId: mm.loserId,
          dealt: sc.dealt && isFiniteNum(sc.dealt[mm.loserId]) ? sc.dealt[mm.loserId] : 0,
          casts: sc.casts && isFiniteNum(sc.casts[mm.loserId]) ? sc.casts[mm.loserId] : 0,
          duration: isFiniteNum(sc.duration) ? sc.duration : 0,
          order: mm.index
        });
      }
      qfLosers.sort(function (x, y) {
        if (y.dealt !== x.dealt) return y.dealt - x.dealt;
        if (y.casts !== x.casts) return y.casts - x.casts;
        if (y.duration !== x.duration) return y.duration - x.duration;
        return x.order - y.order;
      });
      for (var k = 0; k < qfLosers.length; k++) {
        var rec = record(qfLosers[k].ballId);
        push(qfLosers[k].ballId, '止步八强', rec.wins, rec.losses, rec.heal, rec.dealt);
      }
      return rows;
    }

    /* ---- 公开 API ---- */
    function getView() {
      var championId = m('final').winnerId;
      var round = currentRound();
      return {
        mode: 'ranked',
        version: VERSION,
        seed: seed,
        map: map,
        mapName: GameData.MAP_BY_ID && GameData.MAP_BY_ID[map] ? GameData.MAP_BY_ID[map].name : map,
        mapShape: GameData.MAP_BY_ID && GameData.MAP_BY_ID[map] ? GameData.MAP_BY_ID[map].shape : 'square',
        lineup: lineup.slice(),
        complete: isComplete(),
        size: SIZE,
        totalMatches: matches.length,
        done: doneCount(),
        currentRoundId: round ? round.id : 'done',
        currentRoundName: round ? round.name : '已结束',
        nextMatchId: nextReadyMatchId(),
        rounds: buildRoundsView(),
        champion: ballInfo(championId),
        rankings: isComplete() ? computeRankings() : []
      };
    }

    function startMatch(matchId) {
      var mm = m(matchId);
      if (!mm) return null;
      if (matchStatus(mm) !== 'ready') return null;
      var round = ROUND_BY_ID[mm.roundId];
      return {
        matchId: mm.id,
        roundId: mm.roundId,
        roundName: round.name,
        roundEn: round.en,
        label: round.name + ' · 第 ' + mm.index + ' 场',
        index: mm.index,
        a: mm.a,
        b: mm.b,
        seed: mm.seed,
        map: map
      };
    }

    function report(matchId, result) {
      var mm = m(matchId);
      if (!mm) throw new Error('[BallTournament] 未知场次 ' + matchId);
      if (mm.done) throw new Error('[BallTournament] 场次已结束 ' + matchId);
      if (matchStatus(mm) !== 'ready') throw new Error('[BallTournament] 场次尚未就绪 ' + matchId);
      result = result || {};

      var winnerId = result.winnerId;
      var drawResolved = false;
      if (winnerId !== mm.a && winnerId !== mm.b) {
        winnerId = resolveDraw(mm, result);
        drawResolved = true;
      }
      var loserId = winnerId === mm.a ? mm.b : mm.a;
      var duration = isFiniteNum(result.duration) ? result.duration : 0;

      mm.winnerId = winnerId;
      mm.loserId = loserId;
      mm.done = true;
      mm.score = {
        duration: duration,
        drawResolved: drawResolved,
        judged: !!result.judged,
        dealt: { a: statOf(result, mm.a, 'dealt'), b: statOf(result, mm.b, 'dealt') },
        taken: { a: statOf(result, mm.a, 'taken'), b: statOf(result, mm.b, 'taken') },
        casts: { a: statOf(result, mm.a, 'casts'), b: statOf(result, mm.b, 'casts') },
        heal: { a: statOf(result, mm.a, 'heal'), b: statOf(result, mm.b, 'heal') },
        hpPct: { a: statOf(result, mm.a, 'hpPct'), b: statOf(result, mm.b, 'hpPct') }
      };
      // 同时提供按球 id 索引的字段，方便 UI 直接按 ballId 取值
      [mm.a, mm.b].forEach(function (bid) {
        mm.score.dealt[bid] = statOf(result, bid, 'dealt');
        mm.score.taken[bid] = statOf(result, bid, 'taken');
        mm.score.casts[bid] = statOf(result, bid, 'casts');
        mm.score.heal[bid] = statOf(result, bid, 'heal');
        mm.score.hpPct[bid] = statOf(result, bid, 'hpPct');
      });

      propagate(mm);
      var complete = isComplete();
      var view = getView();
      return {
        ok: true,
        match: viewMatch(mm),
        drawResolved: drawResolved,
        judged: !!result.judged,
        winnerId: winnerId,
        loserId: loserId,
        tournamentComplete: complete,
        nextMatchId: view.nextMatchId,
        champion: view.champion,
        rankings: view.rankings,
        view: view
      };
    }

    var tournament = {
      version: VERSION,
      seed: seed,
      map: map,
      lineup: lineup.slice(),
      matches: matches,
      getView: getView,
      startMatch: startMatch,
      report: report,
      isComplete: isComplete,
      getMatch: function (id) { var mm = m(id); return mm ? viewMatch(mm) : null; },
      getSeed: function () { return seed; },
      getMap: function () { return map; },
      getLineup: function () { return lineup.slice(); }
    };
    return tournament;
  }

  return {
    VERSION: VERSION,
    SIZE: SIZE,
    ROUNDS: ROUNDS,
    create: create
  };
});
