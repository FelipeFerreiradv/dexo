// Os módulos PUROS das telas da devolução no wizard e na lista de Notas
// Emitidas (G4 da auditoria de 24/09/2026). Cada bloco diz o caso real que o
// motivou; a tela montada tem specs próprios (`*-tela.spec.tsx`).

import { describe, it, expect, vi } from "vitest";
import {
  PASSOS_COM_EDITOR_DEVOLUCAO,
  destinoAposAutorizar,
  guardaMensagem,
  lerEstadoDevolucaoDoRascunho,
  notaParaAbrir,
  precisaConfirmarSaida,
  quadroDevolucaoAMao,
  ultimoSalvo,
  urlRascunhoDevolucao,
  veioReaproveitada,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-wizard-ui";
import {
  AVISO_FEITA_A_MAO,
  descartarRascunho,
  lerAbertas,
  textoConfirmacaoDescarte,
  viewDevolucoesAbertas,
} from "../../../app/notas-fiscais/lib/nfe-devolucoes-abertas-ui";
import {
  CONFIRA_OS_CAMPOS,
  avisoCfop,
  conferirChaveDigitada,
  destinatarioPelaChave,
  errosDoItemXml,
  itensMarcados,
  lerErrosDaResposta,
  lerItensDigitados,
  lerNItemDigitado,
  lerNumeroDigitado,
  linhasDaNota,
  notaParaDevolverPelaChave,
  selecaoInicial,
  urlDevolverPelaChave,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-manual-ui";
import {
  rotuloEvento,
  seloDevolucao,
  textoOriginaisDaDevolucao,
  viewDevolucoesDaNota,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-vinculo-ui";
import { calcularDvChaveAcesso } from "../../../app/fiscal/domain/chave-acesso-dv";
import type { DevolucaoAbertaResumo } from "../../../app/usecases/nfe-devolucao.usecase";
import type { SaldoResposta } from "../../../app/fiscal/devolucao/contrato";

/** Chave de 44 dígitos com DV certo: cUF + AAMM + CNPJ + 55 + série + nNF + 1 + cNF. */
function chave(cUF: string, cnpj14: string, numero = 1234, serie = 1): string {
  const base = `${cUF}2609${cnpj14}55${String(serie).padStart(3, "0")}${String(numero).padStart(9, "0")}1${"12345678"}`;
  return base + calcularDvChaveAcesso(base);
}
/** CNPJ válido de fornecedor (DISAUTO de mentira), em SC. */
const CNPJ_FORNECEDOR = "11222333000181";
const CHAVE_SC = chave("42", CNPJ_FORNECEDOR);

// ─────────────────────────────── wizard ───────────────────────────────

describe("guarda de navegação — só na devolução e só com edição não salva", () => {
  it("devolução com edição pendente num passo do editor ⇒ pergunta", () => {
    for (const passo of PASSOS_COM_EDITOR_DEVOLUCAO) {
      expect(precisaConfirmarSaida({ devolucao: true, editorSujo: true, passoAtual: passo, destino: passo + 1 })).toBe(true);
    }
  });
  it("NF-e comum NUNCA pergunta, mesmo com o sinal de sujo ligado", () => {
    expect(precisaConfirmarSaida({ devolucao: false, editorSujo: true, passoAtual: 3, destino: 4 })).toBe(false);
  });
  it("sem edição pendente, ou fora dos passos do editor, segue direto", () => {
    expect(precisaConfirmarSaida({ devolucao: true, editorSujo: false, passoAtual: 3, destino: 4 })).toBe(false);
    expect(precisaConfirmarSaida({ devolucao: true, editorSujo: true, passoAtual: 2, destino: 3 })).toBe(false);
    expect(precisaConfirmarSaida({ devolucao: true, editorSujo: true, passoAtual: 3, destino: 3 })).toBe(false);
  });
  it("a frase diz para onde ela ia e o que se perde", () => {
    const m = guardaMensagem(4, "Frete");
    expect(m).toContain("passo 4 (Frete)");
    expect(m).toContain("se perde");
  });
  it("o selo 'Salvo' é o mais recente dos dois saves", () => {
    const a = new Date("2026-09-24T17:00:00Z");
    const b = new Date("2026-09-24T18:00:00Z");
    expect(ultimoSalvo(a, b)).toBe(b);
    expect(ultimoSalvo(b, a)).toBe(b);
    expect(ultimoSalvo(null, a)).toBe(a);
    expect(ultimoSalvo(a, null)).toBe(a);
    expect(ultimoSalvo(null, null)).toBeNull();
  });
});

describe("rascunho de devolução feito à mão — o 404 deixa de ser engolido", () => {
  it("404 DEVOLUCAO_NAO_GERENCIADA ⇒ não gerenciada; 404 SEM código ⇒ desligada (muda nada)", () => {
    expect(lerEstadoDevolucaoDoRascunho(404, { error: "x", code: "DEVOLUCAO_NAO_GERENCIADA" })).toBe("NAO_GERENCIADA");
    expect(lerEstadoDevolucaoDoRascunho(404, { error: "Recurso indisponível" })).toBe("DESLIGADA");
    expect(lerEstadoDevolucaoDoRascunho(422, { code: "EXIGE_NUMERACAO_V2" })).toBe("EXIGE_NUMERACAO_V2");
    expect(lerEstadoDevolucaoDoRascunho(200, {})).toBe("GERENCIADA");
    expect(lerEstadoDevolucaoDoRascunho(500, null)).toBe("DESCONHECIDO");
  });
  it("o quadro do rascunho aberto oferece descarte; o de quem só escolheu, não", () => {
    const aberto = quadroDevolucaoAMao("ABERTO");
    expect(aberto.descartar).toBe("Descartar este rascunho");
    expect(aberto.caminhos.some((c) => c.includes("Devolução manual"))).toBe(true);
    expect(aberto.caminhos.some((c) => c.includes("Devolver total"))).toBe(true);
    const escolhendo = quadroDevolucaoAMao("ESCOLHENDO");
    expect(escolhendo.descartar).toBe("");
    expect(escolhendo.aproveitar).toContain('"Normal"');
  });
  it("o texto é neutro no tempo (o do passo 8 dizia 'antes de o Dexo montar devolução')", () => {
    for (const m of ["ABERTO", "ESCOLHENDO"] as const) {
      const q = quadroDevolucaoAMao(m);
      expect(`${q.titulo} ${q.mensagem}`).not.toMatch(/antes de o Dexo/i);
    }
  });
});

describe("depois de autorizar e rascunho reaproveitado", () => {
  it("vai para a nota autorizada na lista, e não para 'Emitir NF-e'", () => {
    expect(destinoAposAutorizar("cm 1")).toBe("/notas-fiscais/emitidas?nfe=cm%201");
    expect(destinoAposAutorizar(null)).toBe("/notas-fiscais/emitidas");
    expect(notaParaAbrir("?nfe=abc")).toBe("abc");
    expect(notaParaAbrir("?x=1")).toBeNull();
  });
  it("a URL do rascunho leva o aviso só quando foi reaproveitado", () => {
    expect(urlRascunhoDevolucao("d1", false)).toBe("/notas-fiscais/nfe?draft=d1");
    expect(urlRascunhoDevolucao("d1", true)).toBe("/notas-fiscais/nfe?draft=d1&reaproveitada=1");
    expect(veioReaproveitada("?draft=d1&reaproveitada=1")).toBe(true);
    expect(veioReaproveitada("?draft=d1")).toBe(false);
  });
});

// ─────────────────────────────── devoluções em andamento ───────────────────────────────

function aberta(p: Partial<DevolucaoAbertaResumo>): DevolucaoAbertaResumo {
  return {
    draftId: "d",
    status: "DRAFT",
    gerenciada: true,
    tipo: "COMPRA_SAIDA",
    fonte: "XML_IMPORTADO",
    tipoOperacao: "SAIDA",
    destinatarioNome: "DISAUTO DISTRIBUIDORA",
    originais: [{ chaveAcesso: CHAVE_SC, numero: 991757, serie: 1 }],
    quantidadeItens: 2,
    criadaEm: "2026-09-24T20:03:00.000Z",
    atualizadaEm: "2026-09-24T20:47:00.000Z",
    numeracao: null,
    ...p,
  };
}

describe("Devoluções em andamento — os 7 rascunhos invisíveis da DLS", () => {
  const linhas = viewDevolucoesAbertas([
    aberta({ draftId: "a", atualizadaEm: "2026-09-24T20:10:00.000Z" }),
    aberta({ draftId: "b", atualizadaEm: "2026-09-24T21:10:00.000Z" }),
    aberta({ draftId: "mao", gerenciada: false, tipo: null, fonte: null, originais: [], quantidadeItens: 3,
      numeracao: { numero: 712, serie: 1, estado: "REJEITADO", ambiente: "PRODUCAO" } }),
  ]);
  it("mais recente primeiro; título, destinatário, nota e peças", () => {
    expect(linhas.map((l) => l.draftId)[0]).toBe("b");
    const b = linhas.find((l) => l.draftId === "b")!;
    expect(b.titulo).toBe("Devolução de compra (ao fornecedor)");
    expect(b.para).toBe("Para DISAUTO DISTRIBUIDORA");
    expect(b.notas).toBe("NF-e 991757 (série 1)");
    expect(b.itens).toBe("2 peças");
    expect(b.quando).toContain("24/09");
    expect(b.continuarUrl).toBe("/notas-fiscais/nfe?draft=b");
  });
  it("duas da MESMA nota: cada uma avisa da outra", () => {
    expect(linhas.find((l) => l.draftId === "a")!.repetida).toContain("outra devolução");
    expect(linhas.find((l) => l.draftId === "b")!.repetida).toContain("outra devolução");
  });
  it("a feita à mão: só descartar, e o nº 712 preso com o prazo da inutilização", () => {
    const m = linhas.find((l) => l.draftId === "mao")!;
    expect(m.podeContinuar).toBe(false);
    expect(m.continuarUrl).toBeNull();
    expect(m.aviso).toBe(AVISO_FEITA_A_MAO);
    expect(m.numero).toBe("Segura o nº 712 (série 1).");
    expect(m.avisoNumero).toContain("dia 10 do mês seguinte");
    expect(m.repetida).toBeNull();
  });
  it("em homologação não fala de inutilizar", () => {
    const [h] = viewDevolucoesAbertas([aberta({ numeracao: { numero: 5, serie: 1, estado: "RESERVADO", ambiente: "HOMOLOGACAO" } })]);
    expect(h.avisoNumero).toBeNull();
  });
  it("corpo estranho vira lista vazia", () => {
    expect(lerAbertas(null)).toEqual([]);
    expect(lerAbertas({ abertas: [{ x: 1 }, { draftId: "ok" }] })).toHaveLength(1);
  });
});

describe("descarte de rascunho — resultado distinguível (o hook antigo devolvia false para tudo)", () => {
  const resposta = (status: number, body?: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body ?? {} }) as Response;
  it("204 ⇒ ok", async () => {
    const f = vi.fn(async () => resposta(204));
    expect(await descartarRascunho({ base: "http://api", email: "e", draftId: "d 1", fetchImpl: f as never })).toEqual({ ok: true });
    expect(f).toHaveBeenCalledWith("http://api/fiscal/nfe/draft/d%201", { method: "DELETE", headers: { email: "e" } });
  });
  it("409 NUMERACAO_CONFIRMAR_DESCARTE ⇒ pede confirmação, com o número e o prazo", async () => {
    const f = vi.fn(async () => resposta(409, { code: "NUMERACAO_CONFIRMAR_DESCARTE", error: "O nº 712 (série 1) ficará sem uso e precisará ser inutilizado" }));
    const r = await descartarRascunho({ base: "http://api", email: "e", draftId: "d", fetchImpl: f as never });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.confirmar).toBe(true);
    expect(r.ok === false ? r.mensagem : "").toContain("nº 712");
    expect(r.ok === false ? r.mensagem : "").toContain("até o dia 10 do mês seguinte");
  });
  it("com a confirmação vai ?descartarNumero=true", async () => {
    const f = vi.fn(async (_url: string) => resposta(204));
    await descartarRascunho({ base: "http://api", email: "e", draftId: "d", descartarNumero: true, fetchImpl: f as never });
    expect(f.mock.calls[0][0]).toBe("http://api/fiscal/nfe/draft/d?descartarNumero=true");
  });
  it("outro erro ⇒ a frase do servidor; rede ⇒ frase própria", async () => {
    const f = vi.fn(async () => resposta(409, { code: "NFE_NUMERO_PENDENTE_CONSULTA", error: "Consulte a situação antes de excluir o rascunho" }));
    expect(await descartarRascunho({ base: "b", email: "e", draftId: "d", fetchImpl: f as never })).toEqual({ ok: false, confirmar: false, mensagem: "Consulte a situação antes de excluir o rascunho" });
    const g = vi.fn(async () => { throw new Error("offline"); });
    const r = await descartarRascunho({ base: "b", email: "e", draftId: "d", fetchImpl: g as never });
    expect(r.ok === false && !r.confirmar).toBe(true);
  });
  it("número retido para conferência: não fala de prazo de inutilização", () => {
    expect(textoConfirmacaoDescarte("O nº 9 (série 1) está retido para conferência: confirme")).not.toContain("dia 10");
  });
});

// ─────────────────────────────── devolução manual ───────────────────────────────

describe("números digitados no formato brasileiro (o campo dava NaN e engolia o ponto)", () => {
  const dinheiro = (t: string) => lerNumeroDigitado(t, { casas: 10, dinheiro: true });
  const qtd = (t: string) => lerNumeroDigitado(t, { casas: 4 });
  it("vírgula nos centavos, ponto de milhar", () => {
    expect(dinheiro("45,90")).toEqual({ ok: true, valor: 45.9 });
    expect(dinheiro("1.234,56")).toEqual({ ok: true, valor: 1234.56 });
    expect(dinheiro("R$ 12,50")).toEqual({ ok: true, valor: 12.5 });
    expect(dinheiro("12.50")).toEqual({ ok: true, valor: 12.5 });
    expect(dinheiro("1.234.567")).toEqual({ ok: true, valor: 1234567 });
    expect(dinheiro("664")).toEqual({ ok: true, valor: 664 });
  });
  it("'1.234' em dinheiro é ambíguo e é recusado com o jeito certo (nunca divide por mil calado)", () => {
    const r = dinheiro("1.234");
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.mensagem).toContain("ambíguo");
  });
  it("recusa lixo, vírgula dupla, milhar torto, zero", () => {
    for (const t of ["45,", "4,5,0", "1.23,4", "abc", "", "0", "0,00"]) expect(dinheiro(t).ok, t).toBe(false);
  });
  it("quantidade: até 4 casas, como o servidor", () => {
    expect(qtd("1,5")).toEqual({ ok: true, valor: 1.5 });
    expect(qtd("0,0001")).toEqual({ ok: true, valor: 0.0001 });
    expect(qtd("1,23456").ok).toBe(false);
  });
  it("item da nota original: inteiro de 1 a 990", () => {
    expect(lerNItemDigitado("3")).toEqual({ ok: true, valor: 3 });
    for (const t of ["", "0", "991", "2,5", "a"]) expect(lerNItemDigitado(t).ok, t).toBe(false);
  });
});

