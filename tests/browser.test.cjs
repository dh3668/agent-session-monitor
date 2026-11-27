'use strict';
require('../media/i18n.js').setLocale('ko'); // These cases check the Korean text; i18n.test.cjs covers English.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { execFile } = require('node:child_process');

const { PANEL_SCRIPTS } = require('../src/panel.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT_SOURCES = new Map(
  PANEL_SCRIPTS.map(name => [name, fs.readFileSync(path.join(ROOT, 'media', name), 'utf8')])
);
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'media', 'panel.css'), 'utf8');

function toKebab(prop) {
  return prop.replace(/[A-Z]/g, ch => '-' + ch.toLowerCase());
}
function toCamel(attr) {
  return attr.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

// Strict CSP-enforcing DOM harness that throws on any setAttribute('style', ...) or
// removeAttribute('style') call while faithfully modeling CSSOM CSSStyleDeclaration.
function createStrictCspDom({ platform = 'MacIntel', initialState = {}, onBeforeScript, lang = 'ko' } = {}) {
  let nowPerf = 1000;
  let nowDate = Date.UTC(2026, 10, 25, 12, 0, 0);
  let requestTopOffset = 0;
  const postedMessages = [];
  let savedState = structuredClone(initialState);
  let styleSetAttrAttempts = 0;
  let styleRemoveAttrAttempts = 0;
  const intervals = [];
  const timeouts = [];
  const scrolled = [];
  const windowListeners = new Map();
  const docListeners = new Map();

  function createStyleDeclaration() {
    const map = new Map(); // prop -> { value, priority }
    const backing = {
      get length() { return map.size; },
      item(index) { return [...map.keys()][index] ?? ''; },
      getPropertyValue(prop) { return map.get(String(prop).toLowerCase())?.value ?? ''; },
      getPropertyPriority(prop) { return map.get(String(prop).toLowerCase())?.priority ?? ''; },
      setProperty(prop, value, priority = '') {
        const key = String(prop).toLowerCase();
        if (value === '' || value === null || value === undefined) {
          map.delete(key);
          return;
        }
        map.set(key, { value: String(value), priority: priority || '' });
      },
      removeProperty(prop) {
        const key = String(prop).toLowerCase();
        const prev = map.get(key)?.value ?? '';
        map.delete(key);
        return prev;
      },
      get cssText() {
        return [...map.entries()].map(([k, v]) => k + ': ' + v.value + (v.priority ? ' !' + v.priority : '') + ';').join(' ');
      },
      set cssText(_v) {
        styleSetAttrAttempts++;
        throw new Error('CSP violation: setting style.cssText is blocked under strict style-src');
      },
    };
    return new Proxy(backing, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) return target.item(Number(prop));
        if (prop in target) return Reflect.get(target, prop, receiver);
        if (typeof prop === 'string') return target.getPropertyValue(toKebab(prop));
        return undefined;
      },
      set(target, prop, value, receiver) {
        if (prop in target) return Reflect.set(target, prop, value, receiver);
        if (typeof prop === 'string') {
          target.setProperty(toKebab(prop), value);
          return true;
        }
        return false;
      },
    });
  }

  class FakeNode {
    constructor(nodeType) {
      this.nodeType = nodeType;
      this.parentNode = null;
      this.childNodes = [];
    }
    get firstChild() { return this.childNodes[0] || null; }
    get nextSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx >= 0 ? (this.parentNode.childNodes[idx + 1] || null) : null;
    }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === doc.documentElement || cur === doc.body) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    remove() {
      if (!this.parentNode) return;
      const idx = this.parentNode.childNodes.indexOf(this);
      if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
      this.parentNode = null;
    }
    insertBefore(node, ref) {
      if (node.parentNode) node.remove();
      node.parentNode = this;
      if (!ref) {
        this.childNodes.push(node);
      } else {
        const idx = this.childNodes.indexOf(ref);
        if (idx < 0) this.childNodes.push(node);
        else this.childNodes.splice(idx, 0, node);
      }
      return node;
    }
    append(...nodes) {
      for (const item of nodes) {
        const node = typeof item === 'string' ? new FakeText(item) : item;
        this.insertBefore(node, null);
      }
    }
    replaceChildren(...nodes) {
      for (const child of [...this.childNodes]) child.remove();
      this.append(...nodes);
    }
    compareDocumentPosition(other) {
      const order = [];
      (function walk(n) {
        order.push(n);
        for (const c of n.childNodes) walk(c);
      })(doc.body);
      const a = order.indexOf(this), b = order.indexOf(other);
      if (a < 0 || b < 0) return 1;
      if (a < b) return 4;
      if (a > b) return 2;
      return 0;
    }
  }

  class FakeText extends FakeNode {
    constructor(value) {
      super(3);
      this.nodeValue = String(value);
    }
    get textContent() { return this.nodeValue; }
    set textContent(v) { this.nodeValue = String(v); }
    cloneNode() { return new FakeText(this.nodeValue); }
    isEqualNode(other) { return other && other.nodeType === 3 && other.nodeValue === this.nodeValue; }
  }

  function splitSelectorList(selector) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < selector.length; i++) {
      const ch = selector[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        out.push(selector.slice(start, i).trim());
        start = i + 1;
      }
    }
    out.push(selector.slice(start).trim());
    return out.filter(Boolean);
  }

  function matchCompound(el, compound) {
    if (!el || el.nodeType !== 1) return false;
    let rest = compound.trim();
    if (!rest || rest === '*') return true;
    // Strip :hover / :focus-visible / :not(...)
    const notMatches = [];
    rest = rest.replace(/:not\(([^)]+)\)/g, (_, inner) => { notMatches.push(inner.trim()); return ''; });
    for (const neg of notMatches) {
      if (matchCompound(el, neg)) return false;
    }
    if (rest.includes(':hover')) return false;
    if (rest.includes(':focus-visible')) {
      if (doc.activeElement !== el) return false;
      rest = rest.replace(/:focus-visible/g, '');
    }
    if (rest.includes(':disabled')) {
      if (!el.disabled) return false;
      rest = rest.replace(/:disabled/g, '');
    }
    const attrChecks = [];
    rest = rest.replace(/\[([^\]]+)\]/g, (_, inner) => {
      const eq = inner.indexOf('=');
      if (eq < 0) attrChecks.push([inner.trim(), null]);
      else {
        const k = inner.slice(0, eq).trim();
        let v = inner.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        attrChecks.push([k, v]);
      }
      return '';
    });
    const tokens = rest.match(/(?:^[a-zA-Z0-9_-]+|[#.][a-zA-Z0-9_-]+)/g) || [];
    for (const tok of tokens) {
      if (tok.startsWith('#')) {
        if (el.id !== tok.slice(1)) return false;
      } else if (tok.startsWith('.')) {
        if (!el.classList.contains(tok.slice(1))) return false;
      } else {
        if (el.localName !== tok.toLowerCase()) return false;
      }
    }
    for (const [k, v] of attrChecks) {
      if (!el.hasAttribute(k)) return false;
      if (v !== null && el.getAttribute(k) !== v) return false;
    }
    return true;
  }

  function matchComplex(el, selector, scopeNode) {
    for (const branch of splitSelectorList(selector)) {
      let s = branch;
      let scoped = false;
      if (s.startsWith(':scope')) {
        scoped = true;
        s = s.slice(6).trim();
      }
      const parts = [];
      let cur = '', depth = 0, comb = null;
      const pushPart = () => {
        if (cur.trim()) parts.push({ comb, sel: cur.trim() });
        cur = '';
      };
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(' || ch === '[') { depth++; cur += ch; }
        else if (ch === ')' || ch === ']') { depth--; cur += ch; }
        else if (depth === 0 && ch === '>') { pushPart(); comb = '>'; }
        else if (depth === 0 && /\s/.test(ch)) {
          if (cur.trim()) { pushPart(); comb = ' '; }
        } else cur += ch;
      }
      pushPart();
      if (!parts.length) continue;
      if (!matchCompound(el, parts[parts.length - 1].sel)) continue;
      const checkChain = (node, idx) => {
        if (idx < 0) {
          if (!scoped) return true;
          if (parts[0]?.comb === '>') return node.parentNode === scopeNode;
          let anc = node.parentNode;
          while (anc) { if (anc === scopeNode) return true; anc = anc.parentNode; }
          return false;
        }
        const { comb: c, sel } = parts[idx];
        const neededComb = parts[idx + 1]?.comb;
        if (neededComb === '>') {
          const parent = node.parentNode;
          if (!parent || parent.nodeType !== 1) return false;
          if (idx === 0 && scoped && parent === scopeNode && !sel) return true;
          return matchCompound(parent, sel) && checkChain(parent, idx - 1);
        }
        let anc = node.parentNode;
        while (anc && anc.nodeType === 1) {
          if (matchCompound(anc, sel) && checkChain(anc, idx - 1)) return true;
          if (scoped && anc === scopeNode) break;
          anc = anc.parentNode;
        }
        return false;
      };
      if (parts.length === 1) {
        if (!scoped) return true;
        if (parts[0].comb === '>') { if (el.parentNode === scopeNode) return true; }
        else if (scopeNode && scopeNode.contains(el) && el !== scopeNode) return true;
      } else if (checkChain(el, parts.length - 2)) {
        return true;
      }
    }
    return false;
  }

  class FakeElement extends FakeNode {
    constructor(tagName, ns = null) {
      super(1);
      this.localName = String(tagName).toLowerCase();
      this.tagName = ns ? String(tagName) : this.localName.toUpperCase();
      this._attrs = new Map();
      this._listeners = new Map();
      this.style = createStyleDeclaration();
      this.scrollTop = 0;
      this.scrollHeight = 100;
      this.clientHeight = 100;
      this.value = '';
      this._disabled = false;
      this._hidden = false;
      this.offsetParent = {};
      const self = this;
      this.classList = {
        _list() { return (self._attrs.get('class') || '').trim().split(/\s+/).filter(Boolean); },
        _save(arr) {
          if (arr.length) self._attrs.set('class', arr.join(' '));
          else self._attrs.delete('class');
        },
        add(...names) {
          const set = new Set(this._list());
          for (const n of names) if (n) set.add(n);
          this._save([...set]);
        },
        remove(...names) {
          const set = new Set(this._list());
          for (const n of names) set.delete(n);
          this._save([...set]);
        },
        toggle(name, force) {
          const has = this.contains(name);
          const next = force === undefined ? !has : Boolean(force);
          if (next) this.add(name); else this.remove(name);
          return next;
        },
        contains(name) { return this._list().includes(name); },
        get 0() { return this._list()[0]; },
      };
      this.dataset = new Proxy({}, {
        get(_, prop) {
          if (typeof prop !== 'string') return undefined;
          const attr = 'data-' + toKebab(prop);
          return self._attrs.has(attr) ? self._attrs.get(attr) : undefined;
        },
        set(_, prop, val) {
          self._attrs.set('data-' + toKebab(String(prop)), String(val));
          return true;
        },
        deleteProperty(_, prop) {
          self._attrs.delete('data-' + toKebab(String(prop)));
          return true;
        },
      });
    }
    get id() { return this._attrs.get('id') || ''; }
    set id(v) { this._attrs.set('id', String(v)); }
    get className() { return this._attrs.get('class') || ''; }
    set className(v) {
      if (v) this._attrs.set('class', String(v));
      else this._attrs.delete('class');
    }
    get title() { return this._attrs.get('title') || ''; }
    set title(v) { this._attrs.set('title', String(v)); }
    get disabled() { return this._disabled; }
    set disabled(v) {
      this._disabled = Boolean(v);
      if (this._disabled) this._attrs.set('disabled', '');
      else this._attrs.delete('disabled');
    }
    get hidden() { return this._hidden; }
    set hidden(v) {
      this._hidden = Boolean(v);
      if (this._hidden) this._attrs.set('hidden', '');
      else this._attrs.delete('hidden');
    }
    get tabIndex() { return Number(this._attrs.get('tabindex') ?? -1); }
    set tabIndex(v) { this._attrs.set('tabindex', String(v)); }
    get attributes() {
      const list = [];
      for (const [name, value] of this._attrs) list.push({ name, value });
      const cssText = this.style.cssText;
      if (cssText) list.push({ name: 'style', value: cssText });
      return list;
    }
    hasAttribute(name) {
      if (String(name).toLowerCase() === 'style') return this.style.length > 0;
      return this._attrs.has(String(name));
    }
    getAttribute(name) {
      if (String(name).toLowerCase() === 'style') return this.style.length > 0 ? this.style.cssText : null;
      return this._attrs.has(String(name)) ? this._attrs.get(String(name)) : null;
    }
    setAttribute(name, value) {
      if (String(name).toLowerCase() === 'style') {
        styleSetAttrAttempts++;
        throw new Error('CSP violation: setAttribute("style", ...) is blocked under strict style-src');
      }
      const key = String(name);
      const val = String(value);
      this._attrs.set(key, val);
      if (key === 'disabled') this._disabled = true;
      if (key === 'hidden') this._hidden = true;
    }
    removeAttribute(name) {
      if (String(name).toLowerCase() === 'style') {
        styleRemoveAttrAttempts++;
        throw new Error('CSP violation: removeAttribute("style") is blocked under strict style-src');
      }
      const key = String(name);
      this._attrs.delete(key);
      if (key === 'disabled') this._disabled = false;
      if (key === 'hidden') this._hidden = false;
    }
    get textContent() {
      return this.childNodes.map(c => c.textContent).join('');
    }
    set textContent(val) {
      for (const c of [...this.childNodes]) c.remove();
      if (val !== '' && val !== null && val !== undefined) this.append(new FakeText(val));
    }
    matches(selector) { return matchComplex(this, selector, null); }
    closest(selector) {
      let cur = this;
      while (cur && cur.nodeType === 1) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentNode;
      }
      return null;
    }
    querySelectorAll(selector) {
      const found = [];
      const self = this;
      (function walk(node) {
        for (const c of node.childNodes) {
          if (c.nodeType === 1) {
            if (matchComplex(c, selector, self)) found.push(c);
            walk(c);
          }
        }
      })(this);
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    cloneNode(deep = false) {
      const copy = new FakeElement(this.localName);
      for (const [k, v] of this._attrs) copy._attrs.set(k, v);
      for (let i = 0; i < this.style.length; i++) {
        const p = this.style.item(i);
        copy.style.setProperty(p, this.style.getPropertyValue(p), this.style.getPropertyPriority(p));
      }
      if (deep) for (const c of this.childNodes) copy.append(c.cloneNode(true));
      return copy;
    }
    isEqualNode(other) {
      if (!other || other.nodeType !== 1 || other.localName !== this.localName) return false;
      const a = this.attributes, b = other.attributes;
      if (a.length !== b.length) return false;
      const mapA = new Map(a.map(x => [x.name, x.value]));
      for (const { name, value } of b) if (mapA.get(name) !== value) return false;
      if (this.childNodes.length !== other.childNodes.length) return false;
      for (let i = 0; i < this.childNodes.length; i++) {
        if (!this.childNodes[i].isEqualNode(other.childNodes[i])) return false;
      }
      return true;
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    dispatchEvent(event) {
      event.target = event.target || this;
      event.defaultPrevented = false;
      event.preventDefault = () => { event.defaultPrevented = true; };
      let cur = this;
      while (cur) {
        event.currentTarget = cur;
        const handlers = cur._listeners?.get(event.type) || [];
        for (const fn of [...handlers]) fn(event);
        if (!event.bubbles) break;
        cur = cur.parentNode;
      }
      return !event.defaultPrevented;
    }
    click(extra = {}) {
      if (this.disabled) return;
      this.dispatchEvent({ type: 'click', bubbles: true, detail: 1, ...extra });
    }
    focus() { doc.activeElement = this; }
    scrollIntoView(opts) { scrolled.push({ el: this, opts }); }
    getBoundingClientRect() {
      if (this.classList.contains('scroll-region')) return { top: 40, left: 0, width: 300, height: 600, right: 300, bottom: 640 };
      if (this.classList.contains('request')) return { top: 100 + requestTopOffset, left: 10, width: 280, height: 220, right: 290, bottom: 320 + requestTopOffset };
      if (this.classList.contains('request-content') || this.classList.contains('question-group') || this.classList.contains('question')) {
        return { top: 120 + requestTopOffset, left: 16, width: 268, height: 80, right: 284, bottom: 200 + requestTopOffset };
      }
      const req = this.closest('.request');
      if (req && this.localName === 'button') {
        const idx = Math.max(0, req.querySelectorAll('button').indexOf(this));
        const top = 210 + requestTopOffset + idx * 32;
        return { top, left: 16, width: 120, height: 28, right: 136, bottom: top + 28 };
      }
      return { top: 40, left: 10, width: 280, height: 32, right: 290, bottom: 72 };
    }
    animate() {
      return { playState: 'finished', cancel() {}, pause() {}, play() {}, finished: Promise.resolve() };
    }
  }

  const doc = {
    documentElement: new FakeElement('html'),
    body: new FakeElement('body'),
    activeElement: null,
    hidden: false,
    get visibilityState() { return this.hidden ? 'hidden' : 'visible'; },
    createElement(tag) {
      const el = new FakeElement(tag);
      if (String(tag).toLowerCase() === 'template') el.content = new FakeElement('fragment');
      return el;
    },
    createElementNS(ns, tag) { return new FakeElement(tag, ns); },
    createTextNode(text) { return new FakeText(text); },
    querySelector(sel) { return doc.body.querySelector(sel); },
    querySelectorAll(sel) { return doc.body.querySelectorAll(sel); },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    elementFromPoint(x, y) {
      const hit = el => {
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      };
      const req = doc.body.querySelector('.request');
      if (req) {
        for (const btn of req.querySelectorAll('button')) if (hit(btn)) return btn;
        for (const sub of req.querySelectorAll('.request-content, .question-group')) if (hit(sub)) return sub;
        if (hit(req)) return req;
      }
      return doc.body;
    },
  };
  doc.documentElement.append(doc.body);
  doc.documentElement.lang = lang;

  const logosTpl = doc.createElement('template');
  logosTpl.id = 'logos';
  const main = doc.createElement('main');
  main.id = 'sessions';
  doc.body.append(logosTpl, main);

  const FakeDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : [nowDate])); }
    static now() { return nowDate; }
  };

  const sandbox = {
    console,
    Date: FakeDate,
    Intl,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    WeakSet,
    WeakMap,
    RegExp,
    JSON,
    Promise,
    Uint16Array,
    Error,
    queueMicrotask,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    document: doc,
    navigator: { platform, userAgent: platform, clipboard: { writeText: () => Promise.resolve() } },
    performance: { now: () => nowPerf },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    getComputedStyle: () => ({ backgroundColor: 'rgb(94, 169, 255)' }),
    IntersectionObserver: class { observe() {} unobserve() {} },
    ResizeObserver: class { observe() {} },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: fn => fn(),
    setInterval(fn, ms) { const id = intervals.length + 1; intervals.push({ id, fn, ms, active: true }); return id; },
    clearInterval(id) { const item = intervals.find(t => t.id === id); if (item) item.active = false; },
    setTimeout(fn, ms) { const id = timeouts.length + 1; timeouts.push({ id, fn, ms, active: true }); return id; },
    clearTimeout(id) { const item = timeouts.find(t => t.id === id); if (item) item.active = false; },
    acquireVsCodeApi: () => ({
      getState: () => structuredClone(savedState),
      setState: next => { savedState = JSON.parse(JSON.stringify(next)); },
      postMessage: msg => postedMessages.push(JSON.parse(JSON.stringify(msg))),
    }),
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const name of PANEL_SCRIPTS) {
    if (onBeforeScript) onBeforeScript(name, sandbox);
    vm.runInContext(SCRIPT_SOURCES.get(name), sandbox, { filename: 'media/' + name });
  }

  function postFromHost(data) {
    for (const fn of windowListeners.get('message') || []) fn({ data });
  }
  function setVisibility(hidden) {
    doc.hidden = Boolean(hidden);
    for (const fn of docListeners.get('visibilitychange') || []) fn({ type: 'visibilitychange' });
  }
  function advancePerf(ms) { nowPerf += ms; }
  function advanceDate(ms) { nowDate += ms; }
  function tickIntervals() { for (const t of intervals) if (t.active) t.fn(); }
  function flushTimeouts() {
    for (const t of [...timeouts]) {
      if (!t.active) continue;
      t.active = false;
      t.fn();
    }
  }
  function dispatchWindow(event) {
    for (const fn of windowListeners.get(event.type) || []) fn(event);
  }
  function setRequestTopOffset(px) { requestTopOffset = px; }

  return {
    doc, main, sandbox, postedMessages, scrolled, postFromHost, setVisibility, advancePerf, advanceDate, tickIntervals, flushTimeouts, dispatchWindow, setRequestTopOffset,
    getActiveIntervals: () => intervals.filter(t => t.active).map(t => t.ms),
    getCspAttempts: () => ({ set: styleSetAttrAttempts, remove: styleRemoveAttrAttempts }),
    getSavedState: () => savedState,
  };
}

