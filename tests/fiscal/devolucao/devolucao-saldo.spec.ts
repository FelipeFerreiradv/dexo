import { describe, expect, it } from "vitest";

import {
  baldeDoStatus,
  calcularSaldoPorItem,
  isTotalmenteDevolvida,
  quantidadeParaUnidades,
  temAteQuatroCasas,
  temDevolucaoConsumindo,
  type LinhaSaldoDevolucao,
} from "../../../app/fiscal/devolucao/saldo";

const CHAVE = "41260911386276000176550030000000121000000123";
const OUTRA = "41260911386276000176550030000000131000000137";

const linha = (
  nItem: number,
  quantidade: number | string,
  statusDevolucao: string,
  devolucaoNfeId = "dev-1",
  chave = CHAVE,
): LinhaSaldoDevolucao => ({ chave, nItem, quantidade, statusDevolucao, devolucaoNfeId });

describe("calcularSaldoPorItem", () => {
  it("sem devoluções: tudo disponível", () => {
    const r = calcularSaldoPorItem({ itensOriginais: [{ nItem: 1, quantidade: 2 }], linhas: [] });
    expect(r).toEqual([
      { nItem: 1, quantidadeOriginal: 2, devolvidaAutorizada: 0, emProcessamento: 0, emRascunho: 0, disponivel: 2 },
    ]);
    expect(isTotalmenteDevolvida(r)).toBe(false);
  });

  it("devolução total autorizada zera o saldo", () => {
    const r = calcularSaldoPorItem({
      itensOriginais: [{ nItem: 1, quantidade: 2 }],
      linhas: [linha(1, "2.0000", "AUTHORIZED")],
    });
    expect(r[0]).toMatchObject({ devolvidaAutorizada: 2, disponivel: 0 });
    expect(isTotalmenteDevolvida(r)).toBe(true);
    expect(temDevolucaoConsumindo(r)).toBe(true);
  });

  it("parcial: soma devoluções autorizadas de notas diferentes", () => {
    const r = calcularSaldoPorItem({
      itensOriginais: [{ nItem: 1, quantidade: 5 }],
      linhas: [linha(1, 1, "AUTHORIZED", "a"), linha(1, "1.5", "AUTHORIZED", "b")],
    });
    expect(r[0]).toMatchObject({ devolvidaAutorizada: 2.5, disponivel: 2.5 });
  });

  it("múltiplos itens são independentes e seguem a ordem do XML", () => {
    const r = calcularSaldoPorItem({
      itensOriginais: [
        { nItem: 3, quantidade: 1 },
        { nItem: 1, quantidade: 4 },
        { nItem: 2, quantidade: 2 },
      ],
      linhas: [linha(1, 4, "AUTHORIZED"), linha(2, 1, "SENDING"), linha(9, 1, "AUTHORIZED")],
    });
    expect(r.map((s) => [s.nItem, s.disponivel])).toEqual([
      [3, 1],
      [1, 0],
      [2, 1],
    ]);
    expect(isTotalmenteDevolvida(r)).toBe(false);
  });

  it("REJECTED e DRAFT só informam; CANCELLED e INUTILIZED não contam", () => {
    const r = calcularSaldoPorItem({
      itensOriginais: [{ nItem: 1, quantidade: 3 }],
      linhas: [
        linha(1, 1, "REJECTED", "r"),
        linha(1, 1, "DRAFT", "d"),
        linha(1, 3, "CANCELLED", "c"),
        linha(1, 3, "INUTILIZED", "i"),
      ],
    });
    expect(r[0]).toEqual({
      nItem: 1,
      quantidadeOriginal: 3,
      devolvidaAutorizada: 0,
      emProcessamento: 0,
      emRascunho: 2,
      disponivel: 3,
    });
  });

  it("em processamento (VALIDATING/SIGNING/SENDING) reserva o saldo", () => {
    const r = calcularSaldoPorItem({
      itensOriginais: [{ nItem: 1, quantidade: 3 }],
      linhas: [linha(1, 1, "VALIDATING", "v"), linha(1, 1, "SIGNING", "s"), linha(1, "0.5", "SENDING", "e")],
    });
    expect(r[0]).toMatchObject({ emProcessamento: 2.5, disponivel: 0.5 });
  });

  it("status desconhecido é conservador (reserva)", () => {
    expect(baldeDoStatus("QUALQUER")).toBe("EM_PROCESSAMENTO");
  });

  it("excluirDevolucaoNfeId tira a própria nota da conta", () => {
    const r = calcularSaldoPorItem({
      itensOriginais: [{ nItem: 1, quantidade: 2 }],
      linhas: [linha(1, 2, "SENDING", "esta"), linha(1, "0.5", "AUTHORIZED", "outra")],
      excluirDevolucaoNfeId: "esta",
    });
    expect(r[0]).toMatchObject({ emProcessamento: 0, devolvidaAutorizada: 0.5, disponivel: 1.5 });
  });

  it("filtro por chave aceita o prefixo NFe e ignora outras chaves", () => {
    const r = calcularSaldoPorItem({
      itensOriginais: [{ nItem: 1, quantidade: 2 }],
      linhas: [linha(1, 1, "AUTHORIZED", "a", "NFe" + CHAVE), linha(1, 2, "AUTHORIZED", "b", OUTRA)],
      chave: CHAVE,
    });
    expect(r[0]).toMatchObject({ devolvidaAutorizada: 1, disponivel: 1 });
  });

  it("aritmética exata em 1/10000: 0,1 + 0,2 = 0,3", () => {
    const r = calcularSaldoPorItem({
      itensOriginais: [{ nItem: 1, quantidade: "0.3" }],
      linhas: [linha(1, 0.1, "AUTHORIZED", "a"), linha(1, 0.2, "AUTHORIZED", "b")],
    });
    expect(r[0].devolvidaAutorizada).toBe(0.3);
    expect(r[0].disponivel).toBe(0);
    const r2 = calcularSaldoPorItem({
      itensOriginais: [{ nItem: 1, quantidade: 3 }],
      linhas: [linha(1, "1.0001", "AUTHORIZED")],
    });
    expect(r2[0].disponivel).toBe(1.9999);
  });

  it("excesso (anomalia) nunca gera disponível negativo", () => {
    const r = calcularSaldoPorItem({
      itensOriginais: [{ nItem: 1, quantidade: 1 }],
      linhas: [linha(1, 2, "AUTHORIZED")],
    });
    expect(r[0].disponivel).toBe(0);
  });

  it("original sem quantidade (externa sem XML) ⇒ disponível null", () => {
    const r = calcularSaldoPorItem({
      itensOriginais: [{ nItem: 7, quantidade: null }],
      linhas: [linha(7, 1, "AUTHORIZED")],
    });
    expect(r[0]).toMatchObject({ quantidadeOriginal: null, devolvidaAutorizada: 1, disponivel: null });
    expect(isTotalmenteDevolvida(r)).toBe(false);
  });
});

describe("quantidades em 1/10000", () => {
  it("number e texto decimal", () => {
    expect(quantidadeParaUnidades(1.0001)).toBe(10001);
    expect(quantidadeParaUnidades("1.0001")).toBe(10001);
    expect(quantidadeParaUnidades("2")).toBe(20000);
    expect(quantidadeParaUnidades("0.00005")).toBe(1);
    expect(quantidadeParaUnidades(0.1 + 0.2)).toBe(3000);
    expect(quantidadeParaUnidades("1,5")).toBeNull();
    expect(quantidadeParaUnidades(Number.NaN)).toBeNull();
    expect(quantidadeParaUnidades({})).toBeNull();
  });

  it("temAteQuatroCasas", () => {
    expect(temAteQuatroCasas(1.2345)).toBe(true);
    expect(temAteQuatroCasas(0.1 + 0.2)).toBe(true);
    expect(temAteQuatroCasas(1.00005)).toBe(false);
    expect(temAteQuatroCasas("1.23450")).toBe(true);
    expect(temAteQuatroCasas("1.23456")).toBe(false);
  });
});
