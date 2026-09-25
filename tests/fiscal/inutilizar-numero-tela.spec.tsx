// @vitest-environment jsdom
//
// A página "Inutilizar Numeração" MONTADA, só no envio da faixa.
//
// A recusa da SEFAZ volta HTTP 422 {success:false, mensagem} (rota POST
// /fiscal/inutilizacao: `result.success ? 200 : 422`). A tela só lia
// `data.error` no ramo !ok ⇒ o operador via o genérico "Erro ao inutilizar"
// (a frase da SEFAZ se perdia) e o histórico NÃO recarregava, então a linha
// REJEITADA gravada pelo servidor não aparecia. Agora: `data.error ||
// data.mensagem || "Erro ao inutilizar"` e o histórico recarrega.
//
// O AlertDialog do Radix vira stub (usa portal); o que se afirma dele é o
// contrato: o botão de confirmar chama o envio.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// A página não importa o React (runtime automático do Next); o esbuild do
// vitest compila o JSX para o `React.createElement` clássico.
(globalThis as any).React = React;

const h = vi.hoisted(() => {
  // A flag é lida no carregamento do módulo da página.
  const flagAntes = process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED;
  process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED = "true";
  return {
    flagAntes,
    sessao: { data: { user: { email: "dona@dls.test" } }, status: "authenticated" as const },
  };
});

vi.mock("next-auth/react", () => ({ useSession: () => h.sessao }));
vi.mock("next/navigation", () => {
  const router = { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, prefetch: () => {} };
  return { useRouter: () => router, usePathname: () => "/notas-fiscais/inutilizar-numero", useSearchParams: () => new URLSearchParams() };
});
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test", authHeaders: () => ({}) }));
vi.mock("@/components/ui/toast-viewport", async () => {
  const { createElement: e } = await import("react");
  return { ToastViewport: (p: any) => e("div", { role: "status" }, p.children) };
});
vi.mock("@/components/page-header", async () => {
  const { createElement: e } = await import("react");
  return { PageHeader: ({ title }: any) => e("h1", null, title) };
});
// Sem JSX nas fábricas: elas são içadas para antes dos imports.
vi.mock("@/components/ui/alert-dialog", async () => {
  const { createElement: e } = await import("react");
  return {
    AlertDialog: ({ open, children }: any) => (open ? e("div", { "data-testid": "dialogo" }, children) : null),
    AlertDialogContent: ({ children }: any) => e("div", null, children),
    AlertDialogHeader: ({ children }: any) => e("div", null, children),
    AlertDialogFooter: ({ children }: any) => e("div", null, children),
    AlertDialogTitle: ({ children }: any) => e("div", null, children),
    AlertDialogDescription: ({ children }: any) => e("div", null, children),
    AlertDialogCancel: ({ children }: any) => e("button", { type: "button" }, children),
  };
});

import InutilizarNumeroPage from "../../app/notas-fiscais/inutilizar-numero/page";

const MSG_RECUSA = "Inutilizacao recusada pela SEFAZ (codigo 241): Rejeicao: Um numero da faixa ja foi utilizado";

const LINHA_REJEITADA = {
  id: "inut-1",
  ambiente: "HOMOLOGACAO",
  serie: 1,
  numeroInicial: 8,
  numeroFinal: 10,
  justificativa: "Inutilizacao de numeros pulados por erro",
  protocolo: null,
  status: "REJEITADA",
  createdAt: "2026-09-25T12:00:00.000Z",
};

type RespostaPost = { ok: boolean; status: number; json: () => Promise<unknown> } | Error;

let container: HTMLDivElement;
let root: Root;
let chamadas: Array<{ url: string; method: string }>;
let historico: unknown[];
let historicoAposPost: unknown[];
let respostaPost: RespostaPost;