describe("chave colada do DANFE e destinatário da compra pela chave", () => {
  const formatada = CHAVE_SC.replace(/(\d{4})(?=\d)/g, "$1 ");
  it("a chave com espaços (54 caracteres) é conferida inteira, ao vivo", () => {
    expect(formatada.length).toBe(54);
    const v = conferirChaveDigitada(formatada);
    expect(v.ok).toBe(true);
    expect(v.chave).toBe(CHAVE_SC);
    expect(v.mensagem).toContain("NF-e nº 1234");
    expect(v.mensagem).toContain("SC");
  });
  it("a chave cortada diz quanto falta (era 'Dados da requisição inválidos.')", () => {
    expect(conferirChaveDigitada(formatada.slice(0, 44)).mensagem).toBe("Faltam 8 dígitos.");
    expect(conferirChaveDigitada("").vazia).toBe(true);
  });
  it("devolução de compra: CNPJ e UF do fornecedor saem da chave", () => {
    expect(destinatarioPelaChave(formatada)).toEqual({ tipoPessoa: "PJ", cpfCnpj: "11.222.333/0001-81", uf: "SC" });
    expect(destinatarioPelaChave("123")).toBeNull();
  });
  it("emitente pessoa física (000 + CPF válido) vira CPF; CNPJ que começa com 000 continua CNPJ", () => {
    expect(destinatarioPelaChave(chave("41", "00052998224725"))).toEqual({ tipoPessoa: "PF", cpfCnpj: "529.982.247-25", uf: "PR" });
    expect(destinatarioPelaChave(chave("53", "00000000000191"))?.tipoPessoa).toBe("PJ");
  });
});

