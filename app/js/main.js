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
  findOrder,
} from './store.js';
import { registerAllTools, syncContextualTools } from './tools.js';

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

// 선언형 폼: 사람이 직접 제출할 때의 동작
$('#ticket-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  addTicket(fd.get('orderId'), fd.get('body'));
  e.target.reset();
});

function addTicket(orderId, body) {
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString('ko-KR')}] ${orderId} — ${body}`;
  $('#tickets').prepend(li);
  commit(`문의 티켓 생성 (${orderId})`, () => {});
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
  if (tools.some((t) => t.name === prev)) select.value = prev;
  showToolDesc();
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
  // 필수 인자 자리표시자를 인자 칸에 채워 준다
  const props = tool.inputSchema?.properties ?? {};
  const required = tool.inputSchema?.required ?? [];
  const sample = {};
  for (const key of required)
    sample[key] = props[key]?.type === 'number' ? 0 : '';
  $('#tool-args').value = JSON.stringify(sample, null, 2);
}

select.addEventListener('change', showToolDesc);

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
// 운영 시나리오: 에이전트의 "관찰 → 판단 → 행동" 루프를 스크립트로 재현
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

$('#run-scenario').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    await runScenario();
  } finally {
    e.target.disabled = false;
  }
});

async function runScenario() {
  log('think', '── 시나리오 시작: "밀린 주문 처리해줘" ──');

  log('think', '① 먼저 무엇이 밀려 있는지 본다.');
  await invoke('list_orders', { status: 'pending' });
  await sleep(600);

  const pending = state.orders.filter((o) => o.status === 'pending');
  for (const order of pending) {
    log('think', `② ${order.id} 을 할당 시도한다.`);
    const res = await invoke('allocate_stock', { orderId: order.id });
    await sleep(500);

    if (!res.includes('재고 부족')) continue;

    log('think', '③ 실패했다. 부족한 SKU 를 재고에서 확인한다.');
    for (const item of order.items) {
      const inv = state.inventory.find((i) => i.sku === item.sku);
      const avail = inv.onHand - inv.reserved;
      if (avail >= item.qty) continue;

      const need = item.qty - avail;
      log('think', `④ ${item.sku} 가 ${need}개 모자라다. 입고한다.`);
      await invoke('restock_item', { sku: item.sku, qty: need });
      await sleep(500);
    }

    log('think', '⑤ 입고했으니 다시 할당한다.');
    await invoke('allocate_stock', { orderId: order.id });
    await sleep(500);
  }

  log('think', '⑥ 할당된 주문을 출고 처리한다.');
  for (const order of state.orders.filter((o) => o.status === 'allocated')) {
    await invoke('advance_order_status', { orderId: order.id });
    await sleep(400);
  }

  log(
    'think',
    '── 시나리오 끝. 환불처럼 되돌릴 수 없는 작업은 자동으로 하지 않는다. ' +
      '<code>issue_refund</code> 를 직접 호출해 승인 게이트를 확인하라. ──',
  );
}

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
    '문의 티켓 폼을 채워 제출한다. 선언형 <form tool="create_support_ticket"> 이 ' +
    '브라우저 안에서 하는 일과 동일한 결과를 만든다.',
  inputSchema: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['orderId', 'body'],
  },
  execute({ orderId, body }) {
    const form = $('#ticket-form');
    form.orderId.value = orderId;
    form.body.value = body;
    form.requestSubmit();
    return textResult(`티켓 생성됨: ${orderId} — ${body}`);
  },
});

log(
  'think',
  `준비 완료. 런타임: <b>${runtime.mode}</b> (${runtime.namespace}). ` +
    `등록된 도구 ${listTools().length}개.`,
);
