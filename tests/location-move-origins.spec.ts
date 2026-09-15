import { describe, it, expect } from "vitest";
import {
  summarizeMoveOrigins,
  type LinhaOrigem,
} from "../app/localizacoes/lib/move-products-origins";
import { buildMoveProductsAudit } from "../app/localizacoes/lib/move-products-audit";

/**
 * Chamado MK2 Autopeças, 09/2026.
 *
 * Mover peça não deixava rastro próprio: nem SystemLog, nem StockLog. O
 * middleware global gravava a requisição como CREATE_LOCATION e com o destino
 * "[REDACTED]" (a regra de redação casa "rg" por substring dentro de
 * "ta-RG-etLocationId"). A ORIGEM nunca existiu — o `updateMany` a sobrescreve
 * e não há tabela de histórico.
 *
 * A leitura de origem feita ANTES da escrita resolve dois defeitos de uma vez:
 * dá a origem para a auditoria E diz quantas peças de fato MUDARAM de lugar —
 * o `count` do `updateMany` conta linha que casou, não peça que se moveu.
 */

const g = (locationId: string | null, location: string | null, n: number): LinhaOrigem => ({
  locationId,
  location,
  _count: { _all: n },
});

describe("summarizeMoveOrigins", () => {
  it("conta como movidos só os que estavam FORA do destino", () => {
    const r = summarizeMoveOrigins(
      [g("loc-a", "GAL > CX1", 3), g("loc-dest", "GAL > CX9", 2)],
      "loc-dest",
      ["p1", "p2", "p3", "p4", "p5"],
    );
    expect(r.movidos).toBe(3);
    expect(r.jaNoDestino).toBe(2);
    expect(r.naoEncontrados).toBe(0);
  });

  it("não lista o destino entre as origens", () => {
    const r = summarizeMoveOrigins(
      [g("loc-a", "GAL > CX1", 1), g("loc-dest", "GAL > CX9", 1)],
      "loc-dest",
      ["p1", "p2"],
    );
    expect(r.origens.map((o) => o.locationId)).toEqual(["loc-a"]);
  });

  it("trata ids inexistentes ou de outro dono como não encontrados", () => {
    // O `where` do updateMany filtra por `userId`: id de outro tenant some em
    // silêncio, sem erro e sem entrar no count.
    const r = summarizeMoveOrigins([g("loc-a", "CX1", 2)], "loc-dest", [
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
    expect(r.naoEncontrados).toBe(2);
    expect(r.movidos).toBe(2);
  });

  it("deduplica os ids pedidos antes de contar", () => {
    // A rota não deduplica `productIds`; sem isto o "não encontrados" ficaria
    // positivo só por causa de id repetido.
    const r = summarizeMoveOrigins([g("loc-a", "CX1", 1)], "loc-dest", [
      "p1",
      "p1",
      "p1",
    ]);
    expect(r.solicitados).toBe(1);
    expect(r.naoEncontrados).toBe(0);
  });

  it("no desvínculo, peça já sem localização conta como já no destino", () => {
    const r = summarizeMoveOrigins(
      [g(null, null, 2), g("loc-a", "CX1", 1)],
      null,
      ["p1", "p2", "p3"],
    );
    expect(r.jaNoDestino).toBe(2);
    expect(r.movidos).toBe(1);
  });

  it("ordena as origens da maior para a menor e trunca preservando os contadores", () => {
    const linhas = Array.from({ length: 5 }, (_, i) =>
      g("loc-" + i, "CX" + i, i + 1),
    );
    const r = summarizeMoveOrigins(linhas, "loc-dest", ["a"], 2);
    expect(r.origens).toHaveLength(2);
    expect(r.origensTruncadas).toBe(true);
    expect(r.origens[0].quantidade).toBe(5);
    // O truncamento é da LISTA; os totais continuam certos.
    expect(r.movidos).toBe(1 + 2 + 3 + 4 + 5);
  });
});

describe("buildMoveProductsAudit", () => {
  const resumo = summarizeMoveOrigins(
    [g("loc-a", "GAL > CX1", 2), g("loc-b", "GAL > CX2", 1)],
    "loc-dest",
    ["p1", "p2", "p3"],
  );

  it("usa MOVE_PRODUCTS_LOCATION quando há destino", () => {
    const t = buildMoveProductsAudit({
      targetLocationId: "loc-dest",
      targetCode: "CX9",
      targetPath: "GAL > CX9",
      productIds: ["p1", "p2", "p3"],
      count: 3,
      resumo,
      outcome: "ok",
    });
    expect(t.action).toBe("MOVE_PRODUCTS_LOCATION");
    expect(t.message).toContain("GAL > CX9");
  });

  it("usa UNBIND_PRODUCTS_LOCATION quando o destino é nulo", () => {
    const t = buildMoveProductsAudit({
      targetLocationId: null,
      productIds: ["p1"],
      count: 1,
      resumo: null,
      outcome: "ok",
    });
    expect(t.action).toBe("UNBIND_PRODUCTS_LOCATION");
    expect(t.message).toMatch(/SEM localização/i);
  });

  it("registra origem, destino e os dois contadores no details", () => {
    const t = buildMoveProductsAudit({
      targetLocationId: "loc-dest",
      targetCode: "CX9",
      targetPath: "GAL > CX9",
      productIds: ["p1", "p2", "p3"],
      count: 3,
      resumo,
      outcome: "ok",
    });
    expect(t.details.destinoCaminho).toBe("GAL > CX9");
    expect(t.details.movidos).toBe(3);
    // `countUpdateMany` ao lado de `movidos` de propósito: os dois discordam
    // exatamente quando havia peça já no destino, e é isso que se quer auditar.
    expect(t.details.countUpdateMany).toBe(3);
    expect(t.details.origens).toHaveLength(2);
    expect(t.details.origemIndisponivel).toBe(false);
  });

  it("marca origemIndisponivel quando a leitura de origem falhou", () => {
    // A leitura é best-effort e não pode derrubar o movimento do operador — mas
    // o buraco tem de ficar registrado, não silencioso.
    const t = buildMoveProductsAudit({
      targetLocationId: "loc-dest",
      productIds: ["p1"],
      count: 1,
      resumo: null,
      outcome: "ok",
    });
    expect(t.details.origemIndisponivel).toBe(true);
  });

  it("trunca a lista de ids e sinaliza o truncamento", () => {
    // Lição do bulk-delete do Portal Eco Peças: depois do fato, o `details` é a
    // ÚNICA lista do que foi tocado. Truncar em silêncio seria pior que truncar.
    const ids = Array.from({ length: 250 }, (_, i) => "p" + i);
    const t = buildMoveProductsAudit({
      targetLocationId: "loc-dest",
      productIds: ids,
      count: 250,
      resumo: null,
      outcome: "ok",
    });
    expect((t.details.productIds as string[]).length).toBe(200);
    expect(t.details.productIdsTruncados).toBe(true);
  });

  it("registra o caminho de erro com a mensagem e o status", () => {
    // `determineActionType` passou a devolver null para esta rota: sem o log do
    // catch, a falha deixaria de ter QUALQUER rastro.
    const t = buildMoveProductsAudit({
      targetLocationId: "loc-dest",
      productIds: ["p1"],
      count: 0,
      resumo: null,
      outcome: "erro",
      errorMessage: "Localização de destino não encontrada",
      statusCode: 404,
    });
    expect(t.details.resultado).toBe("erro");
    expect(t.details.statusCode).toBe(404);
    expect(t.message).toMatch(/Falha ao mover/i);
  });
});
