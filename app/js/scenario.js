/**
 * 운영 시나리오 — 에이전트의 "관찰 → 판단 → 행동" 루프.
 *
 * ★ 중요: 이건 미리 계산된 단계 배열이 아니라 async generator 다.
 *   본문은 next() 가 불릴 때마다 그 시점의 실제 state 를 읽고 다음 수를 정한다.
 *   단계 목록을 미리 만들어 두면 화면은 똑같아 보여도,
 *   "예상하지 못한 실패에 반응한다"는 이 데모의 핵심을 연출로 가짜로 만드는 것이다.
 *
 * yield 하는 값 = 에이전트가 지금 하려는 한 수
 *   { why, tool?, args?, focus?, kind? }
 * next(result) 로 방금 호출의 결과 문자열이 되돌아온다.
 */

import { state, SHORTAGE_MARK } from './store.js';

export async function* scenario() {
  yield {
    kind: 'observe',
    why: '사용자가 "요청 접수 상태인 예약을 모두 객실 확정해줘"라고 했다. 먼저 처리 대상 예약을 조회한다.',
    tool: 'list_bookings',
    args: { status: 'requested' },
    focus: { status: 'requested' },
  };

  // ↓ 이 시점의 실제 상태를 읽는다.
  // 취소된 예약도 status 는 requested 다 — 도구가 막아 주지만, 애초에
  // 집지 않는 편이 에이전트의 판단으로도 옳다.
  const requested = state.bookings.filter(
    (b) => b.status === 'requested' && !b.cancelled,
  );

  if (requested.length === 0) {
    yield {
      kind: 'done',
      why: 'requested 예약이 없다. 할 일이 없으므로 여기서 멈춘다. "처음부터"를 눌러 상태를 되돌릴 수 있다.',
    };
    return;
  }

  for (const booking of requested) {
    const roomSummary = booking.rooms
      .map((room) => `${room.code} ${room.qty}실`)
      .join(', ');
    const result = yield {
      kind: 'act',
      why: `${booking.id} (${booking.guest})의 ${roomSummary} 예약을 처리한다. 이 단계에서는 이 예약에 포함된 객실만 배정한다.`,
      tool: 'assign_rooms',
      args: { bookingId: booking.id },
      focus: {
        bookings: [booking.id],
        rooms: booking.rooms.map((r) => r.code),
      },
    };

    if (!String(result).includes(SHORTAGE_MARK)) continue;

    // ── 실패했다. 반환 결과에 포함된 객실 코드만 확인하고 복구한다. ──
    for (const req of booking.rooms) {
      const room = state.rooms.find((r) => r.code === req.code);
      const avail = room.total - room.assigned;
      if (avail >= req.qty) continue;

      const need = req.qty - avail;
      yield {
        kind: 'fail',
        why:
          `${booking.id} (${booking.guest})의 ${req.code} 배정이 실패했다. ` +
          `다른 도시 재고는 조회하지 않고, 이 예약에 필요한 ${req.code}의 잔여 수량만 확인한다.`,
        tool: 'check_availability',
        args: { roomCode: req.code },
        focus: { rooms: [req.code] },
      };

      yield {
        kind: 'recover',
        why:
          `${booking.id}의 투숙 기간과 겹치는 기존 예약 때문에 ${req.code}가 ${need}실 모자란다 ` +
          `(필요 ${req.qty}실, 잔여 ${avail}실). 호텔에 같은 객실 코드의 판매 블록 ${need}실만 추가 요청한다.`,
        tool: 'open_room_block',
        args: { roomCode: req.code, qty: need },
        focus: { rooms: [req.code] },
      };
    }

    yield {
      kind: 'recover',
      why: `${booking.id}에 부족했던 객실만 확보했으므로 같은 예약의 객실 배정을 다시 시도한다.`,
      tool: 'assign_rooms',
      args: { bookingId: booking.id },
      focus: {
        bookings: [booking.id],
        rooms: booking.rooms.map((r) => r.code),
      },
    };
  }

  yield {
    kind: 'done',
    why:
      '요청 접수 상태였던 예약 2건의 객실 확정을 마쳤다. BKG-2001은 기존 제주 재고를 사용했고, ' +
      'BKG-2002는 부족했던 BUSAN-CITY 1실만 추가 확보해 배정했다. 서울 재고와 기존 확정 예약은 변경하지 않았으며, ' +
      '사용자가 요청하지 않은 바우처 발급이나 취소·환불도 실행하지 않았다.',
  };
}
