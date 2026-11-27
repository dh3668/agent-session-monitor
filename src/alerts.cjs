'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { PROVIDERS, STATES, cleanLabel } = require('./model.cjs');
const { compareTriage } = require('./workspace-sessions.cjs');
const { resolveNotificationLogo } = require('./logos.cjs');
const { errorLabel, requestSummary, subtitleFor, depletedQuotaHint } = require('../media/format.js');
const { t } = require('../media/i18n.js');

const WAITING = new Set(['approval', 'input']);

// The same change has the same identity in every window that observes the snapshot.
const eventId = row => [row.key, row.status, row.status === 'done' ? row.replyAt : row.waitSince || row.updatedAt].join('|');
const hasNewPendingRef = (earlier, row) => Boolean(
  WAITING.has(row.status) && Array.isArray(row.pendingRefs) && row.pendingRefs.length &&
  Array.isArray(earlier?.pendingRefs) && row.pendingRefs.some(ref => !earlier.pendingRefs.includes(ref))
);
// A claim names the change from the row alone, never from what this window happened to
// observe before: a window that scanned in between and one that did not then claim the
// same marker for the same open requests, so only one of them announces it.
const claimIdFor = row => {
  const refs = WAITING.has(row.status) && Array.isArray(row.pendingRefs) ? [...new Set(row.pendingRefs)].sort() : [];
  return refs.length ? eventId(row) + '|' + refs.join(',') : eventId(row);
};
// Deliveries tracked per session so that seeing a session clears its notifications.
const DELIVERED_SESSIONS = 128, DELIVERED_PER_SESSION = 32;
const notificationKey = ids => 'asm-' + createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 24);
const folderName = cwd => cleanLabel(path.basename(cwd)) || cwd;
const statusTextFor = (row, { forSystem = false } = {}) => {
  if (row.status === 'error') return errorLabel(row.errorReason);
  if (forSystem && row.status === 'done') return t('New reply');
  return t(STATES[row.status].label);
};

