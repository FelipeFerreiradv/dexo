// @vitest-environment jsdom
//
// Onda 5 da NF-e de devolução — grupo I3 (telas), MONTADAS de verdade: o
// `DevolucaoEditor` (passos 3 e 8) e o quadro "Devolução manual".
//
// O que só o teste montado prova (DLS AUTO PEÇAS, Simples Nacional, SC):
//  - decisão 2: no Simples a caixa de alíquota do PIS/COFINS aparece TRAVADA em
//    0, com a frase do porquê, e o PUT leva 0 — a SEFAZ autorizaria o valor
//    destacado, e isso só se desfaz cancelando;
//  - K11: a peça tirada volta DEPOIS DE RECARREGAR (`itensForaDaDevolucao`);
//  - a recusa do salvar aparece no cartão da PEÇA certa (chave + nº do item);
//  - "esta peça também está no rascunho X / na devolução nº Y";
//  - G4 #6: todo passo do editor tem o botão que começa com "Salvar" (o que o
//    "Salvar e seguir" do wizard aperta) e avisa `onDirtyChange(false)` depois;
//  - o seletor de CNPJ da devolução manual, e a origem da mercadoria.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ navegacoes: [] as string[] }));
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));
vi.mock("../../../app/notas-fiscais/lib/nfe-navegacao", () => ({ navegarPara: (u: string) => h.navegacoes.push(u) }));

import { DevolucaoEditor } from "../../../app/notas-fiscais/components/devolucao-editor";
import { DevolucaoManual } from "../../../app/notas-fiscais/components/devolucao-manual";
import { DEVOLVER_TAMBEM, FORA_DA_DEVOLUCAO, TRAVADO_PRODUTOS } from "../../../app/notas-fiscais/lib/nfe-devolucao-editor-ui";
import { ALIQUOTA_TRAVADA_SIMPLES } from "../../../app/notas-fiscais/lib/nfe-devolucao-pis-cofins-campo";
import { QUANTIDADE_VAZIA } from "../../../app/notas-fiscais/lib/nfe-devolucao-quantidade-campo";
import { ESCOLHA_A_EMPRESA, ROTULO_EMPRESA } from "../../../app/notas-fiscais/lib/nfe-devolucao-disponibilidade-ui";
import { ROTULO_COMO_INFORMAR, ROTULO_ORIGEM } from "../../../app/notas-fiscais/lib/nfe-devolucao-manual-ui";
import { TITULO_DEVOLUCOES_EM_ANDAMENTO } from "../../../app/notas-fiscais/lib/nfe-devolucoes-abertas-ui";
import { calcularDvChaveAcesso } from "../../../app/fiscal/domain/chave-acesso-dv";
import { regimeEmitenteDevolucao } from "../../../app/fiscal/devolucao/tributacao";
import type { DevolucaoDetalhe, DevolucaoItemDetalhe } from "../../../app/fiscal/devolucao/contrato";
import type { TributacaoDevolucaoItem } from "../../../app/fiscal/devolucao/tipos";

const API = "http://api.test";
const EMAIL = "dona@dls.test";
const CHAVE = "42260980689839000975550010008528991757991829";

function trib(p: Partial<TributacaoDevolucaoItem> = {}): TributacaoDevolucaoItem {
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
    ...p,
  };
}

function item(nItem: number, ordem: number, extra: Partial<DevolucaoItemDetalhe> = {}): DevolucaoItemDetalhe {
  return {
    ordem,
    chaveAcesso: CHAVE,
    nItem,
    codigo: `P-${nItem}`,
    descricao: `PECA ${nItem}`,
    unidade: "UN",
    ncm: "87089990",
    quantidadeOriginal: 2,
    devolvidaAutorizada: 0,
    emProcessamento: 0,
    disponivel: 2,
    quantidade: 1,
    valorUnitario: 100,
    valor: 100,
    cfopOriginal: "5102",
    cfop: "5202",
    cfopStatus: "ESCOLHA",
    cfopOpcoes: ["5202"],
    tributacao: trib(),
    requerRevisao: true,
    ...extra,
  };
}

