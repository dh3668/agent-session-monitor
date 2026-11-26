// Derived state memoization, session rows/trees, command bar, notices, and quota views.
(root => {
  'use strict';
  const {
    sinceText, remainingText, resetInText, percentLabel, leftOf, visible, modelName,
    representativeWindow, shortLimitLabel, limitName, isWait, requestToken, requestOrder,
    toolKind, errorLabel, depletedQuotaHint, searchHaystack, subtitleFor,
  } = root.AgentSessionFormat;
  const P = root.AgentSessionPanel;
  const {
    providers, shortProviders, labels, sectionNames, usageLabels, defaultOrder, specFor, navigable,
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
    const child = row !== target ? '하위 ' : '';
    if (target.replyUnread && target.status === 'done') {
      return { name: 'unread', text: child + '새 응답', label: child + '새 응답', since: target.replyAt, kind: 'ago' };
    }
    if ((target.status === 'working' || target.status === 'approval' || target.status === 'input') && target.quiet) {
      return { name: 'quiet', text: child + '신호 없음', label: child + '신호 없음', since: target.signalAt, kind: 'for' };
    }
    const text = child + labels[target.status];
    if (isWait(target)) {
      return { name: target.status, text, label: text, short: child + (target.status === 'input' ? '답변' : '승인'), since: target.waitSince, kind: 'for' };
    }
    if (target.status === 'working') {
      return { name: 'working', text, label: section === 'working' && !child ? '' : text, since: target.workSince, kind: 'for' };
    }
    if (target.status === 'error') {
      const reason = target.errorReason ? errorLabel(target.errorReason) : (ctx.quotaHintForError(target) ? '한도 도달' : labels.error);
      const label = child + reason;
      return { name: target.errorAcked ? 'error-acked' : 'error', text: label, label, since: target.updatedAt, kind: 'ago' };
    }
    return { name: target.status, text, label: section === 'history' ? '' : text, since: target.updatedAt, kind: 'ago', fallback: '방금' };
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
      aside.title = '시간이 지나면 공식 채팅에서 처리합니다.';
    } else if (!owner && row.progress) {
      const pct = Math.round((row.progress.done / row.progress.total) * 100);
      aside = element('span', 'aside mini-progress');
      const track = element('span', 'mini-progress-track');
      track.setAttribute('aria-hidden', 'true');
      const fill = element('span', 'mini-progress-fill');
      fill.style.transform = 'scaleX(' + Number((pct / 100).toFixed(4)) + ')';
      track.append(fill);
      aside.append(track, document.createTextNode(row.progress.done + '/' + row.progress.total));
      aside.title = '계획 ' + row.progress.total + '단계 중 ' + row.progress.done + '단계 완료 (' + pct + '%)';
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
      { text: row.changed && '파일 ' + row.changed + '개', cls: 'meta-files' },
      { text: row.project && !row.isSubagent && row.project !== ctx.state.workspaceLabel && row.project },
    ].filter(p => p.text);
    for (const piece of pieces) meta.append(element('span', 'meta' + (piece.cls ? ' ' + piece.cls : ''), piece.text));
    if (meta.childNodes.length) opener.append(meta);
    else line.classList.add('bare');
    opener.title = (row !== target ? title + ' → ' + visible(target.title) : title) +
      (target.viaParent ? ' · 부모 대화에서 열기' : '') + '\n' + name + ' · ' + status + (shownAbout ? '\n' + shownAbout : '') + '\n' + executionNote(row, now);
    opener.setAttribute('aria-label', [title, status, shownAbout, name, model, effort && '추론 강도 ' + effort, row.pinned && '고정됨',
      row.progress && '계획 ' + row.progress.done + '/' + row.progress.total,
      !token && target.viaParent && '부모 대화 열기'].filter(Boolean).join(' · '));
    line.append(opener);
    const badge = element('span', 'status');
    if (info.label) {
      badge.append(element('span', 'status-text', info.short || info.label));
      if (info.short) badge.append(element('span', 'status-rest', info.label.slice(info.short.length).trim()));
    }
    if (info.since) {
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
    const menu = button('more' + (rich ? ' has-story' : ''), row.title + ' 작업 내용 자세히 보기 (I)');
    menu.dataset.control = 'more';
    menu.title = rich ? '작업 내용 보기 (I)' : '자세히 (I)';
    menu.setAttribute('aria-expanded', String(detailed));
    menu.append(icon('more', 'icon small'));
    controls.append(menu);
    if (childSummary?.total) {
      const breakdown = [
        childSummary.active && '진행 ' + childSummary.active,
        childSummary.done && '완료 ' + childSummary.done,
        childSummary.quiet && '신호 없음 ' + childSummary.quiet,
        childSummary.other && '이전 ' + childSummary.other,
      ].filter(Boolean).join(' · ');
      const pillText = childSummary.active > 0 && childSummary.active < childSummary.total
        ? childSummary.active + '/' + childSummary.total : String(childSummary.total);
      const toggle = button('children-toggle' + (childSummary.active > 0 ? ' has-active' : ''),
        row.title + ' · 하위 작업 ' + childSummary.total + '개' + (breakdown ? ' (' + breakdown + ')' : '') + ' ' + (expanded ? '접기' : '펼치기'));
      toggle.dataset.control = 'children';
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.title = toggle.getAttribute('aria-label');
      toggle.append(icon('agent', 'icon tiny'), document.createTextNode(pillText), element('span', 'chevron'));
      controls.append(toggle);
    }
    if (row.pinned) {
      const pin = element('span', 'pin-mark');
      pin.title = '고정됨';
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
        stats.done && '완료 ' + stats.done,
        stats.quiet && '신호 없음 ' + stats.quiet,
        stats.other && '이전 ' + stats.other,
      ].filter(Boolean).join(' · ') || '이전 하위 작업 ' + nodes.length;
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
        item.title = '부모 세션이 목록에 없는 서브에이전트';
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
          const toggle = button('child-bucket-toggle', row.title + ' · ' + label + ' ' + (bucketOpen ? '접기' : '펼치기'));
          toggle.dataset.control = 'settledChildren';
          toggle.dataset.target = row.key;
          toggle.setAttribute('aria-expanded', String(bucketOpen));
          const chevron = element('span', 'chevron');
          chevron.setAttribute('aria-hidden', 'true');
          toggle.append(element('span', 'child-bucket-label', label), chevron);
          const clean = button('child-clean', row.title + ' · 완료되거나 신호 없는 하위 작업 정리', '정리');
          clean.dataset.action = 'dismissChildren';
          clean.dataset.target = row.key;
          clean.dataset.provider = row.provider;
          clean.title = '완료되거나 신호가 없는 하위 작업 숨기기';
          bucket.append(toggle, clean);
          nested.append(bucket);
          if (bucketOpen) for (let i = 0; i < settledChildren.length; i++) appendTree(settledChildren[i], nested, undefined, 'child-settled');
        } else if (settledChildren.length) {
          for (let i = 0; i < settledChildren.length; i++) appendTree(settledChildren[i], nested, undefined, 'child-settled');
          if (settledChildren.some(c => c.row.quiet || c.row.status === 'stale')) {
            const footer = element('li', 'child-bucket inline-clean');
            footer.dataset.bucket = 'clean';
            footer.dataset.target = row.key;
            const clean = button('child-clean', row.title + ' · 완료되거나 신호 없는 하위 작업 정리', '완료·신호 없음 정리');
            clean.dataset.action = 'dismissChildren';
            clean.dataset.target = row.key;
            clean.dataset.provider = row.provider;
            clean.title = '완료되거나 신호가 없는 하위 작업 숨기기';
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
        const toggle = button('section-toggle', sectionNames[name] + ' ' + nodes.length + '개 ' + (ctx.historyCollapsed ? '펼치기' : '접기'));
        toggle.dataset.control = 'history';
        toggle.setAttribute('aria-expanded', String(!ctx.historyCollapsed));
        const chevron = element('span', 'chevron');
        chevron.setAttribute('aria-hidden', 'true');
        toggle.append(element('span', '', sectionNames[name]), element('span', 'section-count', String(nodes.length)), chevron);
        headingWrap.append(toggle);
        head.append(headingWrap);
      } else {
        const heading = element('span', '', sectionNames[name]);
        heading.setAttribute('role', 'heading');
        heading.setAttribute('aria-level', '2');
        head.append(heading, element('span', 'section-count', String(nodes.length)));
        if (name === 'attention' && ctx.state.unreadCount > 0 &&
            nodes.some(node => [node.row, ...family(node)].some(r => r.replyUnread && r.status === 'done'))) {
          const markAll = button('section-action', '새 응답 모두 읽음 표시', '모두 읽음');
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
    meter.setAttribute('aria-valuetext', percentLabel(left) + '% 남음');
    meter.dataset.level = left <= 10 ? 'low' : left <= 25 ? 'warn' : 'ok';
    return meter;
  }
  const levelNote = left => left <= 10 ? '거의 소진' : left <= 25 ? '얼마 남지 않음' : '';
  const levelClass = left => left <= 10 ? 'level-low' : left <= 25 ? 'level-warn' : '';

  function windowRow(window, now = Date.now()) {
    const box = element('div', 'quota-window');
    box.dataset.key = window.label;
    const left = leftOf(window);
    const values = element('div', 'window-values');
    const label = element('span', 'window-label', window.label);
    if (window.resetsAt) {
      const reset = new Date(window.resetsAt);
      const inText = resetInText(window.resetsAt, now);
      const t = element('time', 'quota-reset', (inText ? inText + ' · ' : '') + resetLabel(window.resetsAt, now) + ' 초기화');
      t.dateTime = reset.toISOString();
      t.dataset.resetAt = window.resetsAt;
      t.title = dateTimeShort.format(reset);
      label.append(t);
    }
    const figure = element('span', 'quota-amount');
    const noteText = levelNote(left);
    if (noteText) figure.append(icon('warn', 'icon tiny ' + levelClass(left)));
    figure.append(document.createTextNode(percentLabel(left) + '% 남음'));
    values.append(label, figure);
    values.title = [window.label, percentLabel(window.percent) + '% ' + (window.kind === 'remaining' ? '남음' : '사용'), noteText]
      .filter(Boolean).join(' · ');
    box.append(values, limitMeter(window.label, left));
    return box;
  }

  function renderQuota(id, name, ctx) {
    const quota = ctx.state.quotas?.[id] || { status: 'unavailable', windows: [] };
    const section = element('div', 'subscription');
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', name + ' 구독 한도');
    const windows = quota.windows || [];
    for (const window of windows.slice(0, 4)) section.append(windowRow(window, ctx.now));
    if (windows.length > 4) {
      const open = ctx.extraLimits.has(id);
      const toggle = button('quota-extra usage-link', name + ' 추가 한도 ' + (windows.length - 4) + '개',
        open ? '추가 한도 접기' : '추가 한도 ' + (windows.length - 4) + '개 보기');
      toggle.dataset.control = 'extraLimits';
      toggle.setAttribute('aria-expanded', String(open));
      section.append(toggle);
      if (open) for (const window of windows.slice(4)) section.append(windowRow(window, ctx.now));
    }
    let note;
    if (quota.status === 'loading') note = '조회 중…';
    if (quota.status === 'stale') note = '최근 조회값' + (quota.updatedAt ? ' · ' + resetLabel(quota.updatedAt, ctx.now) : '');
    if (quota.status === 'unavailable') note = quota.message || '한도를 확인할 수 없습니다.';
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
      const refresh = button('icon-button quota-refresh', name + ' 구독 한도 새로 고침');
      refresh.dataset.action = 'refreshQuota';
      refresh.title = '구독 한도 새로 고침';
      refresh.disabled = quota?.status === 'loading';
      refresh.append(icon('refresh'));
      header.append(refresh);
    } else {
      const isCollapsed = ctx.collapsed.has(id);
      const toggle = button('group-toggle', name + ' 세션 ' + rows.length + '개');
      toggle.dataset.control = 'group';
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.setAttribute('aria-controls', 'list-' + id);
      const chevron = element('span', 'chevron');
      chevron.setAttribute('aria-hidden', 'true');
      toggle.append(mark, nameText);
      const attention = rows.filter(row => attentionRank(row) >= 0).length;
      if (isCollapsed && attention) {
        toggle.append(element('span', 'group-alert', '확인 ' + attention));
        toggle.setAttribute('aria-label', name + ' 세션 ' + rows.length + '개, 확인 필요 ' + attention + '개');
      } else if (rows.length) toggle.append(element('span', 'count', String(rows.length)));
      toggle.append(chevron);
      heading.append(toggle);
      if (ctx.state.preferences?.sort === 'manual') {
        const order = ctx.state.preferences.providerOrder;
        for (const [direction, caption, glyph, boundary] of [
          ['up', '위로 이동', '↑', 0], ['down', '아래로 이동', '↓', order.length - 1],
        ]) {
          const move = button('icon-button', name + ' ' + caption, glyph);
          move.dataset.action = 'moveProvider';
          move.dataset.direction = direction;
          move.title = name + ' ' + caption;
          move.disabled = order.indexOf(id) === boundary;
          header.append(move);
        }
      }
      const start = button('icon-button', name + ' 새 세션 시작');
      start.title = name + ' 새 세션 시작';
      start.dataset.action = 'start';
      start.append(icon('plus'));
      header.append(start);
    }
    section.append(header);
    if (ctx.quotaOverview) {
      section.append(renderQuota(id, name, ctx));
      const usage = element('div', 'provider-usage');
      if (ctx.state.usage?.[id]) usage.append(element('span', 'usage-number', ctx.state.usage[id]));
      const viewUsage = button('usage-link', name + ' ' + usageLabels[id], usageLabels[id]);
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
    bar.setAttribute('aria-label', '세션 필터 및 검색');
    const row = element('div', 'command-row');
    const track = element('div', 'lens-track');
    track.setAttribute('role', 'group');
    track.setAttribute('aria-label', '상태별 보기');
    const { counts } = ctx.derived.buckets;
    const tabs = [
      ['all', '전체', counts.all, ''],
      ['attention', '확인', counts.attention, counts.attention ? (counts.hasUrgent ? 'attn' : 'unread') : ''],
      ['working', '진행', counts.working, counts.working ? 'work' : ''],
    ];
    for (const [id, label, count, dotKind] of tabs) {
      const btn = button('lens-btn', label + ' ' + count + '개');
      btn.dataset.control = 'lens';
      btn.dataset.value = id;
      btn.setAttribute('aria-pressed', String(ctx.lens === id));
      if (dotKind) btn.append(element('span', 'lens-dot' + (dotKind === 'work' ? ' work' : dotKind === 'unread' ? ' unread' : '')));
      btn.append(document.createTextNode(label));
      if (count > 0 || id === 'all') btn.append(element('span', 'lens-count', String(count)));
      track.append(btn);
    }
    const toggle = button('search-toggle', ctx.searchOpen ? '검색 닫기' : '세션 검색 (/)');
    toggle.dataset.control = 'searchToggle';
    toggle.setAttribute('aria-pressed', String(ctx.searchOpen || Boolean(ctx.searchQuery) || ctx.providerFilter !== 'all'));
    toggle.title = '세션 검색 (/)';
    toggle.append(icon('search', 'icon small'));
    row.append(track, toggle);
    bar.append(row);

    if (ctx.searchOpen) {
      const drawer = element('div', 'search-drawer');
      const box = element('div', 'search-box');
      box.append(icon('search', 'icon tiny'));
      const input = element('input', 'search-input');
      input.type = 'text';
      input.placeholder = '제목, 요청, 파일, 모델 검색…';
      input.setAttribute('aria-label', '세션 검색');
      input.dataset.control = 'searchInput';
      input.value = ctx.searchQuery;
      box.append(input);
      if (ctx.searchQuery) {
        const clear = button('search-clear', '검색어 지우기', '×');
        clear.dataset.control = 'clearSearch';
        box.append(clear);
      }
      drawer.append(box);
      const present = ctx.derived.presentProviders;
      if (present.size > 1 || ctx.providerFilter !== 'all') {
        const chips = element('div', 'provider-chips');
        chips.setAttribute('role', 'group');
        chips.setAttribute('aria-label', '에이전트별 필터');
        const allChip = button('provider-chip', '모든 에이전트 보기', '전체');
        allChip.dataset.control = 'providerFilter';
        allChip.dataset.value = 'all';
        allChip.setAttribute('aria-pressed', String(ctx.providerFilter === 'all'));
        chips.append(allChip);
        for (const [id, name, mono] of providers) {
          if (!present.has(id) && ctx.providerFilter !== id) continue;
          const chip = button('provider-chip', name + ' 세션만 보기');
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
          ? 'Codex가 훅 상태 조회에 응답하지 않았습니다. CLI의 /hooks에서 상태를 확인한 후 다시 확인해 주세요.'
          : noLive
          ? 'Codex CLI의 /hooks에서 훅을 신뢰해 주세요. 훅 없이는 작업 중·승인 대기를 확인할 수 없습니다.'
          : 'Codex CLI의 /hooks에서 훅을 신뢰해 주세요. 신뢰 전에는 실행 여부만 감지되며 승인 대기·활동은 빠집니다.';
        const heading = name + (status === 'unverified' ? ' 훅 신뢰 상태 미확인' : ' 훅 신뢰 필요');
        notice.title = heading + '\n' + noteText;
        const head = element('div', 'connect-head');
        head.append(icon('warn', 'icon small'), element('span', 'connect-text', heading));
        const actions = element('div', 'connect-actions');
        const guide = button('mini', name + ' /hooks 신뢰 안내 보기', '/hooks');
        guide.dataset.action = 'trustGuide';
        guide.title = '/hooks 신뢰 방법 보기';
        const recheck = button('mini quiet', name + ' 훅 신뢰 상태 다시 확인', '확인');
        recheck.dataset.action = 'refresh';
        recheck.title = '신뢰 상태 다시 확인';
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
        ? name + ' 훅이 없어 작업 중 상태와 승인 대기를 확인할 수 없습니다. 최근 대화만 표시됩니다.'
        : name + ' 훅이 없어 승인 대기·세부 활동을 받지 못합니다. 로컬 실행 여부와 최근 대화만 표시됩니다.';
      notice.title = status === 'update' ? name + ' 훅 구성이 이 버전과 달라 일부 상태가 빠질 수 있습니다.'
        : (id === 'codex' ? codexMissingTip : name + ' 훅이 없어 실시간 상태를 받지 못합니다. 최근 대화만 표시됩니다.');
      notice.append(icon('link', 'icon small'), element('span', 'connect-text', name + (status === 'update' ? ' 훅 업데이트 필요' : ' 훅 연결 안 됨')));
      const connect = button('mini', name + (status === 'update' ? ' 훅 업데이트' : ' 연결'), status === 'update' ? '업데이트' : '연결');
      connect.dataset.action = 'connect';
      notice.append(connect);
      if (status === 'missing') {
        const hide = button('mini quiet', name + ' 연결 안내 숨기기', '숨기기');
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
      ['attentionOnly', 'setAttentionOnly', '확인이 필요한 세션만 표시 중'],
      ['hideCompleted', 'setHideCompleted', '완료된 세션 숨김' + (state.hiddenCompleted ? ' · ' + state.hiddenCompleted + '개' : '')],
    ]) {
      if (!state.preferences?.[key]) continue;
      const notice = element('div', 'connect');
      notice.dataset.filter = key;
      notice.append(icon('sort', 'icon small'), element('span', 'connect-text', text));
      const clear = button('mini', text + ' 해제', '해제');
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
    const retry = button('mini', '세션 상태 다시 읽기', '다시 시도');
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
    const text = element('span', 'filter-alert-text', '필터 밖에서 확인 필요 ' + hiddenWaiting.length + '건');
    const viewBtn = button('filter-alert-btn', '필터를 해제하고 대기 중인 세션 보기', '보기');
    viewBtn.dataset.control = 'showHiddenAttention';
    notice.append(dot, text, viewBtn);
    return [notice];
  }

  function skeletonState() {
    const wrap = element('div', 'skeleton-list');
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-label', '세션 목록 불러오는 중');
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
    footer.setAttribute('aria-label', '다른 폴더와 구독 잔여 한도');
    if (state.elsewhere?.length) {
      const strip = element('div', 'elsewhere');
      strip.setAttribute('role', 'group');
      strip.setAttribute('aria-label', '다른 폴더에서 기다리는 요청');
      strip.append(element('span', 'elsewhere-label', '다른 폴더'));
      for (const item of state.elsewhere) {
        const parts = [item.input && '답변 ' + item.input, item.approval && '승인 ' + item.approval].filter(Boolean).join(' · ');
        const open = button('elsewhere-folder', item.folder + ' · ' + parts + ' · 폴더 열기');
        open.dataset.action = 'openFolder';
        open.dataset.cwd = item.cwd;
        open.title = item.cwd + '\n' + parts + ' 대기 · 눌러서 그 폴더의 창 열기';
        const countEl = element('span', 'elsewhere-count' + (item.input && !item.approval ? ' is-input' : ''), parts);
        open.append(element('span', 'elsewhere-name', item.folder), countEl);
        strip.append(open);
      }
      footer.append(strip);
    }
    footer.append(element('h2', 'footer-head', '남은 한도'));
    const list = element('div', 'quota-list');
    for (const [id, name, mono] of providers) {
      const quota = state.quotas?.[id];
      const windows = quota?.windows ?? [];
      const window = representativeWindow(id, windows);
      const tile = button('quota-tile', name + ' 구독 한도');
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
          note.append(percentLabel(leftOf(low[0])) + '% ', element('span', 'note-name', limitName(low[0].label)));
          period.append(icon('warn', 'icon tiny level-low'));
        } else note.append(element('span', 'note-name', shortLimitLabel(window.label)));
        period.append(note);
        if (quota.status === 'stale') {
          period.classList.add('old');
          period.append(element('span', 'note-old', '이전'));
        }
        const resetIn = window.resetsAt ? resetInText(window.resetsAt, now) : '';
        tile.title = [
          name + ' · ' + window.label,
          amount + ' 남음' + (noteText ? ' · ' + noteText : ''),
          window.resetsAt && resetLabel(window.resetsAt, now) + ' 초기화' + (resetIn ? ' (' + resetIn + ')' : ''),
          ...low.map(w => w.label + ' ' + percentLabel(leftOf(w)) + '% 남음'),
          quota.status === 'stale' && '최근 조회값' + (quota.updatedAt ? ' · ' + resetLabel(quota.updatedAt, now) : ''),
        ].filter(Boolean).join('\n');
      } else {
        const pending = quota?.status === 'loading';
        figure.append(element('strong', 'tile-value none', '—'));
        bar = element('span', 'tile-bar');
        period.classList.add('empty-note');
        period.append(element('span', 'tile-note', pending ? '조회 중' : '조회 불가'));
        tile.title = name + ' · ' + (quota?.message || (pending ? '조회 중' : '한도를 확인할 수 없습니다.'));
      }
      tile.setAttribute('aria-label', tile.title.replaceAll('\n', ' · ') + ' · 자세히 보기');
      tile.append(figure, bar, period);
      list.append(tile);
    }
    footer.append(list);
    return footer;
  }

  function toolbar() {
    const bar = element('div', 'toolbar');
    const back = button('mini', '세션으로 돌아가기');
    back.dataset.control = 'quotaOverview';
    back.append(icon('back', 'icon tiny'), document.createTextNode('세션'));
    bar.append(back, element('h2', 'workspace-name', '구독 한도'), element('span', '', ''));
    return bar;
  }

  Object.assign(P, {
    quotaHintForError, deriveView, countdownState, sessionList, group,
    commandBar, connectNotices, filterNotices, scanErrorNotice, hiddenAttentionNotice,
    skeletonState, emptyState, quotaFooter, toolbar,
  });
})(globalThis);
