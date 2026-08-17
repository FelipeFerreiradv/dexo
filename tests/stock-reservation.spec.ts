// BLOCO G — estoque comprometido por venda pendente.
//
// A DECISÃO DE DESENHO que este spec protege: RECALCULAR, não acumular.
//
// O caminho óbvio (somar no create, subtrair no markPaid/reverse/delete) tem
// uma classe de bug embutida — basta UM caminho esquecer de subtrair e a peça
// fica reservada para sempre, sem ninguém saber por quê. Com 65 vendas
// pendentes em produção e a mais antiga aberta há 51 dias, uma reserva órfã
// não seria percebida.
//
// Aqui o valor vem sempre da FONTE DA VERDADE (as linhas de venda em aberto),
// e é isso que os testes de ida-e-volta afirmam: criar → receber devolve a
// reserva a zero SEM ninguém ter subtraído nada.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

import {
  availableForSale,
  describeAvailability,
  isOverReserved,
  isStockReservationEnabled,
  reservationDelta,
  reservationOf,
  reservesStock,
} from "../app/financeiro/lib/stock-reservation";

const ORIG = process.env.STOCK_RESERVATION_ENABLED;
afterAll(() => {
  if (ORIG === undefined) delete process.env.STOCK_RESERVATION_ENABLED;
  else process.env.STOCK_RESERVATION_ENABLED = ORIG;
});

describe("Quem segura a peça", () => {
  it("PENDENTE e VENCIDA seguram — a venda existe e o estoque não baixou", () => {
    expect(reservesStock("PENDENTE")).toBe(true);
    expect(reservesStock("VENCIDA")).toBe(true);
  });

  it("PAGA NÃO segura — ali o estoque já baixou de verdade", () => {
    // Contar duas vezes tiraria a peça do mercado em dobro.
    expect(reservesStock("PAGA")).toBe(false);
  });

  it("CANCELADA não segura — acabou", () => {
    expect(reservesStock("CANCELADA")).toBe(false);
  });

  it("status desconhecido ou ausente NÃO segura (fail-open)", () => {
    // Reservar por engano tira do mercado peça que existe. Entre errar para um
    // lado ou para o outro, o lado seguro aqui é não segurar.
    expect(reservesStock("QUALQUER")).toBe(false);
    expect(reservesStock(null)).toBe(false);
    expect(reservesStock(undefined)).toBe(false);
  });
});

describe("reservationOf — o que a venda compromete", () => {
  it("soma as quantidades por produto", () => {
    const m = reservationOf(
      [
        { productId: "p-1", quantity: 2 },
        { productId: "p-2", quantity: 1 },
      ],
      "PENDENTE",
    );
    expect(m.get("p-1")).toBe(2);
    expect(m.get("p-2")).toBe(1);
  });

  it("o MESMO produto em duas linhas soma", () => {
    // Acontece: o operador adiciona a peça, depois adiciona de novo.
    const m = reservationOf(
      [
        { productId: "p-1", quantity: 2 },
        { productId: "p-1", quantity: 3 },
      ],
      "PENDENTE",
    );
    expect(m.get("p-1")).toBe(5);
  });

  it("item MANUAL não reserva — não há peça de catálogo a segurar", () => {
    const m = reservationOf(
      [
        { productId: null, quantity: 5 },
        { productId: undefined, quantity: 5 },
      ],
      "PENDENTE",
    );
    expect(m.size).toBe(0);
  });

  it("venda PAGA não compromete nada", () => {
    expect(
      reservationOf([{ productId: "p-1", quantity: 2 }], "PAGA").size,
    ).toBe(0);
  });

  it("quantidade inválida é ignorada, não vira NaN na coluna", () => {
    const m = reservationOf(
      [
        { productId: "p-1", quantity: 0 },
        { productId: "p-2", quantity: -3 },
        { productId: "p-3", quantity: NaN },
      ],
      "PENDENTE",
    );
    expect(m.size).toBe(0);
  });

  it("lista ausente ⇒ mapa vazio", () => {
    expect(reservationOf(null, "PENDENTE").size).toBe(0);
    expect(reservationOf(undefined, "PENDENTE").size).toBe(0);
  });
});

