// FASE 16 — fechando a cobertura da sombra de estoque disponível.
//
// O QUE ESTAVA ERRADO
// A Fase 14 afirmou "25 pontos cobertos por 4 entradas". Eram DUAS entradas
// funcionando. As outras falhavam por motivos diferentes, e nenhum deles
// aparecia em teste nem em `tsc`:
//
//  1. PUBLICAR anúncio novo — `withAvailableStock` era NO-OP ali, porque
//     `mapPrismaToProduct` não copiava `reservedStock` e a entidade `Product`
//     não tinha o campo. Um `as any` na chamada fazia o genérico aceitar o
//     tipo sem a propriedade, e o compilador não tinha como reclamar.
//  2. Shopee e Magalu nunca chamaram a sombra no publish — só o ML chamava.
//  3. `syncAllStock` (o botão "Sincronizar Estoque", o caminho de MAIOR
//     volume) tem query própria, que nem projetava a coluna.
//
// ⚠️ NENHUM teste existente foi tocado. Os 11 casos de
// `tests/stock-reservation-sync.spec.ts` continuam verdes sem alteração.

import { describe, it, expect } from "vitest";

import {
  availableForSale,
  withAvailableStock,
} from "../app/financeiro/lib/stock-reservation";

const ON = { STOCK_RESERVATION_ENABLED: "1" };
const OFF = {};

describe("A sombra é IDEMPOTENTE — aplicar duas vezes não desconta duas vezes", () => {
  it("segunda aplicação não mexe mais no número", () => {
    // ⭐ É a propriedade que substitui disciplina por garantia. Antes disso, a
    // cópia saía com `reservedStock` PRESERVADO, então `{stock:5, reserva:2}`
    // virava 3, depois 1, depois 0. Existem caminhos que passam pela sombra
    // mais de uma vez: `syncProductStock` aplica na entrada, e o retry
    // pós-refresh de token da Shopee reentra no mesmo método. O sintoma seria
    // "a peça sumiu do anúncio" sem causa aparente — e só quando o token
    // expirasse, que é o pior tipo de bug para reproduzir.
    const p = { id: "p-1", stock: 5, reservedStock: 2 };
    const uma = withAvailableStock(p, ON);
    const duas = withAvailableStock(uma, ON);
    const tres = withAvailableStock(duas, ON);
    expect(uma.stock).toBe(3);
    expect(duas.stock).toBe(3);
    expect(tres.stock).toBe(3);
  });

  it("a segunda aplicação devolve o MESMO objeto, sem nem copiar", () => {
    const p = { stock: 5, reservedStock: 2 };
    const uma = withAvailableStock(p, ON);
    expect(withAvailableStock(uma, ON)).toBe(uma);
  });

  it("a cópia sai com reservedStock zerado — é o que fecha a idempotência", () => {
    // ⚠️ O PREÇO DISSO: o objeto sombreado MENTE sobre `reservedStock`. Ele
    // serve para ENVIAR quantidade, nunca para exibir disponibilidade.
    // `describeAvailability` e `isOverReserved` sobre uma sombra dariam a
    // resposta errada. Regra: objeto sombreado não vai para tela, relatório
    // nem exportação.
    const p = { stock: 5, reservedStock: 2 };
    expect(withAvailableStock(p, ON).reservedStock).toBe(0);
    // e o original continua intacto
    expect(p.reservedStock).toBe(2);
  });

  it("com a flag desligada, aplicar N vezes segue devolvendo o mesmo objeto", () => {
    const p = { stock: 5, reservedStock: 2 };
    expect(withAvailableStock(withAvailableStock(p, OFF), OFF)).toBe(p);
    expect(p.stock).toBe(5);
  });
});

describe("O contrato que o publish depende", () => {
  it("produto SEM o campo projetado não é descontado — e não vira NaN", () => {
    // As leituras via `productSelect` (listagem, busca) não trazem a coluna.
    // O mapeador as devolve com `reservedStock: undefined` de propósito: dizer
    // `0` ali seria AFIRMAR "nada reservado" sobre um dado que existe no banco.
    expect(withAvailableStock({ stock: 10 } as any, ON).stock).toBe(10);
    expect(
      withAvailableStock({ stock: 10, reservedStock: null }, ON).stock,
    ).toBe(10);
  });

  it("peça inteiramente comprometida chega em ZERO, e é isso que pausa/recusa", () => {
    // No publish, zero cai no gate "precisa ter estoque maior que zero" e a
    // criação do anúncio é RECUSADA — que é o objetivo: anunciar peça que já
    // está numa venda em aberto é criar a venda dupla no ato do cadastro.
    expect(withAvailableStock({ stock: 1, reservedStock: 1 }, ON).stock).toBe(
      0,
    );
  });

  it("reserva maior que o estoque não vira número negativo", () => {
    // Mandar -2 para o marketplace é rejeição de API, não pausa.
    expect(withAvailableStock({ stock: 2, reservedStock: 5 }, ON).stock).toBe(
      0,
    );
  });
});

describe("syncAllStock — o caminho de maior volume", () => {
  it("o número despachado é o disponível, não o bruto", () => {
    // O botão "Sincronizar Estoque" varre a conta inteira em lotes. Se ele
    // empurrasse o bruto, desfaria a reserva de todos os anúncios de uma vez —
    // e era exatamente o que acontecia, porque o select nem trazia a coluna.
    const linha = {
      id: "p-1",
      sku: "S1",
      stock: 10,
      reservedStock: 3,
      name: "Farol",
    };
    expect(withAvailableStock(linha, ON).stock).toBe(7);
  });

  it("com a coluna em zero o alvo é idêntico ao de hoje", () => {
    expect(availableForSale(10, 0)).toBe(10);
    const linha = {
      id: "p-1",
      sku: "S1",
      stock: 10,
      reservedStock: 0,
      name: "Farol",
    };
    expect(withAvailableStock(linha, ON)).toBe(linha);
  });

  it("preserva sku e name — o log de sync os usa", () => {
    const linha = {
      id: "p-1",
      sku: "S1",
      stock: 10,
      reservedStock: 3,
      name: "Farol",
    };
    const sombra = withAvailableStock(linha, ON);
    expect(sombra.sku).toBe("S1");
    expect(sombra.name).toBe("Farol");
    expect(sombra.id).toBe("p-1");
  });
});
