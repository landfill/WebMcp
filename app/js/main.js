import {
  runtime,
  onToolsChanged,
  listTools,
  callTool,
  registerTool,
  textResult,
} from './webmcp.js';
import {
  state,
  subscribe,
  commit,
  resolveApproval,
  resetState,
  findOrder,
} from './store.js';
import { registerAllTools, syncContextualTools } from './tools.js';
import { scenario } from './scenario.js';

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// 런타임 배지 — shim 이 네이티브를 가리지 않았음을 항상 보이게 한다
// ---------------------------------------------------------------------------

const badge = $('#runtime-badge');
badge.className = `badge ${runtime.mode}`;
badge.textContent =
  runtime.mode === 'native'
    ? `네이티브 WebMCP · ${runtime.namespace}`
    : '폴백 shim · 네이티브 WebMCP 없음 (chrome://flags/#enable-webmcp-testing)';
badge.title = `사용 가능한 메서드: ${runtime.methods.join(', ') || '(없음)'}`;
console.log('[WebMCP] runtime =', runtime);

// ---------------------------------------------------------------------------
// 운영 화면 렌더링
// ---------------------------------------------------------------------------

function statusChip(s) {
  return `<span class="status status-${s}">${s}</span>`;
}

function renderOrders(s) {
  $('#orders tbody').innerHTML = s.orders
    .map(
      (o) => `<tr data-id="${o.id}">
        <td>${o.id}${o.refunded ? ' ↩︎' : ''}</td>
        <td>${o.customer}</td>
        <td>${o.items.map((i) => `${i.sku}×${i.qty}`).join(', ')}</td>
        <td>${statusChip(o.status)}</td>
        <td><button class="link" data-open="${o.id}">열기</button></td>
      </tr>`,
    )
    .join('');
}

function renderInventory(s) {
  $('#inventory tbody').innerHTML = s.inventory
    .map((i) => {
      const avail = i.onHand - i.reserved;
      return `<tr>
        <td><code>${i.sku}</code></td>
        <td>${i.name}</td>
        <td>${i.onHand}</td>
        <td>${i.reserved}</td>
        <td class="${avail <= 0 ? 'zero' : ''}">${avail}</td>
      </tr>`;
    })
    .join('');
}

function renderDetail(s) {
  const box = $('#order-detail');
  const order = s.selectedOrderId ? findOrder(s.selectedOrderId) : null;
  box.hidden = !order;
  if (order) {
    $('#detail-id').textContent = order.id;
    $('#detail-note').textContent = order.note || '(메모 없음)';
  }
}

function renderApprovals(s) {
  $('#approvals').innerHTML = s.approvals
    .map(
      (a) => `<div class="approval">
        <div class="t">승인 필요 — ${a.summary}</div>
        <div class="d">${a.detail}</div>
        <button class="approve" data-approve="${a.id}">승인</button>
        <button class="reject" data-reject="${a.id}">거부</button>
      </div>`,
    )
    .join('');
}

function renderAudit(s) {
  $('#audit').innerHTML = s.audit
    .map((a) => `<li><span class="muted">${a.at}</span> · ${a.reason}</li>`)
    .join('');
}

subscribe((s) => {
  renderOrders(s);
  renderInventory(s);
  renderDetail(s);
  renderApprovals(s);
  renderAudit(s);
});

// ---------------------------------------------------------------------------
// 상호작용
// ---------------------------------------------------------------------------

document.addEventListener('click', (e) => {
  const open = e.target.dataset?.open;
  if (open) {
    commit(`주문 상세 열기 ${open}`, (s) => {
      s.selectedOrderId = open;
    });
    syncContextualTools();
  }
  const ap = e.target.dataset?.approve;
  if (ap) resolveApproval(ap, true);
  const rj = e.target.dataset?.reject;
  if (rj) resolveApproval(rj, false);
});

$('#close-detail').addEventListener('click', () => {
  commit('주문 상세 닫기', (s) => {
    s.selectedOrderId = null;
  });
  syncContextualTools();
});

