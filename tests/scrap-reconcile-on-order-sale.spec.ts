// Espelho do bug G — vender pelo marketplace nunca marcava o lote como
// esgotado.
//
// `Scrap.status` é coluna PERSISTIDA e o único gatilho de reconciliação vinha
// do balcão (`markPaid`/`reverse`). Uma sucata cujas peças foram TODAS vendidas
// pelo ML, e que nunca teve venda de balcão, ficava `AVAILABLE` para sempre.
//
// O risco de corrigir isso não é a regra: é ONDE ela roda. `deductStockForOrder`
// executa DENTRO da importação de pedidos — maior volume e caminho mais
// sensível do sistema. Daí as duas travas que este spec fixa.
//
// Este teste exercita a função REAL que o `deductStockForOrder` chama, não uma
// reimplementação dela — do contrário provaria apenas que a cópia do teste
// funciona.

import { describe, it, expect } from "vitest";
import { scrapReconcileTargetsAfterSale } from "../app/marketplaces/services/scrap-status-reconcile.service";

const ON = { SCRAP_RECONCILE_ON_SALE_ENABLED: "1" };
const OFF = {};

describe("Trava 1 — a flag", () => {
  it("AUSENTE ⇒ lista vazia (importação byte-idêntica)", () => {
    expect(
      scrapReconcileTargetsAfterSale([{ productId: "p-1", newStock: 0 }], OFF),
    ).toEqual([]);
  });

  it("qualquer valor diferente de '1' também não liga", () => {
    for (const v of ["true", "TRUE", "yes", "0", ""]) {
      expect(
        scrapReconcileTargetsAfterSale([{ productId: "p-1", newStock: 0 }], {
          SCRAP_RECONCILE_ON_SALE_ENABLED: v,
        }),
      ).toEqual([]);
    }
  });
});

describe("Trava 2 — só quem ZEROU", () => {
  it("devolve apenas os produtos que chegaram a zero", () => {
    expect(
      scrapReconcileTargetsAfterSale(
        [
          { productId: "p-1", newStock: 0 },
          { productId: "p-2", newStock: 4 },
          { productId: "p-3", newStock: 0 },
        ],
        ON,
      ),
    ).toEqual(["p-1", "p-3"]);
  });

  it("NINGUÉM zerou ⇒ lista vazia", () => {
    // O ponto da trava: sem ela, toda venda abriria N transações serializadas
    // com advisory lock, dentro da importação de pedidos. `deriveScrapStatus`
    // só move o lote para DEPLETED quando o estoque somado chega a zero — logo,
    // reconciliar sem ninguém zerar é trabalho garantidamente inútil.
    expect(
      scrapReconcileTargetsAfterSale(
        [
          { productId: "p-1", newStock: 3 },
          { productId: "p-2", newStock: 1 },
        ],
        ON,
      ),
    ).toEqual([]);
  });

  it("pedido sem baixa nenhuma ⇒ lista vazia", () => {
    expect(scrapReconcileTargetsAfterSale([], ON)).toEqual([]);
  });

  it("estoque negativo (oversell clampado) não é tratado como zero", () => {
    // `deductWithinTx` clampa em 0, então na prática não ocorre — mas se um dia
    // ocorrer, o critério é igualdade estrita, não `<= 0`.
    expect(
      scrapReconcileTargetsAfterSale([{ productId: "p-1", newStock: -2 }], ON),
    ).toEqual([]);
  });

  it("preserva a ordem das deduções", () => {
    expect(
      scrapReconcileTargetsAfterSale(
        [
          { productId: "z", newStock: 0 },
          { productId: "a", newStock: 0 },
        ],
        ON,
      ),
    ).toEqual(["z", "a"]);
  });
});
