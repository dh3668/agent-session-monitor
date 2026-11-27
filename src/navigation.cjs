'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { isAbsolute } = path;
const { setTimeout: delay } = require('node:timers/promises');
const { query, quote, defaultSqlitePath } = require('./metadata.cjs');
const { VENDORS, UUID_RE } = require('./shared.cjs');
const { t, phrase } = require('../media/i18n.js');

const AGY_IDE_SURFACES = Object.freeze(['antigravity', 'antigravity-ide']);
const AGY_CLI_SOURCE = 'CORTEX_TRAJECTORY_SOURCE_CLI';

async function fileStat(filePath) {
  return fs.lstat(filePath).catch(() => undefined);
}

// A trajectory database is named after its cascade ID. Placeholder files can
// exist before data arrives and even in another client's store.
async function probeAgyConversation(id, { homeDir = os.homedir(), source = '' } = {}) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return 'unconfirmed';
  let legacy = false;
  for (const surface of AGY_IDE_SURFACES) {
    const dir = path.join(homeDir, '.gemini', surface, 'conversations');
    const db = path.join(dir, id + '.db');
    if ((await fileStat(db))?.isFile()) {
      const rows = await query(db, 'SELECT 1 AS present FROM trajectory_meta WHERE cascade_id=' +
        quote(id) + ' AND EXISTS (SELECT 1 FROM steps WHERE idx>=0) LIMIT 1', defaultSqlitePath());
      if (rows.length) return 'ide';
    }
    const pb = await fileStat(path.join(dir, id + '.pb'));
    if (pb?.isFile() && pb.size > 0) legacy = true;
  }
  const cliBase = path.join(homeDir, '.gemini', 'antigravity-cli');
  if (source === AGY_CLI_SOURCE ||
      (await fileStat(path.join(cliBase, 'conversations', id + '.db')))?.isFile() ||
      (await fileStat(path.join(cliBase, 'conversations', id + '.pb')))?.isFile() ||
      (await fileStat(path.join(cliBase, 'brain', id)))?.isDirectory()) {
    return 'cli';
  }
  return legacy ? 'legacy' : 'unconfirmed';
}

// The current provider returns undefined for both a successful dispatch and
// "Conversation unavailable". Its main view records /c/<id> in the VS Code
// workspace memento on a route change. Inspect only that provider's scalar ID.
async function agyReachedConversation(id, workspaceStateDb) {
  if (!workspaceStateDb || !(await fileStat(workspaceStateDb))?.isFile()) return false;
  const sql = "SELECT 1 AS reached FROM ItemTable WHERE key=" + quote(VENDORS.agy) +
    " AND json_valid(value) AND json_extract(value,'$.lastConversationId')=" + quote(id);
  for (const wait of [0, 200, 400, 700, 1200]) {
    if (wait) await delay(wait);
    if ((await query(workspaceStateDb, sql, defaultSqlitePath())).length) return true;
  }
  return false;
}

async function offerAgyResume(vscode, id, reason, picker) {
  const cmd = 'agy --resume ' + id;
  const copy = t('Copy Resume Command'), choose = t('Open Chat Picker');
  const selection = await vscode.window.showInformationMessage(
    t('{0} The new-reply state was kept. You can continue in a terminal with {1}.', reason, cmd),
    copy, ...(picker ? [choose] : []));
  if (selection === copy) await vscode.env.clipboard.writeText(cmd);
  if (picker && selection === choose) await vscode.commands.executeCommand(picker);
  return false;
}

const RIGHT_CONTAINER = 'workbench.view.extension.agentSessionMonitorChats';

function preferSidebar(vscode) {
  return vscode.workspace.getConfiguration('agentSessionMonitor').get('chatLocation', 'secondarySidebar') !== 'lastUsed';
}