const gets = () => chamadas.filter((c) => c.method === "GET" && c.url === "http://api.test/fiscal/inutilizacao");
const posts = () => chamadas.filter((c) => c.method === "POST");
const toasts = () => container.querySelector('[role="status"]')?.textContent ?? "";
const texto = () => container.textContent ?? "";

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  chamadas = [];
  historico = [];
  historicoAposPost = [LINHA_REJEITADA];
  respostaPost = { ok: true, status: 200, json: async () => ({ success: true }) };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = String(init?.method ?? "GET");
      chamadas.push({ url: String(url), method });
      if (url === "http://api.test/fiscal/inutilizacao" && method === "GET") {
        const items = posts().length > 0 ? historicoAposPost : historico;
        return { ok: true, status: 200, json: async () => ({ items }) };
      }
      if (url === "http://api.test/fiscal/inutilizacao" && method === "POST") {
        if (respostaPost instanceof Error) throw respostaPost;
        return respostaPost;
      }
      throw new Error(`chamada inesperada: ${method} ${url}`);
    }),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => {
  if (h.flagAntes === undefined) delete process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED;
  else process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED = h.flagAntes;
});

async function esperar() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/** Digita como o navegador: setter nativo + evento que o React escuta. */
async function digitar(seletor: string, valor: string) {
  const el = container.querySelector(seletor) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) throw new Error(`campo ${seletor} não está na tela`);
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, valor);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function botao(rotulo: string): HTMLButtonElement {
  const alvo = Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(rotulo));
  if (!alvo) throw new Error(`botão "${rotulo}" não está na tela`);
  return alvo as HTMLButtonElement;
}

async function enviarFaixa() {
  await act(async () => { root.render(<InutilizarNumeroPage />); });
  await esperar();
  expect(gets()).toHaveLength(1);
  await digitar("#numero-inicial", "8");
  await digitar("#numero-final", "10");
  await digitar("#justificativa", "Inutilizacao de numeros pulados por erro");
  await act(async () => { botao("Inutilizar Numeracao").click(); });
  await act(async () => { botao("Confirmar Inutilizacao").click(); });
  await esperar();
  expect(posts()).toHaveLength(1);
}

describe("Inutilizar Numeração — envio da faixa", () => {
  it("recusa da SEFAZ (HTTP 422 {success:false, mensagem}) ⇒ toast com a frase da SEFAZ e o histórico recarrega com a linha REJEITADA", async () => {
    respostaPost = {
      ok: false,
      status: 422,
      json: async () => ({ success: false, id: "inut-1", status: "REJEITADA", protocolo: null, mensagem: MSG_RECUSA }),
    };
    await enviarFaixa();
    expect(toasts()).toContain(MSG_RECUSA);
    expect(toasts()).not.toContain("Erro ao inutilizar");
    // Recusa é aviso de ERRO (vermelho), nunca de sucesso.
    expect(container.querySelector('[role="status"] .bg-red-500')).not.toBeNull();
    expect(container.querySelector('[role="status"] .bg-green-500')).toBeNull();
    expect(gets()).toHaveLength(2);
    expect(texto()).toContain("Rejeitada");
    expect(texto()).toContain("8 — 10");
  });

  it("!ok com `error` (ex.: 400 de validação) ⇒ prevalece o `error`, como antes", async () => {
    respostaPost = {
      ok: false,
      status: 400,
      json: async () => ({ error: "Justificativa obrigatoria (minimo 15 caracteres)", mensagem: "nao deve aparecer" }),
    };
    await enviarFaixa();
    expect(toasts()).toContain("Justificativa obrigatoria (minimo 15 caracteres)");
    expect(toasts()).not.toContain("nao deve aparecer");
  });

  it("!ok sem `error` nem `mensagem` ⇒ o genérico 'Erro ao inutilizar', como antes", async () => {
    respostaPost = { ok: false, status: 500, json: async () => ({}) };
    await enviarFaixa();
    expect(toasts()).toContain("Erro ao inutilizar");
  });

  it("controle: 200 {success:true} ⇒ 'Inutilizacao aceita pela SEFAZ', limpa o formulário e recarrega o histórico, como antes", async () => {
    historicoAposPost = [{ ...LINHA_REJEITADA, status: "ACEITA", protocolo: "135260000000010" }];
    await enviarFaixa();
    expect(toasts()).toContain("Inutilizacao aceita pela SEFAZ");
    expect(gets()).toHaveLength(2);
    expect((container.querySelector("#numero-inicial") as HTMLInputElement).value).toBe("");
    expect(texto()).toContain("Aceita");
  });

  it("controle: falha de rede ⇒ 'Erro de conexao', como antes", async () => {
    respostaPost = new TypeError("fetch failed");
    await enviarFaixa();
    expect(toasts()).toContain("Erro de conexao");
  });
});
