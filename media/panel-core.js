// Core constants, DOM factories, cached icons/date formatters, CSSOM-safe DOM
// reconciliation, and motion primitives shared across the panel modules.
(root => {
  'use strict';
  const { visible, isWait, requestToken } = root.AgentSessionFormat;
  const { t, phrase, perLocale } = root.AgentSessionI18n;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const providers = [
    ['claude', 'Claude Code', 'C'],
    ['codex', 'Codex', 'O'],
    ['agy', 'Antigravity', 'A'],
  ];
  const PROVIDER_SPECS = Object.fromEntries(providers.map(spec => [spec[0], spec]));
  const shortProviders = { claude: 'Claude', codex: 'Codex', agy: 'AGY' };
  // English text, translated where it is shown.
  const STATUS_LABELS = {
    approval: phrase('Approval needed'), input: phrase('Answer needed'), working: phrase('Working'), error: phrase('Error'),
    done: phrase('Replied'), idle: phrase('Paused'), stale: phrase('No recent signal'), recent: phrase('Recent'),
  };
  const SECTION_NAMES = { attention: phrase('Needs attention'), working: phrase('Working'), history: phrase('Earlier') };
  const USAGE_LABELS = { claude: phrase('Subscription usage'), codex: phrase('View usage'), agy: phrase('Account settings') };
  const defaultOrder = providers.map(([id]) => id);
  const SOURCE_LABELS = { call: phrase('Model call'), setting: phrase('Tool setting'), response: phrase('Actual response'), request: phrase('Turn request') };
  const from = table => key => Object.hasOwn(table, key) ? t(table[key]) : '';
  const statusLabel = from(STATUS_LABELS);
  const sectionName = from(SECTION_NAMES);
  const usageLabel = from(USAGE_LABELS);
  const specFor = id => PROVIDER_SPECS[id];
  const sourceText = source => Object.hasOwn(SOURCE_LABELS, source) ? t(SOURCE_LABELS[source]) : t('Unknown source');
  const navigable = row => row.canOpen !== false || row.viaParent;

  // Cached locale formatters + fast local Y/M/D comparison.
  const hourMinute = perLocale(tag => new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const monthDay = perLocale(tag => new Intl.DateTimeFormat(tag, { month: 'numeric', day: 'numeric' }));
  const dateTimeShort = perLocale(tag => new Intl.DateTimeFormat(tag, {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }));
  function isSameLocalDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function when(value, now = Date.now()) {
    if (!value) return '';
    const time = new Date(value);
    const today = new Date(now);
    return isSameLocalDay(today, time) ? hourMinute().format(time) : monthDay().format(time);
  }
  function resetLabel(at, now = Date.now()) {
    const date = new Date(at);
    const today = new Date(now);
    const day = isSameLocalDay(date, today) ? '' : (date.getMonth() + 1) + '/' + date.getDate() + ' ';
    return day + hourMinute().format(date);
  }
  function quotaAlertText(hint, compact = false, now = Date.now()) {
    if (!hint) return '';
    const at = hint.resetsAt ? resetLabel(hint.resetsAt, now) : '';
    const reset = !hint.resetsAt ? ''
      : !hint.resetIn ? t('Resets at {0}', at)
        : compact ? t('Resets {0}', hint.resetIn) : t('Resets {0} ({1})', hint.resetIn, at);
    const used = t('{0} limit used up', hint.label);
    return reset ? used + ' · ' + reset : used;
  }

  function element(tag, className, value) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (value !== undefined) item.textContent = value;
    return item;
  }
  function button(className, accessible, value) {
    const item = element('button', className, value);
    item.type = 'button';
    item.setAttribute('aria-label', accessible);
    return item;
  }
  function actionButton(row, action, caption, style = 'secondary') {
    const item = button(style, row.title + ' · ' + caption, caption);
    item.dataset.action = action;
    item.dataset.target = row.key;
    return item;
  }

  // Line icons on a 16px grid, drawn with the text colour and cloned from cached templates.
  const iconPaths = {
    command: ['M2.75 3.75h10.5v8.5H2.75z', 'M5 6.6l1.9 1.4L5 9.4', 'M8.4 9.6h2.6'],
    patch: ['M3 13l.7-2.8 7.2-7.2a1.1 1.1 0 0 1 1.6 0l.5.5a1.1 1.1 0 0 1 0 1.6L5.8 12.3z', 'M9.8 4.1l2.1 2.1'],
    write: ['M4.25 2.5h4.5l3 3v8h-7.5z', 'M8.75 2.5v3h3', 'M6.4 9.6h3.2M8 8v3.2'],
    read: ['M1.75 8S4 4.25 8 4.25 14.25 8 14.25 8 12 11.75 8 11.75 1.75 8 1.75 8z', 'M8 9.75a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5z'],
    search: ['M7 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M10 10l3.25 3.25'],
    web: ['M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z', 'M2.5 8h11', 'M8 2.5c1.6 1.5 2.4 3.3 2.4 5.5S9.6 12 8 13.5C6.4 12 5.6 10.2 5.6 8S6.4 4 8 2.5z'],
    agent: ['M4.5 5.4v2.85a3 3 0 0 0 3 3h3', 'M4.5 5.4a1.35 1.35 0 1 0 0-2.7 1.35 1.35 0 0 0 0 2.7z', 'M11.85 12.6a1.35 1.35 0 1 0 0-2.7 1.35 1.35 0 0 0 0 2.7z'],
    plan: ['M5.75 4.25h7.5M5.75 8h7.5M5.75 11.75h7.5', 'M2.75 4.25h.6M2.75 8h.6M2.75 11.75h.6'],
    focus: ['M8 13.25a5.25 5.25 0 1 0 0-10.5 5.25 5.25 0 0 0 0 10.5z', 'M8 9.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z'],
    skill: ['M8.75 2.25L4 8.75h4l-.75 5 4.75-6.5h-4z'],
    fail: ['M4.75 4.75l6.5 6.5M11.25 4.75l-6.5 6.5'],
    permission: ['M8 2.25L3.25 4.25v3.6c0 3 2 5.35 4.75 6.15 2.75-.8 4.75-3.15 4.75-6.15v-3.6L8 2.25z', 'M8 6v2.75', 'M8 10.6v.1'],
    question: ['M3.25 3.25h9.5v7h-5l-3 2.5v-2.5h-1.5z', 'M6.75 5.9a1.3 1.3 0 1 1 1.9 1.15c-.4.2-.65.45-.65.9', 'M8 9.05v.1'],
    other: ['M8 2.5l5.5 5.5L8 13.5 2.5 8z'],
    warn: ['M8 2.75l5.75 10H2.25z', 'M8 6.6v2.9', 'M8 11.2v.1'],
    out: ['M6.25 4h5.75v5.75', 'M12 4l-7.5 7.5'],
    plus: ['M8 3.25v9.5M3.25 8h9.5'],
    more: ['M3.6 8h.01M8 8h.01M12.4 8h.01'],
    check: ['M3.5 8.5l3 3 6-6.5'],
    turn: ['M6 3.5l4.5 4.5L6 12.5'],
    back: ['M10 3.5L5.5 8 10 12.5'],
    pin: ['M8 10v3.5', 'M5.25 10h5.5L10 6.5V3.25H6V6.5z'],
    refresh: ['M12.75 8a4.75 4.75 0 1 1-1.4-3.36', 'M12.75 2.9v2.35H10.4'],
    sort: ['M4.5 3v10M4.5 13l-2-2M4.5 13l2-2', 'M9 4.5h4.5M9 8h3.25M9 11.5h2'],
    link: ['M6.75 9.25l2.5-2.5', 'M7.5 4.75l.9-.9a2.6 2.6 0 0 1 3.7 3.7l-.9.9', 'M8.5 11.25l-.9.9a2.6 2.6 0 0 1-3.7-3.7l.9-.9'],
    inbox: ['M2.75 9.25l1.6-5.5h7.3l1.6 5.5v3H2.75z', 'M2.75 9.25h3l.75 1.5h3l.75-1.5h3'],
    folder: ['M2.5 4.25h3.75l1.25 1.5h6v6.5h-11z'],
    copy: ['M5.75 5.75h6.5v7.5h-6.5z', 'M3.75 10.25V3.75h6.5'],
    file: ['M4.25 2.5h5l3 3v8h-8z', 'M9.25 2.5v3h3'],
    reply: ['M3 3.75h10v7H6.5L3 13.25z'],
  };
  const iconCache = new Map();
  function icon(name, className = 'icon') {
    const key = Object.hasOwn(iconPaths, name) ? name : 'other';
    let tpl = iconCache.get(key);
    if (!tpl) {
      tpl = document.createElementNS(SVG_NS, 'svg');
      tpl.setAttribute('viewBox', '0 0 16 16');
      tpl.setAttribute('aria-hidden', 'true');
      for (const d of iconPaths[key]) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        tpl.append(path);
      }
      iconCache.set(key, tpl);
    }
    const svg = tpl.cloneNode(true);
    svg.setAttribute('class', className);
    svg.dataset.icon = name;
    return svg;
  }

  function copyButton(value, label) {
    const btn = button('copy-btn', t('Copy {0}', label));
    btn.dataset.control = 'copy';
    btn.dataset.copy = value;
    btn.append(icon('copy', 'icon tiny'), element('span', '', t('Copy')));
    return btn;
  }
  function flashCopied(btn) {
    btn.classList.add('copied');
    const span = btn.querySelector('span');
    if (span) span.textContent = t('Copied');
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
      btn.classList.remove('copied');
      if (span) span.textContent = t('Copy');
    }, 1400);
  }
  const inline = value => visible(value).replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  function breakable(className, value) {
    const item = element('span', className);
    inline(value).split('/').forEach((part, at) => {
      if (at) item.append('/', document.createElement('wbr'));
      item.append(part);
    });
    return item;
  }

  const logos = document.querySelector('#logos')?.content;
  function brand(id, mono) {
    const mark = element('span', 'brand brand-' + id);
    mark.setAttribute('aria-hidden', 'true');
    const image = logos?.querySelector('[data-logo="' + id + '"]')?.cloneNode();
    if (image) {
      image.addEventListener('error', () => {
        const source = logos.querySelector('[data-logo="' + id + '"]');
        const next = image.dataset.fallback;
        if (!next) {
          if (source?.getAttribute('src') === image.getAttribute('src')) source.remove();
          mark.replaceChildren(document.createTextNode(mono));
          return;
        }
        for (const each of source ? [image, source] : [image]) {
          delete each.dataset.fallback;
          delete each.dataset.ink;
          each.setAttribute('src', next);
        }
      });
      mark.append(image);
    } else mark.textContent = mono;
    return mark;
  }

  // Fast DOM reconciliation: CSSOM-safe inline style sync, O(1) cursor buckets,
  // zero-array nodeKey, and skip redundant top-down isEqualNode on high-fanout containers.
  const HIGH_FANOUT_CLASSES = new Set([
    'scroll-region', 'session-list', 'child-list', 'provider', 'session',
    'interaction', 'request', 'request-content', 'code-shell', 'payload', 'row-menu',
  ]);
  function firstClass(node) {
    const cls = node.getAttribute('class') || '';
    if (!cls) return '';
    const sp = cls.indexOf(' ');
    return sp < 0 ? cls : cls.slice(0, sp);
  }
  function isHighFanout(node) {
    return node.id === 'sessions' || HIGH_FANOUT_CLASSES.has(firstClass(node));
  }
  function nodeKey(node) {
    if (node.nodeType !== 1) return '#text';
    const cls = firstClass(node);
    // Keep .opener DOM node (brand img + pulsing .node) stable across status transitions.
    if (cls === 'opener') return node.localName + '|opener';
    let key = node.localName + '|' + cls;
    const vKey = node.getAttribute('data-key'); if (vKey) key += '|k:' + vKey;
    const vProv = node.getAttribute('data-provider'); if (vProv) key += '|p:' + vProv;
    const vAct = node.getAttribute('data-action'); if (vAct) key += '|a:' + vAct;
    const vCtrl = node.getAttribute('data-control'); if (vCtrl) key += '|c:' + vCtrl;
    const vIdx = node.getAttribute('data-index'); if (vIdx) key += '|i:' + vIdx;
    const vReq = node.getAttribute('data-request'); if (vReq) key += '|r:' + vReq;
    const vDir = node.getAttribute('data-direction'); if (vDir) key += '|d:' + vDir;
    const vSec = node.getAttribute('data-section'); if (vSec) key += '|s:' + vSec;
    const vCwd = node.getAttribute('data-cwd'); if (vCwd) key += '|w:' + vCwd;
    const vIcon = node.getAttribute('data-icon'); if (vIcon) key += '|ic:' + vIcon;
    const vFilt = node.getAttribute('data-filter'); if (vFilt) key += '|f:' + vFilt;
    const vNot = node.getAttribute('data-notice'); if (vNot) key += '|n:' + vNot;
    const vVal = node.getAttribute('data-value'); if (vVal) key += '|v:' + vVal;
    const vFile = node.getAttribute('data-file'); if (vFile) key += '|fl:' + vFile;
    const vBkt = node.getAttribute('data-bucket');
    if (vBkt) key += '|b:' + vBkt + ':' + (node.getAttribute('data-target') || '');
    return key;
  }
  function syncStyle(current, next) {
    const curStyle = current.style;
    const nextStyle = next.style;
    if (!curStyle || !nextStyle || (!curStyle.length && !nextStyle.length)) return;
    // Fast-path: single inline property (e.g. transform: scaleX(...) on progress fills).
    if (nextStyle.length === 1 && curStyle.length <= 1) {
      const prop = typeof nextStyle.item === 'function' ? nextStyle.item(0) : nextStyle[0];
      const curProp = curStyle.length === 1 ? (typeof curStyle.item === 'function' ? curStyle.item(0) : curStyle[0]) : '';
      if (curProp && curProp !== prop) curStyle.removeProperty(curProp);
      if (prop) {
        const val = nextStyle.getPropertyValue(prop);
        const prio = nextStyle.getPropertyPriority(prop);
        if (curStyle.getPropertyValue(prop) !== val || curStyle.getPropertyPriority(prop) !== prio) {
          curStyle.setProperty(prop, val, prio);
        }
      }
      return;
    }
    const nextProps = new Set();
    for (let i = 0; i < nextStyle.length; i++) {
      const prop = typeof nextStyle.item === 'function' ? nextStyle.item(i) : nextStyle[i];
      if (!prop) continue;
      nextProps.add(prop);
      const val = nextStyle.getPropertyValue(prop);
      const prio = nextStyle.getPropertyPriority(prop);
      if (curStyle.getPropertyValue(prop) !== val || curStyle.getPropertyPriority(prop) !== prio) {
        curStyle.setProperty(prop, val, prio);
      }
    }
    const toRemove = [];
    for (let i = 0; i < curStyle.length; i++) {
      const prop = typeof curStyle.item === 'function' ? curStyle.item(i) : curStyle[i];
      if (prop && !nextProps.has(prop)) toRemove.push(prop);
    }
    for (let i = 0; i < toRemove.length; i++) curStyle.removeProperty(toRemove[i]);
  }
  function reconcile(parent, nextNodes, freeze, quotaOverview = false) {
    const existing = [...parent.childNodes];
    const byKey = new Map();
    for (let i = 0; i < existing.length; i++) {
      const child = existing[i];
      const key = nodeKey(child);
      let bucket = byKey.get(key);
      if (!bucket) {
        bucket = { list: [child], cursor: 0 };
        byKey.set(key, bucket);
      } else {
        bucket.list.push(child);
      }
    }
    let entries = nextNodes.map(next => {
      const bucket = byKey.get(nodeKey(next));
      const current = bucket && bucket.cursor < bucket.list.length ? bucket.list[bucket.cursor++] : undefined;
      return { next, current };
    });
    if (freeze && (parent.matches('.session-list,.child-list') || (parent.matches('.scroll-region') && !quotaOverview))) {
      const positions = new Map();
      for (let i = 0; i < existing.length; i++) positions.set(existing[i], i);
      entries = entries.filter(entry => entry.current || !entry.next.classList?.contains('section-head'));
      entries.sort((a, b) => (positions.get(a.current) ?? Infinity) - (positions.get(b.current) ?? Infinity));
    }
    for (const bucket of byKey.values()) {
      for (let i = bucket.cursor; i < bucket.list.length; i++) bucket.list[i].remove();
    }
    let cursor = parent.firstChild;
    for (let i = 0; i < entries.length; i++) {
      const { next, current } = entries[i];
      const node = current || next;
      if (node !== cursor) {
        if (current && parent.isConnected && parent.moveBefore) parent.moveBefore(node, cursor);
        else parent.insertBefore(node, cursor);
      }
      cursor = node.nextSibling;
      if (!current) continue;
      if (current.tagName === 'INPUT') {
        if ((current !== document.activeElement || next.value === '') && current.value !== next.value) current.value = next.value;
        continue;
      }
      if (current.nodeType === 3) {
        if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
        continue;
      }
      const keepCopied = current.classList?.contains('copied') && Boolean(current._copyTimer);
      const keepNudged = current.classList?.contains('is-nudged');
      if (!keepCopied && !keepNudged && !isHighFanout(current) && current.isEqualNode(next)) continue;
      for (const { name } of [...current.attributes]) {
        if (name === 'style') continue;
        if (!next.hasAttribute(name)) current.removeAttribute(name);
      }
      for (const { name, value } of next.attributes) {
        if (name === 'style') continue;
        if (current.getAttribute(name) !== value) current.setAttribute(name, value);
      }
      if (keepCopied) current.classList.add('copied');
      if (keepNudged) current.classList.add('is-nudged');
      syncStyle(current, next);
      if (keepCopied) continue;
      reconcile(current, [...next.childNodes], freeze, quotaOverview);
    }
  }

  // Motion engine: reduced-motion aware pulses, FLIP updates, and entrance transitions.
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const animations = new Set();
  const moves = new Set();
  const visibleWorkers = new Set();
  const observedWorkers = new Set();
  const pulses = new Map();
  const entered = new WeakSet();
  const workerObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting && observedWorkers.has(entry.target)) visibleWorkers.add(entry.target);
      else visibleWorkers.delete(entry.target);
    }
    syncPulses();
  });
  function allowMotion() {
    return !reducedMotion.matches && !document.hidden && !document.body.classList.contains('vscode-reduce-motion');
  }
  // Compositor-only (transform + opacity) pulse avoids 60fps main-thread style recalc & paint.
  const PULSE_FRAMES = [
    { opacity: 1, transform: 'scale(1)' },
    { opacity: .48, transform: 'scale(1.22)', offset: .45 },
    { opacity: 1, transform: 'scale(1)' },
  ];
  const PULSE_TIMING = { duration: 2600, iterations: Infinity, easing: 'ease-in-out' };
  function syncPulses() {
    const ordered = allowMotion()
      ? [...visibleWorkers].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1)
      : [];
    const live = new Set(ordered.slice(0, 4));
    for (const [node, effect] of pulses) if (!live.has(node)) { effect.cancel(); pulses.delete(node); }
    for (const node of live) if (!pulses.has(node)) {
      pulses.set(node, node.animate(PULSE_FRAMES, PULSE_TIMING));
    }
  }
  function observeWorkers(main) {
    const next = new Set(main.querySelectorAll('.session[data-status="working"] > .title-line .node'));
    for (const old of observedWorkers) if (!next.has(old)) {
      workerObserver.unobserve(old); observedWorkers.delete(old); visibleWorkers.delete(old);
    }
    for (const node of next) if (!observedWorkers.has(node)) { observedWorkers.add(node); workerObserver.observe(node); }
    syncPulses();
  }
  function syncMotionPreference() {
    if (!allowMotion()) for (const effect of animations) effect.cancel();
    syncPulses();
  }
  reducedMotion.addEventListener('change', syncMotionPreference);
  document.addEventListener('visibilitychange', syncMotionPreference);
  new MutationObserver(syncMotionPreference).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  function play(node, frames, timing, moving = false) {
    const effect = node.animate(frames, timing);
    animations.add(effect);
    if (moving) moves.add(effect);
    const cleanup = () => { animations.delete(effect); moves.delete(effect); };
    effect.finished.then(cleanup, cleanup);
  }
  function cancelMoves() {
    for (const effect of moves) effect.cancel();
  }
  function pauseAnimations() {
    for (const effect of animations) if (effect.playState === 'running') effect.pause();
  }
  function resumeAnimations() {
    for (const effect of animations) if (effect.playState === 'paused') effect.play();
  }
  function visiblePositions(scroller) {
    const positions = new Map();
    const boundary = scroller?.getBoundingClientRect();
    if (!boundary) return positions;
    for (const row of scroller.querySelectorAll('.session')) {
      const line = row.querySelector(':scope > .title-line');
      if (!line) continue;
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= boundary.top || rect.top >= boundary.bottom || !rect.height) continue;
      positions.set(row.dataset.key, { row, line, y: rect.top });
    }
    return positions;
  }
  function animateUpdate(before, after, changes, freeze) {
    for (const [key, { row, line, y }] of after) {
      const old = before.get(key);
      const offset = old ? old.y - y : 0;
      if (!freeze && old?.row === row && Math.abs(offset) >= 1 && !row.contains(document.activeElement)) {
        play(row, [{ transform: 'translateY(' + offset + 'px)' }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.22, 1, .36, 1)' }, true);
      }
      const target = line.querySelector('.opener')?.dataset.target;
      if (changes?.has(key) || (target && changes?.has(target))) {
        play(line, [{ backgroundColor: 'color-mix(in srgb, var(--accent) 19%, transparent)' }, { backgroundColor: 'transparent' }],
          { duration: 620, easing: 'ease-out' });
      }
    }
  }
  function enterEffects(main) {
    for (const card of main.querySelectorAll('.request, .row-menu, .search-drawer, .child-list')) {
      if (entered.has(card)) continue;
      entered.add(card);
      if (!allowMotion()) continue;
      const cls = card.classList;
      const frames = cls.contains('request')
        ? [{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }]
        : cls.contains('row-menu')
          ? [{ opacity: 0, transform: 'translateY(-5px)' }, { opacity: 1, transform: 'none' }]
          : [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }];
      const duration = cls.contains('row-menu') ? 200 : cls.contains('request') ? 180 : 170;
      play(card, frames, { duration, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    }
  }
  function transitionKeys(previous, next) {
    const prior = new Map(previous.map(row => [row.key, row]));
    const changed = new Set();
    for (const row of next) {
      const old = prior.get(row.key);
      const newRequest = isWait(row) && (old?.status !== row.status || requestToken(old) !== requestToken(row));
      const newReply = row.replyUnread && row.replyAt && old?.replyAt !== row.replyAt;
      const newError = row.status === 'error' && !row.errorAcked && old?.status !== 'error';
      if (newRequest || newReply || newError) changed.add(row.key);
    }
    return changed;
  }

  root.AgentSessionPanel = {
    providers, shortProviders, statusLabel, sectionName, usageLabel, defaultOrder, specFor, sourceText, navigable,
    dateTimeShort, when, resetLabel, quotaAlertText,
    element, button, actionButton, icon, copyButton, flashCopied, inline, breakable, brand,
    reconcile,
    allowMotion, observeWorkers, animateUpdate, enterEffects, play, visiblePositions, transitionKeys,
    cancelMoves, pauseAnimations, resumeAnimations,
  };
})(globalThis);
