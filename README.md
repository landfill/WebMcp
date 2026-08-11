# WebMCP 실습 랩 — 개념 + 운영 시뮬레이션

Chrome 문서([WebMCP](https://developer.chrome.com/docs/ai/webmcp?hl=ko))에 소개된 WebMCP를
직접 굴려 보기 위한 저장소다. 개념 설명(이 문서)과, 실제로 도구를 등록하고 에이전트가
호출하는 것을 눈으로 보는 데모(`app/`)로 이루어져 있다.

---

## 1. WebMCP가 푸는 문제

지금 AI 에이전트가 웹사이트를 쓰는 방식은 **사람 흉내**다. 스크린샷을 찍고, 버튼처럼
생긴 픽셀을 찾고, 좌표를 클릭한다. 이걸 문서에서는 "작동(Action)"이라 부른다.

이 방식의 문제:

| 문제 | 내용 |
|---|---|
| 취약함 | CSS 한 줄 바뀌면 깨진다 |
| 느림 | 스크린샷 → 추론 → 클릭 → 다시 스크린샷 루프 |
| 모호함 | "장바구니 담기" 버튼이 3개면 어느 것인지 모른다 |
| 위험함 | 무엇이 되돌릴 수 없는 작업인지 에이전트가 알 방법이 없다 |
| 사이트의 통제권 없음 | 사이트는 에이전트가 뭘 할지 정할 수 없다 |

WebMCP의 발상은 뒤집는 것이다. **사이트가 직접 "내가 제공하는 기능은 이것들이고,
입력은 이런 모양이다"를 선언한다.** 에이전트는 픽셀 대신 그 목록을 읽고, 클릭 대신
함수를 호출한다.

```
[기존]  에이전트 → 스크린샷 → 좌표 추측 → 클릭 → DOM 변화 관찰 → 반복
[WebMCP] 에이전트 → 도구 목록 읽기 → tool.execute(args) → 구조화된 결과
```

MCP(Model Context Protocol)와 이름이 같은 이유는 개념이 같기 때문이다. 다만 MCP 서버가
별도 프로세스인 것과 달리, **WebMCP의 "서버"는 열려 있는 웹 페이지 자신**이다.
페이지의 JS 컨텍스트, 로그인 세션, 이미 로드된 상태를 그대로 쓴다.

---

## 2. 핵심 API

### 명령형 (Imperative) — JavaScript

```js
const controller = new AbortController();

await document.modelContext.registerTool({
  name: 'assign_rooms',
  description: '예약에 객실을 배정한다. 잔여 객실이 모자라면 부족분을 보고한다.',
  inputSchema: {
    type: 'object',
    properties: { bookingId: { type: 'string' } },
    required: ['bookingId'],
  },
  annotations: { readOnlyHint: false, untrustedContentHint: false },
  async execute({ bookingId }) {
    // ... 실제 앱 로직 — UI 버튼이 부르는 그 함수를 그대로 부른다
    return { content: [{ type: 'text', text: `${bookingId} 배정 완료` }] };
  },
}, { signal: controller.signal });

controller.abort(); // 등록 해제
```

핵심 조각:

- **`name`** — 에이전트가 부르는 식별자. 동사_명사 형태로.
- **`description`** — 에이전트가 도구 선택에 사용하는 설명. 도구의 기능, 사용 시점,
  실행할 수 없는 조건을 짧고 구체적으로 적는다.
- **`inputSchema`** — JSON Schema. 에이전트가 인자를 지어내지 않게 하는 계약.
- **`annotations`** — `readOnlyHint`는 상태를 바꾸지 않는 조회 도구,
  `untrustedContentHint`는 외부 데이터나 사용자 작성 콘텐츠를 반환하는 도구임을
  나타낸다. 현재 초안에는 `destructiveHint`와 `idempotentHint`가 없다.
- **`execute`** — 동기/비동기 모두 가능. 반환은 `{content:[{type:'text',text}]}` 형태가
  표준이고, 구현에 따라 평범한 값도 받는다.
- **`{ signal }`** — 등록 해제는 `unregisterTool()`이 아니라 **AbortController**로 한다.
  화면이 바뀌면 도구도 같이 사라지는 게 자연스럽다.

> **현재 네임스페이스:** 현재 사양과 Chrome 문서는 `document.modelContext`를 사용한다.
> `navigator.modelContext`는 이전 실험 버전의 이름이며 Chrome 150부터 폐기 대상이다.
> 구버전 실험 환경도 지원해야 할 때만 `document.modelContext ?? navigator.modelContext`
> 순서로 확인한다. 이 저장소의 `app/js/webmcp.js`가 이 호환 처리를 담당한다.

### 선언형 (Declarative) — HTML만으로

이미 폼이 있는 사이트라면 JS를 한 줄도 안 쓰고 도구를 만들 수 있다.

```html
<form toolname="create_support_ticket"
      tooldescription="고객 문의 티켓을 생성한다."
      toolautosubmit>
  <input name="bookingId"
         toolparamdescription="대상 예약 ID (예: BKG-2002)" required />
  <textarea name="body"
            toolparamdescription="문의 내용 본문" required></textarea>
  <button type="submit">티켓 생성</button>
</form>
```

- `toolname` — 에이전트가 호출할 도구의 고유 이름
- `tooldescription` — 도구의 기능과 사용 시점을 설명하는 문장
- `toolparamdescription` — 각 컨트롤이 만드는 인자의 의미와 허용 형식
- `toolautosubmit` — 에이전트가 채운 뒤 자동 제출할지 결정하는 불리언 속성. 생략하면
  브라우저가 제출 버튼에 초점을 옮기고 사람의 확인을 기다린다.
- 표준 HTML의 `name` / `type` / `required` — 인자명·입력 타입·필수 여부를 결정한다.

브라우저가 `name`/`type`/`required`/`toolparamdescription`을 읽어 입력 스키마를
**합성**한다. 검증·제출 로직이 이미 폼에 있다면 공짜로 얻는 셈이다.

에이전트 호출과 사람 클릭은 같은 `submit` 핸들러를 지난다. `e.agentInvoked`가
`true`이면 에이전트가 제출한 경우이며, 이때 `e.respondWith()`로 처리 결과를
에이전트에게 반환한다.

> 현재 선언형 API 초안의 속성명은 하이픈 없이 `toolname`, `tooldescription`,
> `toolautosubmit`으로 쓴다. 초기 제안에 기반한 자료에는 다른 표기가 남아 있을 수 있다.

```js
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const result = createTicket(new FormData(e.target));
  if (e.agentInvoked) {
    // 에이전트에게 돌려줄 결과 (Promise 가능)
    e.respondWith(Promise.resolve({ content: [{ type: 'text', text: result }] }));
  }
});
```

### 상태 공유

화면을 열 때 `AbortSignal`과 함께 도구를 등록하고 닫을 때 `abort()`를 호출하면 도구
목록이 현재 화면 상태와 일치한다. 이 시뮬레이션에서는 **예약 상세 화면을 열었을 때만
`add_booking_note` 도구가 등록**되고, 상세 화면을 닫으면 해제된다.

---

## 3. 실행 조건과 제약

| 항목 | 내용 |
|---|---|
| Chrome 버전 | 149+ (오리진 트라이얼), 로컬은 `chrome://flags/#enable-webmcp-testing` |
| DevTools 패널 | `chrome://flags/#devtools-webmcp-support` — API 동작엔 불필요하지만 검증에는 사실상 필수 (§4 참고) |
| 보안 컨텍스트 | HTTPS 또는 `localhost` |
| 오리진 격리 | `Origin-Agent-Cluster: ?0` 헤더가 있으면 API 비활성 |
| 교차 오리진 iframe | `<iframe allow="tools">` 필요. 없으면 `NotAllowedError` |
| 헤드리스 | **불가.** 탭 또는 웹뷰가 실제로 열려 있어야 한다 |
| 발견 가능성 | 에이전트가 사이트를 **직접 방문해야** 도구가 있는지 안다. 중앙 레지스트리 없음 |

**주의사항:** WebMCP는 백엔드 API의 대체재가 아니라
**"사용자가 이미 열어 둔 탭에서, 사용자의 세션으로, 사용자가 볼 수 있게"** 작업을
수행하는 수단이다.

---

## 4. 이 데모 (`app/`)

### 실행

```bash
npm start          # http://localhost:4173
```

플래그를 켜지 않아도 페이지는 뜬다. 화면 우상단 배지가 지금 어느 모드인지 알려준다.

- 🟢 **네이티브 WebMCP · document.modelContext** — 플래그가 켜져 브라우저 구현이 잡힘
- 🟡 **폴백 shim** — 네이티브가 없어 페이지 내부 shim으로 동작 중

shim은 **네이티브가 없을 때만** 설치된다(`app/js/webmcp.js`). 이게 중요한 이유:
항상 동작하는 shim은 데모를 통과시키되 WebMCP에 대해서는 아무것도 증명하지 못한다.

### 배포 (Vercel)

빌드가 없는 정적 사이트다. 저장소를 연결하면 그대로 뜬다 — `vercel.json`이
`outputDirectory: "app"`을 지정한다. 별도 프레임워크 설정은 필요 없다.

배포해도 **페이지와 시뮬레이터는 전부 동작한다.** shim 경로는 순수 JS라 환경을
타지 않는다. 갈리는 건 네이티브 WebMCP 활성화 여부다:

| 방문자 | 결과 |
|---|---|
| `chrome://flags/#enable-webmcp-testing`를 켠 Chrome 149+ | 🟢 네이티브. 플래그는 브라우저 설정이라 도메인을 가리지 않는다 |
| 플래그를 안 켠 일반 방문자 | 🟡 shim. 네이티브를 켜려면 오리진 트라이얼 토큰이 필요하다 |

**오리진 트라이얼 토큰**은 [developer.chrome.com/origintrials](https://developer.chrome.com/origintrials)에서
배포 도메인으로 발급받아 `app/index.html` 상단의 주석 처리된
`<meta http-equiv="origin-trial">`에 넣으면 된다.

> 토큰은 **오리진마다** 발급된다. Vercel 프리뷰 URL은 배포마다 해시가 바뀌므로
> 토큰이 맞지 않는다. 고정된 프로덕션 도메인에만 적용하라.

그 외 배포 환경에서 확인할 것:

- **HTTPS** — Vercel이 기본 제공하므로 보안 컨텍스트 조건은 충족된다
- **`Origin-Agent-Cluster: ?0`을 보내지 않을 것** — 이 헤더가 붙으면 API가 꺼진다.
  Vercel은 기본으로 붙이지 않으며, `vercel.json`에서도 설정하지 않았다
- **헤드리스 불가는 그대로** — 배포하든 로컬이든 탭이 열려 있어야 도구가 산다

### 화면 구성

탭 두 개다.

**1 · 개념** — 이 README의 앞부분을 읽는 형태로 옮긴 문서. 각 절 끝에 시뮬레이션의
해당 부분으로 바로 가는 딥링크가 붙어 있다 (`data-goto`).

**2 · 시뮬레이션** — 고객이 호텔을 검색·예약하는 화면이 아니라 여행사 운영자가
접수된 예약, 객실 재고, 문의를 처리하는 관리 콘솔이다. 왼쪽은 운영 화면, 오른쪽은
에이전트 쪽(시나리오 스테퍼, 수동 호출, 로그)이다. 시뮬레이션의 각 블록에는 개념
탭의 해당 절로 돌아가는 역방향 링크가 있다.

두 탭은 **같은 컴포넌트와 같은 타입 스케일**을 쓴다 (`.card`, `.code`, `.chip`,
`.result`, `.callout`). 개념 탭의 비교 도식과 스테퍼 카드가 같은 카드 크롬을
공유하는 식이다 — 탭으로 갈라 놓아도 한 제품으로 읽히게 하기 위해서다.

시뮬레이터는 등록된 도구 목록을 읽고, 인자 JSON을 만들어 호출하고, 결과를 본다.
호출되는 `execute()`는 진짜 에이전트가 부르는 것과 **완전히 같은 함수**다.

딥링크 / 진입 파라미터:

| | |
|---|---|
| `#sim`, `?tab=sim` | 시뮬레이션 탭으로 진입 |
| `?autostep=N` | 시뮬 탭에서 N단계까지 자동 진행 (시연·검증용) |

승인 게이트가 열리면 개념 탭을 읽는 중이어도 **자동으로 시뮬 탭으로 전환**된다.
안 보이는 탭에서 Promise만 매달려 있으면 멈춘 것처럼 보이기 때문이다. 같은 이유로
탭을 떠나면 자동 재생은 정지한다.

> 표준에는 "내가 등록한 도구 목록"을 되읽는 API가 없다(등록한 건 페이지 자신이니까).
> 그래서 `webmcp.js`가 등록 시점에 서술자를 로컬 배열에 미러링해 두고, 시뮬레이터가
> 그걸 읽는다.

### 노출한 도구

| 도구 | 성격 |
|---|---|
| `list_bookings` | 읽기 전용 |
| `get_booking` | 읽기 전용 |
| `check_availability` | 읽기 전용 |
| `assign_rooms` | 변경 · **잔여 객실 부족 시 실패하고 이유를 설명** |
| `open_room_block` | 변경 · 호텔에서 객실을 추가 확보 |
| `advance_booking_status` | 변경 |
| `cancel_booking` | **파괴적 · 사람 승인 필수** (취소 + 환불) |
| `add_booking_note` | 예약 상세가 열려 있을 때만 존재 |
| `create_support_ticket_via_form` | 선언형 폼에 대응하는 명령형 버전 |

### 운영 시나리오 스테퍼

에이전트의 **관찰 → 판단 → 행동** 루프를 한 번에 한 수씩 보여준다. 기본은
**"다음 단계" 수동 진행**이고, 자동 재생은 선택이다 (로그가 주르륵 흐르면 인과가
안 보이기 때문이다). 각 단계 카드는 세 부분으로 나뉜다:

```
① 에이전트의 판단   왜 이 도구를 골랐는가
② 도구 호출        assign_rooms({"bookingId":"BKG-2002"})
③ 결과             잔여 객실 부족으로 배정 실패. BUSAN-CITY: 필요 1실, 잔여 0실
```

그리고 호출이 끝나면 **왼쪽 표에서 그 도구가 건드린 행에 불이 들어온다.**
도구 호출이 화면 밖의 추상적 이벤트가 아니라 실제 상태를 바꾸는 조작임을
눈으로 잇기 위한 장치다.

흐름:

1. `list_bookings({status:'requested'})` — 요청 접수 상태인 예약 2건을 조회한다
2. `assign_rooms(BKG-2001)` — 제주 2실은 재고가 충분하므로 성공한다
3. `assign_rooms(BKG-2002)` — 부산 1실이 부족해 실패한다
4. `check_availability({roomCode:'BUSAN-CITY'})` — 다른 도시를 제외하고 부산 재고만 확인한다
5. `open_room_block({roomCode:'BUSAN-CITY', qty:1})` — 호텔에 부산 판매 블록 1실만 추가 요청한다
6. `assign_rooms(BKG-2002)` 재시도 → 성공
7. 요청 범위인 객실 확정까지만 처리하고 종료한다

제주와 부산은 서로 다른 예약이다. 제주 예약은 기존 재고로 배정하며 객실 블록을
추가하지 않는다. 부산은 같은 투숙 기간의 `BKG-2004`가 기존 2실을 사용하고 있어
잔여가 없다. 부산 예약이 실패했을 때만 *"필요 1실, 잔여 0실.
open_room_block으로 객실을 추가 확보한 뒤 다시 시도하라"*는 결과를 받고,
동일한 `BUSAN-CITY` 블록을 1실 확보한다.

> 구현 주의: `scenario.js`는 단계 배열이 아니라 **async generator**다. 본문은
> `next()`가 불릴 때마다 그 시점의 실제 `state`를 읽고 다음 수를 정한다. 단계를
> 미리 계산해 두면 화면은 똑같아 보여도 "예상 못 한 실패에 반응한다"는 이 데모의
> 핵심이 연출이 되어 버린다.

`?autostep=3` 같은 쿼리 파라미터로 N단계까지 자동 진행한 상태를 바로 띄울 수 있다
(시연용이자, 헤드리스 스크린샷으로 UI를 검증하는 수단).

### `:tool-form-active`

에이전트가 선언형 폼을 조작하는 동안 브라우저가 폼에 붙여 주는 의사 클래스다
(제출 버튼에는 `:tool-submit-active`). 이 데모는 그 동안 폼 테두리가 시안색으로
맥동하게 스타일링했고, shim 모드에서는 동등한 `.tool-form-active` 클래스를 직접
토글해 같은 UX를 보여준다. CSS는 `:is()`로 묶어 두었으므로 의사 클래스를 모르는
브라우저에서도 규칙 전체가 무효화되지 않는다.

### 시뮬레이터가 증명하는 것 / 못 하는 것

**시뮬레이터의 호출 경로는 실제 에이전트의 경로가 아니다.** 미러에 보관한 서술자의
`execute`를 페이지가 직접 부른다 — 즉 **에이전트 → 브라우저 → 페이지** 홉을 건너뛴다.
페이지가 자기 도구를 브라우저를 거쳐 되부르는 API가 없기 때문이다.

따라서 네이티브 모드에서 시뮬레이터가 잘 돈다고 해서 *브라우저가* 도구를 인식했다는
증거는 되지 않는다. 배지가 🟢여도 브라우저가 등록을 무시했을 가능성은 남는다.
같은 내용이 시뮬 탭의 **"이 시뮬레이터가 증명하는 것 / 못 하는 것"** 블록에도
표시되며, 거기서 도구별 등록 성공/거부 결과(`registrationReport()`)를 볼 수 있다.

| 확인 대상 | 시뮬레이터 | DevTools WebMCP 패널 |
|---|---|---|
| `execute` 로직이 맞는가 | ✅ | — |
| `registerTool`이 예외 없이 통과했는가 | ✅ | — |
| **브라우저가 도구를 열거하는가** | ❌ | ✅ |
| **선언형 폼이 도구로 합성됐는가** | ❌ | ✅ |
| 브라우저 경로로 실제 호출되는가 | ❌ | ✅ |

즉 `chrome://flags/#devtools-webmcp-support`는 API 동작에는 필요 없지만,
**엔드투엔드 검증에는 사실상 필수**다. 켜고 DevTools의 WebMCP 패널에서
명령형 도구 7개(예약 상세를 열면 `add_booking_note`가 붙어 8개, 폼 대응물까지 9개) +
선언형 `create_support_ticket`이 보이는지 확인하라.

콘솔에서 빠르게 확인하려면:

```js
JSON.stringify({
  onDoc: 'modelContext' in document,
  onNav: 'modelContext' in navigator,
  keys: Object.getOwnPropertyNames(
    Object.getPrototypeOf(document.modelContext ?? navigator.modelContext ?? {})),
})
```

### 승인 게이트

`cancel_booking`을 직접 호출해 보면, `execute()`가 화면에 승인 카드를 띄우고
사람이 버튼을 누를 때까지 **Promise를 pending 상태로 붙잡는다**. 거부하면
아무것도 바꾸지 않고 그 사실을 문자열로 보고한다. 되돌릴 수 없는 작업을 다루는
기본 패턴이다.

---

## 5. 도구를 설계할 때의 원칙

1. **도구 설계 단위는 사용자가 UI에서 완료하는 작업 하나다.** DB CRUD를 그대로
   노출한 `update_row`보다 업무 결과를 나타내는 `assign_rooms`가 적합하다.
2. **description에는 기능과 사용 조건을 적는다.** 실행할 수 없는 조건도 짧고 명확하게
   설명한다.
3. **업무 실패 결과에는 원인과 후속 조치를 포함한다.** 에이전트가 다음 도구를 선택할 수
   있는 정보를 반환한다.
4. **현재 지원되는 annotations를 정확히 사용한다.** 조회 도구에는 `readOnlyHint`,
   외부·사용자 콘텐츠를 반환하는 도구에는 `untrustedContentHint`를 지정한다.
5. **위험한 작업은 실행 함수 안에서 사람 승인을 통과시킨다.** 현재 초안에는 파괴적
   작업 전용 annotation이 없으므로 사이트가 승인 UI와 대기 Promise를 구현한다.
6. **화면 상태에 따라 도구를 등록하고 해제한다.** AbortController로 붙였다 떼면,
   에이전트에게 보이는 도구 목록이 곧 현재 가능한 일이 된다.

---

## 6. 파일

```
app/
  index.html          1부 개념 리더 + 2부 운영 콘솔/시뮬레이터
  styles.css
  js/
    webmcp.js         어댑터: 탐지 · shim · 등록 래퍼 · 미러 · 결과 정규화
    store.js          운영 도메인 상태 + 승인 게이트 + 리셋
    tools.js          WebMCP 도구 정의 (여기가 본체)
    scenario.js       에이전트 루프 (async generator, 지연 평가)
    main.js           렌더링 · 스테퍼 드라이버 · 수동 호출
README.md
```

읽는 순서는 `tools.js` → `scenario.js` → `webmcp.js` → `main.js`를 권한다.
