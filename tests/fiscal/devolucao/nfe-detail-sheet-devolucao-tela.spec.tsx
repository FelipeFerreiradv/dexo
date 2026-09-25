// @vitest-environment jsdom
//
// A FICHA da nota montada, no que a devolução acrescentou — o fio entre as
// peças que os outros specs testam soltas:
//  - a venda toda devolvida: a ficha lê o saldo, mostra a devolução e o
//    "Devolver" SOME (antes seguia oferecido e o clique respondia "Todos os
//    itens desta nota já foram devolvidos");
//  - o histórico traduz os eventos da devolução e deixa os outros como eram.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ sessao: { data: { user: { email: "dona@dls.test" } }, status: "authenticated" as const } }));
vi.mock("next-auth/react", () => ({ useSession: () => h.sessao }));
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));
vi.mock("@/components/ui/sheet", async () => {
  const { createElement: e } = await import("react");
  return {
    Sheet: ({ open, children }: any) => (open ? e("div", null, children) : null),
    SheetContent: ({ children }: any) => e("div", null, children),
    SheetTitle: ({ children }: any) => e("h2", null, children),
  };
});
vi.mock("../../../app/notas-fiscais/components/nfe-status-badge", async () => {
  const { createElement: e } = await import("react");
  return { NfeStatusBadge: ({ status }: any) => e("span", null, status) };
});
vi.mock("../../../app/notas-fiscais/components/numeracao-actions", () => ({ NumeracaoActions: () => null }));
vi.mock("../../../app/notas-fiscais/components/nfe-cancel-dialog", () => ({ NfeCancelDialog: () => null }));
vi.mock("../../../app/notas-fiscais/components/nfe-send-email-dialog", () => ({ NfeSendEmailDialog: () => null }));

import { NfeDetailSheet } from "../../../app/notas-fiscais/components/nfe-detail-sheet";

const VENDA = {
  id: "v1", modelo: "55", serie: 1, numero: 700, status: "AUTHORIZED", finalidade: "NORMAL", tipoOperacao: "SAIDA",
  ambiente: "PRODUCAO", naturezaOperacao: "Venda", devolucaoDisponivel: true, itens: [], totaisJson: { totalNota: 10 },
};
const SALDO = (toda: boolean) => ({
  original: {}, elegivel: !toda, motivo: toda ? "TOTALMENTE_DEVOLVIDA" : null, totalmenteDevolvida: toda,
  devolucoes: [{ nfeId: "dv", numero: 713, serie: 1, status: "AUTHORIZED", itens: [{ nItem: 1, quantidade: 1 }] }],
  itens: [{ nItem: 1, quantidadeOriginal: 2, devolvidaAutorizada: 1, emProcessamento: 0, emRascunho: 0, disponivel: toda ? 0 : 1, codigo: "A", descricao: "Farol", unidade: "UN", valorUnitario: 10 }],
});

let container: HTMLDivElement;
let root: Root;
let saldo: unknown;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const corpo: Record<string, unknown> = {
      "http://api.test/fiscal/nfe/v1": { nfe: VENDA },
      "http://api.test/fiscal/nfe/v1/events": { events: [
        { id: "e1", evento: "DEVOLUCAO_VINCULADA", detalhes: { nItem: 1, quantidade: 1 }, createdAt: "2026-09-24T12:00:00.000Z" },
        { id: "e2", evento: "EMITIDA", createdAt: "2026-09-20T12:00:00.000Z" },
      ] },
      "http://api.test/fiscal/nfe/v1/devolucao/saldo": saldo,
    };
    if (!(url in corpo)) throw new Error(`chamada inesperada: ${url}`);
    return { ok: true, status: 200, json: async () => corpo[url] };
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function abrir() {
  await act(async () => { root.render(<NfeDetailSheet nfeId="v1" open onOpenChange={() => {}} />); });
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const texto = () => container.textContent ?? "";
const temBotao = (r: string) => Array.from(container.querySelectorAll("button")).some((b) => (b.textContent ?? "").trim() === r);

describe("ficha da venda — vínculo com a devolução", () => {
  it("toda devolvida: mostra a devolução e o 'Devolver' some", async () => {
    saldo = SALDO(true);
    await abrir();
    expect(texto()).toContain("Devoluções desta nota");
    expect(texto()).toContain("NF-e 713 (série 1) — autorizada");
    expect(temBotao("Devolver total")).toBe(false);
    expect(temBotao("Devolver parcial")).toBe(false);
  });

  it("ainda com saldo: a devolução aparece e o 'Devolver' continua", async () => {
    saldo = SALDO(false);
    await abrir();
    expect(texto()).toContain("NF-e 713 (série 1) — autorizada");
    expect(temBotao("Devolver total")).toBe(true);
  });

  it("histórico: o evento da devolução em português; o resto como sempre foi", async () => {
    saldo = SALDO(false);
    await abrir();
    expect(texto()).toContain("Peça devolvida por uma devolução (item 1, quantidade 1)");
    expect(texto()).not.toContain("DEVOLUCAO_VINCULADA");
    expect(texto()).toContain("EMITIDA");
  });
});
