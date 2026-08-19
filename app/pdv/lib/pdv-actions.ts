// PDV Balcão — Bloco D: menu "Ações" do livro do dia.
//
// Toda a UI nova fica atrás de NEXT_PUBLIC_PDV_ACTIONS_MENU_ENABLED. Com a
// flag ausente/desligada o livro do dia renderiza EXATAMENTE os dois botões de
// hoje ("Receber" e "NFC-e"), com o mesmo payload e o mesmo número de requests.
//
// Este módulo é PURO — sem React, sem fetch, sem I/O. A decisão de "o que
// aparece, o que desabilita e por quê" é uma tabela testável: nada de botão
// que erra em silêncio (requisito D.2).

import { excedeLimiteNfce } from "./pdv-nfce";

// Referências literais a process.env.NEXT_PUBLIC_* para o Next inlinar
// (mesma convenção de pdv-nfce.ts:9-13 — não há helper central de flags).
const ACTIONS_MENU_ENABLED =
  process.env.NEXT_PUBLIC_PDV_ACTIONS_MENU_ENABLED === "true";
const FISCAL_ENABLED = process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED === "true";
const SALE_CANCEL_ENABLED =
  process.env.NEXT_PUBLIC_SALE_CANCEL_ENABLED === "true";

/** Menu de ações do livro do dia habilitado? Flag OFF ⇒ UI da Fase 2. */
export function isPdvActionsMenuEnabled(): boolean {
  return ACTIONS_MENU_ENABLED;
}

/** Módulo fiscal ligado? Gate da NF-e 55 (independente da flag da NFC-e). */
export function isFiscalUiEnabled(): boolean {
  return FISCAL_ENABLED;
}

/**
 * Bloco E — UI de cancelamento de venda ligada?
 *
 * Só governa a UI. A permissão de verdade é o guard de backend
 * (`requireAction("pdv.cancelar-venda")`), que está SEMPRE ativo e cujo default
 * é permitir — então ligar esta flag não concede nada a ninguém, apenas revela
 * um botão para uma rota que já existia (e que até agora não tinha botão algum).
 */
export function isSaleCancelEnabled(): boolean {
  return SALE_CANCEL_ENABLED;
}

const PDV_EDIT_SALE_ENABLED =
  process.env.NEXT_PUBLIC_PDV_EDIT_SALE_ENABLED === "true";

/**
 * BLOCO E — botão "Editar" no livro do dia, para venda ainda NÃO recebida.
 *
 * Flag OFF ⇒ a coluna de ações renderiza exatamente como hoje e o operador
 * segue indo ao Financeiro. A regra de QUANDO editar (só PENDENTE/VENCIDA)
 * vive em `pdv-edit-sale.ts`; esta flag só governa a existência do botão.
 */
export function isPdvEditSaleEnabled(): boolean {
  return PDV_EDIT_SALE_ENABLED;
}

export type SaleStatusForActions =
  | "PENDENTE"
  | "PAGA"
  | "VENCIDA"
  | "CANCELADA";

// Vocabulário enxuto e estável para o cliente. O backend colapsa os 8 status
// de NfeEmitida (schema.prisma:1439) nestes 4 — VALIDATING/SIGNING/SENDING
// viram PROCESSING. CANCELLED/INUTILIZED nunca chegam aqui: o lookup os
// exclui, e uma nota cancelada deve mesmo liberar nova emissão.
export type FiscalDocStatus =
  | "AUTHORIZED"
  | "PROCESSING"
  | "REJECTED"
  | "DRAFT";

export interface FiscalDocSummary {
  modelo: "55" | "65";
  nfeId: string;
  status: FiscalDocStatus;
  numero: number | null;
  serie: number | null;
  /** Há PDF de DANFE/DANFCE gravado (NfeEmitida.danfePdfPath). */
  danfeDisponivel: boolean;
}

export type SaleActionKind = "receipt" | "nfce" | "nfe55" | "reverse";

export type SaleActionIntent =
  /** Emitir pela primeira vez, ou reemitir uma rejeitada. */
  | "emit"
  /** Nota já existe e não tem PDF pronto — consultar/abrir, nunca reemitir. */
  | "consult"
  /** Nota autorizada com PDF — baixar/imprimir o documento existente. */
  | "reprint"
  /** Recibo sem validade fiscal — gerado sob demanda, sempre. */
  | "download"
  /** Cancelar a venda: devolve o estoque e marca CANCELADA (Bloco E). */
  | "reverse";