async function moveToRightSidebar(vscode, viewId) {
  if (!preferSidebar(vscode)) return;
  // Move only the provider's chat view. VS Code persists the placement for its native buttons.
  try {
    await vscode.commands.executeCommand('vscode.moveViews', {
      viewIds: [viewId], destinationId: RIGHT_CONTAINER,
    });
  } catch {
    // Earlier VS Code builds can still reveal the chat at its existing location.
  }
}

async function openCodexRoute(vscode, path) {
  // Codex's UriHandler focuses its sidebar, then sends this exact route to it.
  // VS Code's app URI resolver binds the link to the invoking editor window.
  const uri = vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: 'openai.chatgpt', path });
  const windowUri = await vscode.env.asExternalUri(uri);
  return vscode.commands.executeCommand('vscode.open', windowUri);
}

const providers = new Map([
  ['claude', {
    name: 'Claude Code',
    extension: VENDORS.claude,
    picker: 'claudeVSCodeSessionsList.focus',
    pickerName: phrase('sessions list'),
    async open(vscode, id) {
      if (preferSidebar(vscode)) await vscode.commands.executeCommand('claude-vscode.sidebar.open');
      // Reuse a live editor if this conversation is already there, honour the preferred
      // sidebar for other sessions, and avoid spawning another writer for the thread.
      return vscode.commands.executeCommand('claude-vscode.editor.open', id, undefined, undefined,
        undefined, undefined, { programmatic: 'honor-preferred-location' });
    },
    async start(vscode) {
      // An undefined session with this routing option is the provider's blank composer.
      if (preferSidebar(vscode)) await vscode.commands.executeCommand('claude-vscode.sidebar.open');
      return vscode.commands.executeCommand('claude-vscode.editor.open', undefined, undefined,
        undefined, undefined, undefined, { programmatic: 'honor-preferred-location' });
    },
  }],
  ['codex', {
    name: 'Codex',
    extension: VENDORS.codex,
    picker: 'chatgpt.openSidebar',
    pickerName: phrase('sidebar'),
    async open(vscode, id) {
      await moveToRightSidebar(vscode, 'chatgpt.sidebarView');
      return openCodexRoute(vscode, '/local/' + id);
    },
    async start(vscode) {
      await moveToRightSidebar(vscode, 'chatgpt.sidebarView');
      return vscode.commands.executeCommand('chatgpt.newChat');
    },
  }],
  ['agy', {
    name: 'Antigravity',
    extension: VENDORS.agy,
    picker: 'antigravity.searchConversations',
    pickerName: phrase('chat picker'),
    async open(vscode, id) {
      await moveToRightSidebar(vscode, 'antigravity.panel');
      return vscode.commands.executeCommand('antigravity.openConversation', id);
    },
    async start(vscode) {
      await moveToRightSidebar(vscode, 'antigravity.panel');
      await vscode.commands.executeCommand('antigravity.panel.focus');
      return vscode.commands.executeCommand('antigravity.startNewConversation');
    },
  }],
]);

