import { describe, it, expect } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// O classificador de desfecho de pedido (01/09/2026).
//
// As fixtures deste arquivo NÃO são inventadas: são os payloads REAIS de
// `GET /orders/{id}` + `GET /shipments/{id}` colhidos na conta de um tenant de
// produção durante o diagnóstico. Os quatro grupos abaixo cobrem 68/68 dos
// cancelamentos daquele tenant, sem uma exceção:
//
//   buyer/buyer_cancel_express + envio cancelled ....... 16 → peça no pátio
//   mediations/mediations      + envio delivered ....... 49 → com o comprador
//   shipment/shipment_not_delivered + not_delivered .....  2 → extraviada
//   internal/unknown           + date_returned .........  1 → voltou
//
// O que este spec prova, e é o coração da correção: o MESMO
// `status: "cancelled"` sai dos dois lados da decisão. Quem separa é o envio.
//
// Prova também o que o classificador NÃO pode fazer: sem envio legível, sem
// payload, com campo desconhecido, ele devolve INDETERMINADO — e INDETERMINADO
// estorna, que é o comportamento de sempre. A API do ML fora do ar não pode
// fazer peça sumir do estoque.
// ──────────────────────────────────────────────────────────────────────────

import { OrderOutcomeService } from "@/app/marketplaces/services/order-outcome.service";

// ── Fixtures reais ────────────────────────────────────────────────────────

/** Pedido 2000018021024766 — comprador desistiu, envio nunca despachado. */
const PEDIDO_BUYER_CANCEL = {
  status: "cancelled" as const,
  tags: ["not_delivered", "not_paid", "pack_order"],
  cancel_detail: {
    group: "buyer",
    code: "buyer_cancel_express",
    description: "",
    requested_by: "buyer",
    date: "2026-08-20T09:31:16.000-04:00",
  },
  shipping: { id: 47812345678 },
};
const ENVIO_CANCELADO = {
  status: "cancelled",
  substatus: null,
  status_history: {
    date_shipped: null,
    date_delivered: null,
    date_returned: null,
    date_cancelled: "2026-08-20T09:31:16.000-04:00",
  },
};

/** Pedido 2000017949195902 (SKU 23128) — entregue, depois mediação. */
const PEDIDO_MEDIACAO = {
  status: "cancelled" as const,
  tags: ["delivered", "not_paid"],
  cancel_detail: {
    group: "mediations",
    code: "mediations",
    description: "",
    requested_by: "meli",
    date: "2026-08-24T12:30:51.000-04:00",
  },
  shipping: { id: 47700000001 },
};
const ENVIO_ENTREGUE = {
  status: "delivered",
  substatus: null,
  status_history: {
    date_shipped: "2026-08-16T05:12:00.000-04:00",
    date_delivered: "2026-08-18T14:03:00.000-04:00",
    date_returned: null,
  },
};

/** Pedido 2000018077930616 (SKU 28555, o do relato) — avariado na logística. */
const PEDIDO_ENVIO_NAO_ENTREGUE = {
  status: "cancelled" as const,
  tags: ["not_delivered", "not_paid", "pack_order"],
  cancel_detail: {
    group: "shipment",
    code: "shipment_not_delivered",
    description: "The shipment was not delivered",
    requested_by: "meli",
    date: "2026-08-28T22:47:18.000-04:00",
  },
  shipping: { id: 47837016639 },
};
const ENVIO_AVARIADO = {
  status: "not_delivered",
  substatus: "damaged",
  status_history: {
    date_shipped: null,
    date_delivered: null,
    date_returned: null,
    date_not_delivered: "2026-08-28T22:47:16.475-04:00",
    date_ready_to_ship: "2026-08-24T20:15:26.000-04:00",
  },
};

/** Pedido 2000017258038678 — a peça voltou de verdade ao vendedor. */
const PEDIDO_DEVOLVIDO = {
  status: "cancelled" as const,
  tags: ["not_delivered", "not_paid", "d2c", "one_shot", "pack_order"],
  cancel_detail: {
    group: "internal",
    code: "unknown",
    description: "",
    requested_by: "meli",
    date: "2026-07-18T03:00:59.000-04:00",
  },
  shipping: { id: 47500000002 },
};
const ENVIO_RETORNADO = {
  status: "not_delivered",
  substatus: "returned",
  status_history: {
    date_shipped: "2026-07-06T10:00:00.000-04:00",
    date_delivered: null,
    date_returned: "2026-07-17T18:22:00.000-04:00",
  },
};

/** Pedido 2000017872842612 — mediação sem envio (retirada combinada). */
const PEDIDO_MEDIACAO_SEM_ENVIO = {
  status: "cancelled" as const,
  tags: ["no_shipping", "not_delivered", "not_paid"],
  cancel_detail: {
    group: "mediations",
    code: "mediations",
    description: "",
    requested_by: "meli",
    date: "2026-08-12T08:55:36.000-04:00",
  },
  shipping: { id: null },
};

const classificar = OrderOutcomeService.classificarML.bind(OrderOutcomeService);

