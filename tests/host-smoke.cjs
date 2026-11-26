// Run by the real VS Code extension host in a disposable profile.
'use strict';
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
exports.run = async function () {
  const extension = vscode.extensions.getExtension('local-tools.agent-session-monitor');
  assert.ok(extension, 'extension must be discovered');
  await extension.activate();
  await vscode.commands.executeCommand('agentSessionMonitor.sessions.focus');
  await vscode.commands.executeCommand('agentSessionMonitor.refresh');
  assert.ok(extension.isActive);
  const containers = extension.packageJSON.contributes.viewsContainers.activitybar;
  assert.ok(containers.some(container => container.id === 'agentSessionMonitor'));
  const commands = await vscode.commands.getCommands(true);
  for (const suffix of ['connect', 'disconnect', 'rename', 'dismiss', 'open', 'switchSession', 'nextAttention', 'previousSession',
    'markAllSeen', 'allowOpenRequest', 'denyOpenRequest', 'newSession', 'arrange', 'testNotification']) {
    assert.ok(commands.includes('agentSessionMonitor.' + suffix));
  }
  // The window endpoint only answers this handshake once the packaged webview
  // JavaScript sends its ready message in the visible panel of this workspace.
  const base = process.env.AGENT_MONITOR_SMOKE_DIR;
  const location = path.join(base,'profile/User/globalStorage/local-tools.agent-session-monitor/approval-windows');
  const cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
  async function answersFor(folder) {
    const names = await fs.readdir(location).catch(() => []);
    for (const name of names) {
      const descriptor = JSON.parse(await fs.readFile(path.join(location,name),'utf8'));
      const nonce = crypto.randomUUID();
      const accepted = await new Promise(resolve => {
        const socket = net.createConnection(descriptor.address);
        socket.setTimeout(500, () => socket.destroy());
        socket.on('error', () => socket.destroy());
        socket.on('close', () => resolve(false));
        socket.on('connect', () => socket.write(JSON.stringify({nonce, cwd:folder}) + '\n'));
        socket.on('data', data => {
          try {
            const proof = Buffer.from(JSON.parse(data.toString()).proof,'base64');
            resolve(crypto.verify(null,Buffer.from(JSON.stringify(['hello',nonce])),descriptor.publicKey,proof));
          } finally { socket.destroy(); }
        });
      });
      if (accepted) return true;
    }
    return false;
  }
  let ready = false;
  for (let attempt = 0; !ready && attempt < 45; attempt++) {
    ready = await answersFor(cwd);
    if (!ready) await sleep(150);
  }
  assert.ok(ready, 'workspace webview did not become visible and ready');
  assert.equal(await answersFor(path.dirname(cwd)), false, 'window must not accept another folder’s request');
  await fs.writeFile(path.join(base,'result'),'PASS\n');
};
