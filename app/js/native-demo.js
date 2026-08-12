const $ = (selector) => document.querySelector(selector);

const tasks = [
  {
    id: 'TRIP-001',
    title: '호텔 체크인 가능 시간 확인하기',
    priority: 'high',
    completed: false,
  },
  {
    id: 'TRIP-002',
    title: 'Visit Japan Web 입국 정보 등록하기',
    priority: 'high',
    completed: true,
  },
  {
    id: 'TRIP-003',
    title: '도쿄 날씨 확인하고 우산 준비 결정하기',
    priority: 'low',
    completed: false,
  },
];
let nextTaskNumber = 4;
let registrationController = null;
let activationVersion = 0;

const TOOL_NAMES = [
  'list_trip_tasks',
  'add_trip_task',
  'complete_trip_task',
];

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[
        character
      ],
  );
}

function toolResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function setStatus(kind, text) {
  const status = $('#native-status');
  if (!status) return;
  status.className = `native-status ${kind}`;
  status.textContent = text;
}

function setCheck(name, kind, text) {
  const check = $(`[data-native-check="${name}"]`);
  const value = $(`#native-check-${name}`);
  if (!check || !value) return;
  check.dataset.state = kind;
  value.textContent = text;
}

function showBlocker(html) {
  const blocker = $('#native-blocker');
  if (!blocker) return;
  blocker.hidden = !html;
  blocker.innerHTML = html;
}

function renderTasks() {
  const list = $('#native-task-list');
  const count = $('#native-task-count');
  if (!list || !count) return;

  const completed = tasks.filter((task) => task.completed).length;
  const percentage = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
  count.textContent = `${completed}/${tasks.length} 완료`;
  const progress = $('#native-progress');
  const progressText = $('#native-progress-text');
  if (progress) progress.style.width = `${percentage}%`;
  if (progressText) progressText.textContent = `${percentage}% 준비되었습니다.`;

  if (tasks.length === 0) {
    list.innerHTML = `
      <div class="native-empty">
        <span>∅</span>
        <p>등록된 작업이 없다.<br />브라우저 에이전트의 도구 호출을 기다린다.</p>
      </div>`;
    return;
  }

  const priorityLabel = { high: '높음', normal: '보통', low: '낮음' };
  list.innerHTML = tasks
    .map(
      (task) => `
        <article class="native-task ${task.completed ? 'is-complete' : ''}">
          <span class="native-task-check" aria-hidden="true">${task.completed ? '✓' : ''}</span>
          <div class="native-task-content">
          <div class="native-task-meta">
            <code>${escapeHtml(task.id)}</code>
            <span class="priority priority-${escapeHtml(task.priority)}">${escapeHtml(
              priorityLabel[task.priority],
            )}</span>
          </div>
          <p>${escapeHtml(task.title)}</p>
          <span class="native-task-state">${task.completed ? '준비 완료' : '확인 필요'}</span>
          </div>
        </article>`,
    )
    .join('');
}

function logInvocation(toolName, args, result) {
  const log = $('#native-event-log');
  if (!log) return;
  log.querySelector('.native-event-empty')?.remove();

  const item = document.createElement('li');
  item.className = 'native-event';
  item.innerHTML = `
    <span class="native-event-icon" aria-hidden="true">✦</span>
    <div>
      <b>${escapeHtml(result)}</b>
      <span>AI 에이전트 · ${new Date().toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
      })}</span>
    </div>`;
  log.prepend(item);
  setStatus('ready', '에이전트가 방금 처리함');
}

function getNativeContext() {
  // 현재 초안의 네임스페이스만 허용한다. navigator나 내부 shim으로 우회하지 않는다.
  return document.modelContext;
}

