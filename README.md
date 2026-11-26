<div align="center">

<img src="media/icons/app.png" width="80" alt="Agent Session Monitor Icon" />

# Agent Session Monitor

**Claude Code · Codex · Antigravity 멀티 에이전트 세션을 하나의 VS Code 사이드바에서 모니터링하고 제어합니다.**

![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.120.0-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-555555?style=flat-square)
![Dependencies](https://img.shields.io/badge/Runtime%20Dependencies-0-2ea44f?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

[주요 기능](#주요-기능) · [지원 범위](#지원-범위) · [빠른 시작](#빠른-시작) · [단축키](#키보드-단축키) · [설정](#설정) · [보안](#개인정보-보호-및-보안) · [개발](#개발)

<br />

<img src="assets/demo.gif" width="440" alt="Agent Session Monitor 사이드바 데모" />

<sub>인라인 Diff 승인 · 병렬 대기 큐 · 서브에이전트 트리 · 작업 스토리 · 구독 한도 게이지</sub>

</div>

---

## 주요 기능

여러 AI 코딩 에이전트를 동시에 띄워 작업할 때, 어떤 세션이 승인을 기다리고 무엇을 수정 중인지 채팅 탭을 오가지 않고 한 화면에서 파악하고 제어할 수 있습니다.

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>통합 멀티 에이전트 보드</strong><br />
      현재 작업 폴더의 <strong>Claude Code · Codex · Antigravity</strong> 세션을 <code>확인 필요 · 작업 중 · 이전 대화</code>로 자동 정리합니다. 세그먼트 필터, <code>/</code> 즉시 검색, 에이전트별 필터와 <code>+</code> 새 세션 시작을 제공합니다.
    </td>
    <td width="50%" valign="top">
      <strong>인라인 승인 &amp; 병렬 대기 큐</strong><br />
      VS Code 메인 Claude Code 세션의 파일 수정(컬러 diff · <code>+N −M</code>), 명령 실행, 선택형 질문(복수 질문·다중 선택)을 패널에서 바로 허용·거절·응답합니다. 여러 대기 요청은 <code>1 / N</code> 스텝퍼로 순회합니다.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>작업 스토리 &amp; 서브에이전트 트리</strong><br />
      <code>⋯</code> 또는 <code>I</code> 키로 요청 원문, 실시간 계획 체크리스트·진행률, 원클릭 변경 파일 칩, 실행 타임라인을 확인합니다. 하위 에이전트는 <code>진행/전체</code> 배지로 묶고 완료 항목을 한 번에 정리합니다.
    </td>
    <td width="50%" valign="top">
      <strong>macOS 네이티브 알림 &amp; 창 라우팅</strong><br />
      VS Code 창이 비활성 상태일 때 내장 Universal Binary 헬퍼(Apple Silicon · Intel)가 에이전트 로고와 함께 알림을 표시합니다. 클릭하면 해당 프로젝트가 열린 정확한 VS Code 창과 세션으로 이동합니다.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>구독 한도 게이지</strong><br />
      로그인된 공식 CLI의 로컬 사용량 조회만 사용해(대화 턴 미소비) 세 도구의 남은 한도와 초기화 카운트다운을 하단 타일과 상세 카드에 표시합니다.
    </td>
    <td width="50%" valign="top">
      <strong>제로 런타임 의존성 &amp; 안전한 기본값</strong><br />
      외부 npm 런타임 패키지 <strong>0개</strong>로 가볍게 동작합니다. 제한된 작업 영역(Restricted Mode)에서도 세션 목록을 읽기 전용으로 안전하게 표시합니다.
    </td>
  </tr>
</table>

---

## 지원 범위

| 기능 | Claude Code | Codex | Antigravity |
|---|:---:|:---:|:---:|
| 실시간 세션 상태 · 작업 스토리 · 서브에이전트 | ✅ | ✅ | ✅ |
| 대기 요청 구조화 미리보기 (diff · 질문 · 권한) | ✅ | ✅ | ✅ |
| 패널 내 인라인 승인 / 질문 응답 | ✅ *(VS Code 메인 세션)* | 읽기 전용 · 채팅 이동 | 읽기 전용 · 채팅 이동 |
| 구독 한도 · 초기화 카운트다운 | ✅ | ✅ | ✅ |

> [!NOTE]
> Codex·Antigravity는 훅 프로토콜상 외부 패널에서 응답을 직접 주입할 수 없으므로 읽기 전용 미리보기와 원클릭 채팅 이동을 제공합니다. Claude Code의 계획 승인(`ExitPlanMode`), 서브에이전트, 대용량 요청, CLI 세션, 대기 시간 만료 요청도 동일하게 채팅 이동으로 전환됩니다.

- **macOS**: 전체 기능 지원 (훅 자동 연결, Universal Binary 네이티브 알림, 내장 `sqlite3` 활용)
- **Linux**: 훅 자동 연결, 인라인 승인, VS Code 인앱 알림 지원 *(Codex·Antigravity 메타데이터 조회 시 `sqlite3` CLI 필요)*
- **Windows**: 미지원 (Unix 도메인 소켓 및 POSIX 훅 기반)

---

## 빠른 시작

**요구 사항**: VS Code `^1.120.0` · Node.js `>= 18` *(테스트 실행은 `>= 20`)* · Python 3 *(VSIX 패키징)*

### 1. 빌드 및 설치

```bash
git clone https://github.com/dh3668/agent-session-monitor.git
cd agent-session-monitor

# VSIX 패키지 빌드 (외부 npm 의존성 없음)
npm run package

# VS Code에 설치
code --install-extension agent-session-monitor-1.0.1.vsix --force
```

### 2. 에이전트 훅 연결

1. VS Code 왼쪽 활동 표시줄에서 **에이전트 세션 모니터** 아이콘을 엽니다.
2. 패널 상단 **연결** 버튼(또는 `⇧⌘P` → **`에이전트 세션 모니터: 에이전트 연결`**)에서 연결할 도구를 선택합니다.
3. *(Codex)* Codex CLI에서 **`/hooks`** 를 실행해 등록된 훅을 **신뢰(Trust)** 하면 승인 대기와 도구 활동까지 모두 연동됩니다. *(신뢰 전에도 로컬 실행 기록·잠금을 확인할 수 있는 환경에서는 작업 중 대화가 표시됩니다.)*
4. *(macOS)* **`에이전트 세션 모니터: 알림 테스트`** 를 실행해 알림 권한을 허용하면 창 밖에서도 클릭 이동 알림을 받을 수 있습니다.

> [!IMPORTANT]
> **VS Code 확장을 삭제해도 각 도구 설정 파일에 추가된 훅은 자동으로 제거되지 않습니다.** 확장을 제거하기 전에 **`에이전트 세션 모니터: 에이전트 연결 해제`** 를 실행해 등록된 훅을 먼저 정리해 주세요.

<details>
<summary>훅 설정 변경 파일 및 업데이트 안내</summary>

- `에이전트 연결`은 선택한 도구의 사용자 설정 파일(`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/config/hooks.json`)에만 이 확장의 훅 항목을 추가하며 기존 사용자 훅은 보존합니다.
- 확장 업데이트로 훅 구성이 바뀌면 패널 상단에 **`훅 업데이트 필요`** 배너가 표시됩니다. **업데이트** 버튼(또는 `에이전트 연결`)으로 갱신하세요. *(Codex는 훅 갱신 후 `/hooks` 재신뢰가 필요할 수 있습니다.)*
- 이미 확장을 삭제했다면 위 설정 파일에서 `agent-session-monitor` 훅 항목을 직접 제거하면 됩니다.

</details>

---

## 키보드 단축키

<details>
<summary><strong>단축키 전체 보기 (10개)</strong></summary>

<br />

| 동작 | macOS | Linux |
|---|---|---|
| 열린 요청 허용 / 답변 보내기 *(에디터 포커스 중에도 동작)* | `⌃⌘↵` | `Ctrl+Alt+Enter` |
| 열린 요청 거절 *(에디터 포커스 중에도 동작)* | `⌃⌘⌫` | `Ctrl+Alt+Backspace` |
| 다음 확인할 세션 | `⌃⌘N` | `Ctrl+Alt+N` |
| 직전에 연 대화로 돌아가기 | `⌃⌘B` | `Ctrl+Alt+B` |
| 현재 폴더의 세션 전환 (QuickPick) | `⌃⌘L` | `Ctrl+Alt+L` |
| 에이전트 세션 모니터 패널 포커스 | `⌃⌘A` | `Ctrl+Alt+A` |
| 패널 내 즉시 검색 | `/` | `/` |
| 작업 스토리 열기/닫기 *(한글 입력기 지원)* | `I` | `I` |
| 검색 · 작업 스토리 · 열린 요청 카드 닫기 | `Esc` | `Esc` |
| 선택지 선택 / 행 이동 / 하위 트리 펼치기 | `1`–`9` · `↑/↓` · `←/→` | `1`–`9` · `↑/↓` · `←/→` |

</details>

## 설정

<details>
<summary><strong>확장 설정 옵션 전체 보기 (9개)</strong></summary>

<br />

| 설정 키 | 기본값 | 설명 |
|---|---|---|
| `agentSessionMonitor.notifications` | `attentionAndDone` | 알림 범위 (`attentionAndDone` · `attention` · `off`) |
| `agentSessionMonitor.awayNotifications` | `true` | VS Code 비활성 시 macOS 네이티브 알림 전달 |
| `agentSessionMonitor.notificationSound` | `true` | macOS 네이티브 알림 사운드 재생 |
| `agentSessionMonitor.inlineActions` | `true` | 패널 내 Claude Code 승인·질문 즉시 처리 |
| `agentSessionMonitor.inlineActionSeconds` | `45` | 인라인 처리 대기 시간(15~540초, 만료 시 채팅으로 이관) |
| `agentSessionMonitor.activityDetail` | `true` | 요청·계획·실행 단계·변경 파일·응답 요약 표시 *(메모리 전용)* |
| `agentSessionMonitor.subscriptionUsage` | `true` | 공식 CLI 로컬 구독 한도 조회 (5분 캐시) |
| `agentSessionMonitor.chatLocation` | `secondarySidebar` | 세션 열기 위치 (`secondarySidebar` · `lastUsed`) |
| `agentSessionMonitor.otherFolders` | `true` | 다른 작업 폴더의 대기 요청 칩 표시 |

</details>

---

## 개인정보 보호 및 보안

- **메모리 전용 활동 처리**: 프롬프트, 도구 입력, diff, 응답 요약은 신뢰된 작업 영역의 확장 호스트 메모리에만 유지되며 디스크 스냅샷에 기록하지 않습니다. *(단, `awayNotifications`와 `activityDetail`이 모두 켜져 있으면 비활성 창의 macOS 알림 본문에 짧은 요약이 포함되어 알림 센터에 표시·보관될 수 있으며, 창 복귀 시 자동 정리됩니다.)*
- **로컬 인증 브리지**: 훅과 확장 호스트 간 Unix 도메인 소켓 통신은 Ed25519 서명과 작업 영역 물리 경로 검증을 거칩니다.
- **오클릭 · 기만 방지**: 요청 표시 직후 입력 보호(~0.5초), 포인터 이동 중 행 고정, BiDi·보이지 않는 문자(`\u202e` 등) 명시적 이스케이프, 긴 빈 줄 접기 및 스크롤 미확인 경고를 적용합니다.
- **파일 접근 경계**: 변경 파일 바로 열기는 세션에 기록된 항목 중 심볼릭 링크를 포함해 현재 작업 폴더 내부에 실존하는 파일만 허용합니다.
- **제한된 작업 영역 지원**: 신뢰되지 않은 폴더에서는 세션 목록만 읽기 전용으로 표시하고 훅 수집·인라인 승인·구독 조회를 비활성화합니다.

---

## 개발

외부 런타임 의존성 없이 Node.js 내장 테스트 러너와 Python 표준 라이브러리로 빌드·검증합니다.

```bash
npm test                  # 전체 단위·통합·Strict-CSP 브라우저 테스트
npm run package           # VSIX 빌드 및 require 그래프 자동 검증
sh scripts/smoke-host.sh  # VS Code 확장 호스트 스모크 테스트
npm run showcase          # 독립 실행형 브라우저 데모(design/showcase.html) 생성
npm run build:notifier    # macOS Universal Binary 알림 헬퍼 재빌드 (swiftc 필요)
```

<details>
<summary>디렉터리 구조</summary>

```text
agent-session-monitor/
├── src/                    # 확장 호스트, 훅·Ed25519 로컬 브리지, 메타데이터·서브에이전트·구독 한도·알림 모듈
├── media/                  # Strict-CSP 웹뷰 모듈(format.js, panel-*.js, panel.css) 및 번들 아이콘
├── native/macos-notifier/  # macOS UNUserNotificationCenter Universal Binary 소스 및 빌드 스크립트
├── scripts/                # 무의존 VSIX 패키저, 확장 호스트 스모크 테스트, 쇼케이스 빌더
├── tests/                  # 단위·통합·Strict-CSP 브라우저·호스트 스모크 테스트 스위트
└── assets/                 # README 사이드바 데모 GIF
```

</details>

---

## 상표권 안내 및 라이선스

Agent Session Monitor는 독립적인 오픈소스 프로젝트이며 Anthropic, OpenAI 또는 Google과 제휴·후원·공식 보증 관계가 없습니다. Claude 및 Claude Code는 Anthropic, PBC의 상표, OpenAI·ChatGPT·Codex는 OpenAI의 상표, Google·Antigravity·Gemini는 Google LLC의 상표입니다.

이 저장소와 VSIX 패키지에는 타사의 공식 로고 파일을 포함하거나 재배포하지 않습니다. 로컬 환경에 공식 VS Code 확장(`anthropic.claude-code`, `openai.chatgpt`, `google.google-antigravity`)이 설치되어 있으면 런타임에 해당 확장의 로컬 아이콘을 참조해 표시하며, 미설치 환경에서는 본 프로젝트의 자체 모노그램 폴백 배지(`CL`, `CX`, `AG`)를 사용합니다.

Distributed under the [MIT License](LICENSE).
