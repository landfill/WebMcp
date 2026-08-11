/** 운영 도메인 상태 (주문 / 재고). 아주 얇은 pub-sub 스토어. */

const subs = new Set();

/** 초기 데이터 팩토리 — "처음부터" 버튼이 이걸로 되돌린다. */
function seed() {
  return {
  orders: [
    {
      id: 'ORD-1001',
      customer: '김민수',
      status: 'pending',
      items: [{ sku: 'TRV-CAP', qty: 2 }],
      note: '',
      refunded: false,
    },
    {
      id: 'ORD-1002',
      customer: '이서연',
      status: 'pending',
      items: [
        { sku: 'TRV-TEE', qty: 1 },
        { sku: 'TRV-MUG', qty: 3 },
      ],
      note: '',
      refunded: false,
    },
    {
      id: 'ORD-1003',
      customer: '박도윤',
      status: 'allocated',
      items: [{ sku: 'TRV-MUG', qty: 1 }],
      note: '',
      refunded: false,
    },
    {
      id: 'ORD-1004',
      customer: '최하은',
      status: 'shipped',
      items: [{ sku: 'TRV-TEE', qty: 2 }],
      note: '',
      refunded: false,
    },
  ],
  inventory: [
    { sku: 'TRV-CAP', name: '트레발리 캡', onHand: 5, reserved: 0 },
    { sku: 'TRV-TEE', name: '트레발리 티셔츠', onHand: 2, reserved: 2 },
    // onHand 는 항상 reserved 이상이어야 한다 (ORD-1003 이 1개를 잡고 있다).
    // 가용 = 0 이므로 ORD-1002 의 3개 요청은 여전히 실패한다.
    { sku: 'TRV-MUG', name: '트레발리 머그', onHand: 1, reserved: 1 },
  ],
  /** 사람 승인 대기 큐 (human-in-the-loop) */
  approvals: [],
  /** 감사 로그 */
  audit: [],
  /** 현재 상세 조회 중인 주문 — 도구 생명주기 데모용 */
  selectedOrderId: null,
  };
}

export const state = seed();

/** 상태를 초기값으로 되돌린다. 대기 중인 승인은 거부 처리해 Promise 를 정리한다. */
export function resetState() {
  for (const a of state.approvals) a.resolve(false);
  Object.assign(state, seed());
  commit('상태를 초기값으로 되돌렸다', () => {});
}

export const STATUS_FLOW = ['pending', 'allocated', 'shipped', 'delivered'];

export function subscribe(fn) {
  subs.add(fn);
  fn(state);
  return () => subs.delete(fn);
}

export function commit(reason, mutator) {
  mutator(state);
  state.audit.unshift({
    at: new Date().toLocaleTimeString('ko-KR'),
    reason,
  });
  state.audit = state.audit.slice(0, 40);
  for (const fn of subs) fn(state);
}

export function findOrder(id) {
  return state.orders.find((o) => o.id === id) ?? null;
}

export function findItem(sku) {
  return state.inventory.find((i) => i.sku === sku) ?? null;
}

export function available(sku) {
  const item = findItem(sku);
  return item ? item.onHand - item.reserved : 0;
}

// ---------------------------------------------------------------------------
// 승인 게이트: 위험한 도구는 사람이 버튼을 눌러야 진행된다.
// ---------------------------------------------------------------------------

let approvalSeq = 0;

export function requestApproval(summary, detail) {
  return new Promise((resolve) => {
    const id = `AP-${++approvalSeq}`;
    commit(`승인 요청 ${id}: ${summary}`, (s) => {
      s.approvals.push({ id, summary, detail, resolve });
    });
  });
}

export function resolveApproval(id, approved) {
  const entry = state.approvals.find((a) => a.id === id);
  if (!entry) return;
  commit(`승인 ${approved ? '허가' : '거부'} ${id}`, (s) => {
    s.approvals = s.approvals.filter((a) => a.id !== id);
  });
  entry.resolve(approved);
}
