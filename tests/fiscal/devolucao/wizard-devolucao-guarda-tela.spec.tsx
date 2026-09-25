// @vitest-environment jsdom
//
// O WIZARD montado de verdade na devolução — a guarda de navegação, o rascunho
// feito à mão, o selo "Salvo" e o destino depois de autorizar.
//
// O caso da DLS AUTO PEÇAS (24/09/2026): nos passos 1, 3 e 8 da devolução só
// "Salvar devolução" grava. "Próximo", "Voltar" e o clique num passo trocavam
// de passo e jogavam fora, sem aviso, o que ela tinha mexido — e a página diz
// "o rascunho é salvo automaticamente". A trilha de produção mostra 33 saves
// num rascunho só: ela aprendeu a salvar em cada passo a cada volta.
//
// O editor aqui é de MENTIRA de propósito (é de outro grupo e muda junto): ele
// só cumpre o contrato `onDirtyChange(sujo)` + `onSaved(detalhe)` e tem um
// botão "Salvar devolução", que é o que o "Salvar e seguir" da guarda aciona.
// Os passos comuns também são stubs: o que se mede é a navegação do wizard.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const EMAIL = "dona@dls.test";
const API = "http://api.test";

const h = vi.hoisted(() => ({
  navegacoes: [] as string[],
  salvou: 0,
  /** true = o "servidor" recusa o save do editor de mentira (onSaved não vem). */
  recusarSave: false,
  finalizarProps: null as any,
}));

vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { email: "dona@dls.test" } }, status: "authenticated" }) }));
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));
vi.mock("../../../app/notas-fiscais/lib/nfe-navegacao", () => ({ navegarPara: (u: string) => h.navegacoes.push(u) }));

vi.mock("../../../app/notas-fiscais/components/devolucao-editor", async () => {
  const { createElement: e } = await import("react");
  return {
    DevolucaoEditor: (p: any) =>
      e("section", { "aria-label": "Devolução fiscal" },
        e("p", null, `editor passo ${p.step}`),
        e("button", { type: "button", onClick: () => p.onDirtyChange?.(true) }, "Mexer na quantidade"),
        e("button", {
          type: "button",
          onClick: async () => {
            h.salvou++;
            if (h.recusarSave) return;
            await p.onSaved(p.value);
            p.onDirtyChange?.(false);
          },
        }, "Salvar devolução")),
  };
});
// Cabeçalho e rodapé do stepper: stubs com os MESMOS callbacks (os reais não
// trazem React em escopo para o jsdom). O cabeçalho só deixa clicar passo anterior.
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
vi.mock("../../../app/notas-fiscais/components/steps/step-informacoes-gerais", async () => {
  const { createElement: e } = await import("react");
  const { useController } = await import("react-hook-form");
  return {
    StepInformacoesGerais: (p: any) => {
      const { field } = useController({ control: p.control, name: "finalidade" });
      return e("div", null,
        e("p", null, `passo 1 comum (${field.value})`),
        e("button", { type: "button", onClick: () => field.onChange("DEVOLUCAO") }, "Escolher finalidade Devolução"),
        e("button", { type: "button", onClick: () => field.onChange("NORMAL") }, "Escolher finalidade Normal"));
    },
  };
});
const { stub } = vi.hoisted(() => ({
  stub: (n: number, nome: string) => async () => {
    const { createElement: e } = await import("react");
    return { [nome]: () => e("p", null, `passo ${n} comum`) };
  },
}));
vi.mock("../../../app/notas-fiscais/components/steps/step-destinatario", stub(2, "StepDestinatario"));
vi.mock("../../../app/notas-fiscais/components/steps/step-produtos", stub(3, "StepProdutos"));
vi.mock("../../../app/notas-fiscais/components/steps/step-frete", stub(4, "StepFrete"));
vi.mock("../../../app/notas-fiscais/components/steps/step-volumes", stub(5, "StepVolumes"));
vi.mock("../../../app/notas-fiscais/components/steps/step-duplicatas", stub(6, "StepDuplicatas"));
vi.mock("../../../app/notas-fiscais/components/steps/step-pagamentos", stub(7, "StepPagamentos"));
vi.mock("../../../app/notas-fiscais/components/steps/step-impostos", stub(8, "StepImpostos"));
vi.mock("../../../app/notas-fiscais/components/steps/step-finalizar", async () => {
  const { createElement: e } = await import("react");
  return { StepFinalizar: (p: any) => { h.finalizarProps = p; return e("p", null, "passo 9 finalizar"); } };
});