describe("reservationDelta — ida e volta", () => {
  const vazio = new Map<string, number>();

  it("criar venda: tudo entra", () => {
    const d = reservationDelta(vazio, new Map([["p-1", 2]]));
    expect(d.get("p-1")).toBe(2);
  });

  it("receber venda: tudo sai — a reserva volta a ZERO", () => {
    // É o teste de ida-e-volta: sem ninguém ter subtraído explicitamente.
    const d = reservationDelta(new Map([["p-1", 2]]), vazio);
    expect(d.get("p-1")).toBe(-2);
  });

  it("produto que NÃO mudou não entra no delta", () => {
    // Produto sem mudança não vira UPDATE.
    const d = reservationDelta(new Map([["p-1", 2]]), new Map([["p-1", 2]]));
    expect(d.size).toBe(0);
  });

  it("trocar item por outro: um libera, o outro compromete", () => {
    const d = reservationDelta(new Map([["p-1", 2]]), new Map([["p-2", 1]]));
    expect(d.get("p-1")).toBe(-2);
    expect(d.get("p-2")).toBe(1);
  });

  it("aumentar a quantidade gera só a diferença", () => {
    const d = reservationDelta(new Map([["p-1", 2]]), new Map([["p-1", 5]]));
    expect(d.get("p-1")).toBe(3);
  });
});

describe("availableForSale — o número que a próxima fase vai empurrar", () => {
  it("desconta a reserva do físico", () => {
    expect(availableForSale(10, 3)).toBe(7);
  });

  it("sem reserva, é o estoque cru", () => {
    expect(availableForSale(10, 0)).toBe(10);
    expect(availableForSale(10, null)).toBe(10);
    expect(availableForSale(10, undefined)).toBe(10);
  });

  it("NUNCA negativo — a tela não pode dizer '-2 disponíveis'", () => {
    // Reserva maior que o estoque significa que alguém vendeu o que não tinha.
    // A resposta certa para "quanto posso vender" é ZERO.
    expect(availableForSale(2, 5)).toBe(0);
  });

  it("valores ausentes viram zero, não NaN", () => {
    expect(availableForSale(null, null)).toBe(0);
    expect(availableForSale(undefined, undefined)).toBe(0);
  });
});

describe("isOverReserved — o sinal de que a venda dupla aconteceu", () => {
  it("reserva maior que o estoque acusa", () => {
    expect(isOverReserved(2, 5)).toBe(true);
  });

  it("reserva igual ao estoque NÃO acusa — está tudo comprometido, não vendido a mais", () => {
    expect(isOverReserved(5, 5)).toBe(false);
  });

  it("sem reserva, nunca acusa", () => {
    expect(isOverReserved(0, 0)).toBe(false);
    expect(isOverReserved(10, null)).toBe(false);
  });
});

describe("describeAvailability — o texto da tela", () => {
  it("sem reserva mostra só o estoque", () => {
    expect(describeAvailability(3, 0)).toBe("3 em estoque");
    expect(describeAvailability(3, null)).toBe("3 em estoque");
  });

  it("com reserva mostra as duas coisas, concordando em número", () => {
    expect(describeAvailability(3, 1)).toBe("3 em estoque · 1 reservada");
    expect(describeAvailability(3, 2)).toBe("3 em estoque · 2 reservadas");
  });
});

describe("Flag", () => {
  it("ausente ⇒ desligada", () => {
    expect(isStockReservationEnabled({})).toBe(false);
  });

  it("só a string exata '1' liga", () => {
    expect(
      isStockReservationEnabled({ STOCK_RESERVATION_ENABLED: "true" }),
    ).toBe(false);
    expect(isStockReservationEnabled({ STOCK_RESERVATION_ENABLED: "1" })).toBe(
      true,
    );
  });
});
