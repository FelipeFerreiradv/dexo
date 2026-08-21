import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";

import { swapImageUrlReferences } from "../app/marketplaces/services/image-bg-swap";

// ──────────────────────────────────────────────────────────────────────────
// GUARDA DE DERIVA ENTRE O FILTRO DO PRISMA E O PREDICADO DO ÍNDICE PARCIAL.
//
// `swapImageUrlReferences` procura os anúncios com override de imagem para
// trocar a URL antiga pela nova depois do recorte de fundo. Em produção são
// 919 linhas que passam pelo filtro, em 381.308 — 0,24%. Sem índice, essa
// busca varria a tabela inteira: 155 ms e 17.831 páginas por chamada, 68 mil
// chamadas em 28,7 dias (1h48min de tempo de banco).
//
// O índice que resolve isso é PARCIAL e vive fora do schema, porque Prisma não
// expressa cláusula WHERE em índice:
//
//   CREATE INDEX "ProductListing_productId_imageUrlsOverride_idx"
//     ON "ProductListing" ("productId")
//     WHERE "imageUrlsOverride" IS NOT NULL;
//
// O Postgres só usa índice parcial quando consegue PROVAR que o predicado dele
// é implicado pelo WHERE da consulta. Quem produz essa prova é uma única linha
// de TypeScript: `imageUrlsOverride: { not: Prisma.DbNull }`, que faz o Prisma
// emitir literalmente `"imageUrlsOverride" IS NOT NULL`.
//
// O MODO DE FALHA É SILENCIOSO. Trocar aquele filtro — por `Prisma.JsonNull`,
// por um `AND` a mais, por qualquer reescrita — não quebra nada visível: a
// consulta continua devolvendo as mesmas linhas, nenhum teste de comportamento
// fica vermelho, nenhum erro aparece no log. Só o plano volta a varrer a tabela
// e a conta de banco volta a subir, sem ninguém perceber por semanas.
//
// ⚠️ O QUE ESTE SPEC PROVA E O QUE NÃO PROVA. Ele prova que as duas pontas
// continuam escritas de forma casada. Ele NÃO prova que o Postgres escolheu o
// índice — isso é decisão do planner e só se verifica no banco, com
// `EXPLAIN` ou com o `idx_scan` de pg_stat_user_indexes (as duas consultas
// estão no rodapé do arquivo de DDL). Aqui o teste estrutural é a ferramenta
// certa justamente porque o acoplamento atravessa duas linguagens e nenhum
// tipo o cobre.
// ──────────────────────────────────────────────────────────────────────────

const NOME_DO_INDICE = "ProductListing_productId_imageUrlsOverride_idx";
const PREDICADO = '"imageUrlsOverride" IS NOT NULL';

const DDL = path.resolve(
  __dirname,
  "..",
  "prisma",
  "ddl",
  "2026-08-21-product-listing-image-urls-override-idx.sql",
);
const MIGRATION = path.resolve(
  __dirname,
  "..",
  "prisma",
  "migrations",
  "20260821180000_add_product_listing_image_urls_override_idx",
  "migration.sql",
);