function baseState(overrides = {}) {
  return {
    type: 'state',
    hasWorkspace: true,
    isRemoteWorkspace: false,
    scanError: '',
    workspaceLabel: 'demo',
    sessions: [],
    usage: {},
    quotas: {
      claude: { status: 'ready', plan: 'Max', windows: [{ name: '', period: 300, kind: 'used', percent: 30 }] },
      codex: { status: 'ready', plan: 'Pro', windows: [{ name: '', period: 300, kind: 'used', percent: 40 }] },
      agy: { status: 'ready', plan: 'Ultra', windows: [{ name: 'Gemini Models', period: 300, kind: 'remaining', percent: 80 }] },
    },
    connections: { claude: 'connected', codex: 'connected', agy: 'connected' },
    elsewhere: [],
    preferences: { sort: 'priority', providerOrder: ['claude', 'codex', 'agy'], attentionOnly: false, hideCompleted: false },
    hiddenCompleted: 0,
    attentionCount: 0,
    unreadCount: 0,
    ...overrides,
  };
}

test('strict CSP: progress bars, plan bar, quota tiles and countdown update via CSSOM without setAttribute("style")', () => {
  const env = createStrictCspDom();
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  const working = {
    provider: 'claude', key: 'claude/work1', status: 'working', title: '결제 로직 정리', updatedAt: now, workSince: now - 60000,
    progress: { done: 1, total: 4 },
    plan: [
      { text: '분석', status: 'completed' },
      { text: '구현', status: 'in_progress' },
      { text: '테스트', status: 'pending' },
      { text: '검증', status: 'pending' },
    ],
  };
  const waiting = {
    provider: 'claude', key: 'claude/wait1', status: 'approval', title: '명령 실행 승인', updatedAt: now, waitSince: now,
    action: { kind: 'approval', token: 'tok-1', tool: 'Bash', detail: '{"command":"npm test"}', cwd: '/demo', allow: true, deny: true, expiresAt: now + 45000 },
  };
  env.postFromHost(baseState({ sessions: [waiting, working], attentionCount: 1 }));

  // Open Work Story Inspector on working session so .plan-progress-fill renders too.
  const workRow = env.main.querySelector('[data-key="claude/work1"]');
  workRow.querySelector('.more').click();

  assert.equal(env.main.querySelector('[data-key="claude/work1"] .mini-progress-fill').style.transform, 'scaleX(0.25)');
  assert.equal(env.main.querySelector('[data-key="claude/work1"] .plan-progress-fill').style.transform, 'scaleX(0.25)');
  assert.equal(env.main.querySelector('.quota-tile[data-provider="claude"] .tile-bar-fill').style.transform, 'scaleX(0.7)');
  const countdownBefore = env.main.querySelector('.countdown-fill').style.transform;
  assert.equal(countdownBefore, 'scaleX(1)');

  // Re-render with updated progress, plan, quota, and elapsed countdown.
  env.advanceDate(15000);
  env.postFromHost(baseState({
    sessions: [
      waiting,
      {
        ...working,
        progress: { done: 3, total: 4 },
        plan: [
          { text: '분석', status: 'completed' },
          { text: '구현', status: 'completed' },
          { text: '테스트', status: 'completed' },
          { text: '검증', status: 'in_progress' },
        ],
      },
    ],
    quotas: {
      claude: { status: 'ready', plan: 'Max', windows: [{ name: '', period: 300, kind: 'used', percent: 80 }] },
      codex: { status: 'ready', plan: 'Pro', windows: [{ name: '', period: 300, kind: 'used', percent: 40 }] },
      agy: { status: 'ready', plan: 'Ultra', windows: [{ name: 'Gemini Models', period: 300, kind: 'remaining', percent: 80 }] },
    },
    attentionCount: 1,
  }));

  assert.equal(env.main.querySelector('[data-key="claude/work1"] .mini-progress-fill').style.transform, 'scaleX(0.75)');
  assert.equal(env.main.querySelector('[data-key="claude/work1"] .plan-progress-fill').style.transform, 'scaleX(0.75)');
  assert.equal(env.main.querySelector('.quota-tile[data-provider="claude"] .tile-bar-fill').style.transform, 'scaleX(0.2)');
  assert.notEqual(env.main.querySelector('.countdown-fill').style.transform, countdownBefore);
  assert.deepEqual(env.getCspAttempts(), { set: 0, remove: 0 });
});

