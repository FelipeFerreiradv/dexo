// @vitest-environment jsdom
//
// A devolução na LISTA de Notas Emitidas e na FICHA da nota, montadas de verdade:
//  - "Devoluções em andamento": os 7 rascunhos que a DLS não achava em lugar
//    nenhum (a lista esconde rascunho), com Continuar e Descartar — e o descarte
//    do nº 712 explicado antes;
//  - "Devolver" que reabre a devolução existente AVISA (antes caía calada nela);
//  - venda sem XML guardado: "Devolver pela chave", no lugar do botão que só
//    respondia "use a devolução manual";
//  - a ficha da venda mostra as devoluções dela e some com o "Devolver" quando
//    não há mais nada a devolver; a ficha da devolução diz de qual nota ela é.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ navegacoes: [] as string[] }));
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));
vi.mock("../../../app/notas-fiscais/lib/nfe-navegacao", () => ({ navegarPara: (u: string) => h.navegacoes.push(u) }));

import { DevolucaoActions, ROTULO_DEVOLVER_PELA_CHAVE } from "../../../app/notas-fiscais/components/devolucao-actions";
import { DevolucoesEmAndamento } from "../../../app/notas-fiscais/components/devolucoes-em-andamento";
import { DevolucaoVinculo } from "../../../app/notas-fiscais/components/devolucao-vinculo";
import { AVISO_FEITA_A_MAO, TITULO_DEVOLUCOES_EM_ANDAMENTO } from "../../../app/notas-fiscais/lib/nfe-devolucoes-abertas-ui";
import { AVISO_TODA_DEVOLVIDA } from "../../../app/notas-fiscais/lib/nfe-devolucao-vinculo-ui";

const API = "http://api.test";
const EMAIL = "dona@dls.test";
type Resp = { status: number; body?: unknown };

let container: HTMLDivElement;
let root: Root;
let chamadas: Array<{ metodo: string; url: string; corpo: any }>;
let rotas: Record<string, Resp[]>;

const texto = () => container.textContent ?? "";
const botao = (rotulo: string, dentro: ParentNode = container) =>
  Array.from(dentro.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === rotulo) as HTMLButtonElement | undefined;
