'use strict';

const strength = { setting:1, request:2, call:3, response:4 };

function settingDescribesResponse(setting, response) {
  if (setting.toLowerCase() === response.toLowerCase()) return true;
  const alias = /^(?:claude-)?(fable|opus|sonnet|haiku|mythos)(?:\[1m\])?$/i.exec(setting);
  const model = response.toLowerCase();
  return Boolean(alias && model.startsWith('claude-') && model.split('-').includes(alias[1].toLowerCase()));
}

// Fields can have different evidence. A response records the model that ran,
// while an effort setting may have been updated by a separate provider event.
function mergeExecution(native, hook, provider) {
  const execution = {};
  for (const field of ['model','effort']) {
    const source = field + 'Source', date = field + 'At';
    let best;
    for (const candidate of [native,hook]) {
      if (typeof candidate?.[field] !== 'string' || !candidate[field]) continue;
      if (best) {
        const time = candidate[date], prior = best[date];
        if (field === 'model' && ((best[source] === 'response' && candidate[source] === 'setting') ||
            (best[source] === 'setting' && candidate[source] === 'response'))) {
          const response = best[source] === 'response' ? best : candidate;
          const setting = response === best ? candidate : best;
          best = setting.modelAt > (response.modelAt || 0) && !settingDescribesResponse(setting.model, response.model)
            ? setting : response;
          continue;
        }
        if (time && prior && time !== prior) {
          if (time < prior) continue;
        } else {
          const rank = strength[candidate[source]] || 0;
          if (rank < (strength[best[source]] || 0)) continue;
          // A Codex thread stores its current configuration. An earlier start
          // hook can carry the previous setting without a comparable DB time.
          if (provider === 'codex' && candidate[source] === 'setting' && best[source] === 'setting' && best === native) continue;
        }
      }
      best = candidate;
    }
    if (best) {
      execution[field] = best[field];
      if (best[source]) execution[source] = best[source];
      if (Number.isSafeInteger(best[date])) execution[date] = best[date];
    }
  }
  return execution.model || execution.effort ? execution : undefined;
}

function createReceipts(storage, onChange, onError) {
  const pending = new Map();
  const pendingError = new Map();
  let writes = Promise.resolve();
  const seen = key => Math.max(pending.get(key) || 0, storage.get('replySeen:' + key) || 0);
  const seenError = key => Math.max(pendingError.get(key) || 0, storage.get('errorSeen:' + key) || 0);
  function unread(row) {
    return !row.isSubagent && row.status === 'done' && Number.isSafeInteger(row.replyAt) &&
      row.replyAt >= (row.workSince || 0) && row.replyAt > seen(row.key);
  }
  function mark(row, stamp) {
    if (!unread(row) || row.replyAt !== stamp) return;
    const key = row.key;
    pending.set(key, stamp);
    onChange();
    writes = writes.then(() => storage.update('replySeen:' + key, stamp)).catch(onError).finally(() => {
      if (pending.get(key) === stamp) pending.delete(key);
      onChange();
    });
    return writes;
  }
  function errorAcked(row) {
    return row.status === 'error' && Number.isSafeInteger(row.updatedAt) && row.updatedAt <= seenError(row.key);
  }
  function ackError(row, stamp) {
    if (row.status !== 'error' || !Number.isSafeInteger(row.updatedAt) || row.updatedAt !== stamp || errorAcked(row)) return;
    const key = row.key;
    pendingError.set(key, stamp);
    onChange();
    writes = writes.then(() => storage.update('errorSeen:' + key, stamp)).catch(onError).finally(() => {
      if (pendingError.get(key) === stamp) pendingError.delete(key);
      onChange();
    });
    return writes;
  }
  function prune(activeKeys, maxAgeMs = 14 * 86400000, now = Date.now()) {
    if (typeof storage?.keys !== 'function') return Promise.resolve(0);
    const active = activeKeys instanceof Set ? activeKeys : new Set(Array.isArray(activeKeys) ? activeKeys : []);
    const cutoff = now - maxAgeMs;
    const stale = [];
    for (const storageKey of storage.keys()) {
      if (typeof storageKey !== 'string') continue;
      let prefix;
      if (storageKey.startsWith('replySeen:')) prefix = 'replySeen:';
      else if (storageKey.startsWith('errorSeen:')) prefix = 'errorSeen:';
      else continue;
      const sessionKey = storageKey.slice(prefix.length);
      if (active.has(sessionKey)) continue;
      if (prefix === 'replySeen:' ? pending.has(sessionKey) : pendingError.has(sessionKey)) continue;
      const stamp = storage.get(storageKey);
      if (!Number.isSafeInteger(stamp) || stamp < cutoff) stale.push(storageKey);
    }
    if (!stale.length) return Promise.resolve(0);
    let removed = 0;
    writes = writes.then(async () => {
      for (const storageKey of stale) {
        await storage.update(storageKey, undefined);
        removed++;
      }
    }).catch(onError);
    return writes.then(() => removed);
  }
  return { unread, mark, errorAcked, ackError, prune };
}

module.exports = { mergeExecution, createReceipts };