// 선언형 폼.
// 명령형 대응 도구가 폼을 몰 때 켜지는 플래그 (네이티브에서는 e.agentInvoked 가 대신한다)
let agentDrivingForm = false;

// 사람이 눌러도, 에이전트가 도구로 호출해도 같은 submit 핸들러를 지난다.
// SubmitEvent.agentInvoked 로 둘을 구분하고, 에이전트에게 돌려줄 결과는
// respondWith() 로 넘긴다 (지원하지 않는 브라우저에서는 그냥 무시된다).
$('#ticket-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const orderId = fd.get('orderId');
  const body = fd.get('body');
  const byAgent = e.agentInvoked === true || agentDrivingForm;

  addTicket(orderId, body, byAgent);
  e.target.reset();

  if (byAgent && typeof e.respondWith === 'function') {
    e.respondWith(
      Promise.resolve(textResult(`티켓 생성됨: ${orderId} — ${body}`)),
    );
  }
});

function addTicket(orderId, body, byAgent = false) {
  const li = document.createElement('li');
  li.textContent =
    `[${new Date().toLocaleTimeString('ko-KR')}]` +
    `${byAgent ? ' 🤖' : ''} ${orderId} — ${body}`;
  $('#tickets').prepend(li);
  commit(`문의 티켓 생성 (${orderId})${byAgent ? ' — 에이전트' : ''}`, () => {});
}

// ---------------------------------------------------------------------------
// 에이전트 시뮬레이터
// ---------------------------------------------------------------------------

const logBox = $('#agent-log');

function log(kind, html) {
  const el = document.createElement('div');
  el.className = 'entry';
  el.innerHTML = `<div class="${kind}">${html}</div>`;
  logBox.prepend(el);
  return el;
}

function logCall(name, args, result, ms) {
  log(
    'call',
    `→ <b>${name}</b>(${JSON.stringify(args)}) <span class="think">${ms}ms</span>` +
      `<pre>${escapeHtml(result)}</pre>`,
  );
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c],
  );
}

const select = $('#tool-select');

onToolsChanged((tools) => {
  const prev = select.value;
  select.innerHTML = tools
    .map((t) => `<option value="${t.name}">${t.name}</option>`)
    .join('');
  const kept = tools.some((t) => t.name === prev);
  if (kept) select.value = prev;
  showToolDesc();
  if (!kept) fillSampleArgs(); // 선택이 바뀐 경우에만 인자 칸을 다시 채운다
});

function showToolDesc() {
  const tool = listTools().find((t) => t.name === select.value);
  if (!tool) {
    $('#tool-desc').textContent = '';
    return;
  }
  const ro = tool.annotations?.readOnlyHint ? ' · 읽기 전용' : '';
  const de = tool.annotations?.destructiveHint ? ' · ⚠ 파괴적' : '';
  $('#tool-desc').innerHTML =
    `<b>${tool.name}</b>${ro}${de}<br>${escapeHtml(tool.description)}` +
    `<br><span class="think">입력: ${escapeHtml(
      JSON.stringify(tool.inputSchema?.properties ?? {}),
    )}</span>`;
}

/** 필수 인자 자리표시자를 채운다. 도구를 "바꿨을 때"만 — 입력 중인 값을 지우지 않는다. */
function fillSampleArgs() {
  const tool = listTools().find((t) => t.name === select.value);
  if (!tool) return;
  const props = tool.inputSchema?.properties ?? {};
  const required = tool.inputSchema?.required ?? [];
  const sample = {};
  for (const key of required)
    sample[key] = props[key]?.type === 'number' ? 0 : '';
  $('#tool-args').value = JSON.stringify(sample, null, 2);
}

select.addEventListener('change', () => {
  showToolDesc();
  fillSampleArgs();
});

$('#run-tool').addEventListener('click', async () => {
  let args;
  try {
    args = JSON.parse($('#tool-args').value || '{}');
  } catch {
    log('err', '인자 JSON 파싱 실패');
    return;
  }
  await invoke(select.value, args);
});

