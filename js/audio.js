/* ============================================================
 * 斗球场 BALL PIT v0.4 — WebAudio 合成音效 + 音乐播放口
 * window.BallAudio = { init, unlock, setMuted, setVolume, getVolume,
 *                      play(name), setMusicSources, playMusic, stopMusic,
 *                      setMusicVolume, getMusicVolume }
 * 无 AudioContext / 自动播放受限时静默降级，绝不抛错。
 * 音效全部用振荡器 + 噪声实时合成；音乐不内置音频文件，
 * 读取 GameData.MUSIC_SLOTS 的 src（lobby / battle / suddenDeath），src 为空时静默。
 * ============================================================ */
(function (root) {
  'use strict';

  var MASTER = 0.18;          // 总音量（克制）

  var A = {
    ctx: null,
    master: null,
    noiseBuf: null,
    muted: false,
    volume: 1,
    inited: false,
    failed: false,
    last: {}
  };

  /* 音乐播放口（v0.3）：不内置音频，只认 GameData.MUSIC_SLOTS 里填的 src */
  var M = {
    slots: {},          // id -> src
    current: '',        // 当前播放 key
    currentSlot: '',     // lobby / battle
    currentTrack: '',    // 实际曲目 id
    lobbyTracks: [],     // 大厅可选曲目
    lobbyTrack: '',      // 当前大厅曲目
    el: null,           // HTMLAudioElement
    volume: 0.6,        // 音乐音量（0..1，默认克制）
    failed: false,      // 没有 Audio 构造 / 播放被拒
    defaultsLoaded: false
  };

  /* ---------- 基础工具 ---------- */
  function getCtor() {
    return root.AudioContext || root.webkitAudioContext || null;
  }

  function ctxNow() {
    return A.ctx ? A.ctx.currentTime : 0;
  }

  function safe(fn) {
    try { return fn(); } catch (e) { return null; }
  }

  function init() {
    if (A.ctx || A.failed) return A.ctx;
    if (A.inited) return A.ctx;
    A.inited = true;
    var C = getCtor();
    if (!C) { A.failed = true; return null; }
    return safe(function () {
      A.ctx = new C();
      A.master = A.ctx.createGain();
      A.master.gain.value = A.muted ? 0 : MASTER * A.volume;
      A.master.connect(A.ctx.destination);
      return A.ctx;
    }) || (function () { A.failed = true; return null; })();
  }

  function unlock() {
    var ctx = init();
    if (!ctx) return false;
    safe(function () {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        var p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    });
    // 用户手势解锁后，如果之前请求过音乐但被自动播放策略拦下，这里重试一次
    if (M.current && M.el && M.el.paused) {
      safe(function () {
        var p = M.el.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      });
    }
    return true;
  }

  function setMuted(muted) {
    A.muted = !!muted;
    if (!A.master) return;
    safe(function () {
      var target = A.muted ? 0 : MASTER * A.volume;
      if (A.ctx && A.ctx.currentTime !== undefined && A.master.gain.setTargetAtTime) {
        A.master.gain.setTargetAtTime(target, A.ctx.currentTime, 0.03);
      } else {
        A.master.gain.value = target;
      }
    });
    applyMusicVolume();
  }

  /* 音量（0..1，设置页滑块用；null/非法值按 0 处理） */
  function setVolume(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    A.volume = Math.max(0, Math.min(1, n));
    if (!A.master) return;
    safe(function () {
      var target = A.muted ? 0 : MASTER * A.volume;
      if (A.ctx && A.ctx.currentTime !== undefined && A.master.gain.setTargetAtTime) {
        A.master.gain.setTargetAtTime(target, A.ctx.currentTime, 0.03);
      } else {
        A.master.gain.value = target;
      }
    });
  }

  function getVolume() { return A.volume; }

  /* ---------- 音乐播放口（v0.3） ----------
   * 用法（main.js）：
   *   BallAudio.setMusicSources(GameData.MUSIC_SLOTS);
   *   BallAudio.playMusic('lobby' / 'battle' / 'suddenDeath');
   *   BallAudio.stopMusic(); BallAudio.setMusicVolume(0..1);
   * 没有 src、没有 Audio 构造、被自动播放策略拦截 → 全部静默，不抛错。
   */
  function parseMusicSources(slots) {
    var out = { slots: {}, tracks: [] };
    if (!slots) return out;
    if (Array.isArray(slots)) {
      for (var i = 0; i < slots.length; i++) {
        var sl = slots[i];
        if (!sl) continue;
        var id = sl.id || sl.trackId || sl.slot || sl.name;
        if (!id) continue;
        var src = typeof sl.src === 'string' ? sl.src : '';
        out.slots[id] = src;
        if (sl.slot === 'lobby' || /^lobby[_-]/.test(id)) {
          out.tracks.push({ id: id, name: sl.name || id, src: src, default: !!sl.default });
        }
      }
      return out;
    }
    for (var k in slots) {
      if (!Object.prototype.hasOwnProperty.call(slots, k)) continue;
      var v = slots[k];
      out.slots[k] = (typeof v === 'string') ? v : (v && typeof v.src === 'string' ? v.src : '');
    }
    return out;
  }

  function pickLobbyTrack(preferred) {
    var tracks = M.lobbyTracks || [];
    if (preferred) {
      for (var i = 0; i < tracks.length; i++) if (tracks[i].id === preferred && tracks[i].src) return tracks[i].id;
    }
    for (var j = 0; j < tracks.length; j++) if (tracks[j].default && tracks[j].src) return tracks[j].id;
    for (var k = 0; k < tracks.length; k++) if (tracks[k].src) return tracks[k].id;
    return tracks.length ? tracks[0].id : '';
  }

  function mergeMusicSources(incoming) {
    var defaults = parseMusicSources(root.GameData && root.GameData.MUSIC_SLOTS);
    var merged = {};
    var id;
    for (id in defaults.slots) merged[id] = defaults.slots[id];
    for (id in incoming.slots) merged[id] = incoming.slots[id];
    M.slots = merged;
    var tracks = incoming.tracks.length ? incoming.tracks : defaults.tracks;
    M.lobbyTracks = tracks;
    M.lobbyTrack = pickLobbyTrack(M.lobbyTrack);
  }

  function setMusicSources(slots) {
    M.defaultsLoaded = true;
    mergeMusicSources(parseMusicSources(slots));
    if (M.currentSlot) {
      var trackId = M.currentSlot === 'lobby' ? M.lobbyTrack : M.currentTrack;
      var src = M.slots[trackId];
      if (!src) stopMusic();
      else if (M.el && M.el.getAttribute && M.el.getAttribute('src') !== src) {
        var playing = M.currentSlot;
        stopMusic();
        playMusic(playing);
      }
    }
    return getMusicSources();
  }

  function getMusicSources() {
    var out = {};
    for (var id in M.slots) out[id] = M.slots[id];
    return out;
  }

  function getLobbyTracks() {
    return (M.lobbyTracks || []).map(function (t) { return { id: t.id, name: t.name, src: t.src }; });
  }

  function getLobbyTrack() { return M.lobbyTrack || ''; }

  function setLobbyTrack(id) {
    var trackId = String(id || '');
    var src = M.slots[trackId];
    if (!src) return false;
    var isLobbyTrack = false;
    for (var i = 0; i < M.lobbyTracks.length; i++) if (M.lobbyTracks[i].id === trackId) isLobbyTrack = true;
    if (!isLobbyTrack) return false;
    M.lobbyTrack = trackId;
    if (M.currentSlot === 'lobby') {
      stopMusic();
      playMusic('lobby');
    }
    return true;
  }

  function musicGain() {
    if (A.muted) return 0;
    return Math.max(0, Math.min(1, M.volume)) * 0.6;   // 音乐比音效更轻一点
  }

  function applyMusicVolume() {
    if (!M.el) return;
    safe(function () { M.el.volume = musicGain(); });
  }

  function stopMusic() {
    if (M.el) {
      safe(function () {
        M.el.pause();
        M.el.currentTime = 0;
      });
    }
    M.el = null;
    M.current = '';
    M.currentSlot = '';
    M.currentTrack = '';
    return true;
  }

  function playMusic(slot) {
    if (!M.defaultsLoaded && root.GameData && root.GameData.MUSIC_SLOTS) {
      setMusicSources(root.GameData.MUSIC_SLOTS);
    }
    var id = '';
    if (slot && typeof slot === 'object') id = slot.id || slot.slot || slot.name || '';
    else if (slot != null) id = String(slot);
    if (!id) { stopMusic(); return false; }
    if (id === 'suddenDeath') id = 'battle';
    var slotId = id;
    var trackId = id;
    if (id === 'lobby' || /^lobby[_-]/.test(id)) {
      slotId = 'lobby';
      trackId = (id === 'lobby') ? M.lobbyTrack : id;
      if (!M.slots[trackId]) trackId = pickLobbyTrack(M.lobbyTrack);
    } else if (id === 'battle') {
      slotId = 'battle';
      trackId = 'battle';
    }
    var src = M.slots[trackId];
    if (!src) { stopMusic(); return false; }
    var key = slotId + ':' + trackId;
    if (M.current === key && M.el) {
      safe(function () {
        if (M.el.paused) {
          var p2 = M.el.play();
          if (p2 && typeof p2.catch === 'function') p2.catch(function () {});
        }
        M.el.loop = true;
        M.el.volume = musicGain();
      });
      return true;
    }
    var Ctor = root.Audio || root.HTMLAudioElement || null;
    if (!Ctor) { M.failed = true; return false; }
    stopMusic();
    var el = null;
    try { el = new Ctor(src); } catch (e) { el = null; }
    if (!el) { M.failed = true; return false; }
    M.el = el;
    M.current = key;
    M.currentSlot = slotId;
    M.currentTrack = trackId;
    safe(function () {
      el.loop = true;
      el.preload = 'auto';
      el.volume = musicGain();
      var p = el.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    });
    return true;
  }

  function setMusicVolume(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    M.volume = Math.max(0, Math.min(1, n));
    applyMusicVolume();
    return M.volume;
  }

  function getMusicVolume() { return M.volume; }

  function ensureNoise() {
    var ctx = A.ctx;
    if (!ctx || A.noiseBuf) return A.noiseBuf;
    var len = Math.max(1, Math.floor((ctx.sampleRate || 44100) * 0.6));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate || 44100);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    A.noiseBuf = buf;
    return buf;
  }

  /* 单个振荡器音：类型 / 起止频率 / 时长 / 音量 */
  function tone(type, f0, f1, dur, gain, delay, dest) {
    var ctx = A.ctx;
    if (!ctx || !A.master) return;
    var t0 = ctx.currentTime + 0.001 + (delay || 0);
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(Math.max(24, f0), t0);
    if (f1 && f1 !== f0) {
      safe(function () {
        osc.frequency.exponentialRampToValueAtTime(Math.max(24, f1), t0 + dur);
      });
    }
    var peak = Math.max(0.0002, gain || 0.15);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.012, dur * 0.35));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(dest || A.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  /* 噪声爆：滤波类型 / 中心频率 / Q / 时长 / 音量 */
  function noiseBurst(type, freq, q, dur, gain, delay, dest) {
    var ctx = A.ctx;
    var buf = ensureNoise();
    if (!ctx || !A.master || !buf) return;
    var t0 = ctx.currentTime + 0.001 + (delay || 0);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var f = ctx.createBiquadFilter();
    f.type = type || 'bandpass';
    f.frequency.setValueAtTime(Math.max(40, freq || 800), t0);
    f.Q.value = q || 0.9;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain || 0.2), t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest || A.master);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }

  /* ---------- 各音效 ---------- */
  var GAPS = {
    click: 0.025, bounce: 0.04, hit: 0.03, cast: 0.05,
    heal: 0.06, death: 0.08, tick: 0.02, start: 0.2, win: 0.2,
    thunder: 0.06, gravity: 0.15, venom: 0.08,
    explode: 0.05
  };

  var SFX = {
    /* 按钮点击：短促方波 */
    click: function () {
      tone('square', 920, 760, 0.035, 0.14);
      noiseBurst('bandpass', 2400, 1.6, 0.02, 0.08);
    },

    /* 撞墙：低频闷响 + 噪声擦碰 */
    bounce: function () {
      var p = 0.9 + Math.random() * 0.2;
      tone('triangle', 210 * p, 120 * p, 0.07, 0.24);
      noiseBurst('bandpass', 950 * p, 1.2, 0.035, 0.13);
    },

    /* 命中：噪声冲击 + 下坠方波 */
    hit: function () {
      var p = 0.9 + Math.random() * 0.25;
      noiseBurst('bandpass', 1400 * p, 0.8, 0.055, 0.3);
      tone('square', 175 * p, 88 * p, 0.075, 0.15);
    },

    /* 施法：上扬锯齿 + 高频微光 */
    cast: function () {
      tone('sawtooth', 250, 740, 0.16, 0.13);
      tone('sine', 520, 1180, 0.15, 0.06);
      noiseBurst('highpass', 2600, 0.7, 0.09, 0.05);
    },

    /* 治疗：三级上行正弦 */
    heal: function () {
      tone('sine', 523, 523, 0.15, 0.1, 0);
      tone('sine', 659, 659, 0.15, 0.09, 0.055);
      tone('sine', 784, 784, 0.2, 0.08, 0.11);
    },

    /* 死亡：低频爆裂 + 下坠 */
    death: function () {
      noiseBurst('lowpass', 820, 0.9, 0.4, 0.32);
      tone('sawtooth', 185, 42, 0.38, 0.18);
      tone('square', 92, 40, 0.3, 0.09);
    },

    /* 倒计时滴答 */
    tick: function () {
      tone('square', 1080, 1080, 0.028, 0.1);
      noiseBurst('highpass', 3400, 1.2, 0.015, 0.04);
    },

    /* 开打：三音上行 + 一声重音 */
    start: function () {
      tone('triangle', 523, 523, 0.11, 0.16, 0);
      tone('triangle', 659, 659, 0.11, 0.16, 0.09);
      tone('triangle', 880, 880, 0.2, 0.18, 0.18);
      noiseBurst('bandpass', 1800, 0.7, 0.14, 0.08, 0.18);
    },

    /* 胜利：小号式琶音 + 收尾和弦 */
    win: function () {
      var seq = [523, 659, 784, 1047, 1319];
      for (var i = 0; i < seq.length; i++) {
        tone('triangle', seq[i], seq[i], 0.22, 0.13, i * 0.09);
        tone('sine', seq[i] / 2, seq[i] / 2, 0.22, 0.05, i * 0.09);
      }
      tone('triangle', 1047, 1047, 0.5, 0.1, 0.5);
      tone('sine', 1568, 1568, 0.5, 0.06, 0.5);
      noiseBurst('highpass', 3000, 0.6, 0.3, 0.04, 0.5);
    },

    /* 天雷（特斯拉）：高频撕裂 + 落地轰响（克制，不炸耳） */
    thunder: function () {
      var p = 0.92 + Math.random() * 0.16;
      noiseBurst('highpass', 4200 * p, 0.7, 0.12, 0.18);
      noiseBurst('bandpass', 1500 * p, 0.9, 0.06, 0.14, 0.01);
      tone('sawtooth', 240 * p, 55 * p, 0.22, 0.12, 0.01);
      tone('square', 96 * p, 40 * p, 0.3, 0.08, 0.02);
    },

    /* 引力井：下潜的低频漩涡 */
    gravity: function () {
      tone('sine', 260, 62, 0.55, 0.12);
      tone('triangle', 130, 48, 0.6, 0.07, 0.03);
      noiseBurst('lowpass', 420, 0.8, 0.4, 0.06);
    },

    /* 地雷爆炸（v0.4）：低频闷响 + 短促爆裂，克制不炸耳 */
    explode: function () {
      var p = 0.9 + Math.random() * 0.2;
      noiseBurst('lowpass', 900 * p, 0.8, 0.22, 0.26);
      tone('sine', 130 * p, 46 * p, 0.24, 0.2);
      tone('square', 78 * p, 40 * p, 0.16, 0.07, 0.01);
      noiseBurst('bandpass', 2400 * p, 1.1, 0.06, 0.1);
    },

    /* 巫医毒伤回复：比 heal 更闷、更短的一口回气 */
    venom: function () {
      tone('sine', 392, 392, 0.1, 0.07, 0);
      tone('sine', 523, 523, 0.12, 0.06, 0.05);
      tone('triangle', 196, 262, 0.16, 0.05, 0.02);
      noiseBurst('lowpass', 700, 0.9, 0.09, 0.03);
    }
  };

  function play(name) {
    if (A.muted || A.failed || !A.ctx || !A.master) return;
    var fn = SFX[name];
    if (!fn) return;
    var t = ctxNow();
    var gap = GAPS[name] || 0.03;
    if (A.last[name] && t - A.last[name] < gap) return;
    A.last[name] = t;
    safe(function () { fn(); });
  }

  root.BallAudio = {
    init: init,
    unlock: unlock,
    setMuted: setMuted,
    setVolume: setVolume,
    getVolume: getVolume,
    play: play,
    /* 音乐播放口（v0.3，无内置音频） */
    setMusicSources: setMusicSources,
    getMusicSources: getMusicSources,
    getLobbyTracks: getLobbyTracks,
    getLobbyTrack: getLobbyTrack,
    setLobbyTrack: setLobbyTrack,
    playMusic: playMusic,
    stopMusic: stopMusic,
    setMusicVolume: setMusicVolume,
    getMusicVolume: getMusicVolume
  };
})(typeof self !== 'undefined' ? self : this);