test('initial skeleton loader transitions cleanly to remote-workspace empty state and scan error retry banner', () => {
  const env = createStrictCspDom();
  // Before first host state: shows skeleton, NOT "작업 폴더를 열어 주세요".
  assert.equal(env.main.querySelectorAll('.skeleton-row').length, 3);
  assert.equal(env.main.textContent.includes('작업 폴더를 열어 주세요'), false);

  // Remote workspace empty state.
  env.postFromHost(baseState({ hasWorkspace: false, isRemoteWorkspace: true, sessions: [] }));
  assert.equal(env.main.querySelectorAll('.skeleton-row').length, 0);
  assert.ok(env.main.textContent.includes('로컬 작업 폴더에서 사용할 수 있습니다'));
  assert.ok(env.main.textContent.includes('원격 창에서는 로컬 에이전트 세션을 모니터링할 수 없습니다.'));

  // Scan error banner + 다시 시도 triggers { action: 'refresh' }.
  env.postFromHost(baseState({ hasWorkspace: true, scanError: '세션 목록을 읽지 못했습니다.', sessions: [] }));
  const errBanner = env.main.querySelector('.connect.is-error');
  assert.ok(errBanner);
  assert.ok(errBanner.textContent.includes('세션 목록을 읽지 못했습니다.'));
  errBanner.querySelector('button[data-action="refresh"]').click();
  assert.deepEqual(env.postedMessages.at(-1), { action: 'refresh' });
});

test('Korean IME KeyI and Shift+I toggle Work Story Inspector while modifier chords do not', () => {
  const env = createStrictCspDom();
  const row = { provider: 'claude', key: 'claude/s1', status: 'working', title: '작업 1', updatedAt: Date.now(), prompt: '테스트' };
  env.postFromHost(baseState({ sessions: [row] }));
  const opener = env.main.querySelector('[data-key="claude/s1"] .opener');
  opener.focus();

  // Korean IME sends key='ㅑ' with code='KeyI'.
  opener.dispatchEvent({ type: 'keydown', bubbles: true, code: 'KeyI', key: 'ㅑ', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false });
  assert.ok(env.main.querySelector('[data-key="claude/s1"] .row-menu'), 'KeyI in Korean IME opens story inspector');

  // Shift+I still toggles inspector closed.
  opener.dispatchEvent({ type: 'keydown', bubbles: true, code: 'KeyI', key: 'I', shiftKey: true, metaKey: false, ctrlKey: false, altKey: false });
  assert.equal(env.main.querySelector('[data-key="claude/s1"] .row-menu'), null, 'Shift+I closes story inspector');

  // Cmd+I must NOT hijack shortcut.
  opener.dispatchEvent({ type: 'keydown', bubbles: true, code: 'KeyI', key: 'i', shiftKey: false, metaKey: true, ctrlKey: false, altKey: false });
  assert.equal(env.main.querySelector('[data-key="claude/s1"] .row-menu'), null);
});

test('decision keyboard shortcuts require exact platform chord (ignoring plain Cmd+Backspace on macOS)', () => {
  const macEnv = createStrictCspDom({ platform: 'MacIntel' });
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  const approval = {
    provider: 'claude', key: 'claude/a1', status: 'approval', title: '승인 테스트', updatedAt: now, waitSince: now,
    action: { kind: 'approval', token: 'tok-a1', tool: 'Bash', detail: '{"command":"ls"}', cwd: '/demo', allow: true, deny: true, expiresAt: now + 45000 },
  };
  macEnv.postFromHost(baseState({ sessions: [approval], attentionCount: 1 }));
  macEnv.advancePerf(1500); // past anti-misclick steady guard
  const opener = macEnv.main.querySelector('[data-key="claude/a1"] .opener');

  // Plain Cmd+Backspace MUST be ignored.
  opener.dispatchEvent({ type: 'keydown', bubbles: true, key: 'Backspace', metaKey: true, ctrlKey: false, altKey: false });
  assert.equal(macEnv.postedMessages.some(m => m.action === 'deny'), false, 'plain Cmd+Backspace must not deny');

  // Exact Ctrl+Cmd+Enter approves.
  opener.dispatchEvent({ type: 'keydown', bubbles: true, key: 'Enter', metaKey: true, ctrlKey: true, altKey: false });
  assert.deepEqual(macEnv.postedMessages.at(-1), { action: 'approve', provider: 'claude', key: 'claude/a1', token: 'tok-a1' });

  // Non-mac requires Ctrl+Alt+Enter and ignores plain Ctrl+Enter.
  const winEnv = createStrictCspDom({ platform: 'Win32' });
  winEnv.postFromHost(baseState({ sessions: [approval], attentionCount: 1 }));
  winEnv.advancePerf(1500);
  const winOpener = winEnv.main.querySelector('[data-key="claude/a1"] .opener');
  winOpener.dispatchEvent({ type: 'keydown', bubbles: true, key: 'Enter', metaKey: false, ctrlKey: true, altKey: false });
  assert.equal(winEnv.postedMessages.some(m => m.action === 'approve'), false);
  winOpener.dispatchEvent({ type: 'keydown', bubbles: true, key: 'Enter', metaKey: false, ctrlKey: true, altKey: true });
  assert.deepEqual(winEnv.postedMessages.at(-1), { action: 'approve', provider: 'claude', key: 'claude/a1', token: 'tok-a1' });
});

test('filter sync reports filter changes and surfaces hidden waiting session banner with one-click reveal', () => {
  const env = createStrictCspDom();
  const readyMsg = env.postedMessages.find(m => m.type === 'ready');
  assert.deepEqual(readyMsg, { type: 'ready', view: 'sessions', lens: 'all', providerFilter: 'all', hasSearch: false });

  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  const claudeWait = {
    provider: 'claude', key: 'claude/w1', status: 'approval', title: 'Claude 승인', updatedAt: now, waitSince: now,
    action: { kind: 'approval', token: 'tok-w1', tool: 'Bash', detail: '{"command":"npm test"}', cwd: '/demo', allow: true, deny: true },
  };
  const codexWork = {
    provider: 'codex', key: 'codex/w2', status: 'working', title: 'Codex 작업', updatedAt: now, workSince: now,
  };
  env.postFromHost(baseState({ sessions: [claudeWait, codexWork], attentionCount: 1 }));
  assert.deepEqual(env.postedMessages.findLast(m => m.type === 'request'), { type: 'request', kind: 'approval', key: 'claude/w1', visible: true });

  // Switch to working lens -> hides claudeWait, emits filter message, shows banner.
  env.main.querySelector('.lens-btn[data-value="working"]').click();
  assert.deepEqual(env.postedMessages.findLast(m => m.type === 'filter'), { type: 'filter', lens: 'working', providerFilter: 'all', hasSearch: false });
  const alertBanner = env.main.querySelector('.filter-alert');
  assert.ok(alertBanner, 'hidden waiting banner renders when filter hides a waiting session');
  assert.ok(alertBanner.textContent.includes('필터 밖에서 확인 필요 1건'));

  // Clicking "보기" clears filter, reports filter reset, and opens the hidden request.
  alertBanner.querySelector('.filter-alert-btn').click();
  assert.deepEqual(env.postedMessages.findLast(m => m.type === 'filter'), { type: 'filter', lens: 'all', providerFilter: 'all', hasSearch: false });
  assert.equal(env.main.querySelector('.filter-alert'), null);
  assert.equal(env.main.querySelector('.request')?.dataset.request, 'tok-w1');
});

test('parallel waiting queue stepper switches smoothly between multiple waiting requests', () => {
  const env = createStrictCspDom();
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  const q1 = {
    provider: 'claude', key: 'claude/q1', status: 'input', title: '질문 세션', updatedAt: now, waitSince: now - 5000,
    action: { kind: 'question', token: 'tok-q1', tool: 'AskUserQuestion', questions: [{ question: '방식 선택?', header: '', multiSelect: false, choices: [{ label: 'A', description: '' }] }] },
  };
  const a2 = {
    provider: 'claude', key: 'claude/a2', status: 'approval', title: '승인 세션', updatedAt: now, waitSince: now,
    action: { kind: 'approval', token: 'tok-a2', tool: 'Bash', detail: '{"command":"pnpm build"}', cwd: '/demo', allow: true, deny: true },
  };
  env.postFromHost(baseState({ sessions: [a2, q1], attentionCount: 2 }));

  assert.equal(env.main.querySelector('.request').dataset.request, 'tok-q1');
  assert.equal(env.main.querySelector('.queue-counter').textContent, '1 / 2');

  env.main.querySelector('.queue-step[data-direction="next"]').click();
  assert.equal(env.main.querySelector('.request').dataset.request, 'tok-a2');
  assert.equal(env.main.querySelector('.queue-counter').textContent, '2 / 2');
  assert.deepEqual(env.postedMessages.findLast(m => m.type === 'request'), { type: 'request', kind: 'approval', key: 'claude/a2', visible: true });

  env.main.querySelector('.queue-step[data-direction="prev"]').click();
  assert.equal(env.main.querySelector('.request').dataset.request, 'tok-q1');
  assert.equal(env.main.querySelector('.queue-counter').textContent, '1 / 2');
});

test('revealSession resets filters, expands subagent tree, opens inspector; truncated callout, + button and accessibility work', () => {
  const env = createStrictCspDom();
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  const parent = { provider: 'claude', key: 'claude/p1', status: 'working', title: '부모 작업', updatedAt: now, workSince: now };
  const child = { provider: 'claude', key: 'claude/c1', isSubagent: true, parentKey: 'claude/p1', status: 'done', title: '하위 탐색', updatedAt: now, prompt: '서브에이전트 조사' };
  const truncatedWait = {
    provider: 'codex', key: 'codex/t1', status: 'approval', title: '큰 패치 승인', updatedAt: now, waitSince: now,
    preview: { tool: 'Bash', detail: JSON.stringify({ _truncated: { totalBytes: 24576, shownBytes: 10240 }, command: 'git diff' }) },
  };
  env.postFromHost(baseState({ sessions: [truncatedWait, parent, child], attentionCount: 1 }));

  // Truncated preview callout renders cleanly and hides raw _truncated field.
  const truncCallout = env.main.querySelector('.request-truncated');
  assert.ok(truncCallout);
  assert.ok(truncCallout.textContent.includes('요청 내용이 커서 앞부분만 표시합니다 (10KB / 24KB) · 전체 내용을 채팅에서 확인 후 처리하세요'));
  assert.equal(env.main.textContent.includes('_truncated'), false);

  // Command bar no longer duplicates VS Code view/title '+' button, giving .lens-track full room.
  assert.equal(env.main.querySelector('.quick-start-btn'), null);

  // Section headings carry role="heading" aria-level="2".
  const headings = env.main.querySelectorAll('.section-head [role="heading"][aria-level="2"]');
  assert.ok(headings.length >= 2);

  // Apply filter hiding claude/c1, then invoke revealSession('claude/c1').
  env.main.querySelector('.lens-btn[data-value="attention"]').click();
  assert.equal(env.main.querySelector('[data-key="claude/c1"]'), null);
  env.postFromHost({ type: 'revealSession', key: 'claude/c1' });
  assert.ok(env.main.querySelector('[data-key="claude/c1"] .row-menu'), 'revealSession clears filter, expands parent, and opens story inspector');

  // aria-live="polite" status announcer speaks newly arrived unread replies and errors.
  const live = env.doc.body.querySelector('.sr-only[aria-live="polite"]');
  assert.ok(live);
  env.postFromHost(baseState({
    sessions: [
      truncatedWait,
      { ...parent, status: 'done', replyUnread: true, replyAt: now + 5000, reply: '완료' },
      child,
    ],
    unreadCount: 1,
    attentionCount: 1,
  }));
  assert.ok(live.textContent.includes('부모 작업 · 새 응답 도착'));
});

