'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { PROVIDERS, STATES, createSessionReader, pruneExpiredSessions, resolveSessionWaits, deduplicateGenericParentApprovals, counts, sessionLabel } = require('./model.cjs');
const { prepareRuntime, nodeExecutable } = require('./runtime.cjs');
const { configureHooks, hookStatus } = require('./setup.cjs');
const { openSession, startSession, openUsage } = require('./navigation.cjs');
const { createPanel, normalizePreferences } = require('./panel.cjs');
const { createWorkspaceScope, arrangeSessions, undismissedSessions, markQuiet, waitingElsewhere } = require('./workspace-sessions.cjs');
const { createMetadataReader, createRecentReader } = require('./metadata.cjs');
const { readCodexLiveRuns, readCodexResolvedPending, readAgyResolvedSteps, liveStateFingerprint } = require('./live-state.cjs');
const { createChildReader } = require('./children.cjs');
const { createQuotaReader } = require('./quota.cjs');
const { createQuotaCache } = require('./quota-cache.cjs');
const { listen, findWindowForFolder } = require('./manual.cjs');
const { createNotifier, NOTIFICATIONS_SETTINGS_URL } = require('./notify.cjs');
const { mergeExecution, createReceipts } = require('./inbox.cjs');
const { DAY, VENDORS, isUnderDir } = require('./shared.cjs');
const { createAlerts } = require('./alerts.cjs');
const { createConnections } = require('./connections.cjs');
const { createActions } = require('./commands.cjs');

const PREFIX = 'agentSessionMonitor.';
const VIEW = PREFIX + 'sessions';
const EXTENSION_ID = 'local-tools.agent-session-monitor';
const ACTIVE = new Set(['working', 'approval', 'input']);
const WAITING = new Set(['approval', 'input']);
// Steps can arrive several times a second; the rows they change are redrawn at most this often.
const ACTIVITY_RENDER_MS = 250;
const PRUNE_STORAGE_MS = 3600000;
const STALE_STATE_AGE_MS = 14 * DAY;
const FOLDER_CACHE_TTL_MS = 5000;
const LIVE_POLL_MS = 3500;
const LIVE_POLL_HOOKED_MS = 12000;
// The metadata reader reuses its answer for 1.5 s within a burst of scans; one trailing
// read after the burst picks up whatever the last of those scans did not look at.
const METADATA_TRAIL_MS = 1600;
// User-named titles and pins outlive sessions; only those unseen for half a year go.
const NAMED_STATE_AGE_MS = 180 * DAY;
const SEEN_KEY = 'namedSessionsSeen.v1';
const setting = (name, fallback) => vscode.workspace.getConfiguration('agentSessionMonitor').get(name, fallback);
const reason = error => error instanceof Error ? error.message : String(error ?? '');
const settle = thenable => Promise.resolve(thenable).catch(() => {});

// Seconds in the setting; the hook clamps the descriptor value to the same range.
function inlineWindow(seconds) {
  const value = Number(seconds);
  return Math.round((Number.isFinite(value) ? Math.min(540, Math.max(15, value)) : 45) * 1000);
}

