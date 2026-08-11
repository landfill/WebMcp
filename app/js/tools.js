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
  findOrder,
  findItem,
  available,
  requestApproval,
  STATUS_FLOW,
} from './store.js';

// ---------------------------------------------------------------------------
// 상시 등록 도구
// ---------------------------------------------------------------------------

const alwaysOn = [
  {
    name: 'list_orders',
    description:
      '주문 목록을 조회한다. status 로 필터링할 수 있다. 어떤 주문을 처리할지 고르기 전에 먼저 호출하라.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: STATUS_FLOW,
          description: '이 상태의 주문만 반환한다. 생략하면 전체.',
        },
        limit: { type: 'number', description: '최대 개수 (기본 20)' },
      },
    },
    annotations: { readOnlyHint: true },
    execute({ status, limit = 20 }) {
      const rows = state.orders
        .filter((o) => !status || o.status === status)
        .slice(0, limit)
        .map((o) => ({
          id: o.id,
          customer: o.customer,
          status: o.status,
          items: o.items.map((i) => `${i.sku} x${i.qty}`).join(', '),
        }));
      return jsonResult({ count: rows.length, orders: rows });
    },
  },

  {
    name: 'get_order',
    description: '주문 하나의 상세 정보를 조회한다.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: '예: ORD-1002' },
      },
      required: ['orderId'],
    },
    annotations: { readOnlyHint: true },
    execute({ orderId }) {
      const order = findOrder(orderId);
      if (!order) return textResult(`주문을 찾을 수 없다: ${orderId}`);
      return jsonResult({
        ...order,
        items: order.items.map((i) => ({
          ...i,
          available: available(i.sku),
        })),
      });
    },
  },

  {
    name: 'check_inventory',
    description:
      '재고를 조회한다. sku 를 주면 해당 품목만, 생략하면 전체를 반환한다. onHand 는 실물 수량, reserved 는 이미 다른 주문에 할당된 수량이며 실제 가용 수량은 available 이다.',
    inputSchema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: '예: TRV-MUG' },
      },
    },
    annotations: { readOnlyHint: true },
    execute({ sku }) {
      const rows = state.inventory
        .filter((i) => !sku || i.sku === sku)
        .map((i) => ({ ...i, available: i.onHand - i.reserved }));
      if (sku && rows.length === 0)
        return textResult(`그런 SKU 는 없다: ${sku}`);
      return jsonResult(rows);
    },
  },

  {
    name: 'allocate_stock',
    description:
      '주문에 재고를 할당하고 상태를 allocated 로 바꾼다. 가용 재고가 모자라면 아무것도 바꾸지 않고 부족분을 보고한다.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
      },
      required: ['orderId'],
    },
    execute({ orderId }) {
      const order = findOrder(orderId);
      if (!order) return textResult(`주문을 찾을 수 없다: ${orderId}`);
      if (order.status !== 'pending')
        return textResult(
          `${orderId} 는 이미 ${order.status} 상태다. pending 주문만 할당할 수 있다.`,
        );

      const shortages = order.items
        .filter((i) => available(i.sku) < i.qty)
        .map((i) => `${i.sku}: 필요 ${i.qty}, 가용 ${available(i.sku)}`);

      if (shortages.length) {
        return textResult(
          `재고 부족으로 할당 실패.\n${shortages.join('\n')}\n` +
            `restock_item 으로 입고한 뒤 다시 시도하라.`,
        );
      }

      commit(`${orderId} 재고 할당`, () => {
        for (const i of order.items) findItem(i.sku).reserved += i.qty;
        order.status = 'allocated';
      });
      return textResult(`${orderId} 할당 완료. 상태: allocated`);
    },
  },

  {
    name: 'restock_item',
    description: '품목을 입고 처리해 실물 재고(onHand)를 늘린다.',
    inputSchema: {
      type: 'object',
      properties: {
        sku: { type: 'string' },
        qty: { type: 'number', description: '입고 수량 (1 이상)' },
      },
      required: ['sku', 'qty'],
    },
    execute({ sku, qty }) {
      const item = findItem(sku);
      if (!item) return textResult(`그런 SKU 는 없다: ${sku}`);
      if (!(qty > 0)) return textResult('qty 는 1 이상이어야 한다.');
      commit(`${sku} ${qty}개 입고`, () => {
        item.onHand += qty;
      });
      return textResult(
        `${sku} 입고 완료. onHand=${item.onHand}, available=${available(sku)}`,
      );
    },
  },

  {
    name: 'advance_order_status',
    description: `주문 상태를 다음 단계로 진행시킨다. 흐름: ${STATUS_FLOW.join(' → ')}`,
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
      },
      required: ['orderId'],
    },
    execute({ orderId }) {
      const order = findOrder(orderId);
      if (!order) return textResult(`주문을 찾을 수 없다: ${orderId}`);
      const idx = STATUS_FLOW.indexOf(order.status);
      if (idx === STATUS_FLOW.length - 1)
        return textResult(`${orderId} 는 이미 최종 상태(delivered)다.`);
      const next = STATUS_FLOW[idx + 1];
      commit(`${orderId} 상태 ${order.status} → ${next}`, () => {
        order.status = next;
      });
      return textResult(`${orderId} 상태를 ${next} 로 변경했다.`);
    },
  },

  {
    name: 'issue_refund',
    description:
      '주문을 환불 처리한다. 되돌릴 수 없는 작업이며 사람 승인이 필요하다. 승인 UI가 화면에 뜨고, 사용자가 누를 때까지 이 도구는 대기한다.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        reason: { type: 'string', description: '환불 사유' },
      },
      required: ['orderId', 'reason'],
    },
    annotations: { destructiveHint: true, idempotentHint: false },
    async execute({ orderId, reason }) {
      const order = findOrder(orderId);
      if (!order) return textResult(`주문을 찾을 수 없다: ${orderId}`);
      if (order.refunded) return textResult(`${orderId} 는 이미 환불됐다.`);

      const approved = await requestApproval(
        `${orderId} 환불`,
        `고객: ${order.customer} / 사유: ${reason}`,
      );
      if (!approved)
        return textResult(
          `사용자가 ${orderId} 환불을 거부했다. 아무것도 변경하지 않았다.`,
        );

      // 이미 할당된 주문이면 예약 재고를 반드시 반납한다.
      // 안 하면 reserved 가 영구히 새고, 재할당 시 이중 예약이 된다.
      const wasReserved = STATUS_FLOW.indexOf(order.status) >= 1;

      commit(`${orderId} 환불 (${reason})`, () => {
        if (wasReserved) {
          for (const i of order.items) {
            const item = findItem(i.sku);
            item.reserved = Math.max(0, item.reserved - i.qty);
          }
        }
        order.refunded = true;
        order.status = 'pending';
        order.note = `환불: ${reason}`;
      });
      return textResult(
        `${orderId} 환불 완료.` +
          (wasReserved ? ' 예약 재고를 반납했다.' : ''),
      );
    },
  },
];

// ---------------------------------------------------------------------------
// 조건부 도구: 주문 상세를 열었을 때만 등록된다 (도구 생명주기 데모)
// ---------------------------------------------------------------------------

let detachContextual = null;

export async function syncContextualTools() {
  const orderId = state.selectedOrderId;

  if (!orderId) {
    detachContextual?.();
    detachContextual = null;
    return;
  }
  if (detachContextual) return; // 이미 등록됨

  detachContextual = await registerTool({
    name: 'add_order_note',
    description:
      '현재 화면에 열려 있는 주문에 메모를 남긴다. 이 도구는 주문 상세 화면이 열려 있을 때만 존재한다.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    execute({ text }) {
      const order = findOrder(state.selectedOrderId);
      if (!order) return textResult('열려 있는 주문이 없다.');
      commit(`${order.id} 메모 추가`, () => {
        order.note = text;
      });
      return textResult(`${order.id} 에 메모를 남겼다: ${text}`);
    },
  });
}

export async function registerAllTools() {
  await registerAll(alwaysOn);
}