test('provider parity UI: permission shield, colorized apply_patch diff, read-only question previews, question header pill, ExitPlanMode and quiet wait banner', () => {
  const env = createStrictCspDom();
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);

  // 1. Inline Claude AskUserQuestion shows .question-header pill above .question.
  const claudeAsk = {
    provider: 'claude', key: 'claude/q-hdr', status: 'input', title: '배치 선택', updatedAt: now, waitSince: now - 50000,
    action: {
      kind: 'question', token: 'tok-hdr', tool: 'AskUserQuestion',
      questions: [{ question: '어디에 둘까요?', header: '레이아웃', multiSelect: false, choices: [{ label: '왼쪽', description: '기본' }] }],
    },
  };
  // 2. Codex request_user_input read-only question preview.
  const codexInput = {
    provider: 'codex', key: 'codex/q1', status: 'input', title: 'Codex 질문', updatedAt: now, waitSince: now - 40000,
    preview: {
      tool: 'request_user_input',
      detail: JSON.stringify({
        questions: [{ id: 'a', header: '인증 방식', question: 'OAuth를 활성화할까요?', options: [{ label: '예', description: 'PKCE 적용' }], isOther: true }],
      }),
    },
  };
  // 3. Antigravity ask_question read-only multi-select preview.
  const agyInput = {
    provider: 'agy', key: 'agy/q1', status: 'input', title: 'AGY 질문', updatedAt: now, waitSince: now - 30000,
    preview: {
      tool: 'ask_question',
      detail: JSON.stringify({
        questions: [{ question: '적용할 환경을 고르세요', options: ['개발', '스테이징'], is_multi_select: true }],
      }),
    },
  };
  // 4. Codex apply_patch colorized diff with Move to and stats.
  const codexPatch = {
    provider: 'codex', key: 'codex/p1', status: 'approval', title: '패치 적용', updatedAt: now, waitSince: now - 20000,
    preview: {
      tool: 'apply_patch',
      detail: JSON.stringify({
        command: '*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@ fn()\n context\n-oldLine\n+newLine1\n+newLine2\n*** End Patch',
      }),
    },
  };
  // 5. Codex request_permissions with shield icon.
  const codexPerm = {
    provider: 'codex', key: 'codex/perm1', status: 'approval', title: '권한 요청 세션', updatedAt: now, waitSince: now - 10000,
    preview: {
      tool: 'request_permissions',
      detail: JSON.stringify({ reason: '테스트 실행을 위한 네트워크 접근', permissions: { network: { enabled: true } } }),
    },
  };
  // 6. Read-only ExitPlanMode with empty detail shows concise .request-note & '계획 승인' headline.
  const exitPlanEmpty = {
    provider: 'claude', key: 'claude/exit1', status: 'approval', title: '계획 검토', updatedAt: now, waitSince: now - 5000,
    preview: { tool: 'ExitPlanMode', detail: '{}' },
  };
  // 7. Quiet waiting row shows accurate wait-stopped banner in Work Story Inspector.
  const quietApproval = {
    provider: 'claude', key: 'claude/quiet-wait', status: 'approval', quiet: true, title: '거절된 요청', updatedAt: now, signalAt: now - 60000,
  };

  env.postFromHost(baseState({
    sessions: [claudeAsk, codexInput, agyInput, codexPatch, codexPerm, exitPlanEmpty, quietApproval],
    attentionCount: 6,
  }));

  // 1. Inline question header pill.
  assert.equal(env.main.querySelector('[data-key="claude/q-hdr"] .question-header')?.textContent, '레이아웃');

  // 2. Step to Codex request_user_input preview.
  env.main.querySelector('.queue-step[data-direction="next"]').click();
  assert.equal(env.main.querySelector('[data-key="codex/q1"] .subtitle')?.textContent, '질문');
  assert.equal(env.main.querySelector('[data-key="codex/q1"] .question-header')?.textContent, '인증 방식');
  assert.ok(env.main.querySelector('[data-key="codex/q1"] .request.is-preview .preview-banner')?.textContent.includes('읽기 전용 미리보기 · Codex에서 직접 선택'));
  assert.ok(env.main.querySelector('[data-key="codex/q1"] .choices.readonly .choice-static'));
  assert.equal(env.main.querySelector('[data-key="codex/q1"] .choice-static')?.classList.contains('choice'), false);
  assert.equal(env.main.querySelector('[data-key="codex/q1"] .choice-static .choice-index')?.textContent, '1.');
  assert.equal(env.main.querySelector('[data-key="codex/q1"] .preview-cta')?.dataset.action, 'review');
  assert.ok(env.main.querySelector('[data-key="codex/q1"] .preview-cta')?.textContent.includes('Codex 채팅에서 답하기'));
  assert.ok(env.main.querySelector('[data-key="codex/q1"] .question-note')?.textContent.includes('직접 입력 가능'));

  // 3. Step to Antigravity ask_question preview.
  env.main.querySelector('.queue-step[data-direction="next"]').click();
  assert.equal(env.main.querySelector('[data-key="agy/q1"] .subtitle')?.textContent, '질문');
  assert.equal(env.main.querySelectorAll('[data-key="agy/q1"] .choices.readonly .choice-static').length, 2);
  assert.ok(env.main.querySelector('[data-key="agy/q1"] .preview-banner')?.textContent.includes('읽기 전용 미리보기 · Antigravity에서 직접 선택'));
  assert.ok(env.main.querySelector('[data-key="agy/q1"] .preview-cta')?.textContent.includes('Antigravity 채팅에서 답하기'));
  assert.ok(env.main.querySelector('[data-key="agy/q1"] .question-note')?.textContent.includes('여러 개 고를 수 있습니다'));

  // 4. Step to Codex apply_patch colorized diff.
  env.main.querySelector('.queue-step[data-direction="next"]').click();
  const patchPathBtn = env.main.querySelector('[data-key="codex/p1"] .request-path-btn');
  assert.equal(patchPathBtn?.dataset.file, 'src/new.ts');
  assert.equal(env.main.querySelector('[data-key="codex/p1"] .diff-add')?.textContent, '+2');
  assert.equal(env.main.querySelector('[data-key="codex/p1"] .diff-del')?.textContent, '−1');
  assert.equal(env.main.querySelector('[data-key="codex/p1"] .change .hunk')?.textContent, '@@ fn()');
  assert.equal(env.main.querySelectorAll('[data-key="codex/p1"] .change .added').length, 2);
  assert.equal(env.main.querySelectorAll('[data-key="codex/p1"] .change .removed').length, 1);

  // 5. Step to Codex request_permissions with shield icon.
  env.main.querySelector('.queue-step[data-direction="next"]').click();
  assert.equal(env.main.querySelector('[data-key="codex/perm1"] .subline-icon')?.dataset.icon, 'permission');
  assert.equal(env.main.querySelector('[data-key="codex/perm1"] .request-note')?.textContent, '테스트 실행을 위한 네트워크 접근');
  assert.ok(env.main.querySelector('[data-key="codex/perm1"] .request-fields')?.textContent.includes('네트워크 · 허용'));

  // 6. Step to empty ExitPlanMode preview.
  env.main.querySelector('.queue-step[data-direction="next"]').click();
  assert.equal(env.main.querySelector('[data-key="claude/exit1"] .subtitle')?.textContent, '계획 승인');
  assert.ok(env.main.querySelector('[data-key="claude/exit1"] .request-note')?.textContent.includes('채팅에서 확인하고 승인해 주세요'));

  // 7. Quiet waiting row inspector banner (NOT the 15-minute working copy).
  env.main.querySelector('[data-key="claude/quiet-wait"] .more').click();
  const quietBanner = env.main.querySelector('[data-key="claude/quiet-wait"] .story-banner.is-quiet');
  assert.ok(quietBanner?.textContent.includes('요청이 거절되었거나 응답이 없어 대기 상태가 멈췄습니다.'));
  assert.equal(quietBanner?.textContent.includes('15분 이상'), false);
  assert.deepEqual(env.getCspAttempts(), { set: 0, remove: 0 });
});

test('adaptive countdown timer activates only when expiresAt is rendered, MCP read steps stay non-clickable, and camelCase filePath renders as path block', () => {
  const env = createStrictCspDom();
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  // Idle boot has only the 15s minute-resolution timer, not the 1s countdown timer.
  assert.deepEqual(env.getActiveIntervals(), [15000]);

  const timed = {
    provider: 'claude', key: 'claude/timed', status: 'approval', title: '파일 수정 승인', updatedAt: now, waitSince: now,
    action: {
      kind: 'approval', token: 'tok-fp', tool: 'edit_file',
      detail: JSON.stringify({ filePath: '/demo/src/app.ts', old_string: 'a', new_string: 'b' }),
      cwd: '/demo', allow: true, deny: true, expiresAt: now + 30000,
    },
    steps: [
      { tool: 'read_mcp_resource', target: 'mcp://docs/spec' },
      { tool: 'Read', target: 'src/app.ts' },
    ],
  };
  env.postFromHost(baseState({ sessions: [timed], attentionCount: 1 }));
  assert.deepEqual(env.getActiveIntervals().sort((a, b) => a - b), [1000, 15000]);
  assert.equal(env.main.querySelector('[data-key="claude/timed"] .request-path-btn')?.dataset.file, '/demo/src/app.ts');
  assert.equal(env.main.querySelector('[data-key="claude/timed"] .diff-add')?.textContent, '+1');
  assert.equal(env.main.querySelector('[data-key="claude/timed"] .diff-del')?.textContent, '−1');

  // Inspect steps: MCP resource is plain text (not clickable openFile), while local Read is a step-link.
  env.main.querySelector('[data-key="claude/timed"] .more').click();
  const stepLinks = env.main.querySelectorAll('[data-key="claude/timed"] .step-link');
  assert.equal(stepLinks.length, 1);
  assert.equal(stepLinks[0].dataset.file, 'src/app.ts');

  // Tick countdown and verify bar updates, then resolve request -> 1s interval stops cleanly.
  env.advanceDate(10000);
  env.tickIntervals();
  assert.equal(env.main.querySelector('time[data-expires]')?.textContent, '20초 남음');
  env.postFromHost(baseState({ sessions: [{ ...timed, status: 'working', action: undefined }], attentionCount: 0 }));
  assert.deepEqual(env.getActiveIntervals(), [15000]);
  assert.deepEqual(env.getCspAttempts(), { set: 0, remove: 0 });
});

