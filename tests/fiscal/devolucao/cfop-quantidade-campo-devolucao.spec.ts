/**
 * Os campos do passo "Produtos" da devolução vistos do lado da TELA: CFOP
 * (`nfe-devolucao-cfop-campo.ts`) e quantidade (`nfe-devolucao-quantidade-campo.ts`).
 *
 * Casos reais (DLS AUTO PEÇAS, 24/09/2026):
 *  - K9: o CFOP era campo livre, nascia vazio ao lado do "CFOP original: 5102"
 *    (a VENDA da DISAUTO). Ela copiou o 5102, levou "CFOP inválido"; em branco,
 *    "Dados da requisição inválidos."; e o `maxLength={4}` cortava "50202".
 *  - K10: o máximo era só dica de HTML (ela digitou 10 com 1 disponível) e
 *    apagar o número virava 0 — que tirava a peça em silêncio.
 */
import { describe, expect, it } from "vitest";

import {
  GRUPO_OUTROS,
  campoCfop,
  idDestDaOriginal,
  referenciaCfopOriginal,
  rotuloCfop,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-cfop-campo";
import {
  QUANTIDADE_VAZIA,
  QUANTIDADE_ZERO,
  formatarQuantidade,
  lerQuantidadeDevolucao,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-quantidade-campo";
import {
  idDestDoCfop,
  isCfopPermitidoEmDevolucao,
  mapearCfopDevolucao,
} from "../../../app/fiscal/domain/devolucao-cfop";

describe("campoCfop — DLS: devolução de compra da DISAUTO, dentro do estado", () => {
  const mapa = mapearCfopDevolucao({ cfopOriginal: "5102", tipo: "COMPRA_SAIDA", idDestOriginal: 1, crt: "1" });
  const campo = campoCfop({
    tipo: "COMPRA_SAIDA",
    crt: "1",
    idDest: 1,
    sugeridos: mapa.opcoes,
    cfop: "",
    cfopOriginal: "5102",
  });

  it("nasce vazio (ESCOLHA) e oferece os sugeridos do servidor, com o nome de cada operação", () => {
    expect(campo.valor).toBe("");
    expect(campo.sugeridos.map((o) => o.codigo)).toEqual(mapa.opcoes);
    expect(campo.sugeridos[0].rotulo).toBe("5202 — Devolução de compra para comercialização");
  });

  it("o 5102 da venda do fornecedor NÃO é opção — aparece como referência, dizendo que não serve", () => {
    const todos = [...campo.sugeridos, ...campo.outros].map((o) => o.codigo);
    expect(todos).not.toContain("5102");
    expect(campo.referencia).toContain("CFOP de saída do fornecedor: 5102");
    expect(campo.referencia).toContain("não serve na devolução");
  });

  it("os OUTROS CFOPs de devolução que o servidor aceita também estão lá (o 5661 do óleo, por exemplo)", () => {
    const outros = campo.outros.map((o) => o.codigo);
    expect(outros).toContain("5661");
    expect(outros.some((c) => mapa.opcoes.includes(c))).toBe(false);
    expect(GRUPO_OUTROS).toBe("Outros CFOPs de devolução");
  });

  it("toda opção passa pela MESMA checagem do servidor (regra 327 + destino)", () => {
    for (const o of [...campo.sugeridos, ...campo.outros]) {
      expect(isCfopPermitidoEmDevolucao(o.codigo, "1"), o.codigo).toBe(true);
      expect(idDestDoCfop(o.codigo), o.codigo).toBe(1);
    }
  });

  it("o CFOP gravado fica selecionado; um gravado fora da lista entra como opção própria", () => {
    expect(campoCfop({ tipo: "COMPRA_SAIDA", crt: "1", idDest: 1, sugeridos: ["5202"], cfop: "5202", cfopOriginal: "5102" }).gravadoForaDaLista).toBeNull();
    const estranho = campoCfop({ tipo: "COMPRA_SAIDA", crt: "1", idDest: 1, sugeridos: ["5202"], cfop: "5020", cfopOriginal: "5102" });
    expect(estranho.valor).toBe("5020");
    expect(estranho.gravadoForaDaLista?.codigo).toBe("5020");
  });
});

describe("referência do CFOP da nota original — o nome certo para cada caso", () => {
  it("devolução de venda: é a venda DELA, não 'do fornecedor'", () => {
    expect(referenciaCfopOriginal("VENDA_ENTRADA", "5102")).toBe("CFOP da sua venda: 5102.");
  });
  it("devolução de compra pela chave, com o CFOP da entrada dela", () => {
    expect(referenciaCfopOriginal("COMPRA_SAIDA", "1102")).toBe("CFOP da sua entrada: 1102.");
  });
  it("sem CFOP original, nada", () => {
    expect(referenciaCfopOriginal("COMPRA_SAIDA", null)).toBe("");
  });
  it("código fora do catálogo não quebra o rótulo", () => {
    expect(rotuloCfop("5999")).toBe("5999 — CFOP de devolução");
  });
});

describe("idDestDaOriginal", () => {
  it("lê o destino do snapshot da original", () => {
    expect(idDestDaOriginal([{ chaveAcesso: "X", idDest: 2 }], "X", [])).toBe(2);
  });
  it("sem ele, o 1º dígito do CFOP sugerido diz o mesmo", () => {
    expect(idDestDaOriginal([{ chaveAcesso: "X" }], "X", ["6202"])).toBe(2);
    expect(idDestDaOriginal(undefined, "X", [])).toBeNull();
  });
});

describe("lerQuantidadeDevolucao — vazio não é zero", () => {
  it("campo vazio é 'falta informar', e trava o salvar", () => {
    const q = lerQuantidadeDevolucao("", 1);
    expect(q.estado).toBe("VAZIA");
    expect(q.valor).toBeNull();
    expect(q.bloqueia).toBe(true);
    expect(q.mensagem).toBe(QUANTIDADE_VAZIA);
  });

  it("zero digitado é a escolha de tirar a peça — dito antes de salvar, sem travar", () => {
    const q = lerQuantidadeDevolucao("0", 1);
    expect(q.estado).toBe("ZERO");
    expect(q.bloqueia).toBe(false);
    expect(q.mensagem).toBe(QUANTIDADE_ZERO);
  });

  it("acima do disponível trava com o número certo (DLS: 10 com 1 disponível)", () => {
    const q = lerQuantidadeDevolucao("10", 1);
    expect(q.estado).toBe("ACIMA_DO_DISPONIVEL");
    expect(q.bloqueia).toBe(true);
    expect(q.mensagem).toContain("No máximo 1");
  });

  it("no limite exato passa, sem erro binário", () => {
    expect(lerQuantidadeDevolucao("1,0001", 1.0001).estado).toBe("OK");
    expect(lerQuantidadeDevolucao("0.3", 0.3).estado).toBe("OK");
  });

  it("disponível nulo (nota sem XML) = sem teto, como no servidor", () => {
    expect(lerQuantidadeDevolucao("999", null).estado).toBe("OK");
  });

  it("aceita vírgula; recusa letra, negativo e mais de 4 casas", () => {
    expect(lerQuantidadeDevolucao("2,5", 3)).toMatchObject({ estado: "OK", valor: 2.5 });
    expect(lerQuantidadeDevolucao("abc", 3).estado).toBe("INVALIDA");
    expect(lerQuantidadeDevolucao("-1", 3).estado).toBe("INVALIDA");
    const casas = lerQuantidadeDevolucao("1,00001", 3);
    expect(casas.estado).toBe("INVALIDA");
    expect(casas.mensagem).toContain("4 casas");
  });

  it("disponível zero diz que não há mais nada a devolver", () => {
    expect(lerQuantidadeDevolucao("1", 0).mensagem).toContain("não tem mais nada para devolver");
  });

  it("formata como ela lê", () => {
    expect(formatarQuantidade(2.5)).toBe("2,5");
    expect(formatarQuantidade(1)).toBe("1");
  });
});
