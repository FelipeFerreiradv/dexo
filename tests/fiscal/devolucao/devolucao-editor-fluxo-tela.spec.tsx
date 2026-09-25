// @vitest-environment jsdom
//
// O `DevolucaoEditor` MONTADO, nos passos 1 ("Informacoes") e 3 ("Produtos") —
// mesmo motivo do `devolucao-editor-icms-tela.spec.tsx` ao lado: o módulo puro
// prova a regra; só o teste montado prova que a tela não cai e que o corpo do
// PUT é o que ela vê.
//
// Casos reais (DLS AUTO PEÇAS, 24/09/2026 — devolução de 2 das 6 peças da
// DISAUTO):
//  - N-fluxo-1: zerar uma peça e salvar DERRUBAVA a tela ("Application error").
//    O estado era casado com a resposta pela posição; cinco vezes no dia, e a
//    cada vez ela recarregou e recomeçou (ou abriu outro rascunho).
//  - K11: a peça tirada sumia para sempre, embora o servidor aceite de volta.
//  - K10: apagar o número para redigitar virava 0 e tirava a peça.
//  - K9: CFOP era campo livre ao lado do CFOP de VENDA do fornecedor.
//  - N-fluxo-3: a caixinha da entrega transformava "não respondi" em "não".
//  - N-fluxo-4: "Dados da requisição inválidos." escondia a frase certa.
//  - N-fluxo-7: pendências diziam "itens 1 e 2" e os cartões "Item original 5, 6".
// E o contrato com o wizard: `onDirtyChange` avisa quando há edição não salva.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));

import { DevolucaoEditor } from "../../../app/notas-fiscais/components/devolucao-editor";
import {
  DEVOLVER_TAMBEM,
  FALHA_VEJA_AS_PECAS,
  FORA_DA_DEVOLUCAO,
  NENHUMA_PECA,
  SAI_AO_SALVAR,
  TIRAR_DA_DEVOLUCAO,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-editor-ui";
import { QUANTIDADE_VAZIA, QUANTIDADE_ZERO } from "../../../app/notas-fiscais/lib/nfe-devolucao-quantidade-campo";
import { CFOP_OBRIGATORIO, GRUPO_OUTROS, GRUPO_SUGERIDOS } from "../../../app/notas-fiscais/lib/nfe-devolucao-cfop-campo";
import { regimeEmitenteDevolucao } from "../../../app/fiscal/devolucao/tributacao";
import type { DevolucaoDetalhe, DevolucaoItemDetalhe } from "../../../app/fiscal/devolucao/contrato";
import type { TipoDevolucao, TributacaoDevolucaoItem } from "../../../app/fiscal/devolucao/tipos";

const EMAIL = "dona@dls.test";
const CHAVE = "42260980689839000975550010008528991757991829";

function tributacao(): TributacaoDevolucaoItem {
  return {
    versao: 1,
    fonte: "XML_ORIGINAL",
    icms: { tag: "ICMSSN102", cst: null, csosn: "102", orig: 0, modBC: null, vBC: 0, pICMS: 0, vICMS: 0 },
    pis: { cst: "49", vBC: 0, p: 0, v: 0 },
    cofins: { cst: "49", vBC: 0, p: 0, v: 0 },
    ipiDevol: null,
    requerRevisao: true,
    motivosRevisao: [],
    avisos: [],
    confirmada: false,
  };
}

const PECAS: Record<number, { codigo: string; descricao: string; cfopOriginal: string; disponivel: number }> = {
  1: { codigo: "LUB-1", descricao: "OLEO LUBRAX", cfopOriginal: "5655", disponivel: 3 },
  2: { codigo: "FIL-2", descricao: "FILTRO", cfopOriginal: "5102", disponivel: 1 },
  5: { codigo: "33603-3", descricao: "RETENTOR", cfopOriginal: "5102", disponivel: 2 },
};

function item(nItem: number, ordem: number, extra: Partial<DevolucaoItemDetalhe> = {}): DevolucaoItemDetalhe {
  const p = PECAS[nItem];
  return {
    ordem,
    chaveAcesso: CHAVE,
    nItem,
    codigo: p.codigo,
    descricao: p.descricao,
    unidade: "UN",
    ncm: "87089990",
    quantidadeOriginal: p.disponivel,
    devolvidaAutorizada: 0,
    emProcessamento: 0,
    disponivel: p.disponivel,
    quantidade: 1,
    valorUnitario: 100,
    valor: 100,
    cfopOriginal: p.cfopOriginal,
    cfop: "5202",
    cfopStatus: "ESCOLHA",
    cfopOpcoes: ["5202", "5201", "5411", "5410", "5553", "5556"],
    tributacao: tributacao(),
    requerRevisao: true,
    ...extra,
  };
}

function detalhe(itens: DevolucaoItemDetalhe[], extra: Partial<DevolucaoDetalhe> = {}): DevolucaoDetalhe {
  return {
    draftId: "draft-dls",
    status: "DRAFT",
    tipo: "COMPRA_SAIDA",
    fonte: "XML_IMPORTADO",
    escopo: "PARCIAL",
    devolvidaAposEntrega: null,
    confirmadoSemXml: false,
    indFinal: "0",
    modoReferencia: "ITEM",
    emitente: regimeEmitenteDevolucao("SIMPLES", "COMPRA_SAIDA"),
    originais: [{ chaveAcesso: CHAVE, originalNfeId: null, modelo: "55", numero: 852899, serie: 1, dataEmissao: "2026-09-10", destinatarioNome: null }],
    itens,
    issues: [],
    podeEmitir: false,
    ...extra,
  };
}

const TRES = () => detalhe([item(1, 1), item(2, 2), item(5, 3, { quantidade: 2 })]);

/** O servidor de mentira: grava o que veio e devolve o detalhe renumerado (como o de verdade). */
function servidor() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const corpo = JSON.parse(String(init.body)) as { itens?: Array<{ nItem: number; quantidade: number; cfop: string }> };
    const itens = (corpo.itens ?? []).map((b, k) => item(b.nItem, k + 1, { quantidade: b.quantidade, cfop: b.cfop }));
    return { ok: true, json: async () => detalhe(itens) };
  });
}