describe("erros do servidor campo a campo (a tela jogava `erros[]` fora)", () => {
  it("com `erros`, o topo manda conferir e cada motivo fica no campo", () => {
    const e = lerErrosDaResposta({ error: "Dados da requisição inválidos.", code: "PAYLOAD_INVALIDO", erros: [{ campo: "chaveAcesso", mensagem: "Faltam 8 dígitos." }, { campo: "itens[0].quantidade", mensagem: "Use no máximo 4 casas decimais.", nItem: 5 }] });
    expect(e.geral).toBe(CONFIRA_OS_CAMPOS);
    expect(e.campos).toEqual([{ campo: "chaveAcesso", mensagem: "Faltam 8 dígitos." }, { campo: "itens[0].quantidade", mensagem: "Use no máximo 4 casas decimais.", nItem: 5 }]);
    expect(errosDoItemXml(e.campos, 5, 9)).toEqual(["Use no máximo 4 casas decimais."]);
  });
  it("sem `erros`, a frase do servidor; sem nada, a da tela", () => {
    expect(lerErrosDaResposta({ error: "Todos os itens desta nota já foram devolvidos." }).geral).toBe("Todos os itens desta nota já foram devolvidos.");
    expect(lerErrosDaResposta(null, "falhou").geral).toBe("falhou");
  });
  it("erro de item sem nItem cai pelo índice enviado", () => {
    expect(errosDoItemXml([{ campo: "itens[1].quantidade", mensagem: "x" }], 7, 1)).toEqual(["x"]);
    expect(errosDoItemXml([{ campo: "itens[1].quantidade", mensagem: "x" }], 7, 0)).toEqual([]);
  });
});

