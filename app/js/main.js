import {
  runtime,
  onToolsChanged,
  listTools,
  callTool,
  registerTool,
  registrationReport,
  textResult,
} from './webmcp.js';
import {
  state,
  subscribe,
  commit,
  resolveApproval,
  resetState,
  findBooking,
  SHORTAGE_MARK,
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
// 탭 + 두 탭을 잇는 딥링크
//
// 탭으로 갈라 놓되, 개념 문단에서 시뮬레이터의 "그 부분"으로 바로 갈 수 있게
// 하고 반대 방향 링크도 둔다. 링크가 한쪽으로만 나 있으면 결국
// "앱을 참조하는 문서"로 읽힌다.
// ---------------------------------------------------------------------------

const TABS = ['concept', 'sim'];
let currentTab = 'concept';

function selectTab(name, { push = true } = {}) {
  if (!TABS.includes(name) || name === currentTab) return;
  if (currentTab === 'sim') stopAuto(); // 안 보이는 탭에서 자동 재생이 도는 것을 막는다
  currentTab = name;

  for (const t of TABS) {
    $(`#tab-${t}`).hidden = t !== name;
    $(`#tab-btn-${t}`).setAttribute('aria-selected', String(t === name));
  }
  if (push) history.replaceState(null, '', `#${name}`);
  window.scrollTo({ top: 0 });
}

document.querySelectorAll('.tab').forEach((btn) =>
  btn.addEventListener('click', () => selectTab(btn.dataset.tab)),
);

/** 도착 지점을 잠깐 강조한다 — 어디로 왔는지 알 수 있게. */
function land(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('landed');
  void el.offsetWidth; // 애니메이션 재시작
  el.classList.add('landed');
  setTimeout(() => el.classList.remove('landed'), 3000);
}

/**
 * data-goto 문법
 *   concept:<섹션id>  개념 탭의 해당 절로
 *   tool:<도구이름>    시뮬 탭 수동 호출에 그 도구를 세팅
 *   scenario / form / refund / lifecycle
 */
function goTo(target) {
  const [kind, arg] = target.split(':');

  if (kind === 'concept') {
    selectTab('concept');
    setTimeout(() => land($(`#${arg}`)), 60);
    return;
  }

  selectTab('sim');
  setTimeout(() => {
    if (kind === 'tool' || kind === 'refund') {
      const name = kind === 'refund' ? 'cancel_booking' : arg;
      if ([...select.options].some((o) => o.value === name)) {
        select.value = name;
        showToolDesc();
        fillSampleArgs();
        if (kind === 'refund') {
          $('#tool-args').value = JSON.stringify(
            { bookingId: 'BKG-2004', reason: '고객 일정 변경' },
            null,
            2,
          );
        }
      }
      land($('#manual-block'));
    } else if (kind === 'form') {
      land($('#form-block'));
    } else if (kind === 'lifecycle') {
      openBooking('BKG-2002');
      land($('#booking-detail'));
    } else {
      land($('#stepper-block'));
    }
  }, 60);
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-goto]');
  if (link) goTo(link.dataset.goto);
});

// ---------------------------------------------------------------------------
// 검증 패널
//
// 시뮬레이터는 미러에 보관한 서술자의 execute() 를 직접 부른다.
// 즉 "에이전트 → 브라우저 → 페이지" 홉을 건너뛴다. 페이지가 자기 도구를
// 브라우저를 거쳐 되부를 수 있는 API 가 없기 때문인데, 그 결과 시뮬레이터가
// 잘 도는 것이 곧 WebMCP 가 동작한다는 증거는 아니다. 숨기지 말고 명시한다.
// ---------------------------------------------------------------------------

