// @vitest-environment jsdom
//
// BLOQ-1 (lado tela): na V2, inutilizar uma faixa que tem número preso numa nota
// NÃO emitida (reserva RESERVADO/REJEITADO/BLOQUEADO) responde 409
// NUMERACAO_CONFIRMAR_DESCARTE com `detalhes.numeros` (contrato C1). A tela
// mostrava isso como um toast de erro e parava: não havia como seguir. Agora
// ela lista os números, pede confirmação explícita e repete o MESMO envio com
// `confirmarDescarteNumeros:true`. O 1º envio nunca leva o campo (o ramo V1 o
// ignora, e a confirmação tem de ser da pessoa, não da tela).
//
// Os outros casos seguem como antes — há `tests/fiscal/inutilizar-numero-tela.spec.tsx`.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;

const h = vi.hoisted(() => {
  const flagAntes = process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED;
  process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED = "true";
  return { flagAntes, sessao: { data: { user: { email: "dona@dls.test" } }, status: "authenticated" as const } };
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
// Diálogo aberto ⇒ uma `section` com o título como nome: dá para saber QUAL está aberto.
vi.mock("@/components/ui/alert-dialog", async () => {
  const { createElement: e } = await import("react");
  return {
    AlertDialog: ({ open, children }: any) => (open ? e("section", { "data-testid": "dialogo" }, children) : null),
    AlertDialogContent: ({ children }: any) => e("div", null, children),
    AlertDialogHeader: ({ children }: any) => e("div", null, children),
    AlertDialogFooter: ({ children }: any) => e("div", null, children),
    AlertDialogTitle: ({ children }: any) => e("h2", null, children),
    AlertDialogDescription: ({ children }: any) => e("div", null, children),
    AlertDialogCancel: ({ children, onClick, disabled }: any) => e("button", { type: "button", onClick, disabled }, children),
  };
});

import InutilizarNumeroPage from "../../app/notas-fiscais/inutilizar-numero/page";

const MSG_409 = "Os nºs 92, 93 da série 4 estão reservados para notas que não foram autorizadas";
const CORPO_409 = { error: MSG_409, code: "NUMERACAO_CONFIRMAR_DESCARTE", detalhes: { numeros: [92, 93], serie: 4 } };

type Resp = { ok: boolean; status: number; json: () => Promise<unknown> };
let container: HTMLDivElement;
let root: Root;
let chamadas: Array<{ method: string; body: any }>;
let filaPost: Resp[];

const posts = () => chamadas.filter((c) => c.method === "POST");
const gets = () => chamadas.filter((c) => c.method === "GET");
const toasts = () => container.querySelector('[role="status"]')?.textContent ?? "";
const dialogos = () => Array.from(container.querySelectorAll('[data-testid="dialogo"]'));
const resp = (status: number, body: unknown): Resp => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  chamadas = [];
  filaPost = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? "GET");
    chamadas.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url !== "http://api.test/fiscal/inutilizacao") throw new Error(`chamada inesperada: ${method} ${url}`);
    if (method === "GET") return resp(200, { items: [] });
    const r = filaPost.shift();
    if (!r) throw new Error("POST a mais");
    return r;
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
afterAll(() => {
  if (h.flagAntes === undefined) delete process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED;
  else process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED = h.flagAntes;
});

async function esperar() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function digitar(seletor: string, valor: string) {
  const el = container.querySelector(seletor) as HTMLInputElement | HTMLTextAreaElement;
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, valor);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function botao(rotulo: string, el: ParentNode = container): HTMLButtonElement {
  const alvo = Array.from(el.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(rotulo));
  if (!alvo) throw new Error(`botão "${rotulo}" não está na tela. Texto: ${container.textContent}`);
  return alvo as HTMLButtonElement;
}
async function clicar(rotulo: string, el?: ParentNode) {
  await act(async () => { botao(rotulo, el).click(); });
  await esperar();
}

async function enviarFaixa() {
  await act(async () => { root.render(<InutilizarNumeroPage />); });
  await esperar();
  await digitar("#serie", "4");
  await digitar("#numero-inicial", "92");
  await digitar("#numero-final", "95");
  await digitar("#justificativa", "Numeros pulados por rejeicao antiga");
  await clicar("Inutilizar Numeracao");
  await clicar("Confirmar Inutilizacao");
}

