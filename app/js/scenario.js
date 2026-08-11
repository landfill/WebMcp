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

import { state } from './store.js';

export async function* scenario() {
  yield {
    kind: 'observe',
    why: '사용자가 "밀린 주문 처리해줘"라고 했다. 먼저 무엇이 밀려 있는지 본다. 목록을 모르면 아무것도 정할 수 없다.',
    tool: 'list_orders',
    args: { status: 'pending' },
    focus: { status: 'pending' },
  };

  // ↓ 이 시점의 실제 상태를 읽는다
  const pending = state.orders.filter((o) => o.status === 'pending');

  if (pending.length === 0) {
    yield {
      kind: 'done',
      why: 'pending 주문이 없다. 할 일이 없으므로 여기서 멈춘다. "처음부터"를 눌러 상태를 되돌릴 수 있다.',
    };
    return;
  }

  for (const order of pending) {
    const result = yield {
      kind: 'act',
      why: `${order.id} 을 처리한다. 재고를 할당해 보면 가능한지 아닌지 알 수 있다.`,
      tool: 'allocate_stock',
      args: { orderId: order.id },
      focus: { orders: [order.id], skus: order.items.map((i) => i.sku) },
    };

    if (!String(result).includes('재고 부족')) continue;

    // ── 실패했다. 여기가 이 시나리오의 핵심 ──
    yield {
      kind: 'fail',
      why:
        '실패했다. 그런데 도구가 예외를 던진 게 아니라 "무엇이 왜 안 됐는지"를 ' +
        '문장으로 돌려줬다. 그래서 다음 수를 스스로 정할 수 있다. ' +
        '먼저 재고 현황을 정확히 확인한다.',
      tool: 'check_inventory',
      args: {},
      focus: { skus: order.items.map((i) => i.sku) },
    };

    for (const item of order.items) {
      const inv = state.inventory.find((i) => i.sku === item.sku);
      const avail = inv.onHand - inv.reserved;
      if (avail >= item.qty) continue;

      const need = item.qty - avail;
      yield {
        kind: 'recover',
        why: `${item.sku} 가 ${need}개 모자란다 (필요 ${item.qty}, 가용 ${avail}). 입고 처리한다.`,
        tool: 'restock_item',
        args: { sku: item.sku, qty: need },
        focus: { skus: [item.sku] },
      };
    }

    yield {
      kind: 'recover',
      why: '막힌 원인을 없앴으니 같은 작업을 다시 시도한다.',
      tool: 'allocate_stock',
      args: { orderId: order.id },
      focus: { orders: [order.id], skus: order.items.map((i) => i.sku) },
    };
  }

  // 할당된 것들을 출고
  for (const order of state.orders.filter((o) => o.status === 'allocated')) {
    yield {
      kind: 'act',
      why: `${order.id} 는 재고가 잡혔다. 다음 단계인 출고로 진행시킨다.`,
      tool: 'advance_order_status',
      args: { orderId: order.id },
      focus: { orders: [order.id] },
    };
  }

  yield {
    kind: 'done',
    why:
      '밀린 주문을 모두 처리했다. 환불처럼 되돌릴 수 없는 작업은 지시받지 않았으므로 하지 않는다. ' +
      '아래 "수동 호출"에서 issue_refund 를 직접 불러 사람 승인 게이트가 어떻게 막아서는지 확인해 보라.',
  };
}
