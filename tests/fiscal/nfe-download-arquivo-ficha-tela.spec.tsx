// @vitest-environment jsdom
//
// A FICHA da nota montada, só nos botões "Baixar XML" e "Baixar DANFE":
//  - erro do servidor ia só para o console (`console.error`): o clique não
//    fazia nada na tela. Agora a frase do servidor aparece num aviso logo
//    abaixo dos botões — o 500 do DANFE da cancelada sem carimbo manda usar o
//    XML; o 403 PAGE_FORBIDDEN diz que o acesso foi removido;
//  - o aviso é DESTA nota: some ao trocar de nota, ao fechar e reabrir a
//    mesma nota, e ao baixar de novo com sucesso;
//  - o PDF da nota cancelada sai como `danfe-<série>-<número>-CANCELADA.pdf`
//    (`cupom-…` na NFC-e); XML e notas não canceladas, com o nome de sempre.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  sessao: { data: { user: { email: "dona@dls.test" } }, status: "authenticated" as const },
  notas: {} as Record<string, Record<string, unknown>>,
  download: {} as Record<string, () => unknown>,
}));
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
vi.mock("../../app/notas-fiscais/components/nfe-status-badge", async () => {
  const { createElement: e } = await import("react");
  return { NfeStatusBadge: ({ status }: any) => e("span", null, status) };
});
vi.mock("../../app/notas-fiscais/components/numeracao-actions", () => ({ NumeracaoActions: () => null }));
vi.mock("../../app/notas-fiscais/components/devolucao-actions", () => ({ DevolucaoActions: () => null }));
vi.mock("../../app/notas-fiscais/components/devolucao-vinculo", () => ({ DevolucaoVinculo: () => null }));
vi.mock("../../app/notas-fiscais/components/nfe-cancel-dialog", () => ({ NfeCancelDialog: () => null }));
vi.mock("../../app/notas-fiscais/components/nfe-send-email-dialog", () => ({ NfeSendEmailDialog: () => null }));

import { NfeDetailSheet } from "../../app/notas-fiscais/components/nfe-detail-sheet";

const FRASE_CANCELADA =
  "Esta nota está CANCELADA e não foi possível marcar o DANFE como cancelado. Use o XML da nota.";
const FRASE_403 = "Seu acesso a esta área foi removido pelo administrador da conta.";
const PADRAO = "Não foi possível baixar o arquivo. Tente de novo.";

function nota(p: Record<string, unknown>) {
  return {
    modelo: "55", serie: 1, numero: 716, status: "AUTHORIZED", finalidade: "NORMAL", tipoOperacao: "SAIDA",
    ambiente: "PRODUCAO", naturezaOperacao: "Venda", itens: [], totaisJson: { totalNota: 10 },
    xmlAutorizadoPath: "x.xml", danfePdfPath: "d.pdf", ...p,
  };
}

const ok = () => ({ ok: true, status: 200, blob: async () => new Blob(["%PDF-1.4"]) });
// Resposta REAL (tem `blob()`): se a ficha seguisse depois de mostrar o aviso,
// o `blob()` do corpo já lido estouraria e trocaria o aviso pela frase padrão.
const falha = (status: number, corpo: string) => new Response(corpo, { status });

let container: HTMLDivElement;
let root: Root;
let baixados: string[];
const urlOriginal = { criar: (URL as any).createObjectURL, revogar: (URL as any).revokeObjectURL };

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  baixados = [];
  h.download = {};
  h.notas = {
    cancelada: nota({ id: "cancelada", status: "CANCELLED" }),
    autorizada: nota({ id: "autorizada", numero: 715 }),
    cupom: nota({ id: "cupom", modelo: "65", serie: 4, numero: 2, status: "CANCELLED" }),
  };
  // jsdom não tem createObjectURL nem navega: o que se mede é o nome que o
  // <a download> recebeu no clique.
  (URL as any).createObjectURL = vi.fn(() => "blob:teste");
  (URL as any).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    baixados.push(this.download);
  });
  // O `console.error` de sempre continua; aqui só não polui a saída.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const m = url.match(/^http:\/\/api\.test\/fiscal\/nfe\/([^/]+)(?:\/(events|danfe|xml))?$/);
    if (!m || !(m[1] in h.notas)) throw new Error(`chamada inesperada: ${url}`);
    if (!m[2]) return { ok: true, status: 200, json: async () => ({ nfe: h.notas[m[1]] }) };
    if (m[2] === "events") return { ok: true, status: 200, json: async () => ({ events: [] }) };
    const r = h.download[`${m[1]}/${m[2]}`];
    return r ? r() : ok();
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  (URL as any).createObjectURL = urlOriginal.criar;
  (URL as any).revokeObjectURL = urlOriginal.revogar;
});

async function esperar() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function abrir(nfeId: string) {
  await act(async () => { root.render(<NfeDetailSheet nfeId={nfeId} open onOpenChange={() => {}} />); });
  await esperar();
}
/** Fecha a ficha SEM trocar de nota nem desmontar o componente (open=false). */
async function fechar(nfeId: string) {
  await act(async () => { root.render(<NfeDetailSheet nfeId={nfeId} open={false} onOpenChange={() => {}} />); });
  await esperar();
}
async function clicar(rotulo: "Baixar XML" | "Baixar DANFE") {
  const botao = Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === rotulo);
  expect(botao, rotulo).toBeTruthy();
  await act(async () => { botao!.click(); });
  await esperar();
}
const aviso = () => container.querySelector('[role="alert"]')?.textContent ?? null;

