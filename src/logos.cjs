'use strict';

// Shared provider and app logo resolution for both webview UI and macOS notifications.
// macOS UNNotificationAttachment only supports raster images (PNG/JPEG), never SVG.
const fs = require('node:fs');
const path = require('node:path');
const { VENDORS } = require('./shared.cjs');

const APP_ICON_PNG = 'app.png';

const LOGO_SPECS = Object.freeze({
  claude: Object.freeze({
    extension: VENDORS.claude,
    dir: 'resources',
    files: Object.freeze(['claude-logo.png']),
    fallbackPng: 'claude.png',
  }),
  codex: Object.freeze({
    extension: VENDORS.codex,
    dir: 'resources',
    files: Object.freeze(['blossom-black.svg', 'blossom.dark.png']),
    ink: true,
    fallbackPng: 'codex.png',
  }),
  agy: Object.freeze({
    extension: VENDORS.agy,
    dir: 'img',
    files: Object.freeze(['logo.png']),
    fallbackPng: 'agy.png',
  }),
});

const RASTER_EXT = /\.(?:png|jpe?g)$/i;
const logoCache = new Map();

function fileExists(filePath, fsSync) {
  if (typeof filePath !== 'string' || !filePath) return false;
  try {
    return Boolean(fsSync.existsSync(filePath));
  } catch {
    return false;
  }
}

// Resolves a verified local PNG/JPEG path for a macOS notification attachment.
// Prefers an installed vendor extension's raster asset (skipping SVGs such as Codex's
// blossom-black.svg), then falls back to bundled media/icons/*.png so CLI-only users
// still receive crisp agent badges. Unknown or mixed providers fall back to app.png.
function resolveNotificationLogo(provider, { vscode, extensionPath, fsSync = fs } = {}) {
  const iconsDir = typeof extensionPath === 'string' && extensionPath
    ? path.join(extensionPath, 'media', 'icons')
    : '';
  const spec = typeof provider === 'string' && Object.hasOwn(LOGO_SPECS, provider)
    ? LOGO_SPECS[provider]
    : undefined;
  const vendor = spec ? vscode?.extensions?.getExtension?.(spec.extension) : undefined;
  const vendorRoot = vendor?.extensionPath || vendor?.extensionUri?.fsPath || '';

  const useCache = fsSync === fs;
  let cacheKey;
  if (useCache) {
    cacheKey = `${typeof provider === 'string' ? provider : ''}\0${iconsDir}\0${typeof vendorRoot === 'string' ? vendorRoot : ''}`;
    if (logoCache.has(cacheKey)) return logoCache.get(cacheKey);
  }

  let resolved;
  if (spec) {
    if (typeof vendorRoot === 'string' && vendorRoot) {
      for (const file of spec.files) {
        if (!RASTER_EXT.test(file)) continue;
        const candidate = path.join(vendorRoot, spec.dir, file);
        if (fileExists(candidate, fsSync)) { resolved = candidate; break; }
      }
    }
    if (!resolved && iconsDir) {
      const fallback = path.join(iconsDir, spec.fallbackPng);
      if (fileExists(fallback, fsSync)) resolved = fallback;
    }
  }

  if (!resolved && iconsDir) {
    const appIcon = path.join(iconsDir, APP_ICON_PNG);
    if (fileExists(appIcon, fsSync)) resolved = appIcon;
  }

  if (useCache) {
    if (logoCache.size >= 64) logoCache.delete(logoCache.keys().next().value);
    logoCache.set(cacheKey, resolved);
  }
  return resolved;
}

// Resolves sidebar webview logos and localResourceRoots for src/panel.cjs.
// Uses installed vendor extension assets first, and falls back to bundled media/icons/*.png
// when a vendor extension is absent (e.g., CLI-only Claude Code or Codex users).
function resolveWebviewLogos(vscode, extensionUri, webview) {
  const media = vscode.Uri.joinPath(extensionUri, 'media');
  const icons = vscode.Uri.joinPath(media, 'icons');
  const localResourceRoots = [media];
  const marks = [];

  for (const [id, spec] of Object.entries(LOGO_SPECS)) {
    const fallbackUri = webview.asWebviewUri(vscode.Uri.joinPath(icons, spec.fallbackPng)).toString();
    const vendor = vscode.extensions?.getExtension?.(spec.extension);
    if (vendor) {
      const assets = vscode.Uri.joinPath(vendor.extensionUri, spec.dir);
      localResourceRoots.push(assets);
      const uris = spec.files.map(file => webview.asWebviewUri(vscode.Uri.joinPath(assets, file)).toString());
      marks.push({ id, ink: Boolean(spec.ink), uris, fallbackUri });
    } else {
      // Bundled fallback icons are full-color badges, so never apply dark-mode ink inversion.
      marks.push({ id, ink: false, uris: [fallbackUri], fallbackUri, isFallback: true });
    }
  }

  return { localResourceRoots, marks };
}

module.exports = {
  APP_ICON_PNG,
  LOGO_SPECS,
  resolveNotificationLogo,
  resolveWebviewLogos,
};