function detalhe(regime: string, itens: DevolucaoItemDetalhe[], extra: Partial<DevolucaoDetalhe> = {}): DevolucaoDetalhe {
  return {
    draftId: "draft-dls",
    status: "DRAFT",
    tipo: "COMPRA_SAIDA",
    fonte: "XML_IMPORTADO",
    escopo: "PARCIAL",
    devolvidaAposEntrega: true,
    confirmadoSemXml: false,
    indFinal: "0",
    modoReferencia: "ITEM",
    emitente: regimeEmitenteDevolucao(regime, "COMPRA_SAIDA"),
    originais: [{ chaveAcesso: CHAVE, originalNfeId: null, modelo: "55", numero: 852899, serie: 1, dataEmissao: "2026-09-10", destinatarioNome: null }],
    itens,
    issues: [],
    podeEmitir: false,
    ...extra,
  };
}

let container: HTMLDivElement;
let root: Root;
const texto = () => container.textContent ?? "";
const linha = (nItem: number) => container.querySelector(`[data-linha="${CHAVE}#${nItem}"]`) as HTMLElement;
const botoes = (rotulo: string, dentro: ParentNode = container) =>
  Array.from(dentro.querySelectorAll("button")).filter((b) => (b.textContent ?? "").trim() === rotulo) as HTMLButtonElement[];
const salvar = () => botoes("Salvar devolução")[0];
const corpoDe = (f: { mock: { calls: unknown[][] } }, n = 0) => JSON.parse(String((f.mock.calls[n] as unknown as [string, RequestInit])[1].body));
const quantidadeDe = (nItem: number) => linha(nItem).querySelector('input[aria-label="Quantidade"]') as HTMLInputElement | null;
const sel = (nItem: number, rotulo: string) => linha(nItem).querySelector(`select[aria-label="${rotulo}"]`) as HTMLSelectElement;
const inp = (nItem: number, rotulo: string) => linha(nItem).querySelector(`input[aria-label="${rotulo}"]`) as HTMLInputElement | null;

