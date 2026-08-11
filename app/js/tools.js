/**
 * 이 페이지가 에이전트에게 노출하는 WebMCP 도구들.
 *
 * 설계 원칙:
 *  - 읽기 전용 도구는 annotations.readOnlyHint: true
 *  - 파괴적 도구는 destructiveHint + 사람 승인 게이트
 *  - 도구 하나 = 사용자가 UI에서 할 수 있는 의미 있는 작업 하나
 *  - 실패는 예외가 아니라 "무엇이 왜 안 됐는지"를 담은 텍스트로 반환한다
 */

import { registerAll, registerTool, textResult, jsonResult } from './webmcp.js';
import {
  state,
  commit,
  findBooking,
  findRoom,
  available,
  requestApproval,
  STATUS_FLOW,
  STATUS_LABEL,
  SHORTAGE_MARK,
} from './store.js';

const flowText = STATUS_FLOW.map(
  (s) => `${s}(${STATUS_LABEL[s]})`,
).join(' → ');

// ---------------------------------------------------------------------------
// 상시 등록 도구
// ---------------------------------------------------------------------------

const alwaysOn = [
  {
    name: 'list_bookings',
    description:
      '여행 예약 목록을 조회한다. status 로 필터링할 수 있다. 어떤 예약을 처리할지 고르기 전에 먼저 호출하라.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: STATUS_FLOW,
          description: '이 상태의 예약만 반환한다. 생략하면 전체.',
        },
        limit: { type: 'number', description: '최대 개수 (기본 20)' },
      },
    },
    annotations: { readOnlyHint: true },
    execute({ status, limit = 20 }) {
      const rows = state.bookings
        .filter((b) => !status || b.status === status)
        .slice(0, limit)
        .map((b) => ({
          id: b.id,
          guest: b.guest,
          status: b.status,
          checkIn: b.checkIn,
          nights: b.nights,
          rooms: b.rooms.map((r) => `${r.code} x${r.qty}`).join(', '),
        }));
      return jsonResult({ count: rows.length, bookings: rows });
    },
  },

  {
    name: 'get_booking',
    description: '예약 하나의 상세 정보를 조회한다.',
    inputSchema: {
      type: 'object',
      properties: {
        bookingId: { type: 'string', description: '예: BKG-2002' },
      },
      required: ['bookingId'],
    },
    annotations: { readOnlyHint: true },
    execute({ bookingId }) {
      const booking = findBooking(bookingId);
      if (!booking) return textResult(`예약을 찾을 수 없다: ${bookingId}`);
      return jsonResult({
        ...booking,
        rooms: booking.rooms.map((r) => ({
          ...r,
          name: findRoom(r.code)?.name ?? '(알 수 없는 객실)',
          available: available(r.code),
        })),
      });
    },
  },

  {
    name: 'check_availability',
    description:
      '객실 상품의 잔여 현황을 조회한다. roomCode 를 주면 해당 상품만, 생략하면 전체를 반환한다. total 은 확보한 총 객실 수, assigned 는 이미 다른 예약에 배정된 수이며 실제로 판매 가능한 수량은 available 이다.',
    inputSchema: {
      type: 'object',
      properties: {
        roomCode: { type: 'string', description: '예: JEJU-OCEAN' },
      },
    },
    annotations: { readOnlyHint: true },
    execute({ roomCode }) {
      const rows = state.rooms
        .filter((r) => !roomCode || r.code === roomCode)
        .map((r) => ({ ...r, available: r.total - r.assigned }));
      if (roomCode && rows.length === 0)
        return textResult(`그런 객실 상품은 없다: ${roomCode}`);
      return jsonResult(rows);
    },
  },

  {
    name: 'assign_rooms',
    description:
      '예약에 객실을 배정하고 상태를 confirmed 로 바꾼다. 잔여 객실이 모자라면 아무것도 바꾸지 않고 부족분을 보고한다.',
    inputSchema: {
      type: 'object',
      properties: {
        bookingId: { type: 'string' },
      },
      required: ['bookingId'],
    },
    execute({ bookingId }) {
      const booking = findBooking(bookingId);
      if (!booking) return textResult(`예약을 찾을 수 없다: ${bookingId}`);
      // 취소된 예약은 status 가 requested 로 돌아가 있다(객실을 반납했으므로).
      // 상태만 보면 "아직 배정 안 된 예약"과 구별되지 않아 다시 집히고,
      // 반납했던 객실을 도로 점유한다.
      if (booking.cancelled)
        return textResult(
          `${bookingId} 는 취소·환불된 예약이라 배정할 수 없다. ` +
            `투숙객이 다시 여행을 원하면 새 예약을 만들어야 한다.`,
        );
      if (booking.status !== 'requested')
        return textResult(
          `${bookingId} 는 이미 ${booking.status} 상태다. requested 예약만 배정할 수 있다.`,
        );

      const shortages = booking.rooms
        .filter((r) => available(r.code) < r.qty)
        .map((r) => `${r.code}: 필요 ${r.qty}실, 잔여 ${available(r.code)}실`);

      if (shortages.length) {
        return textResult(
          `${SHORTAGE_MARK}으로 배정 실패.\n${shortages.join('\n')}\n` +
            `open_room_block 으로 객실을 추가 확보한 뒤 다시 시도하라.`,
        );
      }

      commit(`${bookingId} 객실 배정`, () => {
        for (const r of booking.rooms) findRoom(r.code).assigned += r.qty;
        booking.status = 'confirmed';
      });
      return textResult(`${bookingId} 배정 완료. 상태: confirmed`);
    },
  },

  {
    name: 'open_room_block',
    description:
      '호텔에서 객실을 추가로 확보해 판매 가능한 총 객실 수(total)를 늘린다. 잔여가 모자라 배정이 막혔을 때 사용한다.',
    inputSchema: {
      type: 'object',
      properties: {
        roomCode: { type: 'string' },
        qty: { type: 'number', description: '추가 확보할 객실 수 (1 이상)' },
      },
      required: ['roomCode', 'qty'],
    },
    execute({ roomCode, qty }) {
      const room = findRoom(roomCode);
      if (!room) return textResult(`그런 객실 상품은 없다: ${roomCode}`);
      if (!(qty > 0)) return textResult('qty 는 1 이상이어야 한다.');
      commit(`${roomCode} ${qty}실 추가 확보`, () => {
        room.total += qty;
      });
      return textResult(
        `${roomCode} 추가 확보 완료. total=${room.total}, available=${available(roomCode)}`,
      );
    },
  },

  {
    name: 'advance_booking_status',
    description: `예약 상태를 다음 단계로 진행시킨다. 흐름: ${flowText}`,
    inputSchema: {
      type: 'object',
      properties: {
        bookingId: { type: 'string' },
      },
      required: ['bookingId'],
    },
    execute({ bookingId }) {
      const booking = findBooking(bookingId);
      if (!booking) return textResult(`예약을 찾을 수 없다: ${bookingId}`);
      // 같은 이유로 여기도 막는다. 안 막으면 취소된 예약이 객실을 한 실도
      // 잡지 않은 채 confirmed 로 올라선다.
      if (booking.cancelled)
        return textResult(
          `${bookingId} 는 취소·환불된 예약이라 진행시킬 수 없다.`,
        );
      const idx = STATUS_FLOW.indexOf(booking.status);
      if (idx === STATUS_FLOW.length - 1)
        return textResult(`${bookingId} 는 이미 최종 상태(completed)다.`);
      const next = STATUS_FLOW[idx + 1];
      commit(`${bookingId} 상태 ${booking.status} → ${next}`, () => {
        booking.status = next;
      });
      return textResult(
        `${bookingId} 상태를 ${next}(${STATUS_LABEL[next]}) 로 변경했다.`,
      );
    },
  },

  {
    name: 'cancel_booking',
    description:
      '예약을 취소하고 결제 금액을 환불 처리한다. 되돌릴 수 없는 작업이며 사람 승인이 필요하다. 승인 UI가 화면에 뜨고, 사용자가 누를 때까지 이 도구는 대기한다.',
    inputSchema: {
      type: 'object',
      properties: {
        bookingId: { type: 'string' },
        reason: { type: 'string', description: '취소 사유' },
      },
      required: ['bookingId', 'reason'],
    },
    annotations: { destructiveHint: true, idempotentHint: false },
    async execute({ bookingId, reason }) {
      const booking = findBooking(bookingId);
      if (!booking) return textResult(`예약을 찾을 수 없다: ${bookingId}`);
      if (booking.cancelled)
        return textResult(`${bookingId} 는 이미 취소·환불됐다.`);

      const approved = await requestApproval(
        `${bookingId} 취소 및 환불`,
        `투숙객: ${booking.guest} / 체크인 ${booking.checkIn} ${booking.nights}박 / 사유: ${reason}`,
      );
      if (!approved)
        return textResult(
          `사용자가 ${bookingId} 취소를 거부했다. 아무것도 변경하지 않았다.`,
        );

      // 이미 배정된 예약이면 잡아 둔 객실을 반드시 반납한다.
      // 안 하면 assigned 가 영구히 새고, 재배정 시 이중 점유가 된다.
      const wasAssigned = STATUS_FLOW.indexOf(booking.status) >= 1;

      commit(`${bookingId} 취소·환불 (${reason})`, () => {
        if (wasAssigned) {
          for (const r of booking.rooms) {
            const room = findRoom(r.code);
            room.assigned = Math.max(0, room.assigned - r.qty);
          }
        }
        booking.cancelled = true;
        booking.status = 'requested';
        booking.note = `취소·환불: ${reason}`;
      });
      return textResult(
        `${bookingId} 취소 및 환불 완료.` +
          (wasAssigned ? ' 배정했던 객실을 반납했다.' : ''),
      );
    },
  },
];

// ---------------------------------------------------------------------------
// 조건부 도구: 예약 상세를 열었을 때만 등록된다 (도구 생명주기 데모)
// ---------------------------------------------------------------------------

let detachContextual = null;

export async function syncContextualTools() {
  const bookingId = state.selectedBookingId;

  if (!bookingId) {
    detachContextual?.();
    detachContextual = null;
    return;
  }
  if (detachContextual) return; // 이미 등록됨

  detachContextual = await registerTool({
    name: 'add_booking_note',
    description:
      '현재 화면에 열려 있는 예약에 메모를 남긴다. 이 도구는 예약 상세 화면이 열려 있을 때만 존재한다.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    execute({ text }) {
      const booking = findBooking(state.selectedBookingId);
      if (!booking) return textResult('열려 있는 예약이 없다.');
      commit(`${booking.id} 메모 추가`, () => {
        booking.note = text;
      });
      return textResult(`${booking.id} 에 메모를 남겼다: ${text}`);
    },
  });
}

export async function registerAllTools() {
  await registerAll(alwaysOn);
}
