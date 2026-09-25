// @vitest-environment jsdom
//
// A lista de Notas Emitidas MONTADA, só nos botões de download da linha (XML e
// DANFE):
//  - erro do servidor aparecia em lugar nenhum (`if (!res.ok) return;`): o
//    clique não fazia nada. Agora vira o toast de erro da própria lista, com a
//    frase do servidor — o 500 do DANFE da cancelada sem carimbo manda usar o
//    XML; o 403 PAGE_FORBIDDEN diz que o acesso foi removido;
//  - o PDF da nota cancelada sai como `nfe-<id>-CANCELADA.pdf`; o resto, com o
//    nome de sempre.
// A falha confere o TIPO do toast (erro) e que há EXATAMENTE UM, com o texto
// exato: a resposta de erro é um `Response` real, então seguir para o `blob()`
// depois do toast apareceria como um segundo toast.
// Os filhos pesados (ficha, diálogos, selects do Radix) são stubs.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  sessao: { data: { user: { email: "dona@dls.test" } }, status: "authenticated" as const },
  download: {} as Record<string, () => unknown>,
}));

vi.mock("next-auth/react", () => ({ useSession: () => h.sessao }));
vi.mock("next/navigation", () => {
  const router = { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, prefetch: () => {} };
  return { useRouter: () => router, usePathname: () => "/notas-fiscais/emitidas", useSearchParams: () => new URLSearchParams() };
});
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test", authHeaders: () => ({}) }));
vi.mock("@/components/ui/select", async () => {
  const { createElement: e } = await import("react");
  return {
    Select: ({ children }: any) => e("div", null, children),
    SelectTrigger: ({ children }: any) => e("div", null, children),
    SelectValue: ({ placeholder }: any) => e("span", null, placeholder),
    SelectContent: ({ children }: any) => e("div", null, children),
    SelectItem: ({ value, children }: any) => e("div", { "data-item": value }, children),
  };
});
vi.mock("@/components/ui/tooltip", async () => {
  const { createElement: e, Fragment } = await import("react");
  return {
    TooltipProvider: ({ children }: any) => e(Fragment, null, children),
    Tooltip: ({ children }: any) => e(Fragment, null, children),
    TooltipTrigger: ({ children }: any) => e(Fragment, null, children),
    TooltipContent: ({ children }: any) => e("span", null, children),
  };
});
vi.mock("@/components/ui/toast-viewport", async () => {
  const { createElement: e, Children } = await import("react");
  // O tipo do toast só existe na COR (bg-red-500 = erro, bg-green-500 =
  // sucesso): o stub o expõe em `data-type` para o teste conferir.
  const tipo = (filho: any) => {
    const classe = String(filho?.props?.className ?? "");
    if (classe.includes("bg-red-500")) return "error";
    if (classe.includes("bg-green-500")) return "success";
    return "desconhecido";
  };
  return {
    ToastViewport: (p: any) =>
      e("div", { role: "status" }, Children.map(p.children, (filho: any) => e("div", { "data-type": tipo(filho) }, filho))),
  };
});
vi.mock("../../app/notas-fiscais/components/nfe-detail-sheet", () => ({ NfeDetailSheet: () => null }));
vi.mock("../../app/notas-fiscais/components/nfe-cancel-dialog", () => ({ NfeCancelDialog: () => null }));
vi.mock("../../app/notas-fiscais/components/nfe-send-email-dialog", () => ({ NfeSendEmailDialog: () => null }));
vi.mock("../../app/notas-fiscais/components/devolucao-manual", () => ({ DevolucaoManual: () => null }));
vi.mock("../../app/notas-fiscais/components/numeracao-actions", () => ({ NumeracaoActions: () => null }));
vi.mock("../../app/notas-fiscais/components/devolucao-actions", () => ({ DevolucaoActions: () => null }));
vi.mock("../../app/notas-fiscais/components/devolucoes-em-andamento", () => ({ DevolucoesEmAndamento: () => null }));
vi.mock("../../app/notas-fiscais/components/nfe-status-badge", async () => {
  const { createElement: e } = await import("react");
  return { NfeStatusBadge: ({ status }: any) => e("span", null, status) };
});