function nativeTools() {
  return [
    {
      name: 'list_trip_tasks',
      title: '여행 준비 목록 조회',
      description:
        '현재 도쿄 여행의 출발 전 준비 목록을 조회한다. 준비 항목을 추가하거나 완료하기 전에 현재 상태와 정확한 taskId를 확인할 때 사용한다.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      async execute(args = {}) {
        const result = tasks.map((task) => ({ ...task }));
        logInvocation('list_trip_tasks', args, `여행 준비 ${result.length}개를 확인했습니다.`);
        return toolResult({ count: result.length, tasks: result });
      },
    },
    {
      name: 'add_trip_task',
      title: '여행 준비 추가',
      description:
        '사용자가 도쿄 여행 전에 해야 할 새로운 준비 항목을 목록에 추가한다. title에는 구체적인 행동을 적고 priority는 high, normal, low 중 하나를 사용한다.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, description: '추가할 작업의 구체적인 내용' },
          priority: {
            type: 'string',
            enum: ['high', 'normal', 'low'],
            description: '작업 우선순위',
          },
        },
        required: ['title', 'priority'],
        additionalProperties: false,
      },
      annotations: { untrustedContentHint: true },
      async execute({ title, priority }) {
        const cleanTitle = String(title ?? '').trim();
        if (!cleanTitle || !['high', 'normal', 'low'].includes(priority)) {
          const message = 'title과 priority(high, normal, low)를 확인해야 한다.';
          logInvocation('add_trip_task', { title, priority }, message);
          return toolResult({ ok: false, error: message });
        }

        const task = {
          id: `TRIP-${String(nextTaskNumber++).padStart(3, '0')}`,
          title: cleanTitle,
          priority,
          completed: false,
        };
        tasks.push(task);
        renderTasks();
        logInvocation('add_trip_task', { title: cleanTitle, priority }, `‘${cleanTitle}’ 준비를 추가했습니다.`);
        return toolResult({ ok: true, task: { ...task } });
      },
    },
    {
      name: 'complete_trip_task',
      title: '여행 준비 완료',
      description:
        '현재 도쿄 여행 준비 목록에서 지정한 항목을 완료 처리한다. 먼저 목록을 조회하여 정확한 taskId를 확인한 뒤 사용한다.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            pattern: '^TRIP-[0-9]{3}$',
            description: '완료할 준비 항목 ID. 예: TRIP-001',
          },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
      annotations: { untrustedContentHint: true },
      async execute({ taskId }) {
        const task = tasks.find((candidate) => candidate.id === taskId);
        if (!task) {
          const message = `${taskId} 작업을 찾을 수 없다.`;
          logInvocation('complete_trip_task', { taskId }, message);
          return toolResult({ ok: false, error: message });
        }
        if (task.completed) {
          const message = `${taskId} 작업은 이미 완료되었다.`;
          logInvocation('complete_trip_task', { taskId }, message);
          return toolResult({ ok: true, alreadyCompleted: true, task: { ...task } });
        }

        task.completed = true;
        renderTasks();
        logInvocation('complete_trip_task', { taskId }, `‘${task.title}’ 준비를 완료했습니다.`);
        return toolResult({ ok: true, task: { ...task } });
      },
    },
  ];
}

export async function activateNativeDemo() {
  const version = ++activationVersion;
  registrationController?.abort();
  registrationController = null;
  renderTasks();
  showBlocker('');
  setStatus('checking', '네이티브 API 확인 중');

  if (!window.isSecureContext) {
    setCheck('secure', 'failed', '실패 · HTTPS 또는 localhost 필요');
    setCheck('namespace', 'waiting', '보안 컨텍스트 확인 후 검사');
    setCheck('registration', 'waiting', '등록하지 않음');
    setStatus('blocked', 'Chrome 연결 필요');
    showBlocker('<b>보안 컨텍스트가 아니다.</b> HTTPS 또는 localhost로 접속해야 한다. 대체 실행은 제공하지 않는다.');
    return;
  }
  setCheck('secure', 'passed', '통과 · 보안 컨텍스트');

  const context = getNativeContext();
  if (!context || typeof context.registerTool !== 'function') {
    setCheck('namespace', 'failed', '없음 · document.modelContext 미지원');
    setCheck('registration', 'failed', '0개 · 등록하지 않음');
    setStatus('blocked', 'WebMCP를 사용할 수 없음');
    showBlocker(
      '<b>이 Chrome에서 네이티브 WebMCP API를 찾지 못했다.</b> Chrome의 WebMCP 실험 기능 또는 배포 오리진의 트라이얼을 활성화한 뒤 새로고침해야 한다. 이 탭은 shim이나 페이지 내부 호출로 우회하지 않는다.',
    );
    return;
  }
  setCheck('namespace', 'passed', '확인 · document.modelContext');

  const controller = new AbortController();
  registrationController = controller;
  try {
    for (const tool of nativeTools()) {
      if (version !== activationVersion || controller.signal.aborted) return;
      await context.registerTool(tool, { signal: controller.signal });
    }
    if (version !== activationVersion || controller.signal.aborted) return;
    setCheck('registration', 'passed', `${TOOL_NAMES.length}개 · 사용 가능`);
    setStatus('ready', 'WebMCP 도구 준비됨');
  } catch (error) {
    controller.abort();
    if (registrationController === controller) registrationController = null;
    if (version !== activationVersion || error?.name === 'AbortError') return;
    setCheck('registration', 'failed', '실패 · 등록 거부');
    setStatus('error', '도구 등록 실패');
    showBlocker(
      `<b>브라우저가 도구 등록을 거부했다.</b> ${escapeHtml(error?.message ?? error)} 배포 헤더와 WebMCP 권한을 확인해야 한다.`,
    );
  }
}

export function deactivateNativeDemo() {
  activationVersion += 1;
  registrationController?.abort();
  registrationController = null;
  setCheck('registration', 'waiting', '탭을 벗어나 도구 해제됨');
  setStatus('checking', '탭을 열면 다시 등록');
}
