// BLOCO G — o que as TELAS DE PRODUTO mostram quando a peça está comprometida.
//
// O CASO REAL QUE ORIGINOU ISTO (28/08): peça de 1 unidade vendida FIADO. A
// reserva foi gravada em 54 ms e o disponível virou 0 — mas o card do catálogo
// continuou dizendo "1 un.", porque desenhava `Product.stock`, o estoque
// FÍSICO. Quem olhou a tela concluiu que a venda não tinha baixado nada, e
// abriu um chamado de bug em cima de um sistema que estava certo.
//
// O que não era certo: a Fase 4 da entrega anterior cobriu só o seletor de
// peças do financeiro. As quatro telas de produto ficaram mostrando o bruto.
//
// Este arquivo trava a regra de exibição. O ponto mais importante é o último
// bloco: SEM reserva, a saída tem de ser byte-idêntica à de antes — é o que
// mantém o catálogo inteiro (367 mil produtos, quase todos sem reserva) livre
// de qualquer mudança visível.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const OK = { NEXT_PUBLIC_STOCK_RESERVATION_ENABLED: "true" };

/**
 * `isStockReservationUiEnabled` lê a env numa CONST DE MÓDULO (o Next precisa
 * disso para inlinar no bundle). Então a env tem de estar setada ANTES do
 * import — daí o `resetModules` + import dinâmico a cada caso.
 */
async function carregar(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return await import("../app/produtos/lib/product-format");
}

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_STOCK_RESERVATION_ENABLED;
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_STOCK_RESERVATION_ENABLED;
  vi.resetModules();
});

describe("Peça comprometida em venda pendente", () => {
  it("1 em estoque, 1 reservada ⇒ a tela diz ZERO DISPONÍVEL", async () => {
    // ⭐ O caso do chamado. Antes: "1 un.". Agora: "0 disponível".
    const { getStockDisplay } = await carregar(OK);
    const e = getStockDisplay(1, 1);

    expect(e.value).toBe(0);
    expect(e.suffix).toBe("disponível");
    expect(e.detail).toBe("1 em estoque · 1 reservada");
    expect(e.hasReserved).toBe(true);
  });

  it("o badge fica VERMELHO mesmo com estoque físico maior que zero", async () => {
    // `getStockBadgeVariant` recebe o disponível, não o físico — é isso que
    // transforma o sinal visual. Com o físico, a peça apareceria em verde.
    const { getStockDisplay, getStockBadgeVariant } = await carregar(OK);
    const e = getStockDisplay(1, 1);

    expect(getStockBadgeVariant(e.value)).toBe("destructive");
    expect(getStockBadgeVariant(1)).toBe("warning"); // o que era antes
  });

  it("5 em estoque, 2 reservadas ⇒ 3 disponíveis, sem alarme", async () => {
    const { getStockDisplay, getStockBadgeVariant } = await carregar(OK);
    const e = getStockDisplay(5, 2);

    expect(e.value).toBe(3);
    expect(e.detail).toBe("5 em estoque · 2 reservadas");
    expect(getStockBadgeVariant(e.value)).toBe("warning");
  });

  it("over-reserved não vira número negativo na tela", async () => {
    // Peça vendida por outro canal com fiado ainda em aberto: reserva > físico.
    // A tela nunca pode dizer "-1 disponível".
    const { getStockDisplay } = await carregar(OK);
    const e = getStockDisplay(0, 2);

    expect(e.value).toBe(0);
    expect(e.value).toBeGreaterThanOrEqual(0);
  });
});

describe("Sem reserva, a tela é a MESMA de antes", () => {
  it("reserva zero ⇒ estoque cru e sufixo 'un.'", async () => {
    const { getStockDisplay } = await carregar(OK);
    const e = getStockDisplay(7, 0);

    expect(e.value).toBe(7);
    expect(e.suffix).toBe("un.");
    expect(e.detail).toBeNull();
    expect(e.hasReserved).toBe(false);
  });

  it("campo AUSENTE (projeção antiga, cache) não quebra nem inventa", async () => {
    // A listagem não projetava `reservedStock` antes desta entrega. Uma resposta
    // em cache ou de um deploy anterior chega sem o campo.
    const { getStockDisplay } = await carregar(OK);

    expect(getStockDisplay(3, undefined).value).toBe(3);
    expect(getStockDisplay(3, undefined).detail).toBeNull();
    expect(getStockDisplay(3, null).value).toBe(3);
    expect(getStockDisplay(3, null).suffix).toBe("un.");
  });

  it("flag de UI DESLIGADA ⇒ mostra o bruto mesmo com reserva gravada", async () => {
    // O rollback é a env, e ele tem de devolver a tela ao estado anterior sem
    // depender de limpar a coluna do banco.
    const { getStockDisplay } = await carregar({});
    const e = getStockDisplay(1, 1);

    expect(e.value).toBe(1);
    expect(e.suffix).toBe("un.");
    expect(e.detail).toBeNull();
    expect(e.hasReserved).toBe(false);
  });
});