async function assentar(vezes = 2) {
  for (let i = 0; i < vezes; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function clicar(el: Element | undefined) {
  if (!el) throw new Error(`elemento ausente. Texto: ${texto()}`);
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await assentar();
}
async function digitar(el: HTMLInputElement | HTMLSelectElement | null | undefined, valor: string) {
  if (!el) throw new Error(`campo ausente. Texto: ${texto()}`);
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, valor);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  await assentar();
}

/** O pai de mentira que imita o wizard: grava o detalhe salvo e só depois espera (o `loadDraft`). */
function Pai({ inicial, passo, onDirty }: { inicial: DevolucaoDetalhe; passo: number; onDirty?: (s: boolean) => void }) {
  const [v, setV] = React.useState(inicial);
  return <DevolucaoEditor value={v} email={EMAIL} step={passo} onDirtyChange={onDirty} onSaved={async (d) => { setV(d); await new Promise((r) => setTimeout(r, 0)); }} />;
}
async function montarEditor(inicial: DevolucaoDetalhe, passo: number, onDirty?: (s: boolean) => void) {
  await act(async () => { root.render(<Pai inicial={inicial} passo={passo} onDirty={onDirty} />); });
  await assentar();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.navegacoes = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// ─────────────────────────── decisão 2: alíquota travada ───────────────────────────

describe("decisão 2 na tela — no Simples a alíquota do PIS/COFINS aparece TRAVADA em 0", () => {
  it("escolhido o 99: caixa só de leitura em 0, com a frase do porquê; o PUT leva 0", async () => {
    const v = detalhe("SIMPLES", [item(5, 1)]);
    const f = vi.fn(async () => ({ ok: true, json: async () => v }));
    vi.stubGlobal("fetch", f);
    await montarEditor(v, 8);
    await digitar(sel(5, "Código do PIS (CST)"), "99");
    const caixa = inp(5, "Alíquota do PIS (%)")!;
    expect(caixa.value).toBe("0");
    expect(caixa.readOnly).toBe(true);
    expect(linha(5).textContent).toContain(ALIQUOTA_TRAVADA_SIMPLES);
    // Digitar não muda nada: a caixa não tem como sair do 0.
    await digitar(caixa, "1.65");
    expect(inp(5, "Alíquota do PIS (%)")!.value).toBe("0");
    await clicar(salvar());
    expect(corpoDe(f).itens[0].tributacao).toEqual({ pis: { cst: "99", p: 0 } });
  });

  it("COFINS gravada a 1,64%: a caixa mostra 0, diz o que estava gravado, marca edição pendente e o PUT corrige", async () => {
    const v = detalhe("SIMPLES", [item(5, 1, { tributacao: trib({ cofins: { cst: "49", vBC: 123.56, p: 1.64, v: 2.03 } }) })]);
    const f = vi.fn(async () => ({ ok: true, json: async () => detalhe("SIMPLES", [item(5, 1)]) }));
    vi.stubGlobal("fetch", f);
    const sujo = vi.fn();
    await montarEditor(v, 8, sujo);
    expect(inp(5, "Alíquota da COFINS (%)")!.value).toBe("0");
    expect(linha(5).textContent).toContain("Estava gravada a alíquota de 1,64% da COFINS");
    expect(sujo).toHaveBeenLastCalledWith(true);
    await clicar(salvar());
    expect(corpoDe(f).itens[0].tributacao).toEqual({ cofins: { cst: "49", p: 0 } });
    expect(sujo).toHaveBeenLastCalledWith(false);
  });

  it("regime normal: a caixa continua livre", async () => {
    await montarEditor(detalhe("LUCRO_REAL", [item(5, 1, { tributacao: trib({
      icms: { tag: "ICMS40", cst: "40", csosn: null, orig: 0, modBC: null, vBC: 0, pICMS: 0, vICMS: 0 },
      pis: { cst: "01", vBC: 100, p: 1.65, v: 1.65 },
    }) })]), 8);
    const caixa = inp(5, "Alíquota do PIS (%)")!;
    expect(caixa.readOnly).toBe(false);
    expect(caixa.value).toBe("1.65");
    expect(linha(5).textContent).not.toContain(ALIQUOTA_TRAVADA_SIMPLES);
  });
});

// ─────────────────────────── K11 depois de recarregar ───────────────────────────

describe("K11 — a peça tirada VOLTA depois de recarregar a página", () => {
  it("a peça que o servidor lista fora da devolução aparece com 'Devolver esta peça também' e volta no PUT", async () => {
    const v = detalhe("SIMPLES", [item(1, 1)], { itensForaDaDevolucao: [item(2, 0, { quantidade: 1, disponivel: 1 })] });
    const f = vi.fn(async () => ({ ok: true, json: async () => detalhe("SIMPLES", [item(1, 1), item(2, 2)]) }));
    vi.stubGlobal("fetch", f);
    await montarEditor(v, 3);
    expect(linha(2).textContent).toContain(FORA_DA_DEVOLUCAO);
    // Fora da devolução não é "edição pendente": salvar agora não a traz.
    expect(quantidadeDe(2)).toBeNull();
    await clicar(botoes(DEVOLVER_TAMBEM, linha(2))[0]);
    expect(quantidadeDe(2)!.value).toBe("1");
    await clicar(salvar());
    const enviados = corpoDe(f).itens as Array<{ nItem: number; quantidade: number; confirmarTributacao: boolean }>;
    expect(enviados.map((i) => i.nItem)).toEqual([1, 2]);
    expect(enviados[1]).toMatchObject({ quantidade: 1, confirmarTributacao: false });
    expect(linha(2).textContent).toContain("Item 2 — P-2");
  });

  it("saldo desconhecido (pela chave, sem XML): volta com a caixa VAZIA pedindo a quantidade — nunca 0", async () => {
    const v = detalhe("SIMPLES", [item(1, 1)], { itensForaDaDevolucao: [item(2, 0, { quantidade: 0, disponivel: null })] });
    vi.stubGlobal("fetch", vi.fn());
    await montarEditor(v, 3);
    expect(linha(2).textContent).toContain("o Dexo não tem como conferir");
    await clicar(botoes(DEVOLVER_TAMBEM, linha(2))[0]);
    expect(quantidadeDe(2)!.value).toBe("");
    expect(linha(2).textContent).toContain(QUANTIDADE_VAZIA);
    expect(salvar().disabled).toBe(true);
    expect(texto()).toContain(TRAVADO_PRODUTOS);
  });
});

// ─────────────────────────── recusa na peça certa ───────────────────────────

describe("a recusa do salvar vai para o cartão da PEÇA (chave + nº do item), não da ordem", () => {
  it("409 SALDO_INSUFICIENTE com nItem/chave: a frase aparece na peça 2, mesmo com a ordem apontando a 1", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      json: async () => ({
        error: "Quantidade maior que o saldo disponível para devolução.",
        code: "SALDO_INSUFICIENTE",
        issues: [{ code: "SALDO_EXCEDIDO", severidade: "ERRO", ordem: 1, nItem: 2, chaveAcesso: CHAVE, mensagem: "Item 2: P-2 (item 2 da nota original): pedida 2, disponível 1." }],
      }),
    })));
    await montarEditor(detalhe("SIMPLES", [item(1, 1), item(2, 2)]), 3);
    await clicar(salvar());
    const recusado = (n: number) => linha(n).querySelector('[aria-label="Recusado pelo Dexo"]');
    expect(recusado(2)?.textContent).toContain("pedida 2, disponível 1");
    expect(recusado(1)).toBeNull();
  });
});