function createAlerts({
  vscode,
  context,
  directory,
  notifier,
  notificationsSettingsUrl,
  findWindowForFolder,
  panel,
  receipts,
  quotaCache,
  setting,
  quotaEnabled,
  otherFolders,
  activityShown,
  isAlive,
  getWorkspaceRevision,
  getRows,
  getTitle,
  projectRow,
  workspaceRootFor,
  workspaceGroupId,
  workspaceGroups = () => [],
  workspaceLabel,
  buildFocusUri,
  onOpenFolder,
  onReviewRow,
  log,
  settle,
}) {
  let observed, observedOutside, permissionPrompted = false, lastClearedClaimStamp = '', hasTestNotification = false;
  let bannersOffLogged = false;
  const timers = new Set();
  // Least recently notified sessions first; bounded so a long-unfocused window cannot grow it.
  const deliveredBySession = new Map();

  function trackDelivery(key, id) {
    const set = deliveredBySession.get(key) || new Set();
    deliveredBySession.delete(key);
    set.delete(id);
    set.add(id);
    while (set.size > DELIVERED_PER_SESSION) set.delete(set.values().next().value);
    deliveredBySession.set(key, set);
    while (deliveredBySession.size > DELIVERED_SESSIONS) deliveredBySession.delete(deliveredBySession.keys().next().value);
  }

  function clearSessionNotifications(keys) {
    const ids = [];
    for (const key of keys) {
      const set = deliveredBySession.get(key);
      if (!set) continue;
      for (const id of set) ids.push(id);
      deliveredBySession.delete(key);
    }
    if (ids.length) void settle(notifier.clear({ ids }));
  }

  // Focusing the window clears what it announced: its own thread, the thread of each
  // folder of a multi-root window (another window names those by folder), and every
  // notification it delivered itself, including other folders' requests.
  function clearWorkspaceNotifications() {
    const hadLocal = deliveredBySession.size > 0 || hasTestNotification;
    const ids = [...new Set([...deliveredBySession.values()].flatMap(set => [...set]))].slice(-64);
    deliveredBySession.clear();
    hasTestNotification = false;
    if (setting('notifications', 'attentionAndDone') === 'off' || setting('awayNotifications', true) === false) {
      if (ids.length) void settle(notifier.clear({ ids }));
      return;
    }
    const claimStamp = typeof notifier.stamp === 'function' ? notifier.stamp() : undefined;
    if (!hadLocal && claimStamp !== undefined && claimStamp === lastClearedClaimStamp) return;
    if (claimStamp !== undefined) lastClearedClaimStamp = claimStamp;
    let folders = [];
    try { folders = (workspaceGroups() || []).filter(folder => typeof folder === 'string' && folder); } catch { /* Joined group only. */ }
    const group = workspaceGroupId();
    const groups = [...new Set([group, ...folders])];
    void settle(notifier.clear({ ...(ids.length && { ids }), group, ...(groups.length > 1 && { groups }) }));
  }

  function toast(claimed, remote, revision) {
    const label = row => statusTextFor(row);
    if (remote) {
      const message = claimed.slice(0, 3).map(row => t('Other folder · {0} · {1}', folderName(row.cwd), label(row))).join('\n');
      void settle(Promise.resolve(vscode.window.showInformationMessage(message, t('Open folder'))).then(action => {
        if (action && isAlive()) return onOpenFolder(claimed[0].cwd);
      }));
      return;
    }
    // Suppress duplicate in-window toasts for requests already visibly open in the sidebar.
    const visible = claimed.filter(row => !panel.isShowingRequest?.(row.key));
    if (!visible.length) return;
    const target = visible[0];
    const message = visible.slice(0, 3).map(row => getTitle(row) + ' · ' + label(row)).join('\n');
    void settle(Promise.resolve(vscode.window.showInformationMessage(message, t('Show session'))).then(action => {
      if (!action || !isAlive() || revision !== getWorkspaceRevision()) return;
      const raw = getRows().find(r => r.key === target.key);
      if (raw) return onReviewRow(projectRow(raw));
    }));
  }

  async function systemMessage(claimed, remote, claimIds) {
    const primary = claimed[0];
    const sameProvider = claimed.every(row => row.provider === primary.provider);
    const providerId = sameProvider ? primary.provider : undefined;
    const providerLabel = providerId ? PROVIDERS[providerId] : t('Agent Session Monitor');
    const primaryStatus = statusTextFor(primary, { forSystem: true });
    const title = claimed.length === 1
      ? providerLabel + ' · ' + primaryStatus
      : (sameProvider ? providerLabel : t('Agent Session Monitor')) + ' · ' + primaryStatus + ' ' + t('+{0} more', claimed.length - 1);
    const subtitle = remote ? folderName(primary.cwd) + ' · ' + t('Other folder') : (workspaceLabel() || folderName(primary.cwd));

    let body;
    if (claimed.length === 1) {
      const name = remote ? folderName(primary.cwd) : getTitle(primary);
      let detail = '';
      if (!remote && activityShown()) {
        const projected = projectRow(primary);
        if (projected) {
          detail = (WAITING.has(projected.status) ? requestSummary(projected) : '') || subtitleFor(projected) || '';
        }
      }
      if (!detail && primary.status === 'error' && primary.errorReason === 'rate_limit') {
        const hint = depletedQuotaHint(quotaCache.entries[primary.provider]);
        if (hint) detail = t('{0} limit used up', hint.label) + (hint.resetIn ? ' · ' + t('Resets {0}', hint.resetIn) : '');
      }
      body = detail ? name + '\n' + detail : name + ' · ' + primaryStatus;
    } else {
      const lines = claimed.slice(0, 3).map(row => (remote ? folderName(row.cwd) : getTitle(row)) + ' · ' + statusTextFor(row, { forSystem: true }));
      if (claimed.length > 3) lines.push(t('+{0} more', claimed.length - 3));
      body = lines.join('\n');
    }

    let workspaceRoot = remote ? primary.cwd : (workspaceRootFor(primary.cwd) || primary.cwd);
    let openUri = '';
    if (!remote) {
      openUri = await buildFocusUri({ key: primary.key, cwd: workspaceRoot });
    } else if (typeof findWindowForFolder === 'function' && primary.cwd) {
      const existing = await findWindowForFolder(directory, primary.cwd).catch(() => undefined);
      if (existing?.workspaceRoot) workspaceRoot = existing.workspaceRoot;
      if (existing?.windowUri) {
        try {
          // VS Code encodes a link's whole query as one component and decodes it once on
          // arrival. Add this session's parameters to that query, then encode it the same way.
          const parsed = new URL(existing.windowUri);
          const query = new URLSearchParams(decodeURIComponent(parsed.search.slice(1)));
          query.set('key', primary.key);
          query.set('cwd', workspaceRoot);
          parsed.search = '?' + encodeURIComponent(query.toString());
          openUri = parsed.toString();
        } catch { /* Fall back to workspaceRoot launch. */ }
      }
    }

    const logoPath = resolveNotificationLogo(providerId, { vscode, extensionPath: context.extensionPath });
    const id = notificationKey(claimIds);
    const group = remote ? (workspaceRoot || 'remote') : workspaceGroupId();
    const urgent = claimed.some(row => WAITING.has(row.status) || row.status === 'error');
    return {
      id,
      group,
      title,
      subtitle,
      body,
      ...(logoPath && { logoPath }),
      ...(openUri && { openUri }),
      ...(workspaceRoot && { workspaceRoot }),
      appName: vscode.env?.appName || 'Visual Studio Code',
      interruptionLevel: urgent ? 'timeSensitive' : 'active',
      sound: setting('notificationSound', true) !== false,
    };
  }

  function guideNotificationPermission() {
    if (permissionPrompted || !isAlive()) return;
    permissionPrompted = true;
    void settle(Promise.resolve(vscode.window.showWarningMessage(
      t('macOS notifications are turned off for this extension, so agent alerts cannot be shown. Allow them in System Settings > Notifications > Agent Session Monitor.'),
      t('Open Notification Settings'),
    )).then(action => {
      if (action && vscode.env?.openExternal && vscode.Uri?.parse) {
        return vscode.env.openExternal(vscode.Uri.parse(notificationsSettingsUrl));
      }
    }));
  }

  // Every window that lists a session sees its change. Only the window that claims
  // it first announces it: a focused window at once with a toast, an unfocused one
  // after a pause with a system notification.
  function announce(changes, remote) {
    if (!changes.length) return;
    const revision = getWorkspaceRevision();
    async function deliver() {
      if (!isAlive() || revision !== getWorkspaceRevision() || setting('notifications', 'attentionAndDone') === 'off') return;
      if (!vscode.window.state.focused && setting('awayNotifications', true) === false) return;
      const latest = remote ? observedOutside : observed;
      const claimed = [];
      const claimedIds = [];
      for (const { row, id } of changes) {
        // A request settled or a reply read during the pause is not announced late.
        const current = latest?.get(row.key);
        if (!current || eventId(current) !== eventId(row) || current.quiet || current.errorAcked ||
            (current.status === 'done' && !receipts.unread(current))) continue;
        if (await notifier.claim(id)) {
          claimed.push(current);
          claimedIds.push(id);
        }
      }
      if (!claimed.length) return;
      const releaseClaims = () => Promise.all(claimedIds.map(id => notifier.release(id))).catch(() => {});
      if (!isAlive() || revision !== getWorkspaceRevision()) {
        await releaseClaims();
        return;
      }
      if (vscode.window.state.focused) return toast(claimed, remote, revision);
      if (setting('awayNotifications', true) === false) {
        await releaseClaims();
        return;
      }
      let payload, result;
      try {
        payload = await systemMessage(claimed, remote, claimedIds);
        if (!isAlive() || revision !== getWorkspaceRevision()) {
          await releaseClaims();
          return;
        }
        result = await notifier.deliver(payload);
      } catch (error) {
        log('notify', `delivery error: ${error instanceof Error ? error.message : String(error)}`);
        await releaseClaims();
        return;
      }
      if (!result?.ok) {
        log('notify', `delivery failed (${result?.backend || 'unknown'}, permission=${result?.permission || 'unknown'}): ${result?.error || 'unknown'}`);
        await releaseClaims();
        if (result?.permission === 'denied') guideNotificationPermission();
        return;
      }
      if (result.alertSetting === 'disabled' && !bannersOffLogged) {
        bannersOffLogged = true;
        log('notify', 'macOS banners are turned off for this app; notifications reach Notification Center only');
      }
      for (const row of claimed) trackDelivery(row.key, payload.id);
    }
    if (vscode.window.state.focused) return deliver().catch(() => {});
    const handle = setTimeout(() => {
      timers.delete(handle);
      void deliver().catch(() => {});
    }, remote ? notifier.delays.remote : notifier.delays.local);
    timers.add(handle);
  }

  function notify(annotatedLocal, outsideRows) {
    const before = observed, beforeOutside = observedOutside;
    observed = new Map(annotatedLocal.map(row => [row.key, row]));
    observedOutside = otherFolders() ? new Map(outsideRows.map(row => [row.key, row])) : undefined;
    if (!before) return;
    const mode = setting('notifications', 'attentionAndDone');
    if (mode === 'off') return;
    const local = annotatedLocal.filter(row => {
      if (row.isSubagent && row.status === 'done') return false;
      if (row.quiet || row.errorAcked) return false;
      const earlier = before.get(row.key);
      if (row.status === 'done') return mode === 'attentionAndDone' && receipts.unread(row) && row.replyAt > (earlier?.replyAt || 0);
      if (STATES[row.status].group !== 'attention') return false;
      if (!earlier || earlier.quiet || earlier.errorAcked) return true;
      return eventId(earlier) !== eventId(row) || hasNewPendingRef(earlier, row);
    }).sort(compareTriage).map(row => ({ row, id: claimIdFor(row) }));
    // The folder's own window may be closed, so a request elsewhere is announced too.
    const remote = beforeOutside && observedOutside ?
      outsideRows.filter(row => {
        const earlier = beforeOutside.get(row.key);
        return !earlier || eventId(earlier) !== eventId(row) || hasNewPendingRef(earlier, row);
      }).sort(compareTriage).map(row => ({ row, id: claimIdFor(row) })) : [];
    // When a provider newly hits a rate limit, refresh its subscription quota promptly so the reset countdown appears.
    if (quotaEnabled() && vscode.workspace.isTrusted) {
      const rateLimited = new Set(local.filter(({ row }) => row.status === 'error' && row.errorReason === 'rate_limit').map(({ row }) => row.provider));
      for (const provider of rateLimited) void settle(quotaCache.update(provider, { manual: true }));
    }
    return Promise.all([announce(local, false), announce(remote, true)]);
  }

  async function sendTestNotification() {
    const workspaceRoot = workspaceRootFor('');
    const openUri = await buildFocusUri({ cwd: workspaceRoot });
    const logoPath = resolveNotificationLogo('claude', { vscode, extensionPath: context.extensionPath });
    const payload = {
      id: 'asm-test-' + Date.now(),
      group: workspaceGroupId(),
      title: t('Agent Session Monitor · Test notification'),
      subtitle: workspaceLabel() || 'VS Code',
      body: t('Click the notification to jump straight to the VS Code window for this project.'),
      ...(logoPath && { logoPath }),
      ...(openUri && { openUri }),
      ...(workspaceRoot && { workspaceRoot }),
      appName: vscode.env?.appName || 'Visual Studio Code',
      interruptionLevel: 'timeSensitive',
      sound: setting('notificationSound', true) !== false,
    };
    const result = await notifier.deliver(payload);
    if (result.ok) {
      hasTestNotification = true;
      void settle(vscode.window.showInformationMessage(t('Sent a macOS notification. Click it to check that it brings you back to this window.')));
    } else if (result.permission === 'denied') {
      permissionPrompted = false;
      guideNotificationPermission();
    } else if (result.permission === 'unsupported') {
      void settle(vscode.window.showInformationMessage(t('System notifications are supported on macOS.')));
    } else {
      log('notify', `test failed: ${result.error || 'unknown'}`);
      void settle(vscode.window.showWarningMessage(t('Could not send the macOS notification. See the Agent Session Monitor output channel for the cause.')));
    }
  }

  function resetOutside() {
    observedOutside = undefined;
  }

  function resetWorkspace() {
    observed = undefined;
    observedOutside = undefined;
    lastClearedClaimStamp = '';
    hasTestNotification = false;
    deliveredBySession.clear();
  }

  function dispose() {
    for (const handle of timers) clearTimeout(handle);
    timers.clear();
  }

  return {
    notify,
    sendTestNotification,
    clearSessionNotifications,
    clearWorkspaceNotifications,
    resetOutside,
    resetWorkspace,
    dispose,
  };
}

module.exports = { createAlerts };