function renderVerify() {
  const r = registrationReport();
  const rows = r.rows
    .map(
      (t) =>
        `<li><span class="t">${t.accepted ? '✓' : '✕'}</span> ${t.name}` +
        (t.error ? ` — <span style="color:var(--bad)">${escapeHtml(t.error)}</span>` : '') +
        `</li>`,
    )
    .join('');

  $('#verify-body').innerHTML = `
    <p class="hint" style="margin-top:0">
      런타임 <b style="color:var(--text)">${r.mode}</b> · ${escapeHtml(r.namespace)}<br>
      감지된 메서드: <code>${escapeHtml(r.methods.join(', ') || '(없음)')}</code>
    </p>

    <table class="grid" style="margin: 4px 0 14px">
      <thead><tr><th>확인 대상</th><th>시뮬레이터</th><th>DevTools 패널</th></tr></thead>
      <tbody>
        <tr><td>execute() 로직이 맞는가</td><td>✓</td><td>—</td></tr>
        <tr><td>registerTool() 이 예외 없이 통과했는가</td><td>✓</td><td>—</td></tr>
        <tr><td>브라우저가 도구를 열거하는가</td><td class="zero">✕</td><td>✓</td></tr>
        <tr><td>선언형 폼이 도구로 합성됐는가</td><td class="zero">✕</td><td>✓</td></tr>
        <tr><td>브라우저 경로로 실제 호출되는가</td><td class="zero">✕</td><td>✓</td></tr>
      </tbody>
    </table>

    <p class="hint">
      시뮬레이터의 "호출"은 페이지가 자기 <code>execute()</code>를 직접 부르는 것이다.
      <b style="color:var(--text)">에이전트 → 브라우저 → 페이지 홉을 건너뛴다.</b>
      페이지가 자기 도구를 브라우저를 거쳐 되부르는 API 는 없기 때문이다.
      실행되는 함수는 진짜 에이전트가 부르는 것과 동일하지만,
      전달 경로는 검증되지 않는다.
    </p>
    <p class="hint">
      전달 경로까지 확인하려면
      <code>chrome://flags/#devtools-webmcp-support</code> 를 켜고 DevTools 의
      WebMCP 패널에서 도구가 열거되는지 보거나, Model Context Tool Inspector
      확장으로 외부에서 호출해 보라.
    </p>

    <p class="hint" style="margin-bottom:6px">등록 결과 (${r.rows.length}개)</p>
    <ul class="log">${rows}</ul>
  `;
}

$('#verify-toggle').addEventListener('click', (e) => {
  const body = $('#verify-body');
  body.hidden = !body.hidden;
  e.target.textContent = body.hidden ? '펼치기' : '접기';
  e.target.setAttribute('aria-expanded', String(!body.hidden));
});

// 목차 현재 위치 표시
{
  const links = [...document.querySelectorAll('.doc-toc a')];
  const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
  const seen = new Set();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) seen.add(e.target.id);
        else seen.delete(e.target.id);
      }
      const first = links.find((a) => seen.has(a.getAttribute('href').slice(1)));
      links.forEach((a) => a.classList.toggle('active', a === first));
    },
    { rootMargin: '-84px 0px -60% 0px' },
  );
  for (const id of byId.keys()) {
    const el = document.getElementById(id);
    if (el) io.observe(el);
  }
  links.forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document
        .getElementById(a.getAttribute('href').slice(1))
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }),
  );
}

// 사람 승인이 필요해지면 그 화면으로 데려온다
document.addEventListener('approval-needed', () => {
  selectTab('sim');
  setTimeout(() => land($('#approvals')), 60);
});

// ---------------------------------------------------------------------------
// 운영 화면 렌더링
// ---------------------------------------------------------------------------

function statusChip(s) {
  return `<span class="status status-${s}">${s}</span>`;
}

function renderBookings(s) {
  $('#bookings tbody').innerHTML = s.bookings
    .map(
      (b) => `<tr data-id="${b.id}">
        <td class="mono">${b.id}${b.cancelled ? ' ↩︎' : ''}</td>
        <td>${b.guest}</td>
        <td class="mono">${b.rooms.map((r) => `${r.code}×${r.qty}`).join(', ')}</td>
        <td class="mono">${b.checkIn} · ${b.nights}박</td>
        <td>${statusChip(b.status)}</td>
        <td><button class="link" data-open="${b.id}">열기</button></td>
      </tr>`,
    )
    .join('');
}

function renderRooms(s) {
  $('#rooms tbody').innerHTML = s.rooms
    .map((r) => {
      const avail = r.total - r.assigned;
      return `<tr>
        <td class="mono">${r.code}</td>
        <td>${r.name}<br /><span class="sub">${r.hotel}</span></td>
        <td>${r.total}</td>
        <td>${r.assigned}</td>
        <td class="${avail <= 0 ? 'zero' : ''}">${avail}</td>
      </tr>`;
    })
    .join('');
}

function renderDetail(s) {
  const box = $('#booking-detail');
  const booking = s.selectedBookingId
    ? findBooking(s.selectedBookingId)
    : null;
  box.hidden = !booking;
  if (booking) {
    $('#detail-id').textContent = booking.id;
    $('#detail-note').textContent = booking.note || '(메모 없음)';
  }
}

function renderApprovals(s) {
  $('#approvals').innerHTML = s.approvals
    .map(
      (a) => `<div class="approval">
        <div class="t">⚠ 승인 필요 — ${a.summary}</div>
        <div class="d">${a.detail}<br>도구는 이 버튼을 누를 때까지 대기 중이다.</div>
        <div class="row">
          <button class="approve" data-approve="${a.id}">승인</button>
          <button class="reject" data-reject="${a.id}">거부</button>
        </div>
      </div>`,
    )
    .join('');
}

