#!/usr/bin/env node
'use strict';
// Regenerates design/showcase.html from live media/panel.css, all PANEL_SCRIPTS,
// and bundled media/icons/{claude,codex,agy}.png so the interactive preview stays in sync.
const fs = require('node:fs');
const path = require('node:path');
const { PANEL_SCRIPTS } = require('../src/panel.cjs');

const ROOT = path.resolve(__dirname, '..');
const MEDIA = path.join(ROOT, 'media');
const OUT = path.join(ROOT, 'design', 'showcase.html');
// The same page in English, for recording the English README demo.
const OUT_EN = path.join(ROOT, 'design', 'showcase.en.html');
const embed = value => JSON.stringify(value).replace(/</g, '\\u003c');

const panelCss = fs.readFileSync(path.join(MEDIA, 'panel.css'), 'utf8');
const panelScripts = PANEL_SCRIPTS.map(name => fs.readFileSync(path.join(MEDIA, name), 'utf8'));
const logos = Object.fromEntries(
  ['claude', 'codex', 'agy'].map(id => [
    id,
    'data:image/png;base64,' + fs.readFileSync(path.join(MEDIA, 'icons', id + '.png')).toString('base64'),
  ])
);

const BASE_STATE = {"type":"state","sessions":[{"provider":"claude","key":"claude/s-approval","status":"approval","title":"모바일 메뉴 수정","project":"my-app","updatedAt":1795526580000,"waitSince":1795526580000,"execution":{"model":"claude-opus-5-5","modelSource":"response","modelAt":1795526520000,"effort":"high","effortSource":"setting","effortAt":1795526100000},"action":{"kind":"approval","token":"tok-edit-1","tool":"Edit","cwd":"/Users/dev/my-app","allow":true,"deny":true,"expiresAt":1795526735000,"pendingCount":1,"detail":"{\"file_path\":\"/Users/dev/my-app/src/nav/MobileMenu.tsx\",\"old_string\":\"  const open = useState(false);\\n  return <Menu open={open} />;\",\"new_string\":\"  const [open, setOpen] = useState(false);\\n  useEscape(() => setOpen(false));\\n  return <Menu open={open} onClose={() => setOpen(false)} />;\"}"}},{"provider":"codex","key":"codex/s-patch","status":"approval","title":"재시도 백오프 패치 적용","project":"my-app","updatedAt":1795526590000,"waitSince":1795526590000,"execution":{"model":"gpt-6.2-astra","modelSource":"setting","effort":"high","effortSource":"setting"},"preview":{"tool":"apply_patch","detail":"{\"command\":\"*** Begin Patch\\n*** Update File: src/checkout/retry.ts\\n@@ export async function withRetry<T>(fn: () => Promise<T>)\\n   const baseMs = 200;\\n-  for (let attempt = 0; attempt < 5; attempt++) {\\n+  for (let attempt = 0; attempt < 3; attempt++) {\\n+    const delay = baseMs * Math.pow(2, attempt);\\n     try { return await fn(); } catch (err) { await sleep(delay); }\\n   }\\n*** End Patch\"}"}},{"provider":"agy","key":"agy/s-question","status":"input","title":"피드 캐시 전략 결정","project":"my-app","updatedAt":1795526595000,"waitSince":1795526595000,"execution":{"model":"gemini-4-neon","modelSource":"call","effort":"high","effortSource":"call"},"preview":{"tool":"ask_question","detail":"{\"questions\":[{\"question\":\"피드 목록 응답 캐시를 어떤 계층에 적용할까요?\",\"options\":[\"클라이언트 메모리 캐시 (SWR)\",\"Edge CDN 60초 캐시\",\"Redis 세션별 캐시\"],\"is_multi_select\":true}]}"}},{"provider":"claude","key":"claude/s-bash","status":"approval","title":"결제 E2E 검증","project":"my-app","updatedAt":1795526600000,"waitSince":1795526600000,"execution":{"model":"claude-sonnet-5-5","modelSource":"response","modelAt":1795526540000,"effort":"medium","effortSource":"setting"},"action":{"kind":"approval","token":"tok-bash-2","tool":"Bash","cwd":"/Users/dev/my-app","allow":true,"deny":true,"expiresAt":1795526755000,"pendingCount":1,"detail":"{\"command\":\"pnpm test --filter checkout-e2e\",\"description\":\"결제 E2E 회귀 테스트 실행\"}"}},{"provider":"codex","key":"codex/s-a11y","status":"working","title":"접근성 점검","project":"my-app","updatedAt":1795526340000,"workSince":1795525860000,"priorityTargetKey":"codex/s-a11y-child","execution":{"model":"gpt-5.4","modelSource":"setting","effort":"high","effortSource":"setting"},"activity":{"tool":"Read","target":"src/nav/FocusTrap.tsx","at":1795526280000}},{"provider":"codex","key":"codex/s-a11y-child","isSubagent":true,"parentKey":"codex/s-a11y","status":"input","title":"키보드 탐색 검토","project":"my-app","updatedAt":1795526340000,"waitSince":1795526340000,"canOpen":true,"execution":{"model":"gpt-5.3-codex-spark","modelSource":"setting","effort":"medium","effortSource":"setting"},"activity":{"tool":"Grep","target":"tabIndex","at":1795526280000},"preview":{"tool":"request_user_input","detail":"{\"questions\":[{\"id\":\"focus-order\",\"header\":\"초점 이동\",\"question\":\"모바일 드로어가 닫힐 때 키보드 초점을 어디로 되돌릴까요?\",\"options\":[{\"label\":\"메뉴 토글 버튼 (권장)\",\"description\":\"WAI-ARIA Dialog 패턴에 맞춰 열기 버튼으로 복귀\"},{\"label\":\"본문 첫 번째 제목\",\"description\":\"내비게이션 이동 직후 바로 본문 탐색 시작\"}],\"isOther\":true}]}"}},{"provider":"agy","key":"agy/s-feed","status":"done","title":"피드 카드 간격 정리","project":"my-app","updatedAt":1795526520000,"replyAt":1795526520000,"replyUnread":true,"execution":{"model":"gemini-4-neon","modelSource":"call","effort":"medium","effortSource":"call"},"reply":"카드 사이 간격을 12px로 통일하고 좁은 화면에서 줄바꿈이 어긋나지 않도록 정리했습니다."},{"provider":"claude","key":"claude/s-checkout","status":"working","title":"결제 오류 원인 조사","project":"my-app","updatedAt":1795526640000,"workSince":1795526040000,"execution":{"model":"claude-sonnet-5-5","modelSource":"response","effort":"medium","effortSource":"setting"},"prompt":"결제 실패가 간헐적으로 나는 원인을 찾고 재시도 횟수와 백오프를 안전하게 제한해 줘","activity":{"tool":"Edit","target":"checkout/retry.ts","at":1795526670000},"progress":{"done":3,"total":5},"plan":[{"text":"간헐적 결제 타임아웃 로그 및 예외 경로 분석","status":"completed"},{"text":"중복 결제 방지 멱등성 키 검증 추가","status":"completed"},{"text":"지수 백오프 및 최대 3회 재시도 제한 적용","status":"in_progress"},{"text":"결제 재시도 단위·통합 테스트 보강","status":"pending"},{"text":"전체 체크아웃 회귀 테스트 실행","status":"pending"}],"changed":2,"changedFiles":["checkout/retry.ts","checkout/idempotency.ts"],"steps":[{"tool":"Edit","target":"checkout/retry.ts","at":1795526670000},{"tool":"Bash","target":"pnpm test checkout","at":1795526580000,"failed":true},{"tool":"Edit","target":"checkout/idempotency.ts","at":1795526460000},{"tool":"Grep","target":"PaymentError","at":1795526340000},{"tool":"Read","target":"checkout/retry.ts","at":1795526220000}],"usage":"메시지 24개"},{"provider":"codex","key":"codex/s-page","status":"working","title":"페이지네이션 회귀 테스트","project":"my-app","updatedAt":1795526640000,"workSince":1795526400000,"execution":{"model":"gpt-5.4-mini","modelSource":"setting","effort":"medium","effortSource":"setting"},"activity":{"tool":"Bash","target":"pnpm test pagination","at":1795526660000}},{"provider":"codex","key":"codex/s-filter","status":"done","title":"검색 필터 정리","project":"my-app","updatedAt":1795526160000,"replyAt":1795526160000,"execution":{"model":"gpt-5.4","modelSource":"setting","effort":"low","effortSource":"setting"},"reply":"필터 상태를 URL 쿼리와 동기화하고 뒤로 가기 시 복원되도록 수정했습니다."}],"usage":{"claude":"2026-11-26 기준 · 누적 메시지 1,420개","codex":"3개 세션 · 482,190 토큰 누적","agy":"1개 세션 · 38단계 진행"},"quotas":{"claude":{"status":"ready","plan":"Max","updatedAt":1795526580000,"windows":[{"name":"","period":300,"kind":"used","percent":32,"resetsAt":1795534740000},{"name":"","period":10080,"kind":"used","percent":26,"resetsAt":1795677900000},{"name":"Opus","period":10080,"kind":"used","percent":18,"resetsAt":1795677900000}]},"codex":{"status":"ready","plan":"Pro","updatedAt":1795526520000,"windows":[{"name":"","period":300,"kind":"used","percent":38,"resetsAt":1795532400000},{"name":"","period":10080,"kind":"used","percent":58,"resetsAt":1795785900000}]},"agy":{"status":"ready","plan":"Ultra","updatedAt":1795526610000,"windows":[{"name":"Gemini Models","period":300,"kind":"remaining","percent":18,"resetsAt":1795531020000},{"name":"Claude and GPT models","period":300,"kind":"remaining","percent":64,"resetsAt":1795531020000}]}},"connections":{"claude":"connected","codex":"connected","agy":"connected"},"elsewhere":[{"cwd":"/Users/dev/billing-api","folder":"billing-api","input":1,"approval":0}],"workspaceLabel":"my-app","hasWorkspace":true,"isRemoteWorkspace":false,"scanError":"","preferences":{"sort":"priority","providerOrder":["claude","codex","agy"],"attentionOnly":false,"hideCompleted":false},"hiddenCompleted":0,"attentionCount":5,"unreadCount":1};