describe("prévia pelo XML: ela escolhe as peças (nasciam TODAS, na quantidade cheia)", () => {
  const previa = {
    itens: [
      { nItem: 1, codigo: "A", descricao: "Motor", unidade: "UN", valorUnitario: 100, quantidadeOriginal: 3, devolvidaAutorizada: 0, emProcessamento: 0, emRascunho: 0, disponivel: 3, cfopOriginal: "5655", cfopSugerido: null, cfopOpcoes: [], cfopStatus: "SEM_MAPEAMENTO" },
      { nItem: 5, codigo: "B", descricao: "Farol", unidade: "UN", valorUnitario: 664.58, quantidadeOriginal: 1, devolvidaAutorizada: 0, emProcessamento: 0, emRascunho: 0, disponivel: 1, cfopOriginal: "5102", cfopSugerido: "5202", cfopOpcoes: ["5202"], cfopStatus: "MAPEADO" },
      { nItem: 6, codigo: "C", descricao: "Lanterna", unidade: "UN", valorUnitario: 200, quantidadeOriginal: 1, devolvidaAutorizada: 1, emProcessamento: 0, emRascunho: 0, disponivel: 0, cfopOriginal: "5102", cfopSugerido: "5202", cfopOpcoes: ["5202"], cfopStatus: "MAPEADO" },
    ],
  };
  it("nada nasce marcado; a quantidade sugerida é o que ainda pode voltar", () => {
    const s = selecaoInicial(previa);
    expect(Object.values(s).every((x) => !x.marcado)).toBe(true);
    expect(s[1].quantidade).toBe("3");
  });
  it("nada marcado ⇒ recusa; marcadas ⇒ só elas, com a quantidade lida", () => {
    expect(itensMarcados(previa, selecaoInicial(previa))).toMatchObject({ ok: false, nenhum: true });
    const s = { ...selecaoInicial(previa), 5: { marcado: true, quantidade: "1" }, 1: { marcado: true, quantidade: "1,5" } };
    expect(itensMarcados(previa, s)).toEqual({ ok: true, itens: [{ nItem: 1, quantidade: 1.5 }, { nItem: 5, quantidade: 1 }] });
  });
  it("acima do que ainda pode voltar ⇒ recusa no item", () => {
    const s = { ...selecaoInicial(previa), 5: { marcado: true, quantidade: "2" } };
    const r = itensMarcados(previa, s);
    expect(r.ok).toBe(false);
    expect(r.ok === false && !r.nenhum ? r.porItem[5] : "").toContain("Só dá para devolver 1");
  });
  it("sem CFOP de devolução sugerido, diz que a escolha fica para o passo Produtos", () => {
    expect(avisoCfop(previa.itens[0])).toContain("5655");
    expect(avisoCfop(previa.itens[1])).toBeNull();
  });
});