$('#clear-log').addEventListener('click', () => (logBox.innerHTML = ''));

async function invoke(name, args) {
  try {
    const r = await callTool(name, args);
    logCall(name, args, r.result, r.ms);
    return r.result;
  } catch (err) {
    log('err', `✗ ${name} 실패: ${escapeHtml(err.message)}`);
    return `ERROR: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// 운영 시나리오 스테퍼
//
// 한 번에 한 수씩. 카드는 세 부분으로 나뉜다:
//   ① 왜 이 도구를 골랐나  ② 무엇을 호출했나  ③ 무슨 결과가 왔나
// 그리고 결과가 나오면 왼쪽 표의 "그 도구가 건드린 행"에 불이 들어온다.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let iterator = null;
let lastResult = undefined;
let stepNo = 0;
let busy = false;
let autoTimer = null;

const KIND_LABEL = {
  observe: { text: '관찰', cls: 'k-observe' },
  act: { text: '행동', cls: 'k-act' },
  fail: { text: '실패 → 복구 판단', cls: 'k-fail' },
  recover: { text: '복구', cls: 'k-recover' },
  done: { text: '완료', cls: 'k-done' },
};

function setStepCard(html, extraClass = '') {
  const card = $('#step-card');
  card.className = `step-card ${extraClass}`;
  card.innerHTML = html;
}

/** 왼쪽 표에서 이번 호출이 건드린 행에 불을 켠다. */
function highlight(focus) {
  document
    .querySelectorAll('.grid tr.flash')
    .forEach((tr) => tr.classList.remove('flash'));
  if (!focus) return;

  const ids = new Set(focus.orders ?? []);
  if (focus.status)
    for (const o of state.orders)
      if (o.status === focus.status) ids.add(o.id);

  for (const id of ids)
    $(`#orders tbody tr[data-id="${id}"]`)?.classList.add('flash');

  for (const sku of focus.skus ?? []) {
    const row = [...document.querySelectorAll('#inventory tbody tr')].find(
      (tr) => tr.textContent.includes(sku),
    );
    row?.classList.add('flash');
  }
}

async function nextStep() {
  if (busy) return;
  busy = true;
  $('#step-next').disabled = true;

  try {
    iterator ??= scenario();
    const { value: step, done } = await iterator.next(lastResult);

    if (done || !step) {
      finishScenario();
      return;
    }

    stepNo += 1;
    $('#step-count').textContent = `단계 ${stepNo}`;
    const meta = KIND_LABEL[step.kind] ?? KIND_LABEL.act;

    // ① 판단 ② 호출 — 결과 자리는 비워 두고 먼저 보여준다
    setStepCard(
      `<div class="step-kind ${meta.cls}">${meta.text}</div>
       <div class="step-block">
         <div class="step-label">① 에이전트의 판단</div>
         <p class="step-why">${escapeHtml(step.why)}</p>
       </div>` +
        (step.tool
          ? `<div class="step-block">
               <div class="step-label">② 도구 호출</div>
               <div class="step-call"><b>${step.tool}</b>(<span>${escapeHtml(
                 JSON.stringify(step.args ?? {}),
               )}</span>)</div>
             </div>
             <div class="step-block" id="step-result-block">
               <div class="step-label">③ 결과</div>
               <div class="step-pending">실행 중…</div>
             </div>`
          : ''),
      meta.cls,
    );

    if (!step.tool) {
      lastResult = undefined;
      if (step.kind === 'done') finishScenario(false);
      return;
    }

    highlight(step.focus);
    await sleep(320); // 판단 → 호출의 인과를 눈으로 따라갈 수 있게

    const result = await invoke(step.tool, step.args ?? {});
    lastResult = result;

    const failed = String(result).includes('재고 부족');
    // 실패는 이 데모의 핵심 장면이다 — 카드 전체를 실패 색으로 승격시킨다
    if (failed) {
      $('#step-card').classList.remove(meta.cls);
      $('#step-card').classList.add('k-fail');
      $('#step-card .step-kind').className = 'step-kind k-fail';
      $('#step-card .step-kind').textContent = '행동 → 실패';
    }
    $('#step-result-block').innerHTML =
      `<div class="step-label">③ 결과</div>` +
      `<pre class="step-result ${failed ? 'bad' : ''}">${escapeHtml(result)}</pre>` +
      (failed
        ? `<p class="step-teach">↑ 예외를 던졌다면 여기서 끝났다.
             문장으로 돌려줬기 때문에 에이전트가 다음 수를 정할 수 있다.</p>`
        : '');
    highlight(step.focus);
  } finally {
    busy = false;
    $('#step-next').disabled = false;
  }
}

function finishScenario(clearCard = true) {
  stopAuto();
  $('#step-next').disabled = true;
  $('#step-count').textContent = `완료 · ${stepNo}단계`;
  if (clearCard) setStepCard('<p class="step-empty">시나리오가 끝났다.</p>');
}

function resetScenario() {
  stopAuto();
  iterator = null;
  lastResult = undefined;
  stepNo = 0;
  busy = false;
  resetState();
  highlight(null);
  $('#step-next').disabled = false;
  $('#step-count').textContent = '준비됨';
  setStepCard(
    `<p class="step-empty"><b>다음 단계</b>를 눌러 에이전트의 한 수를 진행하세요.</p>`,
    'empty',
  );
}

function stopAuto() {
  clearInterval(autoTimer);
  autoTimer = null;
  $('#step-auto').textContent = '자동 재생';
  $('#step-auto').classList.remove('on');
}

$('#step-next').addEventListener('click', nextStep);
$('#step-reset').addEventListener('click', resetScenario);
$('#step-auto').addEventListener('click', () => {
  if (autoTimer) return stopAuto();
  $('#step-auto').textContent = '■ 정지';
  $('#step-auto').classList.add('on');
  autoTimer = setInterval(nextStep, 2600);
  nextStep();
});

// ---------------------------------------------------------------------------
// 부팅
// ---------------------------------------------------------------------------

await registerAllTools();

// 선언형 폼의 대응 도구.
// 네이티브 브라우저는 <form tool> 을 읽어 자체 레지스트리에 도구를 합성하는데,
// 그 도구는 페이지에서 열람할 수 없다(브라우저가 소유). 시뮬레이터에서 같은
// 동작을 보이기 위해, 폼을 채우고 제출하는 명령형 대응물을 따로 등록한다.
await registerTool({
  name: 'create_support_ticket_via_form',
  description:
    '문의 티켓 폼을 채워 제출한다. 선언형 <form toolname="create_support_ticket"> 을 ' +
    '브라우저가 도구로 합성해 호출할 때와 동일한 경로를 탄다.',
  inputSchema: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['orderId', 'body'],
  },
  async execute({ orderId, body }) {
    const form = $('#ticket-form');

    // 네이티브라면 브라우저가 :tool-form-active 를 알아서 붙인다.
    // shim 모드에서는 같은 UX 를 보여주기 위해 동등한 클래스를 직접 토글한다.
    agentDrivingForm = true;
    form.classList.add('tool-form-active');
    try {
      form.orderId.value = orderId;
      await sleep(500);
      form.body.value = body;
      await sleep(400);
      form.requestSubmit();
    } finally {
      form.classList.remove('tool-form-active');
      agentDrivingForm = false;
    }
    return textResult(`티켓 생성됨: ${orderId} — ${body}`);
  },
});

fillSampleArgs();

// ?autostep=N — 로드 직후 N 단계를 자동 진행한다.
// 시연용이자, 헤드리스 스크린샷으로 스테퍼를 검증하는 수단이다.
const autostep = Number(new URLSearchParams(location.search).get('autostep'));
if (Number.isFinite(autostep) && autostep > 0) {
  for (let i = 0; i < autostep; i++) await nextStep();
}

log(
  'think',
  `준비 완료. 런타임: <b>${runtime.mode}</b> (${runtime.namespace}). ` +
    `등록된 도구 ${listTools().length}개.`,
);