async function openSession(vscode, session, options = {}) {
  const provider = providers.get(session?.provider);
  if (!provider) return false;

  const extension = vscode.extensions.getExtension(provider.extension);
  if (!extension) {
    if (session.provider === 'agy' && UUID_RE.test(session.sessionId)) {
      return offerAgyResume(vscode, session.sessionId, t('The {0} extension is not available in this window.', 'Antigravity'));
    }
    void vscode.window.showWarningMessage(t('The {0} extension is not available in this window.', provider.name));
    return false;
  }

  // A missing conversation in the current workspace can open a new, empty Claude chat.
  const folder = typeof session.cwd === 'string' && isAbsolute(session.cwd) ? vscode.Uri.file(session.cwd) : undefined;
  if (!folder || folder.authority) {
    void vscode.window.showInformationMessage(t('Open this chat from the VS Code window of the project that started the session.'));
    return false;
  }
  if (!vscode.workspace.getWorkspaceFolder(folder)) {
    const action = t('Open Workspace Folder');
    const selected = await vscode.window.showInformationMessage(
      t('This session started in another folder. You can open it in a new VS Code window.') + '\n' + session.cwd, action,
    );
    if (selected === action) {
      try {
        const stat = await vscode.workspace.fs.stat(folder);
        if (!(stat.type & vscode.FileType.Directory)) throw new Error('Not a directory');
        await vscode.commands.executeCommand('vscode.openFolder', folder, { forceNewWindow: true });
      } catch {
        void vscode.window.showWarningMessage(t('Could not open the folder. Check that it still exists at that path.'));
      }
    }
    return false;
  }

  try {
    await extension.activate();
    if (typeof session.sessionId === 'string' && UUID_RE.test(session.sessionId)) {
      let availability;
      if (session.provider === 'agy') {
        const probe = options.probeAgyConversation || probeAgyConversation;
        availability = await probe(session.sessionId, { homeDir: options.homeDir, source: options.agySource || session.agySource });
        if (availability !== 'ide' && availability !== 'legacy') {
          const message = availability === 'cli'
            ? t('This Antigravity chat started in the CLI, so VS Code cannot open it directly.')
            : t('Could not find the IDE history of this Antigravity chat.');
          return await offerAgyResume(vscode, session.sessionId, message, provider.picker);
        }
      }
      try {
        const result = await provider.open(vscode, session.sessionId);
        if (session.provider !== 'agy' || result === true) return true;
        // A legacy .pb conversation opens in the IDE too; its arrival is confirmed the same way.
        const arrived = result !== false && (availability === 'ide' || availability === 'legacy') &&
          await agyReachedConversation(session.sessionId, options.workspaceStateDb);
        return arrived || await offerAgyResume(vscode, session.sessionId,
          t('Could not confirm that Antigravity moved to the requested chat.'), provider.picker);
      } catch {
        // A provider update may remove its direct-open command or editor route.
      }
    }
    await vscode.commands.executeCommand(provider.picker);
    void vscode.window.showInformationMessage(t('Select the chat in the {0} {1}.', provider.name, t(provider.pickerName)));
  } catch {
    void vscode.window.showWarningMessage(t('Could not open {0}. Check that its extension is enabled in this window.', provider.name));
  }
  return false;
}

async function startSession(vscode, providerId) {
  const provider = providers.get(providerId);
  if (!provider) return false;
  const extension = vscode.extensions.getExtension(provider.extension);
  if (!extension) {
    void vscode.window.showWarningMessage(t('The {0} extension is not available in this window.', provider.name));
    return false;
  }
  try {
    await extension.activate();
    await provider.start(vscode);
    return true;
  } catch {
    void vscode.window.showWarningMessage(t('Could not start a new chat in {0}. Check that the official extension is enabled.', provider.name));
    return false;
  }
}

async function openUsage(vscode, providerId) {
  const provider = providers.get(providerId);
  if (!provider) return false;
  try {
    if (providerId === 'claude') {
      const uri = vscode.Uri.from({ scheme: 'https', authority: 'claude.ai', path: '/settings/usage' });
      if (await vscode.env.openExternal(uri)) return true;
      throw new Error('Browser did not open');
    }
    const extension = vscode.extensions.getExtension(provider.extension);
    if (!extension) {
      if (providerId === 'codex') {
        const uri = vscode.Uri.from({ scheme: 'https', authority: 'chatgpt.com', path: '/codex/settings/usage' });
        if (await vscode.env.openExternal(uri)) return true;
        throw new Error('Browser did not open');
      }
      void vscode.window.showWarningMessage(t('The {0} extension is not available in this window.', provider.name));
      return false;
    }
    await extension.activate();
    if (providerId === 'codex') await openCodexRoute(vscode, '/settings/usage');
    else await vscode.commands.executeCommand('antigravity.openSettings', 'Account');
    return true;
  } catch {
    void vscode.window.showWarningMessage(providerId === 'agy'
      ? t('Could not open the {0} account settings.', provider.name)
      : t('Could not open the {0} usage page.', provider.name));
    return false;
  }
}

module.exports = { openSession, startSession, openUsage, probeAgyConversation };