describe("itens digitados pela chave e prefill da nota do Dexo", () => {
  it("converte no envio; erro fica no campo, com a chave que o servidor usaria", () => {
    const r = lerItensDigitados([
      { nItem: "3", codigo: "X", descricao: "Porta", ncm: "8708.29.99", unidade: "un", cfopOriginal: "5.102", valorUnitario: "45,90", quantidade: "1", origem: "0" },
      { nItem: "", codigo: "", descricao: "Y", ncm: "123", unidade: "UN", cfopOriginal: "", valorUnitario: "45,", quantidade: "1" },
    ]);
    expect(r.itens).toEqual([{ nItem: 3, codigo: "X", descricao: "Porta", ncm: "87082999", unidade: "UN", cfopOriginal: "5102", valorUnitario: 45.9, quantidade: 1, origem: 0 }]);
    // A segunda linha também não tem origem: obrigatória desde que o rascunho sem ela nascia travado.
    expect(r.erros.map((e) => e.campo).sort()).toEqual(["itens[1].codigo", "itens[1].nItem", "itens[1].ncm", "itens[1].origem", "itens[1].valorUnitario"]);
  });
  it("a venda do Dexo vira linhas com vírgula; o param da lista acha a nota", () => {
    expect(linhasDaNota([{ numero: 2, codigo: "P", descricao: "Porta", ncm: "87082999", unidade: "UN", cfop: "5102", valorUnitario: 45.9, quantidade: 1 }])[0]).toEqual({ nItem: "2", codigo: "P", descricao: "Porta", ncm: "87082999", unidade: "UN", cfopOriginal: "5102", valorUnitario: "45,9", quantidade: "1" });
    expect(urlDevolverPelaChave("n 1")).toBe("/notas-fiscais/emitidas?devolverPelaChave=n%201");
    expect(notaParaDevolverPelaChave("?devolverPelaChave=n%201")).toBe("n 1");
  });
});