test('review fixes: trimmed globals, preview transitions, 1-entry diff cache, cyclic parentKeys, visibilitychange refresh, and showcase live timestamps', () => {
  let lineChangesCalls = 0;
  let requestBlocksCalls = 0;
  const env = createStrictCspDom({
    onBeforeScript(name, sandbox) {
      if (name !== 'panel-cards.js') return;
      const origLineChanges = sandbox.AgentSessionFormat.lineChanges;
      const origRequestBlocks = sandbox.AgentSessionFormat.requestBlocks;
      sandbox.AgentSessionFormat.lineChanges = (...args) => { lineChangesCalls++; return origLineChanges(...args); };
      sandbox.AgentSessionFormat.requestBlocks = (...args) => { requestBlocksCalls++; return origRequestBlocks(...args); };
    },
  });

  // 1. Unused internals must not be leaked on globalThis.AgentSessionPanel.
  const removedGlobals = [
    'hourMinute', 'monthDay', 'nodeKey', 'syncStyle', 'syncPulses',
    'codeBlock', 'patchBlock', 'readonlyQuestions', 'changeBlock', 'pathLine', 'requestContent',
    'isLiveWorking', 'attentionRank', 'hasRichStory', 'statusOf', 'sublineIconFor', 'renderRow', 'windowRow', 'renderQuota',
  ];
  for (const name of removedGlobals) {
    assert.equal(Object.hasOwn(env.sandbox.AgentSessionPanel, name), false, 'unexpected global export: ' + name);
  }

  // 2. transitionKeys detects consecutive Codex/Antigravity read-only preview changes.
  const { transitionKeys, deriveView } = env.sandbox.AgentSessionPanel;
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  const prevPreview = { provider: 'codex', key: 'codex/p1', status: 'approval', title: 'Codex', updatedAt: now, waitSince: now, preview: { tool: 'Bash', detail: '{"command":"ls"}' } };
  const samePreview = { ...prevPreview, preview: { tool: 'Bash', detail: '{"command":"ls"}' } };
  const nextPreview = { ...prevPreview, preview: { tool: 'Bash', detail: '{"command":"npm test"}' } };
  assert.equal(transitionKeys([prevPreview], [samePreview]).has('codex/p1'), false);
  assert.equal(transitionKeys([prevPreview], [nextPreview]).has('codex/p1'), true);

  // 3. 1-entry request cache avoids re-running requestBlocks/lineChanges on background activity updates.
  const approval = {
    provider: 'claude', key: 'claude/edit1', status: 'approval', title: '파일 수정 승인', updatedAt: now, waitSince: now - 60000,
    action: {
      kind: 'approval', token: 'tok-cache-1', tool: 'Edit', cwd: '/demo', allow: true, deny: true, expiresAt: now + 40000,
      detail: JSON.stringify({ file_path: '/demo/src/a.ts', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 1;\nconst b = 3;\nconst c = 4;' }),
    },
  };
  const worker = {
    provider: 'codex', key: 'codex/bg1', status: 'working', title: '백그라운드 작업', updatedAt: now, workSince: now - 120000,
    activity: { tool: 'Read', target: 'src/first.ts', at: now },
  };
  env.postFromHost(baseState({
    sessions: [approval, worker],
    quotas: {
      claude: { status: 'ready', plan: 'Max', windows: [{ name: '', period: 300, kind: 'used', percent: 30, resetsAt: now + 30 * 60000 }] },
      codex: { status: 'ready', plan: 'Pro', windows: [{ name: '', period: 300, kind: 'used', percent: 40 }] },
      agy: { status: 'ready', plan: 'Ultra', windows: [{ name: 'Gemini Models', period: 300, kind: 'remaining', percent: 80 }] },
    },
    attentionCount: 1,
  }));
  assert.equal(requestBlocksCalls, 1);
  assert.equal(lineChangesCalls, 1);

  // Frequent background activity updates must hit the 1-entry request cache.
  for (let i = 0; i < 4; i++) {
    env.postFromHost(baseState({
      sessions: [approval, { ...worker, activity: { tool: 'Read', target: 'src/file-' + i + '.ts', at: now + i * 250 } }],
      quotas: {
        claude: { status: 'ready', plan: 'Max', windows: [{ name: '', period: 300, kind: 'used', percent: 30, resetsAt: now + 30 * 60000 }] },
        codex: { status: 'ready', plan: 'Pro', windows: [{ name: '', period: 300, kind: 'used', percent: 40 }] },
        agy: { status: 'ready', plan: 'Ultra', windows: [{ name: 'Gemini Models', period: 300, kind: 'remaining', percent: 80 }] },
      },
      attentionCount: 1,
    }));
  }
  assert.equal(requestBlocksCalls, 1, 'requestBlocks cached across background renders');
  assert.equal(lineChangesCalls, 1, 'lineChanges cached across background renders');

  // 4. Cyclic parentKey chains are broken cleanly in getStateData/deriveView and never dropped.
  const cycA = { provider: 'claude', key: 'claude/cyc-a', isSubagent: true, parentKey: 'claude/cyc-b', status: 'working', title: '사이클 A', updatedAt: now };
  const cycB = { provider: 'claude', key: 'claude/cyc-b', isSubagent: true, parentKey: 'claude/cyc-a', status: 'approval', title: '사이클 B', updatedAt: now, waitSince: now };
  const cycState = baseState({ sessions: [cycA, cycB], attentionCount: 1 });
  const cycAll = deriveView(cycState, 'all', 'all', '', now);
  assert.equal(cycAll.buckets.roots.length, 1);
  assert.equal(cycAll.buckets.counts.all, 1);
  assert.equal(cycAll.buckets.counts.attention, 1);
  assert.deepEqual(deriveView(cycState, 'attention', 'all', '', now).filtered.map(r => r.key), ['claude/cyc-a', 'claude/cyc-b']);
  assert.deepEqual(deriveView(cycState, 'working', 'all', '', now).filtered.map(r => r.key), ['claude/cyc-a', 'claude/cyc-b']);
  assert.deepEqual(deriveView(cycState, 'all', 'claude', '사이클', now).filtered.map(r => r.key), ['claude/cyc-a', 'claude/cyc-b']);

  // 5. visibilitychange back to visible immediately refreshes countdowns, [data-since], and [data-reset-at].
  assert.equal(env.main.querySelector('time[data-expires]')?.textContent, '40초 남음');
  assert.equal(env.main.querySelector('[data-key="claude/edit1"] .since')?.textContent, '1분');
  env.setVisibility(true);
  env.advanceDate(15000);
  // While hidden, returning should happen only once visible again.
  env.setVisibility(false);
  assert.equal(env.main.querySelector('time[data-expires]')?.textContent, '25초 남음');
  env.setVisibility(true);
  env.advanceDate(120000);
  env.setVisibility(false);
  assert.equal(env.main.querySelector('[data-key="claude/edit1"] .since')?.textContent, '3분');

  // Switch to quota overview so [data-reset-at] is rendered and verify visibilitychange refreshes it immediately.
  env.main.querySelector('.quota-tile[data-provider="claude"]').click();
  const resetBefore = env.main.querySelector('[data-reset-at]')?.textContent;
  assert.ok(resetBefore?.includes('28분 후'));
  env.setVisibility(true);
  env.advanceDate(5 * 60000);
  env.setVisibility(false);
  const resetAfter = env.main.querySelector('[data-reset-at]')?.textContent;
  assert.ok(resetAfter?.includes('23분 후'), 'expected reset countdown to update immediately, got: ' + resetAfter);

  // 6. build-showcase.cjs uses updated title and dynamically shifts all BASE_STATE timestamps.
  const showcaseSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'build-showcase.cjs'), 'utf8');
  assert.ok(showcaseSrc.includes('<span>에이전트 세션 모니터</span>'));
  assert.equal(showcaseSrc.includes('<span>에이전트 세션</span>'), false);
  const baseMatch = /const BASE_STATE = (\{[\s\S]*?\});/.exec(showcaseSrc);
  const shiftMatch = /(function shiftTimestamps\([\s\S]*?\n\})/.exec(showcaseSrc);
  assert.ok(baseMatch && shiftMatch);
  const futureNow = Date.UTC(2028, 3, 15, 9, 0, 0);
  const probe = vm.runInNewContext(
    `${shiftMatch[1]}; const s = ${baseMatch[1]}; shiftTimestamps(s, ${futureNow} - 1795526700000); s;`
  );
  for (const row of probe.sessions) {
    assert.ok(Math.abs(futureNow - row.updatedAt) < 15 * 60000, row.key + ' updatedAt shifted');
    if (row.waitSince) assert.ok(Math.abs(futureNow - row.waitSince) < 15 * 60000);
    if (row.workSince) assert.ok(Math.abs(futureNow - row.workSince) < 20 * 60000);
    if (row.replyAt) assert.ok(Math.abs(futureNow - row.replyAt) < 15 * 60000);
    if (row.activity?.at) assert.ok(Math.abs(futureNow - row.activity.at) < 15 * 60000);
    for (const step of row.steps || []) assert.ok(Math.abs(futureNow - step.at) < 15 * 60000);
    if (row.execution?.modelAt) assert.ok(Math.abs(futureNow - row.execution.modelAt) < 15 * 60000);
    if (row.execution?.effortAt) assert.ok(Math.abs(futureNow - row.execution.effortAt) < 15 * 60000);
  }
  for (const quota of Object.values(probe.quotas)) {
    assert.ok(Math.abs(futureNow - quota.updatedAt) < 15 * 60000);
    for (const w of quota.windows) assert.ok(w.resetsAt > futureNow, w.label + ' resetsAt in future');
  }
  assert.deepEqual(env.getCspAttempts(), { set: 0, remove: 0 });
});

test('read-only preview feedback, immediate review CTA, actionable priority, and stationary pointer anti-misclick guard', () => {
  const env = createStrictCspDom();
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);

  // 1. Antigravity ask_question preview: clicking static option or pressing '1' nudges banner + CTA; CTA opens chat immediately.
  const agyQuestion = {
    provider: 'agy', key: 'agy/q-live', status: 'input', title: 'AGY 질문', updatedAt: now, waitSince: now - 60000,
    preview: {
      tool: 'ask_question',
      detail: JSON.stringify({
        questions: [{ question: '진행 방식을 고르세요', options: ['1~3단계 우선', '전체 수정'], is_multi_select: false }],
      }),
    },
  };
  env.postFromHost(baseState({ sessions: [agyQuestion], attentionCount: 1 }));
  const previewCard = env.main.querySelector('[data-key="agy/q-live"] .request.is-preview');
  assert.ok(previewCard);
  const banner = previewCard.querySelector('.preview-banner');
  const firstOption = previewCard.querySelector('.choice-static');
  const cta = previewCard.querySelector('.preview-cta');
  assert.ok(banner?.textContent.includes('읽기 전용 미리보기 · Antigravity에서 직접 선택'));
  assert.equal(cta?.dataset.action, 'review');

  // Clicking a static choice does not send an answer/review message, but nudges banner and announces guidance.
  const msgCountBefore = env.postedMessages.length;
  firstOption.click({ pointerType: 'mouse', clientX: 60, clientY: 160 });
  assert.equal(env.postedMessages.length, msgCountBefore);
  assert.equal(banner.classList.contains('is-nudged'), true);
  assert.ok(env.doc.body.querySelector('.sr-only[aria-live="polite"]')?.textContent.includes('Antigravity에서 직접 선택'));

  // Pressing '1' on a read-only question preview moves focus to the CTA without sending an answer.
  banner.classList.remove('is-nudged');
  const opener = env.main.querySelector('[data-key="agy/q-live"] .opener');
  opener.focus();
  opener.dispatchEvent({ type: 'keydown', bubbles: true, key: '1', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false });
  assert.equal(env.postedMessages.length, msgCountBefore);
  assert.equal(banner.classList.contains('is-nudged'), true);
  assert.equal(env.doc.activeElement, cta);

  // Clicking the CTA works immediately (even within <450ms) because review is non-destructive navigation.
  cta.click({ pointerType: 'mouse', clientX: 60, clientY: 220 });
  assert.deepEqual(env.postedMessages.at(-1), { action: 'review', provider: 'agy', key: 'agy/q-live', token: previewCard.dataset.request });

  // 2. When a live Claude approval arrives while an older Antigravity preview is open, it automatically preempts the preview.
  const claudeApproval = {
    provider: 'claude', key: 'claude/a-live', status: 'approval', title: '명령 승인', updatedAt: now, waitSince: now,
    action: { kind: 'approval', token: 'tok-live-1', tool: 'Bash', detail: '{"command":"npm test"}', cwd: '/demo', allow: true, deny: true, expiresAt: now + 45000 },
  };
  env.postFromHost(baseState({ sessions: [agyQuestion, claudeApproval], attentionCount: 2 }));
  assert.equal(env.main.querySelector('.request')?.dataset.request, 'tok-live-1');

  // If the user explicitly steps back to the preview, subsequent background refreshes do not yank them away.
  env.main.querySelector('.queue-step[data-direction="next"]').click();
  assert.equal(env.main.querySelector('.request')?.dataset.request, previewCard.dataset.request);
  env.postFromHost(baseState({ sessions: [agyQuestion, claudeApproval], attentionCount: 2, workspaceLabel: 'demo-2' }));
  assert.equal(env.main.querySelector('.request')?.dataset.request, previewCard.dataset.request);

  // Step back to the actionable approval for guard checks.
  env.main.querySelector('.queue-step[data-direction="prev"]').click();
  assert.equal(env.main.querySelector('.request')?.dataset.request, 'tok-live-1');

  // 3. Anti-misclick guard: blocks premature clicks (<450ms), accepts stationary click after calm reading without forcing a 4px mouse wiggle.
  const approveBtn = env.main.querySelector('button[data-action="approve"]');
  assert.ok(approveBtn);
  // Premature click at +100ms is refused.
  env.advancePerf(100);
  approveBtn.click({ pointerType: 'mouse', clientX: 80, clientY: 220 });
  assert.equal(env.postedMessages.some(m => m.action === 'approve'), false);
  // After 500ms total, pointer entered from outside (no pointerAtSettle) -> first click succeeds without requiring prior pointermove.
  env.advancePerf(450);
  approveBtn.click({ pointerType: 'mouse', clientX: 80, clientY: 220 });
  assert.deepEqual(env.postedMessages.at(-1), { action: 'approve', provider: 'claude', key: 'claude/a-live', token: 'tok-live-1' });

  // 4. Hovering cursor when a new card appears: warns once if stationary at +500ms, then accepts deliberate retry at the same coordinates.
  env.main.dispatchEvent({ type: 'pointermove', bubbles: true, pointerType: 'mouse', clientX: 90, clientY: 220 });
  env.postFromHost(baseState({
    sessions: [{ ...claudeApproval, key: 'claude/a-hover', action: { ...claudeApproval.action, token: 'tok-hover-1' } }],
    attentionCount: 1,
  }));
  const hoverApprove = env.main.querySelector('button[data-action="approve"]');
  env.advancePerf(500);
  hoverApprove.click({ pointerType: 'mouse', clientX: 90, clientY: 220 });
  assert.equal(env.postedMessages.some(m => m.token === 'tok-hover-1' && m.action === 'approve'), false, 'stationary click right after popup under cursor warns once');
  env.advancePerf(100);
  hoverApprove.click({ pointerType: 'mouse', clientX: 90, clientY: 220 });
  assert.deepEqual(env.postedMessages.at(-1), { action: 'approve', provider: 'claude', key: 'claude/a-hover', token: 'tok-hover-1' });
  assert.deepEqual(env.getCspAttempts(), { set: 0, remove: 0 });
});

