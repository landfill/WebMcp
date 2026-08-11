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
    why: '사용자가 "밀린 예약 확정해줘"라고 했다. 먼저 무엇이 밀려 있는지 본다. 목록을 모르면 아무것도 정할 수 없다.',
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
    const result = yield {
      kind: 'act',
      why: `${booking.id} 을 처리한다. 객실을 배정해 보면 가능한지 아닌지 알 수 있다.`,
      tool: 'assign_rooms',
      args: { bookingId: booking.id },
      focus: {
        bookings: [booking.id],
        rooms: booking.rooms.map((r) => r.code),
      },
    };

    if (!String(result).includes(SHORTAGE_MARK)) continue;

    // ── 실패했다. 여기가 이 시나리오의 핵심 ──
    yield {
      kind: 'fail',
      why:
        '실패했다. 그런데 도구가 예외를 던진 게 아니라 "무엇이 왜 안 됐는지"를 ' +
        '문장으로 돌려줬다. 그래서 다음 수를 스스로 정할 수 있다. ' +
        '먼저 객실 잔여 현황을 정확히 확인한다.',
      tool: 'check_availability',
      args: {},
      focus: { rooms: booking.rooms.map((r) => r.code) },
    };

    for (const req of booking.rooms) {
      const room = state.rooms.find((r) => r.code === req.code);
      const avail = room.total - room.assigned;
      if (avail >= req.qty) continue;

      const need = req.qty - avail;
      yield {
        kind: 'recover',
        why: `${req.code} 가 ${need}실 모자란다 (필요 ${req.qty}실, 잔여 ${avail}실). 호텔에서 객실을 추가로 확보한다.`,
        tool: 'open_room_block',
        args: { roomCode: req.code, qty: need },
        focus: { rooms: [req.code] },
      };
    }

    yield {
      kind: 'recover',
      why: '막힌 원인을 없앴으니 같은 작업을 다시 시도한다.',
      tool: 'assign_rooms',
      args: { bookingId: booking.id },
      focus: {
        bookings: [booking.id],
        rooms: booking.rooms.map((r) => r.code),
      },
    };
  }

  // 확정된 예약에 바우처를 발급한다
  for (const booking of state.bookings.filter((b) => b.status === 'confirmed')) {
    yield {
      kind: 'act',
      why: `${booking.id} 는 객실이 잡혔다. 다음 단계인 바우처 발급으로 진행시킨다.`,
      tool: 'advance_booking_status',
      args: { bookingId: booking.id },
      focus: { bookings: [booking.id] },
    };
  }

  yield {
    kind: 'done',
    why:
      '밀린 예약을 모두 확정했다. 취소·환불처럼 되돌릴 수 없는 작업은 지시받지 않았으므로 하지 않는다. ' +
      '아래 "수동 호출"에서 cancel_booking 을 직접 불러 사람 승인 게이트가 어떻게 막아서는지 확인해 보라.',
  };
}
