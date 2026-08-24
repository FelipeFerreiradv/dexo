import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { swapImageUrlReferences } from "../app/marketplaces/services/image-bg-swap";

// ──────────────────────────────────────────────────────────────────────────
// GUARDA DE DERIVA ENTRE O `where` DO PRISMA E O ÍNDICE COMPOSTO DA `Product`.
//
// A etapa 1 de `swapImageUrlReferences` troca a URL da foto no produto:
//
//   UPDATE "Product" SET "imageUrl" = $1, "updatedAt" = $2
//    WHERE "userId" = $3 AND "imageUrl" = $4
//
// Sem índice que cubra `imageUrl`, o Postgres escolhe algum índice de `userId`,
// carrega TODOS os produtos daquele cliente e filtra em memória — 59.602 linhas
// lidas para achar zero, no maior tenant. Em produção eram 75.497 chamadas em
// 25,6 dias, 21,91 ms e 7.542 páginas cada, e 97,2% delas não alteravam linha
// nenhuma. O índice que resolve é:
//
//   CREATE INDEX "Product_userId_imageUrl_idx" ON "Product" ("userId", "imageUrl");
//
// ⚠️ AO CONTRÁRIO DO ÍNDICE DA #298, ESTE NÃO É PARCIAL — é b-tree comum, e por
// isso o Prisma CONSEGUE declará-lo no schema. Isso cria uma obrigação a mais,
// que nenhum tipo cobre: as TRÊS declarações (schema.prisma, migration, ddl)
// precisam continuar idênticas, ou `prisma migrate diff` passa a acusar deriva
// para sempre.
//
// O MODO DE FALHA DO LADO DO CÓDIGO É SILENCIOSO. Tirar `userId` do `where`, ou
// trocar a igualdade de `imageUrl` por `contains`/`startsWith`/`in`, não quebra
// nada visível: o UPDATE continua alterando exatamente as mesmas linhas, nenhum
// teste de comportamento fica vermelho, nenhum erro aparece no log. Só o plano
// volta a varrer os produtos do cliente e a conta de banco sobe de novo, sem
// ninguém perceber por semanas.
//
// ⚠️ O QUE ESTE SPEC PROVA E O QUE NÃO PROVA. Prova que as pontas continuam
// escritas de forma casada. NÃO prova que o Postgres escolheu o índice — isso é
// decisão do planner e só se verifica no banco, com `EXPLAIN` ou com o
// `idx_scan` de pg_stat_user_indexes (consultas prontas no rodapé do arquivo de
// DDL).
// ──────────────────────────────────────────────────────────────────────────

const NOME_DO_INDICE = "Product_userId_imageUrl_idx";