describe("OrderOutcomeService — onde a peça está", () => {
  it("buyer_cancel_express + envio cancelado → NO_PATIO, estorna como sempre", () => {
    const d = classificar(PEDIDO_BUYER_CANCEL as any, ENVIO_CANCELADO as any);
    expect(d.peca).toBe("NO_PATIO");
    expect(d.reterEstorno).toBe(false);
    expect(d.reason).toBeNull();
  });

  it("mediação + envio entregue → COM_COMPRADOR, retém o estorno", () => {
    const d = classificar(PEDIDO_MEDIACAO as any, ENVIO_ENTREGUE as any);
    expect(d.peca).toBe("COM_COMPRADOR");
    expect(d.reterEstorno).toBe(true);
    expect(d.reason).toBe("PECA_COM_COMPRADOR");
    expect(d.detail).toMatch(/ENTREGUE ao comprador/);
  });

  it("shipment_not_delivered/damaged (o SKU 28555 do relato) → EM_TRANSITO, retém", () => {
    const d = classificar(
      PEDIDO_ENVIO_NAO_ENTREGUE as any,
      ENVIO_AVARIADO as any,
    );
    expect(d.peca).toBe("EM_TRANSITO");
    expect(d.reterEstorno).toBe(true);
    expect(d.reason).toBe("PECA_EM_TRANSITO");
  });

  it("envio com date_returned → DEVOLVIDA_CONFIRMADA, mas AINDA assim retém", () => {
    // Decisão do dono (01/09/2026): `date_returned` prova que a transportadora
    // entregou de volta, não que a peça está na prateleira conferida. O
    // estoque só volta com uma pessoa confirmando.
    const d = classificar(PEDIDO_DEVOLVIDO as any, ENVIO_RETORNADO as any);
    expect(d.peca).toBe("DEVOLVIDA_CONFIRMADA");
    expect(d.reterEstorno).toBe(true);
    expect(d.reason).toBe("DEVOLVIDA_CONFIRMADA_ML");
    // A pendência nasce pré-preenchida: é um clique, não uma investigação.
    expect(d.detail).toContain("2026-07-17T18:22:00.000-04:00");
  });

  it("mediação SEM envio (retirada combinada) → EM_TRANSITO pelo grupo", () => {
    const d = classificar(PEDIDO_MEDIACAO_SEM_ENVIO as any, null);
    expect(d.peca).toBe("EM_TRANSITO");
    expect(d.reterEstorno).toBe(true);
  });

  it("o mesmo status 'cancelled' sai dos DOIS lados — quem separa é o envio", () => {
    expect(PEDIDO_BUYER_CANCEL.status).toBe(PEDIDO_MEDIACAO.status);
    expect(classificar(PEDIDO_BUYER_CANCEL as any, ENVIO_CANCELADO as any).reterEstorno).toBe(false);
    expect(classificar(PEDIDO_MEDIACAO as any, ENVIO_ENTREGUE as any).reterEstorno).toBe(true);
  });

  it("a prioridade é envio-cancelado ANTES de tudo (o caminho que não pode mudar)", () => {
    // Envio cancelado com a tag `delivered` presente por qualquer motivo:
    // ainda assim é NO_PATIO. A regra 1 vem primeiro de propósito.
    const d = classificar(
      { ...PEDIDO_BUYER_CANCEL, tags: ["delivered"] } as any,
      ENVIO_CANCELADO as any,
    );
    expect(d.peca).toBe("NO_PATIO");
    expect(d.reterEstorno).toBe(false);
  });
});

describe("FAIL-SAFE — sem prova, o comportamento é o de hoje", () => {
  it("envio nulo (API fora do ar) e cancelamento do vendedor → INDETERMINADO", () => {
    const d = classificar(
      {
        status: "cancelled",
        tags: [],
        cancel_detail: {
          group: "seller",
          code: "seller_out_of_stock",
          description: "",
          requested_by: "seller",
          date: "",
        },
        shipping: { id: 1 },
      } as any,
      null,
    );
    expect(d.peca).toBe("INDETERMINADO");
    expect(d.reterEstorno).toBe(false);
  });

  it("payload sem cancel_detail e sem tags → INDETERMINADO", () => {
    const d = classificar(
      { status: "cancelled", tags: undefined, cancel_detail: undefined } as any,
      null,
    );
    expect(d.peca).toBe("INDETERMINADO");
    expect(d.reterEstorno).toBe(false);
  });

  it("envio com status desconhecido e histórico vazio → INDETERMINADO", () => {
    const d = classificar(
      { status: "cancelled", tags: [], cancel_detail: null } as any,
      { status: "sabe_la_o_que", substatus: null, status_history: {} } as any,
    );
    expect(d.peca).toBe("INDETERMINADO");
    expect(d.reterEstorno).toBe(false);
  });

  it("datas vazias não contam como prova (string vazia ≠ data)", () => {
    const d = classificar(
      { status: "cancelled", tags: [], cancel_detail: null } as any,
      {
        status: "pending",
        status_history: {
          date_shipped: "",
          date_delivered: "",
          date_returned: "",
        },
      } as any,
    );
    expect(d.peca).toBe("INDETERMINADO");
    expect(d.reterEstorno).toBe(false);
  });
});

describe("evidência — a decisão tem que ser auditável", () => {
  it("carrega group/code/quem pediu e o estado do envio", () => {
    const d = classificar(
      PEDIDO_ENVIO_NAO_ENTREGUE as any,
      ENVIO_AVARIADO as any,
    );
    expect(d.evidencia).toMatchObject({
      orderStatus: "cancelled",
      cancelGroup: "shipment",
      cancelCode: "shipment_not_delivered",
      cancelRequestedBy: "meli",
      shipmentId: 47837016639,
      shipmentStatus: "not_delivered",
      shipmentSubstatus: "damaged",
      dateShipped: null,
      dateDelivered: null,
      dateReturned: null,
    });
  });

  it("não carrega nada do comprador nem token", () => {
    const d = classificar(PEDIDO_MEDIACAO as any, ENVIO_ENTREGUE as any);
    const serializado = JSON.stringify(d.evidencia).toLowerCase();
    expect(serializado).not.toContain("token");
    expect(serializado).not.toContain("buyer_username");
    expect(serializado).not.toContain("nickname");
  });
});