function renderAudit(s) {
  $('#audit').innerHTML = s.audit
    .map((a) => `<li><span class="t">${a.at}</span> ${a.reason}</li>`)
    .join('');
}

subscribe((s) => {
  renderBookings(s);
  renderRooms(s);
  renderDetail(s);
  renderApprovals(s);
  renderAudit(s);
});

// ---------------------------------------------------------------------------
// 상호작용
// ---------------------------------------------------------------------------

function openBooking(id) {
  commit(`예약 상세 열기 ${id}`, (s) => {
    s.selectedBookingId = id;
  });
  syncContextualTools();
}

document.addEventListener('click', (e) => {
  const open = e.target.dataset?.open;
  if (open) openBooking(open);
  const ap = e.target.dataset?.approve;
  if (ap) resolveApproval(ap, true);
  const rj = e.target.dataset?.reject;
  if (rj) resolveApproval(rj, false);
});

$('#close-detail').addEventListener('click', () => {
  commit('예약 상세 닫기', (s) => {
    s.selectedBookingId = null;
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
  const bookingId = fd.get('bookingId');
  const body = fd.get('body');
  const byAgent = e.agentInvoked === true || agentDrivingForm;

  addTicket(bookingId, body, byAgent);
  e.target.reset();

  if (byAgent && typeof e.respondWith === 'function') {
    e.respondWith(
      Promise.resolve(textResult(`티켓 생성됨: ${bookingId} — ${body}`)),
    );
  }
});

function addTicket(bookingId, body, byAgent = false) {
  const li = document.createElement('li');
  li.innerHTML =
    `<span class="t">${new Date().toLocaleTimeString('ko-KR')}</span> ` +
    `${byAgent ? '🤖 ' : ''}${escapeHtml(bookingId)} — ${escapeHtml(body)}`;
  $('#tickets').prepend(li);
  commit(
    `문의 티켓 생성 (${bookingId})${byAgent ? ' — 에이전트' : ''}`,
    () => {},
  );
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

  const ids = new Set(focus.bookings ?? []);
  if (focus.status)
    for (const b of state.bookings)
      if (b.status === focus.status) ids.add(b.id);

  for (const id of ids)
    $(`#bookings tbody tr[data-id="${id}"]`)?.classList.add('flash');

  for (const code of focus.rooms ?? []) {
    const row = [...document.querySelectorAll('#rooms tbody tr')].find(
      (tr) => tr.textContent.includes(code),
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
      `<span class="chip ${meta.cls}">${meta.text}</span>
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

    const failed = String(result).includes(SHORTAGE_MARK);
    // 실패는 이 데모의 핵심 장면이다 — 카드 전체를 실패 색으로 승격시킨다
    if (failed) {
      $('#step-card').classList.remove(meta.cls);
      $('#step-card').classList.add('k-fail');
      $('#step-card .chip').className = 'chip k-fail';
      $('#step-card .chip').textContent = '행동 → 실패';
    }
    $('#step-result-block').innerHTML =
      `<div class="step-label">③ 결과</div>` +
      `<pre class="result ${failed ? 'bad' : ''}">${escapeHtml(result)}</pre>` +
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
      bookingId: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['bookingId', 'body'],
  },
  async execute({ bookingId, body }) {
    const form = $('#ticket-form');

    // 네이티브라면 브라우저가 :tool-form-active 를 알아서 붙인다.
    // shim 모드에서는 같은 UX 를 보여주기 위해 동등한 클래스를 직접 토글한다.
    agentDrivingForm = true;
    form.classList.add('tool-form-active');
    try {
      form.bookingId.value = bookingId;
      await sleep(500);
      form.body.value = body;
      await sleep(400);
      form.requestSubmit();
    } finally {
      form.classList.remove('tool-form-active');
      agentDrivingForm = false;
    }
    return textResult(`티켓 생성됨: ${bookingId} — ${body}`);
  },
});

fillSampleArgs();
renderVerify();

// 진입 시 탭 결정: ?tab= > #해시 > 기본(개념)
const params = new URLSearchParams(location.search);
const autostep = Number(params.get('autostep'));
const wantsSim =
  params.get('tab') === 'sim' ||
  location.hash === '#sim' ||
  (Number.isFinite(autostep) && autostep > 0);

if (wantsSim) selectTab('sim', { push: false });

// ?autostep=N — 로드 직후 N 단계를 자동 진행한다.
// 시연용이자, 헤드리스 스크린샷으로 스테퍼를 검증하는 수단이다.
if (Number.isFinite(autostep) && autostep > 0) {
  for (let i = 0; i < autostep; i++) await nextStep();
}

log(
  'think',
  `준비 완료. 런타임: <b>${runtime.mode}</b> (${runtime.namespace}). ` +
    `등록된 도구 ${listTools().length}개.`,
);