// ─────────────────────────────── vínculo ───────────────────────────────

describe("vínculo nota original ↔ devolução", () => {
  it("selo na lista só para devolução, com o sentido", () => {
    expect(seloDevolucao({ finalidade: "DEVOLUCAO", tipoOperacao: "ENTRADA" })).toBe("Devolução · entrada");
    expect(seloDevolucao({ finalidade: "DEVOLUCAO", tipoOperacao: "SAIDA" })).toBe("Devolução · saída");
    expect(seloDevolucao({ finalidade: "NORMAL", tipoOperacao: "SAIDA" })).toBeNull();
  });
  it("histórico: eventos da devolução em português; o resto como sempre", () => {
    expect(rotuloEvento({ evento: "DEVOLUCAO_VINCULADA", detalhes: { nItem: 2, quantidade: 1.5 } })).toBe("Peça devolvida por uma devolução (item 2, quantidade 1,5)");
    expect(rotuloEvento({ evento: "DEVOLUCAO_AUTORIZADA" })).toBe("Devolução autorizada");
    expect(rotuloEvento({ evento: "DEVOLUCAO_RASCUNHO_CRIADO", detalhes: { tipo: "COMPRA_SAIDA" } })).toBe("Devolução começada (de compra)");
    expect(rotuloEvento({ evento: "EMITIDA" })).toBe("EMITIDA");
    expect(rotuloEvento({ evento: "constructor" })).toBe("constructor");
  });
  it("ficha da venda: as devoluções dela, o saldo e 'toda devolvida'", () => {
    const s = {
      original: {} as SaldoResposta["original"],
      elegivel: false,
      motivo: "TOTALMENTE_DEVOLVIDA",
      totalmenteDevolvida: true,
      devolucoes: [
        { nfeId: "d1", numero: 713, serie: 1, status: "AUTHORIZED", itens: [{ nItem: 1, quantidade: 1 }] },
        { nfeId: "d2", numero: null, serie: 1, status: "DRAFT", itens: [] },
      ],
      itens: [
        { nItem: 1, quantidadeOriginal: 1, devolvidaAutorizada: 1, emProcessamento: 0, emRascunho: 0, disponivel: 0, codigo: "A", descricao: "Farol", unidade: "UN", valorUnitario: 10 },
        { nItem: 2, quantidadeOriginal: 1, devolvidaAutorizada: 0, emProcessamento: 0, emRascunho: 0, disponivel: 1, codigo: "B", descricao: "Porta", unidade: "UN", valorUnitario: 10 },
      ],
    } as SaldoResposta;
    const v = viewDevolucoesDaNota(s);
    expect(v.devolucoes.map((d) => d.texto)).toEqual(["NF-e 713 (série 1) — autorizada — item 1 (1)", "Rascunho de devolução — rascunho"]);
    expect(v.saldo).toEqual(["Item 1 — Farol: devolvida 1 de 1, pode devolver 0"]);
    expect(v.totalmenteDevolvida).toBe(true);
    expect(v.aviso).toContain("já foram devolvidas");
  });
  it("ficha da devolução: de qual nota ela é", () => {
    expect(textoOriginaisDaDevolucao({ tipo: "COMPRA_SAIDA", originais: [{ chaveAcesso: CHAVE_SC, originalNfeId: null, modelo: "55", numero: 991757, serie: 1, dataEmissao: null, destinatarioNome: null }] }))
      .toEqual(["Devolução da NF-e 991757 (série 1) — nota do fornecedor"]);
  });
});