let container: HTMLDivElement;
let root: Root;
const texto = () => container.textContent ?? "";
const linha = (nItem: number) => container.querySelector(`[data-linha="${CHAVE}#${nItem}"]`) as HTMLElement | null;
const botoes = (rotulo: string, dentro: ParentNode = container) =>
  Array.from(dentro.querySelectorAll("button")).filter((b) => b.textContent === rotulo) as HTMLButtonElement[];
const salvar = () => botoes("Salvar devolução")[0];
const corpoDe = (f: { mock: { calls: unknown[][] } }, n = 0) => JSON.parse(String((f.mock.calls[n] as unknown as [string, RequestInit])[1].body));

async function assentar() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** O pai de mentira que imita o wizard: `setDevolucao(d)` e DEPOIS um `await` (o `loadDraft`). */
function Pai({ inicial, passo, onDirty }: { inicial: DevolucaoDetalhe; passo: number; onDirty?: (s: boolean) => void }) {
  const [v, setV] = React.useState(inicial);
  return (
    <DevolucaoEditor
      value={v}
      email={EMAIL}
      step={passo}
      onDirtyChange={onDirty}
      onSaved={async (d) => {
        setV(d);
        await new Promise((r) => setTimeout(r, 0));
      }}
    />
  );
}

async function montar(inicial: DevolucaoDetalhe, passo: number, onDirty?: (s: boolean) => void) {
  await act(async () => {
    root.render(<Pai inicial={inicial} passo={passo} onDirty={onDirty} />);
  });
  await assentar();
}

async function clicar(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await assentar();
}

/** Digitar num input controlado do React (o setter nativo dispara o onChange). */
async function digitar(el: HTMLInputElement, valor: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, valor);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await assentar();
}