export interface SaleAction {
  kind: SaleActionKind;
  label: string;
  intent: SaleActionIntent;
  visible: boolean;
  disabled: boolean;
  /** Motivo do disabled — vira tooltip. Nunca ausente quando disabled. */
  reason?: string;
  /** Nota alvo. Presente quando intent é "reprint" ou "consult". */
  nfeId?: string;
}

export interface BuildSaleActionsInput {
  status: SaleStatusForActions;
  totalAmount: number;
  /** isNfceUiEnabled() — exige módulo fiscal E flag da NFC-e. */
  nfceUi: boolean;
  /** isFiscalUiEnabled() — gate da NF-e 55. */
  fiscalUi: boolean;
  /**
   * Notas já vinculadas à venda pelo link textual numeroPedido="receivable:<id>".
   * `undefined` = ainda não consultado (menu fechado) ⇒ trata como "sem nota",
   * que é o estado seguro: oferece emitir, e a emissão é idempotente no backend.
   */
  docs?: FiscalDocSummary[];
  /**
   * Há caixa para EMITIR uma NFC-e nova neste contexto?
   *
   * true (default) = livro do dia do PDV, onde existe a cadeia de emissão com
   * o emitente multi-CNPJ selecionado. false = contextos de consulta (ex.: o
   * histórico de compras do cliente), onde reimprimir/consultar continuam
   * valendo mas emitir é operação de caixa.
   *
   * Default true preserva o comportamento da Fase 1 byte a byte.
   */
  nfceEmitAvailable?: boolean;
  /**
   * Bloco E — a UI de cancelamento está ligada E o operador tem a permissão?
   *
   * Ausente/false ⇒ a ação nem aparece. A permissão de verdade é o guard de
   * backend (`requireAction`); isto aqui só evita oferecer um botão que
   * responderia 403 — a UI reflete, não decide.
   */
  saleCancelUi?: boolean;
}

function reverseAction(input: BuildSaleActionsInput): SaleAction {
  const base = { kind: "reverse" as const, visible: input.saleCancelUi === true };

  if (input.status === "CANCELADA") {
    return {
      ...base,
      label: "Cancelar venda",
      intent: "reverse",
      disabled: true,
      reason: "Esta venda já está cancelada.",
    };
  }
  // O backend só estorna conta PAGA com itens (finance.usecase.ts:497-507).
  // Venda ainda não recebida não tem estoque baixado para devolver: o caminho
  // dela é excluir o título no Financeiro, não estornar.
  if (input.status !== "PAGA") {
    return {
      ...base,
      label: "Cancelar venda",
      intent: "reverse",
      disabled: true,
      reason: "Só vendas já recebidas podem ser estornadas.",
    };
  }
  return {
    ...base,
    label: "Cancelar venda",
    intent: "reverse",
    disabled: false,
  };
}

