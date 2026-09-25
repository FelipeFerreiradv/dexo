// @vitest-environment jsdom
//
// O WIZARD montado, no que a prontidão da V2 acrescentou:
//  - BLOQ-2: rascunho REJECTED com a reserva BLOQUEADO mostrava "Nº X:
//    BLOQUEADO" e o "Emitir" só devolvia 409 NUMERACAO_BLOQUEADA — nota morta.
//    Agora o NumeracaoActions (real) oferece descartar o nº (a nota segue aqui e
//    o próximo "Emitir" tira número NOVO) ou excluir o rascunho;
//  - B6: o 409 SEQUENCIA_ATRAS_DA_SEFAZ era só um toast de 4 s com um texto
//    longo que manda ajustar o contador em outra tela. Agora vira um quadro FIXO
//    no passo 9, com o card de ajuste ali mesmo, aberto, com o piso como apoio
//    (nunca pré-preenchido).
// Os passos são stubs; o card de ajuste também (ele tem o spec dele).

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;

const API = "http://api.test";

const h = vi.hoisted(() => ({
  navegacoes: [] as string[],
  cardProps: null as any,
}));

vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { email: "dona@dls.test" } }, status: "authenticated" }) }));
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));
vi.mock("../../app/notas-fiscais/lib/nfe-navegacao", () => ({ navegarPara: (u: string) => h.navegacoes.push(u) }));
vi.mock("../../app/notas-fiscais/components/devolucao-editor", () => ({ DevolucaoEditor: () => null }));
vi.mock("@/components/stepper/stepper-header", async () => {
  const { createElement: e } = await import("react");
  return { StepperHeader: () => e("nav", null, "passos") };
});
vi.mock("@/components/stepper/stepper-footer", async () => {
  const { createElement: e } = await import("react");
  return {
    StepperFooter: (p: any) =>
      e("footer", null,
        e("button", { type: "button", onClick: p.onBack, disabled: p.currentStep === 1 }, "Voltar"),
        p.currentStep < p.totalSteps
          ? e("button", { type: "button", onClick: p.onNext }, "Próximo")
          : e("button", { type: "button", onClick: p.onSubmit }, p.submitLabel)),
  };
});
vi.mock("@/components/ui/toast-viewport", async () => {
  const { createElement: e } = await import("react");
  return { ToastViewport: (p: any) => e("div", { role: "status", "data-toast": "" }, p.children) };
});
const { stub } = vi.hoisted(() => ({
  stub: (n: number, nome: string) => async () => {
    const { createElement: e } = await import("react");
    return { [nome]: () => e("p", null, `passo ${n} comum`) };
  },
}));
vi.mock("../../app/notas-fiscais/components/steps/step-informacoes-gerais", stub(1, "StepInformacoesGerais"));
vi.mock("../../app/notas-fiscais/components/steps/step-destinatario", stub(2, "StepDestinatario"));
vi.mock("../../app/notas-fiscais/components/steps/step-produtos", stub(3, "StepProdutos"));
vi.mock("../../app/notas-fiscais/components/steps/step-frete", stub(4, "StepFrete"));
vi.mock("../../app/notas-fiscais/components/steps/step-volumes", stub(5, "StepVolumes"));
vi.mock("../../app/notas-fiscais/components/steps/step-duplicatas", stub(6, "StepDuplicatas"));
vi.mock("../../app/notas-fiscais/components/steps/step-pagamentos", stub(7, "StepPagamentos"));
vi.mock("../../app/notas-fiscais/components/steps/step-impostos", stub(8, "StepImpostos"));
vi.mock("../../app/notas-fiscais/components/steps/step-finalizar", stub(9, "StepFinalizar"));
vi.mock("../../app/notas-fiscais/components/steps/ajuste-numeracao-card", async () => {
  const { createElement: e } = await import("react");
  return { AjusteNumeracaoCard: (p: any) => { h.cardProps = p; return e("div", { "data-testid": "card-ajuste" }, "card de ajuste"); } };
});

import { NfeWizard } from "../../app/notas-fiscais/components/nfe-wizard";

type Resp = { status: number; body?: unknown };
let container: HTMLDivElement;
let root: Root;
let chamadas: Array<{ metodo: string; url: string; body: any }>;
let rotas: Record<string, Resp | Resp[]>;

const BLOQUEADO = { estado: "BLOQUEADO", numero: 501, serie: 1, reutilizavel: false };
const MSG_CONFIRMAR = "O nº 501 (série 1) está retido para conferência: confirme que ele NÃO foi autorizado na SEFAZ antes de descartá-lo";
const MSG_ATRAS = "Os nºs 10, 11, 12 da série 1 já existiam na SEFAZ com outra chave: o contador do Dexo está atrás da numeração real deste CNPJ.";