async function escolher(s: HTMLSelectElement, valor: string) {
  await act(async () => {
    s.value = valor;
    s.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await assentar();
}

const quantidadeDe = (nItem: number) => linha(nItem)!.querySelector('input[aria-label="Quantidade"]') as HTMLInputElement;
const cfopDe = (nItem: number) => linha(nItem)!.querySelector('select[aria-label="CFOP de devolução"]') as HTMLSelectElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe("N-fluxo-1 — tirar peça e salvar NÃO derruba a tela", () => {
  it("tirar a peça do MEIO: o corpo vai com as outras e a tela fica de pé, cada linha com a SUA peça", async () => {
    const f = servidor();
    vi.stubGlobal("fetch", f);
    await montar(TRES(), 3);
    await clicar(botoes(TIRAR_DA_DEVOLUCAO, linha(2)!)[0]);
    expect(linha(2)!.textContent).toContain(SAI_AO_SALVAR);
    await clicar(salvar());

    expect(corpoDe(f).itens.map((i: { nItem: number }) => i.nItem)).toEqual([1, 5]);
    // A tela continua lá (antes: TypeError e o container vazio).
    expect(texto()).toContain("Devolução salva");
    // Renumerada como o servidor: o 33603-3 agora é o item 2 da devolução, e o
    // campo de quantidade da linha dele é o DELE (2), não o do filtro (1).
    expect(linha(5)!.textContent).toContain("Item 2 — 33603-3 — RETENTOR");
    expect(linha(5)!.textContent).toContain("(item 5 da nota original)");
    expect(quantidadeDe(5).value).toBe("2");
    expect(linha(1)!.textContent).toContain("Item 1 — LUB-1 — OLEO LUBRAX");
    // A peça tirada continua na tela, fora da devolução, com como voltar (K11).
    expect(linha(2)!.textContent).toContain(FORA_DA_DEVOLUCAO);
    expect(botoes(DEVOLVER_TAMBEM, linha(2)!)).toHaveLength(1);
  });

  it("zerar a ÚLTIMA peça digitando 0: avisa antes, salva sem ela e a tela fica de pé", async () => {
    const f = servidor();
    vi.stubGlobal("fetch", f);
    await montar(TRES(), 3);
    await digitar(quantidadeDe(5), "0");
    expect(linha(5)!.textContent).toContain(QUANTIDADE_ZERO);
    await clicar(salvar());
    expect(corpoDe(f).itens.map((i: { nItem: number }) => i.nItem)).toEqual([1, 2]);
    expect(linha(1)!.textContent).toContain("Item 1 — LUB-1");
    expect(linha(2)!.textContent).toContain("Item 2 — FIL-2");
    expect(linha(5)!.textContent).toContain(FORA_DA_DEVOLUCAO);
  });

  it("K11: a peça tirada VOLTA — o corpo a leva de novo, sem a revisão antiga", async () => {
    const f = servidor();
    vi.stubGlobal("fetch", f);
    await montar(TRES(), 3);
    await clicar(botoes(TIRAR_DA_DEVOLUCAO, linha(2)!)[0]);
    await clicar(salvar());
    await clicar(botoes(DEVOLVER_TAMBEM, linha(2)!)[0]);
    expect(quantidadeDe(2).value).toBe("1");
    await clicar(salvar());
    const segundo = corpoDe(f, 1).itens as Array<{ nItem: number; confirmarTributacao: boolean }>;
    expect(segundo.map((i) => i.nItem)).toEqual([1, 5, 2]);
    expect(segundo.find((i) => i.nItem === 2)?.confirmarTributacao).toBe(false);
    expect(linha(2)!.textContent).toContain("Item 3 — FIL-2");
  });
});

describe("K10 — quantidade: vazio não é zero, e o máximo vale de verdade", () => {
  it("campo apagado: avisa, trava o salvar e NÃO manda nada", async () => {
    const f = servidor();
    vi.stubGlobal("fetch", f);
    await montar(TRES(), 3);
    await digitar(quantidadeDe(1), "");
    expect(linha(1)!.textContent).toContain(QUANTIDADE_VAZIA);
    expect(salvar().disabled).toBe(true);
    await clicar(salvar());
    expect(f).not.toHaveBeenCalled();
  });

  it("acima do disponível (DLS: 10 com 1 disponível): trava com o número certo", async () => {
    const f = servidor();
    vi.stubGlobal("fetch", f);
    await montar(TRES(), 3);
    await digitar(quantidadeDe(2), "10");
    expect(linha(2)!.textContent).toContain("No máximo 1");
    expect(salvar().disabled).toBe(true);
  });

  it("todas as peças tiradas: diz que precisa de pelo menos uma", async () => {
    vi.stubGlobal("fetch", servidor());
    await montar(detalhe([item(1, 1)]), 3);
    await clicar(botoes(TIRAR_DA_DEVOLUCAO)[0]);
    expect(texto()).toContain(NENHUMA_PECA);
    expect(salvar().disabled).toBe(true);
  });
});

describe("K9 — CFOP é seletor com o que o servidor aceita", () => {
  it("sugeridos e outros CFOPs de devolução; o 5102 do fornecedor só como referência", async () => {
    await montar(TRES(), 3);
    const s = cfopDe(1);
    const grupos = Array.from(s.querySelectorAll("optgroup")).map((g) => g.label);
    expect(grupos).toEqual([GRUPO_SUGERIDOS, GRUPO_OUTROS]);
    const opcoes = Array.from(s.options).map((o) => o.value);
    expect(opcoes).not.toContain("5102");
    // O 5661 (devolução de compra de lubrificante) está lá, mesmo fora dos sugeridos.
    expect(opcoes).toContain("5661");
    expect(s.value).toBe("5202");
    expect(linha(2)!.textContent).toContain("CFOP de saída do fornecedor: 5102");
    // Nada de caixa livre com `maxLength=4` cortando "50202".
    expect(container.querySelector('input[maxlength="4"]')).toBeNull();
  });

  it("CFOP ainda não escolhido: trava com a frase; escolhido, vai no corpo", async () => {
    const f = servidor();
    vi.stubGlobal("fetch", f);
    await montar(detalhe([item(1, 1, { cfop: "" }), item(5, 2)]), 3);
    expect(cfopDe(1).value).toBe("");
    expect(linha(1)!.textContent).toContain(CFOP_OBRIGATORIO);
    expect(salvar().disabled).toBe(true);
    await escolher(cfopDe(1), "5661");
    expect(salvar().disabled).toBe(false);
    await clicar(salvar());
    expect(corpoDe(f).itens[0]).toMatchObject({ nItem: 1, cfop: "5661" });
  });
});

describe("N-fluxo-3 — a entrega tem três respostas: sim, não e SEM resposta", () => {
  const radios = () => Array.from(container.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];

  it("sem resposta: nada marcado, avisa, e salvar NÃO manda o campo (não vira 'não')", async () => {
    const f = servidor();
    vi.stubGlobal("fetch", f);
    await montar(TRES(), 1);
    expect(radios().map((r) => r.checked)).toEqual([false, false]);
    expect(texto()).toContain("Responda para poder emitir");
    await clicar(salvar());
    expect(corpoDe(f)).toEqual({});
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("http://api.test/fiscal/nfe/draft/draft-dls/devolucao");
  });

  it("'Sim' manda true; 'Não' manda false e diz o que isso significa", async () => {
    const f = servidor();
    vi.stubGlobal("fetch", f);
    await montar(TRES(), 1);
    await clicar(radios()[0]);
    await clicar(salvar());
    expect(corpoDe(f)).toEqual({ devolvidaAposEntrega: true });
    await clicar(radios()[1]);
    expect(texto()).toContain("Recusa na entrega não é devolução");
    await clicar(salvar());
    expect(corpoDe(f, 1)).toEqual({ devolvidaAposEntrega: false });
  });

  it("a pergunta é a do TIPO: na compra fala do fornecedor; na venda, do cliente", async () => {
    await montar(TRES(), 1);
    expect(texto()).toContain("voltando para o fornecedor");
    expect(texto()).not.toContain("Escopo");
    expect(texto()).not.toContain("Referência por");
    await act(async () => {
      root.render(<Pai key="venda" inicial={detalhe([item(1, 1)], { tipo: "VENDA_ENTRADA" as TipoDevolucao })} passo={1} />);
    });
    expect(texto()).toContain("A peça chegou ao cliente");
  });
});

describe("N-fluxo-4 — a recusa do servidor vai para a peça dela", () => {
  it("400 com `erros`: pelo corpo ENVIADO (sem a peça tirada), não pela posição da tela", async () => {
    const f = vi.fn(async () => ({
      ok: false,
      json: async () => ({
        error: "Dados da requisição inválidos.",
        code: "PAYLOAD_INVALIDO",
        erros: [{ campo: "itens[1].quantidade", mensagem: "Use no máximo 4 casas decimais." }],
      }),
    }));
    vi.stubGlobal("fetch", f);
    await montar(TRES(), 3);
    await clicar(botoes(TIRAR_DA_DEVOLUCAO, linha(2)!)[0]);
    await clicar(salvar());
    // itens[1] do corpo [1, 5] é o nItem 5 — não o 2, que está na posição 1 da tela.
    expect(linha(5)!.textContent).toContain("Quantidade: Use no máximo 4 casas decimais.");
    expect(linha(2)!.textContent).not.toContain("4 casas");
    expect(texto()).toContain(FALHA_VEJA_AS_PECAS);
  });

  it("409 com `issues`: o quadro de pendências e a frase na peça", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({
          error: "Quantidade maior que o saldo disponível para devolução.",
          code: "SALDO_INSUFICIENTE",
          issues: [{ code: "SALDO_EXCEDIDO", severidade: "ERRO", ordem: 3, mensagem: "Item 3: 33603-3 (item 5 da nota original): pedida 2, disponível 1." }],
        }),
      })),
    );
    await montar(TRES(), 3);
    await clicar(salvar());
    expect(linha(5)!.textContent).toContain("33603-3 (item 5 da nota original): pedida 2, disponível 1.");
    expect(container.querySelector('[aria-label="Pendências da devolução"]')?.textContent).toContain(
      "A quantidade é maior do que ainda pode ser devolvido no item 3",
    );
  });
});

