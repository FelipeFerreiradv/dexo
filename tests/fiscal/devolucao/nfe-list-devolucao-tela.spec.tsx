// @vitest-environment jsdom
//
// A lista de Notas Emitidas MONTADA, só no que a devolução acrescentou:
//  - a linha da devolução tem selo próprio (tinha a mesma cara de uma venda);
//  - `?nfe=<id>` abre a ficha da nota — é para onde o assistente manda depois
//    de autorizar (antes voltava para "Emitir NF-e", que reabria um rascunho
//    qualquer);
//  - o quadro "Devoluções em andamento" está na página, junto do "Devolução
//    manual".
// Os filhos pesados (ficha, diálogos, selects do Radix) são stubs: o que se
// mede é o que a LISTA passa para eles.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// A sessão é o MESMO objeto a cada render, como no next-auth de verdade: a lista
// tem efeitos que dependem dela, e um objeto novo por render viraria laço.
const h = vi.hoisted(() => ({
  ficha: [] as Array<{ nfeId: string | null; open: boolean }>,
  sessao: { data: { user: { email: "dona@dls.test" } }, status: "authenticated" as const },
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
  const { createElement: e } = await import("react");
  return { ToastViewport: (p: any) => e("div", { role: "status" }, p.children) };
});
vi.mock("../../../app/notas-fiscais/components/nfe-detail-sheet", () => ({
  NfeDetailSheet: (p: any) => {
    h.ficha.push({ nfeId: p.nfeId, open: p.open });
    return null;
  },
}));
vi.mock("../../../app/notas-fiscais/components/nfe-cancel-dialog", () => ({ NfeCancelDialog: () => null }));
vi.mock("../../../app/notas-fiscais/components/nfe-send-email-dialog", () => ({ NfeSendEmailDialog: () => null }));
vi.mock("../../../app/notas-fiscais/components/devolucao-manual", () => ({ DevolucaoManual: () => null }));
vi.mock("../../../app/notas-fiscais/components/numeracao-actions", () => ({ NumeracaoActions: () => null }));
vi.mock("../../../app/notas-fiscais/components/devolucao-actions", () => ({ DevolucaoActions: () => null }));
vi.mock("../../../app/notas-fiscais/components/nfe-status-badge", async () => {
  const { createElement: e } = await import("react");
  return { NfeStatusBadge: ({ status }: any) => e("span", null, status) };
});
vi.mock("../../../app/notas-fiscais/components/devolucoes-em-andamento", async () => {
  const { createElement: e } = await import("react");
  return { DevolucoesEmAndamento: ({ email }: any) => e("section", { "data-teste": "em-andamento" }, `em andamento de ${email}`) };
});

import { NfeList } from "../../../app/notas-fiscais/components/nfe-list";

function nota(p: Record<string, unknown>) {
  return {
    id: "n", orderId: null, ambiente: "PRODUCAO", modelo: "55", serie: 1, numero: 700, chaveAcesso: null, tipoOperacao: "SAIDA",
    finalidade: "NORMAL", naturezaOperacao: "Venda", destinatarioNome: "Cliente", destinatarioCpfCnpj: "", totalNota: 100,
    status: "AUTHORIZED", protocoloAutorizacao: null, dataEmissao: "2026-09-24T12:00:00.000Z", dataAutorizacao: null,
    createdAt: "2026-09-24T12:00:00.000Z", hasXml: false, hasDanfe: false, ...p,
  };
}

let container: HTMLDivElement;
let root: Root;

async function montar(url: string) {
  window.history.replaceState({}, "", url);
  await act(async () => { root.render(<NfeList />); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.ficha = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("http://api.test/fiscal/nfe/stats")) {
      return { ok: true, status: 200, json: async () => ({ stats: { total: 3, autorizadas: 3, rejeitadas: 0, canceladas: 0, valorTotal: 300 } }) };
    }
    if (url.startsWith("http://api.test/fiscal/nfe?")) {
      return { ok: true, status: 200, json: async () => ({
        notas: [
          nota({ id: "venda", numero: 700 }),
          nota({ id: "dev-compra", numero: 713, finalidade: "DEVOLUCAO", tipoOperacao: "SAIDA" }),
          nota({ id: "dev-venda", numero: 714, finalidade: "DEVOLUCAO", tipoOperacao: "ENTRADA" }),
        ],
        page: 1, limit: 10, total: 3, totalPages: 1,
      }) };
    }
    throw new Error(`chamada inesperada: ${url}`);
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const linha = (numero: number) =>
  Array.from(container.querySelectorAll("tr")).find((tr) => tr.querySelector("td")?.textContent?.startsWith(String(numero)));

describe("lista de Notas Emitidas — o que a devolução acrescentou", () => {
  it("a devolução tem selo (entrada/saída); a venda, não", async () => {
    await montar("/notas-fiscais/emitidas");
    expect(linha(700)!.textContent).not.toContain("Devolução");
    expect(linha(713)!.textContent).toContain("Devolução · saída");
    expect(linha(714)!.textContent).toContain("Devolução · entrada");
  });

  it("?nfe=<id> abre a ficha dessa nota ao carregar (destino depois de autorizar)", async () => {
    await montar("/notas-fiscais/emitidas?nfe=dev-compra");
    expect(h.ficha.at(-1)).toEqual({ nfeId: "dev-compra", open: true });
  });

  it("sem o parâmetro, a ficha começa fechada, como sempre", async () => {
    await montar("/notas-fiscais/emitidas");
    expect(h.ficha.at(-1)).toEqual({ nfeId: null, open: false });
  });

  it("o quadro das devoluções em andamento está na página", async () => {
    await montar("/notas-fiscais/emitidas");
    expect(container.querySelector('[data-teste="em-andamento"]')!.textContent).toBe("em andamento de dona@dls.test");
  });
});
