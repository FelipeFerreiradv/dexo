import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// ⚠️⚠️ O DEFEITO QUE ESTE SPEC EXISTE PARA IMPEDIR DE VOLTAR.
//
// O `MOTIVO` do `diagnostico_operacional` nasceu com quatro chaves, das quais
// só UMA existe no vocabulário real. As outras três — `NO_ITEMS`,
// `ACCOUNT_ERROR`, `UNKNOWN` — eu inventei; o union de verdade é
// `OrderIngestionIssueReason`, com oito motivos.
//
// O erro era INVISÍVEL porque a linha tem um `?? i.reason` no fim: motivo não
// mapeado não quebra, só devolve o código cru. Ele só apareceu no primeiro
// teste com dados reais — as 12 pendências da loja são TODAS `NO_LINKED_ITEMS`,
// e o lojista leu "Motivo: NO_LINKED_ITEMS" num chat que existe justamente para
// não falar assim.
//
// ⭐ A trava de verdade é o TIPO (`Record<OrderIngestionIssueReason, string>`):
// motivo novo no union sem texto aqui para de compilar. Este spec cobre o que o
// tipo não cobre — que os textos EXISTEM, que estão em português e que dizem a
// mesma coisa que a tela de Pedidos.
// ===========================================================================

vi.mock("../app/lib/prisma", () => ({
  default: {
    orderIngestionIssue: { count: contarMock(), findMany: listarMock() },
    productListing: { count: async () => 0, findMany: async () => [] },
    syncLog: { findMany: async () => [] },
    marketplaceAccount: { findMany: async () => [] },
  },
}));

let pendencias: any[] = [];
function contarMock() {
  return async () => pendencias.length;
}
function listarMock() {
  return async () => pendencias;
}

import { diagnosticoOperacional } from "../app/ai/tools/read/diagnostico";

const escopo = () =>
  ({
    dataOwnerId: "t1",
    actorId: "u1",
    isAdmin: true,
    can: () => true,
    canAction: () => true,
  }) as any;

/** Todos os motivos do vocabulário real, lidos do fonte que os declara. */
const MOTIVOS_REAIS = (() => {
  const fonte = readFileSync(
    join(__dirname, "..", "app/marketplaces/services/order-ingestion-issue.service.ts"),
    "utf8",
  );
  const bloco = fonte.slice(
    fonte.indexOf("export type OrderIngestionIssueReason"),
    fonte.indexOf(";", fonte.indexOf("export type OrderIngestionIssueReason")),
  );
  return [...bloco.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
})();

const chamar = () =>
  diagnosticoOperacional.handler({ escopo: "pedidos" } as any, escopo()) as Promise<any>;

beforeEach(() => {
  pendencias = [];
});

// ---------------------------------------------------------------------------

describe("⭐⭐ nenhum motivo chega ao lojista como código cru", () => {
  it("o vocabulário real tem 8 motivos — e eles foram lidos do fonte, não digitados aqui", () => {
    expect(MOTIVOS_REAIS.length).toBeGreaterThanOrEqual(8);
    expect(MOTIVOS_REAIS).toContain("NO_LINKED_ITEMS");
  });

  it("⭐⭐ TODOS eles viram frase em português", async () => {
    pendencias = MOTIVOS_REAIS.map((reason, i) => ({
      id: `i${i}`,
      platform: "SHOPEE",
      externalOrderId: `${i}`,
      reason,
      status: "OPEN",
      attempts: 1,
      createdAt: new Date("2026-08-01"),
      marketplaceAccount: { accountName: "Loja" },
    }));

    const r = await chamar();
    const itens = r.pendenciasDeImportacao.itens;

    for (const item of itens) {
      // Nenhum motivo pode sair em MAIÚSCULAS_COM_UNDERSCORE.
      expect(item.motivo, `motivo cru vazou: ${item.motivo}`).not.toMatch(
        /^[A-Z_]+$/,
      );
      expect(item.motivo.length).toBeGreaterThan(15);
    }
  });

  it("⭐ `NO_LINKED_ITEMS` — o motivo de 100% das pendências reais — tem texto próprio", async () => {
    pendencias = [
      {
        id: "i1",
        platform: "MERCADO_LIVRE",
        externalOrderId: "2000012345",
        reason: "NO_LINKED_ITEMS",
        status: "NEEDS_ACTION",
        attempts: 5,
        createdAt: new Date("2026-07-30"),
        marketplaceAccount: { accountName: "JOTABE-AUTOPECAS" },
      },
    ];

    const r = await chamar();

    expect(r.pendenciasDeImportacao.itens[0].motivo).toBe(
      "o anúncio vendido não está vinculado a nenhum produto do seu estoque",
    );
  });

  it("⚠️ motivo desconhecido ainda cai no código cru — de propósito", async () => {
    // `reason` é String livre no banco. Uma versão futura pode gravar um motivo
    // que este código não conhece; devolver vazio seria pior que devolver o
    // código. O que mudou é que isso virou exceção, não o caso comum.
    pendencias = [
      {
        id: "i1",
        platform: "SHOPEE",
        externalOrderId: "1",
        reason: "MOTIVO_DO_FUTURO",
        status: "OPEN",
        attempts: 1,
        createdAt: new Date(),
        marketplaceAccount: { accountName: "Loja" },
      },
    ];

    const r = await chamar();
    expect(r.pendenciasDeImportacao.itens[0].motivo).toBe("MOTIVO_DO_FUTURO");
  });
});

describe("⭐ o chat e a tela de Pedidos contam a MESMA história", () => {
  const rota = readFileSync(
    join(__dirname, "..", "app/routes/order.routes.ts"),
    "utf8",
  );

  it("cada motivo do chat casa com o texto da tela", async () => {
    // ⚠️ Não é igualdade de string: a tela escreve em frase completa ("O anúncio
    // vendido não está vinculado...") e o chat entra no meio de uma frase
    // ("motivo: o anúncio vendido não está..."). O que tem de bater é o miolo —
    // ler duas descrições diferentes do mesmo problema faria o lojista achar
    // que são dois problemas.
    pendencias = MOTIVOS_REAIS.map((reason, i) => ({
      id: `i${i}`,
      platform: "SHOPEE",
      externalOrderId: `${i}`,
      reason,
      status: "OPEN",
      attempts: 1,
      createdAt: new Date(),
      marketplaceAccount: { accountName: "Loja" },
    }));

    const itens = (await chamar()).pendenciasDeImportacao.itens;

    for (const item of itens) {
      // O trecho mais distintivo da frase do chat tem de existir na rota.
      const nucleo = item.motivo.split(" — ")[0].slice(4, 40);
      expect(
        rota.toLowerCase(),
        `a tela de Pedidos não fala assim: "${nucleo}"`,
      ).toContain(nucleo.toLowerCase());
    }
  });
});
