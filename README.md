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
  name: 'allocate_stock',
  description: '주문에 재고를 할당한다. 재고가 모자라면 부족분을 보고한다.',
  inputSchema: {
    type: 'object',
    properties: { orderId: { type: 'string' } },
    required: ['orderId'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  async execute({ orderId }) {
    // ... 실제 앱 로직 — UI 버튼이 부르는 그 함수를 그대로 부른다
    return { content: [{ type: 'text', text: `${orderId} 할당 완료` }] };
  },
}, { signal: controller.signal });

controller.abort(); // 등록 해제
```

핵심 조각:

- **`name`** — 에이전트가 부르는 식별자. 동사_명사 형태로.
- **`description`** — 이게 사실상 프롬프트다. *언제* 이 도구를 쓰는지, 실패하면
  어떻게 되는지까지 적어야 에이전트가 제대로 판단한다.
- **`inputSchema`** — JSON Schema. 에이전트가 인자를 지어내지 않게 하는 계약.
- **`annotations`** — `readOnlyHint`(부작용 없음), `destructiveHint`(되돌릴 수 없음),
  `idempotentHint`. 에이전트가 "이건 막 불러도 되는가"를 판단하는 근거.
- **`execute`** — 동기/비동기 모두 가능. 반환은 `{content:[{type:'text',text}]}` 형태가
  표준이고, 구현에 따라 평범한 값도 받는다.
- **`{ signal }`** — 등록 해제는 `unregisterTool()`이 아니라 **AbortController**로 한다.
  화면이 바뀌면 도구도 같이 사라지는 게 자연스럽다.

> ⚠️ 네임스페이스는 사양 진행 중 바뀌었다. 문서마다 `document.modelContext` /
> `navigator.modelContext`가 섞여 있으니 **양쪽 다 확인하는 feature detection**을 써라.
> 이 저장소의 `app/js/webmcp.js`가 그렇게 되어 있다.

### 선언형 (Declarative) — HTML만으로

이미 폼이 있는 사이트라면 JS를 한 줄도 안 쓰고 도구를 만들 수 있다.

```html
<form toolname="create_support_ticket"
      tooldescription="고객 문의 티켓을 생성한다."
      toolautosubmit>
  <input name="orderId"
         toolparamdescription="대상 주문 ID (예: ORD-1002)" required />
  <textarea name="body"
            toolparamdescription="문의 내용 본문" required></textarea>
  <button type="submit">티켓 생성</button>
