// Formatting for the settings page (BYOK PRD §9.5 usage lines, §7.3 cost
// preview, UX-1 state words, §8.2 key promises). Pure functions that return
// plain strings; the page puts them on screen with textContent only. A classic
// script, so tests load it in a vm context.
(function (root) {
  'use strict';

  var CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

  /** A display string: controls and direction marks removed, length capped. */
  function clean(s, max) {
    var t = String(s == null ? '' : s).replace(CTRL, '');
    var n = max || 240;
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  function fixed(n, d) { return Number(n).toFixed(d); }

  /**
   * A whole sentence with named placeholders (docs/STYLE.md §12), so no line is built from
   * pieces: fill('{ai} is out of credit.', { ai: 'Claude' }). A placeholder with no value stays
   * as it is, so a missing name shows up in a test instead of vanishing.
   */
  function fill(template, vars) {
    return String(template).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, function (m, k) {
      return vars && vars[k] != null ? String(vars[k]) : m;
    });
  }

  /** Dollars → "$1.00". */
  function usd(dollars) {
    var n = Number(dollars);
    if (!isFinite(n)) return '—';
    return '$' + fixed(n, 2);
  }

  /** Integer micro-dollars → "$0.18", "$0.0043", "under $0.0001", "$0.00" (money measured has cents, STYLE §8; UX-W37). */
  function usdMicros(micros) {
    var m = Number(micros);
    if (!isFinite(m)) return '—';
    if (m === 0) return '$0.00';
    var d = m / 1e6;
    if (d < 0.0001) return 'under $0.0001';
    if (d < 0.01) return fixed(d * 100, d * 100 < 0.1 ? 2 : 1) + '¢';
    return '$' + fixed(d, 2);
  }

  function centsText(c) {
    var n = Number(c);
    return n < 0.1 ? fixed(n, 2) : fixed(n, 1);
  }
  function range(lo, hi, fmt) {
    var a = fmt(lo);
    var b = fmt(hi);
    return a === b ? a : a + '–' + b;
  }

  /**
   * The cost preview (§16.1 step 6): "about 0.4–0.9¢ a reply · about
   * $0.17–0.37 a day at 40 replies". Free and local models say so, in S3's words (strings.js cost.*;
   * bones-ux-writer onboarding r3, UX-W35).
   */
  function costPreview(hint, platform) {
    if (!hint) return '';
    if (typeof hint === 'string') return clean(hint, 120);
    if (hint.free) return t('cost.free', { n: hint.perDay || 50 }, platform);
    if (hint.local) return t('cost.local', null, platform);
    if (hint.plan) return t('cost.plan', null, platform);
    if (!hint.replyCents) return '';
    var rc = hint.replyCents;
    var parts = [t('cost.replyLine', { cents: range(rc[0], rc[1], centsText) }, platform)];
    if (hint.dayUsd) {
      var dd = hint.dayUsd;
      parts.push(t('cost.dayLine', { range: range(dd[0], dd[1], function (v) { return fixed(v, 2); }), n: hint.at || 40 }, platform));
    }
    return parts.join(' · ');
  }

  /**
   * A typical day with a model (§7.3's 40 typed replies, from the price table the
   * bridge computed the hint from): "$0.17–0.37", "$0" for free and local models,
   * or '' when the model has no price.
   */
  function dayCost(hint) {
    if (!hint || typeof hint !== 'object') return '';
    if (hint.free || hint.local || hint.plan) return '$0';
    if (!Array.isArray(hint.dayUsd)) return '';
    return '$' + range(hint.dayUsd[0], hint.dayUsd[1], function (v) { return fixed(v, 2); });
  }

  /**
   * The bar's usage line (§9.5; strings.js bar.*): "$0.18 today" (no limit, the default), "$0.18 of
   * $1.00 today" with a daily spend limit the player set, free models "Free: 12 of 50 today", a
   * model on this computer "On this computer · localhost:11434 · qwen3:8b". Each is one table line
   * with named placeholders (STYLE §12).
   */
  function usageLine(usage, provider, platform) {
    if (provider && provider.auth === 'local') return t('bar.usageLocal', { app: clean(provider.name, 60), model: clean(provider.modelName || provider.model, 40) }, platform);
    if (!usage) return '';
    var spent = Number(usage.spentMicros) || 0;
    if (usage.freeLimit != null && spent === 0) return t('bar.usageFree', { used: usage.freeUsed || 0, limit: usage.freeLimit }, platform);
    if (usage.capMicros == null) return t('bar.usageSpent', { amount: usdMicros(spent) }, platform);
    return t('bar.usageOfLimit', { amount: usdMicros(spent), limit: usdMicros(usage.capMicros) }, platform);
  }

  /** Accepts a status() result or a bare rt ({state, reason, retryIn}). */
  function asStatus(x) {
    if (x && x.backend) return x;
    return { backend: { rt: x || {} } };
  }

  /**
   * What the window and the tray say the bridge is doing: the bridge's one vocabulary
   * (bridge/byok/status-view.mjs), which every status the window gets carries as status.view
   * ({key, words, tone, needsPlayer, sending, checkIns, screen}; the shell adds it to a status that
   * lacks one). No table of words here (systems plan SY-06/D5). {} while nothing is known yet.
   */
  function viewOf(x) {
    var s = asStatus(x);
    return s.view && typeof s.view === 'object' ? s.view : {};
  }
  function viewKey(status) { return viewOf(status).key || null; }
  // A status with no words yet: the table's (bar.workingLine, bar.startingLine; UX-W30).
  function stateWords(x) { var v = viewOf(x); return clean(v.words || t(v.key ? 'bar.workingLine' : 'bar.startingLine'), 80); }
  function stateTone(x) { return viewOf(x).tone || 'muted'; }
  /** True while the player has something to fix (the tray's attention icon). */
  function needsPlayer(status) { return viewOf(status).needsPlayer === true; }

  /** Pull the parts out of a status() result, whichever way the backend nests them. */
  function parts(status) {
    var b = (status && status.backend) || {};
    return {
      rt: b.rt || {}, provider: b.provider || null, usage: b.usage || null, notice: b.notice || null, lastError: b.lastError || null, view: viewOf(status),
      wow: (status && status.wow) || {}, capture: (status && status.capture) || {},
      bridge: (status && status.bridge) || {}, mock: !!(status && status.mock),
    };
  }

  function tokens(n) {
    var v = Number(n);
    if (!isFinite(v)) return '—';
    return v >= 1000 ? fixed(v / 1000, 1) + 'k' : String(Math.round(v));
  }
  function bytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return fixed(v / 1024, 1) + ' KB';
    return fixed(v / 1024 / 1024, 1) + ' MB';
  }

  // Dates and times in the player's own locale (Intl), with a fixed fallback.
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  var fmtCache = {};
  function fmt(key, opts, locale) {
    var id = key + '|' + (locale || '');
    if (!Object.prototype.hasOwnProperty.call(fmtCache, id)) {
      try { fmtCache[id] = new Intl.DateTimeFormat(locale || undefined, opts); } catch (e) { fmtCache[id] = null; }
    }
    return fmtCache[id];
  }
  function timeText(ts, locale) {
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '—';
    var f = fmt('time', { hour: 'numeric', minute: '2-digit' }, locale);
    return f ? f.format(d) : pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  // One date form on every page (STYLE §8; bones-ux-writer onboarding r4, UX-W40): short month and
  // day, the year only when it isn't this year. now: the moment "this year" is from (tests pass one).
  function otherYear(d, now) { return d.getFullYear() !== new Date(now == null ? Date.now() : Number(now)).getFullYear(); }
  var DAY = { month: 'short', day: 'numeric' };
  var DAY_Y = { year: 'numeric', month: 'short', day: 'numeric' };
  var DAY_TIME = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  var DAY_TIME_Y = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  /** A date and time in a table or a label's value: "Sep 27, 2:05 PM"; another year's "Jan 4, 2027, 2:05 PM". */
  function dateTimeText(ts, locale, now) {
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '—';
    var y = otherYear(d, now);
    var f = fmt(y ? 'datetimeY' : 'datetime', y ? DAY_TIME_Y : DAY_TIME, locale);
    return f ? f.format(d) : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  /** A local day, "2026-09-26" → "Sep 26" (another year's "Sep 26, 2025"), in the player's locale. */
  function dayText(ymd, locale, now) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd == null ? '' : ymd));
    if (!m) return clean(ymd, 10);
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    var y = otherYear(d, now);
    var f = fmt(y ? 'dayY' : 'day', y ? DAY_Y : DAY, locale);
    return f ? f.format(d) : m[0];
  }
  /** A time in a table of events: the time alone today ("4:58 PM"), else with its date ("Sep 27, 4:58 PM"). */
  function whenText(ts, locale, now) {
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '—';
    var n = new Date(now == null ? Date.now() : Number(now));
    var today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return today ? timeText(ts, locale) : dateTimeText(ts, locale, now);
  }

  function storeName(platform) {
    if (platform === 'win32') return 'Windows Credential Manager';
    if (platform === 'darwin') return 'your macOS Keychain';
    return 'the Secret Service';
  }
  /** Where a key is saved, as the player finds it (the key store's service name, bridge/byok/security/keystore.mjs). */
  var KEY_SERVICE = 'NeverQuestAlone';
  /** What the keychain does and doesn't protect, per OS (§8.2). */
  function keyPromises(platform) {
    var out = ['Your key never enters the game.', 'We never see your key. Check Connections.'];
    if (platform === 'darwin') {
      out.unshift('Other accounts on this Mac can’t read it. macOS will ask before another app reads it.');
    } else {
      out.unshift('Other accounts on this PC can’t read it. Programs you run can read it, like any saved password. Keep a spend limit on your key.');
      if (platform === 'win32') out.push('On a work PC with a roaming profile, the key roams with you.');
    }
    return out;
  }
  /** A key store that wouldn't save or read, per OS (D-02): the table's whole sentence for each (common.keyStore). */
  function keyStoreLine(platform, reading) {
    var os = platform === 'win32' ? 'Win' : platform === 'darwin' ? '' : 'Linux';
    return t('common.keyStore.' + (reading ? 'readLine' : 'saveLine') + os, null, platform);
  }


  // -------------------------------------------------------------------------
  // The strings table (renderer/strings.js, window.BonesStrings; docs/STYLE.md): every setup
  // sentence by id, whole, filled here. Nothing builds a sentence from pieces (STYLE §12).

  var has = Object.prototype.hasOwnProperty;
  var plurals = null;
  function pluralKey(n) {
    try { plurals = plurals || new Intl.PluralRules('en'); return plurals.select(Number(n)); } catch (e) { return Number(n) === 1 ? 'one' : 'other'; }
  }
  /** The table's entry at a dotted id ("connectResult.ok.headline"), or undefined. */
  function lookup(id) {
    var node = root.BonesStrings;
    var parts = String(id == null ? '' : id).split('.');
    for (var i = 0; i < parts.length; i++) {
      if (!node || typeof node !== 'object' || !has.call(node, parts[i])) return undefined;
      node = node[parts[i]];
    }
    return node;
  }
  /** An {os:…} label as this OS shows it (common.osTokens); a label with no row shows as written. */
  function osLabel(label, platform) {
    var rows = lookup('common.osTokens') || {};
    var row = has.call(rows, label) ? rows[label] : null;
    return row && typeof row === 'object' && typeof row[platform] === 'string' ? row[platform] : label;
  }
  /** True when the table has a string (or a plural) at id. */
  function hasString(id) {
    var s = lookup(id);
    return typeof s === 'string' || (!!s && typeof s === 'object' && (typeof s.one === 'string' || typeof s.other === 'string'));
  }
  /**
   * t('connectResult.ok.headline', { ai: 'Claude' }, 'darwin') → "Claude is connected.". A plural
   * ({one, other}) is picked by vars.count; {os:X} is X as the OS shows it, {game:X} the game's X;
   * then fill(). An id the table doesn't have shows as ⟦id⟧, so a test catches it.
   */
  function t(id, vars, platform) {
    var s = lookup(id);
    if (s && typeof s === 'object' && (typeof s.one === 'string' || typeof s.other === 'string')) {
      var k = pluralKey(vars && vars.count);
      s = typeof s[k] === 'string' ? s[k] : s.other;
    }
    if (typeof s !== 'string') return '⟦' + id + '⟧';
    return render(s, vars, platform);
  }
  /** A template the way t() fills a table string: {os:…} and {game:…} labels, then fill(). */
  function render(template, vars, platform) {
    var p = platform || 'darwin';
    var s = String(template).replace(/\{os:([^}]+)\}/g, function (m, label) { return osLabel(label, p); })
      .replace(/\{game:([^}]+)\}/g, function (m, label) { return label; });
    return fill(s, vars);
  }

  /** Where keys are kept, as the table's {store} says it: "your macOS Keychain", "Windows Credential Manager". */
  function storeText(platform) {
    if (platform === 'win32') return 'Windows Credential Manager';
    if (platform === 'darwin') return 'your macOS Keychain';
    return 'the Secret Service';
  }

  /** "A, B or C" (no serial comma, STYLE §3), for {ais} and {companies}. */
  function listOr(items) {
    var xs = (items || []).filter(function (x) { return x != null && x !== ''; }).map(String);
    if (xs.length < 2) return xs.join('');
    return xs.slice(0, -1).join(', ') + ' or ' + xs[xs.length - 1];
  }

  function cents2(v) { return '$' + fixed(v, 2); }
  /**
   * A day's cost range from the price table's dayUsd ([low, high]): the low end to the nearest
   * cent, the high end rounded up (STYLE §8: "$0.17–0.37"). → {text, low, high} or null.
   */
  function dayRange(dayUsd) {
    if (!Array.isArray(dayUsd) || dayUsd.length < 2) return null;
    var lo = Number(dayUsd[0]);
    var hi = Number(dayUsd[1]);
    if (!isFinite(lo) || !isFinite(hi) || hi <= 0) return null;
    lo = Math.max(0.01, Math.round(lo * 100) / 100);
    hi = Math.max(lo, Math.ceil(hi * 100 - 1e-9) / 100);
    var low = cents2(lo);
    var high = cents2(hi);
    return { text: lo === hi ? low : low + '–' + fixed(hi, 2), low: low, high: high };
  }

  /** Darwin's major version from os.release() ("24.1.0" → 24), or NaN. */
  function darwinMajor(osRelease) { return parseInt(String(osRelease == null ? '' : osRelease).split('.')[0], 10); }
  /** The Screen Recording pane's name on this Mac ({pane}): Darwin 24 (macOS 15) and later, else macOS 14's. */
  function paneName(osRelease) {
    var major = darwinMajor(osRelease);
    return isFinite(major) && major > 0 && major < 24 ? 'sayHi.permission.paneName.mac14' : 'sayHi.permission.paneName.mac15';
  }
  /** The Login Items pane's name on this Mac ({loginPane}): "Login Items & Extensions" from macOS 15 (Darwin 24). */
  function loginPaneName(osRelease) {
    var major = darwinMajor(osRelease);
    return isFinite(major) && major > 0 && major < 24 ? 'sayHi.loginPaneName.mac14' : 'sayHi.loginPaneName.mac15';
  }
  /** A date as the tables' {date}: short month and day in the player's locale ("Oct 1"). */
  function monthDayText(ts, locale) {
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '—';
    var f = fmt('monthday', { month: 'short', day: 'numeric' }, locale);
    return f ? f.format(d) : (d.getMonth() + 1) + '/' + d.getDate();
  }
  /** 00:00 UTC on the 1st of the month after now: when a monthly limit resets. */
  function nextMonthUtc(now) {
    var d = new Date(Number(now) || Date.now());
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }

  var api = {
    KEY_SERVICE: KEY_SERVICE, clean: clean, fill: fill, viewOf: viewOf, usd: usd, usdMicros: usdMicros, costPreview: costPreview, dayCost: dayCost,
    usageLine: usageLine, viewKey: viewKey, stateWords: stateWords, stateTone: stateTone, needsPlayer: needsPlayer, parts: parts, tokens: tokens,
    bytes: bytes, timeText: timeText, dateTimeText: dateTimeText, dayText: dayText, whenText: whenText, storeName: storeName, keyPromises: keyPromises,
    keyStoreLine: keyStoreLine,
    t: t, render: render, hasString: hasString, storeText: storeText, listOr: listOr, dayRange: dayRange, paneName: paneName,
    loginPaneName: loginPaneName, monthDayText: monthDayText, nextMonthUtc: nextMonthUtc,
  };
  root.BonesFormat = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
