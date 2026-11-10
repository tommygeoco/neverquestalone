// NeverQuestAlone's window: Bones's companion panel on the left, the one decision on the stage
// (the redesign's build spec, "the companion panel", 2026-09-30; BYOK PRD §16 flows, §8.4
// Connections and Last request, §9.5 usage, §10 errors, §13 privacy, §11.5 updates).
//
// Text only: every string reaches the screen as a text node or textContent, never as HTML, so
// model output, memory notes, game text and provider errors can't become markup. The page talks to
// the main process only through window.nqa (preload.cjs); each call is checked there, and saving a
// key, setting, raising or turning off the daily spend limit, switching AI or connecting another
// service (Other) shows a native confirm. The public build has no limits of its own: usage is
// information, and the only limit is one the player may set on Your AI.
//
// Click, never hover: nothing appears, dims or folds by itself. Layout changes only on a click or a
// real event (a key's test result, the addon's hello). Results show after the click that caused
// them and stay; notices have Okay. A state that needs the player is the one card on Home, with the
// fix one click away (elsewhere Bones's pill and line and the nav's dot point there), and it stays
// while the state holds.
//
// Bones lives only in the panel: the Dock icon's glass skull, lit in game and unlit otherwise, a button to Home
// whose name is his state's word.
//
// Keyboard and screen readers: a redraw keeps focus on the same control (by id, or by its data-fk
// key); a page or setup step change puts focus on the new heading; results and state cards are read
// out through one polite live region (#live) outside the page. The Details sheet traps focus and
// gives it back to Show details when it closes.
(function () {
  'use strict';

  var B = window.nqa;
  var F = window.BonesFormat;
  var $app = document.getElementById('app');
  var $page = document.getElementById('page');
  var $banners = document.getElementById('banners');
  var $live = document.getElementById('live');
  var $top = document.getElementById('topbar');
  var $sheet = document.getElementById('sheet-host');
  if (!B || !F) {
    // The table's line when it loaded; these words when even it didn't.
    var BS = window.BonesStrings;
    $page.textContent = (BS && BS.errors && BS.errors.windowFailed) || 'NeverQuestAlone couldn’t start this window.';
    return;
  }

  // -------------------------------------------------------------------------
  // DOM, text only.

  var PROPS = { value: 1, checked: 1, disabled: 1, selected: 1, readOnly: 1, hidden: 1 };
  var ATTRS = {
    id: 1, type: 1, for: 1, name: 1, placeholder: 1, autocomplete: 1, spellcheck: 1, inputmode: 1, min: 1, max: 1,
    step: 1, role: 1, tabindex: 1, title: 1, maxlength: 1, colspan: 1, scope: 1, autocapitalize: 1,
  };

  function add(el, kids) {
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k == null || k === false) continue;
      if (Array.isArray(k)) { add(el, k); continue; }
      el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return el;
  }

  /**
   * An element's handlers live in a list on the element (el.__on) behind one listener per event type,
   * so a redraw that keeps the element (patchNode) gives it the new render's handlers. A handler runs
   * with this = the element on screen, never a node from a render that was thrown away.
   */
  function hook(el, type) {
    var hooked = el.__hooked || (el.__hooked = {});
    if (hooked[type]) return;
    hooked[type] = true;
    el.addEventListener(type, function (e) {
      var list = el.__on && el.__on[type];
      if (!list) return;
      for (var i = 0; i < list.length; i++) list[i].call(el, e);
    });
  }
  function on(el, type, fn) {
    var hs = el.__on || (el.__on = {});
    (hs[type] || (hs[type] = [])).push(fn);
    hook(el, type);
  }

  /** h('p', { class, text, onClick, ... }, ...children). Strings become text nodes. */
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (k === 'class') { if (v) el.className = v; return; }
        if (k === 'text') { el.textContent = v == null ? '' : String(v); return; }
        if (k.slice(0, 2) === 'on' && typeof v === 'function') { on(el, k.slice(2).toLowerCase(), v); return; }
        // The properties a render sets are the ones a redraw carries over (patchNode).
        if (PROPS[k]) { el[k] = v; (el.__props || (el.__props = {}))[k] = true; return; }
        if (v == null || v === false) return;
        if (ATTRS[k] || k.slice(0, 5) === 'data-' || k.slice(0, 5) === 'aria-') el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    return add(el, Array.prototype.slice.call(arguments, 2));
  }

  // -------------------------------------------------------------------------
  // Redraws that keep what's there. A redraw of the page it's on patches the tree in place, node by
  // node, instead of swapping it: the control under the pointer, the focus, a text selection and a
  // screen reader's place all survive a status push. Children pair up in order by tag and key
  // (data-key, data-fk or data-row); what doesn't pair is swapped. A kept node takes the new one's
  // attributes, the properties its render set, its handlers and its children.

  function keyOf(n) {
    if (n.nodeType !== 1) return n.nodeType === 3 ? '#text' : '#node';
    return n.tagName + '|' + (n.getAttribute('data-key') || n.getAttribute('data-fk') || n.getAttribute('data-row') || '');
  }
  var HELD_ATTRS = { 'aria-busy': 1, 'aria-disabled': 1 };
  function patchNode(a, b) {
    if (a.nodeType === 3) { if (a.data !== b.data) a.data = b.data; return; }
    // A button whose call is still running keeps its hold (busy()); what the new render says for it
    // applies once the call is done.
    var held = !!a.__held;
    if (held) a.__want = { 'aria-busy': b.getAttribute('aria-busy'), 'aria-disabled': b.getAttribute('aria-disabled') };
    var gone = a.getAttributeNames();
    for (var i = 0; i < gone.length; i++) if (!(held && HELD_ATTRS[gone[i]]) && !b.hasAttribute(gone[i])) a.removeAttribute(gone[i]);
    var names = b.getAttributeNames();
    for (var j = 0; j < names.length; j++) {
      if (held && HELD_ATTRS[names[j]]) continue;
      var v = b.getAttribute(names[j]);
      if (a.getAttribute(names[j]) !== v) a.setAttribute(names[j], v);
    }
    var props = {};
    [a.__props, b.__props].forEach(function (p) { if (p) Object.keys(p).forEach(function (k) { props[k] = 1; }); });
    Object.keys(props).forEach(function (k) { if (a[k] !== b[k]) a[k] = b[k]; });
    a.__props = b.__props || null;
    a.__on = b.__on || null;
    if (a.__on) Object.keys(a.__on).forEach(function (t) { hook(a, t); });
    patchKids(a, b);
  }
  function patchKids(a, b) {
    var next = Array.prototype.slice.call(b.childNodes);
    var cur = a.firstChild;
    for (var i = 0; i < next.length; i++) {
      var n = next[i];
      var k = keyOf(n);
      var m = cur;
      while (m && keyOf(m) !== k) m = m.nextSibling;
      if (m) {
        while (cur !== m) { var drop = cur; cur = cur.nextSibling; a.removeChild(drop); }
        patchNode(m, n);
        cur = m.nextSibling;
      } else {
        a.insertBefore(n, cur);
      }
    }
    while (cur) { var rest = cur; cur = cur.nextSibling; a.removeChild(rest); }
  }

  /** A button that isn't ready says so: aria-disabled (it keeps focus), a click does nothing. */
  function blocked(el) { return !el || el.disabled || el.getAttribute('aria-disabled') === 'true'; }
  /** The element a handler runs on (this), else the one the render made. */
  function live(self, made) { return self && self.nodeType === 1 ? self : made; }
  /** A decorative line icon (icons/*.svg as a mask in style.css), never read out. */
  function ico(name, cls) { return h('span', { class: 'ico ico-' + name + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' }); }
  /**
   * A button. Its data-fk (the label, or extra.fk when the label changes with its state) is how
   * focus finds it again after a redraw. extra.icon: a leading icon; extra.after: an icon after
   * the label (an arrow out for a web page); extra.kbd: a key hint inside.
   */
  function btn(label, onClick, cls, extra) {
    var props = { type: 'button', class: cls || 'btn', 'data-fk': label };
    var b;
    props.onClick = function (e) { if (!blocked(live(this, b)) && onClick) onClick.call(live(this, b), e); };
    var icon = null;
    var after = null;
    var kbd = null;
    var hideLabel = false;
    if (extra) {
      Object.keys(extra).forEach(function (k) {
        if (k === 'fk') props['data-fk'] = extra[k];
        else if (k === 'icon') icon = extra[k];
        else if (k === 'hideLabel') hideLabel = !!extra[k];
        else if (k === 'after') after = extra[k];
        else if (k === 'kbd') kbd = extra[k];
        else props[k] = extra[k];
      });
    }
    b = h('button', props, icon ? ico(icon) : null, h('span', { class: 'btn-label' + (hideLabel ? ' sr-only' : ''), text: label }), after ? ico(after, 'ico-after') : null,
      kbd ? h('kbd', { 'aria-hidden': 'true', text: kbd }) : null);
    return b;
  }
  function primary(label, onClick, extra) { return btn(label, onClick, 'btn btn-primary', extra); }
  function quiet(label, onClick, extra) { return btn(label, onClick, 'btn btn-quiet', extra); }
  function small(label, onClick, extra) { return btn(label, onClick, 'btn btn-quiet btn-sm', extra); }
  function ghost(label, onClick, extra) { return btn(label, onClick, 'btn-ghost', extra); }
  /**
   * Back: an icon button (‹) at the head of the page's title row, on the column's left edge, the same
   * control as Show details at its end (the owner, 2026-10-02: "‹ Back" in the title strip floated).
   * Its name is the label (Back, Back to setup), said and shown on hover.
   */
  function backBtn(label, onClick, extra) {
    return btn(label, onClick, 'btn-ghost btn-icon btn-back', Object.assign({ icon: 'back', hideLabel: true, title: label }, extra || {}));
  }
  function linkBtn(label, onClick, extra) { return btn(label, onClick, 'btn-link', Object.assign({ after: 'out' }, extra || {})); }
  function openLink(id, extra) {
    var payload = { id: id };
    if (extra) Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });
    return function () { B.openLink(payload); };
  }
  var uid = 0;
  function nid(prefix) { uid += 1; return prefix + '-' + uid; }
  function row() { return h('div', { class: 'row' }, Array.prototype.slice.call(arguments)); }
  function para(text, cls) { return h('p', { class: cls || null, text: text }); }
  /**
   * A line whose prices, masked keys, sizes and commands never break across lines: its text as text
   * nodes, with a span.nowrap around each "$0.17–0.37", "sk-ant-…A1b2", "5.2 GB" and "/nqa ask next".
   */
  var WHOLE = /\$\d[\d.,]*(?:–\d[\d.,]*)?|[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8})*-…[A-Za-z0-9]{1,6}|\d+(?:\.\d+)?[\s\u00a0](?:GB|MB)\b|\/nqa(?: [a-z]+){1,2}/g;
  function keepWhole(text) {
    var t = String(text == null ? '' : text);
    var out = [];
    var at = 0;
    var m;
    WHOLE.lastIndex = 0;
    while ((m = WHOLE.exec(t))) {
      if (m.index > at) out.push(t.slice(at, m.index));
      out.push(h('span', { class: 'nowrap', text: m[0] }));
      at = m.index + m[0].length;
    }
    if (at < t.length) out.push(t.slice(at));
    return out;
  }
  /** A whole string with one part of it kept on one line ("$0.38–0.57 a day"): [before, span.nowrap, after]. */
  function nowrapPart(text, part) {
    var t = String(text == null ? '' : text);
    var at = part ? t.indexOf(part) : -1;
    if (at < 0) return [t];
    return [t.slice(0, at), h('span', { class: 'nowrap', text: part }), t.slice(at + part.length)].filter(function (x) { return x !== ''; });
  }
  /** A page's heading: focus goes here on every page or step change. */
  function title(text, cls) { return h('h1', { id: 'page-title', class: cls || null, tabindex: '-1', text: text }); }
  /** A small label (mono, small caps: the one game nod the type allows). */
  function label(text, cls) { return h('span', { class: 'label' + (cls ? ' ' + cls : ''), text: text }); }
  /** Data, not words: stat values, hosts, keys, JSON, quotes (the word count leaves them out). */
  function data(tag, props) { var p = Object.assign({ 'data-count': 'data' }, props || {}); return h.apply(null, [tag, p].concat(Array.prototype.slice.call(arguments, 2))); }
  function kv(pairs) {
    var dl = h('dl', { class: 'kv' });
    pairs.forEach(function (p) {
      if (!p) return;
      add(dl, [h('dt', { text: p[0] }), h('dd', { class: p[2] || null, 'data-count': p[3] ? 'data' : null, text: p[1] })]);
    });
    return dl;
  }
  /** Numbers each result an action stores, so the same words from a second click are read out again. */
  var seq = 0;
  function stamp(r) { var o = r && typeof r === 'object' ? r : { ok: false }; o.n = ++seq; return o; }
  /** A result line: a tone icon and its words; data-say is what the live region hears. */
  function resultLine(kind, text, stamped, cls) {
    var icon = kind === 'ok' ? 'check' : kind === 'bad' ? 'bad' : kind === 'warn' ? 'warn' : 'info';
    return h('p', { class: 'result result-' + kind + (cls ? ' ' + cls : ''), 'data-say': text, 'data-say-n': stamped && stamped.n ? String(stamped.n) : null },
      ico(icon, 'result-ico'), h('span', null, keepWhole(text)));
  }
  function result(kind, lines, extra, stamped) {
    var ls = lines.filter(Boolean);
    return h('div', { class: 'result-box result-' + kind, 'data-say': ls.join(' '), 'data-say-n': stamped && stamped.n ? String(stamped.n) : null },
      ls.map(function (t, i) { return i ? para(t, 'result-sub') : h('p', { class: 'result result-' + kind }, ico(kind === 'ok' ? 'check' : kind === 'bad' ? 'bad' : kind === 'warn' ? 'warn' : 'info', 'result-ico'), h('span', null, keepWhole(t))); }),
      extra && extra.length ? h('div', { class: 'row' }, extra) : null);
  }
  /**
   * A notice (spec §4.14): one line with Okay, which puts it away for good (onOkay); with no onOkay
   * it goes when its cause does.
   */
  /**
   * A line whose named things (model names, a price) are data spans, as Your AI's rows are: the
   * template filled, with vars[k] for each k in dataKeys wrapped in span[data-count=data].
   */
  function dataLine(id, vars, dataKeys) {
    var mark = {};
    Object.keys(vars).forEach(function (k) { mark[k] = dataKeys.indexOf(k) >= 0 ? '\u0001' + k + '\u0001' : vars[k]; });
    return T(id, mark).split('\u0001').map(function (part, i) { return i % 2 ? data('span', { class: 'nowrap', text: String(vars[part]) }) : part; });
  }
  function notice(kind, text, onOkay, extra, body) {
    var acts = (extra || []).concat(onOkay ? [small(T('common.okayBtn'), onOkay, { fk: 'okay-' + String(text).slice(0, 24) })] : []);
    // A choice (two actions or more) puts them under the words; Okay alone stays on the line.
    return h('div', { class: 'notice notice-' + kind + (acts.length > 1 ? ' notice-stack' : ''), role: 'status', 'data-say': text },
      ico(kind === 'ok' ? 'check' : kind === 'bad' ? 'bad' : kind === 'warn' ? 'warn' : 'info', 'notice-ico'),
      h('p', { class: 'notice-text' }, body || keepWhole(text)),
      acts.length ? h('div', { class: 'notice-acts' }, acts) : null);
  }
  function table(head, rows, numericCols) {
    var nc = numericCols || [];
    return h('table', { class: 'table' },
      h('thead', null, h('tr', null, head.map(function (t, i) { return t ? h('th', { scope: 'col', class: nc.indexOf(i) >= 0 ? 'r' : null, text: t }) : h('td'); }))),
      h('tbody', { 'data-count': 'data' }, rows.map(function (r) {
        return h('tr', null, r.map(function (c, i) { return h('td', { class: nc.indexOf(i) >= 0 ? 'r' : null }, c instanceof Node ? c : String(c == null ? '' : c)); }));
      })));
  }
  /**
   * A block of fixed text. long: it may scroll (max-height in style.css), so it takes focus and the
   * keyboard can scroll it.
   */
  function code(text, long, aria) { return data('pre', { class: 'code', tabindex: long ? '0' : null, 'aria-label': aria || null, text: text }); }
  /** A status chip; a masked key or a price in it never breaks across lines. Always a word. */
  function chip(text, tone) { return h('span', { class: 'chip' + (tone ? ' chip-' + tone : '') }, keepWhole(text)); }
  /** A command, as typed in game, and its Copy (the label says Copied after the click, until the page changes). */
  function cmdChip(cmdText, id) {
    var done = !!S.copied[id];
    var b = btn(done ? T('common.copiedState') : T('common.copyBtn'), null, 'btn btn-quiet btn-sm', { fk: 'copy-' + id, icon: done ? 'check' : 'copy' });
    on(b, 'click', busy(b, function () {
      return B.copyCommand({ id: id }).then(function (r) { if (!isErr(r)) { S.copied[id] = true; rerender(); } });
    }));
    return h('span', { class: 'cmd-row' }, h('code', { class: 'cmd', text: cmdText }), b);
  }

  /**
   * Hold a button while its call runs, so a double click can't send twice. It stays focusable
   * (aria-disabled, not disabled), so focus is still on it when the page redraws.
   */
  function busy(button, fn) {
    return function () {
      var b = live(this, button);
      if (blocked(b) || b.getAttribute('aria-busy') === 'true') return;
      if (document.activeElement === b) S.pendingFocus = focusKey(b);
      b.__held = true;
      b.__want = null;
      b.setAttribute('aria-busy', 'true');
      b.setAttribute('aria-disabled', 'true');
      Promise.resolve().then(function () { return fn(b); }).catch(function () {}).then(function () {
        var want = b.__want || {};
        b.__held = false;
        b.__want = null;
        Object.keys(HELD_ATTRS).forEach(function (k) { if (want[k] != null) b.setAttribute(k, want[k]); else b.removeAttribute(k); });
      });
    };
  }
  function busyBtn(label, fn, cls, extra) {
    var b = btn(label, null, cls || 'btn btn-quiet', extra);
    on(b, 'click', busy(b, fn));
    return b;
  }
  /** A button whose call is running: its busy words, a spinner in place of its key hint. */
  function busyNow(b) { b.setAttribute('aria-busy', 'true'); b.setAttribute('aria-disabled', 'true'); return b; }

  /**
   * A radio group of buttons (the AI rows, the model and thinking options): role radiogroup, roving
   * tabindex, the arrow keys move and pick (spec §2.7, §8.9). items: [{ key, node(checked, tabindex) }].
   */
  function radioGroup(cls, ariaLabel, items, current, onPick) {
    var keys = items.map(function (it) { return it.key; });
    var cur = keys.indexOf(current) >= 0 ? current : keys[0];
    var g = h('div', { class: cls, role: 'radiogroup', 'aria-label': ariaLabel },
      items.map(function (it) {
        var n = it.node(it.key === cur);
        n.setAttribute('role', 'radio');
        n.setAttribute('aria-checked', it.key === cur ? 'true' : 'false');
        n.setAttribute('tabindex', it.key === cur ? '0' : '-1');
        on(n, 'click', function () { if (it.key !== current) onPick(it.key, true); });
        return n;
      }));
    on(g, 'keydown', function (e) {
      var k = e.key;
      var dir = k === 'ArrowDown' || k === 'ArrowRight' ? 1 : k === 'ArrowUp' || k === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      var i = keys.indexOf(cur);
      var next = keys[(i + dir + keys.length) % keys.length];
      onPick(next, false);
    });
    return g;
  }

  // -------------------------------------------------------------------------
  // Focus and the live region.

  /** The containers a focus key is looked for in: the stage's top bar and the page. */
  function keyed() {
    return Array.prototype.slice.call($top.querySelectorAll('[data-fk]')).concat(Array.prototype.slice.call($page.querySelectorAll('[data-fk]')));
  }
  function inScope(el) { return !!el && (($page.contains(el) && el !== $page) || $top.contains(el)); }
  function focusKey(el) {
    if (!inScope(el)) return null;
    if (el.id) return { id: el.id };
    var fk = el.getAttribute && el.getAttribute('data-fk');
    if (!fk) return null;
    var all = keyed();
    var n = 0;
    for (var i = 0; i < all.length; i++) {
      if (all[i] === el) break;
      if (all[i].getAttribute('data-fk') === fk) n += 1;
    }
    return { fk: fk, n: n };
  }
  function findByKey(key) {
    if (!key) return null;
    if (key.id) {
      var e = document.getElementById(key.id);
      return inScope(e) ? e : null;
    }
    var all = keyed();
    var n = 0;
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-fk') !== key.fk) continue;
      if (n === key.n) return all[i];
      n += 1;
    }
    return null;
  }
  function focusEl(el) {
    if (!el || el.disabled) return false;
    try { el.focus({ preventScroll: true }); } catch (e) { return false; }
    if (document.activeElement !== el) return false;
    inView(el);
    return true;
  }
  /** A focused control the page's scroll leaves out of view is brought into it, by the least scroll. */
  function inView(el) {
    var page = document.getElementById('page');
    if (!page || typeof el.getBoundingClientRect !== 'function' || typeof el.scrollIntoView !== 'function' || !page.contains(el)) return;
    var r = el.getBoundingClientRect();
    var p = page.getBoundingClientRect();
    if (!r || !p || !(r.height > 0) || !(p.height > 0)) return;
    if (r.top < p.top || r.bottom > p.bottom) el.scrollIntoView({ block: 'nearest' });
  }
  function focusTitle() { focusEl(document.getElementById('page-title')); }
  function focusAfter(fk) {
    return function () { var el = fk ? findByKey({ fk: fk, n: 0 }) : null; if (!focusEl(el)) focusTitle(); };
  }
  /** Bring a part of the page into view and focus a control in it. */
  function reveal(boxId, fieldId) {
    var box = document.getElementById(boxId);
    if (!box) return;
    if (typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'nearest' });
    var el = (fieldId && document.getElementById(fieldId)) || box.querySelector('[aria-checked="true"]') || box.querySelector('input, select, button');
    if (!focusEl(el)) focusTitle();
  }

  // What's been read out, per area: a result or card is read once when it appears, again only as a
  // new result (its data-say-n) or when its words change. While setup is under way, what it said is
  // remembered across the pages it opens and back.
  var spoken = { page: {}, banners: {} };
  var spokenOn = { page: null, banners: null };
  var setupSaid = {};
  function say(text) {
    var p = document.createElement('p');
    p.textContent = F.clean(text, 400);
    $live.append(p);
    while ($live.childNodes.length > 3) $live.removeChild($live.firstChild);
  }
  function speakNew(root, area) {
    var nodes = root.querySelectorAll('[data-say]');
    var now = {};
    var trip = setupInProgress();
    if (!trip) setupSaid = {};
    for (var i = 0; i < nodes.length; i++) {
      var t = nodes[i].getAttribute('data-say');
      if (!t) continue;
      var k = t + '|' + (nodes[i].getAttribute('data-say-n') || '');
      now[k] = true;
      if (!spoken[area][k] && !(trip && setupSaid[k])) say(t);
      if (trip) setupSaid[k] = true;
    }
    if (spokenOn[area] === S.page) Object.keys(spoken[area]).forEach(function (k) { if (!now[k]) delete setupSaid[k]; });
    spoken[area] = now;
    spokenOn[area] = S.page;
  }

  // -------------------------------------------------------------------------
  // Words.

  /** A string from the table by id, filled, as this OS says it. */
  function T(id, vars) { return F.t(id, vars, platform()); }
  /** An AI's own words from the table (providers.<id>.<key>), or null when it has none. */
  function PT(id, key, vars) {
    var sid = 'providers.' + id + '.' + key;
    return F.hasString(sid) ? T(sid, Object.assign({ name: companion() }, vars || {})) : null;
  }

  // A call's failure where no result of its own says it: the table's words by error code.
  var ERR = {
    bad_amount: function () { return T('usage.badAmountLine'); },
    keystore_error: function () { return F.keyStoreLine(platform()); },
    keystore_denied: function () { return F.keyStoreLine(platform()); },
    keystore_unavailable: function () { return F.keyStoreLine(platform()); },
    no_secret_service: function () { return F.keyStoreLine(platform()); },
  };
  function errWords(code, res) {
    var e = Object.prototype.hasOwnProperty.call(ERR, code) ? ERR[code] : null;
    if (typeof e === 'function') return e(res);
    if (e) return e;
    return code && F.hasString('errors.' + code) ? T('errors.' + code) : null;
  }
  /** Errors whose own detail says it better than a fixed line: the bridge built it from names. */
  var DETAIL_FIRST = { key_mismatch: 1, not_a_key: 1, admin_key: 1, busy: 1, loopback: 1, not_wow: 1 };
  /** Errors whose detail is for diagnostics, never the window. */
  var DETAIL_NEVER = { bad_input: 1, bridge_unavailable: 1, restart_failed: 1, failed: 1, wow_running: 1, install_failed: 1 };
  function errText(res, fallback) {
    if (!res) return fallback || T('errors.failed');
    if (typeof res.headline === 'string' && res.headline) return F.clean([res.headline, res.detail].filter(Boolean).join(' '), 300);
    if (typeof res.line === 'string' && res.line) return F.clean(res.line, 240);
    if (typeof res.detail === 'string' && res.detail && DETAIL_FIRST[res.error]) return F.clean(res.detail, 240);
    var e = errWords(res.error, res);
    if (e) return e;
    if (typeof res.detail === 'string' && res.detail && !DETAIL_NEVER[res.error]) return F.clean(res.detail, 240);
    return fallback || T('errors.failed');
  }
  /** A result's lines: a failure's headline and next step, else one line. */
  function errLines(res, fallback) {
    if (res && typeof res.headline === 'string' && res.headline) return [F.clean(res.headline, 200), F.clean(res.detail, 200)];
    return [errText(res, fallback)];
  }
  function isErr(res) { return !res || res.ok === false; }

  // -------------------------------------------------------------------------
  // State.

  var S = {
    status: null, info: null, appState: null, providers: null, updates: null,
    page: null, demoDismissed: false, setup: null, keyFlow: null, ya: null, capsDraft: null, capsResult: null,
    lastChat: null, memChar: null, open: {}, noticeGone: {}, cardCheck: null, fuseSeen: false, screenSeen: null,
    pendingFocus: null, after: null, sheet: null, copied: {}, settingsResult: {},
  };

  function P() { return F.parts(S.status); }
  function companion() { return F.clean((P().provider && P().provider.companion) || 'NeverQuestAlone', 24); }
  function platform() { return (S.info && S.info.platform) || 'darwin'; }
  function store() { return F.storeName(platform()); }
  function isMac() { return platform() === 'darwin'; }
  function isWin() { return platform() === 'win32'; }
  function modKey() { return isMac() ? '⌘' : 'Ctrl+'; }
  function pasteKbd() { return isMac() ? '⌘V' : 'Ctrl+V'; }
  function providerById(id) { return (S.providers || []).filter(function (p) { return p && p.id === id; })[0] || null; }
  function pname(id) { var p = providerById(id); return p ? F.clean(p.name, 24) : 'your AI company'; }
  function ensureProviders() { return B.providers().then(function (list) { S.providers = Array.isArray(list) ? list : []; return S.providers; }); }
  /** A model on this computer: a local app, or Other at a server here (localhost). */
  function isLocal(id) { var p = providerById(id); return !!p && (p.auth === 'local' || (p.auth === 'custom' && p.local === true)); }
  /** Other (custom): the player's own OpenAI-compatible service; its key comes with its address. */
  function isCustom(id) { var p = providerById(id); return !!p && p.auth === 'custom'; }
  /** Other's service as the bridge saved it ({baseUrl, host, model, local}), or null before it's set. */
  function customOf() { var p = providerById('custom'); return p && p.custom ? p.custom : null; }
  function modelsOf(id) { var p = providerById(id); return p && Array.isArray(p.models) ? p.models : []; }
  function offeredModels(id) { return modelsOf(id).filter(function (m) { return !!m; }); }
  // The thinking levels, cheapest first (the bridge's EFFORT_LEVELS): a model offers the ones its AI
  // company documents (the provider list's efforts), and the window labels them from its table.
  var LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  /** A level's label ("Extra high"); an unknown one is Low's, the default (DB22). */
  function levelLabel(l) { return T('bar.thinkingLevel.' + (LEVELS.indexOf(l) >= 0 ? l : 'low')); }
  /** A model's levels, cheapest first ([] for one without). */
  function levelsOf(m) { return m && Array.isArray(m.efforts) ? m.efforts.filter(function (l) { return LEVELS.indexOf(l) >= 0; }) : []; }
  /** The model's level nearest the one asked for: that one, else the next one up, else its highest (the bridge's nearestEffort). */
  function nearestLevel(levels, want) {
    if (!levels.length) return null;
    if (levels.indexOf(want) >= 0) return want;
    var at = LEVELS.indexOf(want);
    for (var i = 0; i < levels.length; i++) if (LEVELS.indexOf(levels[i]) > at) return levels[i];
    return levels[levels.length - 1];
  }
  function view() { return S.info && S.info.apiMode === 'error' ? 'not_running' : F.viewKey(S.status); }
  /** A model's display name from the provider lists, else its id. */
  function modelName(id) {
    var list = S.providers || [];
    for (var i = 0; i < list.length; i++) {
      var ms = list[i] && Array.isArray(list[i].models) ? list[i].models : [];
      for (var j = 0; j < ms.length; j++) if (ms[j] && ms[j].id === id) return F.clean(ms[j].name || id, 60);
    }
    var cur = P().provider;
    if (cur && cur.model === id && cur.modelName) return F.clean(cur.modelName, 60);
    return F.clean(id, 60);
  }
  // The AIs, as setup shows them (the manifests' display blocks, through providers(): data only).
  function disp(id) { var p = providerById(id); return (p && p.display) || {}; }
  /** Other, once its service is set, is that service by its host (openrouter.ai, localhost:11434). */
  function customName() { var c = customOf(); return c && c.host ? F.clean(c.host, 60) : null; }
  function aiName(id) { if (isCustom(id) && customName()) return customName(); var d = disp(id); return F.clean(d.card || pname(id), 24); }
  function coName(id) { if (isCustom(id) && customName()) return customName(); var d = disp(id); return F.clean(d.maker || pname(id), 24); }
  function namesOf(id, extra) {
    // {co} and {ai} never fill on the local path: its lines name {app} and {model}.
    var v = isLocal(id) ? { name: companion(), app: aiName(id), store: F.storeText(platform()) } : { name: companion(), ai: aiName(id), co: coName(id), store: F.storeText(platform()), testCost: F.usdMicros(14) };
    if (extra) Object.keys(extra).forEach(function (k) { v[k] = extra[k]; });
    return v;
  }
  /** The AIs with a row of their own (Claude, ChatGPT, Grok, Gemini), in the data file's order; hidden ones left out. */
  function cardAis() {
    return (S.providers || []).filter(function (p) { return p && !p.hidden && (p.auth === 'key' || p.auth === 'signin') && p.display && p.display.card; })
      .sort(function (a, b) { return (a.display.order || 0) - (b.display.order || 0); });
  }
  /** A plan that signs in (ChatGPT plan): no key is pasted for it. */
  function isSignin(id) { var p = providerById(id); return !!p && p.auth === 'signin'; }
  function otherShown() { var p = providerById('custom'); return !!p && !p.hidden; }
  function defaultModelOf(id) {
    var ms = modelsOf(id);
    return ms.filter(function (x) { return x && x.tier === 'default'; })[0] || ms[0] || null;
  }
  function modelById(id, mid) { return modelsOf(id).filter(function (m) { return m && m.id === mid; })[0] || null; }
  /** A model's typical day: F.dayRange of its price hint, or null with no price. */
  function dayOf(m) { return m && m.priceHint && Array.isArray(m.priceHint.dayUsd) && !m.priceHint.free ? F.dayRange(m.priceHint.dayUsd) : null; }

  // -------------------------------------------------------------------------
  // Getting to a fix: the page, then the control, in view and focused.

  /** Your AI with the key's Replace open for an AI (Other's form for Other: its key comes with its address). */
  function openFlow(mode, pid) {
    return function () {
      var cur = P().provider;
      var id = pid || (cur ? cur.id : null);
      S.ya = { view: isCustom(id) ? 'custom' : 'main', pick: null, custom: null, replace: !isCustom(id) };
      S.keyFlow = null;
      var show = function () { if (isCustom(id)) reveal('custom-form', 'custom-url'); else reveal('key-row', 'key-field'); };
      if (S.page === 'provider') rerender(false, show); else go('provider', show);
    };
  }
  /** Your AI's picker: every AI, the way step 2 has them. */
  function openChange() {
    S.ya = { view: 'pick', pick: null, custom: null, replace: false };
    S.keyFlow = null;
    if (S.page === 'provider') rerender(true); else go('provider');
  }
  /** Your AI, at the model options, the chosen one focused. */
  function openModelCard() {
    S.ya = { view: 'main', modelOpen: true };
    go('provider', function () { reveal('model-row'); });
  }
  /**
   * Pick a model of the AI in use (cur: its status block): at the Thinking level in use, or the
   * nearest the model has. Your AI's model rows and a retiring model's Use <model> (SY-102-5) alike.
   */
  function chooseModel(cur, mid) {
    var mm = modelById(cur.id, mid) || {};
    return B.choose({ provider: cur.id, model: mid, effort: mm.effort ? (nearestLevel(levelsOf(mm), cur.effort || 'low') || 'low') : null });
  }
  /** A notice's Use <model>: the pick, then Your AI at its models with the result under them, as a pick there shows it. */
  function useModel(cur, mid) {
    return chooseModel(cur, mid).then(function (r) {
      S.ya = { view: 'main', modelOpen: true, chosen: stamp(r || { ok: false }) };
      return refreshStatus().then(function () { go('provider', function () { reveal('model-row'); }); });
    });
  }
  /** Your AI's spending group, at the daily spend limit: its amount focused and selected; with none set, an empty amount opens. */
  function openLimit() {
    var show = function () {
      if (!document.getElementById('cap-dailyUsd') && !S.capsDraft && view() !== 'not_running' && !isLocal((P().provider || {}).id)) {
        S.capsDraft = { value: '' };
        rerender(false, show);
        return;
      }
      reveal('limit-row', 'cap-dailyUsd');
      var el = document.getElementById('cap-dailyUsd');
      if (el && el.select) el.select();
    };
    if (S.page === 'provider' && !(S.ya && S.ya.view && S.ya.view !== 'main')) show(); else { S.ya = null; go('provider', show); }
  }
  /** The window's buttons for a §10 action id (errors.mjs userLine), for provider pid. */
  function fixFor(action, pid) {
    var v = { co: pname(pid), app: pname(pid) };
    switch (action) {
      case 'replace_key': return [btn(T('homeCard.keyInvalid.replaceKeyBtn'), openFlow('key', pid))];
      case 'add_key': return [btn(T('homeCard.noKey.addKeyBtn'), openFlow('key', pid))];
      case 'keys': return S.page === 'provider' ? [] : [btn(T('common.openYourAiBtn'), function () { go('provider'); })];
      case 'add_credit': return isCustom(pid) ? [] : [btn(T('common.addCreditBtn', v), openLink(pid + '.billing'), null, { after: 'out' })];
      case 'provider_limits': return isCustom(pid) ? [] : [btn(T('common.openLimitsBtn', v), openLink(pid + '.limits'), null, { after: 'out' })];
      case 'caps': return [btn(T('homeCard.cap.raiseLimitBtn'), openLimit)];
      case 'pick_model': return [btn(T('homeCard.modelRetired.pickModelBtn'), openModelCard)];
      case 'pick_provider': return [btn(T('common.pickAnotherAiBtn'), openChange, null, { fk: 'pick-ai' })];
      case 'retry': return [];
      case 'connections': return [btn(T('connections.title'), function () { go('connections'); })];
      case 'details': return [btn(T('common.openDiagnosticsBtn'), function () { go('diagnostics'); })];
      // The app's own connections stopped (fix-102): the not-running card's Quit and reopen.
      case 'restart': return [quitReopenBtn()];
      default: return [];
    }
  }
  /** Quit and reopen (D-05): main quits the app and starts it again. */
  function quitReopenBtn(cls) {
    return busyBtn(T('common.notRunning.quitReopenBtn'), function () { return B.relaunch(); }, cls || 'btn', { fk: 'quit-reopen' });
  }

  /** Screen reading's headline: "{name} can’t see the game." for a failure the app can name, else the bridge's words. */
  function screenHead(sc) {
    return !sc.ok && sc.mode === 'screen' && !/unsupported/.test(String(sc.state)) ? T('health.blindHeadline', { name: companion() }) : F.clean(sc.headline, 120);
  }
  /** The button for screen reading's next step, when there's one (status-view.mjs screenView action). */
  function screenFix(sc) {
    switch (sc && sc.action) {
      case 'screen_recording': return [btn(T('sayHi.permission.openSettingsBtn'), openLink('mac.screenRecording'))];
      case 'no_screen_reading': return [readingOffBtn('btn btn-quiet btn-sm')];
      case 'download': return [btn(T('sayHi.startWow.openDownloadBtn'), openLink('releases'), null, { after: 'out' })];
      default: return null;
    }
  }

  // -------------------------------------------------------------------------
  // Bones's panel (spec §5): the portrait's mood, the pill, his one line; then the tracker (setup)
  // or the nav (after setup).

  /** Where setup stands (§3.0 "Done tests"). */
  function setupBlock() { return (S.status && S.status.setup) || {}; }
  /** The AI stage: a key saved for the AI in use (not a no-credit one), a local model, or Other's service. */
  function aiReady() {
    var cur = P().provider;
    if (!cur) return false;
    if (cur.auth === 'local') return true;
    if (isCustom(cur.id)) return !!customOf() && cur.keyState !== 'invalid' && cur.keyState !== 'expired';
    return cur.keyState === 'ok';
  }
  /** The AI in use has a key saved while its account had no credit yet (T1). */
  function noCredit() { var cur = P().provider; return !!cur && cur.keyState === 'no_credit'; }
  /** A saved key its company rejected: never shown as saved, never the primary. */
  function rejectedKey(key) { return !!(key && key.saved && (key.state === 'invalid' || key.state === 'expired')); }
  function aiRejected() {
    var cur = P().provider;
    return !!cur && cur.auth !== 'local' && !!disp(cur.id).card && (cur.keyState === 'invalid' || cur.keyState === 'expired');
  }
  /** Setup is done on the addon's hello (main sets onboarded on it, 2026-10-05) or a first reply (ON-25, OB-23). */
  function setupFinished() { var sb = setupBlock(); return !!(sb.firstReplyAt || (sb.game && sb.game.hello)); }
  /** Setup is under way: not done, and not closed without a saved screen (a player who set up). */
  function setupInProgress() {
    if (setupFinished()) return false;
    var a = S.appState || {};
    return !a.onboarded || !!(a.setup && a.setup.screen);
  }

  /** The state card's cause is one Bones can't answer through (spec §5: "I can’t reach my brain."). */
  var CANT_ANSWER = { no_key: 1, key_invalid: 1, signed_out: 1, out_of_credit: 1, provider_down: 1, local_down: 1, model_retired: 1, last_error: 1, sending_paused: 1 };
  /**
   * Bones's state (spec §5): his mood (happy: in game; idle: joining or catching his breath; needs:
   * something needs you; away: WoW closed, paused or not running), which lights or dims his skull
   * (paintPanel), and its word (always one; spec §4.11). It follows his state, never the page.
   */
  function bonesState() {
    var key = view();
    var p = P();
    var C = function (k) { return T('bones.pill.' + k); };
    if (key === 'not_running') return { mood: 'away', pill: { tone: 'bad', text: C('notRunningChip') } };
    var cardUp = !!(stateModel() || finishModel());
    var cant = CANT_ANSWER[key] || (key === 'no_key') || (cardUp && !aiReady());
    if (S.page === 'setup' && S.setup) {
      var st = S.setup;
      if (st.screen === 'wow' && setupFinished()) return { mood: sayHiNeedsCard() ? 'needs' : 'happy', pill: null };
      if (st.screen === 'wow') {
        if (sayHiNeedsCard()) return { mood: 'needs', pill: null };
        var sb = setupBlock();
        var g = sb.game || {};
        if (sb.firstMsgAt) return { mood: 'idle', pill: null };
        var a = sb.addon || {};
        var permDone = !isMac() || sb.permission === 'granted' || sb.captureState === 'off';
        if (a.state === 'current' && permDone) return { mood: 'idle', pill: null };
        return { mood: 'idle', pill: null };
      }
      if (st.screen === 'welcome') return { mood: 'happy', pill: null };
      return { mood: 'idle', pill: null };
    }
    var paused = p.bridge.paused === true || p.rt.state === 'paused' || key === 'paused';
    if (paused) return { mood: 'away', pill: { tone: 'neutral', text: C('pausedChip') } };
    var needs = { tone: 'needs', text: C('needsYouChip') };
    if (key === 'cap') return { mood: 'needs', pill: needs };
    // A message turned down twice: his line says who, as the card does (CL-player-19).
    var le0 = p.lastError || {};
    if (key === 'last_error' && (le0.kind === 'bad_request' || le0.kind === 'unknown') && !le0.notice && p.provider && !isLocal(p.provider.id)) return { mood: 'needs', pill: needs };
    if (cant) return { mood: 'needs', pill: needs };
    if (p.usage && p.usage.needs === 'near_cap' && key === 'ready') return { mood: 'needs', pill: needs };
    // Chats that can't be saved (code health BR-11): Home's card says it, and his word with it.
    if (p.view.saving && key === 'ready') return { mood: 'needs', pill: needs };
    var running = !!(p.wow && p.wow.running);
    if (key === 'slowed') return { mood: running ? 'idle' : 'away', pill: running ? { tone: 'ok', text: C('inGameChip') } : { tone: 'neutral', text: C('wowClosedChip') } };
    if (!running) return { mood: 'away', pill: { tone: 'neutral', text: C('wowClosedChip') } };
    var cap = p.capture || {};
    if (cap.state && cap.state !== 'ok') return { mood: 'idle', pill: { tone: 'warn', text: C('connectingChip') } };
    // In game his gem is lit (the happy face): the state is in his eye (the owner, 2026-10-02).
    return { mood: 'happy', pill: { tone: 'ok', text: C('inGameChip') } };
  }

  function paintPanel() {
    var b = bonesState();
    var inSetup0 = S.page === 'setup';
    var portrait = document.getElementById('portrait');
    if (portrait) {
      portrait.setAttribute('data-mood', b.mood); // his mood, which the tests read; the picture follows data-state
      // The skull is lit while his word's tone is ok, and at setup's end while the player's client runs; unlit otherwise.
      var up = !!(P().wow || {}).running;
      var lit = (b.pill && b.pill.tone === 'ok') || (inSetup0 && b.mood === 'happy' && S.setup && S.setup.screen !== 'welcome' && up);
      // The first real paint shows him as he is, with no fade (APP-D-61); later changes fade.
      if (S.page != null && !S.skullShown) { S.skullShown = true; portrait.setAttribute('data-instant', ''); requestAnimationFrame(function () { requestAnimationFrame(function () { portrait.removeAttribute('data-instant'); }); }); }
      portrait.setAttribute('data-state', lit ? 'active' : 'inactive');
    }
    // The landmark's name is the shown name, a renamed companion's too (STYLE §11; index.html's
    // "NeverQuestAlone" only until status loads).
    var aside = document.getElementById('companion');
    if (aside) aside.setAttribute('aria-label', companion());
    // His state in a word: beside the portrait on hover or focus, and the portrait button's name. The
    // button opens Home, where the state's card is. In setup the steps say where things stand.
    var btnEl = document.getElementById('bones-btn');
    var tip = document.getElementById('status-tip');
    var word = !inSetup0 && b.pill ? b.pill.text : '';
    if (tip) { if (tip.textContent !== word) tip.textContent = word; tip.setAttribute('data-tone', b.pill ? b.pill.tone : 'neutral'); }
    if (btnEl) {
      if (word) {
        btnEl.setAttribute('aria-label', T('bones.statusAria', { name: companion(), status: word }));
        btnEl.removeAttribute('aria-hidden'); btnEl.removeAttribute('tabindex');
      } else {
        // In setup the steps say where things stand: the portrait is a picture there, out of reach.
        btnEl.removeAttribute('aria-label'); btnEl.setAttribute('aria-hidden', 'true'); btnEl.setAttribute('tabindex', '-1');
      }
    }
    // A change of state is said once in the live region (the speech line that said it is gone), never on
    // the first paint; on Home only when no card says it.
    if (word && S.lastWord && word !== S.lastWord && (S.page !== 'home' || !(stateModel() || finishModel()))) say(T('bones.statusLive', { name: companion(), status: word }));
    S.lastWord = word || S.lastWord;
    paintFoot();
    var inSetup = S.page === 'setup';
    $app.setAttribute('data-mode', S.page == null ? 'loading' : inSetup ? 'setup' : 'app');
    $app.setAttribute('data-os', platform());
    var tracker = document.getElementById('tracker');
    var nav = document.getElementById('nav');
    if (tracker) { tracker.hidden = !inSetup; if (inSetup) paintTracker(tracker); }
    if (nav) { nav.hidden = inSetup; if (!inSetup) paintNav(); }
  }

  /**
   * The panel's foot: the version, and one small update action. It changes only on the player's own
   * click there or when there's something to do (an update found, downloading, ready); a check the app
   * runs by itself never flickers it. In setup and on About it shows the version alone (About has the
   * details; setup is one decision), unless an update is found. With checks off, or in a build that
   * can't update, the version alone too. While WoW runs a ready update says Update ready (the app won't
   * install while WoW runs).
   */
  function paintFoot() {
    var el = document.getElementById('side-foot');
    if (!el) return;
    var info = S.info || {};
    var u = S.updates || {};
    var me = S.foot || {};
    var Fo = function (k, v) { return T('foot.' + k, v); };
    var kids = [];
    if (info.version) kids.push(h('span', { class: 'foot-ver', text: Fo('versionLine', { version: F.clean(info.version, 40) }) }));
    var act = function (label, fn, cls, extra) { return btn(label, fn, 'foot-btn' + (cls ? ' ' + cls : ''), Object.assign({ fk: 'foot' }, extra || {})); };
    var note = function (text) { return h('span', { class: 'foot-note', text: text }); };
    var check = function () {
      if (S.foot && S.foot.busy) return;
      S.foot = { busy: true };
      paintFoot();
      B.checkForUpdates().then(function (r) {
        if (r && r.status) S.updates = r.status;
        var st = (S.updates || {}).state;
        S.foot = { result: st === 'error' || isErr(r) ? 'error' : st === 'available' ? 'found' : 'none' };
        say(S.foot.result === 'error' ? T('pages.updates.problem.' + (UPDATE_PROBLEMS[(S.updates || {}).error] || 'network')) : S.foot.result === 'none' ? T('pages.updates.state.none') : T('pages.updates.state.availableVersion', { version: F.clean(((S.updates || {}).available || {}).version, 40) }));
        paintFoot();
        if (S.page === 'about') rerender();
      }, function () { S.foot = { result: 'error' }; say(T('pages.updates.problem.network')); paintFoot(); });
    };
    var quiet = S.page === 'setup' || S.page === 'about';
    // Setup's way out sits where Check for updates sits after it: beside the version (the owner,
    // 2026-10-02: Finish later looked apart from the rest). An update waits until setup is done.
    if (S.page === 'setup' && S.offerFinishLater) {
      kids.push(act(T('stage.finishLaterBtn'), finishLater, null, { fk: 'finish-later' }));
      patchKids(el, h('div', null, kids));
      return;
    }
    var off = u.supported === false || u.configured === false || u.mode === 'never';
    var running = !!(P().wow && P().wow.running);
    if (u.state === 'ready') {
      if (S.page !== 'about') kids.push(running ? note(Fo('readyChip')) : act(Fo('readyBtn'), function () { B.installUpdateNow().then(function (r) { if (isErr(r)) { S.updateResult = stamp(r); go('about'); } }); }, 'foot-accent'));
    } else if (u.state === 'downloading') {
      if (S.page !== 'about') kids.push(note(u.progress != null ? Fo('downloadingChip', { pct: u.progress }) : Fo('downloadingNoPctChip')));
    } else if (u.state === 'available' && u.available) {
      var v = F.clean(u.available.version, 40);
      if (S.page !== 'about') kids.push(u.notifyOnly || off ? act(Fo('availableBtn', { version: v }), openLink('releases'), 'foot-accent', { after: 'out' })
        : act(Fo('availableBtn', { version: v }), function () { B.downloadUpdate().then(function () { paintFoot(); if (S.page === 'about') rerender(); }); }, 'foot-accent'));
    } else if (!quiet && !off) {
      // The same button through the check, so focus stays on it; its result is said in the live region.
      if (me.busy) kids.push(act(Fo('checkingChip'), check, null, { 'aria-disabled': 'true' }));
      else if (me.result === 'none') kids.push(act(Fo('latestChip'), function () {}, null, { 'aria-disabled': 'true' }));
      else kids.push(act(Fo(me.result === 'error' ? 'retryBtn' : 'checkBtn'), check));
    }
    patchKids(el, h('div', null, kids));
  }

  /** The quest tracker (spec §4.9): a status list, not navigation. */
  function paintTracker(el) {
    var st = S.setup || {};
    var done = st.screen === 'wow' && setupFinished();
    var cur0 = P().provider;
    var rejectedNow = !!cur0 && cur0.auth !== 'local' && cur0.keyState === 'invalid';
    var connect = aiReady() ? 'done' : noCredit() ? 'credit' : rejectedNow ? 'rejected' : 'todo';
    var onSay = st.screen === 'wow';
    // The welcome is before the steps: no step is current yet (CL-design-31).
    var onWelcome = st.screen === 'welcome';
    var rows = [
      { key: 'download', text: T('stage.downloadLine'), state: 'done' },
      { key: 'connect', text: T('stage.connectLine'), state: done ? (connect === 'credit' || connect === 'rejected' ? connect : 'done') : onSay ? (connect === 'todo' ? 'done' : connect) : onWelcome ? 'next' : 'now' },
      { key: 'say', text: T('stage.sayHiLine'), state: done ? 'done' : onSay ? 'now' : 'next' },
    ];
    el.setAttribute('aria-label', T('stage.ariaLabel'));
    var fresh = h('ol', null, rows.map(function (r) {
      var sr = r.state === 'credit' ? T('stage.ariaNeedsCredit', { step: r.text }) : r.state === 'rejected' ? T('stage.ariaKeyRejected', { step: r.text })
        : r.state === 'done' ? T('stage.ariaDone', { step: r.text }) : r.text;
      var mark = r.state === 'done' ? 'dia-done' : r.state === 'now' ? 'dia-now' : r.state === 'next' ? 'dia-next' : 'dia-warn';
      return h('li', { class: 'tracker-row tracker-' + r.state, 'data-key': r.key, 'aria-current': r.state === 'now' ? 'step' : null },
        ico(mark, 'tracker-mark'),
        h('span', { class: 'tracker-text', 'aria-hidden': 'true', text: r.text }),
        h('span', { class: 'sr-only', text: sr }));
    }));
    patchKids(el, fresh);
  }

  /**
   * The nav (spec §4.10): four pages (Home, Your AI, Your data, Settings); the page it's on is current; a warn dot on Home while a card
   * is up. While setup isn't finished, Finish setup sits above them, with three small diamonds.
   */
  function paintNav() {
    var page = S.page;
    var here = NAV_OF[page] || page;
    var going = setupInProgress();
    var cardUp = !!(stateModel() || finishModel());
    document.querySelectorAll('[data-nav]').forEach(function (b) {
      var nav = b.getAttribute('data-nav');
      if (nav === here && nav !== 'setup-now') b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      if (nav === 'home') {
        var needs = cardUp && here !== 'home';
        b.setAttribute('data-attention', needs ? 'true' : 'false');
        if (needs) b.setAttribute('aria-label', T('nav.homeNeedsAria', { status: T('bones.pill.needsYouChip') })); else b.removeAttribute('aria-label');
      }
    });
    var now = document.querySelector('[data-nav="setup-now"]');
    if (now) {
      now.hidden = !going;
      if (going) {
        var st = S.setup || (S.appState && S.appState.setup) || {};
        var say = st.screen === 'wow';
        var marks = h('span', { class: 'nav-marks', 'aria-hidden': 'true' },
          ico('dia-done', 'nav-mark'), ico(aiReady() ? 'dia-done' : 'dia-now', 'nav-mark'), ico(say ? 'dia-now' : 'dia-next', 'nav-mark'));
        now.replaceChildren(document.createTextNode(T('finishLater.finishSetupBtn')), marks);
      }
    }
  }
  /** A sub-page's nav item: Settings for its pages, Your AI for saved keys, Your data for its records. */
  var NAV_OF = { diagnostics: 'settings', about: 'settings', uninstall: 'settings', general: 'settings', connections: 'privacy', 'last-request': 'privacy' };

  // -------------------------------------------------------------------------
  // The state card (spec §4.12): the one alert on Home (and setup's banner; elsewhere only a start
  // that failed). A title, one line and its fix, from rt.state, rt.reason and usage.needs. No Okay
  // while the state holds.

  /** Why the app couldn't start, in plain words (common.notRunning.*; never its error text). */
  function notRunningWhy(reason) {
    var r = String(reason || '');
    if (/already running/i.test(r)) return T('common.notRunning.detailAlreadyRunning');
    if (/missing its bridge|not in this build/i.test(r)) return T('common.notRunning.detailMissingPart');
    if (/outside the app/i.test(r)) return T('common.notRunning.detailChanged');
    return T('common.notRunning.detail');
  }

  /**
   * A check that failed for the very reason a card already says: only that nothing changed, the card
   * keeps the fix and no result shows its button twice. state: the card's cause; r: the failed result.
   */
  var STILL = {
    out_of_credit: { out_of_credit: 'homeCard.outOfCredit.stillLine' },
    provider_down: { overloaded: 'homeCard.providerDown.stillLine', timeout: 'homeCard.providerDown.stillLine' },
    local_down: { local_unreachable: 'homeCard.localDown.stillLine' },
    key_invalid: { auth_invalid: 'homeCard.keyInvalid.stillLine' },
    slowed: { rate_limited: 'homeCard.slowed.stillLine' },
    cap: { cap_spend: 'homeCard.cap.stillLine' },
    model_retired: { model_not_found: 'homeCard.modelRetired.stillLine' },
    key_unreadable: { no_key: 'homeCard.keyUnreadable.stillLine' },
    'last_error:spend_limit': { spend_limit: 'homeCard.spendLimit.stillLine' },
    'last_error:region_blocked': { region_blocked: 'homeCard.regionBlocked.stillLine' },
    'last_error:identifier_blocked': { identifier_blocked: 'homeCard.identifierBlocked.stillLine' },
  };
  function cardCause() {
    var k = view();
    var p = P();
    if (k === 'last_error') return p.lastError && p.lastError.kind ? 'last_error:' + p.lastError.kind : k;
    if (k === 'no_key' && p.rt && p.rt.reason === 'key store unreadable') return 'key_unreadable';
    return k;
  }
  function stillVars() {
    var p = P();
    var prov = p.provider;
    var co = prov ? F.clean(prov.name, 24) : '';
    var nt = p.notice && p.notice.kind === 'model_retired' ? p.notice : null;
    var gone = nt ? (nt.name ? F.clean(nt.name, 60) : modelName(nt.model)) : prov ? modelName(prov.model) : '';
    var u = p.usage || {};
    return { name: companion(), co: co, app: co, store: F.storeText(platform()), amount: u.capMicros != null ? F.usdMicros(u.capMicros) : '', model: gone };
  }
  function stillId(state, r) { var m = STILL[state]; return (m && r && !r.ok && m[r.error]) || null; }
  function failLines(r, state, v) { var id = stillId(state, r); return id ? [T(id, Object.assign(stillVars(), v || {}))] : errLines(r); }

  /**
   * The card's model: {key, tone, head, sub, acts: [() → node], say, out}. acts are factories, so the
   * alert and the banner each make their own buttons. null when all is well.
   */
  function stateModel() {
    var key = view();
    var p = P();
    var prov = p.provider;
    var pid = prov ? prov.id : null;
    var local = !!(prov && prov.auth === 'local');
    var name = companion();
    var v = { name: name, co: prov ? F.clean(prov.name, 24) : '', app: prov ? F.clean(prov.name, 24) : '', store: F.storeText(platform()) };
    var u = p.usage || {};
    var rt = p.rt || {};
    var c = null;
    var check = function (label) {
      return function () {
        return busyBtn(label, function () {
          return B.testKey({ provider: pid }).then(function (r) {
            S.cardCheck = stamp({ key: key, r: r || { ok: false } });
            var passed = !isErr(r) && r.ok;
            // On Say hi in game a pass says so where the card was, once, with no Okay, and focus
            // goes to the rows' next step: never a notice above setup's frame.
            if (passed && S.page === 'setup' && S.setup) {
              S.setup.cardPassed = stamp({ text: passLine(prov) });
              return refreshStatus().then(function () { rerender(false, focusStep); });
            }
            return refreshStatus().then(function () { paintBanners(); if (S.page === 'setup' || S.page === 'home') rerender(); });
          });
        }, 'btn btn-quiet', { fk: 'card-check' });
      };
    };
    var testKey = check(T('homeCard.testKeyBtn'));
    var pickAi = function () { return btn(T('common.pickAnotherAiBtn'), openChange, 'btn btn-quiet', { fk: 'pick-ai' }); };
    var line = function (base, extra) { return { head: T(base + '.headline', v), sub: T(base + '.detail', Object.assign({}, v, extra || {})) }; };
    var card2 = function (tone, words, acts) { return { tone: tone, head: words.head, sub: words.sub, acts: acts }; };
    var replace = function () { return btn(T('homeCard.keyInvalid.replaceKeyBtn'), openFlow('key', pid), 'btn btn-quiet', { fk: 'replace-key' }); };
    switch (key) {
      case 'not_running': {
        // The engine stopped while this window stayed (rt.reason app_stopped, fix-102): it started
        // fine, so the card says it needs a restart, not that it couldn't start.
        var stoppedApp = !(S.info && S.info.apiMode === 'error') && rt.reason === 'app_stopped';
        var twice = !stoppedApp && /already running/i.test(String((S.info && S.info.apiReason) || ''));
        var why = stoppedApp ? T('common.notRunning.detailStopped') : notRunningWhy(S.info && S.info.apiReason);
        // The banner says the cause when it's known, so "this copy" has a referent (CL-words-29).
        c = { tone: 'bad', head: T(stoppedApp ? 'common.notRunning.stoppedHeadline' : 'common.notRunning.headline'), sub: why, bannerText: why !== T('common.notRunning.detail') ? why : null, acts: [
          // Another copy runs: reopening meets it again, so this copy just quits (words-29).
          function () { return twice ? busyBtn(T('common.notRunning.quitCopyBtn'), function () { return B.quitApp(); }, 'btn btn-quiet', { fk: 'quit-copy' }) : quitReopenBtn('btn btn-quiet'); },
          function () { return busyBtn(T('common.copyDiagnosticsBtn'), function () { return B.copyDiagnostics().then(function (r) { S.cardCheck = stamp({ key: key, copied: !isErr(r) }); paintBanners(); if (S.page === 'home') rerender(); }); }, 'btn btn-quiet', { fk: 'copy-diagnostics' }); },
        ] };
        break;
      }
      case 'no_key':
        if (rt.reason === 'unknown provider') c = card2('warn', line('homeCard.noAi'), [function () { return btn(T('homeCard.noAi.pickAiBtn'), openChange, 'btn btn-quiet', { fk: 'pick-ai' }); }]);
        else if (!prov) c = null; // no AI at all: Finish setup (finishModel) or Your AI's empty state says it
        else if (rt.reason === 'key store unreadable') c = { tone: 'bad', head: T('homeCard.keyUnreadable.headline', v), sub: T(isWin() ? 'homeCard.keyUnreadable.detailWin' : 'homeCard.keyUnreadable.detail', v), acts: [testKey, replace] };
        else c = card2('warn', line('homeCard.noKey'), [function () { return btn(T('homeCard.noKey.addKeyBtn'), openFlow('key', pid), 'btn btn-quiet', { fk: 'add-key' }); }, pickAi]);
        break;
      case 'key_invalid':
      case 'signed_out':
        c = card2('bad', line('homeCard.keyInvalid'), [replace, isCustom(pid) ? null : function () { return btn(T('common.openKeysBtn', v), openLink(pid + '.keys'), 'btn btn-quiet', { fk: 'open-keys', after: 'out' }); }]);
        break;
      case 'out_of_credit':
        // The fix first (CL-words-22): a banner shows only its first button.
        c = card2('bad', line('homeCard.outOfCredit'), [isCustom(pid) ? null : function () { return btn(T('common.addCreditBtn', v), openLink(pid + '.billing'), 'btn btn-quiet', { fk: 'add-credit', after: 'out' }); }, testKey]);
        break;
      case 'cap':
        // Held because today's spend couldn't be read (rt.reason load_error, code health BR-09): setting the
        // limit again on Your AI counts from then, so Set limit opens it there.
        if (rt.reason === 'load_error') c = card2('bad', line('homeCard.capUnread'), [function () { return btn(T('homeCard.capUnread.setLimitBtn'), openLimit, 'btn btn-quiet', { fk: 'set-limit-again' }); }]);
        else c = { tone: 'bad', head: T('homeCard.cap.headline'), sub: T('homeCard.cap.detail', { name: name }), acts: [function () { return btn(T('homeCard.cap.raiseLimitBtn'), openLimit, 'btn btn-quiet', { fk: 'raise-limit' }); }] };
        break;
      case 'slowed': {
        var secs = rt.retryIn != null && isFinite(rt.retryIn) ? Math.max(0, Math.round(rt.retryIn)) : null;
        c = { tone: 'warn', head: T('homeCard.slowed.headline', v), sub: secs == null ? T('homeCard.slowed.detailSoon', v) : T('homeCard.slowed.detail', { name: name, count: secs }), acts: [] };
        break;
      }
      case 'provider_down':
        // Not the key: Check again, and the next message tries again anyway (words-22).
        c = card2('bad', line('homeCard.providerDown'), pid ? [check(T('common.checkAgainBtn')), pickAi] : []);
        break;
      case 'sending_paused': {
        var sp = p.view.sending || {};
        c = { tone: 'bad', head: F.clean(sp.headline, 120), sub: F.clean(sp.detail, 240), acts: [function () {
          return busyBtn(T('homeCard.resumeSendingBtn'), function () {
            return B.resumeSending().then(function (r) {
              S.cardCheck = isErr(r) ? stamp({ key: key, r: r }) : null;
              return B.status().then(function (s2) { S.status = s2; paintPanel(); paintBanners(); if (S.page === 'home') rerender(); });
            });
          }, 'btn btn-quiet', { fk: 'resume-sending' });
        }] };
        break;
      }
      case 'local_down':
        c = card2('bad', line('homeCard.localDown'), pid ? [check(T('common.checkAgainBtn'))] : []);
        break;
      case 'model_retired':
        c = card2('bad', line('homeCard.modelRetired'), [function () { return btn(T('homeCard.modelRetired.pickModelBtn'), openModelCard, 'btn btn-quiet', { fk: 'pick-model' }); }]);
        break;
      case 'last_error': {
        // A failure no rt state covers, which the game sends to the desktop: the bridge's line and
        // its fix. It goes with the next reply that works.
        var le = p.lastError || {};
        // A bad request or an unknown failure is a one-off notice the first time; the card means it came twice in a row (D-33).
        var repeated = (le.kind === 'bad_request' || le.kind === 'unknown') && !le.notice;
        var leFix = le.kind === 'identifier_blocked'
          ? [pickAi, function () { return btn(T('common.openDiagnosticsBtn'), function () { go('diagnostics'); }, 'btn btn-quiet', { fk: 'open-diagnostics' }); }]
          : fixFor(le.action, pid).map(function (n) { n.className = 'btn btn-quiet'; return function () { return n; }; });
        // Fixed at the AI company: its fix first, then Check again (the key is fine), but never for a
        // place it isn't offered (CL-words-22).
        if (le.retest && pid && le.kind !== 'region_blocked') leFix = leFix.concat([check(T('common.checkAgainBtn'))]);
        if (/^(overloaded|timeout|provider_down)$/.test(le.kind) && pid) leFix = [check(T('common.checkAgainBtn'))].concat(leFix.filter(function (f) { return f !== testKey; }));
        var openLast = function () { return btn(T('homeCard.openLastRequestBtn'), function () { go('last-request'); }, 'btn btn-quiet', { fk: 'open-last-request' }); };
        var copyDiag = function () { return busyBtn(T('common.copyDiagnosticsBtn'), function () { return B.copyDiagnostics().then(function (r) { S.cardCheck = stamp({ key: key, copied: !isErr(r) }); paintBanners(); if (S.page === 'home') rerender(); }); }, 'btn btn-quiet', { fk: 'copy-diagnostics' }); };
        // A write on this computer that failed (local_write: a full disk, a folder it can't write): its step is
        // the bridge's line, the first time too, and no button: Retry is the game's (bones-ux-writer UX-W07).
        var onComputer = le.kind === 'local_write';
        // Twice in a row: which message is in Last request; diagnostics for a bug report (words-22).
        if (repeated) leFix = [openLast, copyDiag];
        else if (!leFix.length && le.kind !== 'identifier_blocked' && !onComputer) leFix = [openLast];
        // Twice: its next step is the player's own (CL-words-51).
        c = { tone: 'bad', head: repeated && pid ? T('homeCard.repeatedHeadline', v) : F.clean(le.headline, 200) || T('homeCard.lastErrorHeadline'), sub: repeated && pid ? T('homeCard.repeatedDetail') : onComputer ? F.clean(le.detail, 200) || null : null, acts: leFix.slice(0, 2) };
        break;
      }
      default:
        // Chats that can't be saved (code health BR-11): the bridge's words (status-view.mjs savingLines). The
        // fix is the player's, outside the app, and the app writes them again by itself: no button.
        if (p.view.saving) c = { tone: 'bad', head: F.clean(p.view.saving.headline, 120), sub: F.clean(p.view.saving.detail, 240), acts: [] };
        else if (u.needs === 'near_cap' && prov && prov.auth !== 'local' && Number(u.capMicros) > 0) {
          c = { tone: 'warn', head: T('homeCard.nearCap.headline'), sub: T('homeCard.nearCap.detail', { name: companion(), limit: F.usdMicros(u.capMicros) }), acts: [function () { return btn(T('homeCard.cap.raiseLimitBtn'), openLimit, 'btn btn-quiet', { fk: 'raise-limit' }); }], say: T('homeCard.nearCap.liveLine') };
        }
    }
    if (!c) return null;
    c.key = key;
    c.acts = (c.acts || []).filter(Boolean);
    var cc = S.cardCheck;
    c.out = null;
    if (cc && cc.key === key) {
      if (cc.r) c.out = cc.r.ok ? { kind: 'ok', text: T(key === 'local_down' ? 'homeCard.localCheckedLine' : 'homeCard.answeredLine', v), n: cc } : { kind: 'bad', text: failLines(cc.r, cardCause(), v).filter(Boolean).join(' '), n: cc };
      else if (cc.copied) c.out = { kind: 'ok', text: T('common.copiedDiagnosticsLine'), n: cc };
    }
    return c;
  }
  function toneIcon(tone) { return tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : tone === 'ok' ? 'ok' : 'info'; }
  /** The alert card (spec §4.12): Home's. Its first fix is the page's one primary. */
  function alertCard(m, firstPrimary) {
    var hid = 'alert-head';
    var acts = m.acts.map(function (f) { return f(); });
    if (firstPrimary && acts[0]) acts[0].className = 'btn btn-primary';
    return h('section', { class: 'alert alert-' + m.tone, role: 'group', 'aria-labelledby': hid, 'data-say': m.say || m.head, 'data-key': 'alert' },
      ico(toneIcon(m.tone), 'alert-ico'),
      h('div', { class: 'alert-body' },
        h('p', { class: 'alert-head', id: hid }, keepWhole(m.head)),
        m.sub ? h('p', { class: 'alert-sub' }, keepWhole(m.sub)) : null,
        acts.length ? h('div', { class: 'row' }, acts) : null,
        m.out ? resultLine(m.out.kind, m.out.text, m.out.n, 'alert-out') : null));
  }
  /**
   * The banner (spec §4.13): the card's title and its fix as a small quiet button, on the pages that
   * aren't Home. The title goes to Home. prime: its button is the screen's primary (step 3).
   */
  function bannerRow(m, prime) {
    // On Your AI a rejected key's fix is the key row's own Replace key: one button, not two (CL-player-42).
    var own = S.page === 'provider' && (m.key === 'key_invalid' || m.key === 'signed_out') && !(S.ya && S.ya.view && S.ya.view !== 'main');
    var act = m.acts[0] && !own ? m.acts[0]() : null;
    if (act) act.className = prime ? 'btn btn-primary btn-sm' : 'btn btn-quiet btn-sm';
    var text = m.bannerText || m.head;
    var headBtn = S.page === 'setup' ? h('p', { class: 'banner-text' }, keepWhole(text))
      : h('button', { type: 'button', class: 'banner-text banner-link', 'data-fk': 'banner-home', onClick: function () { go('home'); } }, keepWhole(text));
    return h('div', { class: 'banner banner-' + m.tone, role: 'group', 'aria-label': text, 'data-say': m.say || text, 'data-key': 'banner-' + m.key },
      ico(toneIcon(m.tone), 'banner-ico'), headBtn, act,
      m.out ? resultLine(m.out.kind, m.out.text, m.out.n, 'banner-out') : null);
  }

  /**
   * Setup left with Finish later (§3.11): the first missing piece, with Finish setup. null when setup
   * is done, or a state that needs its own fix says it better.
   */
  function finishModel() {
    if (!S.appState || !S.appState.onboarded || !S.appState.setup || !S.status || !S.status.setup || setupFinished()) return null;
    var key = view();
    if (key && key !== 'ready' && key !== 'no_key' && key !== 'paused') return null;
    if (key === 'no_key' && P().provider && P().rt.reason !== 'unknown provider' && aiReady()) return null;
    var sb = setupBlock();
    var addon = sb.addon && sb.addon.state;
    var line = null;
    if (!aiReady()) line = T('finishLater.noAiLine', { name: companion() });
    else if (addon && addon !== 'current' && addon !== 'looking') line = T('finishLater.noAddonLine');
    else if (isMac() && sb.permission && sb.permission !== 'granted' && sb.permission !== 'n/a' && sb.captureState !== 'off') line = T('finishLater.noScreenRecordingLine', { name: companion() });
    if (!line) return null;
    return { key: 'finish', tone: 'warn', head: line, sub: null, acts: [function () { return btn(T('finishLater.finishSetupBtn'), resumeSetup, 'btn btn-quiet', { fk: 'finish-setup' }); }] };
  }
  function resumeSetup() { S.setup = restoreSetup(); go('setup'); }

  function paintBanners() {
    var list = [];
    var setup = S.page === 'setup';
    var home = S.page === 'home';
    if (S.info && S.info.apiMode === 'mock' && !S.demoDismissed) {
      list.push(notice('warn', T('notices.sample.headline'), function () { S.demoDismissed = true; paintBanners(); }));
    }
    // The state card is Home's alert, and setup draws its own (step 3). Every other page leaves it to Home
    // (the app trim: the portrait's eye, its word on hover and the nav's dot say it needs you); the one banner it keeps
    // is a start that failed, which nothing on the page can fix.
    if (!home) {
      var sm = stateModel();
      if (sm && sm.key === 'not_running') list.push(bannerRow(sm, setup));
    }
    if (!setup) {
      // The check-ins fuse (the public build's one exception to "no limits"): one line with Okay.
      var ci = P().view.checkIns;
      if (!ci) S.fuseSeen = false;
      else if (!S.fuseSeen) list.push(notice('warn', T('notices.fuseLine'), function () { S.fuseSeen = true; paintBanners(); }));
      // Screen reading that fails while WoW runs: the bridge's headline and its one next step.
      var sc = P().view.screen;
      if (!sc || sc.ok || !(P().wow && P().wow.running)) S.screenSeen = null;
      else if (S.screenSeen !== sc.state) {
        var scDetail = sc.action === 'no_screen_reading' ? null : F.clean(sc.detail, 240);
        list.push(notice('warn', [screenHead(sc), scDetail].filter(Boolean).join(' '), function () { S.screenSeen = sc.state; paintBanners(); }, screenFix(sc)));
      }
      // Patch day: a new World of Warcraft, and the addon set up for it by the app.
      var gu = P().view.gameUpdate;
      if (gu && S.gameUpdateSeen !== gu.id) list.push(notice(gu.ok ? 'ok' : 'warn', [F.clean(gu.headline, 200), F.clean(gu.detail, 240)].filter(Boolean).join(' '), function () { S.gameUpdateSeen = gu.id; paintBanners(); }));
      // Settings that couldn't be read, so this start began on the defaults: once, with Okay.
      var sr = P().view.settingsReset;
      if (sr && !S.resetSeen) list.push(notice('warn', F.clean(sr.headline, 120), function () { S.resetSeen = true; paintBanners(); }));
      var mn = P().notice;
      if (mn && mn.id && mn.kind === 'model_switched' && !S.noticeGone[mn.id]) list.push(modelNotice(mn));
      // A retiring model is said on Home, where the app opens (every other page keeps its word budget).
      if (home && mn && mn.id && mn.kind === 'model_retiring' && !S.noticeGone[mn.id]) list.push(retiringNotice(mn));
    }
    var fk = $banners.contains(document.activeElement) ? document.activeElement.getAttribute('data-fk') : null;
    var fresh = document.createElement('div');
    add(fresh, list.filter(Boolean));
    patchKids($banners, fresh);
    if (fk) {
      var again = $banners.querySelector('[data-fk="' + fk.replace(/["\\]/g, '') + '"]');
      if (again) focusEl(again);
    }
    speakNew($banners, 'banners');
    paintNav();
  }

  /** The start-time model check's switch (§10, PV-3): one line with Okay, shown once; Okay puts it away for good. */
  function modelNotice(nt) {
    var to = nt.toName ? F.clean(nt.toName, 60) : modelName(nt.to);
    // The old model's name when the notice has it (CL-words-44): it's gone, so it switched to the new one.
    var fv = { from: nt.fromName ? F.clean(nt.fromName, 60) : '', model: to };
    var line = nt.fromName ? T('notices.modelSwitched.fromLine', fv) : T('notices.modelSwitched.line', { model: to });
    return notice('warn', line, function () {
      S.noticeGone[nt.id] = true;
      paintBanners();
      B.dismissNotice({ id: nt.id });
    }, [small(T('notices.modelSwitched.pickModelBtn'), openModelCard, { fk: 'pick-model' })],
    dataLine(nt.fromName ? 'notices.modelSwitched.fromLine' : 'notices.modelSwitched.line', nt.fromName ? fv : { model: to }, ['from', 'model']));
  }

  /**
   * A model its AI company will retire (SY-102-5; the bridge says it while that model is in use): the
   * day, the model offered in its place and its cost a day (Your AI's own figure, at the level the
   * pick would use), Use <model> (the same pick as Your AI's) and Okay, which puts it away for good.
   */
  function retiringNotice(nt) {
    var cur = P().provider || {};
    var to = modelById(cur.id, nt.to);
    var day = to ? dayAt(to, to.effort ? nearestLevel(levelsOf(to), cur.effort || 'low') : null) : null;
    var v = {
      model: nt.name ? F.clean(nt.name, 60) : modelName(nt.model), date: F.dayText(nt.after),
      // The cost in Your AI's own row words ("$0.75–1.15 a day"), kept on one line (CL-design-54).
      to: nt.toName ? F.clean(nt.toName, 60) : modelName(nt.to), dayCost: day ? T('yourAi.dayCostLine', { dayCost: day.text }) : '',
    };
    var id = day ? 'notices.modelRetiring.line' : 'notices.modelRetiring.noCostLine';
    var use = to ? busyBtn(T('notices.modelRetiring.useBtn', { model: v.to }), function () { return useModel(cur, nt.to); }, 'btn btn-quiet btn-sm', { fk: 'use-model' })
      : small(T('notices.modelSwitched.pickModelBtn'), openModelCard, { fk: 'pick-model' });
    return notice('warn', T(id, v), function () {
      S.noticeGone[nt.id] = true;
      paintBanners();
      B.dismissNotice({ id: nt.id });
    }, [use], dataLine(id, v, ['model', 'date', 'to', 'dayCost']));
  }

  // -------------------------------------------------------------------------
  // Pages, the top bar and the sheet.

  var PAGES = {};
  var renderToken = 0;
  function go(page, after) {
    if (page === 'general') page = 'settings';
    // The app trim: Updates is part of About, Memory's two actions are in Settings' Show more.
    if (page === 'updates') page = 'about';
    var openMore = page === 'memory';
    if (openMore) page = 'settings';
    // Usage lives in Your AI now (its spending group): the old page's name still leads there.
    if (page === 'usage') { page = 'provider'; S.ya = null; if (!after) after = function () { reveal('spend-group'); }; }
    if (!PAGES[page]) page = 'home';
    // Leaving setup for a page it links to (a fix, Diagnostics): that page starts with "‹ Back to
    // setup", which comes back to the same screen and control.
    if (S.page === 'setup' && page !== 'setup' && S.setup && !S.bySidebar) { var left = focusKey(document.activeElement); S.fromSetup = { fk: left && left.fk ? left.fk : null }; }
    else if (page === 'setup') S.fromSetup = null;
    S.bySidebar = false;
    if (page !== 'provider') S.keyFlow = null;
    if (page !== 'provider') S.ya = null;
    if (page === 'provider' && S.page !== 'provider') { S.capsDraft = null; S.capsResult = null; }
    if (page === 'privacy' && S.page !== 'privacy') S.safetyId = null;
    if (page === 'settings') S.settingsResult = {};
    if (page === 'diagnostics') S.diagPerm = null;
    if (page !== S.page) { spoken.page = {}; S.copied = {}; ['rawRequest', 'legal', 'perm-details', 'more'].forEach(function (k) { S.open[k] = false; }); }
    if (openMore) S.open.more = true;
    closeSheet(true);
    S.page = page;
    paintPanel();
    paintBanners();
    rerender(true, after);
  }
  /** "‹ Back to setup" on a page setup opened: the same screen, focus on the control left from. */
  function backToSetup() {
    var from = S.fromSetup;
    if (!from || !S.setup || !setupInProgress()) return null;
    return backBtn(T('usage.backToSetupBtn'), function () {
      S.fromSetup = null;
      go('setup', from.fk ? focusAfter(from.fk) : null);
    }, { fk: 'back-to-setup' });
  }
  /**
   * A page's Back (spec §3) goes at the head of its title row, on the column's left edge; a page whose
   * title stands alone gets a title row for it. The stage's top bar is the window's drag strip and stays
   * empty; Finish later is the panel foot's (paintFoot).
   */
  function paintTop(node, top) {
    var left = (top && top.left) || [];
    if (S.page !== 'setup') { var back = backToSetup(); if (back) left = [back].concat(left); }
    S.offerFinishLater = !!(top && top.finishLater);
    patchKids($top, h('div'));
    var h1 = node && node.querySelector ? node.querySelector('#page-title') : null;
    if (!h1 || !left.length) return;
    var row = h1.parentNode && h1.parentNode.classList && (h1.parentNode.classList.contains('title-row') || h1.parentNode.classList.contains('say-head')) ? h1.parentNode : null;
    if (!row) {
      row = h('div', { class: 'title-row', 'data-key': 'title-row' });
      h1.parentNode.insertBefore(row, h1);
      row.appendChild(h1);
    }
    for (var i = left.length - 1; i >= 0; i--) row.insertBefore(left[i], row.firstChild);
  }
  /**
   * Draw the page again. top: a new page or step (scroll to the top, focus its heading). after: run
   * once it's drawn (a fix: scroll to a control and focus it). Otherwise focus stays where it was.
   */
  var topPending = false;
  function rerender(top, after) {
    var token = ++renderToken;
    var page = S.page;
    if (after) S.after = after;
    if (top) topPending = true;
    Promise.resolve().then(function () { return PAGES[page](); }).catch(function () {
      return h('div', { class: 'col' }, title(T('common.pageFailed.title')), para(T('common.pageFailed.body'), 'lead'));
    }).then(function (node) {
      if (token !== renderToken) return;
      top = top || topPending;
      topPending = false;
      var key = focusKey(document.activeElement) || S.pendingFocus;
      var y = $page.scrollTop;
      paintTop(node, node && node.__top);
      paintPanel();
      if (page === 'provider') paintBanners(); // its banner's button is the primary only on Your AI's main view
      var old = $page.firstChild;
      // A redraw of the same page patches it in place; a new page or step is drawn fresh.
      if (!top && old && old.__page === page && old.nodeType === 1 && keyOf(old) === keyOf(node)) patchNode(old, node);
      else { $page.replaceChildren(node); node.__page = page; }
      $page.setAttribute('data-page', page);
      $page.scrollTop = top ? 0 : y;
      S.pendingFocus = null;
      var fn = S.after;
      S.after = null;
      if (fn) fn();
      else if (top) focusTitle();
      else if (key && !focusEl(findByKey(key))) focusTitle();
      speakNew($page, 'page');
      if (S.sheet) paintSheet();
    });
  }
  /** A page's content column, with its top bar's controls carried on the node. */
  function pageNode(cls, top, kids) {
    var n = h('div', { class: 'col ' + cls, 'data-key': cls }, kids);
    n.__top = top || null;
    return n;
  }

  // The Details sheet (spec §4.6): over the stage only, a scrim behind it; focus moves to its heading,
  // stays inside, and comes back to Show details on close. Esc, × or the scrim closes it.
  function openSheet(build) {
    S.sheet = { build: build };
    paintSheet();
    var h2 = document.getElementById('sheet-title');
    if (h2) focusEl(h2);
  }
  function closeSheet(silent) {
    if (!S.sheet) return;
    S.sheet = null;
    paintSheet();
    if (!silent) { var d = findByKey({ fk: 'details', n: 0 }); if (!focusEl(d)) focusTitle(); }
  }
  function paintSheet() {
    var main = document.getElementById('main-body');
    if (!S.sheet) {
      $sheet.replaceChildren();
      [main, $top].forEach(function (el) { if (el) el.removeAttribute('inert'); });
      $app.removeAttribute('data-sheet');
      return;
    }
    var c = S.sheet.build();
    var box = h('aside', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
      h('header', { class: 'sheet-head' },
        h('h2', { id: 'sheet-title', tabindex: '-1', text: c.title }),
        h('button', { type: 'button', class: 'btn-ghost btn-icon', 'aria-label': T('details.closeAria'), 'data-fk': 'sheet-close', onClick: function () { closeSheet(); } }, ico('x'))),
      h('div', { class: 'sheet-body', tabindex: '0', 'aria-labelledby': 'sheet-title' }, c.sections.filter(Boolean).map(function (s) {
        var body = s.body ? (Array.isArray(s.body) ? s.body : [s.body]).filter(Boolean) : [];
        // A section is one card of rows, as the pages' groups are (APP-D-40): words are a row, a control
        // is a row, a card is itself; the fine print stays plain under the cards.
        if (!s.fine && body.length && !(body.length === 1 && body[0].classList && body[0].classList.contains('sheet-card'))) {
          body = [sheetCard(body.map(function (b) {
            if (typeof b === 'string') return sheetLine(b);
            return b.classList && b.classList.contains('sheet-row') ? b : h('div', { class: 'sheet-row' }, b);
          }))];
        } else body = body.map(function (b) { return typeof b === 'string' ? para(b) : b; });
        return h('section', { class: 'sheet-sec' + (s.fine ? ' sheet-fine' : '') }, s.label ? label(s.label) : null, body);
      })));
    $sheet.replaceChildren(h('div', { class: 'scrim', onClick: function () { closeSheet(); } }), box);
    // The panel stays live: a click on the nav or the portrait closes the sheet and goes there (go()).
    [main, $top].forEach(function (el) { if (el) el.setAttribute('inert', ''); });
    $app.setAttribute('data-sheet', 'open');
  }
  document.addEventListener('keydown', function (e) {
    if (!S.sheet) return;
    if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
    if (e.key !== 'Tab') return;
    // Focus stays in the sheet (aria-modal).
    var f = Array.prototype.slice.call($sheet.querySelectorAll('button, [tabindex="0"], a, input, select')).filter(function (el) { return !el.disabled; });
    if (!f.length) return;
    var first = f[0];
    var last = f[f.length - 1];
    var a = document.activeElement;
    if (e.shiftKey && (a === first || !$sheet.contains(a))) { e.preventDefault(); focusEl(last); }
    else if (!e.shiftKey && (a === last || !$sheet.contains(a))) { e.preventDefault(); focusEl(first); }
  });
  /**
   * Show details (spec §4.3): the info icon that opens the sheet. Its name is "Show details" on every
   * page (CL-words-85): the heading beside it names the subject, and the sheet's title says it again.
   */
  function detailsBtn(build) {
    return btn(T('ai.detailsBtn'), function () { openSheet(build); }, 'btn-ghost btn-icon', { fk: 'details', icon: 'info', hideLabel: true, 'aria-haspopup': 'dialog' });
  }
  /** Show details as its icon alone, beside a title (its name is still Show details). */
  function detailsIcon(build) {
    return detailsBtn(build);
  }

  // The portrait opens Home, where his state's card is (in setup it does nothing: the steps say it).
  var bonesBtn0 = document.getElementById('bones-btn');
  if (bonesBtn0) bonesBtn0.addEventListener('click', function () {
    if (bonesBtn0.getAttribute('aria-hidden') === 'true' || S.page === 'setup') return;
    S.fromSetup = null;
    S.bySidebar = true;
    go('home');
  });

  document.querySelectorAll('[data-nav]').forEach(function (b) {
    b.addEventListener('click', function () {
      var page = b.getAttribute('data-nav');
      if (page === 'setup-now') { if (!S.setup) S.setup = restoreSetup(); page = 'setup'; }
      else S.fromSetup = null;
      if (page === 'provider') { S.ya = null; S.keyFlow = null; }
      S.bySidebar = page !== 'setup';
      go(page);
    });
  });

  // -------------------------------------------------------------------------
  // Setup: a first run opens on the welcome (what Bones does for your questing, one primary), then
  // 1 Download (done when the app opens) · 2 Connect your AI (its rows, or Other's form)
  // · 3 Say hi in game (objectives checked off on real events; the first reply ends setup in place,
  // with "You're set"). The screen changes only in a click handler (toScreen); a status push redraws
  // the objectives in place; nothing appears, moves or goes by itself.

  function newSetup() {
    return { screen: 'ai', path: null, provider: null, pick: null, busy: null, slot: null, stage: null, open: {}, why: null, hiddenAi: null, moving: false, copied: {}, doneSaid: false, custom: null, customResult: null };
  }
  /** Save where setup is (no secrets), so a reopen comes back here (§3.11). */
  function saveSetup() {
    var st = S.setup;
    if (!st) return;
    var saved = { v: 2, screen: st.screen, path: st.path === 'custom' ? 'custom' : 'key', provider: st.provider || st.pick || null };
    S.appState = Object.assign({}, S.appState, { setup: saved });
    B.setAppState({ setup: saved });
  }
  /**
   * Reopening (§3.11): the saved screen when its prerequisite still holds, else the first stage not
   * done. A saved screen for an AI the data file now hides opens step 2 with a line that says so.
   * The old "Connect <AI>" and "Check your defaults" screens are step 2 and step 3 now.
   */
  function restoreSetup() {
    var st = newSetup();
    var saved = S.appState && S.appState.setup;
    var cur = P().provider;
    var stageDone = aiReady() || noCredit() || aiRejected();
    if (saved && saved.screen === 'connect' && saved.path === 'custom') { st.screen = 'connect'; st.path = 'custom'; st.provider = 'custom'; }
    else if (saved && (saved.screen === 'connect' || saved.screen === 'ai') && saved.provider) {
      var p = providerById(saved.provider);
      if (p && !p.hidden) st.pick = p.id; else st.hiddenAi = saved.provider;
      st.screen = 'ai';
    } else if (saved && (saved.screen === 'defaults' || saved.screen === 'wow')) st.screen = stageDone ? 'wow' : 'ai';
    else if (saved && saved.screen === 'ai') st.screen = 'ai';
    else st.screen = stageDone ? 'wow' : 'welcome';
    if (st.screen === 'wow' && !stageDone) st.screen = 'ai';
    if (!st.pick && !st.hiddenAi && S.providers) st.pick = firstPick();
    st.provider = st.pick || (cur ? cur.id : null);
    return st;
  }
  /**
   * The only way the screen changes: a click on the screen it was on (a double click, or a click on
   * the old page before the new one is drawn, does nothing). Focus goes to the new heading.
   */
  function toScreen(from, to, patch) {
    var st = S.setup;
    if (!st || st.screen !== from || st.moving) return false;
    if (patch) Object.keys(patch).forEach(function (k) { st[k] = patch[k]; });
    if (st.stage && (patch && patch.dropStage)) { B.dropStagedKey({ stageId: st.stage.stageId }); st.stage = null; }
    st.screen = to;
    st.slot = null;
    st.busy = null;
    st.why = null;
    st.open = {};
    saveSetup();
    rerender(true);
    return true;
  }
  /** Finish later (§3.11): setup counts as done, so the window stops opening by itself; Home shows what's missing. */
  function finishLater() {
    saveSetup();
    B.setAppState({ onboarded: true }).then(function () {
      S.appState = Object.assign({}, S.appState, { onboarded: true });
      S.setup = null;
      go('home');
    });
  }
  function setupTop(back) {
    return {
      left: back ? [backBtn(T('stage.backBtn'), back, { fk: 'back' })] : [],
      right: [],
      finishLater: true, // the panel's foot offers Finish later on this screen
    };
  }

  // ---- Paste key: one click, the key read in main; one result line under the actions

  /** Where a key flow keeps its state: setup's step 2, Your AI's picker, or the Key row's Replace. */
  function KS(where) {
    if (where === 'ai') return S.setup;
    if (where === 'pick') { if (!S.ya) S.ya = { view: 'pick' }; if (!S.ya.pick) S.ya.pick = { pick: (P().provider || {}).id || null, busy: null, slot: null, stage: null, open: {} }; return S.ya.pick; }
    if (!S.keyFlow) S.keyFlow = { provider: (P().provider || {}).id || null, busy: null, slot: null, stage: null, open: {} };
    return S.keyFlow;
  }
  function stFor(st) { return st === S.setup ? 'ai' : S.ya && st === S.ya.pick ? 'pick' : 'page'; }

  /**
   * One result of Paste key, the key field, Use saved key or Test again (spec §6.1's table): one line,
   * and at most one extra button; the primary is relabelled rather than added, and it is the fix
   * (STYLE §5, CL-words-22): the company's page first, Test again quiet after it. → {kind, line,
   * primary: {label, fn, fk, out} | null, quiet: node | null, ghost: node | null, bare, focus}; bare:
   * no Paste and no key page (a region the AI doesn't serve: the rows are the next step).
   */
  function keyResult(res, where) {
    var st = KS(where);
    var pid = res.provider || res.guess || st.pick || st.provider;
    var v = namesOf(pid);
    var R = function (k, x) { return T('ai.result.' + k, Object.assign({}, v, x || {})); };
    var P2 = function (label, fn, fk) { return { label: label, fn: fn, fk: fk || 'key-fix' }; };
    var paste = function (label) { return isSignin(pid) ? P2(T('ai.signInAgainBtn'), function () { signIn(pid, where); }, 'sign-in') : P2(label || T('ai.pasteNewBtn'), function () { pasteKey(where); }, 'paste-key'); };
    var again = function () { return P2(T('ai.signInAgainBtn'), function () { signIn(pid, where); }, 'sign-in'); };
    var retry = function () { return P2(T('ai.testAgainBtn'), function () { return res.retest === 'saved' ? testSaved(pid, where) : retryKey(pid, where); }, 'test-again'); };
    // The fix is a web page: the primary opens it (an arrow out), and Test again is the quiet button.
    var webFix = function (label, fn, fk) { return { label: label, fn: fn, fk: fk, out: true }; };
    var testQuiet = function (fn) { return busyBtn(T('ai.testAgainBtn'), fn || function () { return res.retest === 'saved' ? testSaved(pid, where) : retryKey(pid, where); }, 'btn btn-quiet', { fk: 'test-again' }); };
    var addCredit = function () { return webFix(T('ai.addCreditBtn', v), openLink(pid + '.billing'), 'add-credit'); };
    if (res.ok) {
      if (where === 'page') return { kind: 'ok', line: R('okLine', { ai: F.clean(res.ai || v.ai, 24) }), primary: null, focus: 'paste-key' };
      return { kind: 'ok', line: R('okLine', { ai: F.clean(res.ai || v.ai, 24) }), primary: P2(T('ai.continueBtn'), function () { afterConnect(where); }, 'continue'), focus: 'continue', connected: true };
    }
    if (isSignin(pid)) {
      switch (res.error) {
        case 'cancelled': return { kind: 'warn', line: R('signInCancelledLine'), primary: null, focus: 'sign-in' };
        case 'port_busy': return { kind: 'warn', line: R('portBusyLine'), primary: again(), focus: 'sign-in' };
        case 'browser_failed': return { kind: 'bad', line: R('browserFailedLine'), primary: again(), focus: 'sign-in' };
        case 'timeout': return { kind: 'warn', line: R('signInTimeoutLine'), primary: again(), focus: 'sign-in' };
        case 'sign_in_failed': case 'no_account': case 'no_refresh': return { kind: 'bad', line: R('signInFailedLine'), primary: again(), focus: 'sign-in' };
        case 'oauth_expired': case 'auth_invalid': case 'saved_rejected': return { kind: 'bad', line: R('signInEndedLine'), primary: again(), focus: 'sign-in' };
        case 'not_signed_in': case 'no_key': return { kind: 'warn', line: R('notSignedInLine'), primary: again(), focus: 'sign-in' };
        case 'terms_required': return { kind: 'warn', line: R('termsRequiredLine'), primary: again(), focus: 'sign-in' };
        default: break;
      }
    }
    switch (res.error) {
      case 'clipboard_empty': return { kind: 'warn', line: R('clipboardEmptyLine'), primary: null, focus: 'paste-key' };
      case 'not_a_key': {
        var prefix = F.clean(disp(pid).keyPrefix || '', 20);
        return { kind: 'warn', line: prefix && !isCustom(pid) ? R('notAKeyLine', { prefix: prefix }) : R('notAKeyAnyLine', { companies: F.listOr(cardAis().map(function (p) { return coName(p.id); })) }), primary: null, focus: 'paste-key' };
      }
      case 'hidden_provider': return { kind: 'warn', line: T('ai.hiddenLine', { ai: aiName(res.guess) }), primary: null, focus: 'paste-key' };
      case 'key_mismatch': // Your AI's Replace: a key from another AI
        return { kind: 'warn', line: R('notAKeyLine', { prefix: F.clean(disp(pid).keyPrefix || '', 20) }), primary: null, focus: 'paste-key' };
      case 'subscription_token': return { kind: 'warn', line: R('subscriptionTokenLine'), primary: null, focus: 'paste-key' };
      case 'admin_key': return { kind: 'warn', line: R('adminKeyLine'), primary: paste(), focus: 'paste-key' };
      case 'cancelled': return { kind: 'warn', line: R(where === 'page' ? 'cancelledPageLine' : 'cancelledLine'), primary: null, focus: 'paste-key' };
      case 'terms_required': return { kind: 'warn', line: R('termsRequiredLine'), primary: P2(T('ai.connectBtn'), function () { return useSaved(pid, where); }, 'connect'), focus: 'connect' };
      case 'needs_confirm': return { kind: 'warn', line: R('needsConfirmLine'), primary: paste(), focus: 'paste-key' };
      case 'saved_rejected': return { kind: 'bad', line: R('authInvalidLine'), primary: paste(), focus: 'paste-key' };
      case 'auth_invalid': return { kind: 'bad', line: res.kept ? R('replaceKeptLine') : R('authInvalidLine'), primary: paste(), focus: 'paste-key' };
      case 'out_of_credit':
        if (res.saved) {
          return { kind: 'warn', line: res.still ? R('stillNoCreditLine') : R('noCreditLine'), primary: addCredit(), quiet: testQuiet(function () { return testSaved(pid, where); }),
            ghost: where === 'ai' ? ghost(T('ai.continueAnywayBtn'), function () { carryOn(where); }, { fk: 'carry-on' }) : null, focus: 'add-credit' };
        }
        return { kind: 'warn', line: R('noCreditHeldLine'), primary: addCredit(), quiet: testQuiet(), focus: 'add-credit' };
      case 'spend_limit':
        return { kind: 'warn', line: res.tier ? R('spendLimitTierLine') : R('spendLimitLine'), primary: webFix(T('common.openLimitsBtn', v), openLink(pid + '.limits'), 'open-limits'), quiet: testQuiet(), focus: 'open-limits' };
      case 'workspace_required': return { kind: 'bad', line: R('workspaceLine'), primary: paste(), focus: 'paste-key' };
      case 'model_access': return { kind: 'bad', line: R('modelAccessLine'), primary: paste(), focus: 'paste-key' };
      case 'key_restricted': return { kind: 'bad', line: R('keyRestrictedLine'), primary: paste(), focus: 'paste-key' };
      case 'org_verification': return { kind: 'warn', line: R('orgVerificationLine'), primary: webFix(T('common.openCoSettingsBtn', v), openLink(pid + '.verify'), 'open-settings'), quiet: testQuiet(), focus: 'open-settings' };
      case 'region_blocked': return { kind: 'bad', line: R('regionBlockedLine'), primary: null, bare: true, focus: null };
      case 'rate_limited': return { kind: 'warn', line: R('rateLimitedLine'), primary: retry(), focus: 'test-again' };
      case 'overloaded': return { kind: 'warn', line: R('overloadedLine'), primary: retry(), focus: 'test-again' };
      case 'network': return { kind: 'warn', line: R('networkLine'), primary: retry(), focus: 'test-again' };
      // The app's own guard refused {co}'s own address (fix-102): never the player's internet.
      case 'restart': return { kind: 'bad', line: R('restartLine'), primary: P2(T('common.notRunning.quitReopenBtn'), function () { return B.relaunch(); }, 'quit-reopen'), focus: 'quit-reopen' };
      case 'keystore_error': return { kind: 'bad', line: R('keystoreErrorLine'), primary: P2(T('ai.saveAgainBtn'), function () { return retryKey(pid, where); }, 'save-again'), focus: 'save-again' };
      case 'read_failed': return { kind: 'bad', line: R('readFailedLine'), primary: paste(), focus: 'paste-key' };
      case 'stage_expired': return { kind: 'warn', line: R('stageExpiredLine'), primary: paste(), focus: 'paste-key' };
      case 'busy': return { kind: 'warn', line: R('busyLine'), primary: null, focus: 'paste-key' };
      default: return { kind: 'bad', line: R('failedLine'), primary: retry(), focus: 'test-again' };
    }
  }
  /** Say a result and put focus on its action; Cancel leaves it on Paste. */
  function showResult(res, where) {
    var st = KS(where);
    if (!st) return;
    if (res && res.error === 'ignored') return; // not focused, or a second read within the second: nothing
    // An OpenRouter key: Other's form opens with OpenRouter's address and the key filled in (spec §6.1).
    if (res && res.error === 'custom_key') { toCustom(where, OPENROUTER_URL, res.stageId ? { stageId: res.stageId, masked: res.masked } : null); return; }
    st.slot = stamp(res || { ok: false, error: 'failed' });
    // Paste detects: a key from another AI picks its row, and the flow goes on with it.
    var got = res && (res.provider || (res.error === 'hidden_provider' ? null : res.guess));
    var moved = false;
    if (got && providerById(got) && !isCustom(got) && where !== 'page' && st.pick !== got) { st.pick = got; st.provider = got; moved = true; }
    if (res && res.stageId && res.held) st.stage = { stageId: res.stageId, provider: res.provider };
    else if (res && !res.held) st.stage = null;
    if (where === 'ai' && moved) saveSetup();
    var k = keyResult(st.slot, where);
    // Setup goes straight on to step 3 once the key works (2026-10-05: a player stopped at "{ai} is
    // connected." and never reached the addon install). The player's own click started it.
    if (where === 'ai' && k.connected) { st.cardPassed = stamp({ text: passLine({ id: (st.slot && st.slot.provider) || st.pick }) }); afterConnect(where); return; }
    rerender(false, function () {
      var fk = res && res.error === 'cancelled' ? 'paste-key' : k.focus;
      // A region the AI doesn't serve: the rows are the next step, so focus goes to the one picked.
      if (k.bare && focusEl(document.getElementById('choice-' + st.pick))) return;
      if (!fk || !focusEl(findByKey({ fk: fk, n: 0 }))) { if (!focusEl(findByKey({ fk: 'paste-key', n: 0 }))) focusTitle(); }
    });
  }
  /**
   * While a key's native dialog is up, its button keeps its label (aria-disabled) and nothing is
   * said. main says when the player agreed (onAgreed, with the key's AI); only then does the button
   * say what it's doing, and the live region says it once.
   */
  var agreeWait = null;
  function awaitAgree(st, next, text) {
    st.busy = 'agree';
    st.checkingWith = null;
    agreeWait = { st: st, next: next, text: text };
  }
  function doneWaiting(st) {
    if (agreeWait && agreeWait.st === st) agreeWait = null;
    st.busy = null;
    st.checkingWith = null;
  }
  if (typeof B.onAgreed === 'function') {
    B.onAgreed(function (ev) {
      var w = agreeWait;
      if (!w || w.st.busy !== 'agree') return;
      agreeWait = null;
      var pid = ev && typeof ev.provider === 'string' && providerById(ev.provider) ? ev.provider : null;
      w.st.busy = w.next;
      w.st.checkingWith = pid;
      var t = w.text(pid);
      if (t) say(t);
      if (S.page === 'setup' || S.page === 'provider') rerender();
    });
  }
  /** "Checking with {co}…" for the key's AI, or "Checking…" before it's known. */
  function checkingText(pid) { return pid && providerById(pid) ? T('ai.checkingBtn', namesOf(pid)) : T('common.checkingBtn'); }
  function refreshStatus() {
    return B.status().then(function (s) { if (s) { S.status = s; paintPanel(); } });
  }

  /**
   * Paste key: main reads the clipboard (the page never does), shows the dialog, tests and saves.
   * Step 2 and Your AI's picker detect the AI from the key; Replace on Your AI's Key row is for the
   * AI in use.
   */
  function pasteKey(where) {
    var st = KS(where);
    if (!st || st.busy) return;
    var provider = where === 'page' ? st.provider : null;
    if (st.stage) { B.dropStagedKey({ stageId: st.stage.stageId }); st.stage = null; }
    st.slot = null;
    awaitAgree(st, 'paste', function (pid) { return checkingText(pid || provider || st.pick); });
    rerender();
    B.pasteKey({ provider: provider }).then(function (res) {
      doneWaiting(st);
      if (res && (res.ok || res.saved)) return ensureProviders().then(refreshStatus).then(function () { showResult(res, where); });
      showResult(res, where);
      return null;
    });
  }
  /** Test again / Save again on a held key: no paste, no dialog (main checks it was agreed to). */
  function retryKey(pid, where) {
    var st = KS(where);
    var stage = st && st.stage;
    if (!stage) { showResult({ ok: false, error: 'stage_expired', provider: pid }, where); return Promise.resolve(); }
    say(checkingText(pid));
    return B.retryConnect({ provider: stage.provider, stageId: stage.stageId }).then(function (res) {
      return ensureProviders().then(refreshStatus).then(function () { showResult(res, where); });
    });
  }
  /** A retest of the saved key's failure, by its kind, as the result table names it. */
  var SAVED_RETEST = {
    network: 'network', network_before_send: 'network', network_after_send: 'network', overloaded: 'overloaded', timeout: 'overloaded',
    rate_limited: 'rate_limited', rate_limited_daily: 'rate_limited', spend_limit: 'spend_limit', region_blocked: 'region_blocked',
    // The app's own guard refused the company's own address (fix-102): a restart, never the internet.
    egress_blocked: 'restart',
  };
  /** Test again on a key saved with no credit: the saved key's test (a pass clears the mark). */
  function testSaved(pid, where) {
    say(checkingText(pid));
    return B.testKey({ provider: pid }).then(function (r) {
      return ensureProviders().then(refreshStatus).then(function () {
        var kind = r && r.error;
        if (r && r.ok) showResult({ ok: true, provider: pid, ai: aiName(pid), masked: ((providerById(pid) || {}).key || {}).masked, testCall: r.testCall, cleared: false }, where);
        else if (kind === 'out_of_credit') showResult({ ok: false, error: 'out_of_credit', provider: pid, saved: true, still: true, retest: 'saved' }, where);
        else if (kind === 'auth_invalid') showResult({ ok: false, error: 'saved_rejected', provider: pid, retest: 'saved' }, where);
        else if (kind === 'no_key' && r.action === 'keys') showResult({ ok: false, error: 'read_failed', provider: pid, saved: true, retest: 'saved' }, where);
        else showResult({ ok: false, error: SAVED_RETEST[kind] || 'failed', provider: pid, saved: true, retest: 'saved' }, where);
      });
    });
  }
  /** Use saved key (returning): the dialog only when the terms aren't recorded (main decides). */
  function useSaved(pid, where) {
    var st = KS(where);
    if (!st || st.busy) return Promise.resolve();
    awaitAgree(st, 'saved', function () { return checkingText(pid); });
    rerender();
    return B.useSavedKey({ provider: pid }).then(function (res) {
      doneWaiting(st);
      return ensureProviders().then(refreshStatus).then(function () { showResult(res, where); });
    });
  }
  /**
   * Sign in with a plan (ChatGPT): main shows the dialog, then the bridge opens the player's browser
   * at the company's sign-in page and waits for it; Cancel sign-in stops the wait.
   */
  function signIn(pid, where) {
    var st = KS(where);
    if (!st || st.busy) return Promise.resolve();
    st.slot = null;
    awaitAgree(st, 'signin', function () { return T('ai.signingInBtn'); });
    rerender();
    return B.signIn({ provider: pid }).then(function (res) {
      doneWaiting(st);
      return ensureProviders().then(refreshStatus).then(function () { showResult(res, where); });
    });
  }
  /**
   * After ✓ connected: step 3. The old "Check your defaults" is gone: its defaults apply as they were
   * (the cheaper model, the privacy switches as they are, start at login on, notifications on, no
   * daily limit), each changeable on Your AI, Usage and Settings.
   */
  function afterConnect(where) {
    if (where === 'pick') { S.ya = null; rerender(true); return; }
    var st = S.setup;
    var pid = (st.slot && st.slot.provider) || st.pick || st.provider;
    var li = (S.info && S.info.loginItem) || { supported: false };
    st.moving = true;
    B.finishDefaults({ loginItem: !!li.supported, notifications: true }).then(function (r) {
      if (r && r.state) S.appState = Object.assign({}, S.appState, r.state);
      if (r && r.loginItem && S.info) S.info.loginItem = Object.assign({}, S.info.loginItem, r.loginItem);
    }, function () {}).then(function () {
      st.moving = false;
      toScreen(st.screen, 'wow', { provider: pid, path: st.path === 'custom' ? 'custom' : 'key' });
    });
  }
  /** Continue anyway (T1): install and allow while the credit lands. */
  function carryOn(where) { afterConnect(where); }
  /** OpenRouter's OpenAI-compatible address, filled in when a pasted OpenRouter key leads to Other. */
  var OPENROUTER_URL = 'https://openrouter.ai/api/v1';
  /** Other's form with a base URL filled in (an OpenRouter key pasted) and that key, staged by main (carry). */
  function toCustom(where, url, carry) {
    var custom = { baseUrl: url || '', model: '', stageId: carry && carry.stageId || null, masked: carry && carry.masked || null };
    if (where !== 'ai') {
      S.keyFlow = null;
      S.ya = { view: 'custom', custom: custom, customResult: null };
      rerender(true, function () { reveal('custom-form', 'custom-url'); });
      return;
    }
    toScreen(S.setup.screen, 'connect', { path: 'custom', provider: 'custom', pick: 'custom', dropStage: true, custom: custom, customResult: null });
  }

  // ⌘V anywhere on step 2 (or Your AI's picker) is Paste key (never reading the event's clipboard: main reads it).
  document.addEventListener('paste', function (e) {
    var where = S.page === 'setup' && S.setup && S.setup.screen === 'ai' ? 'ai' : S.page === 'provider' && S.ya && S.ya.view === 'pick' ? 'pick' : null;
    if (!where || S.sheet) return;
    var st = KS(where);
    if (st.pick === 'custom') return;
    var t = e.target;
    if (t && t.tagName && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    e.preventDefault();
    pasteKey(where);
  });

  // ---- Step 2: "Connect your AI"

  /**
   * The picture of where your data goes (shown, not told): your computer, straight to the AI company
   * (or the service you connect); NeverQuestAlone struck out, no account, no tracking; and what's in a
   * message. One image to a screen reader, its words the alt. pid: the AI in use or picked.
   */
  /** Where a message goes, in words: the AI company (or the model on this computer, or Other's name), its line under it, and the picture's name. */
  function flowNames(pid) {
    var custom = !pid || isCustom(pid);
    var local = !!pid && isLocal(pid);
    var to = local ? aiName(pid) : custom ? (customName() || F.clean(disp('custom').card || 'Other', 24)) : coName(pid);
    var cur = P().provider;
    var sub = local ? T('pages.privacy.localLine') : cur && cur.id === pid ? modelName(cur.modelName || cur.model) : (!custom ? aiName(pid) : null);
    return { to: to, sub: sub, alt: custom || local ? T('flow.ariaOther') : T('flow.aria', { co: to }) };
  }
  /** What an AI company keeps: the manifest's own short line (privacyCard.short), or null. */
  function keptShort(pid) {
    var p = providerById(pid);
    var c = p && p.privacyCard;
    if (!c) return null;
    // A manifest without its short line: what it keeps and whether it trains, its own words (CL-words-07).
    return c.short ? playerWords(c.short) : [c.keeps, c.trains].filter(Boolean).map(playerWords).join(' ') || null;
  }
  /** The sheet for an AI (spec §6.1 Details): the cost, your key, the picture, what it keeps, terms, fine print. */
  function aiSheet(pid) {
    return function () {
      if (!pid || isCustom(pid)) return customSheet();
      var v = namesOf(pid);
      var p = providerById(pid) || {};
      var win = isWin();
      var sub = PT(pid, 'subscription', v);
      var extra = PT(pid, 'extraLine', v);
      var kept = keptShort(pid);
      return {
        title: T('details.title', v),
        sections: [
          { label: T('details.costLabel'), body: [T('details.costBody', v), sub].filter(Boolean) },
          { label: T('details.keyLabel'), body: [win ? T('details.keyBodyWin', v) : T('details.keyBody', v), win && S.info && S.info.workPc ? T('details.workPcBodyWin') : null].filter(Boolean) },
          { label: T('details.leavesLabel'), body: [sheetCard(whereRows(pid))] },
          kept || extra || p.id ? { label: T('details.keptLabel', v), body: [sheetCard([kept ? sheetLine(kept) : null, extra ? sheetLine(extra) : null, p.id ? sheetLinkRow(T('details.termsLink', v), openLink(pid + '.terms'), 'terms-' + pid) : null])] } : null,
          { fine: true, body: h('p', { class: 'fine', text: T('details.fineBody') }) },
        ],
      };
    };
  }
  function customSheet() {
    var v = namesOf('custom');
    return {
      title: T('details.titleOther'),
      sections: [
        { label: T('details.worksLabel'), body: T('details.otherWorksBody') },
        { label: T('details.keyLabel'), body: isWin() ? T('details.otherKeyBodyWin', v) : T('details.otherKeyBody', v) },
        { label: T('details.leavesLabel'), body: [sheetCard(whereRows('custom').concat([sheetItem('shield', T('details.otherLeavesBody'), null, 'sheet-row-quiet')]))] },
        { fine: true, body: h('p', { class: 'fine', text: T('details.fineBody') }) },
      ],
    };
  }
  /** A row's cost ("$0.17–0.37 a day"), or Other's line. */
  function costOf(pid) {
    if (isCustom(pid)) return customName() && isCustom((P().provider || {}).id) ? customName() : T('ai.otherCostLine');
    if (isSignin(pid)) return T('ai.planCostLine');
    var day = dayOf(defaultModelOf(pid));
    return day ? T('ai.dayCostLine', { dayCost: day.text }) : '';
  }
  /**
   * The AI rows (spec §4.5): a radio, the name, the cost on the right; a chip after the name for a
   * saved key (Key saved, Key rejected, No credit) or a connection. st: the flow's state.
   */
  function aiRows(st, where) {
    var ids = cardAis().map(function (p) { return p.id; });
    if (otherShown()) ids.push('custom');
    var cur = P().provider;
    var items = ids.map(function (id) {
      return {
        key: id,
        node: function (checked) {
          var p = providerById(id) || {};
          var k = p.key || {};
          var ok = st.slot && st.slot.ok && (st.slot.provider === id || (!st.slot.provider && st.pick === id));
          var chipNode = null;
          if (id === 'custom') chipNode = customOf() && cur && cur.id === 'custom' && aiReady() ? chip(T('ai.connectedChip'), 'ok') : null;
          else if (ok) chipNode = null; // the tick and the result line say it (APP-D-29)
          else if (!(st.slot && st.pick === id) && k.saved) chipNode = rejectedKey(k) ? chip(isSignin(id) ? T('ai.signInAgainBtn') : T('ai.keyRejectedChip'), 'bad') : isSignin(id) ? chip(T('ai.signedInChip'), 'ok') : k.state === 'no_credit' ? chip(T('ai.noCreditChip'), 'warn') : chip(T('ai.keySavedChip'), 'ok');
          var cost = costOf(id);
          return h('button', { type: 'button', class: 'choice' + (checked ? ' is-checked' : ''), 'data-fk': 'card-' + id, id: 'choice-' + id },
            h('span', { class: 'choice-name' }, h('span', { class: 'choice-names' }, h('span', { class: 'choice-title', text: id === 'custom' ? F.clean(disp('custom').card || 'Other', 24) : aiName(id) })), chipNode),
            h('span', { class: 'choice-cost', 'data-count': cost && cost !== T('ai.otherCostLine') ? 'data' : null }, keepWhole(cost)),
            ico('check', 'choice-tick'));
        },
      };
    });
    return h('div', { class: 'choices-wrap', 'data-key': 'choices-wrap' },
      radioGroup('choices', T('ai.legend'), items, st.pick, function (id, byClick) {
        if (st.busy) return;
        if (st.pick !== id) {
          if (st.stage) { B.dropStagedKey({ stageId: st.stage.stageId }); st.stage = null; }
          st.slot = null;
          st.hiddenAi = null;
        }
        st.pick = id;
        st.provider = id;
        if (where === 'ai') saveSetup();
        rerender(false, function () { focusEl(document.getElementById('choice-' + id)); });
      }));
  }
  /**
   * Step 2's actions: the primary (Paste {co} key, or what the result or a saved key makes it), the
   * AI company's own key page (quiet), Show details (ghost, right). One primary on the screen.
   */
  function aiActions(st, where) {
    var pid = st.pick;
    var p = providerById(pid) || {};
    var v = namesOf(pid);
    var k = p.key || {};
    var r = st.slot ? keyResult(st.slot, where) : null;
    var busyPaste = st.busy === 'paste' || st.busy === 'saved';
    var agreeing = st.busy === 'agree';
    var main = null;
    var quietNode = null;
    var ghostNode = null;
    if (isSignin(pid) && !r) {
      var signing = st.busy === 'signin';
      if (signing) {
        main = busyNow(primary(T('ai.signingInBtn'), null, { fk: 'sign-in' }));
        quietNode = quiet(T('ai.cancelSignInBtn'), function () { B.cancelSignIn({ provider: pid }); }, { fk: 'cancel-sign-in' });
      } else if (busyPaste) {
        main = busyNow(primary(checkingText(st.checkingWith || pid), null, { fk: 'use-saved' }));
      } else if (k.saved && !rejectedKey(k)) {
        main = primary(T('ai.useSignInBtn'), function () { useSaved(pid, where); }, { fk: 'use-saved' });
        quietNode = quiet(T('ai.signInAgainBtn'), function () { signIn(pid, where); }, { fk: 'sign-in' });
      } else {
        main = primary(PT(pid, 'signInBtn', v) || T('ai.signInBtn', v), function () { signIn(pid, where); }, { fk: 'sign-in' });
        quietNode = btn(T('ai.plansBtn', v), openLink(pid + '.plans'), 'btn btn-quiet', { fk: 'open-plans', after: 'out' });
      }
    } else if (isCustom(pid)) {
      var customReady = customOf() && isCustom((P().provider || {}).id) && aiReady();
      main = customReady && where === 'ai'
        ? primary(T('ai.continueBtn'), function () { afterConnect(where); }, { fk: 'continue' })
        : primary(T('ai.setUpOtherBtn'), function () { toCustom(where, customOf() ? customOf().baseUrl : '', null); }, { fk: 'set-up-other' });
    } else if (busyPaste) {
      main = busyNow(primary(checkingText(st.checkingWith || pid), null, { fk: 'paste-key' }));
    } else if (r && r.primary) {
      var rp = r.primary;
      if (rp.out) main = primary(rp.label, rp.fn, { fk: rp.fk, after: 'out' }); // a web page: no busy state
      else { main = primary(rp.label, null, { fk: rp.fk }); on(main, 'click', busy(main, function () { return rp.fn(); })); }
      quietNode = r.quiet || null;
      ghostNode = r.ghost || null;
    } else if (r && r.bare) {
      main = null; // the rows are the next step
    } else if (!r && k.saved && !rejectedKey(k) && k.state === 'no_credit') {
      // The fix first (CL-words-22): Add credit opens the company's page; Test again is quiet.
      main = primary(T('ai.addCreditBtn', v), openLink(pid + '.billing'), { fk: 'add-credit', after: 'out' });
      quietNode = busyBtn(T('ai.testAgainBtn'), function () { return testSaved(pid, where); }, 'btn btn-quiet', { fk: 'test-again' });
    } else if (!r && k.saved && !rejectedKey(k)) {
      main = primary(T('ai.useSavedBtn'), function () { useSaved(pid, where); }, { fk: 'use-saved' });
      quietNode = quiet(T('ai.pasteNewBtn'), function () { pasteKey(where); }, { fk: 'paste-key' });
    } else if (!r && rejectedKey(k)) {
      main = primary(T('ai.pasteNewBtn'), function () { pasteKey(where); }, { fk: 'paste-key', kbd: pasteKbd(), 'aria-keyshortcuts': isMac() ? 'Meta+V' : 'Control+V' });
    } else {
      main = primary(T('ai.pasteBtn', v), function () { pasteKey(where); }, { fk: 'paste-key', kbd: pasteKbd(), 'aria-keyshortcuts': isMac() ? 'Meta+V' : 'Control+V' });
    }
    if (agreeing && main) main.setAttribute('aria-disabled', 'true');
    // The AI company's own key page: one link, the same words for every AI (sign-up and credit start there).
    if (!quietNode && !busyPaste && !isCustom(pid) && !isSignin(pid) && !(r && (r.connected || r.bare))) {
      quietNode = btn(T('ai.getKeyBtn', v), openLink(pid + '.keys'), 'btn btn-quiet', { fk: 'open-keys', after: 'out' });
    }
    // No key yet? (onboarding critic ON-01): setup's step 2, before any key or result, opens the key's numbered steps.
    if (where === 'ai' && (!r || NO_KEY_YET[st.slot && st.slot.error]) && !busyPaste && !ghostNode && !k.saved && !isCustom(pid) && !isLocal(pid) && !isSignin(pid)) {
      ghostNode = btn(T('ai.noKeyLink'), function () {
        st.noKey = !st.noKey;
        rerender(false, function () { focusAfter('no-key')(); var box = document.getElementById('no-key-box'); if (box) box.scrollIntoView({ block: 'nearest' }); });
      }, 'btn-link',
        { fk: 'no-key', 'aria-expanded': st.noKey ? 'true' : 'false', 'aria-controls': 'no-key-box' });
    }
    // Your AI's Switch: a key saved for an AI that isn't in use can go too (the one in use has its Key row's).
    var cur = P().provider;
    var drop = where === 'pick' && !r && !busyPaste && k.saved && !isCustom(pid) && !(cur && cur.id === pid) ? deleteKeyBtn(pid, 'btn btn-quiet btn-danger') : null;
    return h('div', { class: 'actions', 'data-key': 'actions' }, main, quietNode, ghostNode, drop);
  }
  /** The result slot: one line, under the actions, reserved so its first line doesn't move them. */
  function slotLine(st, where) {
    var line = null;
    if (st.slot) { var k = keyResult(st.slot, where); line = resultLine(k.kind, k.line, st.slot); }
    else if (st.hiddenAi) line = resultLine('warn', T('ai.hiddenLine', { ai: aiName(st.hiddenAi) }), null);
    return h('div', { class: 'result-slot', id: 'result-slot', 'data-key': 'slot' }, line);
  }
  function moveBanner() {
    if (!isMac() || !S.info || S.info.inApplications !== false) return null;
    var st = S.setup;
    var out = st.moveResult;
    return h('div', { class: 'banner banner-neutral', role: 'group', 'aria-label': T('move.headline'), 'data-key': 'move' },
      ico('info', 'banner-ico'), h('p', { class: 'banner-text', text: T('move.headline') }),
      busyBtn(T('move.moveBtn'), function () {
        return B.moveToApplications().then(function (r) { st.moveResult = r && r.ok === false ? stamp(r) : null; rerender(); });
      }, 'btn btn-quiet btn-sm', { fk: 'move' }),
      out ? resultLine('bad', F.clean(out.headline || T('common.failedLine'), 120), out, 'banner-out') : null);
  }
  /** The row picked on arrival: the AI in use, else one with a key saved, else the first (Claude). */
  function firstPick() {
    var cur = P().provider;
    if (cur && providerById(cur.id) && !providerById(cur.id).hidden) return cur.id;
    var ais = cardAis();
    var keyed = ais.filter(function (p) { return p.key && p.key.saved; })[0];
    return keyed ? keyed.id : ais[0] ? ais[0].id : 'custom';
  }
  /**
   * Step 2's head: the title with the picked AI's Details on its line (one placement, CL-design-26), and
   * one line. Before a key works, what the picked AI needs ("Claude needs credit at Anthropic.",
   * CL-player-29); once a result line shows or the AI's key has passed a test, the plain lead, so a
   * connected player never reads a need they've met and the rows never move (CL-words-65, CL-player-49).
   * A rejected saved key takes the plain lead too: its chip is a result, and the fix is a new key, not
   * credit (CL-words-68). The line's slot is kept when it's empty, so the rows sit at one height in
   * every state, under the pointer that picks one (CL-design-51).
   */
  function pickHead(text, st) {
    var pid = st.pick;
    var p = providerById(pid);
    var k = (p && p.key) || {};
    var needs = p && !isCustom(pid) && !isLocal(pid) && !st.slot && !st.hiddenAi && !(k.saved && k.state === 'ok') && !rejectedKey(k);
    return h('div', { class: 'pick-head', 'data-key': 'pick-head' },
      h('div', { class: 'title-row', 'data-key': 'title-row' }, title(text), detailsBtn(isCustom(pid) ? customSheet : aiSheet(pid))),
      para(needs ? PT(pid, 'creditLead', namesOf(pid)) || T('ai.creditLead', namesOf(pid)) : '', 'lead lead-slot'));
  }
  /**
   * The welcome (a first run only): what Bones does for your questing, in the game's own frame, and
   * one primary. The AI is a supporting fact, one small line.
   */
  function welcomeScreen() {
    var name = companion();
    return pageNode('setup-welcome', setupTop(null), [
      h('div', { class: 'welcome', 'data-key': 'welcome' },
        h('div', { class: 'welcome-text' },
          title(T('welcome.title', { name: name })),
          para(T('welcome.lead', { name: name }), 'lead'),
          para(T('welcome.aiLine'), 'small muted welcome-ai'),
          h('div', { class: 'actions', 'data-key': 'actions' }, primary(T('welcome.startBtn', { name: name }), function () { toScreen('welcome', 'ai'); }, { fk: 'start-setup' }))),
        routeMap()),
    ]);
  }
  /** A paste that held no key (or a sign-in token): No key yet? stays, and its box stays open (onboarding critic OB-03). */
  var NO_KEY_YET = { clipboard_empty: 1, not_a_key: 1, subscription_token: 1, cancelled: 1 };
  /** No key yet?'s box: the picked AI's key in four numbered steps (its subscriptions' line stays in Show details). */
  function noKeyBox(st) {
    var pid = st.pick;
    var p = providerById(pid);
    if (!st.noKey || !p || isCustom(pid) || isLocal(pid) || st.busy || (st.slot && !NO_KEY_YET[st.slot.error]) || (p.key && p.key.saved)) return null;
    var v = namesOf(pid);
    var steps = [T('ai.keyStepSignIn', v), PT(pid, 'creditStep', v), PT(pid, 'createStep', v), T('ai.keyStepBack', v)].filter(Boolean);
    return h('div', { class: 'obj-note', id: 'no-key-box', 'data-behind': 'click', 'data-key': 'no-key' },
      h('ol', { class: 'obj-steps small' }, steps.map(function (s) { return h('li', null, keepWhole(s)); })));
  }
  function aiScreen() {
    var st = S.setup;
    if (!st.pick || (!providerById(st.pick) && st.pick !== 'custom') || (providerById(st.pick) && providerById(st.pick).hidden)) st.pick = firstPick();
    var node = pageNode('setup-pick' + (isMac() && S.info && S.info.inApplications === false ? ' has-move' : ''), setupTop(null), [
      moveBanner(),
      pickHead(T('ai.title'), st),
      aiRows(st, 'ai'),
      aiActions(st, 'ai'),
      slotLine(st, 'ai'), // a paste's result right under its button, above the open No key yet? box (OB-18)
      noKeyBox(st),
    ]);
    return node;
  }

  // ---- 6.1.2 Other: any OpenAI-compatible service at its own address

  var CUSTOM_FAIL = {
    empty: 'badUrl', too_long: 'badUrl', bad_url: 'badUrl', not_http: 'badUrl', https_required: 'httpsRequired', credentials: 'credentials', query: 'query',
    bad_model: 'badModel', not_a_key: 'notAKey', key_expired: 'keyExpired', auth_invalid: 'authInvalid', model_access: 'modelAccess', network: 'network',
    out_of_credit: 'outOfCredit', spend_limit: 'outOfCredit', rate_limited: 'busy', overloaded: 'busy', keystore_error: 'keystoreError', cancelled: 'cancelled',
    restart: 'restart',
  };
  /** The model placeholder for an address: Groq's and Ollama's ids there, else OpenRouter's. */
  function modelHintKey(baseUrl) {
    var u = String(baseUrl || '').toLowerCase();
    if (/(^|[/.])groq\.com([:/]|$)/.test(u)) return 'custom.modelPlaceholderGroq';
    if (/:11434([/]|$)/.test(u)) return 'custom.modelPlaceholderOllama';
    return 'custom.modelPlaceholder';
  }
  /**
   * Other's form: Base URL, API key (optional: a server on this computer takes none) and Model, then
   * Connect. main asks before anything is sent (its confirm names the address); the bridge sends one
   * tiny test request and saves the service only when it answers. The key goes to main and is cleared
   * from the field at once; a pasted one is read by main, never here (code health AP-05), staged for
   * the form (the field shows its mask) and taken off the clipboard once it's saved. st: setup's
   * state or Your AI's; where: 'ai' or 'pick'.
   */
  function customForm(st, where) {
    var saved = customOf();
    if (!st.custom) st.custom = { baseUrl: saved ? saved.baseUrl : '', model: saved && saved.model ? saved.model : '' };
    var d = st.custom;
    var r = st.customResult;
    var busyNow2 = st.busy === 'custom';
    var field = function (id, lbl, input) { return h('div', { class: 'field', 'data-key': 'f-' + id }, h('label', { for: id, text: lbl }), input); };
    var url = h('input', {
      type: 'url', id: 'custom-url', class: 'input', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', value: d.baseUrl, placeholder: T('custom.baseUrlPlaceholder'),
      onInput: function (e) {
        d.baseUrl = e.target.value;
        var m = document.getElementById('custom-model');
        if (m) m.setAttribute('placeholder', T(modelHintKey(d.baseUrl)));
      },
    });
    var key = h('input', { type: 'password', id: 'custom-key', class: 'input key-input', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: d.stageId && d.masked ? T('custom.keyStagedPlaceholder', { masked: F.clean(d.masked, 40) }) : T('custom.keyPlaceholder') });
    var model = h('input', {
      type: 'text', id: 'custom-model', class: 'input', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', value: d.model, placeholder: T(modelHintKey(d.baseUrl)),
      onInput: function (e) { d.model = e.target.value; },
    });
    var send = function () {
      if (st.busy) return;
      var early = !String(d.baseUrl || '').trim() ? 'empty' : !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(String(d.model || '').trim()) ? 'bad_model' : null;
      if (early) { st.customResult = stamp({ ok: false, error: early }); rerender(false, function () { focusEl(document.getElementById(early === 'empty' ? 'custom-url' : 'custom-model')); }); return; }
      var kf = document.getElementById('custom-key');
      var typed = kf ? String(kf.value || '') : '';
      if (kf) kf.value = '';
      var body = { baseUrl: String(d.baseUrl || '').trim(), model: String(d.model || '').trim() };
      if (typed.trim()) body.key = typed.trim();
      else if (d.stageId) body.stageId = d.stageId;
      typed = '';
      st.customResult = null;
      awaitAgree(st, 'custom', function () { return T('custom.checkingBtn'); });
      rerender();
      B.connectCustom(body).then(function (res) {
        doneWaiting(st);
        st.customResult = stamp(res || { ok: false, error: 'failed' });
        if (res && (res.ok || res.error === 'key_expired')) { d.stageId = null; d.masked = null; }
        return ensureProviders().then(refreshStatus);
      }).then(function () {
        var cr = st.customResult;
        if (where === 'ai' && cr && cr.ok) {
          var host = F.clean(cr.name || (customOf() || {}).host || '', 60);
          say(cr.local ? T('custom.ok.localLine', { host: host, model: F.clean(cr.model || d.model, 60) }) : T('custom.ok.headline', { host: host }));
          afterConnect('ai');
          return;
        }
        rerender(false, function () { var el = findByKey({ fk: st.customResult && st.customResult.ok ? 'continue' : 'custom-go', n: 0 }); if (!focusEl(el)) focusTitle(); });
      });
      body = null;
    };
    on(model, 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    on(url, 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    on(key, 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    // A paste: main reads it and stages it for this form (custom_key, as an OpenRouter key pasted on a
    // card is); an empty clipboard does nothing, as in any field.
    on(key, 'paste', function (e) {
      e.preventDefault();
      this.value = '';
      if (st.busy) return;
      B.pasteKey({ provider: 'custom' }).then(function (res) {
        if (res && res.stageId) {
          if (d.stageId && d.stageId !== res.stageId) B.dropStagedKey({ stageId: d.stageId });
          d.stageId = res.stageId;
          d.masked = res.masked;
          st.customResult = null;
        } else if (res && res.error === 'not_a_key') st.customResult = stamp({ ok: false, error: 'not_a_key' });
        else return;
        rerender(false, function () { focusEl(document.getElementById('custom-key')); });
      });
    });
    var go1;
    if (r && r.ok) go1 = primary(T('ai.continueBtn'), function () { if (where === 'ai') afterConnect('ai'); else { S.ya = null; rerender(true); } }, { fk: 'continue' });
    // The app's own connections stopped (fix-102): Quit and reopen takes Connect's place.
    else if (r && CUSTOM_FAIL[r.error] === 'restart') go1 = quitReopenBtn('btn btn-primary');
    else {
      go1 = primary(busyNow2 ? T('custom.checkingBtn') : T('custom.connectBtn'), send, { fk: 'custom-go' });
      if (busyNow2) busyNow(go1); else if (st.busy === 'agree') go1.setAttribute('aria-disabled', 'true');
    }
    var out = null;
    if (r && r.ok) {
      var host = F.clean(r.name || (customOf() || {}).host || '', 60);
      out = resultLine('ok', r.local ? T('custom.ok.localLine', { host: host, model: F.clean(r.model || d.model, 60) }) : T('custom.ok.headline', { host: host }), r);
    } else if (r) {
      var fk = CUSTOM_FAIL[r.error] || 'failed';
      var fv = { host: F.clean(d.baseUrl ? String(d.baseUrl).replace(/^[a-z]+:\/\//i, '').split('/')[0] : '', 60) };
      out = resultLine(fk === 'cancelled' ? 'warn' : 'bad', T('custom.' + fk + '.headline', fv), r);
    }
    return h('div', { class: 'custom-form', id: 'custom-form', 'data-key': 'custom-form' },
      h('div', { class: 'fields' },
        field('custom-url', T('custom.baseUrlLabel'), url),
        field('custom-key', T('custom.keyLabel'), key),
        field('custom-model', T('custom.modelLabel'), model)),
      h('div', { class: 'actions', 'data-key': 'actions' }, go1),
      h('div', { class: 'result-slot', id: 'result-slot', 'data-key': 'slot' }, out));
  }
  function customScreen() {
    var st = S.setup;
    var back = function () { toScreen('connect', 'ai', { path: 'key', pick: 'custom' }); };
    return pageNode('setup-other', setupTop(back), [
      h('div', { class: 'title-row', 'data-key': 'title-row' }, title(T('custom.title')), detailsBtn(customSheet)),
      para(T('custom.lead'), 'lead'),
      customForm(st, 'ai'),
    ]);
  }

  // ---- Step 3: "Say hi in game": the objectives (spec §4.7)

  /**
   * An objective row. state: done, now (the current one: its line and its actions), next, wait (a
   * row waiting on an event, with its line), error (warn diamond; its line says what went wrong).
   */
  function objective(id, titleText, state, meta, acts, extra) {
    var finished = state === 'done' || state === 'skipped';
    var mark = finished ? 'dia-done' : state === 'now' || state === 'wait' ? 'dia-now' : state === 'error' ? 'dia-warn' : 'dia-next';
    var sr = state === 'skipped' ? T('stage.ariaSkipped', { step: titleText }) : state === 'done' ? T('stage.ariaDone', { step: titleText }) : titleText;
    var metaNode = meta ? (meta.nodeType ? meta : h('p', { class: 'obj-meta' }, keepWhole(meta))) : null;
    if (metaNode && finished) metaNode.setAttribute('data-say', metaNode.textContent);
    return h('section', { class: 'obj obj-' + state, 'aria-labelledby': id + '-title', 'data-row': id, 'aria-current': state === 'now' || state === 'error' ? 'step' : null },
      ico(mark, 'obj-mark'),
      h('div', { class: 'obj-body' },
        h('h2', { class: 'obj-title', id: id + '-title' }, h('span', { 'aria-hidden': finished ? 'true' : null, text: titleText }), finished ? h('span', { class: 'sr-only', text: sr }) : null),
        metaNode,
        acts && acts.filter(Boolean).length ? h('div', { class: 'obj-actions' }, acts) : null,
        extra || null));
  }
  function installRow(ctx) {
    var sb = setupBlock();
    var a = sb.addon || {};
    var st = S.setup;
    var path = a.path;
    var p = ctx.primary;
    var cur = ctx.current;
    var I = function (k, v) { return T('sayHi.install.' + k, v); };
    var cls = function (isPrimary) { return isPrimary ? 'btn btn-primary' : 'btn btn-quiet'; };
    var inst = function (whenClosed, fk) {
      return function () {
        var args = { whenClosed: !!whenClosed };
        var pick = st.installPick || path;
        if (pick) args.flavorDir = pick;
        return B.installAddon(args).then(function (r) {
          st.installResult = r && r.ok === false ? stamp(r) : null;
          return refreshStatus();
        }).then(function () { rerender(false, function () { focusEl(findByKey({ fk: fk, n: 0 })) || focusEl(findByKey({ fk: 'row-primary', n: 0 })) || focusStep(); }); });
      };
    };
    var chooseFolder = function (labelId, fix) {
      return busyBtn(I(labelId), function () {
        return B.chooseWowFolder().then(function (r) { st.folderErr = isErr(r) && r.error !== 'cancelled' ? stamp(r) : null; return B.findWow(); }).then(refreshStatus).then(function () { rerender(); });
      }, fix ? cls(p) : 'btn btn-ghost', { fk: 'choose-folder' });
    };
    var meta = null;
    var acts = [];
    var state = cur ? 'now' : 'next';
    var extra = null;
    switch (a.state) {
      case 'looking':
      case undefined:
        meta = I('lookingLine');
        state = 'wait';
        break;
      case 'found':
        meta = I('foundLine');
        acts.push(busyBtn(I('installBtn'), inst(false, 'install'), cls(p), { fk: p ? 'row-primary' : 'install' }), chooseFolder('chooseFolderBtn'));
        break;
      case 'running':
        meta = I('runningLine');
        acts.push(busyBtn(I('installWhenClosedBtn'), inst(true, 'install-when-closed'), cls(p), { fk: p ? 'row-primary' : 'install-when-closed' }));
        break;
      case 'armed':
        state = cur ? 'now' : 'wait'; // the current row once the others are done (OB-21)
        meta = I('armedLine');
        acts.push(busyBtn(I('cancelBtn'), function () { return B.cancelInstall().then(refreshStatus).then(function () { rerender(); }); }, cur ? 'btn-ghost' : 'btn btn-quiet btn-sm', { fk: 'cancel-install' }));
        break;
      case 'installing':
        state = 'wait';
        meta = h('p', { class: 'obj-meta', 'aria-busy': 'true', text: I('installingLine') });
        break;
      case 'current':
        state = 'done';
        if (a.othersCanWrite) { meta = I('othersCanWriteLine'); acts.push(ghost(I('openDiagnosticsBtn'), function () { go('diagnostics'); }, { fk: 'open-diagnostics' })); }
        break;
      case 'choose': {
        var cands = Array.isArray(a.candidates) ? a.candidates : [];
        var sel = st.installPick && cands.some(function (c) { return c.path === st.installPick; }) ? st.installPick : (cands[0] && cands[0].path);
        st.installPick = sel;
        meta = I('severalLine', { count: cands.length });
        acts.push(h('label', { for: 'wow-install', class: 'sr-only', text: I('folderLabel') }),
          h('select', { id: 'wow-install', class: 'select', onChange: function (e) { st.installPick = e.target.value; } }, cands.map(function (c) {
            return h('option', { value: c.path, selected: c.path === sel, text: F.clean(c.path, 200) + (c.version ? ' (' + F.clean(c.version, 24) + ')' : '') });
          })));
        acts.push(sb.game && sb.game.running
          ? busyBtn(I('installWhenClosedBtn'), inst(true, 'install-when-closed'), cls(p), { fk: p ? 'row-primary' : 'install-when-closed' })
          : busyBtn(I('installBtn'), inst(false, 'install'), cls(p), { fk: p ? 'row-primary' : 'install' }));
        break;
      }
      case 'not_found':
        state = cur ? 'error' : state;
        meta = I('notFoundLine');
        acts.push(chooseFolder('chooseWowFolderBtn', true), busyBtn(I('checkAgainBtn'), function () { return B.findWow().then(refreshStatus).then(function () { rerender(); }); }, 'btn btn-quiet', { fk: 'check-again' }));
        break;
      case 'bad_folder':
        state = cur ? 'error' : state;
        meta = I('badFolderLine');
        acts.push(chooseFolder('chooseWowFolderBtn', true));
        break;
      case 'race':
        state = cur ? 'error' : state;
        meta = I('raceLine');
        acts.push(busyBtn(I('installAgainBtn'), inst(false, 'install-again'), cls(p), { fk: 'install-again' }));
        break;
      case 'older':
        meta = I('olderLine');
        acts.push(sb.game && sb.game.running
          ? busyBtn(I('updateWhenClosedBtn'), inst(true, 'update-when-closed'), cls(p), { fk: p ? 'row-primary' : 'update-when-closed' })
          : busyBtn(I('updateBtn'), inst(false, 'update'), cls(p), { fk: p ? 'row-primary' : 'update' }));
        break;
      case 'eperm':
        state = cur ? 'error' : state;
        meta = I('epermLine');
        acts.push(chooseFolder('chooseAnotherBtn', true));
        if (st.copied.eperm) extra = h('div', { class: 'obj-note' }, para(T(isWin() ? 'sayHi.install.copiedBodyWin' : 'sayHi.install.copiedBody'), 'small'), code(F.clean(st.copied.eperm, 4000)));
        break;
      case 'disk_full':
        state = cur ? 'error' : state;
        meta = I('diskFullLine');
        acts.push(busyBtn(I(a.update ? 'updateAgainBtn' : 'installAgainBtn'), inst(false, 'install-again'), cls(p), { fk: 'install-again' }));
        break;
      default:
        state = cur ? 'error' : state;
        meta = I(a.update ? 'failedUpdateLine' : 'failedLine');
        acts.push(busyBtn(I(a.update ? 'updateAgainBtn' : 'installAgainBtn'), inst(false, 'install-again'), cls(p), { fk: 'install-again' }),
          busyBtn(I('copyDiagnosticsBtn'), function () { return B.copyDiagnostics().then(function (r) { st.copied.diag = !isErr(r); rerender(); }); }, 'btn btn-quiet', { fk: 'copy-diagnostics' }));
        if (st.copied.diag) extra = resultLine('ok', I('copiedDiagnosticsLine'), null);
    }
    // A row that isn't current shows only its title, unless it waits on an event (armed, installing) or is done with a note.
    if (state === 'next') { meta = null; acts = []; }
    if (st.folderErr) extra = resultLine('bad', I('badFolderLine'), st.folderErr);
    return { state: state, node: objective('row-install', I('title'), state, meta, acts, extra) };
  }
  function permissionRow(ctx) {
    var sb = setupBlock();
    var st = S.setup;
    var perm = sb.permission;
    var off = sb.captureState === 'off';
    var name = companion();
    var p = ctx.primary;
    var cur = ctx.current;
    var X = function (k, v) { return T('sayHi.permission.' + k, v); };
    var openSettings = function () { return btn(X('openSettingsBtn'), openLink('mac.screenRecording'), p ? 'btn btn-primary' : 'btn btn-quiet', { fk: p ? 'row-primary' : 'open-screen-settings' }); };
    var state = cur ? 'now' : 'next';
    var meta = null;
    var acts = [];
    var extra = null;
    if (off) {
      state = 'skipped'; // not "allowed": the player turned screen reading off (APP-D-51)
      meta = X('offLine');
    } else if (perm === 'granted') {
      state = 'done';
    } else if (perm === 'asked') {
      if (cur) state = 'now';
      meta = X('askedLine');
      acts.push(openSettings());
    } else if (perm === 'denied') {
      if (cur) state = 'error';
      meta = X('deniedLine');
      acts.push(openSettings());
    } else {
      meta = X('notAskedLine', { name: name });
      acts.push(busyBtn(X('allowBtn'), function () {
        return B.requestScreenRecording().then(refreshStatus).then(function () { rerender(false, focusAfter('row-primary')); });
      }, p ? 'btn btn-primary' : 'btn btn-quiet', { fk: p ? 'row-primary' : 'allow' }));
    }
    if (state === 'next') { meta = null; acts = []; }
    // Skip screen reading? (a ghost under the row once macOS was asked and the answer was no: the app trim
    // leaves the first ask and the box's wait with their one button).
    if (!off && perm === 'denied' && state !== 'next') {
      acts.push(noReadingButton(st));
      if (st.open.noReading) extra = noReadingBox();
    }
    return { state: state, node: objective('row-permission', X('title'), state, meta, acts, extra) };
  }
  /** Windows's Screen reading row: nothing to allow, so it's done; it says it's on, and Skip is a click away. */
  function readingRow() {
    var sb = setupBlock();
    var st = S.setup;
    var off = sb.captureState === 'off';
    var R = function (k) { return T('sayHi.reading.' + k); };
    var inGame = (sb.addon || {}).state === 'current'; // then its title alone, like every finished row (ON-21)
    return { state: off ? 'skipped' : 'done', node: objective('row-reading', R('title'), off ? 'skipped' : 'done', inGame ? null : R(off ? 'offLine' : 'onLine'), off || inGame ? [] : [noReadingButton(st)], !off && !inGame && st.open.noReading ? noReadingBox() : null) };
  }
  function noReadingButton(st) {
    return ghost(T('sayHi.permission.noReadingAsk'), function () { st.open.noReading = !st.open.noReading; rerender(false, focusAfter('no-reading')); }, { fk: 'no-reading', 'aria-expanded': st.open.noReading ? 'true' : 'false', 'aria-controls': 'no-reading-box' });
  }
  function noReadingBox() {
    return h('div', { class: 'obj-note', id: 'no-reading-box', 'data-behind': 'click' }, para(T('sayHi.permission.noReadingLine'), 'small'), readingOffBtn('btn btn-quiet btn-sm'));
  }
  /**
   * Turn off screen reading, one click: the app's own switch (Your data's Screen reading), the same
   * setPrivacy every privacy switch saves through. The addon draws nothing once it hears (its next slot
   * load), and setup's Screen Recording row reads "Screen reading off." Turned on again on Your data.
   */
  function readingOffBtn(cls) {
    return busyBtn(T('sayHi.permission.noReadingBtn'), function () {
      return B.privacy().then(function (v) {
        if (isErr(v)) return v; // never the defaults (SY-10)
        var values = privacyValues(v);
        values.screenReading = false;
        return B.setPrivacy(values).then(function (r) { if (!isErr(r)) S.privacyValues = values; return r; });
      }).then(refreshStatus).then(function () { rerender(false); });
    }, cls, { fk: 'reading-off' });
  }
  /** The addon's Settings section with this companion's name ("What Bones Knows"). */
  /** Still waiting?: the first cause that holds, worked out when it's clicked (never by a timer). */
  function whyNow() {
    var sb = setupBlock();
    var f = (sb.game && sb.game.facts) || {};
    // Screen reading off (here or in the addon): the hello waits in the addon's saved data for a /reload (SY-06).
    if (sb.captureState === 'off' && !(sb.game && sb.game.hello)) return 'readingOff';
    if (isMac() && sb.permission !== 'granted' && sb.captureState !== 'off') return 'noPermission';
    if (f.typedError === 'window_minimized') return 'minimized';
    if (f.typedError === 'capture_blocked_by_app') return 'blocked';
    if (f.window && !f.decoded) return isWin() ? 'noDecodeWin' : 'noDecode';
    if (!f.window && f.frames === 0 && sb.game && sb.game.running) return 'noWindow';
    return 'nothingSeen';
  }
  /**
   * Row 3, Start WoW and say hi: the command to type and Open Battle.net; once WoW runs, Listening
   * and Still waiting?; the hello, the first message, and a first message that failed.
   */
  function startRow(ctx, before) {
    var sb = setupBlock();
    var st = S.setup;
    var g = sb.game || {};
    var hello = g.hello;
    var name = companion();
    var cur = P().provider;
    var W = function (k, v) { return T('sayHi.startWow.' + k, v); };
    var p = ctx.primary;
    var launcher = sb.launcher !== false;
    var state = before ? 'next' : 'now';
    var meta = null;
    var acts = [];
    var extra = null;
    var listen = function (text) { return h('span', { class: 'listen', role: 'status' }, h('span', { class: 'listen-dot', 'aria-hidden': 'true' }), text || W('listeningLine')); };
    var chipRow = function () { return cmdChip(W('code'), 'bones_hi'); };
    // What to do in the game, in order and always on screen (2026-10-05: a player never found the
    // AddOns button): start WoW, or restart it when it was open before the install; check the addon
    // at character select; then the command under it.
    // The first step is only ever a true one (onboarding critic OB-02): Start WoW while it's closed; none once
    // it runs (an install waiting for WoW to close keeps row 1 current, ON-22).
    var steps = function (running) {
      var first = running ? null : 'startStep';
      return h('ol', { class: 'obj-meta obj-steps' },
        first ? h('li', null, keepWhole(W(first))) : null,
        h('li', null, keepWhole(W('addonsStep'))),
        h('li', null, keepWhole(W('loginStep', { name: name }))));
    };
    if (before) {
      // Rows above aren't done: WoW open before the addon is in waits for it to close.
      if (g.running && sb.addon && (sb.addon.state === 'armed' || sb.addon.state === 'race') && !isMac()) meta = W('afterCloseLine'); // pending, with its line (OB-21)
    } else if (!aiReady() && !noCredit()) {
      meta = W('aiNotReadyLine');
    } else if (P().lastError && sb.firstMsgAt) {
      state = 'error';
      var le = P().lastError;
      meta = h('p', { class: 'obj-meta' }, keepWhole(F.clean(le.headline, 200)));
      var fx = fixFor(le.action, cur ? cur.id : null);
      if (fx.length) { fx[0].className = p ? 'btn btn-primary' : 'btn btn-quiet'; acts = acts.concat(fx.slice(0, 1)); }
      extra = para(W('errorLine'), 'small obj-sub');
    } else if (sb.firstMsgAt) {
      state = 'wait';
      meta = null;
      acts.push(listen(cur && isLocal(cur.id) ? W('gotMessageLineLocal', { model: modelName(cur.model) }) : W('gotMessageLine', { ai: cur ? aiName(cur.id) : '' })));
    } else if (hello && (hello.fr || sb.firstReplyBefore)) {
      meta = W('afterReplyLine', { name: name });
      acts.push(listen());
    } else if (hello) {
      meta = W('helloLine', { name: name });
      acts.push(chipRow());
    } else if (g.running) {
      meta = steps(true);
      acts.push(listen(), btn(W('stillWaitingLink'), function () {
        st.why = st.why ? null : stamp({ cause: whyNow() });
        rerender(false, focusAfter('still-waiting'));
      }, 'btn-link', { fk: 'still-waiting', 'aria-expanded': st.why ? 'true' : 'false', 'aria-controls': 'still-waiting-box' }));
      if (st.why) {
        var cause = st.why.cause;
        extra = h('div', { class: 'obj-note', id: 'still-waiting-box', 'data-behind': 'click', 'data-say': W('why.' + cause, { name: name }), 'data-say-n': String(st.why.n) },
          para(W('why.' + cause, { name: name }), 'small'),
          row(btn(W('checkAgainBtn'), function () { refreshStatus().then(function () { st.why = stamp({ cause: whyNow() }); rerender(false, focusAfter('why-check')); }); }, 'btn btn-quiet btn-sm', { fk: 'why-check' })));
      }
    } else {
      meta = steps(false);
      if (launcher) acts.push(busyBtn(W('openBattleNetBtn'), function () { return B.openGame(); }, p ? 'btn btn-primary' : 'btn btn-quiet', { fk: p ? 'row-primary' : 'open-battle-net' }));
    }
    if (state === 'next') { acts = []; }
    return { state: state, node: objective('row-start', W('title'), state, meta, acts, extra) };
  }
  /** WoW updated and the addon needs an update too: Check for updates (opens About, checking), or the download page. */
  function updateFix() {
    var u = S.updates || {};
    var canCheck = u.supported === true && u.configured !== false && u.mode === 'notify';
    var page = !!(S.info && S.info.releases);
    if (!canCheck && !page) return null;
    if (!canCheck) return function () { return btn(T('sayHi.startWow.openDownloadBtn'), openLink('releases'), 'btn btn-quiet', { fk: 'open-download', after: 'out' }); };
    return function () {
      return btn(T('sayHi.startWow.checkUpdatesBtn'), function () {
        B.checkForUpdates().then(function (r) { if (r && r.status) S.updates = r.status; if (S.page === 'about') rerender(); }, function () {});
        go('about');
      }, 'btn btn-quiet', { fk: 'check-updates' });
    };
  }
  /** A card's check that passed on Say hi in game: "Claude is connected.", or the local line. */
  function passLine(prov) {
    if (prov && prov.auth === 'local') return T('local.ready.line', { app: F.clean(prov.name, 60), model: modelName(prov.model) });
    return T('sayHi.passedLine', { ai: prov ? aiName(prov.id) : '' });
  }
  /** Focus on the rows' next step (the screen's primary), else the heading. */
  function focusStep() {
    var next = document.querySelector('#page .objs .btn-primary') || document.querySelector('#page .btn-primary');
    if (!focusEl(next)) focusTitle();
  }
  /** Step 3 has a card over the list while the AI isn't ready (no credit, a rejected key, the model app down). */
  function sayHiNeedsCard() { return noCredit() || !aiReady() || view() === 'local_down'; }
  /** The banner over step 3's list (spec §6.1 step 3's states): its fix is the screen's primary. */
  function sayHiBanner() {
    if (noCredit()) {
      var cur = P().provider;
      var v = namesOf(cur.id);
      var cc = S.setup.cardTest;
      // The fix first (CL-words-22): Add credit is the banner's primary; Test again is quiet after it.
      var m = { key: 'no-credit', tone: 'warn', head: T('sayHi.stateCard.noCreditHeadline', v), acts: [function () {
        return btn(T('sayHi.stateCard.addCreditBtn'), openLink(cur.id + '.billing'), 'btn', { fk: 'add-credit', after: 'out' });
      }], out: cc && !cc.ok ? { kind: 'bad', text: failLines(cc, 'out_of_credit', v).join(' '), n: cc } : null };
      var node = bannerRow(m, true);
      node.insertBefore(busyBtn(T('ai.testAgainBtn'), function () {
        var passed = false;
        return B.testKey({ provider: cur.id }).then(function (r) {
          passed = !isErr(r) && !!r.ok;
          S.setup.cardTest = stamp(r || { ok: false });
          if (passed) S.setup.cardPassed = stamp({ text: passLine(cur) });
          return ensureProviders().then(refreshStatus);
        }).then(function () { rerender(false, passed ? focusStep : null); });
      }, 'btn btn-quiet btn-sm', { fk: 'card-test' }), node.querySelector('.banner-out'));
      return node;
    }
    if (!aiReady() || view() === 'local_down') {
      var sm = stateModel();
      return sm ? bannerRow(sm, true) : null;
    }
    return null;
  }
  /**
   * The welcome's hero: Bones's priority route drawn on a map (CL-design-23), one still. A copy of
   * index.html's own figure (the page never sets an image source itself).
   */
  var $map = document.getElementById('map-src');
  function routeMap() {
    if (!$map) return null;
    var fig = $map.cloneNode(true);
    fig.removeAttribute('id');
    fig.hidden = false;
    fig.removeAttribute('hidden');
    fig.setAttribute('data-key', 'map');
    fig.setAttribute('aria-label', T('welcome.mapAlt', { name: companion() }));
    return fig;
  }
  function sayHiSheet() {
    var name = companion();
    var sb = setupBlock();
    var a = sb.addon || {};
    var st = S.setup;
    var perm = sb.permission;
    var adm = a.admin;
    var epermExtra = a.state === 'eperm' ? (adm && adm.command
      ? [para(F.clean(adm.explanation, 300)), row(busyBtn(T('sayHi.install.copyCommandBtn'), function () {
        return B.copyPermissionsCommand().then(function (r) { if (!isErr(r)) st.copied.eperm = r.command; rerender(); if (S.sheet) paintSheet(); });
      }, 'btn btn-quiet btn-sm', { fk: 'copy-command' }))]
      : [T('sayHi.install.epermAskBody')]) : null;
    return {
      title: T('details.titleSayHi'),
      sections: [
        { label: T('details.addonLabel'), body: [T('details.addonBody', { name: name })].concat(epermExtra || []) },
        isMac() ? { label: T('details.screenLabel'), body: [T('details.screenBody'), perm === 'denied' || perm === 'asked' ? T('sayHi.permission.paneLine', { pane: T(F.paneName(S.info && S.info.osRelease)) }) : null].filter(Boolean) } : { label: T('sayHi.reading.title'), body: [T('details.screenBodyWin')] },
        { label: T('details.noReadingLabel'), body: T('details.noReadingBody') },
        { fine: true, body: h('p', { class: 'fine', text: T('details.fineBody') }) },
      ],
    };
  }
  function wowScreen() {
    var st = S.setup;
    var sb = setupBlock();
    // The addon's hello (it loaded in the game and the app can see it) finishes setup: no task to do
    // (the owner, 2026-10-05). A first reply, before this, finished it too.
    if (sb.firstReplyAt || (sb.game && sb.game.hello)) return finalState();
    var mac = isMac();
    var a = sb.addon || {};
    var installDone = a.state === 'current';
    var armed = a.state === 'armed';
    var permDone = !mac || sb.permission === 'granted' || sb.captureState === 'off';
    var g = sb.game || {};
    var hello = !!g.hello;
    var race = a.state === 'race';
    // WoW updated, or a damaged file: a banner over the list (spec §6.1).
    var fix = !hello && (!!g.ifaceMismatch || sb.captureState === 'damaged');
    // The current row: the first not done and not waiting.
    // A fix banner (WoW updated, a damaged file) is the next step: no row is current, and row 3 waits with its
    // title alone, since nothing loads until it's fixed (the onboarding review's full render).
    var card = sayHiBanner();
    if (card) st.cardPassed = null;
    // An AI card (no credit, a rejected key, the model app down) holds row 3 as well: in game, Say Hi stays off
    // until the AI can answer. Rows 1 and 2 stay doable while it holds.
    var firstTodo = fix ? 'fix'
      : !installDone && !armed && a.state !== 'installing' ? 'install'
      : !permDone ? 'permission'
        : armed ? 'install' // the install waits for WoW to close: row 3 waits for it (ON-22)
          : card ? 'card'
            : 'start';
    // "{ai} is connected." greets step 3 and goes once its first row moves on (onboarding critic OB-14).
    if (st.cardPassed) { if (st.cardPassed.row == null) st.cardPassed.row = firstTodo; else if (st.cardPassed.row !== firstTodo) st.cardPassed = null; }
    var passed = !card && st.cardPassed ? resultLine('ok', st.cardPassed.text, st.cardPassed, 'say-passed') : null;
    var cardHasFix = !!(card && card.querySelector('.btn-primary'));
    var fixBanner = null;
    if (fix) {
      var uf = g.ifaceMismatch ? updateFix() : function () { return btn(T('sayHi.startWow.openDownloadBtn'), openLink('releases'), 'btn btn-quiet', { fk: 'open-download', after: 'out' }); };
      fixBanner = bannerRow({ key: 'fix', tone: g.ifaceMismatch ? 'warn' : 'bad', head: T(g.ifaceMismatch ? 'sayHi.startWow.ifaceMismatchLine' : 'sayHi.startWow.damagedLine'), acts: uf ? [uf] : [] }, !cardHasFix);
    }
    var taken = cardHasFix || !!(fixBanner && fixBanner.querySelector('.btn-primary'));
    var r1 = installRow({ current: firstTodo === 'install', primary: !taken && firstTodo === 'install' });
    var r2 = mac ? permissionRow({ current: firstTodo === 'permission', primary: !taken && firstTodo === 'permission' }) : isWin() ? readingRow() : null;
    var startBefore = firstTodo !== 'start' && !(firstTodo === 'install' && (armed || race) && !mac);
    var r3 = startRow({ current: firstTodo === 'start', primary: !taken && firstTodo === 'start' }, firstTodo !== 'start');
    void startBefore;
    return pageNode('setup-say', setupTop(function () { toScreen('wow', 'ai', { dropStage: true }); }), [
      card || fixBanner,
      card && fixBanner ? fixBanner : null,
      h('div', { class: 'say-head', 'data-key': 'say-head' }, title(T('sayHi.title')), detailsIcon(sayHiSheet)),
      passed,
      h('div', { class: 'say-grid', 'data-key': 'say-grid' },
        h('div', { class: 'objs', 'data-key': 'objs' }, r1.node, r2 ? r2.node : null, r3.node)),
    ]);
  }
  /** You're set (spec §6.1): the title, one line, where he stays, Open Home. */
  function finalState() {
    var sb = setupBlock();
    var st = S.setup;
    var name = companion();
    var li = (S.info && S.info.loginItem) || {};
    var held = li.status && li.status !== 'enabled';
    var loginOff = !li.supported || !li.openAtLogin || held;
    // The hello can come before the AI can answer (no credit): Say Hi stays off in game until then, so the card
    // that fixes it sits above "Almost set up", its button the one primary; You're set and its Say Hi line come
    // once the AI can answer (the ux-writer's round 6, OB-24).
    var card = sayHiBanner();
    var cardHasFix = !!(card && card.querySelector('.btn-primary'));
    if (!card && !st.doneSaid) { st.doneSaid = true; say(T('done.liveLine', { name: name })); }
    // Setup is over: its saved screen goes, so Finish setup never comes back after a restart (ON-25).
    if (S.appState && S.appState.setup) { S.appState = Object.assign({}, S.appState, { setup: null }); B.setAppState({ setup: null }); }
    var node = pageNode('setup-done', { left: [], right: [] }, [
      card,
      title(T(card ? 'finishLater.title' : 'done.title')),
      card ? null : para(T(sb.firstReplyAt ? 'done.mapLineReplied' : 'done.mapLine', { name: name }), 'lead'),
      para(loginOff ? T('done.noLoginLine') : T(isWin() ? 'done.menuBarLineWin' : 'done.menuBarLine'), 'small muted done-sub'),
      h('div', { class: 'actions', 'data-key': 'actions' }, (cardHasFix ? quiet : primary)(T('done.homeBtn'), function () { S.setup = null; go('home'); }, { fk: 'home' })),
    ]);
    return node;
  }

  PAGES.setup = function () {
    return ensureProviders().then(function () {
      if (!S.setup) S.setup = restoreSetup();
      var st = S.setup;
      var screen = st.screen;
      if (screen === 'defaults') screen = st.screen = 'wow';
      var body;
      if (screen === 'connect') body = customScreen();
      else if (screen === 'welcome') body = welcomeScreen();
      else if (screen === 'wow') body = wowScreen();
      else body = aiScreen();
      // The app couldn't start: the banner's button is the one primary; the screen's step waits (CL-words-29).
      if (view() === 'not_running' && body && body.querySelectorAll) {
        body.querySelectorAll('.btn-primary').forEach(function (b) { b.className = String(b.className).replace('btn-primary', 'btn-quiet'); });
      }
      paintPanel();
      return body;
    });
  };

  // -------------------------------------------------------------------------
  // Home (spec §6.2): Bones's condition as the title; the one card when something needs the player;
  // the route card (what Bones does in game, in the game's own frame); one compact row for the AI and
  // today's spend, which opens Your AI.

  /** The XP bar (spec §4.15): 10 segments of the player's own limit; warn from 80%, bad at the limit. */
  function xpBar(spent, cap) {
    var pct = cap > 0 ? Math.min(1, spent / cap) : 1;
    var filled = Math.min(10, Math.max(0, Math.round(pct * 10)));
    if (spent > 0 && filled === 0) filled = 1;
    var tone = pct >= 0.999 ? 'bad' : pct >= 0.8 ? 'warn' : 'ok';
    var segs = [];
    for (var i = 0; i < 10; i++) segs.push(h('i', { class: i < filled ? 'on' : null }));
    return h('div', { class: 'xp xp-' + tone, role: 'meter', 'aria-label': T('home.ariaMeter'), 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(cap)), 'aria-valuenow': String(Math.round(Math.min(spent, cap))), 'aria-valuetext': T('home.meterText', { amount: F.usdMicros(spent), limit: F.usdMicros(cap) }) }, segs);
  }
  /**
   * Today's spend and the player's own limit: {spent, cap (0: none), capSet, unknown}. unknown: today's spend
   * couldn't be read, so the limit holds and the spend the bridge reports is the limit, not what was spent
   * (code health BR-09): said in words, with no meter (bones-ux-writer UX-W01).
   */
  function todayOf(today, prov) {
    var spent = Number(today.spentMicros) || 0;
    var local = !!(prov && prov.auth === 'local');
    var capSet = !local && today.capMicros != null && Number(today.capMicros) > 0;
    return { spent: spent, cap: capSet ? Number(today.capMicros) : 0, capSet: capSet, unknown: capSet && today.held === 'load_error' };
  }
  /**
   * The route card: what Bones does for your questing, in one line. In game with a route on the map,
   * the route itself leads (its next stop, live; CL-design-41). No example picture and no list of
   * what he does: the app trim keeps Home to his condition, one line and the next step.
   */
  function routeCard(actions, route) {
    var name = companion();
    var live = route && route.next ? h('div', { class: 'route-live', 'data-key': 'route-live' }, ico('route', 'proof-ico'),
      h('div', { class: 'route-live-text' },
        h('span', { class: 'route-live-key', text: T('home.nextStopLabel') }),
        data('span', { class: 'route-live-stop', text: F.clean(route.next, 80) }),
        h('span', { class: 'route-live-sub', text: T('home.stopsLine', { count: Number(route.stops) || 1 }) })))
      : null;
    // With a next stop, the route is a card whose stop leads (its name, Your route, is for a screen
    // reader); with none (WoW closed) there's no card and no heading, just its button under the page's
    // title (APP-D-28, APP-W-21).
    if (!live) return h('div', { class: 'route-bare', 'data-key': 'route' }, actions || null);
    return h('section', { class: 'route route-solo', 'aria-labelledby': 'route-title', 'data-key': 'route' },
      h('div', { class: 'route-text' },
        h('h2', { class: 'route-title sr-only', id: 'route-title', text: T('home.routeTitle') }),
        live,
        actions || null));
  }
  /** One compact row: the model and today's spend (and the player's limit, with its bar); it opens Your AI. */
  function aiStrip(today, prov) {
    var t = todayOf(today, prov);
    var model = prov ? (prov.auth === 'local' ? T('bar.usageLocal', { app: F.clean(prov.name, 40), model: modelName(prov.model) }) : modelName(prov.modelName || prov.model)) : T('home.noAiValue');
    var dot = function () { return h('span', { class: 'aistrip-dot', 'aria-hidden': 'true', text: '·' }); };
    return h('button', { type: 'button', class: 'aistrip', 'data-fk': 'ai-strip', 'data-key': 'ai-strip', onClick: function () { go('provider'); } },
      ico('spark', 'aistrip-ico'),
      data('span', { class: 'aistrip-model', text: model }),
      prov ? dot() : null,
      prov && t.unknown ? h('span', { class: 'aistrip-spent', text: T('home.todayUnknownLine') }) : null,
      prov && !t.unknown ? data('span', { class: 'aistrip-spent', text: t.capSet ? T('home.todayOfLimitLine', { amount: F.usdMicros(t.spent), limit: F.usdMicros(t.cap) }) : T('home.todayLine', { amount: F.usdMicros(t.spent) }) }) : null,
      prov && t.capSet && !t.unknown ? xpBar(t.spent, t.cap) : null,
      ico('chevron', 'aistrip-go'));
  }
  PAGES.home = function () {
    return Promise.all([B.usage({ days: 1 }), ensureProviders()]).then(function (res) {
      var u = isErr(res[0]) ? {} : res[0];
      var p = P();
      var prov = p.provider;
      var name = companion();
      var key = view();
      var paused = p.bridge.paused === true || p.rt.state === 'paused' || key === 'paused';
      var today = u.today || p.usage || {};
      var fm = finishModel();
      var sm = stateModel();
      var running = !!(p.wow && p.wow.running);
      var cap = p.capture || {};
      var connecting = running && !!cap.state && cap.state !== 'ok';
      var head;
      var lead = null;
      var acts = [];
      if (fm && !sm) { head = T('finishLater.title'); lead = fm.head; }
      else if (sm) head = T('home.needsTitle');
      else if (!prov) head = T('home.noAiTitle', { name: name });
      else if (paused) head = T('home.pausedTitle', { name: name });
      else if (connecting) head = T('home.connectingTitle', { name: name });
      else if (running) head = T('home.inGameTitle', { name: name });
      else head = T('home.wowClosedTitle');
      // The one primary: the card's fix, Finish setup, Pick an AI, Resume, or Open Battle.net while
      // WoW is closed. Pause is quiet, in the title row, only while WoW runs; Resume is the way out.
      var pause = sm || fm || key === 'not_running' || !prov || paused || !running ? null
        : small(T('home.pauseBtn'), function () { B.setPaused({ paused: true }).then(refreshStatus).then(function () { rerender(); }); }, { fk: 'pause', icon: 'pause' });
      if (sm) acts = [];
      else if (fm) acts = [primary(T('finishLater.finishSetupBtn'), resumeSetup, { fk: 'finish-setup' }),
        h('span', { class: 'mini-track', 'aria-hidden': 'true' }, ico('dia-done', 'nav-mark'), ico(aiReady() ? 'dia-done' : 'dia-now', 'nav-mark'), ico(aiReady() ? 'dia-now' : 'dia-next', 'nav-mark'))];
      else if (!prov && key !== 'not_running') acts = [primary(T('home.pickAiBtn'), openChange, { fk: 'pick-ai' })];
      else if (paused && key !== 'not_running') acts = [primary(T('home.resumeBtn'), function () { B.setPaused({ paused: false }).then(refreshStatus).then(function () { rerender(); }); }, { fk: 'resume', icon: 'play' })];
      else if (!running && prov && key !== 'not_running') acts = [busyBtn(T('home.openBattleNetBtn'), function () { return B.openGame(); }, 'btn btn-primary', { fk: 'open-battle-net' })];
      var actions = acts.length ? h('div', { class: 'actions', 'data-key': 'actions' }, acts) : null;
      return pageNode('page-home', { left: [], right: [] }, [
        h('div', { class: 'title-row', 'data-key': 'title-row' }, title(head), pause),
        lead ? para(lead, 'lead') : null,
        sm ? alertCard(sm, true) : null,
        sm ? null : routeCard(actions, running && !paused && !connecting && !fm ? p.wow.route : null),
        key === 'not_running' ? null : aiStrip(today, prov),
      ]);
    });
  };

  // -------------------------------------------------------------------------
  // Your AI (spec §6.3): a group of rows that save on change. Change opens step 2's picker here.

  /**
   * A row whose words stack (CL-design-25): the label, then its one short line and any result, on the
   * left; the control at the right edge. Two-word labels never wrap for want of a column.
   */
  function stackRow(id, key, lines, control, cls, below) {
    return h('div', { class: 'set set-stack' + (cls ? ' ' + cls : ''), id: id || null, 'data-key': 'set-' + (id || key) },
      h('div', { class: 'set-value' }, h('span', { class: 'set-key', text: key }), lines),
      h('div', { class: 'set-control' }, control || null),
      // What a click opened, the row's full width under it (never beside the control).
      below ? h('div', { class: 'set-below' }, below) : null);
  }
  /** A group of rows under a plain heading; extra: a control beside the heading (its Details). */
  function group(titleText, rows, id, extra) {
    return h('section', { class: 'group', id: id || null, 'aria-label': titleText || null, 'data-key': 'group-' + (id || titleText || '') },
      titleText && extra ? h('div', { class: 'group-head' }, h('h2', { class: 'group-title', text: titleText }), extra)
        : titleText ? h('h2', { class: 'group-title', text: titleText }) : null,
      h('div', { class: 'group-rows' }, rows.filter(Boolean)));
  }
  /** A small line under a row's value: "Saved." (ok), a failure with Save again, or a result. */
  function rowLine(kind, text, stamped, extra) {
    return h('p', { class: 'set-line set-line-' + kind, 'data-say': text, 'data-say-n': stamped && stamped.n ? String(stamped.n) : null }, ico(kind === 'ok' ? 'check' : kind === 'bad' ? 'bad' : 'warn', 'set-line-ico'), h('span', null, keepWhole(text)), extra || null);
  }
  /**
   * A segmented option group (spec §4.17): 2–4 options, a bold name and a small cost or hint; row: one
   * line of names. One name at every width: a long one wraps inside its segment in the smallest window.
   */
  function segmented(id, ariaLabel, options, current, onPick, row1) {
    return radioGroup(row1 ? 'seg seg-row' : 'seg', ariaLabel, options.map(function (o) {
      return { key: o.key, node: function (checked) {
        return h('button', { type: 'button', class: 'opt' + (checked ? ' is-checked' : ''), id: id + '-' + o.key, 'data-fk': id + '-' + o.key },
          h('span', { class: 'opt-name', text: o.name }),
          o.hint ? h('span', { class: 'opt-hint' }, keepWhole(o.hint)) : null);
      } };
    }), current, function (k) { onPick(k); });
  }
  /**
   * Your AI's Replace key: Paste key (the clipboard, read in main) or the key field; nothing typed stays
   * on the page. A paste into the field is Paste key too (code health AP-05): main reads the clipboard
   * and clears it once the key is saved; the page never reads the event's clipboard.
   */
  function replaceBox(pid) {
    var st = KS('page');
    if (st.provider !== pid) { st.provider = pid; st.slot = null; }
    var busyPaste = st.busy === 'paste';
    var paste = btn(busyPaste ? checkingText(pid) : T('yourAi.pasteKeyBtn'), function () { pasteKey('page'); }, 'btn btn-quiet btn-sm', { fk: 'paste-key', kbd: busyPaste ? null : pasteKbd() });
    if (busyPaste) busyNow(paste); else if (st.busy === 'agree') paste.setAttribute('aria-disabled', 'true');
    var field = h('input', { type: 'password', class: 'input key-input', id: 'key-field', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': T('yourAi.fieldLabel'), placeholder: F.clean(disp(pid).placeholder || '', 40) || null });
    var sendIt = function (el, text) {
      if (el) el.value = '';
      var t = String(text || '');
      if (!t.trim() || st.busy) return;
      awaitAgree(st, 'paste', function () { return checkingText(pid); });
      rerender();
      B.stageKey({ key: t }).then(function (r) {
        if (!r || r.ok === false) { doneWaiting(st); showResult({ ok: false, error: (r && (r.error === 'bad_input' ? 'not_a_key' : r.error)) || 'not_a_key', provider: pid, guess: r && r.guess }, 'page'); return null; }
        return B.connectKey({ provider: pid, stageId: r.stageId }).then(function (res) {
          doneWaiting(st);
          return ensureProviders().then(refreshStatus).then(function () { showResult(res, 'page'); });
        });
      });
      t = '';
    };
    on(field, 'paste', function (e) { e.preventDefault(); this.value = ''; pasteKey('page'); });
    on(field, 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sendIt(this, this.value); } });
    var out = null;
    if (st.slot) { var k = keyResult(st.slot, 'page'); out = resultLine(k.kind, k.line, st.slot); }
    return h('div', { class: 'replace', id: 'replace-box', 'data-key': 'replace' },
      h('div', { class: 'replace-row' }, paste, field),
      out);
  }
  /** Your AI's one Show details (CL-design-42): the AI's sheet, then how spending is counted. */
  function yourAiSheet(u, prov) {
    return function () {
      var cur = P().provider;
      var base = aiSheet(cur ? cur.id : null)();
      var spend = u ? usageSheet(u.today || P().usage || {}, prov)() : null;
      var tail = base.sections.slice(-1);
      var head = base.sections.slice(0, -1);
      return { title: base.title, sections: head.concat(spend ? spend.sections : [], tail) };
    };
  }
  /**
   * Delete key for a saved key (CL-player-56, CL-words-77): on the Key row for the AI in use, and in
   * Switch's actions for one that isn't. Main asks first ("Delete your Anthropic key?").
   */
  function deleteKeyBtn(pid, cls) {
    return busyBtn(isSignin(pid) ? T('yourAi.signOutBtn') : T('yourAi.deleteKeyBtn'), function () {
      return B.deleteKey({ provider: pid }).then(function () { return ensureProviders(); }).then(refreshStatus).then(function () { paintBanners(); rerender(); });
    }, cls, { fk: 'delete-key' });
  }
  /** A model's cost a day at the level it would run at: the one in use, or its nearest (CL-design-37). */
  function dayAt(m, want) {
    var lv = m && m.effort ? nearestLevel(levelsOf(m), want || 'low') : null;
    var d = lv && m.levelDays && Array.isArray(m.levelDays[lv]) && !(m.priceHint && m.priceHint.free) ? F.dayRange(m.levelDays[lv]) : null;
    return d || dayOf(m);
  }
  /** The cheapest model: the lowest cost rank, then the lowest day. */
  function cheapestOf(models) {
    var best = null;
    models.forEach(function (m) {
      var r = typeof m.costRank === 'number' ? m.costRank : Infinity;
      var hi = m.priceHint && Array.isArray(m.priceHint.dayUsd) ? Number(m.priceHint.dayUsd[1]) : Infinity;
      if (r === Infinity) return;
      if (!best || r < best.r || (r === best.r && hi < best.hi)) best = { id: m.id, r: r, hi: hi };
    });
    return best ? best.id : null;
  }
  /**
   * Your AI's models (CL-words-34, CL-words-35): the recommended one, the one in use and the cheapest,
   * each with at most one chip and its cost a day at the level in use; Show all models opens the rest in
   * place, on a click.
   */
  function modelList(cur, models, local, onPick, all, onAll) {
    var Y = function (k, v) { return T('yourAi.' + k, v); };
    // A model its AI company retired (CL-words-61): the one in use reads Retired, with no price; once
    // another is picked, its row goes.
    var retiredNow = view() === 'model_retired' ? cur.model : null;
    if (retiredNow) { S.retired = S.retired || {}; S.retired[retiredNow] = true; }
    models = models.filter(function (m) { return m.id === cur.model || !(S.retired && S.retired[m.id]); });
    var cheap = models.length > 2 ? cheapestOf(models) : null;
    var kind = function (m) { return m.id === retiredNow ? 'retired' : m.tier === 'default' ? 'recommended' : m.older ? 'older' : m.id === cheap ? 'cheapest' : m.tier === 'smarter' ? 'smartest' : null; };
    // The order (CL-design-46): the tagged rows, then the rest by cost a day, cheapest first, then Older.
    var hiOf = function (m) {
      var lv = m.effort ? nearestLevel(levelsOf(m), cur.effort || 'low') : null;
      var d = lv && m.levelDays && Array.isArray(m.levelDays[lv]) ? m.levelDays[lv] : m.priceHint && m.priceHint.dayUsd;
      var hi = Array.isArray(d) ? Number(d[1]) : NaN;
      return isFinite(hi) ? hi : Infinity;
    };
    var rank = function (m) { var k = kind(m); return k === 'older' ? 2 : k ? 0 : 1; };
    models = models.map(function (m, i) { return { m: m, i: i }; }).sort(function (a, b) {
      return rank(a.m) - rank(b.m) || (rank(a.m) === 1 ? hiOf(a.m) - hiOf(b.m) : 0) || a.i - b.i;
    }).map(function (x) { return x.m; });
    var few = models.filter(function (m) { return m.tier === 'default' || m.id === cur.model || m.id === cheap; });
    var shown = all || few.length >= models.length ? models : few;
    var tag = function (m) {
      var k = kind(m);
      return k === 'retired' ? chip(Y('retiredChip'), 'bad') : k === 'recommended' ? chip(Y('recommendedChip'), 'accent')
        : k === 'older' ? chip(Y('olderChip')) : k === 'cheapest' ? chip(Y('cheapestChip')) : k === 'smartest' ? chip(Y('smartestChip')) : null;
    };
    var list = radioGroup('choices models', Y('modelLabel'), shown.map(function (m) {
      var day = m.id === retiredNow ? null : dayAt(m, cur.effort);
      var cost = local ? T('cost.local') : day ? Y('dayCostLine', { dayCost: day.text }) : '';
      return {
        key: m.id,
        node: function (checked) {
          return h('button', { type: 'button', class: 'choice choice-model' + (checked ? ' is-checked' : ''), id: 'model-' + m.id, 'data-fk': 'model-' + m.id },
            h('span', { class: 'choice-name' }, data('span', { class: 'choice-title', text: F.clean(m.name || m.id, 40) }), tag(m)),
            data('span', { class: 'choice-cost' }, keepWhole(cost)),
            ico('check', 'choice-tick'));
        },
      };
    }), cur.model, function (mid) { onPick(mid); });
    var more = shown.length < models.length || all && few.length < models.length
      ? h('div', { class: 'models-more', 'data-key': 'models-more' }, ghost(all ? Y('hideModelsBtn') : Y('allModelsBtn'), onAll, { fk: 'all-models', icon: 'chevron', 'aria-expanded': all ? 'true' : 'false', 'aria-controls': 'model-row' }))
      : null;
    return [list, more];
  }
  /** Your AI's spending group: today's spend and the daily spend limit (the player's own). */
  function spendGroup(u, caps, prov) {
    var U = function (k, v) { return T('usage.' + k, v); };
    var today = u.today || P().usage || {};
    var t = todayOf(today, prov);
    var local = !!(prov && prov.auth === 'local');
    var cap = caps && (caps.dailyUsd === null || typeof caps.dailyUsd === 'number') ? caps.dailyUsd
      : today.capMicros != null ? Number(today.capMicros) / 1e6 : null;
    var todayText = t.capSet ? U('todayOfLimitValue', { amount: F.usdMicros(t.spent), limit: F.usdMicros(t.cap) }) : U('todayValue', { amount: F.usdMicros(t.spent) });
    // Each record stacks its muted label over its value, as Connection's do (CL-design-47). Today's spend
    // that couldn't be read is a word, with no meter (BR-09, UX-W01).
    var todayRow = stackRow('today-row', U('todayLabel'), [t.unknown ? h('span', { class: 'set-main', text: U('todayUnknownValue') }) : data('span', { class: 'set-main', text: todayText }), t.capSet && !t.unknown ? xpBar(t.spent, t.cap) : null], null, 'set-rec');
    // A plan (a sign-in) costs nothing per reply either: a dollar limit could never stop a reply.
    var plan = !!(prov && isSignin(prov.id));
    var limit = local || plan ? stackRow('limit-row', U('limitLabel'), h('span', { class: 'set-main', text: U(plan ? 'planLine' : 'localLine') }), null, 'set-rec') : limitRow(cap);
    return group(null, [todayRow, limit], 'spend-group');
  }
  PAGES.provider = function () {
    return Promise.all([ensureProviders(), B.usage({ days: 1 }), B.caps()]).then(function (res) {
      var u = isErr(res[1]) ? {} : res[1];
      var caps = isErr(res[2]) ? null : res[2];
      var p = P();
      var cur = p.provider;
      var ya = S.ya || (S.ya = { view: 'main' });
      var Y = function (k, v) { return T('yourAi.' + k, v); };
      var back = { left: [backBtn(Y('backBtn'), function () { S.ya = null; rerender(true); }, { fk: 'back' })], right: [] };
      // The picker: step 2's rows and actions, here.
      if (ya.view === 'pick') {
        var pst = KS('pick');
        return pageNode('page-pick', back, [pickHead(Y('title'), pst), aiRows(pst, 'pick'), aiActions(pst, 'pick'), slotLine(pst, 'pick')]);
      }
      if (ya.view === 'custom') {
        if (!ya.customState) ya.customState = { custom: ya.custom || null, customResult: null, busy: null };
        return pageNode('page-other', back, [h('div', { class: 'title-row', 'data-key': 'title-row' }, title(T('custom.title')), detailsBtn(customSheet)), para(T('custom.lead'), 'lead'), customForm(ya.customState, 'pick')]);
      }
      if (!cur) {
        return pageNode('page-yourai', { left: [], right: [] }, [
          title(Y('title')), para(Y('emptyLine'), 'lead'),
          setupInProgress() ? null : h('div', { class: 'actions', 'data-key': 'actions' }, primary(Y('connectBtn'), openChange, { fk: 'connect-ai' })),
        ]);
      }
      var local = isLocal(cur.id);
      var custom = isCustom(cur.id);
      var k = (providerById(cur.id) || {}).key || {};
      // A key a test just rejected, or the card says so, reads Rejected, never a green Saved (CL-player-42).
      var rejected = cur.keyState === 'invalid' || cur.keyState === 'expired' || view() === 'key_invalid' || view() === 'signed_out' || !!(ya.nowTest && !ya.nowTest.ok && ya.nowTest.error === 'auth_invalid');
      var keyless = local || (custom && !k.saved);
      var retest = function () { return B.testKey({ provider: cur.id }).then(function (r) { ya.nowTest = stamp(r || { ok: false }); rerender(); }); };
      // The AI: its name and company on one line; a server on this computer says so there, with
      // Check again beside Switch (CL-words-45: no Key row without a key).
      var lt = keyless ? ya.nowTest : null;
      var aiLine = lt ? (lt.ok ? rowLine('ok', Y('localOkLine', { app: F.clean(cur.name, 40) }), lt) : rowLine('bad', stillId(cardCause(), lt) ? T(stillId(cardCause(), lt), stillVars()) : errLines(lt).filter(Boolean).join(' '), lt)) : null;
      var aiSub = custom ? [customName(), keyless ? Y('localValue') : null].filter(Boolean).join(' · ') : keyless ? Y('localValue') : coName(cur.id);
      var aiRow = stackRow('ai-row', Y('aiLabel'),
        [h('span', { class: 'set-main' }, h('span', { text: custom ? F.clean(disp('custom').card || 'Other', 24) : aiName(cur.id) }), h('span', { class: 'set-sub', 'data-count': custom || !keyless ? 'data' : null, text: aiSub })), aiLine],
        h('div', { class: 'row' }, keyless ? busyBtn(Y('checkAgainBtn'), retest, 'btn btn-quiet btn-sm', { fk: 'now-test' }) : null, small(Y('changeBtn'), openChange, { fk: 'change-ai' })), 'set-rec');
      // The key: masked on one line with its chip; Test key and Replace key, one pair in one style.
      // A retired model's Test result is the model's, not the key's: it sits under Model (CL-player-52).
      var retiredNow = view() === 'model_retired';
      var rt0 = ya.nowTest;
      var retiredLine = retiredNow && rt0 && !rt0.ok && stillId('model_retired', rt0) ? rowLine('bad', T(stillId('model_retired', rt0), stillVars()), rt0) : null;
      var keyRow = null;
      if (!keyless) {
        // Out of credit reads No credit (CL-player-55); a key that works has no chip: the mask says it's saved.
        var chipNode = rejected ? chip(Y('rejectedChip'), 'bad') : cur.keyState === 'no_credit' || view() === 'out_of_credit' ? chip(Y('noCreditChip'), 'warn') : cur.keyState === 'missing' ? chip(Y('missingChip'), 'bad') : null;
        var nt = ya.nowTest;
        var ntLine = null;
        if (nt && !retiredLine) {
          var still = stillId(cardCause(), nt);
          var keyStore = nt.error === 'no_key' && nt.action === 'keys';
          ntLine = nt.ok ? rowLine('ok', Y('testOkLine', { amount: F.usdMicros(nt.testCall && nt.testCall.micros) }), nt)
            : still ? rowLine('bad', T(still, stillVars()), nt)
              : keyStore ? rowLine('bad', Y('keyUnreadableLine'), nt)
                : rowLine('bad', errLines(nt).filter(Boolean).join(' '), nt, nt.action === 'restart' ? quitReopenBtn('btn btn-quiet btn-sm') : null); // fix-102: a restart's own button
        }
        var test = busyBtn(Y('testKeyBtn'), retest, 'btn btn-quiet btn-sm', { fk: 'now-test' });
        var openReplace = function () { ya.replace = !ya.replace; rerender(false, function () { reveal('key-row', 'key-field'); }); };
        var signedIn = isSignin(cur.id);
        var repl = signedIn ? (rejected ? primary : small)(Y('signInAgainBtn'), function () { signIn(cur.id, 'page'); }, { fk: 'key-' + cur.id })
          : custom ? small(Y('replaceKeyBtn'), function () { S.ya = { view: 'custom' }; rerender(true, function () { reveal('custom-form', 'custom-key'); }); }, { fk: 'key-' + cur.id })
          : (rejected ? primary : small)(Y('replaceKeyBtn'), openReplace, { fk: 'key-' + cur.id, 'aria-expanded': ya.replace ? 'true' : 'false', 'aria-controls': 'replace-box' });
        if (signedIn) test = busyBtn(Y('testSignInBtn'), retest, 'btn btn-quiet btn-sm', { fk: 'now-test' });
        keyRow = stackRow('key-row', signedIn ? Y('signInLabel') : Y('keyLabel'),
          [h('span', { class: 'set-main key-main' }, signedIn ? h('span', { text: Y('signedInLine', { ai: aiName(cur.id) }) }) : data('span', { class: 'mono key-mask', text: F.clean(k.masked || '', 40) }), chipNode), ntLine],
          h('div', { class: 'row' }, test, repl, k.saved ? deleteKeyBtn(cur.id, 'btn btn-quiet btn-sm btn-danger') : null), 'set-rec', ya.replace && !custom && !signedIn ? replaceBox(cur.id) : null);
      }
      // The model: the recommended one, the one in use and the cheapest; the rest one click away.
      var modelRow = null;
      var models = offeredModels(cur.id);
      if (custom) modelRow = h('div', { class: 'set set-bare-row', id: 'model-row', 'data-key': 'set-model' }, data('span', { class: 'set-main mono', text: F.clean(cur.model, 60) }));
      else if (models.length) {
        var chosen = ya.chosen;
        var pick = function (mid) {
          chooseModel(cur, mid).then(function (r) {
            ya.chosen = stamp(r || { ok: false });
            return refreshStatus().then(function () { paintBanners(); rerender(false, function () { focusEl(document.getElementById('model-' + mid)); }); });
          });
        };
        var toggleAll = function () { ya.allModels = !ya.allModels; rerender(false, function () { focusEl(findByKey({ fk: 'all-models', n: 0 })); }); };
        modelRow = h('div', { class: 'set-models', id: 'model-row', 'data-key': 'set-model' },
          modelList(cur, models, local, pick, !!ya.allModels, toggleAll),
          chosen ? h('div', { class: 'models-line' }, chosen.ok ? rowLine('ok', T('settings.savedLine'), chosen) : rowLine('bad', errText(chosen), chosen))
            : retiredLine ? h('div', { class: 'models-line' }, retiredLine) : null);
      }
      // Thinking: the model's own levels (Off only where it has it), one track, cheapest first, under its
      // muted label, and the level's cost a day under it. A model without levels shows no row, and a
      // retired one none: it can't answer at any level (CL-design-50, CL-design-52).
      var effortGroup = null;
      var cm = modelById(cur.id, cur.model);
      var lv = cm && cm.effort && cur.effortSupported !== false && !custom && !retiredNow ? levelsOf(cm) : [];
      var curLv = lv.length ? nearestLevel(lv, cur.effort || 'low') : null;
      if (curLv) {
        var lvDay = local ? null : dayAt(cm, curLv);
        effortGroup = h('div', { class: 'set-block', id: 'effort-row', 'data-key': 'set-effort' },
          h('span', { class: 'set-key', text: Y('thinkingLabel') }),
          segmented('effort', Y('thinkingLabel'), lv.map(function (l) { return { key: l, name: levelLabel(l) }; }), curLv, function (e) {
            B.choose({ provider: cur.id, model: cur.model, effort: e }).then(refreshStatus).then(function () { rerender(false, function () { focusEl(document.getElementById('effort-' + e)); }); });
          }, true),
          // The level's cost is data, as each row's cost is.
          lvDay ? h('p', { class: 'set-sub seg-note' }, data('span', null, keepWhole(Y('thinkingDayLine', { level: levelLabel(curLv), dayCost: lvDay.text })))) : null);
      }
      var session = S.status && S.status.keys && S.status.keys.persistent === false ? notice('warn', Y('sessionOnlyLine'), null) : null;
      // The model and its thinking, trimmed: one row says which model, at what level and what it
      // costs a day; Pick a model opens the lists inside the same card (CL-design-55). A retired model
      // says Retired in red, as a rejected key does, and opens them: that is the fix (CL-design-52).
      var modelOpen = !!ya.modelOpen || retiredNow;
      var modelBlock = [];
      if (custom) modelBlock = [group(Y('modelLabel'), [modelRow], 'model-group')];
      else if (modelRow || effortGroup) {
        var mname = modelName(cur.modelName || cur.model);
        var sumDay = local || retiredNow || !cm ? null : dayAt(cm, curLv || cur.effort);
        var level = curLv ? levelLabel(curLv) : null;
        // One whole string (CL-words-78, CL-player-58), its day's cost never split across lines (CL-design-54).
        var sumText = level && sumDay ? Y('modelSumLine', { model: mname, level: level, dayCost: sumDay.text })
          : sumDay ? Y('modelSumCostLine', { model: mname, dayCost: sumDay.text })
            : level ? Y('modelSumLevelLine', { model: mname, level: level }) : mname;
        var sumValue = retiredNow
          ? h('span', { class: 'set-main key-main' }, data('span', { text: mname }), chip(Y('retiredChip'), 'bad'))
          : data('span', { class: 'set-main' }, h('span', null, nowrapPart(sumText, sumDay ? Y('dayCostLine', { dayCost: sumDay.text }) : null)));
        var toggleModel = function () { ya.modelOpen = !modelOpen; rerender(false, focusAfter('model-change')); };
        var sumRow = stackRow('model-sum', Y('modelLabel'), sumValue,
          retiredNow ? null : small(modelOpen ? Y('hideModelBtn') : Y('pickModelBtn'), toggleModel, { fk: 'model-change', 'aria-expanded': modelOpen ? 'true' : 'false', 'aria-controls': 'model-box' }), 'set-rec');
        modelBlock = [group(null, [sumRow,
          modelOpen ? h('div', { class: 'more', id: 'model-box', 'data-key': 'model-box', 'data-behind': 'click' }, modelRow, effortGroup) : null], 'model-sum-group')];
      }
      return pageNode('page-yourai', { left: [], right: [] }, [
        h('div', { class: 'title-row', 'data-key': 'title-row' }, title(Y('title')), detailsIcon(yourAiSheet(u, cur))),
        session,
        group(null, [aiRow, keyRow], 'ai-group'),
        modelBlock,
        spendGroup(u, caps, cur),
      ]);
    });
  };
  // -------------------------------------------------------------------------
  // The daily spend limit and the spending sheet (spec §6.4), in Your AI's spending group.

  /**
   * The daily spend limit: the player's own, off by default and never pre-filled. None set: "None"
   * and Set a limit, which opens an empty amount, Save limit (the one primary) and Cancel. One set:
   * its amount and Turn off limit; Save limit shows once the amount changes. One line says what the
   * limit does. main asks before a limit is raised, turned off, or set when the saved one couldn't be
   * read; never when it's lowered. Enter saves.
   */
  function limitRow(cap) {
    var U = function (k, v) { return T('usage.' + k, v); };
    var d = S.capsDraft;
    var cr = S.capsResult;
    S.capsResult = null;
    var out = !cr ? null : cr.ok === false ? rowLine(cr.error === 'cancelled' ? 'warn' : 'bad', cr.error === 'bad_amount' ? U('badAmountLine') : errText(cr), cr)
      : rowLine('ok', cr.off ? U('offLine') : U('savedLine'), cr);
    var after = function (r, extra) {
      S.capsResult = stamp(isErr(r) ? (r || { ok: false }) : Object.assign({ ok: true }, extra));
      if (!isErr(r) || (r && r.error === 'cancelled')) S.capsDraft = null;
    };
    // No limit: the row is its label and Set a limit, which says there's none (no "None": the app trim's word budget).
    if (!d && cap == null) {
      return stackRow('limit-row', U('limitLabel'), [out], small(U('setLimitBtn'), function () {
        S.capsDraft = { value: '' };
        S.capsResult = null;
        rerender(false, function () { reveal('limit-row', 'cap-dailyUsd'); });
      }, { fk: 'set-limit' }), 'set-rec');
    }
    if (!d) d = S.capsDraft = { value: cap.toFixed(2) };
    // A limit held because today's spend couldn't be read (code health BR-09) is set again as it is: Save
    // limit shows for the same amount too, which counts today's spend from then.
    var held = (P().usage || {}).held === 'load_error';
    var changed = function (v) { return held || cap == null || String(v == null ? '' : v).trim() !== cap.toFixed(2); };
    var save = busyBtn(U('saveLimitBtn'), function () {
      var t = String(d.value == null ? '' : d.value).trim();
      var n = Number(t);
      if (!t || !isFinite(n) || n < 0.01 || n > 100) {
        S.capsResult = stamp({ ok: false, error: 'bad_amount' });
        rerender(false, function () { reveal('limit-row', 'cap-dailyUsd'); });
        return null;
      }
      return B.setCaps({ dailyUsd: Math.round(n * 100) / 100 }).then(function (r) { after(r); return refreshStatus(); }).then(function () { paintBanners(); rerender(); });
    }, cap == null ? 'btn btn-primary btn-sm' : 'btn btn-quiet btn-sm', { fk: 'save-limit', hidden: !changed(d.value) });
    var input = h('input', {
      type: 'number', id: 'cap-dailyUsd', class: 'money-in', min: 0.01, max: 100, step: 0.25, inputmode: 'decimal', value: d.value, placeholder: U('amountPlaceholder'), 'aria-label': U('amountAria'),
      'aria-invalid': cr && cr.error === 'bad_amount' ? 'true' : null,
      onInput: function (e) { d.value = e.target.value; var sv = findByKey({ fk: 'save-limit', n: 0 }); if (sv) sv.hidden = !changed(d.value); },
      onKeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); save.click(); } },
    });
    var other = cap == null
      ? ghost(U('cancelBtn'), function () { S.capsDraft = null; S.capsResult = null; rerender(false, function () { reveal('limit-row'); }); }, { fk: 'cancel-limit' })
      : busyBtn(U('turnOffBtn'), function () {
        return B.setCaps({ dailyUsd: null }).then(function (r) { after(r, { off: true }); return refreshStatus(); }).then(function () { paintBanners(); rerender(false, function () { reveal('limit-row'); }); });
      }, 'btn btn-quiet btn-sm btn-danger', { fk: 'limit-off' });
    return stackRow('limit-row', U('limitLabel'), [
      h('div', { class: 'money-row' }, h('span', { class: 'money' + (cr && cr.error === 'bad_amount' ? ' money-bad' : '') }, h('span', { class: 'money-sign', 'aria-hidden': 'true', text: '$' }), input), save, other),
      out || (cap == null ? para(U('limitLine', { name: companion() }), 'set-sub') : null)], null, 'set-rec');
  }
  function usageSheet(today, prov) {
    return function () {
      var local = prov && prov.auth === 'local';
      var pn = prov && !local && !isCustom(prov.id) ? F.clean(prov.name, 24) : null;
      return {
        title: T('details.titleUsage'),
        sections: [
          { label: T('details.countedLabel'), body: T(today.exact && pn ? 'details.countedExactBody' : 'details.countedBody', { co: pn || '' }) },
          local || (prov && isSignin(prov.id)) ? null : { label: T('details.limitLabel'), body: [T('details.limitBody', { name: companion() }), pn ? T('details.atCoBody', { co: pn }) : null, pn ? sheetLinkRow(T('common.openLimitsBtn', { co: pn }), openLink(prov.id + '.limits'), 'open-limits') : null].filter(Boolean) },
        ],
      };
    };
  }
  /** Back to Your data, from its two records (CL-design-27). */
  function dataTop() { return { left: [backBtn(T('settings.backBtn'), function () { go('privacy'); }, { fk: 'back' })], right: [] }; }
  // Whose key a key test tried, by the address's company (player-20): "Google key test".
  var HOST_CO = [[/(^|\.)anthropic\.com$/i, 'anthropic'], [/(^|\.)openai\.com$/i, 'openai'], [/(^|\.)x\.ai$/i, 'xai'], [/(^|\.)googleapis\.com$/i, 'google']];
  function hostId(host) {
    var hit = HOST_CO.filter(function (x) { return x[0].test(String(host || '')); })[0];
    return hit && providerById(hit[1]) ? hit[1] : null;
  }
  /** What an address is for, in the player's words: "Messages to Claude", "Google key test" (CL-words-58). */
  function hostFor(r) {
    var f = FEATURES[r.feature];
    var id = f === 'keyTest' || f === 'provider' ? hostId(r.host) : null;
    if (id && f === 'keyTest') return T('connections.feature.keyTestCo', { co: coName(id) });
    if (id) return T('connections.feature.providerAi', { ai: aiName(id) });
    return featureText(r.feature);
  }

  // -------------------------------------------------------------------------
  // Connections (spec §6.5).

  var FEATURES = {
    provider: 'provider', 'provider call': 'provider', key_test: 'keyTest', 'key test': 'keyTest', local_model: 'local', 'local model': 'local',
    sign_in: 'signIn', 'sign-in': 'signIn', update: 'update', 'update check': 'update',
  };
  function featureText(f) {
    if (Object.prototype.hasOwnProperty.call(FEATURES, f)) return T('connections.feature.' + FEATURES[f]);
    if (!f) return T('connections.feature.app');
    var t = F.clean(String(f).replace(/_/g, ' '), 40);
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  PAGES.connections = function () {
    return B.connections().then(function (c) {
      c = isErr(c) ? {} : c;
      var b = c.bridge || {};
      var appRows = Array.isArray(b) ? b : Array.isArray(b.rows) ? b.rows : [];
      var shell = c.shell || { allowed: [], blocked: [] };
      var rows = appRows.map(function (r) { return { host: r.host, port: r.port, feature: r.feature, count: r.count, last: r.last }; })
        .concat((shell.allowed || []).map(function (r) { return { host: r.host, port: r.port, feature: r.feature || 'update check', count: r.count, last: r.last }; }));
      var refused = (Array.isArray(b.blocked) ? b.blocked : []).concat(shell.blocked || []);
      var C = function (k, v) { return T('connections.' + k, v); };
      var hostRow = function (host, sub, count, last, bad) {
        return h('li', { class: 'host' + (bad ? ' host-bad' : ''), 'data-count': 'data' },
          h('span', { class: 'host-main' }, h('span', { class: 'mono host-name', text: F.clean(host, 80) }), sub ? h('span', { class: 'host-sub', text: sub }) : null),
          bad ? chip(C('refusedChip'), 'bad') : null,
          h('span', { class: 'host-count', text: C('countLine', { count: Number(count) || 0 }) }),
          h('span', { class: 'host-last', text: last ? F.whenText(last) : '' }));
      };
      var list = rows.map(function (r) { return hostRow(r.host + (r.port && r.port !== 443 ? ':' + r.port : ''), hostFor(r), r.count, r.last, false); })
        .concat(refused.map(function (r) { return hostRow((r.scheme ? r.scheme + '://' : '') + (r.host || ''), null, r.count, r.last, true); }));
      return pageNode('page-connections', dataTop(), [
        title(C('title')),
        para(C('lead'), 'lead'),
        list.length ? h('ul', { class: 'hosts group', 'aria-label': C('listAria'), 'data-key': 'hosts' }, list) : para(C('emptyLine'), 'empty'),
      ]);
    });
  };

  // -------------------------------------------------------------------------
  // Last request (spec §6.6).

  /**
   * What the last request carried, read back for the summary: the player's words, and the game data
   * block's parts (bridge/byok/runtime/context.mjs: <game_data id="…">, one line of JSON, then the text).
   * Never guesses: what isn't there is left out.
   */
  function readRequest(body) {
    var msgs = body && Array.isArray(body.messages) ? body.messages : body && Array.isArray(body.input) ? body.input : [];
    var last = null;
    for (var i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === 'user') { last = msgs[i]; break; }
    var text = '';
    if (last) {
      if (typeof last.content === 'string') text = last.content;
      else if (Array.isArray(last.content)) text = last.content.map(function (c) { return c && typeof c.text === 'string' ? c.text : c && typeof c.content === 'string' ? c.content : ''; }).join('\n');
    }
    var game = null;
    var m = /^<game_data id="([0-9a-f]+)">\n(.*)\n<\/game_data id="\1">(?:\n|$)/.exec(text);
    if (m) {
      try { game = JSON.parse(m[2]); } catch (e) { game = null; }
      text = text.slice(m[0].length);
    }
    return { asked: text.replace(/^\s+|\s+$/g, ''), game: game && typeof game === 'object' ? game : null };
  }
  /** The game data's parts as chips: level, class and race; the zone; how many quests; gear; memory. */
  function gameChips(game) {
    if (!game) return [];
    var g = game.game && typeof game.game === 'object' ? game.game : game;
    var st = g.state && typeof g.state === 'object' ? g.state : g;
    var ch = st.char && typeof st.char === 'object' ? st.char : {};
    var out = [];
    var cap = function (w) { w = F.clean(String(w || ''), 24).toLowerCase(); return w ? w.charAt(0).toUpperCase() + w.slice(1) : ''; };
    if (ch.level != null) out.push([T('lastRequest.levelChip', { level: F.clean(String(ch.level), 4) }), cap(ch.race), cap(ch.class)].filter(Boolean).join(' '));
    if (st.loc && st.loc.zone) out.push(F.clean(st.loc.zone, 40));
    if (Array.isArray(st.quests)) out.push(T('lastRequest.questsChip', { count: st.quests.length }));
    if (st.gear || st.equipment || st.items) out.push(T('lastRequest.gearChip'));
    if (game.memory && typeof game.memory === 'object' && Object.keys(game.memory).length) out.push(T('lastRequest.memoryChip'));
    return out;
  }
  PAGES['last-request'] = function () {
    return Promise.all([B.lastRequest(S.lastChat ? { chatId: S.lastChat } : undefined), ensureProviders()]).then(function (res) {
      var r = res[0];
      var none = isErr(r) || !r || !r.request;
      var chats = r && Array.isArray(r.chats) ? r.chats : [];
      var L = function (k, v) { return T('lastRequest.' + k, v); };
      var raw = !!S.open.rawRequest;
      var summary = null;
      if (!none) {
        var req = readRequest(r.request.body);
        var chips = gameChips(req.game);
        var co = providerById(r.provider) ? coName(r.provider) : F.clean(r.provider, 30);
        // Each label over its value (CL-design-25), as Settings' rows are.
        summary = h('section', { class: 'group', 'data-key': 'summary', 'aria-label': L('title') }, h('div', { class: 'group-rows' },
          stackRow('lr-asked', L('askedLabel'), req.asked ? data('span', { class: 'set-text', text: F.clean(req.asked, 600) }) : h('span', { class: 'set-text', text: L('checkInValue') }), null, 'set-rec'),
          stackRow('lr-game', L('gameLabel'), chips.length ? data('span', { class: 'chips' }, chips.map(function (c) { return chip(c); })) : h('span', { class: 'set-text', text: L('noGameValue') }), null, 'set-rec'),
          stackRow('lr-to', L('sentToLabel'), data('span', { class: 'set-text', text: L('sentToValue', { co: co, model: modelName(r.model), time: F.whenText(r.at) }) }), null, 'set-rec')));
      }
      // The chat picker names what the player did (CL-design-43): Your question, Route update.
      var chatName = function (c) {
        var t = F.clean(c.title || c.id, 60);
        return t === companion() ? L('chatAsk') : /route/i.test(t) ? L('chatRoute') : t;
      };
      var pickChat = function (id) { S.lastChat = id; rerender(false, function () { focusEl(document.getElementById('chat-' + id)); }); };
      return pageNode('page-last', dataTop(), [
        title(L('title')),
        chats.length > 3 ? h('div', { class: 'field field-inline', 'data-key': 'chat' }, h('label', { for: 'chat', text: L('chatLabel') }),
          h('select', { id: 'chat', class: 'select', onChange: function (e) { S.lastChat = e.target.value; rerender(); } }, chats.map(function (c) {
            return h('option', { value: F.clean(c.id, 64), text: chatName(c), selected: c.id === r.chatId });
          })))
          // Two segments say what they are: no visible label, its name stays the group's (CL-design-45).
          : chats.length > 1 ? h('div', { class: 'field field-inline', 'data-key': 'chat' },
            segmented('chat', L('chatLabel'), chats.map(function (c) { return { key: F.clean(c.id, 64), name: chatName(c) }; }), r.chatId, pickChat, true)) : null,
        none ? para(L('emptyLine'), 'empty') : summary,
        none ? null : h('div', { class: 'actions actions-quiet', 'data-key': 'raw-toggle' }, ghost(raw ? L('hideRawBtn') : L('showRawBtn'), function () { S.open.rawRequest = !raw; rerender(false, focusAfter('raw-request')); }, { fk: 'raw-request', icon: 'chevron', 'aria-expanded': raw ? 'true' : 'false', 'aria-controls': 'raw-box' })),
        !none && raw ? h('div', { class: 'json', id: 'raw-box', 'data-key': 'json', 'data-behind': 'click' },
          data('p', { class: 'json-meta', text: [F.dateTimeText(r.at), providerById(r.provider) ? pname(r.provider) : F.clean(r.provider, 30), modelName(r.model)].join(' · ') }),
          code(F.clean(JSON.stringify(r.request, null, 2), 200000), true, L('jsonAria'))) : null,
      ]);
    });
  };

  // -------------------------------------------------------------------------
  // Settings (spec §6.7): one page of groups; every control saves on change. Sub-pages open with ‹ Settings.

  /** A switch (spec §4.18): role="switch", aria-checked; the knob moves only on a click. */
  function switchBtn(id, labelText, isOn, onFlip, disabled) {
    return h('button', {
      type: 'button', role: 'switch', class: 'switch', id: id, 'aria-checked': isOn ? 'true' : 'false', 'aria-label': labelText, 'data-fk': id,
      'aria-disabled': disabled ? 'true' : null,
      onClick: function () { if (!disabled) onFlip(!isOn); },
    }, h('span', { class: 'switch-knob', 'aria-hidden': 'true' }));
  }
  var RETENTION = [1, 7, 14, 30, 90, 180, 365];
  function settingsLine(key, okText) {
    var r = S.settingsResult[key];
    if (!r) return null;
    if (r.ok) return rowLine('ok', okText || T('settings.savedLine'), r);
    if (r.error === 'cancelled') return rowLine('warn', T('errors.cancelled'), r);
    return rowLine('bad', r.error ? errText(r, T('settings.notSavedLine')) : T('settings.notSavedLine'), r, r.again ? small(T('settings.saveAgainBtn'), r.again, { fk: 'save-again-' + key }) : null);
  }
  function subTop() { return { left: [backBtn(T('settings.backBtn'), function () { go('settings'); }, { fk: 'back' })], right: [] }; }
  /** The privacy values the switches flip (Your data's and Settings' Check-ins), saved together. */
  function privacyFlip(values, k, onNow, focusId) {
    if (values.unread) {
      // The saved values weren't read: read them again first, and say this one wasn't saved (SY-10).
      S.privacyValues = null;
      S.settingsResult['pv-' + k] = stamp({ ok: false, error: 'failed', again: function () { rerender(false); } });
      rerender(false, function () { focusEl(document.getElementById(focusId || 'sw-' + k)); });
      return;
    }
    var before = values[k];
    values[k] = onNow;
    B.setPrivacy(values).then(function (r) {
      if (isErr(r)) values[k] = before;
      S.settingsResult['pv-' + k] = stamp(isErr(r) ? Object.assign({ again: function () { privacyFlip(values, k, onNow, focusId); } }, r || { ok: false }) : { ok: true });
      S.privacyValues = values;
      rerender(false, function () { focusEl(document.getElementById(focusId || 'sw-' + k)); });
    });
  }
  /**
   * Settings, trimmed: the three switches a player changes, and Show more. It holds the few things
   * that protect the player or get Bones running again (chat history and Delete all, Forget all, the
   * chat-frame echo, run setup again) and the pages behind it (Diagnostics, About, Uninstall). Every
   * control saves on change. No text size or screen-reading row: ⌘+ and ⌘− still zoom, and screen
   * reading's switch is on Your data (On your screen), beside what's sent.
   */
  PAGES.settings = function () {
    return Promise.all([B.appState(), B.transcripts({ deleteAll: false }), B.memory(), ensureProviders(), B.privacy(), B.updates()]).then(function (res) {
      var stt = res[0];
      if (!isErr(res[5]) && res[5]) S.updates = res[5];
      var upd = S.updates || {};
      if (!isErr(stt) && stt) S.appState = stt;
      var tr = isErr(res[1]) ? null : res[1];
      var chars = !isErr(res[2]) && res[2] && Array.isArray(res[2].chars) ? res[2].chars : [];
      var values = S.privacyValues || privacyValues(isErr(res[4]) ? null : res[4]);
      var info = S.info || {};
      var li = info.loginItem || { supported: false };
      var ST = function (k, v) { return T('settings.' + k, v); };
      var name = companion();
      var setLogin = function (onNow) {
        B.setLoginItem({ openAtLogin: onNow }).then(function (r) {
          if (!isErr(r)) info.loginItem = Object.assign({}, li, { openAtLogin: onNow });
          S.settingsResult.login = stamp(isErr(r) ? Object.assign({ again: function () { setLogin(onNow); } }, r || { ok: false }) : { ok: true });
          rerender(false, function () { focusEl(document.getElementById('sw-login')); });
        });
      };
      var setNotes = function (onNow) {
        B.setAppState({ notifications: onNow }).then(function (r) {
          if (!isErr(r)) S.appState = Object.assign({}, S.appState, r.state || { notifications: onNow });
          S.settingsResult.notes = stamp(isErr(r) ? Object.assign({ again: function () { setNotes(onNow); } }, r || { ok: false }) : { ok: true });
          rerender(false, function () { focusEl(document.getElementById('sw-notifications')); });
        });
      };
      var setAutoUpdate = function (onNow) {
        B.setUpdateAuto({ on: onNow }).then(function (r) {
          if (!isErr(r) && r && r.status) S.updates = r.status;
          S.settingsResult.updates = stamp(isErr(r) ? Object.assign({ again: function () { setAutoUpdate(onNow); } }, r || { ok: false }) : { ok: true });
          rerender(false, function () { focusEl(document.getElementById('sw-auto-install')); });
        });
      };
      var held = li.status && li.status !== 'enabled' && li.status !== 'not-registered' && li.openAtLogin;
      var loginSmall = !li.supported ? para(ST('loginDevLine'), 'set-sub') : held && isMac() ? para(ST('loginHeldLine', { loginPane: T(F.loginPaneName(info.osRelease)) }), 'set-sub') : null;
      var saved = tr && Number.isInteger(tr.retentionDays) ? tr.retentionDays : 30;
      var days = RETENTION.indexOf(saved) >= 0 ? RETENTION : RETENTION.concat([saved]).sort(function (a, b) { return a - b; });
      var keep = h('select', { id: 'retention-days', class: 'select', 'aria-label': ST('historyLabel'), onChange: function (e) {
        var n = Number(e.target.value);
        B.setRetention({ days: n }).then(function (r) {
          S.settingsResult.history = stamp(r || { ok: false });
          rerender(false, function () { focusEl(document.getElementById('retention-days')); });
        });
      } }, days.map(function (d) { return h('option', { value: String(d), selected: d === saved, text: ST('historyOption', { count: d }) }); }));
      // A row that opens a page: its label and a chevron.
      var subRow = function (id, key, page, fkId, cls) {
        return h('button', { type: 'button', class: 'set set-link set-stack' + (cls ? ' ' + cls : ''), id: id, 'data-fk': fkId || 'open-' + page, 'data-key': 'set-' + id, onClick: function () { go(page); } },
          h('span', { class: 'set-value' }, h('span', { class: 'set-key', text: key })), h('span', { class: 'set-control' }, ico('chevron')));
      };
      // The deletions say what they delete, on the row of the thing they delete (CL-words-76,
      // CL-design-59); each asks first, in main's dialog, once; a no or a failure says so under its row.
      var deleteChats = busyBtn(ST('deleteChatsBtn'), function () {
        return B.transcripts({ deleteAll: true }).then(function (r) {
          S.settingsResult.chats = stamp(r || { ok: false });
          rerender(false, function () { focusEl(findByKey({ fk: 'delete-history', n: 0 })); });
        });
      }, 'btn btn-quiet btn-sm btn-danger', { fk: 'delete-history', 'aria-label': ST('deleteChatsAria') });
      // Forget all: every character's notes, after one confirm in main (CL-player-60).
      var forget = chars.length ? busyBtn(ST('forgetAllBtn'), function () {
        return B.forgetMemory({ all: true }).then(function (r) {
          S.settingsResult.memory = stamp(r || { ok: false });
          // Forgotten: the button goes with the notes, so focus goes to Show less above.
          rerender(false, function () { focusEl(findByKey({ fk: 'forget-all', n: 0 }) || findByKey({ fk: 'more', n: 0 })); });
        });
      }, 'btn btn-quiet btn-sm btn-danger', { fk: 'forget-all' }) : null;
      var openMore = !!S.open.more;
      var toggleMore = ghost(openMore ? ST('lessBtn') : ST('moreBtn'), function () { S.open.more = !openMore; rerender(false, focusAfter('more')); }, { fk: 'more', icon: 'chevron', 'aria-expanded': openMore ? 'true' : 'false', 'aria-controls': 'more-box' });
      // No lines under these rows: their labels and buttons say it, and Show more stays at 45 words or fewer.
      var moreBox = !openMore ? null : h('div', { class: 'more', id: 'more-box', 'data-key': 'more', 'data-behind': 'click' },
        group(null, [
          stackRow('history-row', ST('historyLabel'), [settingsLine('history'), settingsLine('chats', ST('deletedLine'))], h('div', { class: 'row' }, keep, deleteChats)),
          forget || S.settingsResult.memory ? stackRow('memory-row', ST('memoryLabel'), [settingsLine('memory', ST('forgotLine'))], forget) : null,
          // The chat-frame echo: the desktop gates it (off by default: chat-logging addons keep the chat
          // frame), and the game's words send the player here (CL-words-73).
          stackRow('pv-echo', ST('echoLabel'), [settingsLine('pv-echo')], switchBtn('sw-echo', ST('echoLabel'), !!values.echo, function (onNow) { privacyFlip(values, 'echo', onNow); })),
        ], 'more-data'),
        group(null, [
          // Run setup again is the row (it opens setup, as the rows under it open their pages).
          h('button', { type: 'button', class: 'set set-link set-stack', id: 'setup-row', 'data-fk': 'run-setup', 'data-key': 'set-setup-row', onClick: function () { S.setup = newSetup(); go('setup'); } },
            h('span', { class: 'set-value' }, h('span', { class: 'set-key', text: ST('runSetupBtn') })), h('span', { class: 'set-control' }, ico('chevron'))),
          subRow('diag-row', ST('diagnosticsLabel'), 'diagnostics'),
          subRow('about-row', ST('aboutLabel'), 'about'),
          subRow('uninstall-row', ST('uninstallBtn'), 'uninstall', 'open-uninstall', 'set-link-danger'),
        ], 'more-help'));
      return pageNode('page-settings', { left: [], right: [] }, [
        title(ST('title')),
        group(null, [
          stackRow('login-row', ST('loginLabel'), [loginSmall, settingsLine('login')], switchBtn('sw-login', ST('loginLabel'), !!(li.supported && li.openAtLogin), setLogin, !li.supported)),
          stackRow('notes-row', ST('notificationsLabel'), [settingsLine('notes')], switchBtn('sw-notifications', ST('notificationsLabel'), !S.appState || S.appState.notifications !== false, setNotes)),
          stackRow('auto-updates-row', ST('autoUpdateLabel'), [para(ST('autoUpdateLine'), 'set-sub'), settingsLine('updates')], switchBtn('sw-auto-install', ST('autoUpdateLabel'), upd.auto !== false, setAutoUpdate)),
          stackRow('checkins-row', ST('checkInsLabel'), [para(ST('checkInsLine', { name: name }), 'set-sub'), settingsLine('pv-companion')], switchBtn('sw-companion', ST('checkInsLabel'), !!values.companion, function (onNow) { privacyFlip(values, 'companion', onNow); })),
        ], 'general'),
        h('div', { class: 'actions actions-quiet', 'data-key': 'more-toggle' }, toggleMore),
        moreBox,
      ]);
    });
  };

  // Your data (the nav's page): the switches for what's sent, under who it's sent to, and the records
  // (Connections, Last request) one click away. The picture of where it goes and the AI company's
  // terms are behind Show details.
  var PRIVACY_ROWS = [
    ['gameContext', 'gameDataLabel', 'gameDataHint'],
    ['identity', 'identityLabel', 'identityHint'],
    ['otherNames', 'otherNamesLabel', 'otherNamesHint'],
  ];
  var PRIVACY_DEFAULTS = { identity: false, otherNames: false, companion: false, echo: false, gameContext: true, screenReading: true };
  function privacyValues(res) {
    var out = {};
    Object.keys(PRIVACY_DEFAULTS).forEach(function (k) { out[k] = res && typeof res[k] === 'boolean' ? res[k] : PRIVACY_DEFAULTS[k]; });
    // Defaults drawn because the saved values couldn't be read: never sent back (a flip would turn screen
    // reading back on, SY-10). Not enumerable, so it never reaches the IPC.
    if (!res) Object.defineProperty(out, 'unread', { value: true });
    return out;
  }
  function playerWords(t) { return F.render(F.clean(t, 300), null, platform()); }
  /**
   * Your data's sheet: where it goes first (the picture: your computer, straight to the AI company;
   * NeverQuestAlone gets nothing; CL-words-75), then what the AI company keeps and whether it trains
   * (the manifest's player text), its policy, OpenAI's install ID.
   */
  /**
   * The data sheet's cards (the owner, 2026-10-03: "more well organized and less cluttered"): each part
   * one card of rows, as the pages' groups are. A row is an icon and its words, or a muted key over its
   * value; a link is the card's last row.
   */
  function sheetCard(rows) { return h('div', { class: 'sheet-card' }, rows.filter(Boolean)); }
  function sheetItem(icon, name, sub, cls) {
    return h('div', { class: 'sheet-row' + (cls ? ' ' + cls : '') }, ico(icon, 'sheet-row-ico'),
      h('div', { class: 'sheet-row-text' }, h('span', { class: 'sheet-row-val', text: name }), sub ? h('span', { class: 'sheet-row-key', text: sub }) : null));
  }
  /** A line of words as a row of its card. */
  function sheetLine(text) { return h('div', { class: 'sheet-row' }, h('p', { class: 'sheet-row-val', text: text })); }
  /** A link as its card's last row: its words, then ↗. */
  function sheetLinkRow(label, onClick, fk) {
    return h('button', { type: 'button', class: 'sheet-row sheet-link', 'data-fk': fk, onClick: onClick }, h('span', { class: 'btn-label', text: label }), ico('out', 'sheet-row-ico'));
  }
  /** An action that ends a card (Replace ID): a full-width row like the link rows, in the text colour, busy while it runs. */
  function sheetActionRow(label, fn, fk) {
    var b = h('button', { type: 'button', class: 'sheet-row sheet-link sheet-action', 'data-fk': fk }, h('span', { class: 'btn-label', text: label }), ico('refresh', 'sheet-row-ico'));
    on(b, 'click', busy(b, fn));
    return b;
  }
  /** Where it goes, as rows (every sheet that says it: Your data, an AI's, Other's): the picture, what each message carries, what NeverQuestAlone gets. */
  function whereRows(pid) {
    return [
      sheetFlow(pid),
      sheetItem('chat', T('flow.inMessageLine'), null, 'sheet-row-quiet'),
      sheetItem('none', T('flow.usLine'), T('flow.usSubLine'), 'sheet-row-off'),
    ];
  }
  function sheetRecord(key, value) {
    return h('div', { class: 'sheet-row' }, h('div', { class: 'sheet-row-text' }, h('span', { class: 'sheet-row-key', text: key }), h('span', { class: 'sheet-row-val', text: value })));
  }
  /** Your computer → the AI: the picture as the card's first row, its names data (the budget counts words). */
  function sheetFlow(pid) {
    var fn = flowNames(pid);
    return h('div', { class: 'sheet-row sheet-flow', role: 'img', 'aria-label': fn.alt, 'data-key': 'flow' },
      h('span', { class: 'sheet-flow-end', 'aria-hidden': 'true' }, ico('computer', 'sheet-row-ico'), h('span', { class: 'sheet-row-val', text: T('flow.youLine') })),
      h('span', { class: 'flow-arrow', 'aria-hidden': 'true' }, h('i')),
      h('span', { class: 'sheet-flow-end sheet-flow-to', 'aria-hidden': 'true', 'data-count': 'data' }, ico('spark', 'sheet-row-ico'),
        h('span', { class: 'sheet-row-text' }, h('span', { class: 'sheet-row-val', text: fn.to }), fn.sub ? h('span', { class: 'sheet-row-key', text: fn.sub }) : null)));
  }
  function dataSheet(id) {
    return function () {
      var PV = function (k, x) { return T('pages.privacy.' + k, x); };
      var p = id ? providerById(id) : null;
      var c = p && p.privacyCard;
      var sections = [{ label: T('details.leavesLabel'), body: [sheetCard(whereRows(id))] }];
      if (c) {
        var link = c.link && !isLocal(id) && !isCustom(id) ? sheetLinkRow(PV('dataPolicyLink', { co: coName(id) }), openLink(c.link), 'data-policy') : null;
        sections.push({ label: isLocal(id) ? aiName(id) : T('details.keptLabel', { co: isCustom(id) ? (customName() || pname(id)) : coName(id) }), body: [sheetCard([
          c.keeps ? sheetRecord(PV('keepsLabel'), playerWords(c.keeps)) : null,
          c.trains ? sheetRecord(PV('trainsLabel'), playerWords(c.trains)) : null,
          link,
        ])] });
        // OpenAI only: the random ID it sees for this install, and Replace ID.
        if (id === 'openai') {
          var replaceId = sheetActionRow(T('yourAi.replaceIdBtn'), function () {
            return B.regenerateSafetyId().then(function (r) { S.safetyId = stamp(r || { ok: false }); if (S.sheet) { paintSheet(); focusEl($sheet.querySelector('[data-fk="regenerate-safety-id"]')); } });
          }, 'regenerate-safety-id');
          var idLine = S.safetyId ? (S.safetyId.ok ? rowLine('ok', T('yourAi.safetyIdDoneLine'), S.safetyId) : rowLine('bad', errText(S.safetyId), S.safetyId)) : null;
          sections.push({ label: T('yourAi.safetyIdLabel'), body: [PV('safetyIdBody'), idLine, replaceId].filter(Boolean) });
        }
      }
      // On your screen (the trust plan): what screen reading reads, exactly, and what off means; the
      // page's Screen reading row says it in a few words.
      sections.push({ label: PV('screenSheetLabel'), body: [PV(isMac() ? 'screenSheetBody' : 'screenSheetBodyWin'), PV('screenSheetOffBody')] });
      return { title: T('details.titleData'), sections: sections };
    };
  }
  PAGES.privacy = function () {
    return Promise.all([B.privacy(), ensureProviders()]).then(function (res) {
      var values = S.privacyValues || privacyValues(isErr(res[0]) ? null : res[0]);
      var p = P();
      var pid = p.provider ? p.provider.id : null;
      var PV = function (k, v) { return T('pages.privacy.' + k, v); };
      var switches = PRIVACY_ROWS.map(function (r) {
        var off = r[0] === 'gameContext' && !values[r[0]];
        return stackRow('pv-' + r[0], PV(r[1]), [para(off ? PV('gameDataOffLine') : PV(r[2]), 'set-sub'), settingsLine('pv-' + r[0])], switchBtn('sw-' + r[0], PV(r[1]), !!values[r[0]], function (onNow) { privacyFlip(values, r[0], onNow); }));
      });
      // Screen reading, one click (the orchestrator's trust plan, 2026-10-03): what it reads, exactly, and
      // what off means. On here but off in the addon's Settings (its hello's mode): said, not hidden.
      var hm = ((setupBlock().game || {}).hello || {}).mode;
      var addonOff = !!values.screenReading && (hm === 'stream' || hm === 'reload');
      var readLine = addonOff ? rowLine('warn', PV('screenAddonOffLine', { name: companion() })) : para(values.screenReading ? PV(isMac() ? 'screenOnLine' : 'screenOnLineWin') : PV('screenOffLine'), 'set-sub');
      var screen = stackRow('pv-screenReading', PV('screenLabel'), [readLine, settingsLine('pv-screenReading')],
        switchBtn('sw-screenReading', PV('screenLabel'), !!values.screenReading, function (onNow) { privacyFlip(values, 'screenReading', onNow); }));
      // The records, one click each: their names say what they are (CL-words-62: no hint lines).
      var records = [
        h('button', { type: 'button', class: 'set set-link set-stack', id: 'connections-row', 'data-fk': 'open-connections', 'data-key': 'set-connections', onClick: function () { go('connections'); } },
          h('span', { class: 'set-value' }, h('span', { class: 'set-key', text: PV('connectionsLabel') })), h('span', { class: 'set-control' }, ico('chevron'))),
        h('button', { type: 'button', class: 'set set-link set-stack', id: 'last-request-row', 'data-fk': 'open-last-request', 'data-key': 'set-last-request', onClick: function () { go('last-request'); } },
          h('span', { class: 'set-value' }, h('span', { class: 'set-key', text: PV('lastRequestLabel') })), h('span', { class: 'set-control' }, ico('chevron'))),
      ];
      // Where it goes, in the switches' title (CL-words-75): the AI company, or Other's service by its
      // host. No AI, or a model on this computer (its lead says nothing leaves): the plain title.
      var co = pid && !isLocal(pid) ? (isCustom(pid) ? customName() || pname(pid) : coName(pid)) : null;
      return pageNode('page-privacy', { left: [], right: [] }, [
        h('div', { class: 'title-row', 'data-key': 'title-row' }, title(PV('title')), pid && (providerById(pid) || {}).privacyCard ? detailsBtn(dataSheet(pid)) : null),
        // A model on this computer: the one line that says nothing leaves it.
        pid && isLocal(pid) ? para(PV('localLine'), 'lead') : null,
        group(co ? PV('sentToTitle', { co: co }) : PV('sentTitle'), switches, 'sent-group'),
        group(null, [screen], 'screen-group'),
        group(null, records, 'records-group'),
      ]);
    });
  };
  /**
   * The AddOns folder's permissions: calm, optional, never in the way. What the check found (the
   * bridge's detail), then "Fix permissions" when this account can (main asks first), else "Copy
   * the command" for an administrator (shown once copied). Fix permissions changes only the
   * permissions (no reinstall; WoW may be open).
   */
  function permissionsBlock(pm, o) {
    var win = isWin();
    var canFix = !!pm.fixable && !win;
    var ps = o.state || {};
    var W = function (k) { return T('pages.diagnostics.permissions.' + k, { name: companion() }); };
    var open = !!S.open['perm-details'];
    var more = [F.clean(pm.detail, 400), canFix ? null : win ? W('adminDetailWin') : W('adminDetail')].filter(Boolean);
    // A copied command and its explanation stay behind Show details, on every system (player-38).
    if (ps.copied && ps.copied.command) more = more.concat([ps.copied.command, ps.copied.explanation].filter(Boolean));
    var extra = [];
    if (canFix) extra.push(busyBtn(W('fixBtn'), function () { return B.tightenAddonPermissions().then(function (r) { o.fixed(r); }); }, 'btn btn-quiet btn-sm', { fk: 'fix-permissions' }));
    if (pm.command) {
      extra.push(busyBtn(W('copyCommandBtn'), function () {
        return B.copyPermissionsCommand().then(function (r) {
          if (isErr(r)) { o.copied({ text: errText(r, W('nothingToCopyLine')) }); return; }
          o.copied({ text: W('copiedLine'), command: F.clean(r.command, 4000), explanation: F.clean(r.explanation, 300) });
        });
      }, 'btn btn-quiet btn-sm', { fk: 'copy-admin-command' }));
    } else if (pm.explanation) more.push(F.clean(pm.explanation, 300));
    extra.push(ghost(open ? W('hideDetailsBtn') : W('detailsBtn'), function () { S.open['perm-details'] = !open; rerender(false, focusAfter('perm-details')); }, { fk: 'perm-details', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': 'perm-details-box' }));
    var n = o.stamped && o.stamped.n ? String(o.stamped.n) : null;
    var note = ps.note ? h('p', { class: 'small', 'data-say': ps.note, 'data-say-n': n, text: ps.note }) : null;
    var copied = ps.copied ? h('div', { class: 'copied', 'data-say': ps.copied.text, 'data-say-n': n }, para(ps.copied.text, 'small')) : null;
    return h('div', { class: 'perm', 'data-say': W('optionalLine') },
      para(W('optionalLine')),
      open ? h('div', { class: 'obj-note', id: 'perm-details-box', 'data-behind': 'click' }, more.map(function (t) { return ps.copied && t === ps.copied.command ? code(t) : para(t, 'small'); })) : null,
      note, copied,
      h('div', { class: 'row' }, extra));
  }
  function afterTighten(r) {
    if (isErr(r)) return { note: r && r.error === 'cancelled' ? T('errors.cancelled') : errText(r) };
    var pm = r.permissions || {};
    if (pm.ok === false) return { note: T('pages.diagnostics.permissions.partLine'), permissions: pm };
    return { done: true, permissions: pm };
  }
  PAGES.diagnostics = function () {
    return B.addonPermissions().then(function (r) {
      return diagnosticsPage(!isErr(r) && r ? r.permissions : null);
    }, function () { return diagnosticsPage(null); });
  };
  function permissionsCard(pm) {
    var d = S.diagPerm || {};
    var box = function (kids) { return h('section', { class: 'group group-pad', 'data-key': 'perm' }, h('h2', { class: 'group-title', text: T('pages.diagnostics.permissions.title') }), kids); };
    if (d.done) return box(resultLine('ok', T('pages.diagnostics.permissions.doneLine'), d));
    if (!pm || pm.ok !== false) return null;
    return box(permissionsBlock(d.permissions || pm, {
      state: d, stamped: d,
      fixed: function (r) { S.diagPerm = stamp(afterTighten(r)); rerender(); },
      copied: function (c) { S.diagPerm = stamp(Object.assign({}, S.diagPerm || {}, { copied: c, note: null })); rerender(); },
    }));
  }
  /** The system in a player's words (CL-words-28): "macOS · Apple silicon", "Windows · x64". */
  function diagnosticsPage(pm) {
    var D = function (k, v) { return T('pages.diagnostics.' + k, v); };
    var got = S.diagCopied;
    return pageNode('page-diagnostics', subTop(), [
      title(D('title')),
      // The card says what its button copies, above it (CL-design-62).
      h('section', { class: 'group group-pad', 'data-key': 'bundle' },
        para(D('bundleBody'), 'small muted'),
        row(busyBtn(T('common.copyDiagnosticsBtn'), function () {
          return B.copyDiagnostics().then(function (r) { S.diagCopied = stamp(r || { ok: false }); rerender(); });
        }, 'btn btn-primary btn-sm', { fk: 'copy-diagnostics' })),
        // After a copy: one line; the text itself one click away (CL-words-37: no versions on the page).
        got ? (isErr(got) ? resultLine('bad', errText(got), got) : h('div', null, resultLine('ok', D('copiedLine', { size: F.bytes(got.bytes), n: got.lines }), got),
          h('div', { class: 'actions actions-quiet', 'data-key': 'copied-toggle' }, ghost(S.open.copied ? D('hideCopiedBtn') : D('showCopiedBtn'), function () { S.open.copied = !S.open.copied; rerender(false, focusAfter('show-copied')); }, { fk: 'show-copied', icon: 'chevron', 'aria-expanded': S.open.copied ? 'true' : 'false', 'aria-controls': 'copied-box' })),
          S.open.copied ? h('div', { id: 'copied-box', 'data-behind': 'click' }, code(got.text, true)) : null)) : null),
      permissionsCard(pm),
    ]);
  }

  var UPDATE_STATES = { idle: 1, checking: 1, none: 1, available: 1, downloading: 1, ready: 1, error: 1, off: 1 };
  var UPDATE_PROBLEMS = { refused: 'refused', network: 'network', failed: 'failed', not_packaged: 'notPackaged' };
  /**
   * About, with the update line in it (the app trim folded Updates here): the version, whether you
   * have the latest (or that checks are off), the one action that state offers, the Automatic update
   * checks switch, and Legal and credits one click away.
   */
  PAGES.about = function () {
    return Promise.all([B.notices(), B.updates()]).then(function (res) {
      var list = Array.isArray(res[0]) ? res[0] : [];
      var u = S.updates = isErr(res[1]) ? (S.updates || {}) : (res[1] || {});
      var info = S.info || {};
      var A = function (k, v) { return T('pages.about.' + k, v); };
      var UP = function (k, v) { return T('pages.updates.' + k, v); };
      var legal = !!S.open.legal;
      var words = UPDATE_STATES[u.state] ? UP('state.' + u.state) : '';
      if (u.state === 'available' && u.available) words = UP('state.availableVersion', { version: F.clean(u.available.version, 40) });
      if (u.state === 'downloading' && u.progress != null) words = UP('state.downloadingPct', { pct: u.progress });
      if (u.state === 'ready' && u.auto !== false && !u.notifyOnly && u.mode !== 'never') words = UP('state.readyAuto');
      if (u.configured === false) words = UP('notSetUpLine');
      else if (u.supported === false) words = UP('installedOnlyLine');
      // Checks off (CL-words-79): the line says so, and the download page is one quiet click away; an
      // update already found or downloaded keeps its own line and action.
      var checksOff = u.supported && u.configured !== false && u.mode === 'never' && !/^(available|downloading|ready)$/.test(u.state);
      if (checksOff) words = UP('state.checksOff');
      var acts = [];
      if (u.supported && u.mode === 'notify') acts.push(busyBtn(UP('checkBtn'), function () { return B.checkForUpdates().then(function () { rerender(); }); }, 'btn btn-quiet btn-sm', { fk: 'check-updates' }));
      else if (checksOff && S.info && S.info.releases) acts.push(btn(UP('openDownloadBtn'), openLink('releases'), 'btn btn-quiet btn-sm', { fk: 'open-download', after: 'out' }));
      else if ((u.supported === false || u.configured === false) && S.info && S.info.releases) acts.push(btn(UP('openDownloadBtn'), openLink('releases'), 'btn btn-primary btn-sm', { fk: 'open-download', after: 'out' }));
      if (u.state === 'available') acts.push(u.notifyOnly ? btn(UP('openDownloadBtn'), openLink('releases'), 'btn btn-quiet btn-sm', { after: 'out' }) : busyBtn(UP('downloadBtn'), function () { return B.downloadUpdate().then(function () { rerender(); }); }, 'btn btn-primary btn-sm', { fk: 'download' }));
      if (u.state === 'ready' && !(P().wow && P().wow.running)) acts.push(busyBtn(UP('quitInstallBtn'), function () { return B.installUpdateNow().then(function (r) { if (isErr(r)) { S.updateResult = stamp(r); rerender(); } }); }, 'btn btn-primary btn-sm', { fk: 'quit-install' }));
      var resOut = S.updateResult;
      var problem = u.supported && u.error && UPDATE_PROBLEMS[u.error] ? UP('problem.' + UPDATE_PROBLEMS[u.error]) : null;
      var auto = u.supported && u.configured !== false
        ? h('div', { class: 'set set-bare', 'data-key': 'auto-updates' }, h('span', { class: 'set-key set-key-wide', id: 'auto-updates-label', text: UP('notifyName') }),
          switchBtn('sw-auto-updates', UP('notifyName'), u.mode !== 'never', function (on) {
            B.setUpdateMode({ mode: on ? 'notify' : 'never' }).then(function () { rerender(false, function () { focusEl(document.getElementById('sw-auto-updates')); }); });
          }))
        : null;
      return pageNode('page-about', subTop(), [
        title(A('title')),
        para(A('lead', { version: F.clean(info.version, 40) }), 'lead'),
        h('section', { class: 'group group-pad', 'data-key': 'updates' },
          para(words, 'update-state'),
          problem ? resultLine('warn', problem, null) : null,
          acts.length ? row(acts) : null,
          resOut ? resultLine(resOut.error === 'cancelled' ? 'warn' : 'bad', errText(resOut), resOut) : null,
          auto),
        h('div', { class: 'actions actions-quiet', 'data-key': 'legal-toggle' }, ghost(legal ? A('hideLegalBtn') : A('legalBtn'), function () { S.open.legal = !legal; rerender(false, focusAfter('legal')); }, { fk: 'legal', icon: 'chevron', 'aria-expanded': legal ? 'true' : 'false', 'aria-controls': 'legal-box' })),
        legal ? h('div', { id: 'legal-box', 'data-key': 'legal', 'data-behind': 'click' },
          h('section', { class: 'group group-pad', 'data-key': 'notice-legal' },
            para(A('unofficialBody'), 'small'),
            para(A('trademarkBody'), 'small muted'),
            row(linkBtn(A('trademarksLink'), openLink('blizzard.trademarks'), { fk: 'trademarks' }))),
          h('section', { class: 'group group-pad', 'data-key': 'credits' },
            h('h2', { class: 'group-title', text: A('creditsTitle') }),
            para(A('upstreamBody'), 'small'), row(linkBtn(A('upstreamLink'), openLink('credits.upstream'), { fk: 'credit-upstream' })),
            para(A('codexBody'), 'small'), row(linkBtn(A('codexLink'), openLink('credits.codex'), { fk: 'credit-codex' })),
            para(A('fontsBody'), 'small')),
          h('section', { class: 'group group-pad', 'data-key': 'license' }, h('h2', { class: 'group-title', text: A('licenseTitle') }), code(F.clean(info.license || 'MIT', 20000), true), para(A('licenseNote'), 'small muted')),
          h('section', { class: 'group group-pad', 'data-key': 'notices' },
            h('h2', { class: 'group-title', text: A('noticesTitle') }),
            para(A('noticesBody'), 'small muted'),
            list.length ? table([A('packageCol'), A('licenseCol'), ''], list.map(function (n) {
              var id = 'n:' + n.name;
              var open = !!S.open[id];
              return [
                h('div', null, h('span', { class: 'mono', text: F.clean(n.name, 80) + '@' + F.clean(n.version, 30) }), open && n.text ? code(F.clean(n.text, 30000), true) : null),
                F.clean(n.license, 40),
                h('div', { class: 'row row-end' }, n.text ? btn(open ? A('hideNoticeBtn') : A('showNoticeBtn'), function () { S.open[id] = !open; rerender(); }, 'btn btn-quiet btn-sm', { fk: 'notice-' + n.name }) : null),
              ];
            })) : para(A('noPackagesLine'), 'empty'))) : null,
      ]);
    });
  };
  PAGES.uninstall = function () {
    var G = function (k, v) { return T('pages.uninstall.' + k, v); };
    var removeAddon = S.removeAddon !== false;
    var r = S.uninstallResult;
    return Promise.resolve(pageNode('page-uninstall', subTop(), [
      title(G('title')),
      para(G('lead'), 'lead'),
      h('section', { class: 'group group-pad', 'data-key': 'uninstall' },
        h('ul', { class: 'xlist' }, [G('appItem'), G('keysItem', { store: store() }), G(isMac() ? 'loginItem' : 'loginItemWin')].map(function (t) { return h('li', null, ico('x', 'set-ico'), h('span', { text: t })); })),
        h('div', { class: 'set set-bare', 'data-key': 'rm-addon' }, h('span', { class: 'set-key set-key-wide', id: 'rm-addon-label', text: G('addonLabel') }), switchBtn('sw-rm-addon', G('addonLabel'), removeAddon, function (onNow) { S.removeAddon = onNow; rerender(false, function () { focusEl(document.getElementById('sw-rm-addon')); }); })),
        row(busyBtn(G('uninstallBtn'), function () {
          return B.uninstall({ removeAddon: removeAddon }).then(function (res) { S.uninstallResult = stamp(res || { ok: false }); rerender(); });
        }, 'btn btn-quiet btn-danger', { fk: 'uninstall' })),
        r ? (isErr(r) ? resultLine(r.error === 'cancelled' ? 'warn' : 'bad', errText(r), r) : result('ok', [G('doneLine'), F.clean(r.finish, 200)], null, r)) : null),
    ]));
  };

  // -------------------------------------------------------------------------
  // Start.

  // The Listening dot breathes only while the window is in front of the player (code health, the
  // audit's .listen-dot note): with hardware acceleration off, a running animation has the compositor
  // draw every frame in software, and while the player types in game this window is behind WoW,
  // minimized or hidden. Away, the dot holds still at full strength (style.css [data-away]); back
  // in front, it breathes again.
  function markAway() {
    var away = document.visibilityState === 'hidden' || (typeof document.hasFocus === 'function' && !document.hasFocus());
    if (away) document.documentElement.setAttribute('data-away', ''); else document.documentElement.removeAttribute('data-away');
  }
  if (typeof window.addEventListener === 'function') { window.addEventListener('focus', markAway); window.addEventListener('blur', markAway); }
  document.addEventListener('visibilitychange', markAway);
  markAway();

  // Status pushes (the bridge's onChange, debounced in main): the panel and the banners follow at
  // once; the page itself on Home and on Say hi in game, whose rows follow the game.
  function applyStatus(s) {
    S.status = s;
    paintPanel();
    paintBanners();
    var st = S.setup;
    var running = !!(P().wow && P().wow.running);
    if (S.page === 'setup' && st && !st.busy && st.screen === 'wow') rerender();
    else if (S.page === 'home') rerender();
    // About offers Restart to update only with WoW closed: it follows the game starting and closing (W-20).
    else if (S.page === 'about' && S.updates && S.updates.state === 'ready' && running !== S.lastRunning) rerender();
    S.lastRunning = running;
  }
  // The same status again changes nothing, so it draws nothing; while a pointer is down in the
  // window, a push waits for the release, so the click it makes lands on the control it started on.
  var lastPush = null;
  var pressing = false;
  var pushWaiting = false;
  B.onStatus(function (s) {
    var sig = null;
    try { sig = JSON.stringify(s); } catch (e) { sig = null; }
    if (sig !== null && sig === lastPush) return;
    lastPush = sig;
    if (pressing) { pushWaiting = true; return; }
    applyStatus(s);
  });
  function flushPush() {
    if (pressing || !pushWaiting) return;
    pushWaiting = false;
    B.status().then(function (s) { if (s && !pressing) applyStatus(s); else if (s) pushWaiting = true; });
  }
  function released() {
    if (!pressing) return;
    pressing = false;
    if (pushWaiting && typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(flushPush);
  }
  document.addEventListener('pointerdown', function () { pressing = true; }, true);
  document.addEventListener('pointerup', released, true);
  document.addEventListener('pointercancel', released, true);
  document.addEventListener('click', flushPush);
  B.onNavigate(function (page) {
    if (page === 'setup' && S.page === 'setup') return; // already there: the screen stays (only a click changes it)
    if (page === 'setup') S.setup = null;
    go(page);
  });
  B.onUpdates(function (u) {
    S.updates = u;
    paintBanners();
    paintFoot();
    if (S.page === 'about' || S.page === 'settings') rerender();
  });

  Promise.all([B.appInfo(), B.appState(), B.status(), B.updates()]).then(function (r) {
    S.info = isErr(r[0]) ? {} : r[0];
    S.appState = isErr(r[1]) ? {} : r[1];
    S.status = r[2];
    S.updates = isErr(r[3]) ? null : r[3];
    var hash = String(location.hash || '').replace(/^#/, '');
    if (hash === 'general') hash = 'settings';
    ensureProviders().then(function () {
      go(PAGES[hash] || hash === 'usage' || hash === 'updates' || hash === 'memory' ? hash : (S.appState.onboarded ? 'home' : 'setup'));
    }, function () { go(S.appState.onboarded ? 'home' : 'setup'); });
  });
})();
