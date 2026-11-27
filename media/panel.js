// Panel entrypoint: owns UI state, host messaging, focus/reveal lifecycle,
// batched rendering, anti-misclick guard, event dispatch, and adaptive timers.
(() => {
  'use strict';
  const host = acquireVsCodeApi();
  const {
    sinceText, remainingText, resetInText, visible, isWait,
    requestToken, dismissKey, requestOrder, errorLabel,
  } = globalThis.AgentSessionFormat;
  const { t } = globalThis.AgentSessionI18n;
  const {
    providers, shortProviders, defaultOrder, specFor, resetLabel,
    element, button, brand, flashCopied, reconcile,
    allowMotion, observeWorkers, animateUpdate, enterEffects, play,
    visiblePositions, transitionKeys, cancelMoves, pauseAnimations, resumeAnimations,
    quotaHintForError, deriveView, countdownState, sessionList, group,
    commandBar, connectNotices, filterNotices, scanErrorNotice, hiddenAttentionNotice,
    skeletonState, emptyState, quotaFooter, toolbar,
  } = globalThis.AgentSessionPanel;

  const main = document.querySelector('#sessions');
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const chord = mac ? { allow: '⌃⌘↵', deny: '⌃⌘⌫' } : { allow: 'Ctrl+Alt+Enter', deny: 'Ctrl+Alt+Backspace' };
  const saved = host.getState() || {};
  const collapsed = new Set(saved.collapsed || []);
  const childExpansion = new Map(saved.childExpansion || []);
  let historyCollapsed = saved.historyCollapsed === true;
  let lens = ['all', 'attention', 'working'].includes(saved.lens) ? saved.lens : 'all';
  let providerFilter = ['all', 'claude', 'codex', 'agy'].includes(saved.providerFilter) ? saved.providerFilter : 'all';
  let searchOpen = providerFilter !== 'all';
  let searchQuery = '';
  const expandedPrompts = new Set();
  const settledChildExpansion = new Set();
  let allowReorderUntil = 0;
  const persist = () => host.setState({ collapsed: [...collapsed], childExpansion: [...childExpansion], historyCollapsed, lens, providerFilter });
  const extraLimits = new Set();
  // One request is open at a time: the most important one, until the user picks another.
  let focusToken;
  let awaitingFocus = false;
  let pendingPreempt = false;
  const dismissed = new Set();
  const drafts = new Map();
  const windowTotals = new Map();
  const decided = new Map();
  const sending = new Map();
  const sendingTimers = new Map();
  let refuseNotice;
  let refuseTimer;
  let previousInlineTokens = new Set();
  let announced;
  let announcedKey = '';
  let announcedVisible;
  let lastReportedFilter = '';
  let lastSpoken = '';
  let loaded = false;
  let expandedMenu;
  let quotaOverview = false;
  let groupedView = false;
  let heldPointer = false;
  let renderPending = false;
  let returnTile;
  let sessionScroll = 0;
  let hoverUntil = 0;
  let pendingOrder = false;
  let settleTimer;
  let countdownTimer;
  let previewNudgeTimer;
  let cardBox;
  let cardSettledAt = 0;
  let cardGuard = 450;
  let cardMoved = false;
  let cardWarned = false;
  let lastKeyPress = -Infinity;
  let keyHeld = false;
  let remotePress = false;
  let pointerAt;
  let pointerAtSettle;
  let userScrollUntil = 0;
  let state = { sessions: [], usage: {} };
  let lastState;
  let lastRev;

  const getDerived = (now = Date.now()) => deriveView(state, lens, providerFilter, searchQuery, now);
  const currentFilter = () => ({ lens, providerFilter, hasSearch: Boolean(searchQuery.trim()) });
  function reportView(type) {
    if (type === 'ready') {
      const f = currentFilter();
      lastReportedFilter = JSON.stringify(f);
      host.postMessage({ type, view: quotaOverview ? 'quotas' : 'sessions', ...f });
    } else {
      host.postMessage({ type, view: quotaOverview ? 'quotas' : 'sessions' });
    }
  }
  function reportFilter() {
    const f = currentFilter();
    const sig = JSON.stringify(f);
    if (sig === lastReportedFilter) return;
    lastReportedFilter = sig;
    host.postMessage({ type: 'filter', ...f });
  }

  const liveRegion = document.createElement('div');
  liveRegion.className = 'sr-only';
  liveRegion.setAttribute('role', 'status');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  document.body.append(liveRegion);
  function announceStatus(message) {
    if (!message) return;
    if (message === lastSpoken) {
      liveRegion.textContent = '';
      queueMicrotask(() => { liveRegion.textContent = message; });
    } else {
      lastSpoken = message;
      liveRegion.textContent = message;
    }
  }

  function draftFor(token, questions) {
    const draft = drafts.get(token);
    return draft?.length === questions.length ? draft : questions.map(() => new Set());
  }
  function setFocus(token) { focusToken = token; }
  const aiming = () => heldPointer || hoverUntil > performance.now() || Boolean(main.querySelector('.interaction:hover'));

  function syncFocus() {
    const now = Date.now();
    const derived = getDerived(now);
    const allSessions = state.sessions || [];
    const allTokens = new Set();
    const allWaiting = new Set();
    for (let i = 0; i < allSessions.length; i++) {
      const row = allSessions[i];
      const token = derived.tokenOf.get(row.key);
      if (token) allTokens.add(token);
      if (isWait(row)) allWaiting.add(dismissKey(row));
      if (row.action?.expiresAt && token && !windowTotals.has(token)) {
        windowTotals.set(token, Math.max(15000, row.action.expiresAt - now));
      }
    }
    // Prune request & expansion state against ALL sessions (never filtered views) so filtering preserves drafts.
    for (const key of dismissed) if (!allWaiting.has(key)) dismissed.delete(key);
    for (const token of drafts.keys()) if (!allTokens.has(token)) drafts.delete(token);
    for (const token of decided.keys()) if (!allTokens.has(token)) decided.delete(token);
    for (const token of sending.keys()) if (!allTokens.has(token)) {
      sending.delete(token);
      clearTimeout(sendingTimers.get(token));
      sendingTimers.delete(token);
    }
    for (const token of windowTotals.keys()) if (!allTokens.has(token)) windowTotals.delete(token);
    if (refuseNotice && !allTokens.has(refuseNotice.token)) {
      clearTimeout(refuseTimer);
      refuseNotice = undefined;
    }
    if (loaded && state.hasWorkspace) {
      for (const k of expandedPrompts) if (!derived.byKey.has(k)) expandedPrompts.delete(k);
      for (const k of settledChildExpansion) if (!derived.byKey.has(k)) settledChildExpansion.delete(k);
      for (const k of childExpansion.keys()) if (!derived.byKey.has(k)) childExpansion.delete(k);
    }
    const rows = derived.queue;
    const live = new Set();
    for (let i = 0; i < rows.length; i++) {
      const token = derived.tokenOf.get(rows[i].key);
      if (token) live.add(token);
    }
    if (pendingPreempt && focusToken?.startsWith('preview:') && !aiming()) {
      const urgent = rows.find(row => row.action && !dismissed.has(dismissKey(row)));
      pendingPreempt = false;
      if (urgent) {
        awaitingFocus = false;
        setFocus(derived.tokenOf.get(urgent.key));
        return;
      }
    }
    if (focusToken && live.has(focusToken)) {
      const wantPreempt = pendingPreempt && focusToken.startsWith('preview:') &&
        rows.some(row => row.action && !dismissed.has(dismissKey(row)));
      if (!wantPreempt) pendingPreempt = false;
      awaitingFocus = wantPreempt;
      if (awaitingFocus) scheduleSettle();
      return;
    }
    pendingPreempt = false;
    const next = rows.find(row => !dismissed.has(dismissKey(row)));
    awaitingFocus = Boolean(next) && aiming();
    setFocus(awaitingFocus || !next ? undefined : derived.tokenOf.get(next.key));
    if (awaitingFocus) scheduleSettle();
  }
  function closeFocus() {
    for (const row of getDerived().queue) dismissed.add(dismissKey(row));
    pendingPreempt = false;
    awaitingFocus = false;
    setFocus(undefined);
  }

  function focusKey(item) {
    if (!item || !main.contains(item)) return;
    return [
      item.closest('[data-provider]')?.dataset.provider, item.closest('[data-key]')?.dataset.key,
      item.closest('[data-request]')?.dataset.request, item.dataset.action || item.dataset.control || item.tagName, item.dataset.question,
      item.dataset.index || item.dataset.direction || item.dataset.value || item.dataset.cwd || item.dataset.file,
    ].join('|');
  }
  function interacting(focus) {
    return Boolean(
      (expandedMenu && (focus?.closest?.('.row-menu') || main.querySelector('.row-menu:hover'))) ||
      (focus?.closest?.('.session') && focus.matches(':focus-visible')) ||
      hoverUntil > performance.now() || main.querySelector('.interaction:hover')
    );
  }
  function isCardInView() {
    const region = main.querySelector('.scroll-region');
    const card = main.querySelector('.request');
    if (!region || !card) return false;
    const r = region.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    if (r.height <= 0 || c.height <= 0) return true;
    return c.bottom > r.top + 8 && c.top < r.bottom - 8;
  }
  function scheduleSettle() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      if (quotaOverview || (!pendingOrder && !awaitingFocus)) return;
      if (aiming()) { scheduleSettle(); return; }
      const opening = awaitingFocus;
      if (opening) syncFocus();
      if (!opening && interacting(document.activeElement)) { scheduleSettle(); return; }
      render(new Set());
      if (opening && focusToken) main.querySelector('.interaction')?.closest('.session')?.scrollIntoView({ block: 'nearest' });
    }, 950);
  }
  function reportRequest(derived = getDerived()) {
    const owner = quotaOverview || !focusToken ? undefined : derived.filtered.find(row => derived.tokenOf.get(row.key) === focusToken);
    const kind = owner && main.querySelector('.request') ? (owner.action ? owner.action.kind : 'preview') : '';
    const key = kind ? (owner?.key || '') : '';
    const visible = Boolean(kind) && isCardInView();
    if (kind === announced && key === announcedKey && visible === announcedVisible) return;
    announced = kind;
    announcedKey = key;
    announcedVisible = visible;
    host.postMessage({ type: 'request', kind, key, visible });
  }

  function exposeRequest(token, derived) {
    const row = state.sessions.find(r => (derived ? derived.tokenOf.get(r.key) : requestToken(r)) === token);
    if (!row || !collapsed.delete(row.provider)) return false;
    persist();
    return true;
  }

  function render(changes, { fromHost = false, keepGuard = false } = {}) {
    const now = Date.now();
    const derived = getDerived(now);
    if (focusToken && !quotaOverview) exposeRequest(focusToken, derived);
    const focus = document.activeElement;
    const previous = focusKey(focus);
    const focusRow = focus?.closest('[data-key]')?.dataset.key;
    const focusProvider = focus?.closest('[data-provider]')?.dataset.provider;
    const old = main.querySelector('.scroll-region');
    const oldMode = old?.dataset.mode;
    const motion = changes != null && allowMotion() && oldMode === 'sessions' && !quotaOverview;
    // Batch all DOM layout reads before any writes to avoid forced synchronous reflows.
    const keepScroll = old?.scrollTop ?? 0;
    if (oldMode === 'sessions') sessionScroll = keepScroll;
    const before = motion ? visiblePositions(old) : null;
    const anchor = oldMode === 'sessions' && !quotaOverview ? cardPlace() : undefined;
    const freeze = fromHost && performance.now() > allowReorderUntil && interacting(focus);
    if (motion) cancelMoves();
    const scroller = element('div', 'scroll-region');
    scroller.dataset.mode = quotaOverview ? 'quotas' : 'sessions';
    scroller.setAttribute('role', 'region');
    scroller.setAttribute('aria-label', quotaOverview ? t('Subscription limit details') : t('Workspace sessions'));
    scroller.tabIndex = 0;
    const shownRows = quotaOverview || !loaded ? [] : derived.filtered;
    const localFiltered = lens !== 'all' || providerFilter !== 'all' || Boolean(searchQuery.trim());
    groupedView = !quotaOverview && loaded && Boolean(state.hasWorkspace) && (state.preferences?.sort || 'priority') !== 'priority';
    const ctx = {
      state, derived, now, chord, draftFor, focusToken, expandedMenu, expandedPrompts,
      childExpansion, settledChildExpansion, collapsed, historyCollapsed, extraLimits,
      quotaOverview, groupedView, lens, providerFilter, searchOpen, searchQuery, windowTotals,
      sending, refuseNotice,
      quotaHintForError: row => quotaHintForError(row, derived.quotaHints, now),
    };
    if (!quotaOverview && !loaded) {
      scroller.append(skeletonState());
    } else {
      if (!quotaOverview) scroller.append(...scanErrorNotice(state), ...connectNotices(state), ...filterNotices(state));
      if (!quotaOverview && state.hasWorkspace && (state.preferences?.sort || 'priority') === 'priority') {
        if (shownRows.length) scroller.append(sessionList(shownRows, true, ctx));
      } else if (quotaOverview || state.hasWorkspace) {
        const order = quotaOverview ? defaultOrder : (state.preferences?.providerOrder || defaultOrder);
        for (const id of order) {
          const spec = specFor(id);
          const filteredOut = !quotaOverview && (state.preferences?.attentionOnly || localFiltered) && !shownRows.some(row => row.provider === id);
          if (spec && !filteredOut) scroller.append(group(spec[0], spec[1], spec[2], shownRows, ctx));
        }
      }
      if (!quotaOverview && !shownRows.length) {
        if (!state.hasWorkspace) {
          if (state.isRemoteWorkspace) {
            scroller.append(emptyState('folder', t('Available in local folders'), t('A remote window cannot monitor local agent sessions.')));
          } else {
            scroller.append(emptyState('folder', t('Open a folder'), t('Open a folder in VS Code and its agent sessions gather here.')));
          }
        } else if (localFiltered && state.sessions.length) {
          const reset = button('mini accent', t('Reset filters'), t('Show all sessions'));
          reset.dataset.control = 'resetFilters';
          const title = searchQuery.trim() ? t('No matching sessions') : lens === 'attention' ? t('Nothing needs attention') : t('No work in progress');
          const desc = searchQuery.trim() ? t('Try a different search or agent filter.') : t('Every waiting request is handled, or no session is running.');
          scroller.append(emptyState(searchQuery.trim() ? 'search' : 'check', title, desc, [reset]));
        } else if (state.preferences?.attentionOnly) {
          scroller.append(emptyState('check', t('All caught up'), t('No session is waiting for an answer or approval.')));
        } else if (state.hiddenCompleted) {
          scroller.append(emptyState('check', t('Finished sessions are hidden'), t('You can show them again from Sort & Filter.')));
        } else {
          const launchers = providers
            .filter(([id]) => state.connections?.[id] !== 'absent')
            .map(([id, name, mono]) => {
              const pill = button('launch-pill', t('Start a new {0} session', name));
              pill.dataset.action = 'start';
              pill.dataset.provider = id;
              pill.append(brand(id, mono), document.createTextNode(t('Start {0}', shortProviders[id])));
              return pill;
            });
          scroller.append(emptyState('inbox', t('No sessions yet'), t('Start an agent below and its work shows up here as it happens.'), launchers));
        }
      }
    }
    main.dataset.mode = scroller.dataset.mode;
    const showCommandBar = !quotaOverview && loaded && state.hasWorkspace && (state.sessions.length > 0 || localFiltered || searchOpen);
    const hiddenAlerts = !quotaOverview && loaded ? hiddenAttentionNotice(ctx) : [];
    const children = !loaded && !quotaOverview
      ? [scroller]
      : quotaOverview ? [toolbar(), scroller]
        : [...(showCommandBar ? [commandBar(ctx)] : []), ...hiddenAlerts, scroller, quotaFooter(ctx)];
    reconcile(main, children, freeze, quotaOverview);
    const region = main.querySelector('.scroll-region');
    region.scrollTop = quotaOverview ? (oldMode === 'quotas' ? keepScroll : 0) : sessionScroll;
    const placed = anchor && cardPlace();
    if (placed && placed.token === anchor.token && Math.abs(placed.top - anchor.top) >= 1) {
      region.scrollTop += placed.top - anchor.top;
      sessionScroll = region.scrollTop;
    }
    observeWorkers(main);
    if (motion) animateUpdate(before, visiblePositions(region), changes || new Set(), freeze);
    markClipped();
    trackCard(keepGuard);
    enterEffects(main);
    syncCountdownTimer(Boolean(main.querySelector('time[data-expires], [data-expires-bar]')));
    pendingOrder = freeze && !quotaOverview;
    if (pendingOrder) scheduleSettle();
    if (previous && !main.contains(document.activeElement)) {
      const items = [...main.querySelectorAll('button,input,[tabindex="0"],.opener')];
      const ofRow = item => item.closest('[data-key]')?.dataset.key === focusRow && !item.closest('.request');
      const target = items.find(item => focusKey(item) === previous && !item.disabled) ||
        items.find(item => item.dataset.control === 'request' && ofRow(item)) ||
        items.find(item => item.matches('.opener') && ofRow(item)) ||
        items.find(item => item.dataset.control === 'group' && item.closest('[data-provider]')?.dataset.provider === focusProvider) ||
        (focusRow ? items.find(item => item.dataset.control === 'history') || region : undefined);
      target?.focus({ preventScroll: true });
    }
    reportRequest(derived);
  }

  function toggleOverview(provider, fromKeyboard = false) {
    if (!quotaOverview) returnTile = provider;
    quotaOverview = !quotaOverview;
    reportView('view');
    render();
    const returnControl = main.querySelector('[data-control="quotaOverview"]');
    if (quotaOverview && provider) {
      const section = main.querySelector('.provider[data-provider="' + provider + '"]');
      section?.scrollIntoView({ block: 'start' });
      if (fromKeyboard) (section?.querySelector('.quota-refresh:not(:disabled)') || returnControl)?.focus({ preventScroll: true });
    } else if (!quotaOverview && returnTile) {
      if (fromKeyboard) main.querySelector('.quota-tile[data-provider="' + returnTile + '"]')?.focus({ preventScroll: true });
    } else if (fromKeyboard) returnControl?.focus({ preventScroll: true });
  }
  const requestButton = token => [...main.querySelectorAll('[data-control="request"]')].find(b => b.dataset.token === token);

  function revealRequest(key, token) {
    const row = getDerived().byKey.get(key);
    if (quotaOverview || !row?.action || row.action.token !== token) return;
    if (lens === 'working' || (providerFilter !== 'all' && providerFilter !== row.provider) || searchQuery.trim()) {
      lens = 'all'; providerFilter = 'all'; searchQuery = '';
      persist();
      reportFilter();
    }
    dismissed.delete(dismissKey(row));
    pendingPreempt = false;
    awaitingFocus = false;
    setFocus(token);
    render(new Set());
    const control = requestButton(token);
    control?.focus({ preventScroll: true });
    control?.closest('.session')?.scrollIntoView({ block: 'nearest' });
  }

  function revealSession(key) {
    if (typeof key !== 'string' || !key) return;
    const derived = getDerived();
    const row = derived.byKey.get(key);
    if (!row) return;
    if (quotaOverview) {
      quotaOverview = false;
      reportView('view');
    }
    let filterReset = false;
    if (lens !== 'all' || providerFilter !== 'all' || searchQuery.trim()) {
      lens = 'all'; providerFilter = 'all'; searchQuery = ''; searchOpen = false;
      filterReset = true;
    }
    let layoutChanged = filterReset;
    if (collapsed.delete(row.provider)) layoutChanged = true;
    if (historyCollapsed) { historyCollapsed = false; layoutChanged = true; }
    if (row.isSubagent) {
      const visited = new Set([row.key]);
      let parent = derived.byKey.get(row.parentKey);
      while (parent && !visited.has(parent.key)) {
        visited.add(parent.key);
        if (childExpansion.get(parent.key) !== true) {
          childExpansion.set(parent.key, true);
          layoutChanged = true;
        }
        settledChildExpansion.add(parent.key);
        parent = parent.isSubagent ? derived.byKey.get(parent.parentKey) : undefined;
      }
    }
    if (layoutChanged) persist();
    if (filterReset) reportFilter();
    const token = derived.tokenOf.get(row.key);
    if (token) {
      dismissed.delete(dismissKey(row));
      awaitingFocus = false;
      setFocus(token);
    } else {
      expandedMenu = row.key;
    }
    render(new Set([row.key]));
    const rowEl = [...main.querySelectorAll('.session')].find(el => el.dataset.key === key);
    const targetFocus = token ? requestButton(token) : rowEl?.querySelector(':scope > .title-line > .opener');
    rowEl?.scrollIntoView({ behavior: allowMotion() ? 'smooth' : 'auto', block: 'nearest' });
    targetFocus?.focus({ preventScroll: true });
  }

  // Anti-misclick guard & decision helpers.
  function cardPlace() {
    const card = main.querySelector('.request');
    return card ? { token: card.dataset.request, top: card.getBoundingClientRect().top } : undefined;
  }
  function decideOpen(action) {
    const card = quotaOverview ? undefined : main.querySelector('.request');
    if (!card) return false;
    const control = action === 'deny' ? card.querySelector('button[data-action="deny"]') :
      card.querySelector('button[data-action="approve"]') || card.querySelector('.actions button[data-action="answer"]');
    if (!control || control.disabled) return false;
    pressFor(control);
    return true;
  }
  function pressFor(control) {
    remotePress = true;
    try { control.click(); } finally { remotePress = false; }
  }
  function showing(node, x, y) {
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit) && node.contains(hit);
  }
  function inFront(control) {
    const box = control.getBoundingClientRect();
    if (!showing(control, box.left + box.width / 2, box.top + box.height / 2)) return false;
    const card = control.closest('.request');
    const subject = control.closest('.question-group')?.querySelector('.question') ||
      (card && [...card.querySelectorAll('.request-content, .question-group')].at(-1));
    if (!subject) return true;
    const about = subject.getBoundingClientRect();
    const x = about.left + Math.min(about.width / 2, 40);
    return showing(card, x, about.bottom - 4) && showing(card, x, Math.max(about.top + 4, about.bottom - 44));
  }
  function trackCard(byUser) {
    const node = quotaOverview ? null : main.querySelector('.request');
    const token = node?.dataset.request;
    const rect = node?.getBoundingClientRect();
    const isNew = Boolean(node) && (!cardBox || cardBox.token !== token);
    const shifted = Boolean(node) && !isNew && (
      cardBox.node !== node ||
      Math.abs(cardBox.top - rect.top) > 1 ||
      Math.abs(cardBox.left - rect.left) > 1 ||
      Math.abs(cardBox.height - rect.height) > 1
    );
    if (isNew || (shifted && !byUser)) {
      cardSettledAt = performance.now();
      pointerAtSettle = pointerAt && { ...pointerAt };
      cardMoved = shifted;
      cardWarned = false;
      cardGuard = shifted && hoverUntil > cardSettledAt ? 900 : 450;
    }
    cardBox = node ? { node, token, top: rect.top, left: rect.left, height: rect.height } : undefined;
  }
  function steady(event, control) {
    const now = performance.now();
    const still = now - cardSettledAt;
    if (event.pointerType) {
      if (still < cardGuard) return false;
      if (pointerAtSettle && !cardWarned && still < (cardMoved ? 2000 : 1200)) {
        return Math.hypot(event.clientX - pointerAtSettle.x, event.clientY - pointerAtSettle.y) >= 4;
      }
      return true;
    }
    const again = now - lastKeyPress < 1100;
    lastKeyPress = now;
    if (again || (keyHeld && !remotePress)) return false;
    if (still < (remotePress ? 1000 : 450)) return false;
    if (inFront(control)) return true;
    control.closest('.session')?.scrollIntoView({ block: 'end' });
    return false;
  }
  function decisionAllowed(event, token, control) {
    const request = state.sessions.find(row => row.action?.token === token)?.action;
    if (!request || (request.expiresAt && Date.now() >= request.expiresAt)) return false;
    return steady(event, control);
  }
  function refuse(control) {
    if (performance.now() - cardSettledAt >= cardGuard) cardWarned = true;
    if (allowMotion()) {
      play(control, [{ transform: 'translateX(0)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }],
        { duration: 240, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    }
    const token = control.closest('.request')?.dataset.request;
    const message = t('This request just appeared or moved. Check it, then press again.');
    if (token) {
      refuseNotice = { token, message };
      clearTimeout(refuseTimer);
      refuseTimer = setTimeout(() => {
        refuseTimer = undefined;
        if (refuseNotice?.token === token) {
          refuseNotice = undefined;
          render(undefined, { keepGuard: true });
        }
      }, 4000);
      render(undefined, { keepGuard: true });
    }
    announceStatus(message);
  }
  function nudgePreview(card, { focusCta = false } = {}) {
    const banner = card?.querySelector('.preview-banner');
    const cta = card?.querySelector('.preview-cta');
    if (banner) {
      banner.classList.add('is-nudged');
      clearTimeout(previewNudgeTimer);
      previewNudgeTimer = setTimeout(() => {
        for (const el of main.querySelectorAll('.preview-banner.is-nudged')) el.classList.remove('is-nudged');
      }, 1400);
      announceStatus(banner.textContent);
    }
    if (cta) {
      if (allowMotion()) play(cta, [{ transform: 'scale(1)' }, { transform: 'scale(1.015)' }, { transform: 'scale(1)' }], { duration: 240, easing: 'cubic-bezier(.22, 1, .36, 1)' });
      if (focusCta) cta.focus({ preventScroll: true });
    }
  }

  // A block cut off at the bottom says so in its own words; the stylesheet shows them.
  function clip(block, clipped) {
    block.classList.toggle('clipped', clipped);
    if (clipped) block.dataset.more = t('More below · Scroll to the end to review');
  }
  // Batched reads-before-writes to avoid layout thrashing across multiple code/diff blocks.
  function markClipped() {
    const blocks = main.querySelectorAll('.payload');
    if (!blocks.length) return;
    const states = new Array(blocks.length);
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      states[i] = b.scrollHeight - b.clientHeight - b.scrollTop > 2;
    }
    for (let i = 0; i < blocks.length; i++) clip(blocks[i], states[i]);
  }
  new ResizeObserver(markClipped).observe(main);

  function holdTarget() {
    heldPointer = true;
    pauseAnimations();
  }
  function notePointer(event) {
    if (pointerAt && pointerAt.x === event.clientX && pointerAt.y === event.clientY) return;
    pointerAt = { x: event.clientX, y: event.clientY };
  }
  main.addEventListener('pointerdown', e => {
    notePointer(e);
    if (e.button === 0) holdTarget();
    if (e.target.matches?.('.scroll-region, .payload')) userScrollUntil = Infinity;
  });
  main.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('button')) holdTarget(); });
  window.addEventListener('keyup', () => { if (heldPointer) setTimeout(releasePointer, 0); });
  window.addEventListener('keydown', e => { keyHeld = e.repeat; }, true);
  window.addEventListener('keyup', () => { keyHeld = false; }, true);
  window.addEventListener('blur', () => { keyHeld = false; });
  main.addEventListener('pointermove', e => {
    notePointer(e);
    if (e.pointerType !== 'touch' && e.target.closest?.('.scroll-region')) hoverUntil = performance.now() + 900;
  });
  main.addEventListener('pointerleave', () => { hoverUntil = 0; pointerAt = undefined; });
  const userScroll = () => { if (userScrollUntil !== Infinity) userScrollUntil = performance.now() + 300; };
  main.addEventListener('wheel', userScroll, { passive: true });
  main.addEventListener('touchmove', userScroll, { passive: true });
  main.addEventListener('keydown', e => {
    if (['PageDown', 'PageUp', ' '].includes(e.key) ||
      (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && e.target.matches?.('.scroll-region, .payload'))) {
      userScroll();
    }
  });
  main.addEventListener('scroll', e => {
    if (e.target.matches?.('.payload')) {
      const b = e.target;
      clip(b, b.scrollHeight - b.clientHeight - b.scrollTop > 2);
      return;
    }
    trackCard(performance.now() < userScrollUntil);
    reportRequest();
  }, true);
  main.addEventListener('focusout', e => {
    if (e.target.closest('.session') && !e.relatedTarget?.closest('.session')) {
      requestAnimationFrame(() => {
        if (!heldPointer && !quotaOverview && (pendingOrder || awaitingFocus)) {
          if (awaitingFocus) syncFocus();
          render();
        }
      });
    }
  });
  function releasePointer() {
    heldPointer = false;
    resumeAnimations();
    if (userScrollUntil === Infinity) userScrollUntil = performance.now() + 300;
    if (renderPending) { renderPending = false; syncFocus(); render(); }
  }
  window.addEventListener('pointerup', () => setTimeout(releasePointer, 0));
  window.addEventListener('pointercancel', releasePointer);
  window.addEventListener('blur', releasePointer);

  main.addEventListener('input', event => {
    if (event.target.dataset?.control !== 'searchInput') return;
    searchQuery = event.target.value;
    reportFilter();
    syncFocus();
    render();
  });

  // Dispatch tables for UI controls and host actions.
  const CONTROL_HANDLERS = {
    quotaOverview: ({ provider, event }) => toggleOverview(provider, event.detail === 0),
    quotaTile: ({ provider, event }) => toggleOverview(provider, event.detail === 0),
    lens: ({ item }) => {
      lens = item.dataset.value;
      persist(); reportFilter(); syncFocus(); render();
    },
    searchToggle: () => {
      searchOpen = !searchOpen;
      if (!searchOpen) { searchQuery = ''; providerFilter = 'all'; persist(); reportFilter(); }
      syncFocus(); render();
      if (searchOpen) main.querySelector('.search-input')?.focus();
    },
    clearSearch: () => {
      searchQuery = '';
      reportFilter(); syncFocus(); render();
      main.querySelector('.search-input')?.focus();
    },
    providerFilter: ({ item }) => {
      providerFilter = item.dataset.value;
      persist(); reportFilter(); syncFocus(); render();
    },
    resetFilters: () => {
      lens = 'all'; providerFilter = 'all'; searchQuery = ''; searchOpen = false;
      persist(); reportFilter(); syncFocus(); render();
    },
    showHiddenAttention: () => {
      const derived = getDerived();
      const hiddenWaiting = (state.sessions || []).filter(r => isWait(r) && !derived.filteredKeys.has(r.key));
      const first = requestOrder(hiddenWaiting)[0] || hiddenWaiting[0];
      lens = 'all'; providerFilter = 'all'; searchQuery = ''; searchOpen = false;
      if (first) collapsed.delete(first.provider);
      persist(); reportFilter();
      const token = first && derived.tokenOf.get(first.key);
      if (token) {
        dismissed.delete(dismissKey(first));
        pendingPreempt = false;
        awaitingFocus = false;
        setFocus(token);
      } else syncFocus();
      render(new Set());
      const targetEl = first && [...main.querySelectorAll('.session')].find(el => el.dataset.key === first.key);
      targetEl?.scrollIntoView({ behavior: allowMotion() ? 'smooth' : 'auto', block: 'nearest' });
    },
    queueStep: ({ item, event }) => {
      const derived = getDerived();
      const queue = derived.queue;
      if (queue.length < 2) return;
      const at = queue.findIndex(r => derived.tokenOf.get(r.key) === focusToken);
      const delta = item.dataset.direction === 'prev' ? -1 : 1;
      const nextRow = queue[(Math.max(0, at) + delta + queue.length) % queue.length];
      const nextToken = derived.tokenOf.get(nextRow.key);
      if (!nextToken) return;
      dismissed.delete(dismissKey(nextRow));
      pendingPreempt = false;
      awaitingFocus = false;
      setFocus(nextToken);
      render(new Set());
      const ctrl = requestButton(nextToken);
      ctrl?.closest('.session')?.scrollIntoView({ behavior: allowMotion() ? 'smooth' : 'auto', block: 'nearest' });
      if (event.detail === 0) {
        main.querySelector('.request .queue-step[data-direction="' + item.dataset.direction + '"]')?.focus({ preventScroll: true });
      }
    },
    copy: ({ item }) => {
      const value = item.dataset.copy;
      if (value && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(value).then(() => flashCopied(item), () => {});
      }
    },
    expandPrompt: ({ item }) => {
      const k = item.dataset.target;
      if (expandedPrompts.has(k)) expandedPrompts.delete(k); else expandedPrompts.add(k);
      render();
    },
    request: ({ item }) => {
      const token = item.dataset.token;
      if (focusToken === token) closeFocus();
      else {
        const derived = getDerived();
        const row = state.sessions.find(r => derived.tokenOf.get(r.key) === token);
        if (row) dismissed.delete(dismissKey(row));
        pendingPreempt = false;
        awaitingFocus = false;
        setFocus(token);
      }
      render(new Set());
    },
    choice: ({ item }) => {
      const token = item.closest('[data-request]')?.dataset.request;
      const questions = state.sessions.find(row => row.action?.token === token)?.action.questions;
      const at = Number(item.dataset.question), index = Number(item.dataset.index);
      if (!questions?.[at]) return;
      const draft = draftFor(token, questions);
      if (!questions[at].multiSelect) { const had = draft[at].has(index); draft[at].clear(); if (!had) draft[at].add(index); }
      else if (!draft[at].delete(index)) draft[at].add(index);
      drafts.set(token, draft);
      render();
    },
    group: ({ provider }) => {
      if (collapsed.has(provider)) collapsed.delete(provider);
      else {
        const derived = getDerived();
        if (state.sessions.some(row => row.provider === provider && derived.tokenOf.get(row.key) === focusToken)) closeFocus();
        collapsed.add(provider);
      }
      persist(); render();
    },
    history: () => { historyCollapsed = !historyCollapsed; persist(); render(); },
    children: ({ item, key }) => {
      childExpansion.set(key, item.getAttribute('aria-expanded') !== 'true');
      persist(); render(new Set());
    },
    settledChildren: ({ key }) => {
      if (settledChildExpansion.has(key)) settledChildExpansion.delete(key); else settledChildExpansion.add(key);
      render(new Set());
    },
    extraLimits: ({ provider }) => {
      if (extraLimits.has(provider)) extraLimits.delete(provider); else extraLimits.add(provider);
      render();
    },
    more: ({ key }) => {
      expandedMenu = expandedMenu === key ? undefined : key;
      render();
    },
  };

  const ACTION_HANDLERS = {
    refresh: () => host.postMessage({ action: 'refresh' }),
    newSession: () => host.postMessage({ action: 'newSession' }),
    openFolder: ({ item }) => host.postMessage({ action: 'openFolder', cwd: item.dataset.cwd }),
    openFile: ({ item, provider, key }) => host.postMessage({ action: 'openFile', provider, key, file: item.dataset.file }),
    markAllSeen: () => { allowReorderUntil = performance.now() + 1200; host.postMessage({ action: 'markAllSeen' }); },
    markSeen: ({ item, provider, key }) => {
      allowReorderUntil = performance.now() + 1200;
      host.postMessage({ action: 'markSeen', provider, key, replyAt: Number(item.dataset.replyAt) });
    },
    ackError: ({ item, provider, key }) => {
      allowReorderUntil = performance.now() + 1200;
      host.postMessage({ action: 'ackError', provider, key, updatedAt: Number(item.dataset.updatedAt) });
    },
    setHideCompleted: ({ item }) => {
      allowReorderUntil = performance.now() + 1200;
      host.postMessage({ action: 'setHideCompleted', value: item.dataset.value === 'true' });
    },
    setAttentionOnly: ({ item }) => {
      allowReorderUntil = performance.now() + 1200;
      host.postMessage({ action: 'setAttentionOnly', value: item.dataset.value === 'true' });
    },
    setPinned: ({ item, provider, key }) => {
      allowReorderUntil = performance.now() + 1200;
      host.postMessage({ action: 'setPinned', provider, key, value: item.dataset.value === 'true' });
    },
    moveProvider: ({ item, provider }) => host.postMessage({ action: 'moveProvider', provider, direction: item.dataset.direction }),
  };

  function markSending(token, action) {
    decided.set(token, performance.now());
    sending.set(token, action);
    if (refuseNotice?.token === token) {
      clearTimeout(refuseTimer);
      refuseNotice = undefined;
    }
    clearTimeout(sendingTimers.get(token));
    sendingTimers.set(token, setTimeout(() => {
      sendingTimers.delete(token);
      if (sending.delete(token)) render(undefined, { keepGuard: true });
    }, 4000));
    render(undefined, { keepGuard: true });
  }

  main.addEventListener('click', event => {
    const item = event.target.closest('button');
    if (!item) {
      const previewChoice = event.target.closest?.('.request.is-preview .choice-static');
      if (previewChoice && !window.getSelection?.()?.toString()) {
        nudgePreview(previewChoice.closest('.request'));
      }
      return;
    }
    if (!main.contains(item)) return;
    const provider = item.dataset.provider || item.closest('[data-provider]')?.dataset.provider;
    const key = item.dataset.target || item.closest('[data-key]')?.dataset.key;
    const control = item.dataset.control;
    if (control && Object.hasOwn(CONTROL_HANDLERS, control)) {
      CONTROL_HANDLERS[control]({ item, event, provider, key });
      return;
    }
    const action = item.dataset.action;
    if (!action) return;
    if (Object.hasOwn(ACTION_HANDLERS, action)) {
      ACTION_HANDLERS[action]({ item, event, provider, key });
      return;
    }
    const token = item.closest('[data-request]')?.dataset.request;
    if (action === 'approve' || action === 'deny' || action === 'answer') {
      if (performance.now() - (decided.get(token) ?? -Infinity) < 4000) {
        if (!event.pointerType) lastKeyPress = performance.now();
        return;
      }
      if (!decisionAllowed(event, token, item)) { refuse(item); return; }
      if (action === 'answer') {
        const questions = state.sessions.find(row => row.action?.token === token)?.action.questions;
        if (!questions) return;
        const answers = item.dataset.index !== undefined ? [[Number(item.dataset.index)]] :
          draftFor(token, questions).map(picked => [...picked].sort((a, b) => a - b));
        if (answers.some(picked => !picked.length)) return;
        markSending(token, action);
        host.postMessage({ action, provider, key, token, answers });
        return;
      }
      markSending(token, action);
    } else if (action === 'defer' && item.closest('.request') && !steady(event, item)) {
      refuse(item);
      return;
    }
    if (action === 'dismiss' || action === 'dismissChildren') allowReorderUntil = performance.now() + 1200;
    host.postMessage({ action, provider, key, token });
  });

  document.body.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (quotaOverview) { toggleOverview(undefined, true); return; }
    const insideMenu = Boolean(event.target.closest?.('.row-menu'));
    const insideRequest = Boolean(event.target.closest?.('[data-request]'));
    if (expandedMenu && (insideMenu || !searchOpen)) {
      const closedKey = expandedMenu;
      expandedMenu = undefined;
      render();
      if (insideMenu) {
        const rowEl = [...main.querySelectorAll('.session')].find(el => el.dataset.key === closedKey);
        rowEl?.querySelector(':scope > .title-line .more')?.focus();
      }
      return;
    }
    if (focusToken && (insideRequest || !searchOpen)) {
      const token = focusToken;
      closeFocus();
      render(new Set());
      if (insideRequest) requestButton(token)?.focus();
      return;
    }
    if (searchOpen) {
      if (searchQuery) { searchQuery = ''; reportFilter(); syncFocus(); render(); main.querySelector('.search-input')?.focus(); return; }
      searchOpen = false; providerFilter = 'all'; persist(); reportFilter(); syncFocus(); render();
      main.querySelector('.search-toggle')?.focus();
      return;
    }
    if (expandedMenu) { expandedMenu = undefined; render(); return; }
    if (focusToken) {
      const token = focusToken;
      closeFocus();
      render(new Set());
      if (insideRequest) requestButton(token)?.focus();
    }
  });

  // Panel-focused shortcuts: '/' opens search, 'i' inspects focused session, 1-9 picks option, exact chord decides.
  document.body.addEventListener('keydown', event => {
    if (quotaOverview || event.target.closest?.('input, textarea, [contenteditable]')) return;
    const decideChord = mac
      ? (event.ctrlKey && event.metaKey && !event.altKey)
      : (event.ctrlKey && event.altKey && !event.metaKey);
    if (decideChord && (event.key === 'Enter' || event.key === 'Backspace')) {
      if (event.repeat || decideOpen(event.key === 'Enter' ? 'approve' : 'deny')) event.preventDefault();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.code === 'KeyI' || event.key === 'i' || event.key === 'I') && !event.repeat) {
      const row = event.target.closest?.('.session');
      if (row && !event.target.closest('.interaction')) {
        event.preventDefault();
        expandedMenu = expandedMenu === row.dataset.key ? undefined : row.dataset.key;
        render();
        return;
      }
    }
    if (event.shiftKey) return;
    if (event.key === '/' && state.hasWorkspace && state.sessions.length) {
      event.preventDefault();
      searchOpen = true;
      render();
      main.querySelector('.search-input')?.focus();
      return;
    }
    if (!/^[1-9]$/.test(event.key)) return;
    const option = main.querySelector('.request .choice[data-hotkey="' + event.key + '"]');
    if (!option) {
      const previewCard = main.querySelector('.request.is-preview');
      if (previewCard?.querySelector('.choices.readonly')) {
        event.preventDefault();
        if (!event.repeat) nudgePreview(previewCard, { focusCta: true });
      }
      return;
    }
    event.preventDefault();
    if (event.repeat) return;
    if (option.dataset.control === 'choice' && !inFront(option)) {
      option.closest('.session')?.scrollIntoView({ block: 'end' });
      return;
    }
    pressFor(option);
  });

  document.body.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || quotaOverview) return;
    const from = event.target;
    if (from?.matches?.('.search-input')) {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== 'ArrowDown' && event.key !== 'Enter') return;
      const target = [...main.querySelectorAll('.scroll-region .title-line > .opener')].find(item => item.offsetParent) ||
        main.querySelector('.filter-alert-btn');
      if (!target) return;
      event.preventDefault();
      target.focus();
      target.closest('.session')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const bodyFocused = from === document.body || from === main;
    const region = bodyFocused ? main.querySelector('.scroll-region') : from.closest?.('.scroll-region');
    if (!region || (!bodyFocused && from.closest?.('.interaction, .row-menu, .connect'))) return;
    const openers = [...region.querySelectorAll('.title-line > .opener')].filter(item => item.offsetParent);
    if (!openers.length) return;
    const row = bodyFocused ? null : from.closest?.('.session');
    const current = row?.querySelector(':scope > .title-line > .opener');
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (from.matches?.('.group-toggle, .section-toggle, .child-bucket-toggle')) {
        event.preventDefault();
        if ((from.getAttribute('aria-expanded') === 'true') !== (event.key === 'ArrowRight')) from.click();
        return;
      }
      const toggle = row?.querySelector(':scope > .title-line .children-toggle');
      if (!toggle || from !== current) return;
      event.preventDefault();
      if ((toggle.getAttribute('aria-expanded') === 'true') !== (event.key === 'ArrowRight')) toggle.click();
      return;
    }
    const at = openers.indexOf(current);
    const down = event.key === 'ArrowDown';
    if (at === 0 && event.key === 'ArrowUp' && searchOpen) {
      const input = main.querySelector('.search-input');
      if (input) { event.preventDefault(); input.focus(); return; }
    }
    const after = bodyFocused ? 0 : openers.findIndex(item => from.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING);
    const nearest = (bodyFocused || from === region) ? (down ? 0 : openers.length - 1) : down ? after : (after < 0 ? openers.length : after) - 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? openers.length - 1 : at < 0 ? nearest : at + (down ? 1 : -1);
    if (next < 0 || next >= openers.length) return;
    event.preventDefault();
    openers[next].focus();
  });

  // Adaptive timers: 1s interval runs ONLY while a countdown is rendered; 15s updates minute labels.
  function tickCountdowns() {
    if (document.hidden) return;
    const now = Date.now();
    const times = main.querySelectorAll('time[data-expires]');
    const bars = main.querySelectorAll('[data-expires-bar]');
    if (!times.length && !bars.length) { syncCountdownTimer(false); return; }
    for (const node of times) {
      const exp = Number(node.dataset.expires);
      const value = remainingText(exp, now);
      if (node.textContent !== value) node.textContent = value;
      const left = Math.max(0, exp - now);
      node.classList.toggle('urgent', left > 5000 && left <= 15000);
      node.classList.toggle('critical', left <= 5000);
      if (now >= exp) {
        for (const control of node.closest('.session')?.querySelectorAll(
          '[data-action="approve"], [data-action="deny"], [data-action="answer"], [data-control="choice"]') || []) control.disabled = true;
      }
    }
    for (const fill of bars) {
      const { pct, cls } = countdownState(Number(fill.dataset.expiresBar), fill.dataset.expiresToken, now, windowTotals);
      fill.style.transform = 'scaleX(' + Number((pct / 100).toFixed(4)) + ')';
      fill.classList.toggle('urgent', cls === 'urgent');
      fill.classList.toggle('critical', cls === 'critical');
    }
  }
  function syncCountdownTimer(active) {
    if (active && !countdownTimer) countdownTimer = setInterval(tickCountdowns, 1000);
    else if (!active && countdownTimer) { clearInterval(countdownTimer); countdownTimer = undefined; }
  }
  function tickMinuteLabels() {
    if (document.hidden) return;
    const now = Date.now();
    for (const node of main.querySelectorAll('[data-since]')) {
      const value = sinceText(node.dataset.kind, node.dataset.since, now) || node.dataset.fallback || '';
      if (node.textContent !== value) node.textContent = value;
    }
    for (const node of main.querySelectorAll('[data-reset-at]')) {
      const at = Number(node.dataset.resetAt);
      const inText = resetInText(at, now);
      const shown = resetLabel(at, now);
      const value = inText ? t('Resets {0} · {1}', inText, shown) : t('Resets at {0}', shown);
      if (node.textContent !== value) node.textContent = value;
    }
  }
  setInterval(tickMinuteLabels, 15000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    tickCountdowns();
    tickMinuteLabels();
  });

  window.addEventListener('message', ({ data }) => {
    if (data?.type === 'probe') {
      reportView('ready');
      announced = undefined;
      announcedKey = '';
      announcedVisible = undefined;
      reportRequest();
      return;
    }
    if (data?.type === 'revealRequest') { revealRequest(data.key, data.token); return; }
    if (data?.type === 'revealSession') { revealSession(data.key); return; }
    if (data?.type === 'decide') { if (data.action === 'approve' || data.action === 'deny') decideOpen(data.action); return; }
    if (data?.type !== 'state' || !Array.isArray(data.sessions)) return;
    const hasRev = Number.isSafeInteger(data.rev);
    let signature;
    if (hasRev) {
      if (lastRev === data.rev) return;
    } else {
      signature = JSON.stringify(data);
      if (lastState === signature) return;
    }
    const wasLoaded = loaded;
    const prevSessions = state.sessions;
    const prevScanError = state.scanError;
    let changes = wasLoaded && state.preferences?.sort === data.preferences?.sort &&
      state.preferences?.attentionOnly === data.preferences?.attentionOnly && state.preferences?.hideCompleted === data.preferences?.hideCompleted
      ? transitionKeys(state.sessions, data.sessions) : undefined;
    if (changes && !changes.size && state.sessions.length === data.sessions.length &&
        state.sessions.every((row, i) => row.key === data.sessions[i].key && row.parentKey === data.sessions[i].parentKey)) {
      changes = undefined;
    }
    loaded = true;
    state = data;
    if (hasRev) { lastRev = data.rev; lastState = undefined; }
    else { lastState = signature; lastRev = undefined; }
    if (wasLoaded) {
      const prior = new Map(prevSessions.map(row => [row.key, row]));
      const notices = [];
      for (const row of data.sessions) {
        const old = prior.get(row.key);
        if (isWait(row) && (old?.status !== row.status || requestToken(old) !== requestToken(row))) {
          notices.push(visible(row.title) + ' · ' + (row.status === 'input' ? t('Answer needed') : t('Approval needed')));
        } else if (row.replyUnread && row.status === 'done' && old?.replyAt !== row.replyAt) {
          notices.push(visible(row.title) + ' · ' + t('New reply received'));
        } else if (row.status === 'error' && !row.errorAcked && old?.status !== 'error') {
          notices.push(visible(row.title) + ' · ' + errorLabel(row.errorReason));
        }
      }
      if (data.scanError && data.scanError !== prevScanError) notices.push(t('Error · {0}', visible(data.scanError)));
      if (notices.length) {
        const summary = notices.slice(0, 2).join(', ') + (notices.length > 2 ? ' ' + t('+{0} more', notices.length - 2) : '');
        announceStatus(summary);
      }
    } else if (data.scanError) {
      announceStatus(t('Error · {0}', visible(data.scanError)));
    }
    const currentTokens = new Set();
    let revealed = false;
    let newInlineAction = false;
    for (const row of state.sessions) {
      const token = row.action?.token;
      if (!token) continue;
      currentTokens.add(token);
      if (!previousInlineTokens.has(token)) {
        newInlineAction = true;
        if (collapsed.delete(row.provider)) revealed = true;
      }
    }
    if (revealed) persist();
    previousInlineTokens = currentTokens;
    const shown = focusToken;
    if (newInlineAction && focusToken?.startsWith('preview:')) {
      if (aiming()) {
        pendingPreempt = true;
      } else {
        pendingPreempt = false;
        setFocus(undefined);
      }
    }
    syncFocus();
    if (expandedMenu && !getDerived().byKey.has(expandedMenu)) expandedMenu = undefined;
    if (heldPointer) { renderPending = true; return; }
    render(changes, { fromHost: true });
    if (focusToken && focusToken !== shown && !quotaOverview && !interacting(document.activeElement)) {
      main.querySelector('.interaction')?.closest('.session')?.scrollIntoView({ block: 'nearest' });
      reportRequest();
    }
  });

  syncFocus();
  render();
  reportView('ready');
  announced = undefined;
  announcedKey = '';
  announcedVisible = undefined;
  reportRequest();
})();
