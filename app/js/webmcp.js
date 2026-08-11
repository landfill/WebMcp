/**
 * WebMCP 어댑터 계층.
 *
 * 목적 3가지:
 *  1) 네임스페이스 차이 흡수 (document.modelContext / navigator.modelContext)
 *  2) 네이티브 구현이 없을 때만 shim 설치 — 절대로 네이티브를 가리지 않는다
 *  3) 등록한 도구 서술자를 페이지 쪽에 미러링 (표준에는 "내 도구 목록" 조회 API가 없다)
 */

const listeners = new Set();

/** 페이지가 등록한 도구 서술자 미러. name -> {descriptor, active} */
const mirror = new Map();

function notify() {
  for (const fn of listeners) fn(listTools());
}

export function onToolsChanged(fn) {
  listeners.add(fn);
  fn(listTools());
  return () => listeners.delete(fn);
}

export function listTools() {
  return [...mirror.values()]
    .filter((e) => e.active)
    .map((e) => e.descriptor);
}

// ---------------------------------------------------------------------------
// 1. 탐지
// ---------------------------------------------------------------------------

function detectNative() {
  const onDocument =
    typeof document !== 'undefined' && 'modelContext' in document;
  const onNavigator =
    typeof navigator !== 'undefined' && 'modelContext' in navigator;
  const target = onDocument
    ? document.modelContext
    : onNavigator
      ? navigator.modelContext
      : null;

  if (!target || typeof target.registerTool !== 'function') return null;

  return {
    target,
    namespace: onDocument ? 'document.modelContext' : 'navigator.modelContext',
    methods: Object.getOwnPropertyNames(
      Object.getPrototypeOf(target) ?? {},
    ).filter((m) => m !== 'constructor'),
  };
}

// ---------------------------------------------------------------------------
// 2. shim (네이티브가 없을 때만)
// ---------------------------------------------------------------------------

function createShim() {
  const registry = new Map();
  return {
    __shim: true,
    async registerTool(descriptor, options = {}) {
      if (!descriptor?.name) throw new TypeError('tool.name is required');
      registry.set(descriptor.name, descriptor);
      options.signal?.addEventListener('abort', () => {
        registry.delete(descriptor.name);
      });
    },
    /** shim 전용: 에이전트 측 호출 경로를 흉내내기 위한 진입점 */
    async __invoke(name, args) {
      const tool = registry.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return await tool.execute(args ?? {});
    },
  };
}

const native = detectNative();

export const runtime = native
  ? {
      mode: 'native',
      namespace: native.namespace,
      methods: native.methods,
      target: native.target,
    }
  : {
      mode: 'shim',
      namespace: 'shim (네이티브 없음)',
      methods: ['registerTool'],
      target: createShim(),
    };

// ---------------------------------------------------------------------------
// 3. 등록 래퍼
// ---------------------------------------------------------------------------

/**
 * 도구를 등록하고 서술자를 미러에 기록한다.
 * @returns {() => void} 등록 해제 함수 (AbortController.abort)
 */
export async function registerTool(descriptor) {
  const controller = new AbortController();

  const entry = { descriptor, active: true, controller };
  mirror.set(descriptor.name, entry);

  try {
    await runtime.target.registerTool(descriptor, {
      signal: controller.signal,
    });
  } catch (err) {
    mirror.delete(descriptor.name);
    notify();
    throw err;
  }

  controller.signal.addEventListener('abort', () => {
    mirror.delete(descriptor.name);
    notify();
  });

  notify();
  return () => controller.abort();
}

/** 여러 도구를 한 번에 등록하고, 전부 해제하는 함수 하나를 돌려준다. */
export async function registerAll(descriptors) {
  const offs = [];
  for (const d of descriptors) offs.push(await registerTool(d));
  return () => offs.forEach((off) => off());
}

// ---------------------------------------------------------------------------
// 4. 호출 (in-page 에이전트 시뮬레이터용)
// ---------------------------------------------------------------------------

/**
 * 시뮬레이터가 도구를 부르는 경로.
 *
 * 주의: 이건 "에이전트가 하는 일"을 페이지 안에서 흉내내는 것이다.
 * 실제 에이전트는 브라우저/확장을 통해 같은 execute() 를 호출한다.
 * 우리는 미러에 보관한 서술자의 execute 를 직접 부르므로,
 * 네이티브/shim 어느 쪽이든 동일한 코드 경로가 검증된다.
 */
export async function callTool(name, args) {
  const entry = mirror.get(name);
  if (!entry?.active) throw new Error(`등록되지 않은 도구: ${name}`);
  const started = performance.now();
  const raw = await entry.descriptor.execute(args ?? {});
  return {
    name,
    args,
    ms: Math.round(performance.now() - started),
    result: normalizeResult(raw),
    raw,
  };
}

/** 반환 형식 차이 흡수: {content:[{type:'text',text}]} 또는 평범한 값 */
export function normalizeResult(raw) {
  if (raw && Array.isArray(raw.content)) {
    return raw.content
      .map((part) =>
        part.type === 'text' ? part.text : JSON.stringify(part, null, 2),
      )
      .join('\n');
  }
  if (typeof raw === 'string') return raw;
  return JSON.stringify(raw, null, 2);
}

/** 도구 실행 결과를 표준 content 형식으로 감싸는 헬퍼 */
export function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

export function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
