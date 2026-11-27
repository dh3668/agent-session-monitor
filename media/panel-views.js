// Derived state memoization, session rows/trees, command bar, notices, and quota views.
(root => {
  'use strict';
  const {
    sinceText, remainingText, resetInText, percentLabel, leftOf, visible, modelName,
    quotaLabel, quotaKey, representativeWindow, shortLimitLabel, limitName, isWait, requestToken, requestOrder,
    toolKind, errorLabel, depletedQuotaHint, searchHaystack, subtitleFor,
  } = root.AgentSessionFormat;
  const { t, tp, phrase } = root.AgentSessionI18n;
  const P = root.AgentSessionPanel;
  const {
    providers, shortProviders, statusLabel, sectionName, usageLabel, defaultOrder, specFor, navigable,
    dateTimeShort, resetLabel, quotaAlertText, element, button, icon, brand,
    requestHeadline, executionNote, renderRequest, renderDetail,
  } = P;

  const LIMIT_TEXT_RE = /rate.?limit|usage.?limit|hit your limit|한도|사용량|429/i;
  const isLiveWorking = row => row.status === 'working' && !row.quiet;
  const attentionRank = row => {
    if (row.quiet) return -1;
    if (row.replyUnread && row.status === 'done') return 3;
    if (row.status === 'error' && row.errorAcked) return -1;
    return row.status === 'input' ? 0 : row.status === 'approval' ? 1 : row.status === 'error' ? 2 : -1;
  };
  const hasRichStory = row => Boolean(
    row.prompt || row.focus || row.plan?.length || row.changedFiles?.length || row.steps?.length ||
    (row.reply && (row.status === 'done' || row.status === 'error')) ||
    (row.status === 'error' && !row.errorAcked) || row.quiet
  );

  function computeQuotaHints(quotas, now) {
    const hints = {};
    for (const id of defaultOrder) hints[id] = depletedQuotaHint(quotas?.[id], now);
    return hints;
  }
  function quotaHintForError(row, quotaHints, now = Date.now()) {
    if (row.status !== 'error') return;
    const hint = quotaHints?.[row.provider];
    if (!hint) return;
    if (row.errorReason === 'rate_limit') return hint;
    if (row.errorReason) return;
    const mentionsLimit = typeof row.reply === 'string' && LIMIT_TEXT_RE.test(row.reply);
    const recentEnough = Number.isSafeInteger(row.updatedAt) && now - row.updatedAt < 6 * 3600000;
    return (mentionsLimit || recentEnough) ? hint : undefined;
  }

  function resolveParents(rows, knownKeys) {
    const parents = new Map();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.isSubagent && knownKeys.has(row.parentKey) && row.parentKey !== row.key) parents.set(row.key, row.parentKey);
    }
    const visited = new Set();
    for (let i = 0; i < rows.length; i++) {
      let key = rows[i].key;
      const chain = new Set();
      while (parents.has(key) && !visited.has(key) && !chain.has(key)) { chain.add(key); key = parents.get(key); }
      if (chain.has(key)) parents.delete(key);
      for (const member of chain) visited.add(member);
    }
    return parents;
  }

  // Two-level memoized derived view: Level 1 keyed by state reference, Level 2 by filter tuple.
  let cachedStateRef;
  let cachedStateData;
  let cachedFilterSig = '';
  let cachedFilterData;

  function getStateData(state, now) {
    if (cachedStateRef === state && cachedStateData) {
      if (Math.abs(now - cachedStateData.quotaAt) >= 15000) {
        cachedStateData.quotaHints = computeQuotaHints(state.quotas, now);
        cachedStateData.quotaAt = now;
      }
      return cachedStateData;
    }
    const all = state.sessions || [];
    const byKey = new Map();
    const tokenOf = new Map();
    const childrenMap = new Map();
    const presentProviders = new Set();

    for (let i = 0; i < all.length; i++) {
      const r = all[i];
      byKey.set(r.key, r);
      tokenOf.set(r.key, requestToken(r));
      presentProviders.add(r.provider);
    }
    const parents = resolveParents(all, byKey);
    for (const [child, parent] of parents) {
      let list = childrenMap.get(parent);
      if (!list) { list = []; childrenMap.set(parent, list); }
      list.push(byKey.get(child));
    }
    const roots = [];
    const membersMap = new Map();
    let attention = 0, working = 0, hasUrgent = false;
    for (let i = 0; i < all.length; i++) {
      const root = all[i];
      if (parents.has(root.key)) continue;
      roots.push(root);
      const seen = new Set([root.key]);
      const members = [root];
      for (let j = 0; j < members.length; j++) {
        const kids = childrenMap.get(members[j].key);
        if (!kids) continue;
        for (let k = 0; k < kids.length; k++) {
          const c = kids[k];
          if (!seen.has(c.key)) { seen.add(c.key); members.push(c); }
        }
      }
      membersMap.set(root.key, members);
      let hasAttn = false, hasWork = false;
      for (let j = 0; j < members.length; j++) {
        const m = members[j];
        if (attentionRank(m) >= 0) {
          hasAttn = true;
          if (isWait(m) || (m.status === 'error' && !m.errorAcked)) hasUrgent = true;
        } else if (isLiveWorking(m)) {
          hasWork = true;
        }
      }
      if (hasAttn) attention++;
      else if (hasWork) working++;
    }
    cachedStateRef = state;
    cachedStateData = {
      all, byKey, tokenOf, presentProviders,
      buckets: { roots, membersMap, counts: { all: roots.length, attention, working, hasUrgent } },
      haystacks: new Map(),
      quotaHints: computeQuotaHints(state.quotas, now),
      quotaAt: now,
    };
    cachedFilterSig = '';
    cachedFilterData = undefined;
    return cachedStateData;
  }

  function deriveView(state, lens, providerFilter, searchQuery, now = Date.now()) {
    const base = getStateData(state, now);
    const activeQuery = String(searchQuery || '').trim();
    const sig = lens + '\0' + providerFilter + '\0' + activeQuery;
    if (cachedFilterData && cachedFilterSig === sig) {
      cachedFilterData.quotaHints = base.quotaHints;
      return cachedFilterData;
    }
    let filtered;
    if (lens === 'all' && providerFilter === 'all' && !activeQuery) {
      filtered = base.all;
    } else {
      const terms = activeQuery ? activeQuery.toLowerCase().split(/\s+/).filter(Boolean) : [];
      const matchesRow = m => {
        let haystack = base.haystacks.get(m.key);
        if (haystack === undefined) {
          haystack = searchHaystack(m);
          base.haystacks.set(m.key, haystack);
        }
        for (let i = 0; i < terms.length; i++) if (!haystack.includes(terms[i])) return false;
        return true;
      };
      const keep = new Set();
      const { roots, membersMap } = base.buckets;
      for (let i = 0; i < roots.length; i++) {
        const root = roots[i];
        if (providerFilter !== 'all' && root.provider !== providerFilter) continue;
        const members = membersMap.get(root.key);
        const lensMatch = lens === 'all' ||
          (lens === 'attention' && members.some(m => attentionRank(m) >= 0)) ||
          (lens === 'working' && members.some(isLiveWorking));
        if (!lensMatch) continue;
        if (terms.length && !members.some(matchesRow)) continue;
        for (let j = 0; j < members.length; j++) keep.add(members[j].key);
      }
      filtered = base.all.filter(r => keep.has(r.key));
    }
    const filteredKeys = new Set();
    for (let i = 0; i < filtered.length; i++) filteredKeys.add(filtered[i].key);
    const queue = requestOrder(filtered);
    cachedFilterSig = sig;
    cachedFilterData = {
      byKey: base.byKey,
      tokenOf: base.tokenOf,
      buckets: base.buckets,
      presentProviders: base.presentProviders,
      quotaHints: base.quotaHints,
      filtered,
      filteredKeys,
      queue,
    };
    return cachedFilterData;
  }

  function statusOf(row, target, section, ctx) {
    const child = row !== target;
    const of = text => child ? t('Subtask: {0}', text) : text;
    if (target.replyUnread && target.status === 'done') {
      const label = t('New reply');
      return { name: 'unread', child, text: of(label), label, since: target.replyAt, kind: 'ago' };
    }
    if ((target.status === 'working' || target.status === 'approval' || target.status === 'input') && target.quiet) {
      const label = t('No signal');
      return { name: 'quiet', child, text: of(label), label, since: target.signalAt, kind: 'for' };
    }
    const label = statusLabel(target.status);
    const text = of(label);
    if (isWait(target)) {
      return { name: target.status, child, text, label, short: target.status === 'input' ? t('Answer') : t('Approval'), since: target.waitSince, kind: 'for' };
    }
    if (target.status === 'working') {
      return { name: 'working', child, text, label: section === 'working' && !child ? '' : label, since: target.workSince, kind: 'for' };
    }
    if (target.status === 'error') {
      const reason = target.errorReason ? errorLabel(target.errorReason) : (ctx.quotaHintForError(target) ? t('Limit reached') : statusLabel('error'));
      return { name: target.errorAcked ? 'error-acked' : 'error', child, text: of(reason), label: reason, since: target.updatedAt, kind: 'ago' };
    }
    return { name: target.status, child, text, label: section === 'history' ? '' : label, since: target.updatedAt, kind: 'ago', fallback: t('just now') };
  }

  function sublineIconFor(row, target, owner, ctx) {
    if (owner) {
      if (owner.action?.kind === 'question') return { name: 'question', cls: 'accent' };
      const tool = owner.action ? owner.action.tool : owner.preview?.tool;
      return { name: toolKind(tool).kind, cls: 'accent' };
    }
    const subject = row !== target ? target : row;
    if (isWait(subject)) {
      const tool = subject.action?.tool || subject.preview?.tool || subject.activity?.tool;
      const tk = tool ? toolKind(tool).kind : '';
      if (tk === 'permission') return { name: 'permission', cls: 'accent' };
      if (subject.status === 'input') return { name: 'question', cls: 'accent' };
      return { name: tk || 'warn', cls: 'accent' };
    }
    if (subject.status === 'working') {
      if (subject.activity) return { name: toolKind(subject.activity.tool).kind, cls: subject.activity.failed ? 'failed' : '' };
      if (subject.focus) return { name: 'focus', cls: 'accent' };
      if (subject.plan?.length) return { name: 'plan', cls: '' };
      return { name: 'reply', cls: '' };
    }
    if (subject.status === 'done' && subject.reply) return { name: 'reply', cls: subject.replyUnread ? 'accent' : '' };
    if (subject.status === 'error' && (subject.reply || ctx.quotaHintForError(subject))) {
      return { name: 'warn', cls: subject.errorAcked ? '' : 'failed' };
    }
    return null;
  }

  function countdownState(expiresAt, token, now = Date.now(), windowTotals) {
    const left = Math.max(0, Number(expiresAt) - now);
    const total = windowTotals?.get(token) || 45000;
    const pct = Math.max(0, Math.min(100, (left / total) * 100));
    const cls = left <= 5000 ? 'critical' : left <= 15000 ? 'urgent' : '';
    return { pct, cls };
  }

  function renderRow(row, target, childSummary, expanded, owner, section, ctx) {
    const now = ctx.now;
    const detailed = ctx.expandedMenu === row.key;
    const item = element('li', 'session' + (owner ? ' is-open' : '') + (detailed ? ' is-detailed' : ''));
    const info = statusOf(row, target, section, ctx);
    const waited = info.since ? sinceText(info.kind, info.since, now) || info.fallback || '' : '';
    const status = info.text + (waited ? ' ' + waited : '');
    const [id, name, mono] = specFor(row.provider);
    item.dataset.key = row.key;
    item.dataset.provider = row.provider;
    item.dataset.status = info.name;
    item.dataset.vscodeContext = JSON.stringify({
      webviewSection: 'agentSession', key: row.key, provider: row.provider,
      sessionOpens: navigable(row),
      sessionSettled: (row.status !== 'working' && row.status !== 'approval' && row.status !== 'input') || row.quiet === true,
      preventDefaultContextMenuItems: true,
    });
    const ownerToken = owner ? ctx.derived.tokenOf.get(owner.key) : undefined;
    const ownerCountdown = owner?.action?.expiresAt
      ? countdownState(owner.action.expiresAt, ownerToken, now, ctx.windowTotals)
      : undefined;
    if (ownerCountdown) {
      const bar = element('div', 'countdown-bar');
      const fill = element('div', 'countdown-fill');
      fill.style.transform = 'scaleX(' + Number((ownerCountdown.pct / 100).toFixed(4)) + ')';
      if (ownerCountdown.cls) fill.classList.add(ownerCountdown.cls);
      fill.dataset.expiresBar = owner.action.expiresAt;
      fill.dataset.expiresToken = ownerToken;
      bar.append(fill);
      item.append(bar);
    }
    const line = element('div', 'title-line');
    const canOpen = navigable(target);
    const token = ctx.derived.tokenOf.get(target.key);
    const live = Boolean(token) || canOpen;
    const title = visible(row.title);
    const opener = live ? button('opener', title + ' · ' + status) : element('div', 'opener static-title');
    if (!live) opener.tabIndex = -1;
    opener.dataset.target = target.key;
    if (token) {
      opener.dataset.control = 'request';
      opener.dataset.token = token;
      opener.setAttribute('aria-expanded', String(ctx.focusToken === token));
    } else if (canOpen) opener.dataset.action = isWait(target) ? 'review' : 'open';
    const dot = element('span', 'node');
    dot.setAttribute('aria-hidden', 'true');
    const marked = !row.isSubagent && !ctx.groupedView;
    if (!marked) {
      item.classList.add('plain');
      line.classList.add('plain');
    }
    opener.append(dot);
    if (marked) opener.append(brand(id, mono));
    opener.append(element('span', 'title', title));
    const request = owner?.action;
    const timedAction = request?.expiresAt ? request : (target?.action?.expiresAt ? target.action : undefined);
    const timedCountdown = timedAction
      ? (owner ? ownerCountdown : countdownState(timedAction.expiresAt, token, now, ctx.windowTotals))
      : undefined;
    const fallbackErrorLine = subject => subject.status === 'error' ? quotaAlertText(ctx.quotaHintForError(subject), true, now) : '';
    const about = owner ? (owner !== row ? owner.title + ' — ' : '') + requestHeadline(owner)
      : row !== target ? [target.title, subtitleFor(target) || fallbackErrorLine(target)].filter(Boolean).join(' — ')
        : subtitleFor(row) || fallbackErrorLine(row);
    const shownAbout = about ? visible(about) : '';
    let aside;
    if (timedAction?.expiresAt) {
      const cls = timedCountdown?.cls || '';
      aside = element('time', 'aside countdown' + (cls ? ' ' + cls : ''), remainingText(timedAction.expiresAt, now));
      aside.dataset.expires = timedAction.expiresAt;
      aside.title = t('When time runs out, it moves to the official chat.');
    } else if (!owner && row.progress) {
      const pct = Math.round((row.progress.done / row.progress.total) * 100);
      aside = element('span', 'aside mini-progress');
      const track = element('span', 'mini-progress-track');
      track.setAttribute('aria-hidden', 'true');
      const fill = element('span', 'mini-progress-fill');
      fill.style.transform = 'scaleX(' + Number((pct / 100).toFixed(4)) + ')';
      track.append(fill);
      aside.append(track, document.createTextNode(row.progress.done + '/' + row.progress.total));
      aside.title = tp(row.progress.total, '{1} of {0} plan step done ({2}%)', '{1} of {0} plan steps done ({2}%)', row.progress.done, pct);
    }
    if (about || aside) {
      const second = element('span', 'subline');
      const glyph = about ? sublineIconFor(row, target, owner, ctx) : null;
      if (glyph) second.append(icon(glyph.name, 'icon subline-icon' + (glyph.cls ? ' ' + glyph.cls : '')));
      second.append(element('span', 'subtitle', shownAbout));
      if (aside) second.append(aside);
      opener.append(second);
      line.classList.add('three');
    }
    const model = row.execution?.model;
    const effort = row.execution?.effort;
    const meta = element('span', 'info');
    const pieces = [
      { text: modelName(model, row.execution, id) || (!ctx.groupedView && name) },
      { text: effort },
      { text: row.changed && tp(row.changed, '{0} file changed', '{0} files changed'), cls: 'meta-files' },
      { text: row.project && !row.isSubagent && row.project !== ctx.state.workspaceLabel && row.project },
    ].filter(p => p.text);
    for (const piece of pieces) meta.append(element('span', 'meta' + (piece.cls ? ' ' + piece.cls : ''), piece.text));
    if (meta.childNodes.length) opener.append(meta);
    else line.classList.add('bare');
    opener.title = (row !== target ? title + ' → ' + visible(target.title) : title) +
      (target.viaParent ? ' · ' + t('Opens in the parent chat') : '') + '\n' + name + ' · ' + status + (shownAbout ? '\n' + shownAbout : '') + '\n' + executionNote(row, now);
    opener.setAttribute('aria-label', [title, status, shownAbout, name, model, effort && t('Reasoning effort: {0}', effort), row.pinned && t('Pinned'),
      row.progress && t('Plan {0}/{1}', row.progress.done, row.progress.total),
      !token && target.viaParent && t('Open the parent chat')].filter(Boolean).join(' · '));
    line.append(opener);
    const badge = element('span', 'status');
    if (info.label) {
      if (info.child) badge.append(element('span', 'status-prefix', t('Subtask:')), document.createTextNode(' '));
      badge.append(element('span', 'status-text', info.short || info.label));
      if (info.short && info.label.startsWith(info.short)) {
        badge.append(document.createTextNode(' '), element('span', 'status-rest', info.label.slice(info.short.length).trim()));
      }
    }
    if (info.since) {
      if (info.label) badge.append(document.createTextNode(' '));
      const time = element('time', 'since', waited);
      time.dataset.since = info.since;
      time.dataset.kind = info.kind;
      if (info.fallback) time.dataset.fallback = info.fallback;
      badge.append(time);
    }
    if (token) badge.append(icon('turn', 'icon tiny status-glyph'));
    else if (isWait(target) && canOpen) badge.append(icon('out', 'icon tiny status-glyph'));
    line.append(badge);
    const controls = element('div', 'row-tools');
    const rich = hasRichStory(row);
    const menu = button('more' + (rich ? ' has-story' : ''), t('Show {0} work details (I)', row.title));
    menu.dataset.control = 'more';
    menu.title = rich ? t('Show work details (I)') : t('Details (I)');
    menu.setAttribute('aria-expanded', String(detailed));
    menu.append(icon('more', 'icon small'));
    controls.append(menu);
    if (childSummary?.total) {
      const breakdown = [
        childSummary.active && t('{0} active', childSummary.active),
        childSummary.done && t('{0} done', childSummary.done),
        childSummary.quiet && t('{0} no signal', childSummary.quiet),
        childSummary.other && t('{0} earlier', childSummary.other),
      ].filter(Boolean).join(' · ');
      const pillText = childSummary.active > 0 && childSummary.active < childSummary.total
        ? childSummary.active + '/' + childSummary.total : String(childSummary.total);
      const toggle = button('children-toggle' + (childSummary.active > 0 ? ' has-active' : ''),
        row.title + ' · ' + tp(childSummary.total, '{0} subtask', '{0} subtasks') + (breakdown ? ' (' + breakdown + ')' : '') + ' ' + (expanded ? t('Collapse') : t('Expand')));
      toggle.dataset.control = 'children';
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.title = toggle.getAttribute('aria-label');
      toggle.append(icon('agent', 'icon tiny'), document.createTextNode(pillText), element('span', 'chevron'));
      controls.append(toggle);
    }
    if (row.pinned) {
      const pin = element('span', 'pin-mark');
      pin.title = t('Pinned');
      pin.append(icon('pin', 'icon tiny'));
      controls.append(pin);
    }
    line.append(controls);
    item.append(line);
    if (owner) {
      const block = element('div', 'interaction');
      block.append(renderRequest(owner, ctx));
      item.append(block);
    }
    if (detailed) item.append(renderDetail(row, ctx));
    return item;
  }

  function sessionList(rows, sectioned, ctx) {
    const items = new Map();
    for (let i = 0; i < rows.length; i++) items.set(rows[i].key, { row: rows[i], children: [] });
    const parents = resolveParents(rows, items);
    for (const [child, parent] of parents) items.get(parent).children.push(items.get(child));
    const list = element('ul', 'session-list');
    const familyCache = new Map();
    function family(node) {
      let cached = familyCache.get(node);
      if (cached) return cached;
      const queue = [...node.children];
      for (let i = 0; i < queue.length; i++) queue.push(...queue[i].children);
      cached = queue.map(member => member.row);
      familyCache.set(node, cached);
      return cached;
    }
    const activeCache = new Map();
    function isActiveSubtree(node) {
      let cached = activeCache.get(node);
      if (cached !== undefined) return cached;
      cached = attentionRank(node.row) >= 0 || isLiveWorking(node.row) || node.children.some(isActiveSubtree);
      activeCache.set(node, cached);
      return cached;
    }
    function summarizeChildren(descendants) {
      let active = 0, done = 0, quiet = 0, other = 0;
      for (let i = 0; i < descendants.length; i++) {
        const m = descendants[i];
        if (attentionRank(m) >= 0 || isLiveWorking(m)) active++;
        else if (m.status === 'done') done++;
        else if (m.quiet || m.status === 'stale') quiet++;
        else other++;
      }
      return { total: descendants.length, active, done, quiet, other };
    }
    function settledBucketLabel(nodes) {
      const stats = summarizeChildren(nodes.map(n => n.row));
      return [
        stats.done && t('{0} done', stats.done),
        stats.quiet && t('{0} no signal', stats.quiet),
        stats.other && t('{0} earlier', stats.other),
      ].filter(Boolean).join(' · ') || tp(nodes.length, '{0} earlier subtask', '{0} earlier subtasks');
    }
    function appendTree(node, targetList, section, extraClass) {
      const { row, children } = node;
      const descendants = family(node);
      const expanded = ctx.childExpansion.get(row.key) === true || (isWait(row) && descendants.some(isWait));
      const hidden = !expanded && children.length ? descendants : [];
      let target = row;
      for (let i = 0; i < hidden.length; i++) {
        const candidate = hidden[i];
        if (row.priorityTargetKey === candidate.key) { target = candidate; break; }
        if (attentionRank(candidate) >= 0 && (attentionRank(target) < 0 || attentionRank(candidate) < attentionRank(target))) target = candidate;
      }
      const owner = ctx.focusToken ? [row, ...hidden].find(member => ctx.derived.tokenOf.get(member.key) === ctx.focusToken) : undefined;
      if (owner) target = owner;
      const summary = children.length ? summarizeChildren(descendants) : undefined;
      const item = renderRow(row, target, summary, expanded, owner, section, ctx);
      if (extraClass) item.classList.add(extraClass);
      if (row.isSubagent && !parents.has(row.key)) {
        item.title = t('A subagent whose parent session is not in the list');
        item.classList.add('orphan');
      }
      if (children.length && expanded) {
        const nested = element('ul', 'child-list');
        const activeChildren = [], settledChildren = [];
        for (let i = 0; i < children.length; i++) {
          (isActiveSubtree(children[i]) ? activeChildren : settledChildren).push(children[i]);
        }
        for (let i = 0; i < activeChildren.length; i++) appendTree(activeChildren[i], nested);
        const shouldFold = settledChildren.length > 0 && (activeChildren.length > 0 || settledChildren.length > 3);
        const bucketOpen = ctx.settledChildExpansion.has(row.key);
        if (shouldFold) {
          const bucket = element('li', 'child-bucket');
          bucket.dataset.bucket = 'settled';
          bucket.dataset.target = row.key;
          const label = settledBucketLabel(settledChildren);
          const toggle = button('child-bucket-toggle', row.title + ' · ' + label + ' ' + (bucketOpen ? t('Collapse') : t('Expand')));
          toggle.dataset.control = 'settledChildren';
          toggle.dataset.target = row.key;
          toggle.setAttribute('aria-expanded', String(bucketOpen));
          const chevron = element('span', 'chevron');
          chevron.setAttribute('aria-hidden', 'true');
          toggle.append(element('span', 'child-bucket-label', label), chevron);
          const clean = button('child-clean', row.title + ' · ' + t('Clear finished or silent subtasks'), t('Clear'));
          clean.dataset.action = 'dismissChildren';
          clean.dataset.target = row.key;
          clean.dataset.provider = row.provider;
          clean.title = t('Hide finished or silent subtasks');
          bucket.append(toggle, clean);
          nested.append(bucket);
          if (bucketOpen) for (let i = 0; i < settledChildren.length; i++) appendTree(settledChildren[i], nested, undefined, 'child-settled');
        } else if (settledChildren.length) {
          for (let i = 0; i < settledChildren.length; i++) appendTree(settledChildren[i], nested, undefined, 'child-settled');
          if (settledChildren.some(c => c.row.quiet || c.row.status === 'stale')) {
            const footer = element('li', 'child-bucket inline-clean');
            footer.dataset.bucket = 'clean';
            footer.dataset.target = row.key;
            const clean = button('child-clean', row.title + ' · ' + t('Clear finished or silent subtasks'), t('Clear finished · silent'));
            clean.dataset.action = 'dismissChildren';
            clean.dataset.target = row.key;
            clean.dataset.provider = row.provider;
            clean.title = t('Hide finished or silent subtasks');
            footer.append(clean);
            nested.append(footer);
          }
        }
        item.append(nested);
      }
      targetList.append(item);
    }
    const roots = [...items.values()].filter(node => !parents.has(node.row.key));
    if (!sectioned) {
      for (let i = 0; i < roots.length; i++) appendTree(roots[i], list);
      return list;
    }
    const groups = { attention: [], working: [], history: [] };
    for (let i = 0; i < roots.length; i++) {
      const node = roots[i];
      const members = [node.row, ...family(node)];
      groups[members.some(row => attentionRank(row) >= 0) ? 'attention' :
        members.some(isLiveWorking) ? 'working' : 'history'].push(node);
    }
    for (const [name, nodes] of Object.entries(groups)) {
      if (!nodes.length) continue;
      const head = element('li', 'section-head');
      head.dataset.section = name;
      if (name === 'history') {
        const headingWrap = element('span', 'section-heading');
        headingWrap.setAttribute('role', 'heading');
        headingWrap.setAttribute('aria-level', '2');
        const toggle = button('section-toggle', t('{0} section ({1})', sectionName(name), nodes.length) + ' ' + (ctx.historyCollapsed ? t('Expand') : t('Collapse')));
        toggle.dataset.control = 'history';
        toggle.setAttribute('aria-expanded', String(!ctx.historyCollapsed));
        const chevron = element('span', 'chevron');
        chevron.setAttribute('aria-hidden', 'true');
        toggle.append(element('span', '', sectionName(name)), element('span', 'section-count', String(nodes.length)), chevron);
        headingWrap.append(toggle);
        head.append(headingWrap);
      } else {
        const heading = element('span', '', sectionName(name));
        heading.setAttribute('role', 'heading');
        heading.setAttribute('aria-level', '2');
        head.append(heading, element('span', 'section-count', String(nodes.length)));
        if (name === 'attention' && ctx.state.unreadCount > 0 &&
            nodes.some(node => [node.row, ...family(node)].some(r => r.replyUnread && r.status === 'done'))) {
          const markAll = button('section-action', t('Mark all new replies as read'), t('Mark all read'));
          markAll.dataset.action = 'markAllSeen';
          head.append(markAll);
        }
      }
      list.append(head);
      if (name === 'history' && ctx.historyCollapsed) continue;
      for (let i = 0; i < nodes.length; i++) appendTree(nodes[i], list, name);
    }
    return list;
  }

  function limitMeter(label, left) {
    const meter = element('meter', 'quota-meter');
    meter.min = 0;
    meter.max = 100;
    meter.value = left;
    meter.setAttribute('aria-label', label);
    meter.setAttribute('aria-valuetext', t('{0}% left', percentLabel(left)));
    meter.dataset.level = left <= 10 ? 'low' : left <= 25 ? 'warn' : 'ok';
    return meter;
  }
  const levelNote = left => left <= 10 ? t('Almost used up') : left <= 25 ? t('Running low') : '';
  const levelClass = left => left <= 10 ? 'level-low' : left <= 25 ? 'level-warn' : '';

  function windowRow(window, now = Date.now()) {
    const box = element('div', 'quota-window');
    const name = quotaLabel(window);
    box.dataset.key = quotaKey(window);
    const left = leftOf(window);
    const values = element('div', 'window-values');
    const label = element('span', 'window-label', name);
    if (window.resetsAt) {
      const reset = new Date(window.resetsAt);
      const inText = resetInText(window.resetsAt, now);
      const at = resetLabel(window.resetsAt, now);
      const stamp = element('time', 'quota-reset', inText ? t('Resets {0} · {1}', inText, at) : t('Resets {0}', at));
      stamp.dateTime = reset.toISOString();
      stamp.dataset.resetAt = window.resetsAt;
      stamp.title = dateTimeShort().format(reset);
      label.append(stamp);
    }
    const figure = element('span', 'quota-amount');
    const noteText = levelNote(left);
    if (noteText) figure.append(icon('warn', 'icon tiny ' + levelClass(left)));
    figure.append(document.createTextNode(t('{0}% left', percentLabel(left))));
    values.append(label, figure);
    values.title = [name, window.kind === 'remaining' ? t('{0}% left', percentLabel(window.percent)) : t('{0}% used', percentLabel(window.percent)), noteText]
      .filter(Boolean).join(' · ');
    box.append(values, limitMeter(name, left));
    return box;
  }

  function renderQuota(id, name, ctx) {
    const quota = ctx.state.quotas?.[id] || { status: 'unavailable', windows: [] };
    const section = element('div', 'subscription');
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', t('{0} subscription limits', name));
    const windows = quota.windows || [];
    for (const window of windows.slice(0, 4)) section.append(windowRow(window, ctx.now));
    if (windows.length > 4) {
      const open = ctx.extraLimits.has(id);
      const extra = windows.length - 4;
      const toggle = button('quota-extra usage-link', tp(extra, '{1}: {0} more limit', '{1}: {0} more limits', name),
        open ? t('Hide extra limits') : tp(extra, 'Show {0} more limit', 'Show {0} more limits'));
      toggle.dataset.control = 'extraLimits';
      toggle.setAttribute('aria-expanded', String(open));
      section.append(toggle);
      if (open) for (const window of windows.slice(4)) section.append(windowRow(window, ctx.now));
    }
    let note;
    if (quota.status === 'loading') note = t('Checking…');
    if (quota.status === 'stale') note = t('Last checked') + (quota.updatedAt ? ' · ' + resetLabel(quota.updatedAt, ctx.now) : '');
    if (quota.status === 'unavailable') note = quota.message ? t(quota.message) : t('Limits are unavailable.');
    if (note) section.append(element('div', 'quota-note', note));
    return section;
  }

  function group(id, name, mono, sourceRows, ctx) {
    const rows = sourceRows.filter(row => row.provider === id);
    const section = element('section', 'provider');
    section.dataset.provider = id;
    section.setAttribute('aria-labelledby', 'heading-' + id);
    const header = element('header', 'provider-head');
    const heading = element('h2');
    const mark = brand(id, mono);
    const nameText = element('span', 'brand-name', name);
    nameText.id = 'heading-' + id;
    header.append(heading);
    if (ctx.quotaOverview) {
      const quota = ctx.state.quotas?.[id];
      heading.className = 'quota-identity';
      heading.append(mark, nameText);
      if (quota?.plan) heading.append(element('span', 'quota-plan', quota.plan));
      const refresh = button('icon-button quota-refresh', t('Refresh {0} subscription limits', name));
      refresh.dataset.action = 'refreshQuota';
      refresh.title = t('Refresh subscription limits');
      refresh.disabled = quota?.status === 'loading';
      refresh.append(icon('refresh'));
      header.append(refresh);
    } else {
      const isCollapsed = ctx.collapsed.has(id);
      const toggle = button('group-toggle', tp(rows.length, '{1}: {0} session', '{1}: {0} sessions', name));
      toggle.dataset.control = 'group';
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.setAttribute('aria-controls', 'list-' + id);
      const chevron = element('span', 'chevron');
      chevron.setAttribute('aria-hidden', 'true');
      toggle.append(mark, nameText);
      const attention = rows.filter(row => attentionRank(row) >= 0).length;
      if (isCollapsed && attention) {
        toggle.append(element('span', 'group-alert', t('{0} to review', attention)));
        toggle.setAttribute('aria-label', tp(rows.length, '{1}: {0} session', '{1}: {0} sessions', name) + ', ' + tp(attention, '{0} needs attention', '{0} need attention'));
      } else if (rows.length) toggle.append(element('span', 'count', String(rows.length)));
      toggle.append(chevron);
      heading.append(toggle);
      if (ctx.state.preferences?.sort === 'manual') {
        const order = ctx.state.preferences.providerOrder;
        for (const [direction, caption, glyph, boundary] of [
          ['up', t('Move {0} up', name), '↑', 0], ['down', t('Move {0} down', name), '↓', order.length - 1],
        ]) {
          const move = button('icon-button', caption, glyph);
          move.dataset.action = 'moveProvider';
          move.dataset.direction = direction;
          move.title = caption;
          move.disabled = order.indexOf(id) === boundary;
          header.append(move);
        }
      }
      const start = button('icon-button', t('Start a new {0} session', name));
      start.title = t('Start a new {0} session', name);
      start.dataset.action = 'start';
      start.append(icon('plus'));
      header.append(start);
    }
    section.append(header);
    if (ctx.quotaOverview) {
      section.append(renderQuota(id, name, ctx));
      const usage = element('div', 'provider-usage');
      if (ctx.state.usage?.[id]) usage.append(element('span', 'usage-number', ctx.state.usage[id]));
      const viewUsage = button('usage-link', name + ' · ' + usageLabel(id), usageLabel(id));
      viewUsage.dataset.action = 'usage';
      viewUsage.append(icon('out', 'icon tiny'));
      usage.append(viewUsage);
      section.append(usage);
      return section;
    }
    const list = sessionList(rows, false, ctx);
    list.id = 'list-' + id;
    list.hidden = ctx.collapsed.has(id);
    section.append(list);
    return section;
  }

  function commandBar(ctx) {
    const bar = element('div', 'command-bar');
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', t('Session filters and search'));
    const row = element('div', 'command-row');
    const track = element('div', 'lens-track');
    track.setAttribute('role', 'group');
    track.setAttribute('aria-label', t('View by status'));
    const { counts } = ctx.derived.buckets;
    const tabs = [
      ['all', t('All'), counts.all, ''],
      ['attention', t('Attention'), counts.attention, counts.attention ? (counts.hasUrgent ? 'attn' : 'unread') : ''],
      ['working', t('Active'), counts.working, counts.working ? 'work' : ''],
    ];
    for (const [id, label, count, dotKind] of tabs) {
      const btn = button('lens-btn', tp(count, '{1}, {0} session', '{1}, {0} sessions', label));
      btn.dataset.control = 'lens';
      btn.dataset.value = id;
      btn.setAttribute('aria-pressed', String(ctx.lens === id));
      if (dotKind) btn.append(element('span', 'lens-dot' + (dotKind === 'work' ? ' work' : dotKind === 'unread' ? ' unread' : '')));
      btn.append(element('span', 'lens-label', label));
      if (count > 0 || id === 'all') btn.append(element('span', 'lens-count', String(count)));
      track.append(btn);
    }
    const toggle = button('search-toggle', ctx.searchOpen ? t('Close search') : t('Search sessions (/)'));
    toggle.dataset.control = 'searchToggle';
    toggle.setAttribute('aria-pressed', String(ctx.searchOpen || Boolean(ctx.searchQuery) || ctx.providerFilter !== 'all'));
    toggle.title = t('Search sessions (/)');
    toggle.append(icon('search', 'icon small'));
    row.append(track, toggle);
    bar.append(row);

    if (ctx.searchOpen) {
      const drawer = element('div', 'search-drawer');
      const box = element('div', 'search-box');
      box.append(icon('search', 'icon tiny'));
      const input = element('input', 'search-input');
      input.type = 'text';
      input.placeholder = t('Search titles, requests, files, models…');
      input.setAttribute('aria-label', t('Search sessions'));
      input.dataset.control = 'searchInput';
      input.value = ctx.searchQuery;
      box.append(input);
      if (ctx.searchQuery) {
        const clear = button('search-clear', t('Clear search'), '×');
        clear.dataset.control = 'clearSearch';
        box.append(clear);
      }
      drawer.append(box);
      const present = ctx.derived.presentProviders;
      if (present.size > 1 || ctx.providerFilter !== 'all') {
        const chips = element('div', 'provider-chips');
        chips.setAttribute('role', 'group');
        chips.setAttribute('aria-label', t('Filter by agent'));
        const allChip = button('provider-chip', t('Show all agents'), t('All'));
        allChip.dataset.control = 'providerFilter';
        allChip.dataset.value = 'all';
        allChip.setAttribute('aria-pressed', String(ctx.providerFilter === 'all'));
        chips.append(allChip);
        for (const [id, name, mono] of providers) {
          if (!present.has(id) && ctx.providerFilter !== id) continue;
          const chip = button('provider-chip', t('Show only {0} sessions', name));
          chip.dataset.control = 'providerFilter';
          chip.dataset.value = id;
          chip.setAttribute('aria-pressed', String(ctx.providerFilter === id));
          chip.append(brand(id, mono), document.createTextNode(shortProviders[id]));
          chips.append(chip);
        }
        drawer.append(chips);
      }
      bar.append(drawer);
    }
    return bar;
  }

  function connectNotices(state) {
    const notices = [];
    for (const [id, name] of providers) {
      const status = state.connections?.[id];
      if (status === 'untrusted' || status === 'unverified') {
        const notice = element('div', 'connect is-warning is-stacked');
        notice.dataset.provider = id;
        notice.dataset.status = status;
        notice.setAttribute('role', 'status');
        const noLive = id === 'codex' && state.codexLiveDetection === 'unavailable';
        const noteText = status === 'unverified'
          ? t('Codex did not answer the hook status check. Check the status with /hooks in the CLI, then check again.')
          : noLive
          ? t('Trust the hooks with /hooks in the Codex CLI. Without them, working and waiting-for-approval states cannot be detected.')
          : t('Trust the hooks with /hooks in the Codex CLI. Until then, only whether Codex is running is detected; approvals and activity are missing.');
        const heading = status === 'unverified' ? t('{0} hook trust unconfirmed', name) : t('{0} hooks need trust', name);
        notice.title = heading + '\n' + noteText;
        const head = element('div', 'connect-head');
        head.append(icon('warn', 'icon small'), element('span', 'connect-text', heading));
        const actions = element('div', 'connect-actions');
        const guide = button('mini', t('How to trust {0} hooks with /hooks', name), '/hooks');
        guide.dataset.action = 'trustGuide';
        guide.title = t('How to trust hooks with /hooks');
        const recheck = button('mini quiet', t('Recheck {0} hook trust', name), t('Check'));
        recheck.dataset.action = 'refresh';
        recheck.title = t('Recheck trust');
        actions.append(guide, recheck);
        head.append(actions);
        notice.append(head, element('div', 'connect-note', noteText));
        notices.push(notice);
        continue;
      }
      if (status !== 'missing' && status !== 'update') continue;
      const notice = element('div', 'connect');
      notice.dataset.provider = id;
      notice.setAttribute('role', 'status');
      const codexMissingTip = state.codexLiveDetection === 'unavailable'
        ? t('Without {0} hooks, working and approval states cannot be detected. Only recent chats are shown.', name)
        : t('Without {0} hooks, approvals and detailed activity are not received. Only local run status and recent chats are shown.', name);
      notice.title = status === 'update' ? t('{0} hooks differ from this version, so some states may be missing.', name)
        : (id === 'codex' ? codexMissingTip : t('Without {0} hooks, live status is not received. Only recent chats are shown.', name));
      notice.append(icon('link', 'icon small'), element('span', 'connect-text', status === 'update' ? t('{0} hooks need an update', name) : t('{0} hooks not connected', name)));
      const connect = button('mini', status === 'update' ? t('Update {0} hooks', name) : t('Connect {0}', name), status === 'update' ? t('Update') : t('Connect'));
      connect.dataset.action = 'connect';
      notice.append(connect);
      if (status === 'missing') {
        const hide = button('mini quiet', t('Hide the {0} connection notice', name), t('Hide'));
        hide.dataset.action = 'hideConnect';
        notice.append(hide);
      }
      notices.push(notice);
    }
    return notices;
  }

  function filterNotices(state) {
    const notices = [];
    for (const [key, action, text] of [
      ['attentionOnly', 'setAttentionOnly', t('Showing only sessions that need attention')],
      ['hideCompleted', 'setHideCompleted', state.hiddenCompleted ? t('Finished sessions hidden · {0}', state.hiddenCompleted) : t('Finished sessions hidden')],
    ]) {
      if (!state.preferences?.[key]) continue;
      const notice = element('div', 'connect');
      notice.dataset.filter = key;
      notice.append(icon('sort', 'icon small'), element('span', 'connect-text', text));
      const clear = button('mini', t('Turn off: {0}', text), t('Turn off'));
      clear.dataset.action = action;
      clear.dataset.value = 'false';
      notice.append(clear);
      notices.push(notice);
    }
    return notices;
  }

  function scanErrorNotice(state) {
    if (!state.scanError) return [];
    const notice = element('div', 'connect is-error');
    notice.dataset.notice = 'scan-error';
    notice.setAttribute('role', 'alert');
    notice.title = state.scanError;
    notice.append(icon('warn', 'icon small'), element('span', 'connect-text', visible(state.scanError)));
    const retry = button('mini', t('Reload session status'), t('Try again'));
    retry.dataset.action = 'refresh';
    notice.append(retry);
    return [notice];
  }

  function hiddenAttentionNotice(ctx) {
    const localFiltered = ctx.lens !== 'all' || ctx.providerFilter !== 'all' || Boolean(ctx.searchQuery.trim());
    if (!localFiltered) return [];
    const shownKeys = ctx.derived.filteredKeys;
    const hiddenWaiting = (ctx.state.sessions || []).filter(r => isWait(r) && !shownKeys.has(r.key));
    if (!hiddenWaiting.length) return [];
    const notice = element('div', 'filter-alert');
    notice.dataset.notice = 'hidden-attention';
    notice.setAttribute('role', 'status');
    notice.title = hiddenWaiting.slice(0, 3).map(r => specFor(r.provider)[1] + ' · ' + visible(r.title)).join('\n');
    const dot = element('span', 'filter-alert-dot');
    dot.setAttribute('aria-hidden', 'true');
    const text = element('span', 'filter-alert-text', tp(hiddenWaiting.length, '{0} needs attention outside the filter', '{0} need attention outside the filter'));
    const viewBtn = button('filter-alert-btn', t('Clear the filter and show waiting sessions'), t('Show'));
    viewBtn.dataset.control = 'showHiddenAttention';
    notice.append(dot, text, viewBtn);
    return [notice];
  }

  function skeletonState() {
    const wrap = element('div', 'skeleton-list');
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-label', t('Loading sessions'));
    for (let i = 0; i < 3; i++) {
      const row = element('div', 'skeleton-row');
      row.dataset.index = String(i);
      const lines = element('span', 'skeleton-lines');
      lines.append(
        element('span', 'skeleton-line skeleton-title'),
        element('span', 'skeleton-line skeleton-sub'),
        element('span', 'skeleton-line skeleton-meta'),
      );
      row.append(element('span', 'skeleton-avatar'), lines, element('span', 'skeleton-badge'));
      wrap.append(row);
    }
    return wrap;
  }

  function emptyState(glyph, title, body, actions) {
    const box = element('div', 'empty');
    const wrap = element('div', 'empty-icon-wrap');
    wrap.append(icon(glyph, 'icon empty-icon'));
    box.append(wrap, element('strong', 'empty-title', title));
    if (body) box.append(element('p', 'empty-text', body));
    if (actions?.length) {
      const bar = element('div', 'empty-actions');
      bar.append(...actions);
      box.append(bar);
    }
    return box;
  }

  function quotaFooter(ctx) {
    const { state, now } = ctx;
    const footer = element('footer', 'quota-footer');
    footer.setAttribute('aria-label', t('Other folders and remaining subscription limits'));
    if (state.elsewhere?.length) {
      const strip = element('div', 'elsewhere');
      strip.setAttribute('role', 'group');
      strip.setAttribute('aria-label', t('Requests waiting in other folders'));
      strip.append(element('span', 'elsewhere-label', t('Other folders')));
      for (const item of state.elsewhere) {
        const parts = [item.input && tp(item.input, '{0} answer', '{0} answers'), item.approval && tp(item.approval, '{0} approval', '{0} approvals')]
          .filter(Boolean).join(' · ');
        const open = button('elsewhere-folder', item.folder + ' · ' + parts + ' · ' + t('Open folder'));
        open.dataset.action = 'openFolder';
        open.dataset.cwd = item.cwd;
        open.title = item.cwd + '\n' + t('{0} waiting · Click to open a window for that folder', parts);
        const countEl = element('span', 'elsewhere-count' + (item.input && !item.approval ? ' is-input' : ''), parts);
        open.append(element('span', 'elsewhere-name', item.folder), countEl);
        strip.append(open);
      }
      footer.append(strip);
    }
    footer.append(element('h2', 'footer-head', t('Remaining limits')));
    const list = element('div', 'quota-list');
    for (const [id, name, mono] of providers) {
      const quota = state.quotas?.[id];
      const windows = quota?.windows ?? [];
      const window = representativeWindow(id, windows);
      const tile = button('quota-tile', t('{0} subscription limits', name));
      tile.dataset.control = 'quotaTile';
      tile.dataset.provider = id;
      const figure = element('span', 'tile-figure');
      figure.append(brand(id, mono));
      const period = element('span', 'tile-period');
      let bar;
      if (window && (quota.status === 'ready' || quota.status === 'stale')) {
        const left = leftOf(window);
        const amount = (left > 0 && left < 1 ? '<1' : String(Math.round(left))) + '%';
        const level = levelClass(left);
        const noteText = levelNote(left);
        const value = element('strong', 'tile-value', amount);
        if (level) value.classList.add(level);
        figure.append(value);
        if (noteText) figure.append(icon('warn', 'icon tiny ' + level));
        bar = element('span', 'tile-bar');
        const fill = element('span', 'tile-bar-fill');
        fill.style.transform = 'scaleX(' + Number((Math.max(0, Math.min(100, left)) / 100).toFixed(4)) + ')';
        fill.dataset.level = left <= 10 ? 'low' : left <= 25 ? 'warn' : 'ok';
        bar.append(fill);
        const low = windows.filter(w => w !== window && leftOf(w) <= 10).sort((a, b) => leftOf(a) - leftOf(b));
        const note = element('span', 'tile-note');
        if (low.length) {
          period.classList.add('warned');
          note.append(percentLabel(leftOf(low[0])) + '% ', element('span', 'note-name', limitName(low[0])));
          period.append(icon('warn', 'icon tiny level-low'));
        } else note.append(element('span', 'note-name', shortLimitLabel(window)));
        period.append(note);
        if (quota.status === 'stale') {
          period.classList.add('old');
          period.append(element('span', 'note-old', t('Stale')));
        }
        const resetIn = window.resetsAt ? resetInText(window.resetsAt, now) : '';
        const at = window.resetsAt ? resetLabel(window.resetsAt, now) : '';
        tile.title = [
          name + ' · ' + quotaLabel(window),
          t('{0} left', amount) + (noteText ? ' · ' + noteText : ''),
          window.resetsAt && (resetIn ? t('Resets {0} ({1})', resetIn, at) : t('Resets {0}', at)),
          ...low.map(w => quotaLabel(w) + ' ' + t('{0}% left', percentLabel(leftOf(w)))),
          quota.status === 'stale' && t('Last checked') + (quota.updatedAt ? ' · ' + resetLabel(quota.updatedAt, now) : ''),
        ].filter(Boolean).join('\n');
      } else {
        const pending = quota?.status === 'loading';
        figure.append(element('strong', 'tile-value none', '—'));
        bar = element('span', 'tile-bar');
        period.classList.add('empty-note');
        period.append(element('span', 'tile-note', pending ? t('Checking') : t('Unavailable')));
        tile.title = name + ' · ' + (quota?.message ? t(quota.message) : pending ? t('Checking') : t('Limits are unavailable.'));
      }
      tile.setAttribute('aria-label', tile.title.replaceAll('\n', ' · ') + ' · ' + t('Show details'));
      tile.append(figure, bar, period);
      list.append(tile);
    }
    footer.append(list);
    return footer;
  }

  function toolbar() {
    const bar = element('div', 'toolbar');
    const back = button('mini', t('Back to sessions'));
    back.dataset.control = 'quotaOverview';
    back.append(icon('back', 'icon tiny'), document.createTextNode(t('Sessions')));
    bar.append(back, element('h2', 'workspace-name', t('Subscription limits')), element('span', '', ''));
    return bar;
  }

  Object.assign(P, {
    quotaHintForError, deriveView, countdownState, sessionList, group,
    commandBar, connectNotices, filterNotices, scanErrorNotice, hiddenAttentionNotice,
    skeletonState, emptyState, quotaFooter, toolbar,
  });
})(globalThis);