function nfceAction(
  input: BuildSaleActionsInput,
  doc: FiscalDocSummary | undefined,
): SaleAction {
  const base = { kind: "nfce" as const, visible: input.nfceUi };

  // Reimpressão ANTES de qualquer guard de status: cancelar a venda no Dexo
  // não cancela a nota (fluxos desacoplados — nfe-cancelamento.usecase.ts tem
  // prazo e justificativa próprios). Se a nota existe, o operador precisa
  // conseguir reimprimi-la mesmo com a venda cancelada.
  if (doc?.status === "AUTHORIZED" && doc.danfeDisponivel) {
    return {
      ...base,
      label: "Reimprimir NFC-e",
      intent: "reprint",
      nfeId: doc.nfeId,
      disabled: false,
    };
  }
  // Autorizada sem PDF renderizado, ou ainda em processamento na SEFAZ:
  // consultar. O POST /nfce é idempotente — devolve o estado atual e NÃO
  // emite de novo (finance.usecase.ts:679-705).
  if (doc?.status === "AUTHORIZED" || doc?.status === "PROCESSING") {
    return {
      ...base,
      label: "Consultar NFC-e",
      intent: "consult",
      nfeId: doc.nfeId,
      disabled: false,
    };
  }

  if (input.status === "CANCELADA") {
    return {
      ...base,
      label: "Emitir NFC-e",
      intent: "emit",
      disabled: true,
      reason: "Venda cancelada — não é possível emitir NFC-e.",
    };
  }
  if (input.status !== "PAGA") {
    return {
      ...base,
      label: "Emitir NFC-e",
      intent: "emit",
      disabled: true,
      reason: "Receba a venda antes de emitir a NFC-e.",
    };
  }
  if (excedeLimiteNfce(input.totalAmount)) {
    return {
      ...base,
      label: "Emitir NFC-e",
      intent: "emit",
      disabled: true,
      reason: "Venda acima de R$ 10.000 — use NF-e (modelo 55).",
    };
  }
  // Fora do caixa (histórico do cliente) não há cadeia de emissão nem
  // emitente selecionado — reimprimir/consultar acima continuam valendo.
  if (input.nfceEmitAvailable === false) {
    return {
      ...base,
      label: "Emitir NFC-e",
      intent: "emit",
      disabled: true,
      reason: "Emita a NFC-e pelo PDV Balcão.",
    };
  }
  return {
    ...base,
    label: doc?.status === "REJECTED" ? "Reemitir NFC-e" : "Emitir NFC-e",
    intent: "emit",
    disabled: false,
  };
}

function nfe55Action(
  input: BuildSaleActionsInput,
  doc: FiscalDocSummary | undefined,
): SaleAction {
  const base = { kind: "nfe55" as const, visible: input.fiscalUi };

  if (doc?.status === "AUTHORIZED" && doc.danfeDisponivel) {
    return {
      ...base,
      label: "Reimprimir NF-e",
      intent: "reprint",
      nfeId: doc.nfeId,
      disabled: false,
    };
  }
  // Rascunho/rejeitada/processando: o usuário finaliza no módulo Notas
  // Fiscais (fluxo atual, mais seguro — o NCM sai em branco do rascunho).
  // Nunca gerar um segundo rascunho para a mesma venda.
  if (doc) {
    return {
      ...base,
      label: "Abrir NF-e em Notas Fiscais",
      intent: "consult",
      nfeId: doc.nfeId,
      disabled: false,
    };
  }
  if (input.status === "CANCELADA") {
    return {
      ...base,
      label: "Gerar NF-e (modelo 55)",
      intent: "emit",
      disabled: true,
      reason: "Venda cancelada — não é possível gerar NF-e.",
    };
  }
  return {
    ...base,
    label: "Gerar NF-e (modelo 55)",
    intent: "emit",
    disabled: false,
  };
}

/**
 * Tabela de ações de uma venda do livro do dia.
 *
 * Sempre devolve as 3 ações (mesma ordem), cada uma com `visible`/`disabled`
 * resolvidos — o componente só renderiza. Ordem: recibo (sempre), NFC-e, NF-e.
 */
export function buildSaleActions(input: BuildSaleActionsInput): SaleAction[] {
  const nfce = input.docs?.find((d) => d.modelo === "65");
  const nfe = input.docs?.find((d) => d.modelo === "55");

  return [
    // Recibo sem validade fiscal: disponível em QUALQUER status. É o
    // comprovante interno da operação e serve inclusive para venda cancelada.
    {
      kind: "receipt",
      label: "Recibo simples",
      intent: "download",
      visible: true,
      disabled: false,
    },
    nfceAction(input, nfce),
    nfe55Action(input, nfe),
    // Destrutiva, por último e separada das impressões.
    reverseAction(input),
  ];
}

/**
 * Há nota fiscal emitida vinculada a esta venda?
 *
 * Cancelar a venda no Dexo NÃO cancela a nota: o cancelamento fiscal tem prazo
 * de 24h e justificativa própria (nfe-cancelamento.usecase.ts). Quem vai
 * cancelar precisa ser avisado disso ANTES de confirmar.
 */
export function emittedDocsFor(docs?: FiscalDocSummary[]): FiscalDocSummary[] {
  return (docs ?? []).filter(
    (d) => d.status === "AUTHORIZED" || d.status === "PROCESSING",
  );
}