const raiz = path.resolve(__dirname, "..");
const DDL = path.join(
  raiz,
  "prisma",
  "ddl",
  "2026-08-24-product-userid-imageurl-idx.sql",
);
const MIGRATION = path.join(
  raiz,
  "prisma",
  "migrations",
  "20260824190000_add_product_userid_imageurl_idx",
  "migration.sql",
);
const SCHEMA = path.join(raiz, "prisma", "schema.prisma");
const SERVICO = path.join(
  raiz,
  "app",
  "marketplaces",
  "services",
  "image-bg-swap.ts",
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

/**
 * As linhas de `@@index` do model Product, sem comentário.
 *
 * Extraído em função própria de propósito: se a regex morasse dentro de um
 * único teste, o teste que verifica a própria extração acabaria duplicando-a e
 * deixaria de guardar coisa alguma.
 */
function indicesDoModelProduct(): string[] {
  const texto = fs.readFileSync(SCHEMA, "utf8");
  const bloco = texto.match(/^model Product \{$([\s\S]*?)^\}$/m);
  if (!bloco) throw new Error("model Product não encontrado no schema.prisma");
  return bloco[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("@@index(") || l.startsWith("@@unique("));
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

async function whereDaEtapa1(): Promise<Record<string, unknown>> {
  const db = makeDb();
  await swapImageUrlReferences({
    userId: "u1",
    oldUrl: "http://test.local/uploads/a.webp",
    newUrl: "http://test.local/uploads/a.png",
    db,
  });
  const chamada = (
    db as unknown as {
      product: { updateMany: { mock: { calls: unknown[][] } } };
    }
  ).product.updateMany.mock.calls[0][0] as { where: Record<string, unknown> };
  return chamada.where;
}

describe("índice composto de Product: o `where` e o índice casam", () => {
  it("o `where` usa as DUAS colunas do índice, as duas por igualdade", async () => {
    const where = await whereDaEtapa1();

    // Escopo de tenant. Se isto sumir não é lentidão, é vazamento entre
    // clientes: o swap de um vendedor mexeria no produto de outro. É também a
    // coluna LÍDER do índice — sem ela o índice não serve.
    expect(where.userId).toBe("u1");

    // Igualdade crua, não objeto de operador. `{ contains: ... }`,
    // `{ startsWith: ... }` ou `{ in: [...] }` continuariam devolvendo o mesmo
    // resultado neste caso e fariam o Postgres abandonar a segunda coluna do
    // índice.
    expect(where.imageUrl).toBe("http://test.local/uploads/a.webp");
    expect(typeof where.imageUrl).toBe("string");

    // Nenhuma condição a mais: qualquer AND extra sobre coluna fora do índice
    // reintroduz o filtro em memória que este índice existe para eliminar.
    expect(Object.keys(where).sort()).toEqual(["imageUrl", "userId"]);
  });

  it("o schema declara o índice com as colunas NA ORDEM certa", () => {
    const indices = indicesDoModelProduct();

    // A ordem importa: `userId` primeiro. Invertido, o índice deixa de servir
    // como índice de tenant e passa a depender de a URL ser seletiva sozinha.
    expect(indices).toContain("@@index([userId, imageUrl])");
    expect(indices).not.toContain("@@index([imageUrl, userId])");
    expect(indices).not.toContain("@@index([imageUrl])");
  });

  it("a extração dos índices do schema realmente lê o model Product", () => {
    // Guarda-da-guarda: se `indicesDoModelProduct` passasse a ler o arquivo
    // inteiro (ou o model errado), o teste acima viraria decoração. Estes três
    // índices são de OUTROS models e não podem aparecer aqui.
    const indices = indicesDoModelProduct();
    expect(indices).toContain("@@index([userId, skuNormalized])");
    expect(indices).not.toContain("@@index([retryEnabled, updatedAt])");
    expect(indices.every((l) => !l.includes("imageUrlsOverride"))).toBe(true);
  });

  it("o DDL de produção declara o MESMO índice", () => {
    const sql = comandos(DDL);
    expect(sql).toContain(`"${NOME_DO_INDICE}"`);
    expect(sql).toContain('ON "Product" ("userId", "imageUrl")');
    // Idempotente: pode ser reaplicado sem quebrar.
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS");
    // Protege a tabela mais escrita do sistema de ficar presa atrás de outra
    // sessão enquanto segura ACCESS EXCLUSIVE.
    expect(sql).toContain("SET LOCAL lock_timeout");
  });

  it("a migration (banco limpo) declara o MESMO índice", () => {
    const sql = comandos(MIGRATION);
    expect(sql).toContain(`"${NOME_DO_INDICE}"`);
    expect(sql).toContain('ON "Product" ("userId", "imageUrl")');
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS");
  });

  it("o índice NÃO virou parcial nem ganhou INCLUDE", () => {
    // Parcial economizaria ~3% (11.376 dos 366.259 produtos têm `imageUrl`
    // nulo) e criaria divergência permanente com o schema, porque o Prisma não
    // expressa cláusula WHERE em índice.
    //
    // INCLUDE de coluna de array estouraria o teto de ~2.700 bytes da entrada
    // de btree e transformaria um INSERT grande em FALHA de escrita.
    for (const arquivo of [DDL, MIGRATION]) {
      const sql = comandos(arquivo);
      const criacao = sql.slice(sql.indexOf("CREATE INDEX"));
      expect(criacao).not.toMatch(/\bWHERE\b/i);
      expect(criacao).not.toMatch(/\bINCLUDE\b/i);
      // CONCURRENTLY não roda dentro de transação, e os dois arquivos rodam
      // dentro de uma.
      expect(criacao).not.toMatch(/\bCONCURRENTLY\b/i);
    }
  });

  it("o comentário do serviço aponta para o índice pelo nome", () => {
    // Quem for mexer no `where` precisa esbarrar na explicação antes.
    const fonte = fs.readFileSync(SERVICO, "utf8");
    expect(fonte).toContain(NOME_DO_INDICE);
    expect(fonte).toContain("2026-08-24-product-userid-imageurl-idx.sql");
  });

  it("a etapa 2 continua SEM índice e o código diz por quê", () => {
    // A etapa 2 usa `= ANY(array)`, que não aproveita GIN — precisaria virar
    // `@>`, ou seja mudança de código, com custo de escrita não medido. Se
    // alguém adicionar um índice para ela sem medir, este teste avisa que a
    // justificativa registrada ficou desatualizada.
    const fonte = fs.readFileSync(SERVICO, "utf8");
    expect(fonte).toContain('= ANY("imageUrls")');
    expect(fonte).toContain("NÃO foi medido");

    const indices = indicesDoModelProduct();
    expect(indices.every((l) => !l.includes("imageUrls"))).toBe(true);
  });

  it("as três etapas seguem sendo disparadas, na mesma ordem", async () => {
    // Controle de não-regressão: o índice é aditivo e não pode ter mexido no
    // que o swap faz.
    const db = makeDb();
    const contas = await swapImageUrlReferences({
      userId: "u1",
      oldUrl: "http://test.local/uploads/a.webp",
      newUrl: "http://test.local/uploads/a.png",
      db,
    });

    const d = db as unknown as {
      product: { updateMany: { mock: { calls: unknown[][] } } };
      $executeRaw: { mock: { calls: unknown[][] } };
      productListing: { findMany: { mock: { calls: unknown[][] } } };
    };

    expect(d.product.updateMany.mock.calls).toHaveLength(1);
    expect(d.$executeRaw.mock.calls).toHaveLength(2); // Product.imageUrls + Scrap.imageUrls
    expect(d.productListing.findMany.mock.calls).toHaveLength(1);
    expect(contas).toEqual({
      productImageUrl: 0,
      productImageUrls: 0,
      scrapImageUrls: 0,
      listingOverrides: 0,
    });
  });
});