// ─────────────────────────── onde mais a peça está ───────────────────────────

describe("o cartão da peça diz onde mais ela está", () => {
  it("outro rascunho e uma devolução autorizada aparecem no passo 3, com o saldo da peça", async () => {
    await montarEditor(detalhe("SIMPLES", [item(1, 1, {
      devolvidaAutorizada: 1,
      emRascunho: 1,
      outrasDevolucoes: [
        { nfeId: "r1", status: "DRAFT", numero: null, serie: 1, quantidade: 1, criadaEm: null },
        { nfeId: "a1", status: "AUTHORIZED", numero: 715, serie: 1, quantidade: 1, criadaEm: null },
      ],
    })]), 3);
    const lista = linha(1).querySelector('[aria-label="Esta peça em outras devoluções"]')!;
    expect(lista.textContent).toContain("Também está em outro rascunho de devolução (1 UN)");
    expect(lista.textContent).toContain(`"${TITULO_DEVOLUCOES_EM_ANDAMENTO}"`);
    expect(lista.textContent).toContain("Já foi devolvida na NF-e de devolução nº 715 (série 1), autorizada: 1 UN.");
    expect(linha(1).textContent).toContain("Na nota original: 2 UN · já devolvida: 1 · em outro rascunho: 1");
  });

  it("sem outras devoluções, nada a mais", async () => {
    await montarEditor(detalhe("SIMPLES", [item(1, 1)]), 3);
    expect(linha(1).querySelector('[aria-label="Esta peça em outras devoluções"]')).toBeNull();
  });
});

describe("o topo do quadro, sem jargão", () => {
  it("diz para onde a peça vai, que o estoque não mexe e de quem é a nota original", async () => {
    await montarEditor(detalhe("SIMPLES", [item(1, 1)]), 3);
    expect(texto()).toContain("Devolução de compra — a peça volta para o fornecedor");
    expect(texto()).toContain("Nota do fornecedor: NF-e nº 852899, série 1");
    expect(texto()).not.toContain("exclusivamente fiscal");
  });
});

// ─────────────────────────── G4 #6: o botão que o wizard aperta ───────────────────────────