test('regressions: deferred render shift re-arms anti-misclick guard and preview stays visible while aiming on new inline request', () => {
  const env = createStrictCspDom();
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  const approval = {
    provider: 'claude', key: 'claude/shift-1', status: 'approval', title: '배포 승인', updatedAt: now, waitSince: now - 5000,
    action: { kind: 'approval', token: 'tok-shift-1', tool: 'Bash', detail: '{"command":"npm run deploy"}', cwd: '/demo', allow: true, deny: true, expiresAt: now + 45000 },
  };
  const settled = { provider: 'codex', key: 'codex/done-1', status: 'done', title: '이전 대화', updatedAt: now - 10000, replyAt: now - 10000 };
  const errRow = { provider: 'codex', key: 'codex/err-1', status: 'error', title: '오류 세션', updatedAt: now, errorReason: 'server_error' };
  env.postFromHost(baseState({ sessions: [approval, settled], attentionCount: 1 }));
  env.advancePerf(2000);

  // 1. Deferred host update released on pointerup shifts the card downward: immediate click (<450ms) MUST be refused.
  const region = env.main.querySelector('.scroll-region');
  region.dispatchEvent({ type: 'pointermove', bubbles: true, pointerType: 'mouse', clientX: 80, clientY: 280 });
  region.dispatchEvent({ type: 'pointerdown', bubbles: true, pointerType: 'mouse', button: 0, clientX: 80, clientY: 280 });
  env.setRequestTopOffset(70);
  env.postFromHost(baseState({ sessions: [errRow, approval, settled], attentionCount: 2 }));
  env.dispatchWindow({ type: 'pointerup' });
  env.flushTimeouts(); // runs releasePointer() -> render() without { fromHost: true }
  env.advancePerf(120);
  env.main.querySelector('button[data-action="approve"]').click({ pointerType: 'mouse', clientX: 80, clientY: 280 });
  assert.equal(env.postedMessages.some(m => m.action === 'approve'), false, 'deferred releasePointer shift must re-arm misclick guard');

  // 2. Deferred scheduleSettle render after hovering shifts the card again: immediate click MUST also be refused.
  env.advancePerf(2500);
  region.dispatchEvent({ type: 'pointermove', bubbles: true, pointerType: 'mouse', clientX: 80, clientY: 340 });
  env.setRequestTopOffset(140);
  env.postFromHost(baseState({ sessions: [errRow, { ...errRow, key: 'codex/err-2', title: '오류 세션 2' }, approval, settled], attentionCount: 3 }));
  env.advancePerf(1000); // past hoverUntil
  env.flushTimeouts(); // runs scheduleSettle() -> render(new Set())
  env.advancePerf(40);
  env.main.querySelector('button[data-action="approve"]').click({ pointerType: 'mouse', clientX: 80, clientY: 340 });
  assert.equal(env.postedMessages.some(m => m.action === 'approve'), false, 'deferred scheduleSettle shift must re-arm misclick guard');

  // 3. Preview remains visible while pointer is moving over the panel when a new inline request arrives, then switches once settled.
  const env2 = createStrictCspDom();
  const agyPreview = {
    provider: 'agy', key: 'agy/q-stay', status: 'input', title: 'AGY 질문', updatedAt: now, waitSince: now - 60000,
    preview: { tool: 'ask_question', detail: JSON.stringify({ questions: [{ question: '진행?', options: ['예', '아니오'] }] }) },
  };
  env2.postFromHost(baseState({ sessions: [agyPreview, settled], attentionCount: 1 }));
  const previewTok = env2.main.querySelector('.request')?.dataset.request;
  assert.ok(previewTok?.startsWith('preview:'));
  const region2 = env2.main.querySelector('.scroll-region');
  region2.dispatchEvent({ type: 'pointermove', bubbles: true, pointerType: 'mouse', clientX: 80, clientY: 160 });
  env2.postFromHost(baseState({ sessions: [approval, agyPreview, settled], attentionCount: 2 }));
  // While still aiming, preview MUST NOT vanish.
  assert.equal(env2.main.querySelector('.request')?.dataset.request, previewTok);
  // Once pointer settles (>900ms) and scheduleSettle fires, it transitions directly to the new inline approval.
  env2.advancePerf(1000);
  env2.flushTimeouts();
  assert.equal(env2.main.querySelector('.request')?.dataset.request, 'tok-shift-1');
  assert.deepEqual(env2.getCspAttempts(), { set: 0, remove: 0 });
});

test('approval flow fixes: work story does not block new card scroll/toast, body shortcuts & search navigation work, collapsed row shows countdown', () => {
  const env = createStrictCspDom();
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  const work = { provider: 'codex', key: 'codex/w1', status: 'working', title: '스토리 세션', updatedAt: now, workSince: now - 60000, prompt: '점검 중' };
  const q1 = {
    provider: 'claude', key: 'claude/q1', status: 'input', title: '질문 세션', updatedAt: now, waitSince: now - 5000,
    action: {
      kind: 'question', token: 'tok-q1', tool: 'AskUserQuestion', expiresAt: now + 40000,
      questions: [{ question: '방식?', header: '', multiSelect: false, choices: [{ label: '빠른 수정', description: '' }, { label: '전체 수정', description: '' }] }],
    },
  };
  const aUrgent = {
    provider: 'claude', key: 'claude/a-urg', status: 'approval', title: '긴급 승인', updatedAt: now, waitSince: now,
    action: { kind: 'approval', token: 'tok-urg', tool: 'Bash', detail: '{"command":"npm test"}', cwd: '/demo', allow: true, deny: true, expiresAt: now + 12000 },
  };
  env.postFromHost(baseState({ sessions: [work], attentionCount: 0 }));

  // 1. Leave Work Story open without actively focusing inside it -> new request scrolls into view and reports visible: true.
  env.main.querySelector('[data-key="codex/w1"] .more').click();
  assert.ok(env.main.querySelector('[data-key="codex/w1"] .row-menu'));
  env.doc.activeElement = env.doc.body;
  const scrolledBefore = env.scrolled.length;
  env.postFromHost(baseState({ sessions: [q1, aUrgent, work], attentionCount: 2 }));
  assert.ok(env.scrolled.length > scrolledBefore, 'new request scrolls into view even if Work Story was left open');

  // 2. Urgent deadline (12s) opens first, AND the collapsed second timed row (40s) displays its live countdown!
  assert.equal(env.main.querySelector('.request')?.dataset.request, 'tok-urg');
  const collapsedCountdown = env.main.querySelector('[data-key="claude/q1"] time[data-expires]');
  assert.ok(collapsedCountdown, 'collapsed row with timed inline action must display remaining countdown');
  assert.equal(collapsedCountdown.textContent, '40초 남음');

  // 3. When open card is scrolled off-screen, reportRequest posts visible: false so host does not suppress toast.
  env.setRequestTopOffset(700);
  env.main.querySelector('.scroll-region').dispatchEvent({ type: 'scroll', bubbles: true });
  assert.deepEqual(env.postedMessages.findLast(m => m.type === 'request'), { type: 'request', kind: 'approval', key: 'claude/a-urg', visible: false });
  env.setRequestTopOffset(0);
  env.main.querySelector('.scroll-region').dispatchEvent({ type: 'scroll', bubbles: true });
  assert.deepEqual(env.postedMessages.findLast(m => m.type === 'request'), { type: 'request', kind: 'approval', key: 'claude/a-urg', visible: true });

  // 4. Shortcuts work immediately when focus is on document.body (right after focusing the panel): '1' answers question, '/' opens search, ArrowDown moves into search results.
  env.main.querySelector('.queue-step[data-direction="next"]').click(); // switch to q1
  assert.equal(env.main.querySelector('.request')?.dataset.request, 'tok-q1');
  env.advancePerf(1500);
  env.doc.activeElement = env.doc.body;
  env.doc.body.dispatchEvent({ type: 'keydown', bubbles: true, key: '1', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false });
  assert.deepEqual(env.postedMessages.at(-1), { action: 'answer', provider: 'claude', key: 'claude/q1', token: 'tok-q1', answers: [[0]] });

  // '/' from body opens search, typing filters results, ArrowDown from search input jumps to first result, ArrowUp returns to search input.
  env.doc.body.dispatchEvent({ type: 'keydown', bubbles: true, key: '/', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false });
  const searchInput = env.main.querySelector('.search-input');
  assert.ok(searchInput);
  assert.equal(env.doc.activeElement, searchInput);
  searchInput.value = '스토리';
  searchInput.dispatchEvent({ type: 'input', bubbles: true });
  searchInput.dispatchEvent({ type: 'keydown', bubbles: true, key: 'ArrowDown', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false });
  const firstResultOpener = env.main.querySelector('[data-key="codex/w1"] .opener');
  assert.equal(env.doc.activeElement, firstResultOpener, 'ArrowDown in search input focuses first result row');
  firstResultOpener.dispatchEvent({ type: 'keydown', bubbles: true, key: 'ArrowUp', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false });
  assert.equal(env.doc.activeElement, env.main.querySelector('.search-input'), 'ArrowUp from first result returns to search input');
  assert.deepEqual(env.getCspAttempts(), { set: 0, remove: 0 });
});

