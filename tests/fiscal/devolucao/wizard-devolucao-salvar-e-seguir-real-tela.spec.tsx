// @vitest-environment jsdom
//
// "Salvar e seguir" de PONTA A PONTA, com o editor da devolução DE VERDADE
// dentro do wizard (G4 #6, onda 5).
//
// O `wizard-devolucao-guarda-tela.spec.tsx` ao lado usa um editor de mentira de
// propósito: ele mede a navegação do wizard. Mas o "Salvar e seguir" depende de
// um contrato entre os DOIS arquivos: o wizard aperta o botão do editor cujo
// texto começa com "Salvar", e só segue quando o editor chama `onSaved`; quem
// limpa o "há edição não salva" é o editor (`onDirtyChange(false)`), não o
// wizard. Se um dos lados mudar o rótulo, o momento do aviso ou o corpo do PUT,
// só este teste percebe: aqui o editor é o real, o PUT é o real, e o caminho é
// o da DLS — mexeu na quantidade no passo 3, clicou "Próximo", escolheu
// "Salvar e seguir".
//
// Os passos comuns do wizard são stubs (não são o que se mede).

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ navegacoes: [] as string[] }));

vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { email: "dona@dls.test" } }, status: "authenticated" }) }));
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));
vi.mock("../../../app/notas-fiscais/lib/nfe-navegacao", () => ({ navegarPara: (u: string) => h.navegacoes.push(u) }));
vi.mock("@/components/stepper/stepper-header", async () => {
  const { createElement: e } = await import("react");
  return {
    StepperHeader: (p: any) =>
      e("nav", null, p.steps.map((s: any) =>
        e("button", { key: s.id, type: "button", "data-passo": s.id, disabled: !(s.id < p.currentStep), onClick: () => s.id < p.currentStep && p.onGoToStep?.(s.id) }, s.title))),
  };
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
  return { ToastViewport: (p: any) => e("div", { role: "status" }, p.children) };
});
const { stub } = vi.hoisted(() => ({
  stub: (n: number, nome: string) => async () => {
    const { createElement: e } = await import("react");
    return { [nome]: () => e("p", null, `passo ${n} comum`) };
  },
}));
vi.mock("../../../app/notas-fiscais/components/steps/step-informacoes-gerais", stub(1, "StepInformacoesGerais"));
vi.mock("../../../app/notas-fiscais/components/steps/step-destinatario", stub(2, "StepDestinatario"));
vi.mock("../../../app/notas-fiscais/components/steps/step-produtos", stub(3, "StepProdutos"));
vi.mock("../../../app/notas-fiscais/components/steps/step-frete", stub(4, "StepFrete"));
vi.mock("../../../app/notas-fiscais/components/steps/step-volumes", stub(5, "StepVolumes"));
vi.mock("../../../app/notas-fiscais/components/steps/step-duplicatas", stub(6, "StepDuplicatas"));
vi.mock("../../../app/notas-fiscais/components/steps/step-pagamentos", stub(7, "StepPagamentos"));
vi.mock("../../../app/notas-fiscais/components/steps/step-impostos", stub(8, "StepImpostos"));
vi.mock("../../../app/notas-fiscais/components/steps/step-finalizar", stub(9, "StepFinalizar"));