describe("N-fluxo-7 — o número do cartão é o das pendências", () => {
  it("'Item 1 — código — descrição' com '(item 5 da nota original)' embaixo", async () => {
    await montar(detalhe([item(5, 1), item(2, 2)]), 3);
    expect(linha(5)!.textContent).toContain("Item 1 — 33603-3 — RETENTOR");
    expect(linha(5)!.textContent).toContain("(item 5 da nota original)");
    expect(texto()).not.toContain("Item original");
  });
});

describe("onDirtyChange — o wizard sabe quando há edição não salva", () => {
  it("true ao editar; false ao desfazer; true de novo; false depois de salvar", async () => {
    vi.stubGlobal("fetch", servidor());
    const sujo = vi.fn();
    await montar(TRES(), 3, sujo);
    expect(sujo).not.toHaveBeenCalled();
    await digitar(quantidadeDe(5), "1");
    expect(sujo).toHaveBeenLastCalledWith(true);
    await clicar(botoes("Desfazer alterações")[0]);
    expect(sujo).toHaveBeenLastCalledWith(false);
    expect(quantidadeDe(5).value).toBe("2");
    await digitar(quantidadeDe(5), "1");
    expect(sujo).toHaveBeenLastCalledWith(true);
    await clicar(salvar());
    expect(sujo).toHaveBeenLastCalledWith(false);
    expect(sujo.mock.calls.map((c) => c[0])).toEqual([true, false, true, false]);
  });

  it("sair do passo com edição não salva avisa false (a edição foi descartada)", async () => {
    const sujo = vi.fn();
    await montar(TRES(), 1, sujo);
    await clicar(container.querySelectorAll('input[type="radio"]')[0]);
    expect(sujo).toHaveBeenLastCalledWith(true);
    await act(async () => {
      root.render(<div />);
    });
    expect(sujo).toHaveBeenLastCalledWith(false);
  });
});