</form>
```

- `toolname` / `tooldescription` — 폼 자체를 도구로 만든다
- `toolparamdescription` — 각 컨트롤의 인자 설명
- `toolautosubmit` — 에이전트가 채운 뒤 자동 제출할지 (없으면 사람이 눌러야 한다)

브라우저가 `name`/`type`/`required`/`toolparamdescription`을 읽어 입력 스키마를
**합성**한다. 검증·제출 로직이 이미 폼에 있다면 공짜로 얻는 셈이다.

에이전트 호출과 사람 클릭은 같은 `submit` 핸들러를 지나므로, `SubmitEvent`에 추가된
두 멤버로 구분하고 응답한다:

> 인터넷의 예제 중 `tool-name` / `tool-description` / `autosubmit` 처럼 하이픈을 넣은
> 것이 많은데 **틀렸다.** 사양의 속성명에는 하이픈이 없다.

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

도구 목록 자체가 상태를 표현한다. 로그인 전에는 `login` 도구만, 로그인 후에는
`list_orders`가 나타나는 식. 이 데모에서는 **주문 상세 화면을 열었을 때만
`add_order_note` 도구가 등록**되도록 해서 이 패턴을 보여준다.

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

마지막 두 개가 실무에서 제일 중요하다. WebMCP는 백엔드 API의 대체재가 아니라
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

### 화면 구성

탭 두 개다.

**1 · 개념** — 이 README의 앞부분을 읽는 형태로 옮긴 문서. 각 절 끝에 시뮬레이션의
해당 부분으로 바로 가는 딥링크가 붙어 있다 (`data-goto`).

**2 · 시뮬레이션** — 왼쪽은 사람이 쓰는 운영 화면(주문/재고/문의 폼), 오른쪽은
에이전트 쪽(시나리오 스테퍼, 수동 호출, 로그). 시뮬레이션의 각 블록에는 개념
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
| `list_orders` | 읽기 전용 |
| `get_order` | 읽기 전용 |
| `check_inventory` | 읽기 전용 |
| `allocate_stock` | 변경 · **재고 부족 시 실패하고 이유를 설명** |
| `restock_item` | 변경 |
| `advance_order_status` | 변경 |
| `issue_refund` | **파괴적 · 사람 승인 필수** |
| `add_order_note` | 주문 상세가 열려 있을 때만 존재 |
| `create_support_ticket_via_form` | 선언형 폼에 대응하는 명령형 버전 |

### 운영 시나리오 스테퍼

에이전트의 **관찰 → 판단 → 행동** 루프를 한 번에 한 수씩 보여준다. 기본은
**"다음 단계" 수동 진행**이고, 자동 재생은 선택이다 (로그가 주르륵 흐르면 인과가
안 보이기 때문이다). 각 단계 카드는 세 부분으로 나뉜다:

```
① 에이전트의 판단   왜 이 도구를 골랐는가
② 도구 호출        allocate_stock({"orderId":"ORD-1002"})
③ 결과             재고 부족으로 할당 실패. TRV-MUG: 필요 3, 가용 0 …
```

그리고 호출이 끝나면 **왼쪽 표에서 그 도구가 건드린 행에 불이 들어온다.**
도구 호출이 화면 밖의 추상적 이벤트가 아니라 실제 상태를 바꾸는 조작임을
눈으로 잇기 위한 장치다.

흐름:

1. `list_orders({status:'pending'})` — 뭐가 밀렸는지 본다
2. `allocate_stock(ORD-1001)` — 성공
3. `allocate_stock(ORD-1002)` — **실패한다** (TRV-TEE·TRV-MUG 가용 0) ← 카드가 붉게 승격
4. `check_inventory` → `restock_item`으로 부족분만 입고
5. `allocate_stock` 재시도 → 성공
6. `advance_order_status`로 출고 처리
7. 환불은 **자동으로 하지 않는다** — 파괴적 작업이므로

여기서 봐야 할 것은 3번이다. 도구가 예외를 던지는 대신 *"필요 3, 가용 0. restock_item으로
입고한 뒤 다시 시도하라"* 는 문장을 돌려주기 때문에 에이전트가 스스로 복구할 수 있다.
**도구의 에러 메시지는 사람이 아니라 에이전트를 위한 다음 지시문이다.**

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

솔직하게 짚고 넘어갈 것: 시뮬레이터는 **미러에 보관한 서술자의 `execute`를 직접 부른다.**
따라서 네이티브 모드에서 시뮬레이터가 잘 돈다고 해서 *브라우저가* 도구를 인식했다는
증거는 되지 않는다. 배지가 🟢여도 브라우저가 등록을 무시했을 가능성은 남는다.

| 확인 대상 | 시뮬레이터 | DevTools WebMCP 패널 |
|---|---|---|
| `execute` 로직이 맞는가 | ✅ | — |
| `registerTool`이 예외 없이 통과했는가 | ✅ | — |
| **브라우저가 도구를 열거하는가** | ❌ | ✅ |
| **선언형 폼이 도구로 합성됐는가** | ❌ | ✅ |
| 브라우저 경로로 실제 호출되는가 | ❌ | ✅ |

즉 `chrome://flags/#devtools-webmcp-support`는 API 동작에는 필요 없지만,
**엔드투엔드 검증에는 사실상 필수**다. 켜고 DevTools의 WebMCP 패널에서
명령형 도구 8개(주문 상세를 열면 `add_order_note`가 붙어 9개) +
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

`issue_refund`를 직접 호출해 보면, `execute()`가 화면에 승인 카드를 띄우고
사람이 버튼을 누를 때까지 **Promise를 pending 상태로 붙잡는다**. 거부하면
아무것도 바꾸지 않고 그 사실을 문자열로 보고한다. 되돌릴 수 없는 작업을 다루는
기본 패턴이다.

---

## 5. 도구를 설계할 때의 원칙

1. **도구 하나 = 사용자가 UI에서 하는 의미 있는 작업 하나.** DB CRUD를 그대로
   노출하지 마라. `update_row`가 아니라 `allocate_stock`이다.
2. **description은 프롬프트다.** 무엇을 하는지만이 아니라 *언제 쓰는지*, 실패하면
   무엇을 해야 하는지를 적어라.
3. **실패는 예외가 아니라 설명이다.** throw 하면 에이전트는 막힌다. 문장으로 돌려주면
   복구한다.
4. **annotations를 채워라.** `readOnlyHint`가 붙은 도구는 에이전트가 자유롭게 탐색할 수
   있다. `destructiveHint`는 멈추게 만든다.
5. **위험한 작업은 사람 승인을 통과시켜라.** 페이지가 열려 있다는 게 WebMCP의 제약이자
   장점이다 — 사람이 화면 앞에 있다.
6. **도구 생명주기를 화면 상태에 묶어라.** AbortController로 붙였다 떼면, 에이전트에게
   보이는 도구 목록이 곧 "지금 가능한 일"이 된다.

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