describe("G4 #6 — o contrato com o 'Salvar e seguir' do wizard", () => {
  for (const passo of [1, 3, 8]) {
    it(`passo ${passo}: há um botão cujo texto começa com "Salvar" (o que o wizard aperta)`, async () => {
      await montarEditor(detalhe("SIMPLES", [item(1, 1)]), passo);
      const achado = Array.from(container.querySelectorAll("button")).filter((b) => /^\s*salvar/i.test(b.textContent ?? ""));
      expect(achado.map((b) => b.textContent)).toEqual(["Salvar devolução"]);
    });
  }

  it("depois do save aceito, o editor avisa onDirtyChange(false) — o wizard não limpa sozinho", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const corpo = JSON.parse(String(init.body)) as { itens: Array<{ nItem: number; quantidade: number }> };
      return { ok: true, json: async () => detalhe("SIMPLES", corpo.itens.map((b, k) => item(b.nItem, k + 1, { quantidade: b.quantidade }))) };
    }));
    const sujo = vi.fn();
    await montarEditor(detalhe("SIMPLES", [item(1, 1)]), 3, sujo);
    await digitar(quantidadeDe(1), "2");
    expect(sujo).toHaveBeenLastCalledWith(true);
    await clicar(salvar());
    expect(sujo.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });
});

// ─────────────────────────── devolução manual: CNPJ e origem ───────────────────────────

