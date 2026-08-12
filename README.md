# WebMCP 실습 랩

[WebMCP](https://developer.chrome.com/docs/ai/webmcp?hl=ko)를 직접 굴려 보기 위한
저장소다. 웹 페이지가 AI 에이전트에게 도구를 직접 등록하고, 에이전트가 그 도구를
호출하는 과정을 눈으로 볼 수 있는 정적 데모 사이트(`app/`)로 이루어져 있다.

> **개념 설명은 이 문서에 없다.** 실행한 사이트의 **개념 탭**이 명령형/선언형 API,
> 도구 설계 원칙, 보안과 승인 게이트, 실행 조건과 제약을 모두 다룬다.
> 이 README는 저장소를 **실행 · 배포 · 탐색**하는 데 필요한 것만 담는다.

---

## 빠른 시작

```bash
npm start        # 또는 npm run dev — http://localhost:4173
```

빌드 단계가 없다. `npx serve app -l 4173`으로 `app/`을 정적 서빙할 뿐이다.

Chrome 플래그를 켜지 않아도 페이지는 뜬다. 화면 우상단 배지가 현재 모드를 알려준다.

| 배지 | 의미 |
|---|---|
| 🟢 네이티브 WebMCP · `document.modelContext` | 브라우저 구현이 잡혔다 |
| 🟡 폴백 shim | 네이티브가 없어 페이지 내부 shim으로 동작 중 |

shim은 **네이티브가 없을 때만** 설치된다(`app/js/webmcp.js`). 항상 동작하는 shim은
데모를 통과시키되 WebMCP에 대해서는 아무것도 증명하지 못하기 때문이다.

네이티브로 확인하려면 Chrome 149+ 에서:

| 플래그 | 용도 |
|---|---|
| `chrome://flags/#enable-webmcp-testing` | API 활성화 (로컬 확인에 필수) |
| `chrome://flags/#devtools-webmcp-support` | DevTools의 WebMCP 패널. API 동작엔 불필요하지만 브라우저가 실제로 도구를 열거하는지 확인하려면 사실상 필수 |

보안 컨텍스트(HTTPS 또는 `localhost`)가 아니면 도구가 등록되지 않는다.
`file://`로 열면 동작하지 않는다.

### 진입 파라미터

| | |
|---|---|
| `#sim`, `?tab=sim` | 시뮬레이션 탭으로 진입 |
| `#native`, `?tab=native` | AI 여행 준비 탭으로 진입 |
| `?autostep=N` | 시뮬 탭에서 N단계까지 자동 진행 (시연 · 헤드리스 스크린샷 검증용) |

---

## 배포 (Vercel)

빌드가 없는 정적 사이트다. 저장소를 연결하면 그대로 뜬다 — `vercel.json`이
`outputDirectory: "app"`을 지정하므로 별도 프레임워크 설정은 필요 없다.

배포해도 페이지와 시뮬레이터는 전부 동작한다. shim 경로는 순수 JS라 환경을 타지
않는다. 갈리는 건 네이티브 WebMCP 활성화 여부다.

| 방문자 | 결과 |
|---|---|
| `chrome://flags/#enable-webmcp-testing`를 켠 Chrome 149+ | 🟢 네이티브. 플래그는 브라우저 설정이라 도메인을 가리지 않는다 |
| 플래그를 안 켠 일반 방문자 | 🟡 shim. 네이티브를 켜려면 오리진 트라이얼 토큰이 필요하다 |

**오리진 트라이얼 토큰**은
[developer.chrome.com/origintrials](https://developer.chrome.com/origintrials)에서
배포 도메인으로 발급받아 `app/index.html` 상단의 주석 처리된
`<meta http-equiv="origin-trial">`에 넣는다.

> 토큰은 **오리진마다** 발급된다. Vercel 프리뷰 URL은 배포마다 해시가 바뀌므로
> 토큰이 맞지 않는다. 고정된 프로덕션 도메인에만 적용하라.

그 외 배포 환경에서 확인할 것:

- **HTTPS** — Vercel이 기본 제공하므로 보안 컨텍스트 조건은 충족된다
- **`Origin-Agent-Cluster: ?0`을 보내지 않을 것** — 이 헤더가 붙으면 API가 꺼진다.
  Vercel은 기본으로 붙이지 않으며 `vercel.json`에서도 설정하지 않았다
- **헤드리스는 불가** — 배포하든 로컬이든 탭이 실제로 열려 있어야 도구가 산다

---

## 코드베이스 구조

```
WebMcp/
├── app/                        # 배포·실행 대상 (정적 사이트 루트)
│   ├── index.html              # 3개 탭(개념 · 시뮬레이션 · AI 여행 준비) 마크업
│   ├── styles.css              # 공유 디자인 토큰 + 탭별 레이아웃
│   └── js/
│       ├── main.js             # 진입점: 탭 · 렌더링 · 스테퍼 · 수동 호출 · 선언형 폼
│       ├── webmcp.js           # WebMCP 어댑터 (탐지 · shim · 등록 · 미러 · 호출)
│       ├── tools.js            # 시뮬 탭용 WebMCP 도구 정의
│       ├── store.js            # 운영 도메인 상태 · pub-sub · 승인 게이트
│       ├── scenario.js         # 운영 시나리오 async generator
│       └── native-demo.js      # 3번째 탭 전용 네이티브 WebMCP 도구 (shim 없음)
├── package.json                # dev 서버 스크립트 (`serve app -l 4173`)
├── vercel.json                 # 정적 배포 · 보안 헤더
├── .github/workflows/          # Claude Code / PR 리뷰 자동화
└── README.md
```

### 모듈 의존 관계

```
index.html
    └── main.js ─────────────────────────────────────────┐
            │                                            │
            ├── webmcp.js ◄── tools.js ── store.js       │
            │        ▲              ▲                    │
            │        │              └── scenario.js      │
            │        │                                   │
            └── native-demo.js (탭 3, document.modelContext 직접)
```

| 모듈 | 역할 | 등록하는 도구 |
|---|---|---|
| `main.js` | UI 오케스트레이션. 탭 전환 시 도구 생명주기 관리, 선언형 폼(`create_support_ticket`)과 그 명령형 대응물 | `create_support_ticket_via_form` |
| `webmcp.js` | `document.modelContext` 탐지, 네이티브 없을 때만 shim 설치, 등록 미러, 시뮬레이터용 `callTool` | — |
| `tools.js` | 시뮬 탭 도구 정의. 예약 상세가 열렸을 때만 `add_booking_note` 조건부 등록 | `list_bookings`, `get_booking`, `check_availability`, `assign_rooms`, `open_room_block`, `advance_booking_status`, `cancel_booking`, `add_booking_note` |
| `store.js` | 예약 · 객실 재고 시드 데이터, `commit`/`subscribe`, `requestApproval` | — |
| `scenario.js` | `next()` 시점의 실제 `state`를 읽어 다음 수를 정하는 async generator | — |
| `native-demo.js` | 도쿄 여행 준비 탭. 사람용 UI와 네이티브 도구가 공통 작업 로직 사용 | `list_trip_tasks`, `add_trip_task`, `complete_trip_task`, `reopen_trip_task` |

주요 export: `webmcp.js` → `runtime` · `registerTool` · `listTools` · `callTool` ·
`registrationReport`, `tools.js` → `registerAllTools` · `unregisterAllTools` ·
`syncContextualTools`, `store.js` → `state` · `commit` · `requestApproval`,
`native-demo.js` → `activateNativeDemo` · `deactivateNativeDemo`.

### 탭별 도구 등록 경로

| 탭 | 도구 등록 |
|---|---|
| 1 · 개념 | 시뮬 도구를 **백그라운드 등록** (`setSimulationToolsActive(true)` — 부팅 시부터 유지) |
| 2 · 시뮬레이션 | 탭 1과 동일한 시뮬 도구 + UI에서 수동 호출 · 스테퍼 |
| 3 · AI 여행 준비 | 여행 도구 4개를 탭 진입 시에만 등록, 이탈 시 `AbortController`로 해제 |

탭 1·2와 3은 **동시에 도구를 등록하지 않는다.** `main.js`의 `selectTab()`이
`native`가 아닐 때 `setSimulationToolsActive(true)`, `native`일 때 시뮬 도구를 해제하고
`activateNativeDemo()` / `deactivateNativeDemo()`로 전환한다.

### 읽는 순서 (권장)

1. **시뮬레이션 흐름:** `tools.js` → `scenario.js` → `webmcp.js` → `main.js`
2. **네이티브 예시:** `native-demo.js` → `main.js` (탭 전환 · 생명주기 부분)
3. **도메인 상태:** `store.js`는 `tools.js`와 `scenario.js` 양쪽에서 참조

---

## 구현 노트

읽기 전에 알아 두면 코드가 덜 이상해 보이는 것들.

- **표준에는 "내가 등록한 도구 목록"을 되읽는 API가 없다.** 등록한 주체가 페이지
  자신이기 때문이다. 그래서 `webmcp.js`가 등록 시점에 서술자를 로컬 배열에
  미러링하고, 시뮬레이터가 그걸 읽는다.
- **시뮬레이터의 호출 경로는 실제 에이전트의 경로가 아니다.** 미러의 `execute`를
  페이지가 직접 부르므로 *에이전트 → 브라우저 → 페이지* 홉을 건너뛴다. 배지가
  🟢여도 브라우저가 등록을 무시했을 가능성은 남는다. 브라우저가 실제로 도구를
  열거하는지는 DevTools의 WebMCP 패널에서만 확인된다. 같은 내용이 시뮬 탭의
  "이 시뮬레이터가 증명하는 것 / 못 하는 것" 블록에도 표시된다.
- **`scenario.js`는 단계 배열이 아니라 async generator다.** `next()`가 불릴 때마다
  그 시점의 실제 `state`를 읽고 다음 수를 정한다. 단계를 미리 계산해 두면 화면은
  똑같아 보여도 "예상 못 한 실패에 반응한다"는 이 데모의 핵심이 연출이 되어 버린다.
- **개념 탭과 시뮬레이션 탭은 같은 컴포넌트와 타입 스케일을 공유한다**
  (`.card`, `.code`, `.chip`, `.result`, `.callout`). 탭으로 갈라 놓아도 한 제품으로
  읽히게 하기 위해서다.

브라우저 콘솔에서 네이티브 지원 여부를 빠르게 확인하려면:

```js
JSON.stringify({
  onDoc: 'modelContext' in document,
  onNav: 'modelContext' in navigator,
  keys: Object.getOwnPropertyNames(
    Object.getPrototypeOf(document.modelContext ?? navigator.modelContext ?? {})),
})
```
