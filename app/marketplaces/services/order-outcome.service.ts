import type {
  MLOrderDetails,
  MLShipmentDetails,
} from "../types/ml-order.types";

/**
 * Onde a peça está quando o marketplace encerra o pedido.
 *
 * O ML usa UM único estado terminal (`status: "cancelled"`) para duas coisas
 * opostas, e o sistema tratava as duas igual:
 *
 *  - cancelamento ANTES do envio — a peça nunca saiu do pátio, o estorno `+1`
 *    está certo e não pode mudar;
 *  - devolução DEPOIS do envio/entrega — a peça está com o comprador (ou
 *    extraviada), e o estorno recria estoque que não existe, reabre o anúncio e
 *    outra pessoa compra o que a loja não tem.
 *
 * Varredura de 68 cancelamentos de um tenant real contra a API do ML
 * (01/09/2026) — a separação é limpa e NÃO teve uma exceção:
 *
 * | cancel_detail.group | shipping.status | n  | onde a peça está  |
 * | ------------------- | --------------- | -- | ----------------- |
 * | buyer               | cancelled       | 16 | no pátio          |
 * | mediations          | delivered       | 49 | com o comprador   |
 * | shipment            | not_delivered   |  2 | extraviada        |
 * | internal            | returned        |  1 | voltou de verdade |
 *
 * 51 dos 68 estornos (75%) estavam errados. 20 peças estavam à venda naquele
 * instante, em 48 anúncios, R$ 2.576,90 expostos.
 *
 * ⚠️ O ATALHO DO TEMPO NÃO FUNCIONA. "Estorno tardio = devolução" foi testado e
 * é falso nos dois sentidos: o pedido 2000017407259734 é `buyer_cancel_express`
 * 7,2 DIAS depois (envio cancelado, peça no pátio) e o 2000017872842612 é
 * `mediations` com 1,08 dia. As caudas se cruzam — classificar EXIGE o payload.
 */
export type DesfechoPeca =
  /** Nunca saiu do pátio. Estorna, exatamente como sempre. */
  | "NO_PATIO"
  /** O marketplace registrou a devolução como concluída (`date_returned`). */
  | "DEVOLVIDA_CONFIRMADA"
  /** Entregue ao comprador. Não volta sozinha. */
  | "COM_COMPRADOR"
  /** Saiu e não chegou: em trânsito, extraviada ou avariada. */
  | "EM_TRANSITO"
  /** Sem prova de nada. Estorna, exatamente como sempre. */
  | "INDETERMINADO";

/**
 * Motivos de pendência de devolução. String (não enum do Prisma) para que um
 * motivo novo não exija migração — mesma decisão de `OrderIngestionIssueReason`.
 */
export type OrderReturnPendencyReason =
  /** Entregue ao comprador e o pedido virou devolução/reclamação. */
  | "PECA_COM_COMPRADOR"
  /** Saiu do pátio e não chegou: em trânsito de volta, extraviada ou avariada. */
  | "PECA_EM_TRANSITO"
  /** O próprio marketplace registrou a devolução como concluída. */
  | "DEVOLVIDA_CONFIRMADA_ML"
  /** Shopee pediu devolução sobre um pedido já entregue (`TO_RETURN`). */
  | "SHOPEE_TO_RETURN"
  /** Reembolso parcial: exige decisão explícita, nunca mexe em estoque sozinho. */
  | "ML_PARTIALLY_REFUNDED";

export interface DesfechoPedido {
  peca: DesfechoPeca;
  /**
   * `true` ⇒ o estoque NÃO volta agora e o anúncio NÃO reabre.
   * `false` ⇒ caminho de hoje, byte-idêntico.
   */
  reterEstorno: boolean;
  /** Preenchido só quando `reterEstorno`. */
  reason: OrderReturnPendencyReason | null;
  detail: string | null;
  /** Evidência auditável da decisão. Sem token, sem dado do comprador. */
  evidencia: Record<string, unknown>;
}