/** Só os comandos executáveis: joga fora comentário e normaliza espaço. */
function comandos(arquivo: string): string {
  return fs
    .readFileSync(arquivo, "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

function makeDb() {
  return {
    product: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $executeRaw: vi.fn().mockResolvedValue(0),
    productListing: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  } as never;
}

describe("índice parcial de imageUrlsOverride: o filtro e o predicado casam", () => {
  it("o filtro enviado ao banco é exatamente o que gera `IS NOT NULL`", async () => {
    const db = makeDb();
    await swapImageUrlReferences({
      userId: "u1",
      oldUrl: "http://test.local/uploads/a.webp",
      newUrl: "http://test.local/uploads/a.png",
      db,
    });

    const chamada = (db as unknown as { productListing: { findMany: { mock: { calls: unknown[][] } } } })
      .productListing.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };

    // Escopo de tenant — se isto sumir não é lentidão, é vazamento entre
    // clientes: o swap de um vendedor mexeria no anúncio de outro.
    expect(chamada.where.product).toEqual({ userId: "u1" });

    // `DbNull` = NULL do SQL. `JsonNull` = o valor JSON `null`, que é outra
    // coisa e não produz `IS NOT NULL`. A identidade (toBe) é o ponto: não
    // basta ser "um nulo do Prisma", tem de ser ESTE.
    expect(chamada.where.imageUrlsOverride).toEqual({ not: Prisma.DbNull });
    expect(
      (chamada.where.imageUrlsOverride as { not: unknown }).not,
    ).toBe(Prisma.DbNull);

    // Nenhuma condição a mais: qualquer AND extra restringe a consulta sem
    // restringir o índice, e o predicado deixa de casar de forma óbvia.
    expect(Object.keys(chamada.where).sort()).toEqual([
      "imageUrlsOverride",
      "product",
    ]);
  });

  it("o DDL de produção declara o índice com esse predicado", () => {
    const sql = comandos(DDL);
    expect(sql).toContain(`"${NOME_DO_INDICE}"`);
    expect(sql).toContain('ON "ProductListing" ("productId")');
    expect(sql).toContain(`WHERE ${PREDICADO}`);
    // Idempotente: este arquivo pode ser reaplicado sem quebrar.
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS");
  });

  it("o predicado não foi 'melhorado' para excluir o JSON `null`", () => {
    // Hoje 918 das 919 linhas que passam pelo filtro guardam o literal JSON
    // `null` (herança de "limpar o override", que grava `null` do JavaScript
    // numa coluna Json). Sabendo disso, a tentação óbvia é apertar o predicado
    // para deixar o lixo de fora — e isso INUTILIZA o índice: o Postgres só usa
    // índice parcial quando PROVA que o predicado é implicado pelo WHERE da
    // consulta, e a consulta só diz `IS NOT NULL`. Predicado mais estreito não
    // é implicado por um WHERE mais largo: o planner volta ao Seq Scan, em
    // silêncio, sem erro nenhum.
    for (const arquivo of [DDL, MIGRATION]) {
      const sql = comandos(arquivo);
      expect(sql).not.toMatch(/'null'::jsonb/);
      expect(sql).not.toMatch(/jsonb_typeof/);
      // O predicado tem de terminar aí: nada de AND depois. (`PREDICADO` não
      // tem metacaractere de regex — são aspas, letras e espaços.)
      expect(sql).toMatch(new RegExp(`WHERE ${PREDICADO}\\s*;`));
    }
  });

  it("a migration (banco limpo) declara o MESMO índice", () => {
    const sql = comandos(MIGRATION);
    expect(sql).toContain(`"${NOME_DO_INDICE}"`);
    expect(sql).toContain('ON "ProductListing" ("productId")');
    expect(sql).toContain(`WHERE ${PREDICADO}`);

    // `migrate` roda a migration DENTRO de uma transação, e o Postgres recusa
    // CREATE INDEX CONCURRENTLY em transação. Se alguém "melhorar" isto para
    // CONCURRENTLY, todo banco novo passa a falhar na migração.
    expect(sql).not.toMatch(/CONCURRENTLY/i);
  });

  it("o índice não carrega o JSON no INCLUDE (limite de tamanho do btree)", () => {
    // Um `INCLUDE ("imageUrlsOverride")` tornaria a leitura index-only e
    // pouparia mais algumas páginas. Não vale: o valor é um JSON de tamanho
    // livre e a entrada de btree tem teto de ~2.700 bytes. No dia em que um
    // vendedor salvasse um override com fotos demais, o INSERT/UPDATE daquele
    // anúncio passaria a FALHAR. Ganho de leitura não paga falha de escrita.
    for (const arquivo of [DDL, MIGRATION]) {
      expect(comandos(arquivo)).not.toMatch(/INCLUDE\s*\(/i);
    }
  });

  it("o comentário do código aponta para o índice pelo nome", () => {
    // O aviso só serve se o mantenedor conseguir achar o índice a partir dele.
    const fonte = fs.readFileSync(
      path.resolve(
        __dirname,
        "..",
        "app",
        "marketplaces",
        "services",
        "image-bg-swap.ts",
      ),
      "utf8",
    );
    expect(fonte).toContain(NOME_DO_INDICE);
  });
});