async function assentar(vezes = 4) {
  for (let i = 0; i < vezes; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function clicar(el: HTMLElement | undefined) {
  if (!el) throw new Error(`elemento ausente. Texto: ${texto()}`);
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await assentar();
}
async function montar(no: React.ReactElement) {
  await act(async () => { root.render(no); });
  await assentar(6);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  chamadas = [];
  rotas = {};
  h.navegacoes = [];
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
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const VENDA = { id: "v1", status: "AUTHORIZED", finalidade: "NORMAL", tipoOperacao: "SAIDA" };

describe("botões de devolução da venda", () => {
  it("'Devolver' que reabriu a devolução existente leva ao assistente COM o aviso", async () => {
    rotas["POST /fiscal/nfe/v1/devolucao"] = [{ status: 200, body: { draftId: "d93", reutilizado: true, escopo: "TOTAL" } }];
    await montar(<DevolucaoActions nota={{ ...VENDA, devolucaoDisponivel: true }} email={EMAIL} />);
    await clicar(botao("Devolver parcial"));
    expect(chamadas[0].corpo).toEqual({ escopo: "PARCIAL" });
    expect(h.navegacoes).toEqual(["/notas-fiscais/nfe?draft=d93&reaproveitada=1"]);
  });

  it("devolução nova: sem o aviso", async () => {
    rotas["POST /fiscal/nfe/v1/devolucao"] = [{ status: 201, body: { draftId: "novo", reutilizado: false } }];
    await montar(<DevolucaoActions nota={{ ...VENDA, devolucaoDisponivel: true }} email={EMAIL} />);
    await clicar(botao("Devolver total"));
    expect(h.navegacoes).toEqual(["/notas-fiscais/nfe?draft=novo"]);
  });

  it("recusa do servidor vira mensagem (e não uma linha vazia)", async () => {
    rotas["POST /fiscal/nfe/v1/devolucao"] = [{ status: 409, body: { error: "Todos os itens desta nota já foram devolvidos.", code: "TOTALMENTE_DEVOLVIDA" } }];
    await montar(<DevolucaoActions nota={{ ...VENDA, devolucaoDisponivel: true }} email={EMAIL} />);
    await clicar(botao("Devolver total"));
    expect(texto()).toContain("Todos os itens desta nota já foram devolvidos.");
  });

  it("venda sem XML no Dexo: 'Devolver pela chave' leva ao quadro manual preenchido", async () => {
    await montar(<DevolucaoActions nota={{ ...VENDA, devolucaoPelaChave: true }} email={EMAIL} />);
    expect(botao("Devolver total")).toBeUndefined();
    await clicar(botao(ROTULO_DEVOLVER_PELA_CHAVE));
    expect(h.navegacoes).toEqual(["/notas-fiscais/emitidas?devolverPelaChave=v1"]);
  });

  it("nada a devolver (saldo da ficha) ⇒ os botões somem; nota que não é venda ⇒ nada", async () => {
    await montar(<DevolucaoActions nota={{ ...VENDA, devolucaoDisponivel: true }} email={EMAIL} elegivel={false} />);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    await montar(<DevolucaoActions nota={{ ...VENDA, finalidade: "DEVOLUCAO", devolucaoDisponivel: true, devolucaoPelaChave: true }} email={EMAIL} />);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});

function aberta(p: Record<string, unknown>) {
  return {
    draftId: "d", status: "DRAFT", gerenciada: true, tipo: "COMPRA_SAIDA", fonte: "XML_IMPORTADO", tipoOperacao: "SAIDA",
    destinatarioNome: "DISAUTO DISTRIBUIDORA", originais: [{ chaveAcesso: "4".repeat(44), numero: 991757, serie: 1 }],
    quantidadeItens: 2, criadaEm: "2026-09-24T20:03:00.000Z", atualizadaEm: "2026-09-24T20:47:00.000Z", numeracao: null, ...p,
  };
}

describe("Devoluções em andamento", () => {
  // ATUALIZADO (onda 5, revisão de regressão): o quadro agora pergunta ANTES se a
  // devolução está ligada (GET /disponibilidade) e só então chama /abertas — antes
  // era um 404 e uma consulta ao banco em toda carga da lista, de todo cliente.
  // Os casos abaixo são de empresa COM a devolução ligada (esta rota é só o
  // "sim"); o caso desligada tem teste próprio, no fim deste bloco.
  beforeEach(() => {
    rotas["GET /fiscal/nfe/devolucao/disponibilidade"] = [{ status: 200, body: { disponivel: true, companyFiscalConfigId: "cfg-dls", empresas: [] } }];
  });

  it("empresa sem a devolução ligada (404) ⇒ o quadro nem aparece", async () => {
    rotas["GET /fiscal/nfe/devolucao/abertas"] = [{ status: 404, body: { error: "Recurso indisponível" } }];
    await montar(<DevolucoesEmAndamento email={EMAIL} />);
    expect(container.innerHTML).toBe("");
  });

  it("lista, continua e avisa da feita à mão (só descartar)", async () => {
    rotas["GET /fiscal/nfe/devolucao/abertas"] = [{ status: 200, body: { abertas: [
      aberta({ draftId: "8d269885" }),
      aberta({ draftId: "cmubl7is", gerenciada: false, tipo: null, fonte: null, originais: [], quantidadeItens: 3, numeracao: { numero: 712, serie: 1, estado: "REJEITADO", ambiente: "PRODUCAO" } }),
    ] } }];
    await montar(<DevolucoesEmAndamento email={EMAIL} />);
    expect(texto()).toContain(`${TITULO_DEVOLUCOES_EM_ANDAMENTO} (2)`);
    const boa = container.querySelector('[data-draft="8d269885"]')!;
    const mao = container.querySelector('[data-draft="cmubl7is"]')!;
    expect(boa.textContent).toContain("Devolução de compra (ao fornecedor) — Para DISAUTO DISTRIBUIDORA");
    expect(mao.textContent).toContain(AVISO_FEITA_A_MAO);
    expect(mao.textContent).toContain("Segura o nº 712 (série 1).");
    expect(botao("Continuar", mao)).toBeUndefined();
    await clicar(botao("Continuar", boa));
    expect(h.navegacoes).toEqual(["/notas-fiscais/nfe?draft=8d269885"]);
  });

  it("descartar o que segura o nº 712: explica, pede confirmação, descarta e recarrega", async () => {
    rotas["GET /fiscal/nfe/devolucao/abertas"] = [
      { status: 200, body: { abertas: [aberta({ draftId: "cmubl7is", gerenciada: false, numeracao: { numero: 712, serie: 1, estado: "REJEITADO", ambiente: "PRODUCAO" } })] } },
      { status: 200, body: { abertas: [] } },
    ];
    rotas["DELETE /fiscal/nfe/draft/cmubl7is"] = [{ status: 409, body: { code: "NUMERACAO_CONFIRMAR_DESCARTE", error: "O nº 712 (série 1) ficará sem uso e precisará ser inutilizado" } }];
    rotas["DELETE /fiscal/nfe/draft/cmubl7is?descartarNumero=true"] = [{ status: 204 }];
    await montar(<DevolucoesEmAndamento email={EMAIL} />);
    await clicar(botao("Descartar"));
    const dialogo = container.querySelector('[role="alertdialog"]')!;
    expect(dialogo.textContent).toContain("O nº 712 (série 1) ficará sem uso e precisará ser inutilizado.");
    expect(dialogo.textContent).toContain("até o dia 10 do mês seguinte");
    // Cancelar não descarta nada.
    await clicar(botao("Cancelar"));
    expect(chamadas.filter((c) => c.url.includes("descartarNumero"))).toHaveLength(0);
    await clicar(botao("Descartar"));
    await clicar(botao("Descartar e soltar o número"));
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toContain("DELETE /fiscal/nfe/draft/cmubl7is?descartarNumero=true");
    expect(container.innerHTML).toBe("");
  });

  it("erro no descarte aparece na linha", async () => {
    rotas["GET /fiscal/nfe/devolucao/abertas"] = [{ status: 200, body: { abertas: [aberta({ draftId: "x" })] } }];
    rotas["DELETE /fiscal/nfe/draft/x"] = [{ status: 409, body: { code: "NFE_NUMERO_PENDENTE_CONSULTA", error: "Consulte a situação antes de excluir o rascunho" } }];
    await montar(<DevolucoesEmAndamento email={EMAIL} />);
    await clicar(botao("Descartar"));
    expect(texto()).toContain("Consulte a situação antes de excluir o rascunho");
  });

  it("devolução DESLIGADA (disponibilidade 404) ⇒ o GET /abertas nem sai, e o quadro não aparece", async () => {
    rotas["GET /fiscal/nfe/devolucao/disponibilidade"] = [{ status: 404, body: { error: "Recurso indisponível" } }];
    rotas["GET /fiscal/nfe/devolucao/abertas"] = [{ status: 200, body: { abertas: [aberta({ draftId: "nao-deveria" })] } }];
    await montar(<DevolucoesEmAndamento email={EMAIL} />);
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual(["GET /fiscal/nfe/devolucao/disponibilidade"]);
    expect(container.innerHTML).toBe("");
  });

  it("rede caída na pergunta ⇒ não afirma que está ligada: nada de /abertas", async () => {
    rotas["GET /fiscal/nfe/devolucao/disponibilidade"] = [];
    rotas["GET /fiscal/nfe/devolucao/abertas"] = [{ status: 200, body: { abertas: [aberta({ draftId: "nao-deveria" })] } }];
    await montar(<DevolucoesEmAndamento email={EMAIL} />);
    expect(chamadas.filter((c) => c.url === "/fiscal/nfe/devolucao/abertas")).toHaveLength(0);
    expect(container.innerHTML).toBe("");
  });

  it("recarregar depois de descartar não pergunta de novo se está ligada", async () => {
    rotas["GET /fiscal/nfe/devolucao/abertas"] = [
      { status: 200, body: { abertas: [aberta({ draftId: "x" })] } },
      { status: 200, body: { abertas: [] } },
    ];
    rotas["DELETE /fiscal/nfe/draft/x"] = [{ status: 204 }];
    await montar(<DevolucoesEmAndamento email={EMAIL} />);
    await clicar(botao("Descartar"));
    const urls = chamadas.map((c) => `${c.metodo} ${c.url}`);
    expect(urls.filter((u) => u === "GET /fiscal/nfe/devolucao/disponibilidade")).toHaveLength(1);
    expect(urls.filter((u) => u === "GET /fiscal/nfe/devolucao/abertas")).toHaveLength(2);
    expect(container.innerHTML).toBe("");
  });
});

describe("ficha da nota — o vínculo com a devolução", () => {
  const SALDO = {
    original: { nfeId: "v1", chaveAcesso: "4".repeat(44), numero: 700, serie: 1, modelo: "55", status: "AUTHORIZED", dataEmissao: null, destinatarioNome: null, destinatarioCpfCnpj: null },
    elegivel: false, motivo: "TOTALMENTE_DEVOLVIDA", totalmenteDevolvida: true,
    devolucoes: [{ nfeId: "dv", numero: 713, serie: 1, status: "AUTHORIZED", itens: [{ nItem: 1, quantidade: 1 }] }],
    itens: [{ nItem: 1, quantidadeOriginal: 1, devolvidaAutorizada: 1, emProcessamento: 0, emRascunho: 0, disponivel: 0, codigo: "A", descricao: "Farol", unidade: "UN", valorUnitario: 10 }],
  };

  it("venda: mostra as devoluções e avisa o pai que não há mais o que devolver", async () => {
    rotas["GET /fiscal/nfe/v1/devolucao/saldo"] = [{ status: 200, body: SALDO }];
    const elegivel = vi.fn();
    await montar(<DevolucaoVinculo nota={{ ...VENDA, devolucaoDisponivel: true }} email={EMAIL} onElegivel={elegivel} />);
    expect(texto()).toContain("Devoluções desta nota");
    expect(texto()).toContain("NF-e 713 (série 1) — autorizada — item 1 (1)");
    expect(texto()).toContain(AVISO_TODA_DEVOLVIDA);
    expect(elegivel).toHaveBeenCalledWith(false);
  });

  it("devolução: diz de qual nota ela é", async () => {
    rotas["GET /fiscal/nfe/draft/dv/devolucao"] = [{ status: 200, body: { tipo: "VENDA_ENTRADA", originais: [{ chaveAcesso: "4".repeat(44), originalNfeId: "v1", modelo: "55", numero: 700, serie: 1, dataEmissao: null, destinatarioNome: null }] } }];
    await montar(<DevolucaoVinculo nota={{ id: "dv", status: "AUTHORIZED", finalidade: "DEVOLUCAO", tipoOperacao: "ENTRADA", numeracao: null }} email={EMAIL} />);
    expect(texto()).toContain("Devolução da NF-e 700 (série 1) — sua nota de venda");
  });

  it("nota sem a devolução nova (sem `numeracao`, sem `devolucaoDisponivel`) ⇒ nem pergunta ao servidor", async () => {
    await montar(<DevolucaoVinculo nota={{ id: "dv", status: "AUTHORIZED", finalidade: "DEVOLUCAO", tipoOperacao: "ENTRADA" }} email={EMAIL} />);
    await montar(<DevolucaoVinculo nota={{ ...VENDA }} email={EMAIL} />);
    expect(chamadas).toHaveLength(0);
    expect(container.innerHTML).toBe("");
  });
});