const version = require('../package.json').version;
const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Session Monitor v${version} · Interactive Showcase</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Apple SD Gothic Neo', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  body { display: grid; grid-template-columns: minmax(280px, 380px) minmax(0, 1fr); gap: 36px; align-items: center; justify-content: center; max-width: 1040px; margin: 0 auto; padding: 32px 24px; background: radial-gradient(circle at 20% 20%, #1d2028 0%, #0d0e12 65%); color: #f4f4f6; }
  body.light-stage { background: radial-gradient(circle at 20% 20%, #ffffff 0%, #e9eaee 70%); color: #1d1d1f; }
  .frame-wrap { width: 360px; height: 760px; border-radius: 18px; overflow: hidden; box-shadow: 0 32px 80px -20px rgba(0, 0, 0, .65), 0 0 0 1px rgba(255, 255, 255, .12); display: flex; flex-direction: column; }
  body.light-stage .frame-wrap { box-shadow: 0 28px 70px -20px rgba(0, 0, 0, .18), 0 0 0 1px rgba(0, 0, 0, .09); }
  .vscode-titlebar { height: 34px; flex: none; display: flex; align-items: center; justify-content: space-between; padding: 0 14px; background: #18181b; color: #b4b4bc; border-bottom: 1px solid rgba(255, 255, 255, .08); font-size: 11px; font-weight: 600; letter-spacing: .04em; }
  body.light-stage .vscode-titlebar { background: #f5f5f7; color: #52525b; border-bottom-color: rgba(0, 0, 0, .08); }
  .vscode-titlebar span:last-child { font-weight: 400; opacity: .75; letter-spacing: 0; }
  iframe { width: 100%; flex: 1; border: 0; display: block; }
  .hero { display: grid; gap: 18px; }
  .badge { justify-self: start; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: rgba(10, 132, 255, .16); color: #5ea9ff; border: 1px solid rgba(10, 132, 255, .3); }
  body.light-stage .badge { background: rgba(0, 113, 227, .1); color: #0066cc; border-color: rgba(0, 113, 227, .22); }
  h1 { margin: 0; font-size: 38px; line-height: 1.14; letter-spacing: -.03em; font-weight: 700; }
  p { margin: 0; font-size: 15px; line-height: 1.6; opacity: .78; max-width: 44ch; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; }
  .btn { height: 34px; padding: 0 14px; border-radius: 9px; border: 1px solid rgba(255, 255, 255, .14); background: rgba(255, 255, 255, .07); color: inherit; font: 500 13px/1 inherit; cursor: pointer; transition: background .15s ease, transform .1s ease; }
  .btn:hover { background: rgba(255, 255, 255, .13); }
  .btn:active { transform: scale(.97); }
  body.light-stage .btn { border-color: rgba(0, 0, 0, .12); background: rgba(255, 255, 255, .85); }
  body.light-stage .btn:hover { background: #fff; }
  .btn.primary { background: #0a84ff; border-color: transparent; color: #fff; }
  .log { padding: 12px 14px; border-radius: 12px; font: 12px/1.6 'SF Mono', ui-monospace, Menlo, monospace; background: rgba(255, 255, 255, .05); border: 1px solid rgba(255, 255, 255, .08); min-height: 68px; color: #a1a1aa; }
  body.light-stage .log { background: rgba(255, 255, 255, .75); border-color: rgba(0, 0, 0, .08); color: #52525b; }
  @media (max-width: 820px) { body { grid-template-columns: 1fr; justify-items: center; } .hero { text-align: center; justify-items: center; } }
</style>
</head>
<body>
  <div class="frame-wrap">
    <div class="vscode-titlebar"><span>에이전트 세션 모니터</span><span>my-app</span></div>
    <iframe id="panel" title="Agent Session Monitor Live Preview"></iframe>
  </div>
  <section class="hero">
    <span class="badge">v${version} · Live Interactive Preview</span>
    <h1>모든 AI 에이전트의 작업을<br>한눈에 직관적으로.</h1>
    <p>Claude Code, Codex, Antigravity 세션을 하나의 Apple-grade 사이드바에 통합했습니다. 왼쪽 패널은 실제 확장의 CSS·JS가 그대로 동작합니다. 승인 버튼, 작업 요약(⋯), 계획 체크리스트, 변경 파일 클릭, <code>/</code> 검색, 구독 한도까지 직접 눌러 보세요.</p>
    <div class="controls">
      <button class="btn primary" id="toggleTheme">라이트 / 다크 전환</button>
      <button class="btn" id="inspectStory">작업 스토리 펼치기</button>
      <button class="btn" id="triggerQuestion">질문 요청 시뮬레이션</button>
      <button class="btn" id="triggerTruncated">큰 요청 미리보기</button>
      <button class="btn" id="previewNotifClick">알림 클릭 미리보기</button>
      <button class="btn" id="resetDemo">처음 상태로</button>
    </div>
    <div class="log" id="eventLog">상호작용 로그: 패널의 버튼·파일·승인 동작을 누르면 여기에 표시됩니다.</div>
  </section>
<script>
const PANEL_CSS = ${embed(panelCss)};
const PANEL_SCRIPTS_SRC = ${embed(panelScripts)};
const LOGOS = ${embed(logos)};
const BASE_STATE = ${embed(BASE_STATE)};
let isLight = false, shifted = false, currentState = structuredClone(BASE_STATE);
const iframe = document.getElementById('panel'), logEl = document.getElementById('eventLog');
const log = msg => { logEl.textContent = new Date().toLocaleTimeString('ko-KR') + ' · ' + msg; };
function shiftTimestamps(state, delta) {
  const bump = (obj, key) => { if (obj && typeof obj[key] === 'number') obj[key] += delta; };
  for (const s of state.sessions || []) {
    bump(s, 'updatedAt'); bump(s, 'waitSince'); bump(s, 'workSince'); bump(s, 'replyAt');
    bump(s.activity, 'at');
    if (Array.isArray(s.steps)) for (const step of s.steps) bump(step, 'at');
    bump(s.execution, 'modelAt'); bump(s.execution, 'effortAt');
    bump(s.action, 'expiresAt');
  }
  for (const q of Object.values(state.quotas || {})) {
    bump(q, 'updatedAt');
    if (Array.isArray(q?.windows)) for (const w of q.windows) bump(w, 'resetsAt');
  }
}
const themeVars = light => light
  ? ":root{--vscode-sideBar-background:#f5f5f7;--vscode-sideBar-foreground:#1d1d1f;--vscode-foreground:#1d1d1f;--vscode-descriptionForeground:#6e6e73;--vscode-sideBarSectionHeader-border:rgba(0,0,0,.09);--vscode-list-hoverBackground:rgba(0,0,0,.05);--vscode-focusBorder:#0071e3;--vscode-button-background:#0071e3;--vscode-button-hoverBackground:#0077ed;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:rgba(0,0,0,.065);--vscode-button-secondaryForeground:#1d1d1f;--vscode-textCodeBlock-background:#ececef;--vscode-textLink-foreground:#0066cc;--vscode-input-background:#fff;--vscode-input-foreground:#1d1d1f;--vscode-input-border:rgba(0,0,0,.14);--vscode-font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','SF Pro Text',sans-serif;--vscode-editor-font-family:'SF Mono',ui-monospace,Menlo,monospace;--vscode-font-size:13px;}"
  : ":root{--vscode-sideBar-background:#18181b;--vscode-sideBar-foreground:#ececef;--vscode-foreground:#ececef;--vscode-descriptionForeground:#9898a2;--vscode-sideBarSectionHeader-border:rgba(255,255,255,.09);--vscode-list-hoverBackground:rgba(255,255,255,.06);--vscode-focusBorder:#0a84ff;--vscode-button-background:#0a84ff;--vscode-button-hoverBackground:#2997ff;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:rgba(255,255,255,.09);--vscode-button-secondaryForeground:#ececef;--vscode-textCodeBlock-background:#111114;--vscode-textLink-foreground:#58a6ff;--vscode-input-background:#111114;--vscode-input-foreground:#ececef;--vscode-input-border:rgba(255,255,255,.14);--vscode-font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','SF Pro Text',sans-serif;--vscode-editor-font-family:'SF Mono',ui-monospace,Menlo,monospace;--vscode-font-size:13px;}";
function mount() {
  const now = Date.now();
  if (!shifted) {
    const delta = now - 1795526700000;
    shiftTimestamps(currentState, delta);
    shifted = true;
  }
  const fresh = structuredClone(currentState);
  for (const s of fresh.sessions) if (s.action?.expiresAt) s.action.expiresAt = now + 45000;
  const scripts = PANEL_SCRIPTS_SRC.map(src => '<script>' + src.replace(/<\\/script/gi, '<\\\\/script') + '<\\/script>').join('');
  const logoTags = ['claude', 'codex', 'agy'].map(id => '<img data-logo="' + id + '" data-bundled src="' + LOGOS[id] + '" alt="">').join('');
  iframe.srcdoc = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>' + themeVars(isLight) + '</style><style>' + PANEL_CSS + '</style>' +
    '<script>window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:msg=>window.parent.postMessage({fromShowcasePanel:true,msg},"*")});<\\/script></head>' +
    '<body class="' + (isLight ? 'vscode-light' : 'vscode-dark') + '"><template id="logos">' + logoTags + '</template><main id="sessions"></main>' + scripts + '</body></html>';
  iframe.onload = () => iframe.contentWindow.postMessage(fresh, '*');
}
window.addEventListener('message', ({ data }) => {
  if (!data?.fromShowcasePanel) return;
  const m = data.msg;
  if (m.type === 'filter') { log('Filter sync → ' + JSON.stringify(m)); return; }
  if (m.type) return;
  log('Host action → ' + JSON.stringify(m));
  if (m.action === 'approve' || m.action === 'deny' || m.action === 'answer') {
    const row = currentState.sessions.find(s => s.key === m.key);
    if (row) { row.status = 'working'; delete row.action; row.activity = { tool: 'Edit', target: 'src/nav/MobileMenu.tsx', at: Date.now() }; }
  } else if (m.action === 'newSession') { log('새 세션 시작 QuickPick 호출 (Claude / Codex / Antigravity)'); return; }
  else if (m.action === 'refresh') currentState.scanError = '';
  else if (m.action === 'markAllSeen') { for (const s of currentState.sessions) delete s.replyUnread; currentState.unreadCount = 0; }
  else if (m.action === 'setPinned') { const row = currentState.sessions.find(s => s.key === m.key); if (row) row.pinned = m.value; }
  else if (m.action === 'ackError') { const row = currentState.sessions.find(s => s.key === m.key); if (row) row.errorAcked = true; }
  else if (m.action === 'dismiss') currentState.sessions = currentState.sessions.filter(s => s.key !== m.key && s.parentKey !== m.key);
  else if (m.action === 'dismissChildren') currentState.sessions = currentState.sessions.filter(s => !(s.parentKey === m.key && (!['working', 'input', 'approval'].includes(s.status) || s.quiet)));
  else return;
  iframe.contentWindow.postMessage(structuredClone(currentState), '*');
});
document.getElementById('toggleTheme').onclick = () => { isLight = !isLight; document.body.classList.toggle('light-stage', isLight); mount(); };
document.getElementById('inspectStory').onclick = () => {
  const doc = iframe.contentDocument;
  doc?.querySelector('[data-key="claude/s-checkout"] .more')?.click();
  doc?.querySelector('[data-key="claude/s-checkout"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
document.getElementById('triggerQuestion').onclick = () => {
  const q = { provider: 'claude', key: 'claude/s-question-' + Date.now(), status: 'input', title: '설정 화면 정리', project: 'my-app', updatedAt: Date.now(), waitSince: Date.now(), execution: { model: 'claude-opus-5-5', modelSource: 'response', effort: 'xhigh', effortSource: 'setting' }, action: { kind: 'question', token: 'tok-q-' + Date.now(), tool: 'AskUserQuestion', cwd: '/Users/dev/my-app', expiresAt: Date.now() + 45000, pendingCount: 1, questions: [{ question: '탭 순서를 어떻게 둘까요?', header: '순서', multiSelect: false, choices: [{ label: '일반 → 알림 → 계정', description: '지금 문서와 같은 순서' }, { label: '계정 → 일반 → 알림', description: '로그인 직후 흐름 우선' }] }] } };
  currentState.sessions = [q, ...currentState.sessions];
  iframe.contentWindow.postMessage(structuredClone(currentState), '*');
  log('새 질문 요청이 도착했습니다! 상단 대기 요청 1 / N 전환 버튼이나 숫자 키로 바로 답해 보세요.');
};
document.getElementById('triggerTruncated').onclick = () => {
  const key = 'codex/s-large-patch-' + Date.now();
  const large = { provider: 'codex', key, status: 'approval', title: '대규모 마이그레이션 패치', project: 'my-app', updatedAt: Date.now(), waitSince: Date.now() - 120000, execution: { model: 'gpt-5.4', modelSource: 'setting', effort: 'high', effortSource: 'setting' }, preview: { tool: 'apply_patch', detail: JSON.stringify({ _truncated: { totalBytes: 24576, shownBytes: 10240 }, command: '*** Begin Patch\\n*** Update File: src/db/migrations/20261125_checkout.sql\\n@@\\n-ALTER TABLE orders ADD COLUMN retry_count INT;\\n+ALTER TABLE orders ADD COLUMN retry_count INT NOT NULL DEFAULT 0;\\n+CREATE INDEX idx_orders_retry ON orders (status, retry_count);\\n*** End Patch' }) } };
  currentState.sessions = [large, ...currentState.sessions];
  iframe.contentWindow.postMessage(structuredClone(currentState), '*');
  iframe.contentWindow.postMessage({ type: 'revealSession', key }, '*');
  log('큰 요청(24KB 중 앞 10KB)의 잘림 안내 배너를 표시했습니다.');
};
document.getElementById('previewNotifClick').onclick = () => {
  iframe.contentWindow.postMessage({ type: 'revealSession', key: 'claude/s-checkout' }, '*');
  log('macOS 알림 클릭 시뮬레이션 → revealSession("claude/s-checkout") 실행 (필터 해제 + 작업 스토리 열기 + 스크롤)');
};
document.getElementById('resetDemo').onclick = () => { currentState = structuredClone(BASE_STATE); shifted = false; mount(); log('데모를 초기 상태로 되돌렸습니다.'); };
mount();
</script>
</body>
</html>
`;

// Korean text in the page and its sample sessions, in English. Longer text is replaced first,
// and nothing here uses quotes or apostrophes, so it fits inside any string it lands in.
const ENGLISH = [
  ['피드 목록 응답 캐시를 어떤 계층에 적용할까요?', 'Which layer should cache the feed list response?'],
  ['클라이언트 메모리 캐시 (SWR)', 'Client memory cache (SWR)'], ['Edge CDN 60초 캐시', 'Edge CDN 60s cache'], ['Redis 세션별 캐시', 'Redis per-session cache'],
  ['모바일 메뉴 수정', 'Fix the mobile menu'], ['재시도 백오프 패치 적용', 'Apply the retry backoff patch'], ['피드 캐시 전략 결정', 'Decide the feed cache strategy'],
  ['결제 E2E 회귀 테스트 실행', 'Run the checkout E2E regression tests'], ['결제 E2E 검증', 'Verify checkout E2E'],
  ['접근성 점검', 'Accessibility review'], ['키보드 탐색 검토', 'Review keyboard navigation'], ['초점 이동', 'Focus'],
  ['모바일 드로어가 닫힐 때 키보드 초점을 어디로 되돌릴까요?', 'Where should keyboard focus return when the mobile drawer closes?'],
  ['메뉴 토글 버튼 (권장)', 'Menu toggle button (recommended)'], ['WAI-ARIA Dialog 패턴에 맞춰 열기 버튼으로 복귀', 'Back to the button that opened it, per the WAI-ARIA dialog pattern'],
  ['본문 첫 번째 제목', 'First heading of the page'], ['내비게이션 이동 직후 바로 본문 탐색 시작', 'Start reading the page right after navigating'],
  ['피드 카드 간격 정리', 'Tidy feed card spacing'],
  ['카드 사이 간격을 12px로 통일하고 좁은 화면에서 줄바꿈이 어긋나지 않도록 정리했습니다.', 'Set the gap between cards to 12px and kept line breaks aligned on narrow screens.'],
  ['결제 오류 원인 조사', 'Investigate checkout failures'],
  ['결제 실패가 간헐적으로 나는 원인을 찾고 재시도 횟수와 백오프를 안전하게 제한해 줘', 'Find why checkout fails now and then, and cap retries and backoff safely'],
  ['간헐적 결제 타임아웃 로그 및 예외 경로 분석', 'Analyze intermittent checkout timeout logs and error paths'],
  ['중복 결제 방지 멱등성 키 검증 추가', 'Add idempotency key checks against double charges'],
  ['지수 백오프 및 최대 3회 재시도 제한 적용', 'Apply exponential backoff with at most 3 retries'],
  ['결제 재시도 단위·통합 테스트 보강', 'Strengthen unit and integration tests for checkout retries'],
  ['전체 체크아웃 회귀 테스트 실행', 'Run the full checkout regression tests'], ['메시지 24개', '24 messages'],
  ['페이지네이션 회귀 테스트', 'Pagination regression tests'], ['검색 필터 정리', 'Clean up search filters'],
  ['필터 상태를 URL 쿼리와 동기화하고 뒤로 가기 시 복원되도록 수정했습니다.', 'Synced filter state with the URL query so going back restores it.'],
  ['2026-11-26 기준 · 누적 메시지 1,420개', 'As of 2026-11-26 · 1,420 messages total'], ['3개 세션 · 482,190 토큰 누적', '3 sessions · 482,190 tokens total'],
  ['1개 세션 · 38단계 진행', '1 session · 38 steps run'], ['에이전트 세션 모니터', 'Agent Session Monitor'],
  ['모든 AI 에이전트의 작업을<br>한눈에 직관적으로.', 'Every AI agent at work,<br>clear at a glance.'],
  ['Claude Code, Codex, Antigravity 세션을 하나의 Apple-grade 사이드바에 통합했습니다. 왼쪽 패널은 실제 확장의 CSS·JS가 그대로 동작합니다. 승인 버튼, 작업 요약(⋯), 계획 체크리스트, 변경 파일 클릭, <code>/</code> 검색, 구독 한도까지 직접 눌러 보세요.',
    'Claude Code, Codex, and Antigravity sessions in one Apple-grade sidebar. The panel on the left runs the real extension CSS and JS. Try the approval buttons, the work story (⋯), the plan checklist, changed files, <code>/</code> search, and subscription limits.'],
  ['라이트 / 다크 전환', 'Light / Dark'], ['작업 스토리 펼치기', 'Open work story'], ['질문 요청 시뮬레이션', 'Simulate a question'],
  ['큰 요청 미리보기', 'Preview a large request'], ['알림 클릭 미리보기', 'Preview a notification click'], ['처음 상태로', 'Reset'],
  ['상호작용 로그: 패널의 버튼·파일·승인 동작을 누르면 여기에 표시됩니다.', 'Interaction log: buttons, files, and approvals you press in the panel show up here.'],
  ['새 세션 시작 QuickPick 호출 (Claude / Codex / Antigravity)', 'Start New Session QuickPick (Claude / Codex / Antigravity)'],
  ['설정 화면 정리', 'Tidy the settings screen'], ['탭 순서를 어떻게 둘까요?', 'How should the tabs be ordered?'], ['순서', 'Order'],
  ['일반 → 알림 → 계정', 'General → Notifications → Account'], ['지금 문서와 같은 순서', 'Same order as the current docs'],
  ['계정 → 일반 → 알림', 'Account → General → Notifications'], ['로그인 직후 흐름 우선', 'Puts the post-sign-in flow first'],
  ['새 질문 요청이 도착했습니다! 상단 대기 요청 1 / N 전환 버튼이나 숫자 키로 바로 답해 보세요.', 'A new question arrived. Answer it with the 1 / N pending request switcher at the top or the number keys.'],
  ['대규모 마이그레이션 패치', 'Large migration patch'],
  ['큰 요청(24KB 중 앞 10KB)의 잘림 안내 배너를 표시했습니다.', 'Showed the notice for a large request (first 10KB of 24KB).'],
  ['실행 (필터 해제 + 작업 스토리 열기 + 스크롤)', '(clears filters, opens the work story, scrolls)'], ['macOS 알림 클릭 시뮬레이션', 'Simulated macOS notification click'],
  ['데모를 초기 상태로 되돌렸습니다.', 'Reset the demo.'],
].sort((a, b) => b[0].length - a[0].length);
// The panel scripts carry their own dictionary, so they are set aside while the page is translated.
const scriptsJson = embed(panelScripts);
const [before, after] = html.split(scriptsJson);
const translate = part => ENGLISH.reduce((text, [ko, en]) => text.replaceAll(ko, en), part)
  .replaceAll('lang="ko"', 'lang="en"').replace("toLocaleTimeString('ko-KR')", "toLocaleTimeString('en-US')");
const english = translate(before) + scriptsJson + translate(after);
const leftover = (translate(before) + translate(after)).match(/[^\s<>'"]*[\uAC00-\uD7A3][^\s<>'"]*/);
if (leftover) throw new Error('English showcase still has Korean: ' + leftover[0]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
for (const [file, page] of [[OUT, html], [OUT_EN, english]]) {
  fs.writeFileSync(file, page);
  console.log('Wrote ' + path.relative(ROOT, file) + ' (' + Buffer.byteLength(page) + ' bytes)');
}