test('Codex untrusted /hooks notice, live detection limitation note, and preview filename search work in the panel UI', () => {
  const env = createStrictCspDom();
  const now = Date.UTC(2026, 10, 26, 12, 0, 0);
  const patch = '*** Begin Patch\n*** Add File: qa-marker.txt\n+hello\n*** Update File: old/a.js\n*** Move to: new/b.js\n@@\n-1\n+2\n*** End Patch';
  const rows = [
    {
      provider: 'codex', key: 'codex/p1', status: 'approval', title: '패치 승인', updatedAt: now, waitSince: now,
      preview: { tool: 'apply_patch', detail: JSON.stringify({ command: patch }) },
    },
    { provider: 'claude', key: 'claude/w1', status: 'working', title: '다른 작업', updatedAt: now, workSince: now },
  ];
  env.postFromHost(baseState({
    sessions: rows,
    connections: { claude: 'connected', codex: 'untrusted', agy: 'connected' },
    codexLiveDetection: 'available',
    attentionCount: 1,
  }));

  const warn = env.main.querySelector('.connect.is-warning[data-provider="codex"]');
  assert.ok(warn, 'Codex untrusted warning banner renders');
  assert.ok(warn.textContent.includes('Codex 훅 신뢰 필요'));
  assert.ok(warn.textContent.includes('/hooks'));
  assert.ok(warn.textContent.includes('실행 여부만 감지'));
  warn.querySelector('button[data-action="trustGuide"]').click();
  assert.deepEqual(env.postedMessages.at(-1), { action: 'trustGuide', provider: 'codex' });
  warn.querySelector('button[data-action="refresh"]').click();
  assert.deepEqual(env.postedMessages.at(-1), { action: 'refresh' });

  // When hookless live detection is unavailable, the notice explicitly states the limitation.
  env.postFromHost(baseState({
    sessions: rows,
    connections: { claude: 'connected', codex: 'untrusted', agy: 'connected' },
    codexLiveDetection: 'unavailable',
    attentionCount: 1,
  }));
  assert.ok(env.main.querySelector('.connect.is-warning .connect-note').textContent.includes('작업 중·승인 대기를 확인할 수 없습니다'));

  env.postFromHost(baseState({ sessions: rows, connections: { codex: 'unverified' } }));
  const unknown = env.main.querySelector('.connect[data-status="unverified"]');
  assert.ok(unknown.textContent.includes('훅 신뢰 상태 미확인'));
  unknown.querySelector('button[data-action="refresh"]').click();
  assert.deepEqual(env.postedMessages.at(-1), { action: 'refresh' });

  // Searching by filename visible in preview card finds the Codex approval row.
  env.main.querySelector('.search-toggle').click();
  const input = env.main.querySelector('.search-input');
  for (const query of ['qa-marker.txt', 'old/a.js', 'new/b.js']) {
    input.value = query;
    input.dispatchEvent({ type: 'input', bubbles: true });
    assert.deepEqual(env.main.querySelectorAll('.session').map(el => el.dataset.key), ['codex/p1'], query);
  }
  assert.deepEqual(env.getCspAttempts(), { set: 0, remove: 0 });
});

test('optional headless Chrome strict-CSP check (no CSP violations on CSSOM progress updates and dynamic theme pulse)', async t => {
  const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const chrome = chromePaths.find(p => fs.existsSync(p));
  if (!chrome) return t.skip('Chrome/Chromium binary not installed');

  const nonce = 'testnonce1234567890';
  const scriptTags = PANEL_SCRIPTS.map(name => `<script nonce="${nonce}" src="/${name}"></script>`).join('\n');
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<link rel="stylesheet" href="/panel.css"><title>CSP Test</title></head>
<body class="vscode-dark"><template id="logos"></template><main id="sessions"></main>
<script nonce="${nonce}">
window.__violations = [];
document.addEventListener('securitypolicyviolation', e => window.__violations.push(e.violatedDirective + ':' + e.blockedURI));
window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: () => {} });
</script>
${scriptTags}
<script nonce="${nonce}">
const makeState = (done, used) => ({
  type: 'state', hasWorkspace: true, workspaceLabel: 'demo', isRemoteWorkspace: false, scanError: '',
  sessions: [{ provider: 'claude', key: 'claude/w1', status: 'working', title: 'CSP Check', updatedAt: Date.now(), workSince: Date.now(), progress: { done, total: 4 } }],
  usage: {}, quotas: { claude: { status: 'ready', plan: 'Max', windows: [{ name: '', period: 300, kind: 'used', percent: used }] }, codex: { status: 'unavailable', windows: [] }, agy: { status: 'unavailable', windows: [] } },
  connections: { claude: 'connected', codex: 'connected', agy: 'connected' }, elsewhere: [],
  preferences: { sort: 'priority', providerOrder: ['claude', 'codex', 'agy'], attentionOnly: false, hideCompleted: false },
  hiddenCompleted: 0, attentionCount: 0, unreadCount: 0,
});
window.postMessage(makeState(1, 30), '*');
setTimeout(() => {
  window.postMessage(makeState(3, 80), '*');
  setTimeout(() => {
    const node = document.querySelector('.session[data-status="working"] > .title-line .node');
    const anims = node ? node.getAnimations() : [];
    if (anims[0]) anims[0].currentTime = 1170;
    const darkStyle = node ? getComputedStyle(node) : null;
    const darkPulse = darkStyle ? darkStyle.backgroundColor : '';
    const pulseOpacity = darkStyle ? Number(darkStyle.opacity) : 1;
    const pulseTransform = darkStyle ? darkStyle.transform : 'none';
    document.body.className = 'vscode-light';
    if (anims[0]) anims[0].currentTime = 1170;
    const lightPulse = node ? getComputedStyle(node).backgroundColor : '';
    const out = document.createElement('div');
    out.id = 'csp-result';
    out.textContent = JSON.stringify({
      violations: window.__violations,
      progressTransform: document.querySelector('.mini-progress-fill')?.style.transform || '',
      tileTransform: document.querySelector('.tile-bar-fill')?.style.transform || '',
      pulseCount: anims.length,
      pulseOpacity,
      pulseTransform,
      darkPulse,
      lightPulse,
    });
    document.body.append(out);
  }, 150);
}, 50);
</script></body></html>`;

  const server = http.createServer((req, res) => {
    const scriptName = req.url?.startsWith('/') ? req.url.slice(1) : '';
    if (req.url === '/panel.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(CSS_SRC);
    } else if (SCRIPT_SOURCES.has(scriptName)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(SCRIPT_SOURCES.get(scriptName));
    } else {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; style-src 'self'; script-src 'nonce-${nonce}'; img-src 'self'; base-uri 'none'; form-action 'none';`,
      });
      res.end(html);
    }
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (err) {
    return t.skip('Local HTTP loopback blocked in sandbox: ' + err.code);
  }

  const os = require('node:os');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-chrome-csp-'));
  let domOut;
  try {
    const { port } = server.address();
    try {
      domOut = await new Promise((resolve, reject) => {
        execFile(chrome, [
          '--headless=new', '--disable-gpu', '--no-sandbox', '--user-data-dir=' + profileDir,
          '--virtual-time-budget=2000', '--dump-dom', `http://127.0.0.1:${port}/`,
        ], { timeout: 10000 }, (err, stdout) => err ? reject(err) : resolve(stdout));
      });
    } catch (err) {
      return t.skip('Headless Chrome execution unavailable in sandbox: ' + (err.message || err.code));
    }
    const match = /<div id="csp-result">([^<]+)<\/div>/.exec(domOut);
    if (!match) return t.skip('Headless Chrome did not render DOM output in this environment');
    const result = JSON.parse(match[1].replaceAll('&quot;', '"'));
    assert.deepEqual(result.violations, []);
    assert.equal(result.progressTransform, 'scaleX(0.75)');
    assert.equal(result.tileTransform, 'scaleX(0.2)');
    assert.equal(result.pulseCount, 1);
    assert.ok(result.pulseOpacity < 0.9, 'compositor pulse animates opacity');
    assert.notEqual(result.pulseTransform, 'none', 'compositor pulse animates transform');
    assert.notEqual(result.darkPulse, '');
    assert.notEqual(result.lightPulse, '');
    assert.notEqual(result.darkPulse, result.lightPulse, 'pulse color should dynamically update on Dark/Light theme switch');
  } finally {
    server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});

test('Phase 1-3 UI polish: pinned filter-alert, draft preservation across filters, refuse-note + sending state, Escape priority, mouse/kb overview focus, rev fast-path, stable opener, and sandbox warning', () => {
  const env = createStrictCspDom();
  const now = Date.UTC(2026, 10, 26, 12, 0, 0);
  const multiQ = {
    provider: 'claude', key: 'claude/q-multi', status: 'input', title: '옵션 선택', updatedAt: now, waitSince: now - 10000,
    action: {
      kind: 'question', token: 'tok-multi', tool: 'AskUserQuestion', expiresAt: now + 45000,
      questions: [{ question: '적용할 항목?', header: '선택', multiSelect: true, choices: [{ label: '옵션 A', description: '' }, { label: '옵션 B', description: '' }] }],
    },
  };
  const work = {
    provider: 'codex', key: 'codex/w-bg', status: 'working', title: '백그라운드 분석', updatedAt: now, workSince: now - 60000,
    prompt: '상세 점검',
    plan: [{ text: '1단계', status: 'completed' }, { text: '2단계', status: 'in_progress' }],
    progress: { done: 1, total: 2 },
  };
  const approval = {
    provider: 'agy', key: 'agy/bypass', status: 'approval', title: '배포 실행', updatedAt: now, waitSince: now,
    action: {
      kind: 'approval', token: 'tok-bypass', tool: 'run_command', cwd: '/demo', allow: true, deny: true, expiresAt: now + 40000,
      detail: JSON.stringify({ CommandLine: 'npm run deploy', BypassSandbox: true, file_path: '/demo/scripts/deploy.sh' }),
    },
  };
  const traversalEdit = {
    provider: 'claude', key: 'claude/edit-rel', status: 'approval', title: '파일 수정', updatedAt: now, waitSince: now + 1000,
    action: {
      kind: 'approval', token: 'tok-rel', tool: 'Edit', cwd: '/demo', allow: true, deny: true, expiresAt: now + 50000,
      detail: JSON.stringify({ file_path: '/demo/src/app.ts', old_string: 'a', new_string: 'b' }),
    },
  };

  env.postFromHost(baseState({ rev: 1, sessions: [multiQ, approval, traversalEdit, work], attentionCount: 3 }));

  // 1. Draft selections survive switching lens to 'working' and back to 'all', AND .filter-alert is pinned outside .scroll-region.
  env.main.querySelector('.queue-step[data-direction="next"]').click(); // switch from tok-bypass (40s) to tok-multi (45s)
  assert.equal(env.main.querySelector('.request')?.dataset.request, 'tok-multi');
  env.main.querySelector('.choice[data-index="0"]').click();
  assert.equal(env.main.querySelector('.choice[data-index="0"]').getAttribute('aria-pressed'), 'true');
  env.main.querySelector('.lens-btn[data-value="working"]').click();
  const alertEl = env.main.querySelector('.filter-alert');
  assert.ok(alertEl, 'filter alert renders');
  assert.equal(alertEl.parentNode, env.main, 'filter-alert must be pinned above .scroll-region as direct child of #sessions');
  assert.equal(env.main.querySelector('.scroll-region .filter-alert'), null);
  env.main.querySelector('.lens-btn[data-value="all"]').click();
  env.main.querySelector('.queue-step[data-direction="next"]').click();
  assert.equal(env.main.querySelector('.request')?.dataset.request, 'tok-multi');
  assert.equal(env.main.querySelector('.choice[data-index="0"]').getAttribute('aria-pressed'), 'true', 'draft selection must survive filter round-trip');

  // 2. Sandbox bypass warning callout + concise aria-describedby + relative display path preserving full dataset.file.
  env.main.querySelector('.queue-step[data-direction="prev"]').click();
  assert.equal(env.main.querySelector('.request')?.dataset.request, 'tok-bypass');
  const warnCallout = env.main.querySelector('.request-warning');
  assert.ok(warnCallout?.textContent.includes('샌드박스 외부 실행 (BypassSandbox)'));
  const approveBtn = env.main.querySelector('button[data-action="approve"]');
  assert.equal(approveBtn.getAttribute('aria-describedby'), 'request-summary');
  assert.ok(env.main.querySelector('#request-summary')?.textContent.includes('npm run deploy'));

  env.main.querySelector('.queue-step[data-direction="prev"]').click(); // wrap to tok-rel
  assert.equal(env.main.querySelector('.request')?.dataset.request, 'tok-rel');
  const relBtn = env.main.querySelector('.request-path-btn');
  assert.equal(relBtn.dataset.file, '/demo/src/app.ts', 'openFile keeps full path');
  assert.equal(relBtn.textContent, 'src/app.ts', 'displayed path trims matching cwd prefix');

  // 3. Dedicated .refuse-note on misclick guard refusal + aria-live announcement + survives background tick, then '전송 중…' pending state on valid click.
  env.advancePerf(100);
  env.main.querySelector('button[data-action="approve"]').click({ pointerType: 'mouse', clientX: 80, clientY: 220 });
  const refuseNote = env.main.querySelector('.refuse-note');
  assert.ok(refuseNote?.textContent.includes('방금 나타났거나 움직인 요청입니다'));
  assert.ok(env.doc.body.querySelector('.sr-only[aria-live="polite"]')?.textContent.includes('방금 나타났거나'));
  env.postFromHost(baseState({ rev: 2, sessions: [multiQ, approval, traversalEdit, { ...work, title: '백그라운드 분석 2' }], attentionCount: 3 }));
  assert.ok(env.main.querySelector('.refuse-note'), 'refuse-note persists across background state updates');

  // Duplicate rev is short-circuited cleanly without touching DOM.
  env.postFromHost(baseState({ rev: 2, sessions: [], attentionCount: 0 }));
  assert.ok(env.main.querySelector('[data-key="claude/edit-rel"]'), 'duplicate rev must be ignored');

  // Valid click transitions approve button into disabled '전송 중…' pending state.
  env.advancePerf(500);
  env.main.querySelector('button[data-action="approve"]').click({ pointerType: 'mouse', clientX: 80, clientY: 220 });
  const sendingBtn = env.main.querySelector('button[data-action="approve"]');
  assert.equal(sendingBtn.textContent, '전송 중…');
  assert.equal(sendingBtn.disabled, true);
  assert.equal(sendingBtn.classList.contains('is-sending'), true);
  assert.equal(env.main.querySelector('.refuse-note'), null);

  // 4. Plan progressbar ARIA attributes & Escape closes focused Work Story BEFORE closing search drawer.
  env.main.querySelector('.search-toggle').click();
  assert.ok(env.main.querySelector('.search-drawer'));
  env.main.querySelector('[data-key="codex/w-bg"] .more').click();
  const bar = env.main.querySelector('[data-key="codex/w-bg"] .plan-progress-bar');
  assert.equal(bar.getAttribute('role'), 'progressbar');
  assert.equal(bar.getAttribute('aria-valuenow'), '50');
  const menuCopyBtn = env.main.querySelector('[data-key="codex/w-bg"] .row-menu .copy-btn');
  menuCopyBtn.focus();
  menuCopyBtn.dispatchEvent({ type: 'keydown', bubbles: true, key: 'Escape' });
  assert.equal(env.main.querySelector('[data-key="codex/w-bg"] .row-menu'), null, 'Escape inside .row-menu closes inspector first');
  assert.ok(env.main.querySelector('.search-drawer'), 'search drawer remains open when Escape closes inspector');
  assert.equal(env.doc.activeElement, env.main.querySelector('[data-key="codex/w-bg"] .more'), 'focus returns to .more button');

  // 5. Mouse click on quota tile does not paint keyboard focus ring on .quota-refresh; keyboard activation does.
  env.doc.activeElement = env.doc.body;
  env.main.querySelector('.quota-tile[data-provider="claude"]').click({ detail: 1 });
  assert.notEqual(env.doc.activeElement, env.main.querySelector('.provider[data-provider="claude"] .quota-refresh'));
  env.main.querySelector('[data-control="quotaOverview"]').click({ detail: 1 });
  env.main.querySelector('.quota-tile[data-provider="claude"]').click({ detail: 0 });
  assert.equal(env.doc.activeElement, env.main.querySelector('.provider[data-provider="claude"] .quota-refresh'));
  env.main.querySelector('[data-control="quotaOverview"]').click({ detail: 0 });

  // 6. .opener DOM node is preserved across status transition (working -> approval).
  const openerBefore = env.main.querySelector('[data-key="codex/w-bg"] .opener');
  env.postFromHost(baseState({
    rev: 3,
    sessions: [
      { ...work, status: 'approval', waitSince: now, preview: { tool: 'Bash', detail: '{"command":"ls"}' } },
    ],
    attentionCount: 1,
  }));
  const openerAfter = env.main.querySelector('[data-key="codex/w-bg"] .opener');
  assert.equal(openerAfter, openerBefore, '.opener DOM node must stay stable across working->approval transition');
  assert.deepEqual(env.getCspAttempts(), { set: 0, remove: 0 });
});

