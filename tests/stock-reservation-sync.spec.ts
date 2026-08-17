// BLOCO G, 2ª FATIA — a virada do sync.
//
// O mapeamento achou 25 pontos que empurram quantidade para fora. Editar 25
// lugares seria 25 chances de esquecer um — e o esquecido seria justamente o
// `syncProductData`, que roda em TODA edição de produto e desfaria a reserva
// em silêncio na próxima vez que alguém mexesse em qualquer peça.
//
// A virada é por SOMBRA: o número é trocado UMA VEZ na entrada de cada funil,
// e tudo o que vem depois — os três métodos por plataforma, os gates
// `if (product.stock > 0)`, o `available_quantity` do sync completo — lê o
// valor efetivo sem saber que existe reserva.
//
// Isso só é seguro porque o sync NUNCA escreve em `Product` (verificado: zero
// `product.update` em sync.usercase.ts). É essa propriedade que este spec
// protege junto com a aritmética: se alguém um dia gravar de volta, o estoque
// FÍSICO do sistema passa a encolher a cada sincronização.

import { describe, it, expect, afterAll } from "vitest";

import {
  availableForSale,
  withAvailableStock,
} from "../app/financeiro/lib/stock-reservation";

const ON = { STOCK_RESERVATION_ENABLED: "1" };
const OFF = {};

const ORIG = process.env.STOCK_RESERVATION_ENABLED;
afterAll(() => {
  if (ORIG === undefined) delete process.env.STOCK_RESERVATION_ENABLED;
  else process.env.STOCK_RESERVATION_ENABLED = ORIG;
});

describe("withAvailableStock — a sombra que cobre os 25 pontos", () => {
  it("desconta o comprometido do que vai para o marketplace", () => {
    const p = { id: "p-1", stock: 10, reservedStock: 3, name: "Farol" };
    expect(withAvailableStock(p, ON).stock).toBe(7);
  });

  it("NÃO muta o produto original — o estoque físico é sagrado", () => {
    // Se isto virar mutação, o objeto carregado do banco passa a carregar o
    // número efetivo, e qualquer escrita posterior gravaria o valor errado.
    const p = { id: "p-1", stock: 10, reservedStock: 3 };
    const sombra = withAvailableStock(p, ON);
    expect(p.stock).toBe(10);
    expect(sombra).not.toBe(p);
  });

  it("preserva todo o resto do objeto — inclusive os listings", () => {
    // `syncProductStock` carrega o produto COM os anúncios e itera sobre eles.
    // Perder `listings` na cópia significaria não sincronizar nada.
    const p = {
      id: "p-1",
      stock: 10,
      reservedStock: 3,
      name: "Farol",
      listings: [{ id: "l-1" }, { id: "l-2" }],
    };
    const sombra = withAvailableStock(p, ON);
    expect(sombra.listings).toHaveLength(2);
    expect(sombra.name).toBe("Farol");
    expect(sombra.id).toBe("p-1");
  });

  it("peça INTEIRAMENTE reservada chega em ZERO — e é isso que pausa o anúncio", () => {
    // Os gates `if (product.stock > 0)` que já existem passam a fazer a coisa
    // certa de graça: quantidade zero cai no ramo que pausa.
    expect(withAvailableStock({ stock: 1, reservedStock: 1 }, ON).stock).toBe(
      0,
    );
  });

  it("reserva MAIOR que o estoque não vira número negativo", () => {
    // Mandar -2 para o Mercado Livre seria rejeição de API, não pausa.
    expect(withAvailableStock({ stock: 2, reservedStock: 5 }, ON).stock).toBe(
      0,
    );
  });

  it("sem reserva, devolve o MESMO objeto — nem cópia acontece", () => {
    const p = { stock: 10, reservedStock: 0 };
    expect(withAvailableStock(p, ON)).toBe(p);
  });

  it("FLAG DESLIGADA: mesmo objeto, mesmo número, mesmo tudo", () => {
    // É o que garante que ligar o código sem ligar a flag deixa 364 mil
    // anúncios exatamente como estão hoje.
    const p = { stock: 10, reservedStock: 3 };
    const saida = withAvailableStock(p, OFF);
    expect(saida).toBe(p);
    expect(saida.stock).toBe(10);
  });

  it("só a string exata '1' liga", () => {
    const p = { stock: 10, reservedStock: 3 };
    expect(
      withAvailableStock(p, { STOCK_RESERVATION_ENABLED: "true" }).stock,
    ).toBe(10);
  });

  it("reservedStock ausente (produto de projeção antiga) não quebra", () => {
    // Nem toda consulta seleciona a coluna. Sem tratar isso, o sync mandaria
    // NaN para o marketplace.
    expect(withAvailableStock({ stock: 10 } as any, ON).stock).toBe(10);
    expect(
      withAvailableStock({ stock: 10, reservedStock: null }, ON).stock,
    ).toBe(10);
  });
});

describe("O reconciliador usa o mesmo número", () => {
  it("o alvo do job é o disponível, não o bruto", () => {
    // O reconciliador roda a cada 15 minutos sobre TODOS os anúncios. Se ele
    // enfileirasse o estoque bruto, desfaria a reserva de todo mundo de uma
    // vez — e a cada tick.
    expect(availableForSale(10, 3)).toBe(7);
    expect(availableForSale(1, 1)).toBe(0);
  });

  it("com a coluna em zero, o alvo é idêntico ao de hoje", () => {
    // `reservedStock` é NOT NULL DEFAULT 0, então com a flag desligada ninguém
    // escreve nela e o reconciliador continua enfileirando exatamente o que
    // enfileirava antes.
    expect(availableForSale(10, 0)).toBe(10);
  });
});
