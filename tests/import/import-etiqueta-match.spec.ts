/**
 * Casamento por ETIQUETA — a segunda chance do vínculo por SKU.
 *
 * Caso real que motivou: o cliente já tinha 24.415 produtos no Dexo (vindos da
 * importação de anúncios, NENHUM com localização) e a planilha do Vaapt trazia
 * justamente as localizações. Só que o SKU do Dexo veio do anúncio:
 *
 *     Dexo ....... "18593"  ou  "15709 N535"   (etiqueta + prateleira)
 *     Cod Peça ... 5340416                      -> casa com ZERO produtos
 *     Etiqueta ... 18593                        -> casa
 *
 * Medido: 13.305 por SKU exato + 2.589 só pelo 1º token = 15.894 de 28.875
 * (55,0%), com apenas 29 ambíguos.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../app/lib/prisma", () => ({
  default: {
    product: { findMany: vi.fn(async () => []) },
    location: { findMany: vi.fn(async () => []) },
    scrap: { findMany: vi.fn(async () => []) },
  },
}));

import {
  resolverPorEtiqueta,
  type ProdutoParaEtiqueta,
} from "../../app/usecases/import/lib/etiqueta-match";
import type { LinkPlanItem } from "../../app/usecases/import/mappers/vinculos.mapper";
import type { ImportContext, ImportReport } from "../../app/usecases/import/import.types";
import { newReport } from "../../app/usecases/import/import.types";

const ctx: ImportContext = { targetUserId: "u1", files: [], dryRun: false };
const rel = (): ImportReport => newReport("VAAPT", "VINCULOS", "u1", false);

function deps(produtos: ProdutoParaEtiqueta[]) {
  const chamadas: string[] = [];
  return {
    dep: {
      loadTodosOsProdutos: vi.fn(async (userId: string) => {
        chamadas.push(userId);
        return produtos;
      }),
    },
    chamadas,
  };
}

const item = (
  sku: string,
  etiqueta: string | null,
  linha = 1,
): LinkPlanItem => ({ linha, sku, etiqueta, locationCode: "L1", locationLabel: "L1" });

const prod = (id: string, sku: string): ProdutoParaEtiqueta => ({
  id,
  sku,
  skuNormalized: sku.trim().toLowerCase(),
});

describe("import/etiqueta-match", () => {
  it("casa pelo SKU INTEIRO quando a etiqueta é o próprio SKU do Dexo", async () => {
    const { dep } = deps([prod("p1", "18593")]);
    const r = await resolverPorEtiqueta(ctx, rel(), [item("5340416", "18593")], dep);
    expect(r.resolvidos).toBe(1);
    expect(r.items[0].sku).toBe("18593"); // reescrito para o SKU real
  });

  it("casa pelo 1º TOKEN do SKU ('15709 N535' ← etiqueta '15709')", async () => {
    const { dep } = deps([prod("p1", "15709 N535")]);
    const r = await resolverPorEtiqueta(ctx, rel(), [item("999", "15709")], dep);
    expect(r.resolvidos).toBe(1);
    expect(r.items[0].sku).toBe("15709 N535");
  });

  it("AMBÍGUO: etiqueta que aponta para 2 produtos NÃO vincula", async () => {
    // 4.140 dos 24.423 produtos do tenant real compartilham o 1º token — o
    // teste de unicidade é o que impede o vínculo errado.
    const { dep } = deps([prod("p1", "5728 N1"), prod("p2", "5728 N2")]);
    const report = rel();
    const r = await resolverPorEtiqueta(ctx, report, [item("999", "5728")], dep);
    expect(r.resolvidos).toBe(0);
    expect(r.ambiguos).toBe(1);
    expect(r.items[0].sku).toBe("999"); // segue com o original → sem_produto
    expect(report.contadores.etiqueta_ambigua).toBe(1);
  });

  it("PRECEDÊNCIA: se o 'Cod Peça' já casa, a etiqueta não interfere", async () => {
    const { dep } = deps([prod("p1", "5340416"), prod("p2", "18593")]);
    const r = await resolverPorEtiqueta(ctx, rel(), [item("5340416", "18593")], dep);
    expect(r.resolvidos).toBe(0);
    expect(r.items[0].sku).toBe("5340416"); // intocado
  });

  it("etiqueta sem correspondência deixa o item como está", async () => {
    const { dep } = deps([prod("p1", "outro")]);
    const r = await resolverPorEtiqueta(ctx, rel(), [item("999", "12345")], dep);
    expect(r.resolvidos).toBe(0);
    expect(r.items[0].sku).toBe("999");
  });

  it("EGRESS: sem coluna de etiqueta, NÃO consulta o banco", async () => {
    const { dep, chamadas } = deps([prod("p1", "18593")]);
    const r = await resolverPorEtiqueta(ctx, rel(), [item("100", null)], dep);
    expect(chamadas).toEqual([]);
    expect(r.resolvidos).toBe(0);
  });

  it("EGRESS: uma consulta só, mesmo com muitos itens", async () => {
    const { dep, chamadas } = deps(
      Array.from({ length: 300 }, (_, i) => prod(`p${i}`, String(1000 + i))),
    );
    const itens = Array.from({ length: 300 }, (_, i) =>
      item(`nao-existe-${i}`, String(1000 + i), i + 1),
    );
    const r = await resolverPorEtiqueta(ctx, rel(), itens, dep);
    expect(chamadas).toHaveLength(1);
    expect(r.resolvidos).toBe(300);
  });

  it("tenant sem produto nenhum: devolve tudo intocado", async () => {
    const { dep } = deps([]);
    const r = await resolverPorEtiqueta(ctx, rel(), [item("100", "18593")], dep);
    expect(r.resolvidos).toBe(0);
    expect(r.items[0].sku).toBe("100");
  });

  it("normaliza caixa e espaço na comparação", async () => {
    const { dep } = deps([prod("p1", "ABC123")]);
    const r = await resolverPorEtiqueta(ctx, rel(), [item("999", " abc123 ")], dep);
    expect(r.resolvidos).toBe(1);
    expect(r.items[0].sku).toBe("ABC123");
  });

  it("o relatório explica o que aconteceu", async () => {
    const { dep } = deps([prod("p1", "18593")]);
    const report = rel();
    await resolverPorEtiqueta(ctx, report, [item("999", "18593")], dep);
    expect(report.contadores.casados_pela_etiqueta).toBe(1);
    expect(report.avisos.some((a) => /ETIQUETA/.test(a.motivo))).toBe(true);
  });

  it("preserva localização e sucata do item ao reescrever o SKU", async () => {
    const { dep } = deps([prod("p1", "18593")]);
    const original: LinkPlanItem = {
      linha: 7,
      sku: "999",
      etiqueta: "18593",
      locationCode: "S1P1N1CX1",
      locationLabel: "S1 P1 N1 CX1",
      scrapKey: "V76",
    };
    const r = await resolverPorEtiqueta(ctx, rel(), [original], dep);
    expect(r.items[0]).toMatchObject({
      linha: 7,
      sku: "18593",
      locationCode: "S1P1N1CX1",
      locationLabel: "S1 P1 N1 CX1",
      scrapKey: "V76",
    });
  });
});