function textoData(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Decide, a partir do payload do pedido e do envio, se o estorno de estoque
 * pode acontecer agora.
 *
 * PRINCÍPIO, e ele governa todas as regras: o default é O COMPORTAMENTO DE
 * HOJE. Só RETÉM o estorno com PROVA POSITIVA de que a peça saiu. Payload
 * ausente, envio ilegível, campo desconhecido, API fora do ar ⇒
 * `INDETERMINADO` ⇒ estorna igual a sempre. Errar para o lado de estornar
 * mantém o furo antigo; errar para o outro lado faz peça REAL sumir do
 * estoque, que é trocar um furo por outro.
 *
 * Função PURA: nenhum I/O, nenhuma leitura de env. Quem decide se sequer chama
 * isto é o caller, pelo kill-switch ORDER_RETURN_HOLD_DISABLED.
 */
export class OrderOutcomeService {
  static classificarML(
    mlOrder: Pick<MLOrderDetails, "status" | "tags" | "cancel_detail"> & {
      shipping?: { id?: number | null } | null;
    },
    shipment: MLShipmentDetails | null,
  ): DesfechoPedido {
    const tags = Array.isArray(mlOrder?.tags) ? mlOrder.tags : [];
    const cancelDetail = (mlOrder?.cancel_detail ?? null) as {
      group?: string | null;
      code?: string | null;
      requested_by?: string | null;
    } | null;
    const grupo = cancelDetail?.group ?? null;
    const historico = shipment?.status_history ?? null;
    const statusEnvio = shipment?.status ?? null;

    const dataRetorno = textoData(historico?.date_returned);
    const dataEntrega = textoData(historico?.date_delivered);
    const dataEnvio = textoData(historico?.date_shipped);

    const evidencia: Record<string, unknown> = {
      orderStatus: mlOrder?.status ?? null,
      tags,
      cancelGroup: grupo,
      cancelCode: cancelDetail?.code ?? null,
      cancelRequestedBy: cancelDetail?.requested_by ?? null,
      shipmentId: mlOrder?.shipping?.id ?? null,
      shipmentStatus: statusEnvio,
      shipmentSubstatus: shipment?.substatus ?? null,
      dateShipped: dataEnvio,
      dateDelivered: dataEntrega,
      dateReturned: dataRetorno,
    };

    const manter = (peca: DesfechoPeca): DesfechoPedido => ({
      peca,
      reterEstorno: false,
      reason: null,
      detail: null,
      evidencia,
    });
    const reter = (
      peca: DesfechoPeca,
      reason: OrderReturnPendencyReason,
      detail: string,
    ): DesfechoPedido => ({
      peca,
      reterEstorno: true,
      reason,
      detail,
      evidencia,
    });

    // 1. Envio cancelado ⇒ a peça NUNCA saiu. É o único sinal positivo de "está
    //    no pátio", e cobriu 16/16 dos `buyer_cancel_express` reais. Vem antes
    //    de tudo: este é o caminho que não pode mudar.
    if (statusEnvio === "cancelled") return manter("NO_PATIO");

    // 2. O ML registrou a devolução como concluída. A peça voltou — mas quem
    //    repõe o estoque é o operador, não esta função (decisão do dono,
    //    01/09/2026): `date_returned` diz que a transportadora entregou de
    //    volta, não que a peça está na prateleira conferida. A pendência nasce
    //    pré-preenchida, então é um clique.
    if (dataRetorno) {
      return reter(
        "DEVOLVIDA_CONFIRMADA",
        "DEVOLVIDA_CONFIRMADA_ML",
        `O Mercado Livre registrou a devolução em ${dataRetorno}. Confira a peça na prateleira e confirme o recebimento.`,
      );
    }

    // 3. Entregue ao comprador. Foi o desfecho de 49 dos 68 casos — todos com
    //    `cancel_detail.group = "mediations"`. A peça não volta sozinha.
    if (
      dataEntrega ||
      statusEnvio === "delivered" ||
      tags.includes("delivered")
    ) {
      return reter(
        "COM_COMPRADOR",
        "PECA_COM_COMPRADOR",
        "A peça foi ENTREGUE ao comprador e o pedido virou devolução/reclamação. Confirme se ela voltou ao pátio antes de repor o estoque.",
      );
    }

    // 4. Saiu e não chegou: em trânsito de volta, extraviada ou avariada. Foi o
    //    caso do SKU 28555 (`shipment_not_delivered` / substatus `damaged`).
    if (
      dataEnvio ||
      statusEnvio === "shipped" ||
      statusEnvio === "not_delivered" ||
      statusEnvio === "returned"
    ) {
      return reter(
        "EM_TRANSITO",
        "PECA_EM_TRANSITO",
        "A peça saiu do pátio e não está com o comprador (em trânsito de volta, extraviada ou avariada). Confirme o recebimento físico antes de repor o estoque.",
      );
    }

    // 5. Sem envio legível, mas o pedido foi encerrado por mediação ou por
    //    problema de envio — os dois só existem DEPOIS que a peça saiu. Cobre o
    //    caso real de `no_shipping` (retirada combinada) com mediação aberta.
    if (grupo === "mediations" || grupo === "shipment") {
      return reter(
        "EM_TRANSITO",
        "PECA_EM_TRANSITO",
        `O pedido foi encerrado pelo Mercado Livre (${grupo}) e não há envio que prove que a peça ficou no pátio. Confirme onde ela está.`,
      );
    }

    // 6. Nada provado ⇒ comportamento de sempre. Inclui o cancelamento do
    //    próprio vendedor por indisponibilidade, que NÃO apareceu nos 68 casos
    //    e por isso não ganha regra própria: chutar aqui seria inventar.
    return manter("INDETERMINADO");
  }
}