test('an English page shows the whole panel in English: rows, the open request, the work story, limits and empty states', () => {
  const env = createStrictCspDom({ lang: 'en' });
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  const waiting = {
    provider: 'claude', key: 'claude/wait1', status: 'approval', title: 'Run the tests', updatedAt: now, waitSince: now - 120000,
    action: { kind: 'approval', token: 'tok-en', tool: 'Bash', detail: '{"command":"npm test","description":"Run the unit tests"}', cwd: '/demo',
      allow: true, deny: true, expiresAt: now + 45000 },
  };
  const working = {
    provider: 'codex', key: 'codex/w1', status: 'working', title: 'Retry backoff', updatedAt: now, workSince: now - 5 * 60000,
    prompt: 'Limit retries with exponential backoff', activity: { tool: 'apply_patch', target: 'src/retry.ts', at: now },
    plan: [{ text: 'Read the retry path', status: 'completed' }, { text: 'Cap retries at three', status: 'in_progress' }],
    progress: { done: 1, total: 2 }, changed: 2, changedFiles: ['src/retry.ts', 'src/idempotency.ts'],
    steps: [{ tool: 'apply_patch', target: 'src/retry.ts', at: now }, { tool: 'Read', target: 'src/retry.ts', at: now - 60000 }],
  };
  env.postFromHost(baseState({ sessions: [waiting, working], attentionCount: 1, elsewhere: [{ cwd: '/other', folder: 'other', input: 1, approval: 2 }],
    quotas: {
      claude: { status: 'ready', plan: 'Max', windows: [{ name: '', period: 300, kind: 'used', percent: 30, resetsAt: now + 90 * 60000 },
        { name: 'Opus', period: 10080, kind: 'used', percent: 95 }] },
      codex: { status: 'loading', windows: [] },
      agy: { status: 'unavailable', windows: [], message: 'Antigravity CLI 1.1.11 or later is required.' },
    } }));
  assert.equal(env.main.querySelector('.request')?.dataset.request, 'tok-en', 'the inline request opens by itself');
  const badge = env.main.querySelector('[data-key="claude/wait1"] .status');
  assert.equal(badge.querySelector('.status-text').textContent, 'Approval');
  assert.equal(badge.querySelector('.status-rest').textContent, 'needed');
  assert.equal(badge.textContent.trim(), 'Approval needed 2m');
  assert.equal(env.main.querySelector('.lens-btn[data-value="attention"]')?.getAttribute('aria-label'), 'Attention, 1 session');
  assert.equal(env.main.querySelector('.lens-btn[data-value="all"]')?.getAttribute('aria-label'), 'All, 2 sessions');
  assert.equal(env.main.querySelector('[data-key="codex/w1"] .mini-progress')?.title, '1 of 2 plan steps done (50%)');
  env.main.querySelector('[data-key="codex/w1"] .more').click();
  const stepLink = env.main.querySelector('[data-key="codex/w1"] .step-link');
  assert.equal(stepLink?.getAttribute('aria-label'), 'Read file · Open file src/retry.ts');
  const text = env.main.textContent;
  for (const shown of ['Needs attention', 'Run command', 'Command to run', 'Deny', 'Allow once', 'Open in chat',
    'Editing code', 'Work plan', 'Changed files', 'Earlier steps', '1m ago', 'Remaining limits', 'Other folders', '1 answer', '2 approvals', '5% Opus', 'Checking']) {
    assert.ok(text.includes(shown), 'shows ' + shown);
  }
  assert.doesNotMatch(text, /[가-힣]/, 'no Korean is left on an English page');
  const tile = env.main.querySelector('.quota-tile[data-provider="agy"]');
  assert.match(tile.getAttribute('aria-label'), /Antigravity CLI 1\.1\.11 or later is required\. · Show details$/);

  // Verify English singular/plural grammar across hidden-attention notice, 1-step plan, promoted subtask, and 5 quota windows.
  const promotedParent = {
    provider: 'codex', key: 'codex/p1', status: 'working', title: 'Main task', updatedAt: now, workSince: now - 60000,
    priorityTargetKey: 'codex/c1', progress: { done: 1, total: 1 },
  };
  const promotedChild = {
    provider: 'codex', key: 'codex/c1', isSubagent: true, parentKey: 'codex/p1', status: 'approval', title: 'Sub check',
    updatedAt: now, waitSince: now - 60000, preview: { tool: 'Bash', detail: '{"command":"ls"}' },
  };
  env.postFromHost(baseState({
    sessions: [waiting, working, promotedParent, promotedChild],
    attentionCount: 2,
    quotas: {
      claude: {
        status: 'ready', plan: 'Max',
        windows: [
          { name: '', period: 300, kind: 'used', percent: 30, resetsAt: now + 90 * 60000 },
          { name: '', period: 10080, kind: 'used', percent: 20, resetsAt: now + 3 * 86400000 },
          { name: 'Opus', period: 10080, kind: 'used', percent: 50 },
          { name: 'Sonnet', period: 10080, kind: 'used', percent: 40 },
          { name: 'Haiku', period: 10080, kind: 'used', percent: 10 },
        ],
      },
    },
  }));
  assert.equal(env.main.querySelector('[data-key="codex/p1"] .mini-progress')?.title, '1 of 1 plan step done (100%)');
  const subBadge = env.main.querySelector('[data-key="codex/p1"] .status');
  assert.equal(subBadge.querySelector('.status-prefix')?.textContent, 'Subtask:');
  assert.equal(subBadge.querySelector('.status-text')?.textContent, 'Approval');
  assert.equal(subBadge.querySelector('.status-rest')?.textContent, 'needed');
  assert.equal(subBadge.textContent.trim(), 'Subtask: Approval needed 1m');

  // Filter to working -> 1 waiting session hidden (promotedParent stays visible because it is working), then 2 hidden.
  env.main.querySelector('.lens-btn[data-value="working"]').click();
  assert.equal(env.main.querySelector('.filter-alert-text')?.textContent, '1 needs attention outside the filter');
  const waiting2 = { ...waiting, key: 'claude/wait2', title: 'Approve deploy', action: undefined, preview: { tool: 'Bash', detail: '{"command":"deploy"}' } };
  env.postFromHost(baseState({ sessions: [waiting, waiting2, working], attentionCount: 2 }));
  assert.equal(env.main.querySelector('.filter-alert-text')?.textContent, '2 need attention outside the filter');
  env.main.querySelector('.lens-btn[data-value="all"]').click();

  // Open quota overview to verify singular "1 more limit" and date-safe reset wording (no "Resets at <date>").
  env.postFromHost(baseState({
    sessions: [waiting],
    attentionCount: 1,
    quotas: {
      claude: {
        status: 'ready', plan: 'Max',
        windows: [
          { name: '', period: 300, kind: 'used', percent: 30, resetsAt: now + 90 * 60000 },
          { name: '', period: 10080, kind: 'used', percent: 20, resetsAt: now + 3 * 86400000 },
          { name: 'Opus', period: 10080, kind: 'used', percent: 50 },
          { name: 'Sonnet', period: 10080, kind: 'used', percent: 40 },
          { name: 'Haiku', period: 10080, kind: 'used', percent: 10 },
        ],
      },
    },
  }));
  const claudeTile = env.main.querySelector('.quota-tile[data-provider="claude"]');
  assert.doesNotMatch(claudeTile.title, /Resets at /);
  claudeTile.click();
  const moreLimits = env.main.querySelector('.quota-extra');
  assert.equal(moreLimits?.textContent, 'Show 1 more limit');
  assert.equal(moreLimits?.getAttribute('aria-label'), 'Claude Code: 1 more limit');
  env.main.querySelector('[data-control="quotaOverview"]').click();

  env.postFromHost(baseState({ sessions: [] }));
  assert.ok(env.main.textContent.includes('No sessions yet'));
  assert.doesNotMatch(env.main.textContent, /[가-힣]/);
});