describe("devolução manual — seletor de empresa (mais de um CNPJ) e a origem da mercadoria", () => {
  type Resp = { status: number; body?: unknown };
  let chamadas: Array<{ metodo: string; url: string; corpo: any }>;
  let rotas: Record<string, Resp[]>;
  const EMPRESA = (id: string, cnpj: string, nome: string, isDefault = false) => ({
    companyFiscalConfigId: id, cnpj, razaoSocial: nome, nomeFantasia: null, uf: "SC", ambiente: "PRODUCAO", isDefault,
  });
  const DUAS = { disponivel: true, companyFiscalConfigId: null, empresas: [EMPRESA("cfg-a", "57502966000144", "DLS AUTO PECAS"), EMPRESA("cfg-b", "11222333000181", "DLS FILIAL")] };
  const campo = (rotulo: string) =>
    Array.from(container.querySelectorAll("label")).find((l) => (l.textContent ?? "").trim().startsWith(rotulo))?.querySelector("input,select") as
      | HTMLInputElement
      | HTMLSelectElement
      | undefined;
  const posts = (caminho: string) => chamadas.filter((c) => c.metodo === "POST" && c.url === caminho);

  beforeEach(() => {
    chamadas = [];
    rotas = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const metodo = init?.method ?? "GET";
      const caminho = url.replace(API, "");
      chamadas.push({ metodo, url: caminho, corpo: init?.body ? JSON.parse(String(init.body)) : undefined });
      const fila = rotas[`${metodo} ${caminho}`];
      const r = fila && (fila.length > 1 ? fila.shift() : fila[0]);
      if (!r) throw new Error(`chamada inesperada: ${metodo} ${caminho}`);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} };
    }));
  });

  async function montarManual(url = "/notas-fiscais/emitidas") {
    window.history.replaceState({}, "", url);
    await act(async () => { root.render(<DevolucaoManual email={EMAIL} />); });
    await assentar(6);
  }

  it("duas empresas ligadas e nenhuma padrão entre elas: ela ESCOLHE; a prévia e a criação vão com a escolhida", async () => {
    rotas["GET /fiscal/nfe/devolucao/disponibilidade"] = [{ status: 200, body: DUAS }];
    rotas["POST /fiscal/nfe/devolucao/manual/previa"] = [{ status: 200, body: { chaveAcesso: CHAVE, numero: 852899, serie: 1, emitenteCnpjCpf: "80689839000975", destinatarioNome: "DISAUTO", rascunhoAberto: null, itens: [] } }];
    await montarManual();
    await clicar(botoes("Devolução manual")[0]);
    const empresa = campo(ROTULO_EMPRESA) as HTMLSelectElement;
    expect(empresa.value).toBe("");
    expect(Array.from(empresa.options).map((o) => o.textContent)).toEqual([
      ESCOLHA_A_EMPRESA,
      "DLS AUTO PECAS — CNPJ 57.502.966/0001-44 (SC)",
      "DLS FILIAL — CNPJ 11.222.333/0001-81 (SC)",
    ]);
    // Sem empresa escolhida, nada de arquivo nem de criar.
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(botoes("Criar rascunho de devolução")).toHaveLength(0);
    await digitar(empresa, "cfg-b");
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [{ name: "nota.xml", size: 100, text: async () => "<nfeProc/>" }] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await assentar(6);
    expect(posts("/fiscal/nfe/devolucao/manual/previa")[0].corpo.companyFiscalConfigId).toBe("cfg-b");
  });

  it("uma empresa só (servidor novo): sem seletor, como antes", async () => {
    rotas["GET /fiscal/nfe/devolucao/disponibilidade"] = [{ status: 200, body: { disponivel: true, companyFiscalConfigId: "cfg-a", empresas: [EMPRESA("cfg-a", "57502966000144", "DLS", true)] } }];
    await montarManual();
    await clicar(botoes("Devolução manual")[0]);
    expect(campo(ROTULO_EMPRESA)).toBeUndefined();
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
  });

  it("devolução desligada (404): o quadro não aparece", async () => {
    rotas["GET /fiscal/nfe/devolucao/disponibilidade"] = [{ status: 404, body: { error: "Recurso indisponível" } }];
    await montarManual();
    expect(container.innerHTML).toBe("");
  });

  it("'Devolver pela chave' com dois CNPJs: abre com a empresa DA VENDA e a origem da própria nota", async () => {
    const base = `422609${"57502966000144"}55001000000711112345678`;
    const chaveVenda = base + calcularDvChaveAcesso(base);
    rotas["GET /fiscal/nfe/devolucao/disponibilidade"] = [{ status: 200, body: DUAS }];
    rotas["GET /fiscal/nfe/v711"] = [{ status: 200, body: { nfe: { id: "v711", companyFiscalConfigId: "cfg-b", chaveAcesso: chaveVenda, destinatarioJson: { nome: "Cliente", cpfCnpj: "52998224725", uf: "AP" }, itens: [{ numero: 1, codigo: "P1", descricao: "Farol", ncm: "87081000", unidade: "UN", cfop: "6102", valorUnitario: 12000, quantidade: 1, origem: 2 }] } } }];
    rotas["POST /fiscal/nfe/devolucao/manual"] = [{ status: 201, body: { draftId: "novo", reutilizado: false } }];
    await montarManual("/notas-fiscais/emitidas?devolverPelaChave=v711");
    expect((campo(ROTULO_EMPRESA) as HTMLSelectElement).value).toBe("cfg-b");
    expect((campo(ROTULO_COMO_INFORMAR) as HTMLSelectElement).value).toBe("CHAVE");
    expect((campo(ROTULO_ORIGEM) as HTMLSelectElement).value).toBe("2");
    await clicar(Array.from(container.querySelectorAll('input[type="checkbox"]')).at(-1));
    await clicar(botoes("Criar rascunho de devolução")[0]);
    const corpo = posts("/fiscal/nfe/devolucao/manual")[0].corpo;
    expect(corpo.companyFiscalConfigId).toBe("cfg-b");
    expect(corpo.itens[0].origem).toBe(2);
  });

  it("pela chave, a origem nasce SEM escolha; escolhida, vai no corpo", async () => {
    rotas["GET /fiscal/nfe/devolucao/disponibilidade"] = [{ status: 200, body: { disponivel: true, companyFiscalConfigId: "cfg-a" } }];
    await montarManual();
    await clicar(botoes("Devolução manual")[0]);
    await digitar(campo(ROTULO_COMO_INFORMAR), "CHAVE");
    expect((campo(ROTULO_ORIGEM) as HTMLSelectElement).value).toBe("");
    await digitar(campo(ROTULO_ORIGEM), "1");
    expect((campo(ROTULO_ORIGEM) as HTMLSelectElement).value).toBe("1");
  });
});