import { NfeList } from "../../app/notas-fiscais/components/nfe-list";

const FRASE_CANCELADA =
  "Esta nota está CANCELADA e não foi possível marcar o DANFE como cancelado. Use o XML da nota.";
const FRASE_403 = "Seu acesso a esta área foi removido pelo administrador da conta.";
const PADRAO = "Não foi possível baixar o arquivo. Tente de novo.";

function nota(p: Record<string, unknown>) {
  return {
    id: "n", orderId: null, ambiente: "PRODUCAO", modelo: "55", serie: 1, numero: 700, chaveAcesso: null, tipoOperacao: "SAIDA",
    finalidade: "NORMAL", naturezaOperacao: "Venda", destinatarioNome: "Cliente", destinatarioCpfCnpj: "", totalNota: 100,
    status: "AUTHORIZED", protocoloAutorizacao: null, dataEmissao: "2026-09-24T12:00:00.000Z", dataAutorizacao: null,
    createdAt: "2026-09-24T12:00:00.000Z", hasXml: true, hasDanfe: true, ...p,
  };
}

const ok = () => ({ ok: true, status: 200, blob: async () => new Blob(["%PDF-1.4"]) });
// Resposta REAL (tem `blob()`): se a tela seguisse depois do toast de erro, o
// `blob()` do corpo já lido estouraria e daria um SEGUNDO toast — que o
// `toastsExatos()` pega.
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
  // jsdom não tem createObjectURL nem navega: o que se mede é o nome que o
  // <a download> recebeu no clique.
  (URL as any).createObjectURL = vi.fn(() => "blob:teste");
  (URL as any).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    baixados.push(this.download);
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("http://api.test/fiscal/nfe/stats")) {
      return { ok: true, status: 200, json: async () => ({ stats: { total: 2, autorizadas: 1, rejeitadas: 0, canceladas: 1, valorTotal: 200 } }) };
    }
    if (url.startsWith("http://api.test/fiscal/nfe?")) {
      return { ok: true, status: 200, json: async () => ({
        notas: [nota({ id: "autorizada", numero: 715 }), nota({ id: "cancelada", numero: 716, status: "CANCELLED" })],
        page: 1, limit: 10, total: 2, totalPages: 1,
      }) };
    }
    const tipo = url.match(/^http:\/\/api\.test\/fiscal\/nfe\/([^/]+)\/(danfe|xml)$/);
    if (tipo) {
      const r = h.download[`${tipo[1]}/${tipo[2]}`];
      return r ? r() : ok();
    }
    throw new Error(`chamada inesperada: ${url}`);
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