async function activate(context) {
  const root = context.globalStorageUri.fsPath;
  const directory = path.join(root, 'sessions');
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const output = vscode.window.createOutputChannel?.('에이전트 세션 모니터');
  const log = (tag, detail) => {
    if (!output) return;
    const stamp = new Date().toISOString().slice(11, 19);
    try { output.appendLine(`[${stamp}] [${tag}] ${detail}`); } catch { /* ignore output errors */ }
  };

  let alive = true, queued = false, timer, scanPromise, bridge, previous, watcher, watchRetryTimer, activityRender, titleTimer, softWaitTimer, livePollTimer, metadataTrailTimer;
  let watchBackoffMs = 1000, lastClockScanAt = Date.now(), codexLiveDetection = 'unknown', lastLiveFp = '';
  let rows = [], elsewhere = [], activeScope, workspaceRevision = 0, forceQueued = false, metadataRefreshAt = 0;
  let cachedScopeKey = '', cachedRoots;
  const folderCheckCache = new Map();
  let scanError = '', windowBaseUri = '', lastPruneAt = 0, titleCheckAttempts = 0, titleCheckSignature = '';
  const notifier = createNotifier({ directory: path.join(root, 'notifications'), extensionPath: context.extensionPath });
  const sessionReader = createSessionReader();
  const layoutKey = 'sessionLayout.v1';
  const saved = context.workspaceState.get(layoutKey) || {};
  // Legacy automatic layouts persisted their default even for a filter-only edit.
  const legacyAuto = !saved.version && ['recent', 'attention'].includes(saved.preferences?.sort);
  let preferences = normalizePreferences(legacyAuto ? { ...saved.preferences, sort: 'priority' } : saved.preferences);
  const pins = new Set(Array.isArray(saved.pins) ? saved.pins.filter(key => typeof key === 'string') : []);
  let layoutWrite = Promise.resolve();
  const receipts = createReceipts(context.workspaceState, render, () => {
    if (alive) void settle(vscode.window.showWarningMessage('이 작업 공간의 응답 확인 상태를 저장하지 못했습니다.'));
  });
  let shownProviderOrder = preferences.providerOrder;
  const otherFolders = () => setting('otherFolders', true) !== false;
  const activityShown = () => setting('activityDetail', true) !== false;

  const currentFolders = () => (vscode.workspace.workspaceFolders || [])
    .filter(folder => folder.uri.scheme === 'file' && (!folder.uri.authority || folder.uri.authority === 'localhost'));
  const isRemoteWorkspace = () => (vscode.workspace.workspaceFolders || []).length > 0 && currentFolders().length === 0;
  const workspaceGroupId = () => {
    const folders = currentFolders();
    return folders.length ? folders.map(f => f.uri.fsPath).sort().join('|') : 'agent-session-monitor';
  };
  const workspaceLabel = () => currentFolders().map(folder => folder.name || path.basename(folder.uri.fsPath)).join(' · ');
  // Advertised in this window's descriptor: a hook contacts no window that does not want it.
  const activityWanted = () => alive && vscode.workspace.isTrusted && activityShown() && currentFolders().length > 0;

  function workspaceRootFor(cwd) {
    const folders = currentFolders();
    if (!folders.length) return '';
    if (typeof cwd === 'string' && path.isAbsolute(cwd)) {
      const matched = vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(cwd));
      if (matched?.uri?.fsPath) return matched.uri.fsPath;
      const resolved = path.resolve(cwd);
      for (const folder of folders) {
        if (isUnderDir(resolved, folder.uri.fsPath)) return folder.uri.fsPath;
      }
    }
    return folders[0].uri.fsPath;
  }

  async function buildFocusUri({ key, cwd } = {}) {
    const scheme = vscode.env?.uriScheme;
    if (!scheme || typeof vscode.Uri?.from !== 'function') return '';
    const params = new URLSearchParams();
    if (typeof key === 'string' && key) params.set('key', key);
    if (typeof cwd === 'string' && cwd) params.set('cwd', cwd);
    const raw = vscode.Uri.from({ scheme, authority: context.extension?.id || EXTENSION_ID, path: '/focus', query: params.toString() });
    // Encoded form: a folder name with spaces, Hangul, '#' or '&' must neither end the
    // query early nor make the link unparsable for the native notifier's URL(string:).
    try {
      const bound = typeof vscode.env?.asExternalUri === 'function' ? await vscode.env.asExternalUri(raw) : raw;
      return typeof bound?.toString === 'function' ? bound.toString() : '';
    } catch {
      return typeof raw?.toString === 'function' ? raw.toString() : '';
    }
  }

  async function refreshWindowUri() {
    windowBaseUri = await buildFocusUri();
    if (windowBaseUri) void bridge?.updateWindow();
  }

  function saveLayout() {
    const snapshot = { version: 2, preferences, pins: [...pins] };
    render();
    layoutWrite = layoutWrite.catch(() => {}).then(() => context.workspaceState.update(layoutKey, snapshot)).catch(() => {
      if (alive) void settle(vscode.window.showWarningMessage('이 작업 공간의 목록 설정을 저장하지 못했습니다.'));
    });
    return layoutWrite;
  }

  let metadata = { sessions: new Map(), providerUsage: {} };
  const readMetadata = createMetadataReader();
  const readRecent = createRecentReader();
  const readChildren = createChildReader();
  const extensionPath = id => vscode.extensions.getExtension(id)?.extensionPath;
  const codexPlatform = process.platform === 'darwin' ? 'macos' : process.platform;
  const codexArch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const claudeBin = () => {
    const root = extensionPath(VENDORS.claude);
    return root && path.join(root, 'resources/native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
  };
  const codexBin = () => {
    const root = extensionPath(VENDORS.codex);
    return root && path.join(root, 'bin', codexPlatform + '-' + codexArch, process.platform === 'win32' ? 'codex.exe' : 'codex');
  };
  const readQuota = createQuotaReader({
    claudePath: claudeBin,
    codexPath: codexBin,
  });
  const quotaCache = createQuotaCache(path.join(root, 'quotas'), readQuota, { onChange: render });
  const quotaEnabled = () => setting('subscriptionUsage', true);
  function updateQuotas(provider, manual = false) {
    if (!alive || !panel.isVisible() || !vscode.window.state.focused || !vscode.workspace.isTrusted || !quotaEnabled()) return;
    const targets = provider ? [provider] : Object.keys(PROVIDERS);
    return Promise.all(targets.map(id => quotaCache.update(id, { manual })));
  }

  const getAlias = key => context.globalState.get('alias:' + key);
  const getTitle = row => sessionLabel(row, getAlias(row.key) || (row.isSubagent && row.title) || metadata.sessions.get(row.key)?.title || row.title);

  let actions;
  const connections = createConnections({
    vscode, context, root, directory, codexPath: codexBin, hookStatus, configureHooks, prepareRuntime, nodeExecutable,
    isAlive: () => alive, render, log, reason, settle,
  });

  const panel = createPanel(vscode, context.extensionUri, message => settle(actions.act(message)), visible => {
    if (!visible || !panel.canHandleRequests()) bridge?.deferAll();
    if (visible) { schedule(); scheduleLivePoll(); queueMicrotask(() => updateQuotas()); void connections.refreshConnections(); }
    else { clearTimeout(titleTimer); titleTimer = undefined; clearTimeout(livePollTimer); livePollTimer = undefined; }
  }, () => {
    // If the user applies a filter that hides Claude requests, immediately hand any pending
    // inline Claude request back to native chat instead of trapping it for 45-540s.
    if (!panel.canHandleRequests('claude')) bridge?.deferAll();
  });
  const registration = vscode.window.registerWebviewViewProvider(VIEW, panel);
  const status = vscode.window.createStatusBarItem('agentSessionMonitor', vscode.StatusBarAlignment.Left, 42);
  status.name = '에이전트 세션 모니터';
  status.command = VIEW + '.focus';
  status.show();

  function annotateLifecycle(source, now = Date.now()) {
    if (!source.length) return [];
    const detailed = activityShown();
    return markQuiet(source.map(row => {
      const native = metadata.sessions.get(row.key);
      const errorAcked = receipts.errorAcked(row);
      const hookActivityAt = detailed ? (bridge?.activityFor(row.key)?.activity?.at || 0) : 0;
      const activityAt = Math.max(row.activityAt || 0, hookActivityAt);
      const interruptedAt = native?.interruptedAt;
      const turnInterruptedAt = native?.turnInterruptedAt;
      if (!errorAcked && !interruptedAt && !turnInterruptedAt && !hookActivityAt && (!activityAt || activityAt === row.activityAt)) return row;
      return {
        ...row,
        ...(hookActivityAt && { hookActivityAt }),
        ...(activityAt && { activityAt }),
        ...(errorAcked && { errorAcked: true }),
        ...(interruptedAt && { interruptedAt }),
        ...(turnInterruptedAt && { turnInterruptedAt }),
      };
    }), now);
  }

  function projectRow(row, detailed = activityShown()) {
    const {
      softPendingRefs: _sr, nextSoftWaitAt: _ns, hookActivityAt: _ha,
      pendingEntries: _pe, pendingSoftEntries: _pse, turn: _t, liveTurnConfirmed: _live,
      ...visibleRow
    } = row;
    const native = metadata.sessions.get(row.key);
    const waiting = WAITING.has(row.status);
    const pending = !row.isSubagent && waiting ? bridge?.forSession(row.key) : undefined;
    const action = row.status === 'input' && pending?.kind === 'approval' ? undefined : pending;
    // Content of a request that only its own chat can answer, while that request is open.
    const preview = waiting && !action ? bridge?.previewFor(row.key, row.pendingRefs) : undefined;
    // What the session was asked, is doing and answered, as its hooks reported it to this window.
    const activity = detailed ? bridge?.activityFor(row.key) : undefined;
    const activityAt = Math.max(row.activityAt || 0, activity?.activity?.at || 0);
    // Both native sources are merged field by field. Metadata comes first: it is read after
    // the scan's own native rows and again between scans, so on a tie it is the fresher one.
    const nativeExecution = mergeExecution(native?.execution, row.nativeExecution, row.provider);
    return {
      ...visibleRow, title: getTitle(row), pinned: !row.isSubagent && pins.has(row.key), usage: native?.usage,
      execution: mergeExecution(nativeExecution, row.execution, row.provider),
      replyUnread: receipts.unread(row), ...(activityAt && { activityAt }),
      status: action?.kind === 'question' ? 'input' : row.status, action, ...(preview && { preview }), ...activity,
    };
  }

  function projectRows(annotated = annotateLifecycle(rows)) {
    const detailed = activityShown();
    return annotated.map(row => projectRow(row, detailed));
  }

  const alerts = createAlerts({
    vscode, context, directory, notifier, notificationsSettingsUrl: NOTIFICATIONS_SETTINGS_URL,
    findWindowForFolder, panel, receipts, quotaCache, setting, quotaEnabled, otherFolders, activityShown,
    isAlive: () => alive, getWorkspaceRevision: () => workspaceRevision, getRows: () => rows,
    getTitle, projectRow, workspaceRootFor, workspaceGroupId, workspaceLabel, buildFocusUri,
    workspaceGroups: () => currentFolders().map(folder => folder.uri.fsPath),
    onOpenFolder: cwd => actions.openFolder(cwd), onReviewRow: row => actions.reviewRow(row), log, settle,
  });

  actions = createActions({
    vscode, context, prefix: PREFIX, viewId: VIEW, directory,
    openSession: (vs, target) => openSession(vs, target, {
      agySource: metadata.sessions.get(target.key)?.agySource,
      workspaceStateDb: context.storageUri?.fsPath && path.join(context.storageUri.fsPath, '..', 'state.vscdb'),
    }),
    startSession, openUsage,
    findWindowForFolder, panel, receipts, alerts, connections,
    isAlive: () => alive, getWorkspaceRevision: () => workspaceRevision, getRows: () => rows,
    getElsewhere: () => elsewhere, getActiveScope: () => activeScope, getBridge: () => bridge,
    getPreferences: () => preferences, setPreferences: next => { preferences = next; },
    getShownProviderOrder: () => shownProviderOrder, pins, getAlias, getTitle, otherFolders,
    workspaceRootFor, annotateLifecycle, projectRows, saveLayout, render, refresh, updateQuotas, settle,
  });

  function render(annotatedRows) {
    if (!alive) return;
    // This render includes every step received so far.
    clearTimeout(activityRender);
    activityRender = undefined;
    const allSessions = projectRows(annotatedRows);
    const enabled = quotaEnabled() && vscode.workspace.isTrusted;
    const quotas = Object.fromEntries(Object.keys(PROVIDERS).map(id => [id, enabled
      ? quotaCache.entries[id] || { status: 'loading', windows: [] }
      : { status: 'unavailable', windows: [], message: quotaEnabled() ? '신뢰된 작업 폴더에서 확인할 수 있습니다.' : '설정에서 구독 사용량 조회를 켤 수 있습니다.' }]));
    const { sessions, completedCount, workingCount } = arrangeSessions(allSessions, { ...preferences, pinnedKeys: [...pins] });
    const latest = new Map(), attention = new Set();
    for (const row of sessions) {
      latest.set(row.provider, Math.max(latest.get(row.provider) || 0, row.activityAt || 0, row.updatedAt));
      if (STATES[row.status].group === 'attention' && !row.errorAcked && !row.quiet) attention.add(row.provider);
    }
    shownProviderOrder = [...preferences.providerOrder];
    if (preferences.sort !== 'manual') shownProviderOrder.sort((a, b) =>
      (preferences.sort === 'attention' ? Number(attention.has(b)) - Number(attention.has(a)) : 0) ||
      (latest.get(b) || 0) - (latest.get(a) || 0));
    const folders = currentFolders();
    // A quiet turn or quiet wait has produced no signal for a while; acknowledged errors stay visible without alerting.
    const total = counts(allSessions.filter(row =>
      !row.quiet && !row.errorAcked && (!row.isSubagent || STATES[row.status].group === 'attention')));
    total.working = workingCount;
    const unreadCount = allSessions.filter(row => row.replyUnread).length;
    const outside = otherFolders() ? elsewhere : [];
    const outsideCount = outside.reduce((sum, item) => sum + item.input + item.approval, 0);
    const state = {
      sessions, unreadCount, usage: metadata.providerUsage, quotas,
      attentionCount: total.attention, hiddenCompleted: preferences.hideCompleted ? completedCount : 0,
      hasWorkspace: folders.length > 0, isRemoteWorkspace: isRemoteWorkspace(), scanError,
      workspaceLabel: workspaceLabel(), connections: connections.connectionView(), codexLiveDetection, elsewhere: outside,
      preferences: { ...preferences, providerOrder: shownProviderOrder },
    };
    const signature = JSON.stringify([state, total]);
    if (signature === previous) return;
    previous = signature;
    const parts = [['답변', total.input], ['승인', total.approval], ['오류', total.error], ['새 응답', unreadCount], ['진행', total.working],
      ['다른 폴더', outsideCount]].filter(([, count]) => count).map(([label, count]) => label + ' ' + count);
    status.text = '$(list-unordered) ' + (parts.join(' · ') || '에이전트 세션 모니터');
    status.tooltip = scanError || ['에이전트 세션 모니터 열기', ...parts].join(' · ');
    status.accessibilityInformation = { label: status.tooltip };
    // An error stays until it is dismissed, so only an open request colours the item.
    status.backgroundColor = total.input + total.approval ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    // The signature already says whether anything changed; the panel need not serialise again.
    panel.setState(state, signature);
  }

  async function syncMetadataIfChanged() {
    if (!alive || !rows.length || scanPromise) return;
    const revision = workspaceRevision;
    metadataRefreshAt = Date.now();
    try {
      const nextMetadata = await readMetadata(rows.filter(row => !row.isSubagent));
      if (!alive || revision !== workspaceRevision || nextMetadata === metadata) return;
      metadata = nextMetadata;
      render();
    } catch { /* Keep current metadata on transient read errors. */ }
  }

  function scheduleMetadataTrail() {
    clearTimeout(metadataTrailTimer);
    metadataTrailTimer = undefined;
    if (!alive || !rows.length) return;
    metadataTrailTimer = setTimeout(() => {
      metadataTrailTimer = undefined;
      void syncMetadataIfChanged();
    }, METADATA_TRAIL_MS);
  }

  function scheduleTitleCheck() {
    clearTimeout(titleTimer);
    titleTimer = undefined;
    if (!alive || !panel.isVisible() || !vscode.window.state.focused || !rows.length) return;
    const untitledKeys = [];
    let needsChildName = false;
    for (const row of rows) {
      if (!row.isSubagent) {
        if (!getAlias(row.key) && !metadata.sessions.get(row.key)?.title && !row.title) untitledKeys.push(row.key);
      } else if (ACTIVE.has(row.status) && !getAlias(row.key) &&
          (!row.title || /^(?:self|default|general-purpose|서브에이전트(?:\s*·.*)?)$/i.test(row.title))) {
        untitledKeys.push(row.key);
        needsChildName = true;
      }
    }
    // Stop polling once all visible sessions and active children have resolved titles.
    if (!untitledKeys.length) { titleCheckAttempts = 0; titleCheckSignature = ''; return; }
    const sig = untitledKeys.sort().join('\n');
    if (sig !== titleCheckSignature) { titleCheckSignature = sig; titleCheckAttempts = 0; }
    if (titleCheckAttempts >= 10) return;
    titleCheckAttempts++;
    titleTimer = setTimeout(() => {
      titleTimer = undefined;
      if (needsChildName) schedule();
      void syncMetadataIfChanged().then(() => scheduleTitleCheck());
    }, 3000);
  }

  // Activity coalesces into one render shortly after the first unrendered step; any
  // other change still renders at once and takes the pending steps with it.
  function renderActivity() {
    if (activityRender || !alive) return;
    activityRender = setTimeout(() => {
      activityRender = undefined;
      render();
      if (panel.isVisible() && Date.now() - metadataRefreshAt >= 3000) void syncMetadataIfChanged();
    }, ACTIVITY_RENDER_MS);
  }

  async function pruneStorageIfDue(activeKeys) {
    const now = Date.now();
    if (now - lastPruneAt < PRUNE_STORAGE_MS) return;
    lastPruneAt = now;
    try {
      await pruneExpiredSessions(directory, now);
      await receipts.prune(activeKeys, STALE_STATE_AGE_MS, now);
      if (typeof context.globalState.keys === 'function') {
        const cutoff = now - STALE_STATE_AGE_MS;
        for (const key of context.globalState.keys()) {
          if (!key.startsWith('dismiss:')) continue;
          const sessionKey = key.slice('dismiss:'.length);
          const stamp = context.globalState.get(key);
          if (!activeKeys.has(sessionKey) && Number.isSafeInteger(stamp) && stamp < cutoff) {
            await settle(context.globalState.update(key, undefined));
          }
        }
        await pruneNamedState(activeKeys, now);
      }
    } catch (error) {
      log('prune', reason(error));
    }
  }

  // A rename or a pin is the user's own word and carries no date. Every window records,
  // per day, that a named session is still listed somewhere; one no window has listed
  // for half a year is long gone, and only then are its name and pin let go. A name
  // seen for the first time starts its clock instead of being judged.
  async function pruneNamedState(activeKeys, now) {
    const aliases = new Set(context.globalState.keys().filter(key => key.startsWith('alias:')).map(key => key.slice('alias:'.length)));
    const named = new Set([...aliases, ...pins]);
    const stored = context.globalState.get(SEEN_KEY);
    const seen = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
    const today = Math.floor(now / DAY);
    const cutoff = Math.floor((now - NAMED_STATE_AGE_MS) / DAY);
    let changed = false, pinsChanged = false;
    for (const key of named) {
      const last = Number.isSafeInteger(seen[key]) ? seen[key] : undefined;
      if (activeKeys.has(key) || last === undefined || last > today) {
        if (last !== today) { seen[key] = today; changed = true; }
      } else if (last < cutoff) {
        if (aliases.has(key)) await settle(context.globalState.update('alias:' + key, undefined));
        if (pins.delete(key)) pinsChanged = true;
        delete seen[key];
        changed = true;
      }
    }
    // Days recorded for names that are gone everywhere are forgotten after the same age.
    for (const [key, day] of Object.entries(seen)) {
      if (!named.has(key) && !(Number.isSafeInteger(day) && day >= cutoff)) { delete seen[key]; changed = true; }
    }
    if (changed) await settle(context.globalState.update(SEEN_KEY, seen));
    if (pinsChanged) await saveLayout();
  }

  function scheduleLivePoll() {
    clearTimeout(livePollTimer);
    livePollTimer = undefined;
    if (!alive || !panel.isVisible()) return;
    const codexNeedsLive = connections.hookState('codex') !== 'connected';
    const codexWorking = rows.some(r => r.provider === 'codex' && r.status === 'working');
    const codexWaiting = rows.some(r => r.provider === 'codex' && WAITING.has(r.status));
    const softWaits = rows.some(r => r.pendingSoftEntries?.length > 0);
    if (!codexNeedsLive && !codexWorking && !codexWaiting && !softWaits) return;
    // Trusted Codex hooks report every turn change themselves; while they only work, the
    // native poll is a slow safety net. Without hooks, or with a wait that only native
    // state can settle, it stays quick.
    const delay = codexNeedsLive || codexWaiting || softWaits ? LIVE_POLL_MS : LIVE_POLL_HOOKED_MS;
    livePollTimer = setTimeout(async () => {
      livePollTimer = undefined;
      if (!alive || !panel.isVisible()) return;
      try {
        const fp = await liveStateFingerprint(rows, { checkCodex: codexNeedsLive });
        if (fp !== lastLiveFp) {
          lastLiveFp = fp;
          schedule();
        }
      } catch { /* best-effort stat poll */ }
      scheduleLivePoll();
    }, delay);
  }

  async function scan(force) {
    do {
      queued = false;
      force ||= forceQueued;
      forceQueued = false;
      const revision = workspaceRevision;
      try {
        const folders = currentFolders();
        const scopeKey = folders.map(f => f.uri.fsPath).sort().join('\0');
        const rootsFresh = !force && scopeKey === cachedScopeKey && Array.isArray(cachedRoots) &&
          cachedRoots.length === folders.length &&
          cachedRoots.every(r => {
            try { return fs.realpathSync.native(r.local) === r.real; } catch { return false; }
          });
        if (!rootsFresh) {
          cachedScopeKey = scopeKey;
          cachedRoots = undefined;
          folderCheckCache.clear();
        }
        const scope = await createWorkspaceScope(folders, { resolvedRoots: cachedRoots, folderCache: folderCheckCache });
        if (!alive || revision !== workspaceRevision) continue;
        cachedRoots = scope.roots;
        activeScope = scope;
        const outsideWanted = otherFolders();
        // A notice received after this point may describe a wait this scan cannot see yet.
        const since = Date.now();
        lastClockScanAt = since;
        // Hook snapshots are global; other folders' waits are read even without a folder here.
        const [rawActive, recent] = await Promise.all([
          scope.paths.length || outsideWanted ? sessionReader(directory) : [],
          scope.paths.length ? readRecent(scope.paths, { force }) : [],
        ]);
        if (!alive || revision !== workspaceRevision) continue;
        let active = deduplicateGenericParentApprovals(rawActive);
        const codexWaiting = active.filter(row => row.provider === 'codex' && WAITING.has(row.status) &&
          row.pendingEntries?.some(entry => entry.target));
        const agySoft = active.filter(row => row.provider === 'agy' && row.pendingSoftEntries?.length > 0);
        const [codexResolved, agyResolved, liveCodex] = await Promise.all([
          codexWaiting.length ? readCodexResolvedPending(codexWaiting).catch(() => new Map()) : new Map(),
          agySoft.length ? readAgyResolvedSteps(agySoft).catch(() => new Map()) : new Map(),
          // A restricted folder lists sessions read-only; probing live Codex writers spawns helpers.
          !scope.paths.length ? { runs: [], capability: 'available' }
            : !vscode.workspace.isTrusted ? { runs: [], capability: 'unknown' }
              : readCodexLiveRuns(scope.paths, { knownIds: active.filter(r => r.provider === 'codex').map(r => r.sessionId) })
                .catch(() => ({ runs: [], capability: 'unavailable' })),
        ]);
        if (!alive || revision !== workspaceRevision) continue;
        codexLiveDetection = liveCodex.capability || 'unknown';
        if (codexResolved.size || agyResolved.size) {
          const nowMs = Date.now();
          active = active.map(row => {
            const cRes = codexResolved.get(row.key);
            if (cRes?.size) return resolveSessionWaits(row, { resolvedRefs: cRes }, nowMs);
            const aRes = agyResolved.get(row.key);
            // A step that is still running settles its soft wait as surely as a finished one.
            if (aRes?.resolvedSoftRefs?.size || aRes?.runningSoftRefs?.size) return resolveSessionWaits(row, aRes, nowMs);
            return row;
          });
          active = deduplicateGenericParentApprovals(active);
        }
        const dedup = new Map(recent.map(row => [row.key, row]));
        for (const row of active) {
          const native = dedup.get(row.key);
          dedup.set(row.key, { ...native, ...row, cwd: row.cwd || native?.cwd || '',
            activityAt: Math.max(row.updatedAt, native?.updatedAt || 0),
            ...(row.provider === 'agy' && native?.cwd && { workspacePaths: [...new Set([...(row.workspacePaths || []), native.cwd, row.cwd].filter(Boolean))] }) });
        }
        for (const run of liveCodex.runs || []) {
          const existing = dedup.get(run.key);
          if (!existing || existing.status === 'recent' || existing.status === 'stale') {
            dedup.set(run.key, {
              ...existing,
              ...run,
              title: existing?.title || run.title,
              activityAt: Math.max(run.updatedAt, existing?.updatedAt || 0),
            });
          } else if (['done', 'idle', 'error'].includes(existing.status)) {
            const newerTurn = run.turnId && existing.turn ? run.turnId !== existing.turn : run.workSince > existing.updatedAt + 2000;
            if (newerTurn) {
              const {
                replyAt: _ra, errorReason: _er, interrupted: _int,
                waitSince: _ws, pendingRefs: _pr, pendingEntries: _pe,
                ...rest
              } = existing;
              dedup.set(run.key, {
                ...rest,
                ...run,
                title: existing.title || run.title,
                activityAt: Math.max(run.updatedAt, existing.updatedAt || 0),
              });
            }
          } else if (existing.status === 'working') {
            dedup.set(run.key, { ...existing, liveTurnConfirmed: true,
              updatedAt: Math.max(existing.updatedAt, run.updatedAt), activityAt: Math.max(existing.activityAt || 0, run.updatedAt) });
          }
        }
        const seeds = await scope.filter([...dedup.values()]);
        const rawFamily = seeds.length ? await scope.filter(await readChildren(seeds, { force })) : [];
        const family = deduplicateGenericParentApprovals(rawFamily);
        if (!alive || revision !== workspaceRevision) continue;
        const scoped = new Set([...seeds, ...family].map(row => row.key));
        const outside = outsideWanted ? waitingElsewhere(active, key => scoped.has(key)) : { waiting: [], folders: [] };
        elsewhere = outside.folders;
        const previousRows = new Map(rows.map(row => [row.key, row]));
        const annotatedFamily = annotateLifecycle(family, Date.now());
        const visible = new Set(undismissedSessions(annotatedFamily,
          key => context.globalState.get('dismiss:' + key)).map(row => row.key));
        const preserveWorkSince = row => {
          if (row.status !== 'working' || row.workSince) return row;
          // A native index may only report "running" and the last file change.
          // Keep its first observed start stable until the task leaves this state.
          const prior = previousRows.get(row.key);
          return { ...row, workSince: (prior?.status === 'working' && prior.workSince) || row.updatedAt };
        };
        rows = family.filter(row => visible.has(row.key)).map(preserveWorkSince);
        let annotatedRows = rows.length === family.length
          ? annotatedFamily.map(preserveWorkSince)
          : annotateLifecycle(rows, Date.now());
        // Every open request of a session keeps its preview, not only those of the state it
        // shows: an approval queued behind a question still needs its own when it surfaces.
        const waits = new Map();
        for (const row of rows) {
          const waiting = WAITING.has(row.status);
          if (waiting && !row.pendingRefs?.length) {
            waits.set(row.key, undefined);
          } else {
            const refs = [...new Set([
              ...(waiting ? row.pendingRefs : []), ...(row.softPendingRefs || []),
              ...(Array.isArray(row.pendingEntries) ? row.pendingEntries.map(entry => entry?.ref) : []),
              ...(Array.isArray(row.pendingSoftEntries) ? row.pendingSoftEntries.map(entry => entry?.ref) : []),
            ].filter(ref => typeof ref === 'string' && ref))];
            if (refs.length) waits.set(row.key, refs);
          }
        }
        bridge?.prunePreviews((key, ref) => waits.has(key) && (!waits.get(key)?.length || waits.get(key).includes(ref)), since);
        // Re-scan right when the earliest delayed soft wait matures (in this workspace or another folder).
        clearTimeout(softWaitTimer);
        softWaitTimer = undefined;
        let nextSoftAt = Infinity;
        for (const row of active) {
          if (Number.isSafeInteger(row.nextSoftWaitAt) && row.nextSoftWaitAt < nextSoftAt) {
            nextSoftAt = row.nextSoftWaitAt;
          }
        }
        if (Number.isFinite(nextSoftAt) && alive) {
          const delay = Math.max(25, Math.min(65000, nextSoftAt - Date.now() + 25));
          softWaitTimer = setTimeout(() => {
            softWaitTimer = undefined;
            if (alive) void refresh();
          }, delay);
        }
        // A session that left the list takes what it was doing with it.
        const listed = new Set(rows.map(row => row.key));
        bridge?.pruneActivity(key => listed.has(key), since);
        scanError = '';
        render(annotatedRows);
        if (panel.shownActionKeys) bridge?.deferUnshown?.(panel.shownActionKeys(), since);
        const nextMetadata = await readMetadata(rows.filter(row => !row.isSubagent), { force });
        if (!alive || revision !== workspaceRevision) continue;
        metadataRefreshAt = Date.now();
        if (nextMetadata !== metadata) {
          metadata = nextMetadata;
          annotatedRows = annotateLifecycle(rows, metadataRefreshAt);
          render(annotatedRows);
          if (panel.shownActionKeys) bridge?.deferUnshown?.(panel.shownActionKeys(), since);
        }
        scheduleTitleCheck();
        scheduleLivePoll();
        scheduleMetadataTrail();
        // A restricted folder only lists its sessions; it announces nothing.
        if (vscode.workspace.isTrusted) await alerts.notify(annotatedRows, outside.waiting);
        void pruneStorageIfDue(new Set([...active.map(r => r.key), ...family.map(r => r.key)]));
      } catch (error) {
        log('scan', reason(error));
        if (alive) {
          scanError = '세션 상태를 읽지 못했습니다. 새로 고침으로 다시 시도하세요.';
          render();
        }
      }
      force = false;
    } while (queued && alive);
  }

  function refresh(force = false) {
    if (!alive) return;
    if (scanPromise) { queued = true; forceQueued ||= force; return scanPromise; }
    scanPromise = scan(force).finally(() => { scanPromise = undefined; });
    return scanPromise;
  }

  function schedule() {
    if (timer || !alive) return;
    timer = setTimeout(() => { timer = undefined; void refresh(); }, 100);
  }

  // A watch that fails to start or dies later is retried with backoff; meanwhile the
  // clock still scans at least once a minute.
  function retryWatcher() {
    if (!alive || watchRetryTimer) return;
    const delay = watchBackoffMs;
    watchBackoffMs = Math.min(30000, watchBackoffMs * 2);
    watchRetryTimer = setTimeout(() => { watchRetryTimer = undefined; startWatcher(); }, delay);
  }

  function startWatcher() {
    if (!alive) return;
    try { watcher?.close(); } catch { /* ignore */ }
    watcher = undefined;
    try {
      watcher = fs.watch(directory, (_type, name) => {
        watchBackoffMs = 1000;
        if (!name || String(name).endsWith('.json')) schedule();
      });
      watcher.on('error', error => {
        log('watch', reason(error));
        try { watcher?.close(); } catch { /* ignore */ }
        watcher = undefined;
        retryWatcher();
      });
    } catch (error) {
      log('watch', reason(error));
      watcher = undefined;
      // The directory may have been removed; recreate it before the next attempt.
      void fs.promises.mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => {});
      retryWatcher();
    }
  }

  actions.registerCommands();
  const uriHandler = vscode.window.registerUriHandler?.({ handleUri: uri => settle(actions.handleNotificationUri(uri)) });
  if (uriHandler) context.subscriptions.push(uriHandler);

  await refreshWindowUri();
  try {
    bridge = await listen(directory, {
      // Accept inline requests while the panel visibly shows this provider (even while unfocused so
      // clicking a macOS notification lands on an immediately interactive card; actual decisions
      // still strictly require vscode.window.state.focused === true).
      canAccept: (cwd, provider = 'claude', req) => {
        if (!alive || !vscode.workspace.isTrusted || !panel.canHandleRequests(provider) ||
            !setting('inlineActions', true) || !activeScope?.containsExistingFolder(cwd)) return false;
        if (req?.kind === 'approval') {
          const existing = rows.find(row => row.key === req.key);
          if (existing?.status === 'input' && !bridge?.forSession(req.key)) return false;
        }
        return true;
      },
      // Display-only content needs neither a visible panel nor focus: it is there when the user looks.
      canNotice: cwd => alive && vscode.workspace.isTrusted && Boolean(activeScope?.containsExistingFolder(cwd, { maxAgeMs: FOLDER_CACHE_TTL_MS })),
      canActivity: cwd => activityWanted() && Boolean(activeScope?.containsExistingFolder(cwd, { maxAgeMs: FOLDER_CACHE_TTL_MS })),
      workspaceRootFor,
      windowMeta: () => ({
        workspaceFolders: currentFolders().map(folder => folder.uri.fsPath),
        ...(windowBaseUri && { windowUri: windowBaseUri }),
      }),
      changed: render,
      activityChanged: renderActivity,
      windowMs: () => inlineWindow(setting('inlineActionSeconds', 45)),
      wantsActivity: activityWanted,
    });
  } catch (error) {
    log('bridge', 'socket unavailable: ' + reason(error));
  }
  startWatcher();
  const clock = setInterval(() => {
    const now = Date.now();
    const visible = panel.isVisible();
    const hasActive = rows.some(row => ACTIVE.has(row.status));
    if (visible || hasActive || !watcher || now - lastClockScanAt >= 60000) {
      lastClockScanAt = now;
      schedule();
    }
    void updateQuotas();
    if (visible && connections.isDue(now)) void connections.refreshConnections();
  }, 15000);
  if (output) context.subscriptions.push(output);
  context.subscriptions.push(panel, registration, status, vscode.workspace.onDidChangeWorkspaceFolders(() => {
    workspaceRevision++; activeScope = undefined; cachedScopeKey = ''; cachedRoots = undefined; folderCheckCache.clear();
    titleCheckAttempts = 0; titleCheckSignature = '';
    rows = []; elsewhere = []; metadata = { sessions: new Map(), providerUsage: {} };
    actions.resetWorkspace(); alerts.resetWorkspace();
    bridge?.deferAll(); void refreshWindowUri(); void bridge?.updateWindow(); render(); void refresh(true);
  }), vscode.window.onDidChangeWindowState(state => {
    if (!state.focused) { clearTimeout(titleTimer); titleTimer = undefined; }
    else {
      alerts.clearWorkspaceNotifications();
      if (connections.hasUntrusted()) void connections.refreshConnections({ force: true });
      void updateQuotas();
      void syncMetadataIfChanged().then(() => scheduleTitleCheck());
    }
  }), vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('agentSessionMonitor.subscriptionUsage')) { render(); void updateQuotas(); }
    if (event.affectsConfiguration('agentSessionMonitor.inlineActions')) bridge?.deferAll();
    if (event.affectsConfiguration('agentSessionMonitor.inlineActionSeconds')) void bridge?.updateWindow();
    if (event.affectsConfiguration('agentSessionMonitor.otherFolders')) {
      elsewhere = []; alerts.resetOutside(); render(); void refresh();
    }
    if (event.affectsConfiguration('agentSessionMonitor.activityDetail')) {
      if (!activityShown()) bridge?.clearActivity();
      void bridge?.updateWindow(); render();
    }
  }), { dispose() {
    alive = false; bridge?.dispose(); alerts.dispose();
    try { watcher?.close(); } catch { /* ignore */ }
    clearTimeout(watchRetryTimer); clearTimeout(timer); clearTimeout(activityRender); clearTimeout(titleTimer); clearTimeout(softWaitTimer); clearTimeout(livePollTimer); clearTimeout(metadataTrailTimer); clearInterval(clock);
  } });
  // Trust can be granted while the window is open; only then do untrusted-disabled vendor
  // extensions become visible, and only then may this window ask for activity or live Codex runs.
  const trustGranted = vscode.workspace.onDidGrantWorkspaceTrust?.(() => {
    panel.refreshLogos();
    void bridge?.updateWindow();
    render();
    void updateQuotas();
    void connections.refreshConnections({ force: true });
    schedule();
  });
  if (trustGranted) context.subscriptions.push(trustGranted);
  // Vendor extensions may appear or move after trust grant, install, enable, or update.
  const extensionsChanged = vscode.extensions?.onDidChange?.(() => {
    if (!alive) return;
    panel.refreshLogos();
    void connections.refreshConnections();
  });
  if (extensionsChanged) context.subscriptions.push(extensionsChanged);
  await Promise.all([refresh(), connections.refreshRuntime()]);
}

module.exports = { activate };