const CORPO_BASE = { serie: 4, numeroInicial: 92, numeroFinal: 95, justificativa: "Numeros pulados por rejeicao antiga" };

describe("Inutilizar Numeração — 409 NUMERACAO_CONFIRMAR_DESCARTE (V2)", () => {
  it("lista os números presos e pede confirmação, sem toast de erro e sem 2º envio", async () => {
    filaPost = [resp(409, CORPO_409)];
    await enviarFaixa();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toEqual(CORPO_BASE);
    expect(posts()[0].body).not.toHaveProperty("confirmarDescarteNumeros");
    const [d] = dialogos();
    expect(dialogos()).toHaveLength(1);
    expect(d.textContent).toContain("92, 93");
    expect(d.textContent).toContain("série 4");
    expect(d.textContent).toContain(MSG_409);
    expect(toasts()).toBe("");
  });

  it("confirmou ⇒ repete o MESMO corpo com confirmarDescarteNumeros:true ⇒ aceita, limpa e recarrega o histórico", async () => {
    filaPost = [resp(409, CORPO_409), resp(200, { success: true, id: "inut-1", status: "ACEITA", protocolo: "135260000000010" })];
    await enviarFaixa();
    const getsAntes = gets().length;
    // Mexer no formulário por trás da confirmação NÃO muda o que vai ser enviado.
    await digitar("#numero-final", "99");
    await clicar("Descartar os números e inutilizar", dialogos()[0]);
    expect(posts()).toHaveLength(2);
    expect(posts()[1].body).toEqual({ ...CORPO_BASE, confirmarDescarteNumeros: true });
    expect(toasts()).toContain("Inutilizacao aceita pela SEFAZ");
    expect(dialogos()).toHaveLength(0);
    expect(gets().length).toBe(getsAntes + 1);
    expect((container.querySelector("#numero-inicial") as HTMLInputElement).value).toBe("");
  });

  it("Voltar ⇒ fecha sem reenviar", async () => {
    filaPost = [resp(409, CORPO_409)];
    await enviarFaixa();
    await clicar("Voltar", dialogos()[0]);
    expect(dialogos()).toHaveLength(0);
    expect(posts()).toHaveLength(1);
  });

  it("a SEFAZ recusa depois de confirmado ⇒ toast com a frase dela e histórico recarregado, como sempre", async () => {
    filaPost = [resp(409, CORPO_409), resp(422, { success: false, status: "REJEITADA", mensagem: "Rejeicao: numero ja utilizado" })];
    await enviarFaixa();
    await clicar("Descartar os números e inutilizar", dialogos()[0]);
    expect(toasts()).toContain("Rejeicao: numero ja utilizado");
    expect(dialogos()).toHaveLength(0);
  });

  // Integração (revisão do G2): a guarda que impede reabrir a pergunta quando o reenvio JÁ
  // confirmado volta com o mesmo 409. O servidor não faz isso hoje; se fizer, a tela não entra em
  // laço de confirmações: mostra a frase dele no toast e para.
  it("reenvio já confirmado volta 409 de novo ⇒ toast com a frase do servidor, nenhum diálogo, só 2 POSTs", async () => {
    filaPost = [resp(409, CORPO_409), resp(409, CORPO_409)];
    await enviarFaixa();
    await clicar("Descartar os números e inutilizar", dialogos()[0]);
    expect(posts()).toHaveLength(2);
    expect(posts()[1].body).toEqual({ ...CORPO_BASE, confirmarDescarteNumeros: true });
    expect(dialogos()).toHaveLength(0);
    expect(toasts()).toContain(MSG_409);
  });

  it("409 de OUTRO code (ex.: faixa com nota em transmissão) ⇒ o toast de erro de sempre, sem confirmação", async () => {
    filaPost = [resp(409, { error: "O nº 94 está em transmissão: consulte a situação antes", code: "NUMERACAO_FAIXA_COM_NUMERO_VIVO", detalhes: { numeros: [94] } })];
    await enviarFaixa();
    expect(toasts()).toContain("O nº 94 está em transmissão: consulte a situação antes");
    expect(dialogos()).toHaveLength(0);
    expect(posts()).toHaveLength(1);
  });
});