function draft(over: Record<string, unknown> = {}) {
  return {
    id: "d1", status: "DRAFT", serie: 1, numero: -1, ambiente: "PRODUCAO", companyFiscalConfigId: "cfg-dls",
    tipoOperacao: "SAIDA", finalidade: "NORMAL", destinoOperacao: "INTERNA", naturezaOperacao: "VENDA DE MERCADORIA", indPresenca: "NAO_SE_APLICA",
    destinatarioJson: { tipoPessoa: "PJ", cpfCnpj: "11222333000181", nome: "DISAUTO DISTRIBUIDORA" },
    itens: [{ numero: 1, codigo: "P1", descricao: "Farol", ncm: "87081000", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 664.58, valorTotal: 664.58 }],
    modalidadeFrete: "SEM_FRETE",
    pagamentosJson: [{ meio: "DINHEIRO", valor: 664.58 }],
    ...over,
  };
}

const texto = () => container.textContent ?? "";
const botao = (rotulo: string, el: ParentNode = container) =>
  Array.from(el.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === rotulo) as HTMLButtonElement | undefined;
async function assentar(vezes = 4) {
  for (let i = 0; i < vezes; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function clicar(rotulo: string, el?: ParentNode) {
  const b = botao(rotulo, el);
  if (!b) throw new Error(`botão "${rotulo}" não está na tela. Texto: ${texto()}`);
  await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await assentar();
}
async function montar() {
  window.history.replaceState({}, "", "/notas-fiscais/nfe?draft=d1");
  await act(async () => { root.render(<NfeWizard />); });
  await assentar(8);
}
async function irAoPasso9() {
  for (let i = 0; i < 8; i++) await clicar("Próximo");
  expect(texto()).toContain("passo 9 comum");
}
const quadroAtras = () => container.querySelector('[role="alert"][aria-label="O contador desta série está atrás da SEFAZ"]');
const issues = () => chamadas.filter((c) => c.metodo === "POST" && c.url === "/fiscal/nfe/d1/issue");

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  chamadas = [];
  h.navegacoes = [];
  h.cardProps = null;
  rotas = {
    "GET /fiscal/nfe/draft/d1": { status: 200, body: { draft: draft() } },
    "PUT /fiscal/nfe/draft/d1": { status: 200, body: {} },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const metodo = init?.method ?? "GET";
    const caminho = url.replace(API, "");
    chamadas.push({ metodo, url: caminho, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = rotas[`${metodo} ${caminho}`];
    const resp = Array.isArray(r) ? (r.length > 1 ? r.shift() : r[0]) : r;
    if (!resp) throw new Error(`chamada inesperada: ${metodo} ${caminho}`);
    return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, json: async () => resp.body ?? {} };
  }));
});
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("wizard: rascunho com o nº BLOQUEADO", () => {
  beforeEach(() => {
    rotas["GET /fiscal/nfe/draft/d1"] = { status: 200, body: { draft: draft({ status: "REJECTED", numero: 501, motivoRejeicao: "Nº 501 retido para conferência", numeracao: BLOQUEADO }) } };
  });

  it("descartar o nº: confirmação ⇒ o quadro do nº some, a nota fica AQUI e o próximo 'Emitir' vai sem confirmar descarte", async () => {
    rotas["POST /fiscal/nfe/d1/numeracao/descartar-bloqueado"] = [
      { status: 409, body: { error: MSG_CONFIRMAR, code: "NUMERACAO_CONFIRMAR_DESCARTE", detalhes: { numero: 501, serie: 1 } } },
      { status: 200, body: { ok: true, numeroDescartado: 501, serie: 1 } },
    ];
    rotas["POST /fiscal/nfe/d1/issue"] = { status: 200, body: { success: true, status: "AUTHORIZED", numero: 502, chaveAcesso: "42260900000000000000550010000005021234567890", numeracao: { estado: "AUTORIZADO", numero: 502 } } };
    await montar();
    expect(texto()).toContain("Nº 501: retido para conferência");
    await clicar("Descartar o nº 501 e emitir com número novo");
    const dialogo = container.querySelector('[role="alertdialog"][aria-label="Confirmar descarte"]')!;
    expect(dialogo?.textContent).toContain(MSG_CONFIRMAR);
    await act(async () => { Array.from(dialogo.querySelectorAll("button")).find((b) => b.textContent !== "Cancelar")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await assentar();
    expect(chamadas.filter((c) => c.url.endsWith("/descartar-bloqueado")).map((c) => c.body)).toEqual([{}, { confirmar: true }]);
    expect(texto()).not.toContain("Nº 501: retido para conferência");
    expect(container.querySelector('[data-toast]')?.textContent).toContain("Nº 501 descartado");
    expect(h.navegacoes).toEqual([]);
    await irAoPasso9();
    await clicar("Emitir NF-e");
    expect(issues()).toHaveLength(1);
    expect(issues()[0].body).toEqual({ confirmarDescarteNumero: false });
  });

  it("excluir o rascunho: confirmação ⇒ DELETE ?descartarNumero=true ⇒ volta para Notas Emitidas", async () => {
    rotas["DELETE /fiscal/nfe/draft/d1"] = { status: 409, body: { error: MSG_CONFIRMAR, code: "NUMERACAO_CONFIRMAR_DESCARTE" } };
    rotas["DELETE /fiscal/nfe/draft/d1?descartarNumero=true"] = { status: 204 };
    await montar();
    await clicar("Excluir rascunho");
    await clicar("Descartar e soltar o número", container.querySelector('[role="alertdialog"]')!);
    expect(chamadas.filter((c) => c.metodo === "DELETE").map((c) => c.url)).toEqual(["/fiscal/nfe/draft/d1", "/fiscal/nfe/draft/d1?descartarNumero=true"]);
    expect(h.navegacoes).toEqual(["/notas-fiscais/emitidas"]);
  });
});

describe("wizard: 409 SEQUENCIA_ATRAS_DA_SEFAZ vira quadro fixo com o ajuste ali mesmo", () => {
  const CORPO = { error: MSG_ATRAS, code: "SEQUENCIA_ATRAS_DA_SEFAZ", detalhes: { numeros: [10, 11, 12], serie: 1, ambiente: "PRODUCAO", modelo: "55", proximoNumeroAtual: 13, proximoNumeroMinimo: 14 } };

  it("o quadro fica depois que o toast some, com o card ABERTO e o piso só como apoio", async () => {
    rotas["POST /fiscal/nfe/d1/issue"] = { status: 409, body: CORPO };
    await montar();
    await irAoPasso9();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await clicar("Emitir NF-e");
    const quadro = quadroAtras();
    expect(quadro, texto()).toBeTruthy();
    expect(quadro!.textContent).toContain(MSG_ATRAS);
    expect(quadro!.querySelector('[data-testid="card-ajuste"]')).toBeTruthy();
    expect(h.cardProps).toMatchObject({ userEmail: "dona@dls.test", configExists: true, companyId: "cfg-dls", ambientePadrao: "PRODUCAO", seriePadrao: 1, abertoInicial: true, pisoSugerido: 14 });
    // O toast (4 s) some; o quadro não.
    await act(async () => { vi.advanceTimersByTime(4500); });
    expect(container.querySelector('[data-toast]')).toBeNull();
    expect(quadroAtras()).toBeTruthy();
  });

  it("emitiu de novo e passou ⇒ o quadro sai", async () => {
    rotas["POST /fiscal/nfe/d1/issue"] = [
      { status: 409, body: CORPO },
      { status: 200, body: { success: true, status: "AUTHORIZED", numero: 14, chaveAcesso: "42260900000000000000550010000000141234567890", numeracao: { estado: "AUTORIZADO", numero: 14 } } },
    ];
    await montar();
    await irAoPasso9();
    await clicar("Emitir NF-e");
    expect(quadroAtras()).toBeTruthy();
    await clicar("Emitir NF-e");
    expect(quadroAtras()).toBeNull();
  });

  it("outro erro (ex.: NUMERACAO_BLOQUEADA) ⇒ sem quadro, só o toast de sempre", async () => {
    rotas["POST /fiscal/nfe/d1/issue"] = { status: 409, body: { error: "Numeração nº 3 exige conferência manual", code: "NUMERACAO_BLOQUEADA" } };
    await montar();
    await irAoPasso9();
    await clicar("Emitir NF-e");
    expect(quadroAtras()).toBeNull();
    expect(h.cardProps).toBeNull();
    expect(container.querySelector('[data-toast]')?.textContent).toContain("Numeração nº 3 exige conferência manual");
  });

  it("rascunho V1 (sem a chave `numeracao`): nenhum quadro de numeração", async () => {
    await montar();
    expect(texto()).not.toContain("Nº ");
    expect(botao("Excluir rascunho")).toBeUndefined();
  });
});
