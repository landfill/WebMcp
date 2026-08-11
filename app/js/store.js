/** 여행 예약 도메인 상태 (예약 / 객실 재고). 아주 얇은 pub-sub 스토어. */

const subs = new Set();

/**
 * 객실 부족 실패를 알리는 표식.
 *
 * 이 문구는 세 곳에서 맞물린다: 도구가 돌려주는 실패 텍스트,
 * 시나리오 제너레이터의 복구 분기, 스테퍼의 실패 카드 승격.
 * 문자열을 각자 적어 두면 하나만 어긋나도 조용히 어긋난다 —
 * 예외도 안 나고 화면도 돌지만 이 데모의 핵심 장면만 사라진다.
 */
export const SHORTAGE_MARK = '잔여 객실 부족';

/** 초기 데이터 팩토리 — "처음부터" 버튼이 이걸로 되돌린다. */
function seed() {
  return {
  bookings: [
    {
      id: 'BKG-2001',
      guest: '김민수',
      status: 'requested',
      checkIn: '04-12',
      nights: 2,
      rooms: [{ code: 'JEJU-OCEAN', qty: 2 }],
      note: '',
      cancelled: false,
    },
    {
      id: 'BKG-2002',
      guest: '이서연',
      status: 'requested',
      checkIn: '04-14',
      nights: 3,
      rooms: [{ code: 'BUSAN-CITY', qty: 1 }],
      note: '',
      cancelled: false,
    },
    {
      id: 'BKG-2003',
      guest: '박도윤',
      status: 'confirmed',
      checkIn: '04-15',
      nights: 1,
      rooms: [{ code: 'SEOUL-SUITE', qty: 1 }],
      note: '',
      cancelled: false,
    },
    {
      id: 'BKG-2004',
      guest: '최하은',
      status: 'ticketed',
      // 04-15~04-18. BKG-2002(04-14~04-17)와 겹쳐야 한다 —
      // 재고를 객실 타입별 단순 카운트로 두었으므로, 투숙 기간이 겹치지 않는
      // 예약이 서로 객실을 잠그면 화면이 데이터와 모순돼 보인다.
      checkIn: '04-15',
      nights: 3,
      rooms: [{ code: 'BUSAN-CITY', qty: 2 }],
      note: '',
      cancelled: false,
    },
  ],
  rooms: [
    {
      code: 'JEJU-OCEAN',
      name: '제주 오션뷰 디럭스',
      hotel: '제주 블루하버',
      total: 5,
      assigned: 0,
    },
    {
      code: 'BUSAN-CITY',
      name: '부산 시티뷰 트윈',
      hotel: '부산 해운대 스테이',
      total: 2,
      assigned: 2,
    },
    // total 은 항상 assigned 이상이어야 한다 (BKG-2003 이 1실을 잡고 있다).
    {
      code: 'SEOUL-SUITE',
      name: '서울 시티 스위트',
      hotel: '서울 남산 호텔',
      total: 1,
      assigned: 1,
    },
  ],
  /** 사람 승인 대기 큐 (human-in-the-loop) */
  approvals: [],
  /** 감사 로그 */
  audit: [],
  /** 현재 상세 조회 중인 예약 — 도구 생명주기 데모용 */
  selectedBookingId: null,
  };
}

export const state = seed();

/** 상태를 초기값으로 되돌린다. 대기 중인 승인은 거부 처리해 Promise 를 정리한다. */
export function resetState() {
  for (const a of state.approvals) a.resolve(false);
  Object.assign(state, seed());
  commit('상태를 초기값으로 되돌렸다', () => {});
}

export const STATUS_FLOW = [
  'requested',
  'confirmed',
  'ticketed',
  'completed',
];

/** 상태 코드의 한국어 설명 — 화면과 도구 설명에서 함께 쓴다. */
export const STATUS_LABEL = {
  requested: '요청 접수',
  confirmed: '객실 확정',
  ticketed: '바우처 발급',
  completed: '투숙 완료',
};

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

export function findBooking(id) {
  return state.bookings.find((b) => b.id === id) ?? null;
}

export function findRoom(code) {
  return state.rooms.find((r) => r.code === code) ?? null;
}

export function available(code) {
  const room = findRoom(code);
  return room ? room.total - room.assigned : 0;
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
    // 승인 카드는 시뮬레이션 탭에 있다. 개념 탭을 읽는 중이라면
    // 아무것도 안 보인 채 Promise 만 매달려 있게 되므로 화면을 끌어온다.
    document.dispatchEvent(new CustomEvent('approval-needed'));
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