async function montar() {
  window.history.replaceState({}, "", "/notas-fiscais/emitidas");
  await act(async () => { root.render(<NfeList />); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const linha = (numero: number) =>
  Array.from(container.querySelectorAll("tr")).find((tr) => tr.querySelector("td")?.textContent?.startsWith(String(numero)))!;

// Os botões da linha são só ícone: o do DANFE é o `Download`, o do XML é o `FileText`.
async function clicar(numero: number, tipo: "danfe" | "xml") {
  const icone = tipo === "danfe" ? "lucide-download" : "lucide-file-text";
  const botao = Array.from(linha(numero).querySelectorAll("button")).find((b) => b.querySelector(`svg.${icone}`));
  expect(botao, `botão ${tipo} da nota ${numero}`).toBeTruthy();
  await act(async () => { botao!.click(); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const toasts = () => container.querySelector('[role="status"]')?.textContent ?? "";
/** Cada toast na tela, com o tipo e o texto exato. */
const toastsExatos = () =>
  Array.from(container.querySelectorAll('[role="status"] > [data-type]')).map((t) => ({
    tipo: t.getAttribute("data-type"),
    texto: t.textContent,
  }));

describe("lista de Notas Emitidas — erro no download aparece", () => {
  it("DANFE da cancelada sem carimbo (500): o toast mostra a frase que manda usar o XML", async () => {
    h.download["cancelada/danfe"] = () => falha(500, JSON.stringify({ error: FRASE_CANCELADA }));
    await montar();
    await clicar(716, "danfe");
    expect(toasts()).toContain(FRASE_CANCELADA);
    expect(toastsExatos()).toEqual([{ tipo: "error", texto: FRASE_CANCELADA }]);
    expect(baixados).toEqual([]);
  });

  it("acesso removido (403 PAGE_FORBIDDEN): o toast mostra o `message` do servidor", async () => {
    h.download["autorizada/xml"] = () => falha(403, JSON.stringify({ message: FRASE_403, code: "PAGE_FORBIDDEN" }));
    await montar();
    await clicar(715, "xml");
    expect(toasts()).toContain(FRASE_403);
    expect(toastsExatos()).toEqual([{ tipo: "error", texto: FRASE_403 }]);
    expect(baixados).toEqual([]);
  });

  it("corpo que não é JSON (proxy): frase padrão", async () => {
    h.download["autorizada/danfe"] = () => falha(502, "<html>Bad Gateway</html>");
    await montar();
    await clicar(715, "danfe");
    expect(toasts()).toContain(PADRAO);
    expect(toastsExatos()).toEqual([{ tipo: "error", texto: PADRAO }]);
    expect(baixados).toEqual([]);
  });

  it("rede caída (fetch lança): frase padrão, em vez de silêncio", async () => {
    h.download["autorizada/danfe"] = () => { throw new TypeError("Failed to fetch"); };
    await montar();
    await clicar(715, "danfe");
    expect(toasts()).toContain(PADRAO);
    expect(toastsExatos()).toEqual([{ tipo: "error", texto: PADRAO }]);
    expect(baixados).toEqual([]);
  });

  it("404 \"DANFE nao disponivel\": exatamente UM toast, de erro, com a frase exata, e nada baixado", async () => {
    h.download["autorizada/danfe"] = () => falha(404, JSON.stringify({ error: "DANFE nao disponivel" }));
    await montar();
    await clicar(715, "danfe");
    expect(toastsExatos()).toEqual([{ tipo: "error", texto: "DANFE nao disponivel" }]);
    expect(baixados).toEqual([]);
  });

  it("erro técnico cru do catch da rota (várias linhas): o toast mostra só a primeira linha", async () => {
    const cru = "Invalid `prisma.nfeEmitida.findFirst()` invocation in\nC:\\dexo\\app\\routes\\fiscal.routes.ts:1360:52\n\nCan't reach database server at `db.interno:5432`";
    h.download["autorizada/xml"] = () => falha(500, JSON.stringify({ error: cru }));
    await montar();
    await clicar(715, "xml");
    expect(toastsExatos()).toEqual([{ tipo: "error", texto: "Invalid `prisma.nfeEmitida.findFirst()` invocation in" }]);
    expect(toasts()).not.toContain("db.interno");
    expect(baixados).toEqual([]);
  });
});

describe("lista de Notas Emitidas — nome do arquivo baixado", () => {
  it("autorizada: o nome de sempre, PDF e XML, sem toast", async () => {
    await montar();
    await clicar(715, "danfe");
    await clicar(715, "xml");
    expect(baixados).toEqual(["nfe-autorizada.pdf", "nfe-autorizada.xml"]);
    expect(toasts()).toBe("");
    expect(toastsExatos()).toEqual([]);
  });

  it("cancelada: o PDF do DANFE ganha -CANCELADA; o XML fica com o nome de sempre", async () => {
    await montar();
    await clicar(716, "danfe");
    await clicar(716, "xml");
    expect(baixados).toEqual(["nfe-cancelada-CANCELADA.pdf", "nfe-cancelada.xml"]);
    expect(toasts()).toBe("");
    expect(toastsExatos()).toEqual([]);
  });
});
