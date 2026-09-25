// O VÍNCULO entre a nota original e a devolução, na lista e na ficha da nota,
// em módulo puro para ser testado em node.
//
// Antes (auditoria de 24/09/2026): o GET /fiscal/nfe/:id/devolucao/saldo — que
// já devolve as devoluções de uma venda com número e status, e o saldo de cada
// item — não era chamado por tela nenhuma. Na ficha da venda não aparecia quais
// devoluções ela tinha nem o que ainda dava para devolver; "Devolver" seguia
// oferecido numa nota já toda devolvida; o histórico mostrava códigos crus
// ("DEVOLUCAO_VINCULADA"); e na lista a devolução tinha a mesma cara de uma
// venda.
//
// Módulo PURO: sem React, sem fetch, sem DOM.

import type { SaldoResposta, DevolucaoDetalhe } from "@/app/fiscal/devolucao/contrato";

// ─────────────────────────────── selo na lista ───────────────────────────────

/** Selo da linha: "Devolução · entrada" / "Devolução · saída"; null para nota que não é devolução. */
export function seloDevolucao(nota: { finalidade?: string | null; tipoOperacao?: string | null }): string | null {
  if (nota.finalidade !== "DEVOLUCAO") return null;
  if (nota.tipoOperacao === "ENTRADA") return "Devolução · entrada";
  if (nota.tipoOperacao === "SAIDA") return "Devolução · saída";
  return "Devolução";
}

// ─────────────────────────────── histórico ───────────────────────────────

const ROTULOS_EVENTO_DEVOLUCAO: Readonly<Record<string, string>> = {
  DEVOLUCAO_RASCUNHO_CRIADO: "Devolução começada",
  DEVOLUCAO_ITENS_EDITADOS: "Devolução alterada",
  DEVOLUCAO_AUTORIZADA: "Devolução autorizada",
  DEVOLUCAO_VINCULADA: "Peça devolvida por uma devolução",
  DEVOLUCAO_SALDO_EXCEDIDO: "Atenção: devolução acima do que a nota original tinha",
};

/**
 * Rótulo do evento no histórico da ficha. Só os eventos da devolução ganham
 * texto; todo o resto sai exatamente como antes (o código do evento).
 */
export function rotuloEvento(ev: { evento?: unknown; detalhes?: unknown }): string {
  const codigo = typeof ev.evento === "string" ? ev.evento : "";
  const rotulo = Object.prototype.hasOwnProperty.call(ROTULOS_EVENTO_DEVOLUCAO, codigo)
    ? ROTULOS_EVENTO_DEVOLUCAO[codigo]
    : null;
  if (!rotulo) return codigo;
  const d = ev.detalhes && typeof ev.detalhes === "object" ? (ev.detalhes as Record<string, unknown>) : {};
  if ((codigo === "DEVOLUCAO_VINCULADA" || codigo === "DEVOLUCAO_SALDO_EXCEDIDO") && typeof d.nItem === "number") {
    const q = typeof d.quantidade === "number" ? `, quantidade ${String(d.quantidade).replace(".", ",")}` : "";
    return `${rotulo} (item ${d.nItem}${q})`;
  }
  if (codigo === "DEVOLUCAO_RASCUNHO_CRIADO" && typeof d.tipo === "string") {
    return `${rotulo} (${d.tipo === "COMPRA_SAIDA" ? "de compra" : "de venda"})`;
  }
  return rotulo;
}

// ─────────────────────────────── ficha da nota original ───────────────────────────────

const STATUS_ROTULO: Readonly<Record<string, string>> = {
  DRAFT: "rascunho",
  REJECTED: "recusada pela SEFAZ",
  // VALIDATING e SIGNING também são "em envio" para ela (o Dexo já está
  // mandando à SEFAZ) — sem eles, a ficha mostrava o código cru ("VALIDATING").
  VALIDATING: "em envio",
  SIGNING: "em envio",
  SENDING: "em envio",
  AUTHORIZED: "autorizada",
  CANCELLED: "cancelada",
  INUTILIZED: "inutilizada",
  DENIED: "denegada",
};

export interface DevolucoesDaNotaView {
  titulo: string;
  /** Uma linha por devolução: "NF-e 713 (série 1) — autorizada — itens 1 (1), 3 (2)". */
  devolucoes: Array<{ nfeId: string; texto: string; rascunho: boolean }>;
  /** Uma linha por item com o saldo: "Item 1 — Farol: devolvida 1 de 1, pode devolver 0". */
  saldo: string[];
  /** Nada mais a devolver: "Devolver" some. */
  totalmenteDevolvida: boolean;
  aviso: string | null;
}

export const TITULO_DEVOLUCOES_DA_NOTA = "Devoluções desta nota";
export const AVISO_TODA_DEVOLVIDA = "Todas as peças desta nota já foram devolvidas: não há mais o que devolver.";

function num(n: number | null | undefined): string {
  return n === null || n === undefined ? "?" : String(n).replace(".", ",");
}

export function viewDevolucoesDaNota(s: SaldoResposta): DevolucoesDaNotaView {
  const devolucoes = s.devolucoes.map((d) => {
    const qual = d.numero === null ? "Rascunho de devolução" : `NF-e ${d.numero} (série ${d.serie})`;
    const itens = d.itens.map((i) => `item ${i.nItem} (${num(i.quantidade)})`).join(", ");
    return {
      nfeId: d.nfeId,
      texto: `${qual} — ${STATUS_ROTULO[d.status] ?? d.status}${itens ? ` — ${itens}` : ""}`,
      rascunho: d.numero === null,
    };
  });
  const saldo = s.itens
    .filter((i) => i.devolvidaAutorizada > 0 || i.emProcessamento > 0 || i.emRascunho > 0)
    .map((i) => {
      const partes = [`devolvida ${num(i.devolvidaAutorizada)} de ${num(i.quantidadeOriginal)}`];
      if (i.emProcessamento > 0) partes.push(`em envio ${num(i.emProcessamento)}`);
      if (i.emRascunho > 0) partes.push(`em rascunho ${num(i.emRascunho)} (ainda não conta)`);
      if (i.disponivel !== null) partes.push(`pode devolver ${num(i.disponivel)}`);
      return `Item ${i.nItem} — ${i.descricao}: ${partes.join(", ")}`;
    });
  return {
    titulo: TITULO_DEVOLUCOES_DA_NOTA,
    devolucoes,
    saldo,
    totalmenteDevolvida: s.totalmenteDevolvida,
    aviso: s.totalmenteDevolvida ? AVISO_TODA_DEVOLVIDA : null,
  };
}

// ─────────────────────────────── ficha da devolução ───────────────────────────────

/** "Devolução da NF-e 710 (série 1) — nota do fornecedor". Vazio quando não há original. */
export function textoOriginaisDaDevolucao(d: Pick<DevolucaoDetalhe, "tipo" | "originais">): string[] {
  const de = d.tipo === "COMPRA_SAIDA" ? "nota do fornecedor" : "sua nota de venda";
  return d.originais.map((o) => `Devolução da NF-e ${o.numero} (série ${o.serie}) — ${de}`);
}