import { NfeWizard } from "../../../app/notas-fiscais/components/nfe-wizard";
import {
  ALTERACOES_NAO_SALVAS,
  AVISO_REAPROVEITADA,
  GUARDA_NAO_DA_PARA_SALVAR,
  GUARDA_TITULO,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-wizard-ui";

type Resp = { status: number; body?: unknown };

let container: HTMLDivElement;
let root: Root;
let chamadas: Array<{ metodo: string; url: string }>;
let rotas: Record<string, Resp | Resp[]>;

function draft(finalidade: string) {
  return {
    id: "d1",
    status: "DRAFT",
    serie: 1,
    numero: 0,
    ambiente: "PRODUCAO",
    companyFiscalConfigId: "cfg-dls",
    tipoOperacao: "SAIDA",
    finalidade,
    destinoOperacao: "INTERNA",
    naturezaOperacao: "Devolucao de compra",
    indPresenca: "NAO_SE_APLICA",
    destinatarioJson: { tipoPessoa: "PJ", cpfCnpj: "11222333000181", nome: "DISAUTO DISTRIBUIDORA" },
    itens: [{ numero: 1, codigo: "P1", descricao: "Farol", ncm: "87081000", cfop: "5202", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 664.58, valorTotal: 664.58 }],
    modalidadeFrete: "SEM_FRETE",
    pagamentosJson: [{ meio: "SEM_PAGAMENTO", valor: 0 }],
  };
}

const DETALHE = {
  draftId: "d1",
  status: "DRAFT",
  tipo: "COMPRA_SAIDA",
  fonte: "XML_IMPORTADO",
  escopo: "PARCIAL",
  devolvidaAposEntrega: true,
  confirmadoSemXml: false,
  indFinal: "0",
  modoReferencia: "ITEM",
  emitente: {},
  originais: [],
  itens: [],
  issues: [],
  podeEmitir: true,
  totais: { totalProdutos: 664.58, totalDesconto: 0, totalFrete: 0, totalBcIcms: 0, totalIcms: 0, totalPis: 0, totalCofins: 0, totalIpiDevol: 12.5, totalNota: 677.08, completo: true, itensPendentes: [] },
};

const texto = () => container.textContent ?? "";
const botao = (rotulo: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === rotulo) as HTMLButtonElement | undefined;

async function assentar(vezes = 4) {
  for (let i = 0; i < vezes; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function clicar(rotulo: string) {
  const b = botao(rotulo);
  if (!b) throw new Error(`botão "${rotulo}" não está na tela. Texto: ${texto()}`);
  await act(async () => {
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await assentar();
}

async function montar(url = "/notas-fiscais/nfe?draft=d1") {
  window.history.replaceState({}, "", url);
  await act(async () => {
    root.render(<NfeWizard />);
  });
  await assentar(8);
}

/** Passo atual, pelo editor de mentira ou pelos stubs dos passos comuns. */
const passo = () => {
  const m = /editor passo (\d)|passo (\d) comum|passo (9) finalizar/.exec(texto());
  return m ? Number(m[1] ?? m[2] ?? m[3]) : null;
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  chamadas = [];
  h.navegacoes = [];
  h.salvou = 0;
  h.recusarSave = false;
  h.finalizarProps = null;
  rotas = {
    "GET /fiscal/nfe/draft/d1": { status: 200, body: { draft: draft("DEVOLUCAO") } },
    "GET /fiscal/nfe/draft/d1/devolucao": { status: 200, body: DETALHE },
    "PUT /fiscal/nfe/draft/d1": { status: 200, body: {} },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const metodo = init?.method ?? "GET";
      const caminho = url.replace(API, "");
      chamadas.push({ metodo, url: caminho });
      const r = rotas[`${metodo} ${caminho}`];
      const resp = Array.isArray(r) ? r.shift() : r;
      if (!resp) throw new Error(`chamada inesperada: ${metodo} ${caminho}`);
      return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, json: async () => resp.body ?? {} };
    }),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("guarda de navegação na devolução — pergunta, e nunca prende", () => {
  it("sem edição pendente, Próximo segue direto (como antes)", async () => {
    await montar();
    expect(passo()).toBe(1);
    await clicar("Próximo");
    expect(passo()).toBe(2);
    expect(texto()).not.toContain(GUARDA_TITULO);
  });

  it("mexeu e clicou Próximo: pergunta e NÃO troca de passo", async () => {
    await montar();
    await clicar("Mexer na quantidade");
    await clicar("Próximo");
    expect(texto()).toContain(GUARDA_TITULO);
    expect(texto()).toContain("passo 2 (Destinatario)");
    expect(passo()).toBe(1);
    // As três saídas estão lá.
    expect(botao("Salvar e seguir")).toBeTruthy();
    expect(botao("Descartar e seguir")).toBeTruthy();
    expect(botao("Ficar neste passo")).toBeTruthy();
  });

  it("'Descartar e seguir' troca de passo sem salvar", async () => {
    await montar();
    await clicar("Mexer na quantidade");
    await clicar("Próximo");
    await clicar("Descartar e seguir");
    expect(passo()).toBe(2);
    expect(h.salvou).toBe(0);
    expect(texto()).not.toContain(GUARDA_TITULO);
  });

  it("'Ficar neste passo' fecha a pergunta e mantém o passo", async () => {
    await montar();
    await clicar("Mexer na quantidade");
    await clicar("Próximo");
    await clicar("Ficar neste passo");
    expect(passo()).toBe(1);
    expect(texto()).not.toContain(GUARDA_TITULO);
  });

  it("'Salvar e seguir' aciona o salvar DO QUADRO e só segue quando o servidor aceita", async () => {
    await montar();
    await clicar("Mexer na quantidade");
    await clicar("Próximo");
    await clicar("Salvar e seguir");
    expect(h.salvou).toBe(1);
    expect(passo()).toBe(2);
    expect(texto()).not.toContain(GUARDA_TITULO);
  });

  it("save recusado: fica no passo, a pergunta continua e dá para descartar e seguir", async () => {
    h.recusarSave = true;
    await montar();
    await clicar("Mexer na quantidade");
    await clicar("Próximo");
    await clicar("Salvar e seguir");
    expect(h.salvou).toBe(1);
    expect(passo()).toBe(1);
    expect(texto()).toContain(GUARDA_TITULO);
    await clicar("Descartar e seguir");
    expect(passo()).toBe(2);
  });

  it("Voltar e o clique num passo anterior também perguntam (passo 3 → 1)", async () => {
    await montar();
    await clicar("Próximo");
    await clicar("Próximo");
    expect(passo()).toBe(3);
    await clicar("Mexer na quantidade");
    await clicar("Voltar");
    expect(texto()).toContain(GUARDA_TITULO);
    expect(passo()).toBe(3);
    await clicar("Ficar neste passo");
    const cabecalho = container.querySelector('nav button[data-passo="1"]') as HTMLButtonElement;
    await act(async () => cabecalho.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await assentar();
    expect(texto()).toContain("passo 1 (Informacoes)");
    expect(passo()).toBe(3);
  });

  it("com edição pendente, o rodapé diz que não está salvo e o navegador segura o fechar da aba", async () => {
    await montar();
    await clicar("Mexer na quantidade");
    expect(texto()).toContain(ALTERACOES_NAO_SALVAS);
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await clicar("Salvar devolução");
    expect(texto()).not.toContain(ALTERACOES_NAO_SALVAS);
    expect(texto()).toMatch(/Salvo \d/);
    const ev2 = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
  });

  it("botão de salvar travado no quadro: a guarda diz por quê e não finge que salvou", async () => {
    await montar();
    await clicar("Mexer na quantidade");
    await clicar("Próximo");
    botao("Salvar devolução")!.disabled = true;
    await clicar("Salvar e seguir");
    expect(h.salvou).toBe(0);
    expect(texto()).toContain(GUARDA_NAO_DA_PARA_SALVAR);
    expect(passo()).toBe(1);
  });
});

describe("NF-e comum — nada muda", () => {
  it("rascunho NORMAL: sem editor, sem guarda, sem GET da devolução", async () => {
    rotas["GET /fiscal/nfe/draft/d1"] = { status: 200, body: { draft: draft("NORMAL") } };
    await montar();
    expect(texto()).toContain("passo 1 comum (NORMAL)");
    await clicar("Próximo");
    expect(passo()).toBe(2);
    expect(texto()).not.toContain(GUARDA_TITULO);
    expect(chamadas.some((c) => c.url.endsWith("/devolucao"))).toBe(false);
    // O save do passo 1 da nota comum continua saindo.
    expect(chamadas.filter((c) => c.metodo === "PUT" && c.url === "/fiscal/nfe/draft/d1")).toHaveLength(1);
  });
});

describe("rascunho de devolução feito à mão — o aviso sai no passo 1", () => {
  it("404 DEVOLUCAO_NAO_GERENCIADA ⇒ quadro com o caminho certo e o descarte, já no passo 1", async () => {
    rotas["GET /fiscal/nfe/draft/d1/devolucao"] = { status: 404, body: { error: "Este rascunho não é uma devolução gerenciada.", code: "DEVOLUCAO_NAO_GERENCIADA" } };
    await montar();
    expect(passo()).toBe(1);
    expect(texto()).toContain("Este rascunho de devolução não vai emitir");
    expect(texto()).toContain("Devolução manual");
    expect(botao("Descartar este rascunho")).toBeTruthy();
  });

  it("404 sem código (devolução desligada para a empresa) ⇒ mudo, como antes", async () => {
    rotas["GET /fiscal/nfe/draft/d1/devolucao"] = { status: 404, body: { error: "Recurso indisponível" } };
    await montar();
    expect(texto()).not.toContain("não vai emitir");
    expect(texto()).not.toContain("não se faz por aqui");
  });

  it("descartar: o 409 do número vira pergunta clara; confirmado, descarta e volta para a lista", async () => {
    rotas["GET /fiscal/nfe/draft/d1/devolucao"] = { status: 404, body: { code: "DEVOLUCAO_NAO_GERENCIADA" } };
    rotas["DELETE /fiscal/nfe/draft/d1"] = { status: 409, body: { code: "NUMERACAO_CONFIRMAR_DESCARTE", error: "O nº 712 (série 1) ficará sem uso e precisará ser inutilizado" } };
    rotas["DELETE /fiscal/nfe/draft/d1?descartarNumero=true"] = { status: 204 };
    await montar();
    await clicar("Descartar este rascunho");
    expect(texto()).toContain("nº 712");
    expect(texto()).toContain("até o dia 10 do mês seguinte");
    expect(h.navegacoes).toEqual([]);
    await clicar("Descartar e soltar o número");
    expect(h.navegacoes).toEqual(["/notas-fiscais/emitidas"]);
  });

  it("NF-e comum: escolher 'Devolução' no passo 1 já mostra o caminho certo (sem descarte)", async () => {
    rotas["GET /fiscal/nfe/draft/d1"] = { status: 200, body: { draft: draft("NORMAL") } };
    rotas["GET /fiscal/nfe/draft/d1/devolucao"] = { status: 404, body: { code: "DEVOLUCAO_NAO_GERENCIADA" } };
    await montar();
    expect(texto()).not.toContain("não se faz por aqui");
    await clicar("Escolher finalidade Devolução");
    expect(texto()).toContain("A devolução não se faz por aqui");
    expect(botao("Descartar este rascunho")).toBeUndefined();
    await clicar("Escolher finalidade Normal");
    expect(texto()).not.toContain("não se faz por aqui");
  });

  it("422 EXIGE_NUMERACAO_V2 também deixa de ser engolido", async () => {
    rotas["GET /fiscal/nfe/draft/d1/devolucao"] = { status: 422, body: { code: "EXIGE_NUMERACAO_V2", error: "x" } };
    await montar();
    expect(texto()).toContain("ainda não emite devolução pelo Dexo");
  });
});

describe("reaproveitada, passo 9 e depois de autorizar", () => {
  it("aberta por 'reaproveitada=1' ⇒ diz que era a devolução que já existia", async () => {
    await montar("/notas-fiscais/nfe?draft=d1&reaproveitada=1");
    expect(texto()).toContain(AVISO_REAPROVEITADA);
  });

  it("o passo 9 recebe os totais da devolução (valor da nota com o IPI devolvido)", async () => {
    await montar();
    for (let i = 0; i < 8; i++) await clicar("Próximo");
    expect(passo()).toBe(9);
    expect(h.finalizarProps.totaisDevolucao.totalNota).toBe(677.08);
    // Tenant de um CNPJ: a Revisão segue lendo a config padrão.
    expect(h.finalizarProps.companyFiscalConfigId).toBeNull();
  });

  it("autorizada ⇒ vai para a NOTA autorizada na lista, e não para 'Emitir NF-e'", async () => {
    rotas["POST /fiscal/nfe/d1/issue"] = { status: 200, body: { success: true, status: "AUTHORIZED", numero: 713, chaveAcesso: "4226090000", numeracao: null } };
    await montar();
    for (let i = 0; i < 8; i++) await clicar("Próximo");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await clicar("Emitir NF-e");
      await act(async () => {
        vi.advanceTimersByTime(2500);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(h.navegacoes).toEqual(["/notas-fiscais/emitidas?nfe=d1"]);
  });
});