describe("ficha da nota — erro no download aparece", () => {
  it("DANFE da cancelada sem carimbo (500): a frase que manda usar o XML aparece na ficha", async () => {
    h.download["cancelada/danfe"] = () => falha(500, JSON.stringify({ error: FRASE_CANCELADA }));
    await abrir("cancelada");
    expect(aviso()).toBeNull();
    await clicar("Baixar DANFE");
    expect(aviso()).toBe(FRASE_CANCELADA);
    expect(baixados).toEqual([]);
  });

  it("acesso removido (403 PAGE_FORBIDDEN): o `message` do servidor aparece", async () => {
    h.download["autorizada/xml"] = () => falha(403, JSON.stringify({ message: FRASE_403, code: "PAGE_FORBIDDEN" }));
    await abrir("autorizada");
    await clicar("Baixar XML");
    expect(aviso()).toBe(FRASE_403);
  });

  it("corpo sem texto: frase padrão", async () => {
    h.download["autorizada/danfe"] = () => falha(500, "");
    await abrir("autorizada");
    await clicar("Baixar DANFE");
    expect(aviso()).toBe(PADRAO);
  });

  it("rede caída (fetch lança): frase padrão, em vez de só o console", async () => {
    h.download["autorizada/danfe"] = () => { throw new TypeError("Failed to fetch"); };
    await abrir("autorizada");
    await clicar("Baixar DANFE");
    expect(aviso()).toBe(PADRAO);
  });

  it("o aviso some quando o download seguinte dá certo (o XML que ele manda usar)", async () => {
    h.download["cancelada/danfe"] = () => falha(500, JSON.stringify({ error: FRASE_CANCELADA }));
    await abrir("cancelada");
    await clicar("Baixar DANFE");
    expect(aviso()).toBe(FRASE_CANCELADA);
    await clicar("Baixar XML");
    expect(aviso()).toBeNull();
    expect(baixados).toEqual(["nfe-1-716.xml"]);
  });

  it("o aviso é DESTA nota: trocar de nota apaga", async () => {
    h.download["cancelada/danfe"] = () => falha(500, JSON.stringify({ error: FRASE_CANCELADA }));
    await abrir("cancelada");
    await clicar("Baixar DANFE");
    expect(aviso()).toBe(FRASE_CANCELADA);
    await abrir("autorizada");
    expect(container.textContent).toContain("#715");
    expect(aviso()).toBeNull();
  });

  it("fechar e reabrir a MESMA nota apaga o aviso", async () => {
    h.download["cancelada/danfe"] = () => falha(500, JSON.stringify({ error: FRASE_CANCELADA }));
    await abrir("cancelada");
    await clicar("Baixar DANFE");
    expect(aviso()).toBe(FRASE_CANCELADA);
    await fechar("cancelada");
    expect(aviso()).toBeNull();
    await abrir("cancelada");
    // A ficha voltou com a nota (não é só o Sheet fechado escondendo o aviso).
    expect(container.textContent).toContain("#716");
    expect(Array.from(container.querySelectorAll("button")).some((b) => (b.textContent ?? "").trim() === "Baixar DANFE")).toBe(true);
    expect(aviso()).toBeNull();
    expect(baixados).toEqual([]);
  });

  it("404 \"DANFE nao disponivel\": o aviso tem a frase exata e nada é baixado", async () => {
    h.download["autorizada/danfe"] = () => falha(404, JSON.stringify({ error: "DANFE nao disponivel" }));
    await abrir("autorizada");
    await clicar("Baixar DANFE");
    expect(aviso()).toBe("DANFE nao disponivel");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(baixados).toEqual([]);
  });

  it("erro técnico cru do catch da rota (várias linhas): o aviso mostra só a primeira linha", async () => {
    const cru = "Invalid `prisma.nfeEmitida.findFirst()` invocation in\nC:\\dexo\\app\\routes\\fiscal.routes.ts:1420:52\n\nCan't reach database server at `db.interno:5432`";
    h.download["autorizada/danfe"] = () => falha(500, JSON.stringify({ error: cru }));
    await abrir("autorizada");
    await clicar("Baixar DANFE");
    expect(aviso()).toBe("Invalid `prisma.nfeEmitida.findFirst()` invocation in");
    expect(container.textContent).not.toContain("db.interno");
    expect(baixados).toEqual([]);
  });
});

describe("ficha da nota — nome do arquivo baixado", () => {
  it("autorizada: o nome de sempre, PDF e XML, sem aviso", async () => {
    await abrir("autorizada");
    await clicar("Baixar DANFE");
    await clicar("Baixar XML");
    expect(baixados).toEqual(["danfe-1-715.pdf", "nfe-1-715.xml"]);
    expect(aviso()).toBeNull();
  });

  it("cancelada: o PDF do DANFE ganha -CANCELADA; o XML fica com o nome de sempre", async () => {
    await abrir("cancelada");
    await clicar("Baixar DANFE");
    await clicar("Baixar XML");
    expect(baixados).toEqual(["danfe-1-716-CANCELADA.pdf", "nfe-1-716.xml"]);
  });

  it("NFC-e cancelada: o cupom também ganha -CANCELADA (o carimbo vale para os dois modelos)", async () => {
    await abrir("cupom");
    await clicar("Baixar DANFE");
    await clicar("Baixar XML");
    expect(baixados).toEqual(["cupom-4-2-CANCELADA.pdf", "nfce-4-2.xml"]);
  });
});
