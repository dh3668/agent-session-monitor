'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { PROVIDERS, cleanLabel, quotaPeriod } = require('./model.cjs');
const { writeAtomic } = require('./shared.cjs');
const { phrase } = require('../media/i18n.js');

const AUTO_INTERVAL = 5 * 60000;
const MANUAL_INTERVAL = 15000;
const MAX_AGE = 24 * 60 * 60000;

function normalize(value, now) {
  const windows = [];
  for (const item of Array.isArray(value?.windows) ? value.windows.slice(0, 80) : []) {
    // A record written before windows were language-neutral keeps its whole label as the period.
    const legacy = item && item.name === undefined && item.period === undefined;
    const name = legacy ? '' : cleanLabel(item?.name);
    const period = quotaPeriod(legacy ? item?.label : item?.period);
    if ((!name && period === undefined) || !Number.isFinite(item.percent) || item.percent < 0 || item.percent > 100 ||
        !['used', 'remaining'].includes(item.kind)) continue;
    const window = { name, ...(period !== undefined && { period }), percent: item.percent, kind: item.kind };
    if (Number.isSafeInteger(item.resetsAt) && item.resetsAt > 0) window.resetsAt = item.resetsAt;
    windows.push(window);
  }
  if (!windows.length || value.status !== 'ready') return;
  const plan = cleanLabel(value.plan);
  return { status: 'ready', windows, ...(plan && { plan }), updatedAt: now };
}

function createQuotaCache(directory, readQuota, { now = Date.now, onChange = () => {} } = {}) {
  const entries = {}, inflight = new Map();
  function publish(id, value) {
    if (JSON.stringify(entries[id]) === JSON.stringify(value)) return;
    entries[id] = value;
    onChange();
  }
  async function load(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) || {}; } catch { return {}; }
  }
  async function save(file, record) {
    await writeAtomic(file, JSON.stringify(record));
  }
  function show(id, record) {
    const time = now();
    if (record.success && Number.isSafeInteger(record.success.updatedAt) &&
        time - record.success.updatedAt < MAX_AGE && record.success.updatedAt <= time) {
      const success = normalize(record.success, record.success.updatedAt);
      if (success) {
        const expired = success.windows.some(win => win.resetsAt > success.updatedAt && win.resetsAt <= time);
        const stale = Boolean(record.error) || expired || time - success.updatedAt >= AUTO_INTERVAL;
        return publish(id, { ...success, status: stale ? 'stale' : 'ready', ...(record.error && { message:cleanLabel(record.error) }) });
      }
    }
    publish(id, record.error ? {status:'unavailable', windows:[], message:cleanLabel(record.error)} : {status:'loading', windows:[]});
  }
  const due = (record, wait) => !Number.isSafeInteger(record.attempt) || now() < record.attempt || now() - record.attempt >= wait;
  async function refresh(id, manual) {
    const file = path.join(directory, id + '.json');
    const lock = file + '.lock';
    await fs.mkdir(directory, { recursive:true, mode:0o700 });
    let record = await load(file);
    show(id, record);
    const wait = manual ? MANUAL_INTERVAL : AUTO_INTERVAL;
    if (!due(record, wait)) return;
    try { await fs.mkdir(lock, { mode:0o700 }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.stat(lock).catch(() => undefined);
      // All adapter deadlines are shorter than this lease. A crashed host can leave the directory.
      if (stat && now() - stat.mtimeMs > AUTO_INTERVAL) await fs.rmdir(lock).catch(() => {});
      return;
    }
    try {
      record = await load(file);
      if (!due(record, wait)) { show(id, record); return; }
      record.attempt = now();
      await save(file, record);
      let result;
      try { result = await readQuota(id); } catch { /* Some providers are only available while signed in. */ }
      const success = normalize(result, now());
      if (success) record = { attempt:record.attempt, success };
      else {
        record.error = cleanLabel(result?.message) || phrase('Could not get subscription usage.');
        if (result?.signedOut || /로그인.*필요|로그인해|인증.*필요/.test(record.error)) delete record.success;
      }
      await save(file, record);
      show(id, record);
    } finally { await fs.rmdir(lock).catch(() => {}); }
  }
  function update(id, {manual = false} = {}) {
    if (!Object.hasOwn(PROVIDERS, id)) return Promise.resolve();
    if (!inflight.has(id)) {
      inflight.set(id, refresh(id, manual).catch(() => {
        publish(id,{status:'unavailable', windows:[], message:phrase('Could not read the subscription usage cache.')});
      }).finally(() => inflight.delete(id)));
    }
    return inflight.get(id);
  }
  return { entries, update };
}

module.exports = { createQuotaCache, AUTO_INTERVAL, MANUAL_INTERVAL };