import { NfeWizard } from "../../../app/notas-fiscais/components/nfe-wizard";
import {
  ALTERACOES_NAO_SALVAS,
  GUARDA_NAO_DA_PARA_SALVAR,
  GUARDA_TITULO,
  TEXTO_DEVOLUCAO_SEM_COBRANCA,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-wizard-ui";
import { regimeEmitenteDevolucao } from "../../../app/fiscal/devolucao/tributacao";

const API = "http://api.test";
const CHAVE = "42260980689839000975550010008528991757991829";
type Resp = { status: number; body?: unknown };

function draft() {
  return {
    id: "d1", status: "DRAFT", serie: 1, numero: 0, ambiente: "PRODUCAO", companyFiscalConfigId: "cfg-dls",
    tipoOperacao: "SAIDA", finalidade: "DEVOLUCAO", destinoOperacao: "INTERNA", naturezaOperacao: "Devolucao de compra",
    indPresenca: "NAO_SE_APLICA",
    destinatarioJson: { tipoPessoa: "PJ", cpfCnpj: "80689839000975", nome: "DISAUTO" },
    itens: [{ numero: 1, codigo: "33603-3", descricao: "RETENTOR", ncm: "84133090", cfop: "5202", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 123.56, valorTotal: 123.56 }],
    modalidadeFrete: "SEM_FRETE",
    pagamentosJson: [{ meio: "SEM_PAGAMENTO", valor: 0 }],
  };
}

function detalhe(quantidade: number) {
  return {
    draftId: "d1", status: "DRAFT", tipo: "COMPRA_SAIDA", fonte: "XML_IMPORTADO", escopo: "PARCIAL", devolvidaAposEntrega: true,
    confirmadoSemXml: false, indFinal: "0", modoReferencia: "ITEM", emitente: regimeEmitenteDevolucao("SIMPLES", "COMPRA_SAIDA"),
    originais: [{ chaveAcesso: CHAVE, originalNfeId: null, modelo: "55", numero: 852899, serie: 1, dataEmissao: null, destinatarioNome: "DISAUTO" }],
    itens: [{
      ordem: 1, chaveAcesso: CHAVE, nItem: 5, codigo: "33603-3", descricao: "RETENTOR", unidade: "UN", ncm: "84133090",
      quantidadeOriginal: 3, devolvidaAutorizada: 0, emProcessamento: 0, disponivel: 3, quantidade, valorUnitario: 123.56, valor: 123.56 * quantidade,
      cfopOriginal: "5102", cfop: "5202", cfopStatus: "ESCOLHA", cfopOpcoes: ["5202"],
      tributacao: {
        versao: 1, fonte: "XML_ORIGINAL", icms: { tag: "ICMSSN102", cst: null, csosn: "102", orig: 0, modBC: null, vBC: 0, pICMS: 0, vICMS: 0 },
        pis: { cst: "49", vBC: 0, p: 0, v: 0 }, cofins: { cst: "49", vBC: 0, p: 0, v: 0 }, ipiDevol: null, requerRevisao: true, motivosRevisao: [], avisos: [], confirmada: false,
      },
      requerRevisao: true,
    }],
    issues: [], podeEmitir: false,
  };
}

let container: HTMLDivElement;
let root: Root;
let chamadas: Array<{ metodo: string; url: string; corpo: any }>;
let rotas: Record<string, Resp | Resp[]>;

const texto = () => container.textContent ?? "";
const botao = (rotulo: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === rotulo) as HTMLButtonElement | undefined;
const quantidade = () => container.querySelector(`[data-linha="${CHAVE}#5"] input[aria-label="Quantidade"]`) as HTMLInputElement | null;
const passo = () => {
  const m = /passo (\d) comum/.exec(texto());
  if (m) return Number(m[1]);
  return container.querySelector('[aria-label="Devolução fiscal"]') ? "editor" : null;
};

async function assentar(vezes = 4) {
  for (let i = 0; i < vezes; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function clicar(rotulo: string) {
  const b = botao(rotulo);
  if (!b) throw new Error(`botão "${rotulo}" não está na tela. Texto: ${texto()}`);
  await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await assentar();
}
async function digitar(el: HTMLInputElement | null, valor: string) {
  if (!el) throw new Error(`campo ausente. Texto: ${texto()}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, valor);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await assentar();
}
async function montar() {
  window.history.replaceState({}, "", "/notas-fiscais/nfe?draft=d1");
  await act(async () => { root.render(<NfeWizard />); });
  await assentar(8);
}
/** Do passo 1 (editor) ao passo 3 (editor, "Produtos"). */
async function irAoPasso3() {
  await clicar("Próximo");
  expect(passo()).toBe(2);
  await clicar("Próximo");
  expect(quantidade()).not.toBeNull();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  chamadas = [];
  h.navegacoes = [];
  rotas = {
    "GET /fiscal/nfe/draft/d1": { status: 200, body: { draft: draft() } },
    "GET /fiscal/nfe/draft/d1/devolucao": { status: 200, body: detalhe(1) },
    "PUT /fiscal/nfe/draft/d1": { status: 200, body: {} },
    "PUT /fiscal/nfe/draft/d1/devolucao/itens": { status: 200, body: detalhe(2) },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const metodo = init?.method ?? "GET";
    const caminho = url.replace(API, "");
    chamadas.push({ metodo, url: caminho, corpo: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = rotas[`${metodo} ${caminho}`];
    const resp = Array.isArray(r) ? r.shift() : r;
    if (!resp) throw new Error(`chamada inesperada: ${metodo} ${caminho}`);
    return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, json: async () => resp.body ?? {} };
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("'Salvar e seguir' com o editor DE VERDADE (G4 #6)", () => {
  it("mexeu na quantidade no passo 3 → Próximo → 'Salvar e seguir': o PUT sai com a quantidade nova e o wizard segue para o 4", async () => {
    await montar();
    await irAoPasso3();
    await digitar(quantidade(), "2");
    expect(texto()).toContain(ALTERACOES_NAO_SALVAS);
    await clicar("Próximo");
    expect(texto()).toContain(GUARDA_TITULO);
    expect(quantidade()).not.toBeNull();
    await clicar("Salvar e seguir");
    const put = chamadas.filter((c) => c.metodo === "PUT" && c.url === "/fiscal/nfe/draft/d1/devolucao/itens");
    expect(put).toHaveLength(1);
    expect(put[0].corpo.itens).toEqual([{ chaveAcesso: CHAVE, nItem: 5, quantidade: 2, cfop: "5202", confirmarTributacao: false }]);
    // Seguiu, sem pergunta aberta, e o "não salvo" sumiu (quem limpa é o editor).
    expect(passo()).toBe(4);
    expect(texto()).not.toContain(GUARDA_TITULO);
    expect(texto()).not.toContain(ALTERACOES_NAO_SALVAS);
    expect(texto()).toMatch(/Salvo \d/);
  });

  it("servidor recusou (409): fica no passo 3, a frase aparece na peça e a guarda continua aberta", async () => {
    rotas["PUT /fiscal/nfe/draft/d1/devolucao/itens"] = {
      status: 409,
      body: { error: "Quantidade maior que o saldo disponível para devolução.", code: "SALDO_INSUFICIENTE", issues: [{ code: "SALDO_EXCEDIDO", severidade: "ERRO", ordem: 1, nItem: 5, chaveAcesso: CHAVE, mensagem: "Item 1: 33603-3 (item 5 da nota original): pedida 2, disponível 1." }] },
    };
    await montar();
    await irAoPasso3();
    await digitar(quantidade(), "2");
    await clicar("Próximo");
    await clicar("Salvar e seguir");
    expect(quantidade()).not.toBeNull();
    expect(texto()).toContain(GUARDA_TITULO);
    expect(container.querySelector(`[data-linha="${CHAVE}#5"] [aria-label="Recusado pelo Dexo"]`)?.textContent).toContain("pedida 2, disponível 1");
    await clicar("Descartar e seguir");
    expect(passo()).toBe(4);
  });

  it("o quadro trava o salvar (quantidade apagada): 'Salvar e seguir' diz o porquê e não manda nada", async () => {
    await montar();
    await irAoPasso3();
    await digitar(quantidade(), "");
    await clicar("Próximo");
    await clicar("Salvar e seguir");
    expect(texto()).toContain(GUARDA_NAO_DA_PARA_SALVAR);
    expect(chamadas.filter((c) => c.url === "/fiscal/nfe/draft/d1/devolucao/itens")).toHaveLength(0);
    expect(quantidade()).not.toBeNull();
  });

  it("passos 6 e 7 da devolução: a frase sem o 'pagamento 90'", async () => {
    await montar();
    await irAoPasso3();
    await clicar("Próximo");
    await clicar("Próximo");
    await clicar("Próximo");
    expect(texto()).toContain(TEXTO_DEVOLUCAO_SEM_COBRANCA);
    expect(texto()).not.toContain("pagamento 90");
  });
});
