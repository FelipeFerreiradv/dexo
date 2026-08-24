import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { swapImageUrlReferences } from "../app/marketplaces/services/image-bg-swap";

// ──────────────────────────────────────────────────────────────────────────
// GUARDA DA DUPLA: O ÍNDICE GIN E A CONDIÇÃO `@>` SÓ VALEM JUNTOS.
//
// A etapa 2 de `swapImageUrlReferences` troca a URL antiga na galeria do
// produto. `$4 = ANY("imageUrls")` é um ScalarArrayOpExpr sobre uma COLUNA, e
// nenhuma classe de operador do GIN o atende — ou seja, o índice sozinho não
// faz nada. Isso foi MEDIDO em produção: com o GIN criado e a consulta antiga,
// o plano continuou varrendo 59.607 produtos em 99 ms.
//
// Quem torna a busca indexável é uma única linha de SQL:
//
//   AND "imageUrls" @> ARRAY[${oldUrl}]
//
// O MODO DE FALHA É SILENCIOSO NOS DOIS SENTIDOS:
//
//  · tirar o `@>` do código deixa 244 MB de índice sem nenhum uso, e a consulta
//    volta a 89 ms sem que nada fique vermelho;
//  · tirar o índice deixa o `@>` sendo avaliado à toa em cada linha.
//
// Por isso as duas pontas são verificadas aqui juntas.
//
// ⚠️ O `= ANY` FOI MANTIDO DE PROPÓSITO, e este spec exige que ele continue.
// As duas condições são equivalentes para `oldUrl` não-nulo — verificado no
// banco, linha a linha nos 366.343 produtos, com zero divergências — então
// manter as duas faz a mudança de predicado ser estritamente não-restritiva.
// O `= ANY` vira o `Filter` de recheck do Bitmap Heap Scan e custa nada,
// porque os candidatos são ~0.
//
// ⚠️ O QUE ESTE SPEC NÃO PROVA: que o Postgres escolheu o índice. Isso é
// decisão do planner e só se verifica no banco. As consultas de `EXPLAIN` e de
// `idx_scan` estão no rodapé do arquivo de DDL.
// ──────────────────────────────────────────────────────────────────────────

const NOME_DO_INDICE = "Product_imageUrls_idx";

const raiz = path.resolve(__dirname, "..");
const DDL = path.join(
  raiz,
  "prisma",
  "ddl",
  "2026-08-24-product-imageurls-gin.sql",
);
const MIGRATION = path.join(
  raiz,
  "prisma",
  "migrations",
  "20260824230000_add_product_imageurls_gin",
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

const OLD = "http://test.local/uploads/aaa.webp";
const NEW = "http://test.local/uploads/aaa.png";

/** As duas chamadas de SQL cru, separadas por tabela. */
async function sqlCru() {
  const db = makeDb();
  await swapImageUrlReferences({ userId: "u1", oldUrl: OLD, newUrl: NEW, db });

  const calls = (
    db as unknown as { $executeRaw: { mock: { calls: unknown[][] } } }
  ).$executeRaw.mock.calls;

  const porTabela = calls.map((c) => {
    const strings = c[0] as unknown as TemplateStringsArray;
    return { sql: strings.join("?"), valores: c.slice(1) };
  });

  return {
    produto: porTabela.find((q) => q.sql.includes('"Product"'))!,
    sucata: porTabela.find((q) => q.sql.includes('"Scrap"'))!,
  };
}

describe("índice GIN de imageUrls: o `@>` e o índice andam juntos", () => {
  it("a consulta do PRODUTO tem o `@>` — sem ele o índice não é usado", async () => {
    const { produto } = await sqlCru();

    expect(produto.sql).toContain('"imageUrls" @> ARRAY[?]');
    // O parâmetro do `@>` é a URL ANTIGA, não a nova. Trocar isso faria a
    // busca procurar por uma URL que ainda não existe em lugar nenhum e o
    // swap viraria no-op — silenciosamente.
    expect(produto.valores).toEqual([OLD, NEW, "u1", OLD, OLD]);
  });

  it("o `= ANY` continua lá: a mudança de predicado é não-restritiva", async () => {
    const { produto } = await sqlCru();
    expect(produto.sql).toContain('= ANY("imageUrls")');
    // `&&` (sobreposição) coincidiria com `@>` para um elemento, mas muda de
    // significado com mais de um. Não é a mesma coisa.
    expect(produto.sql).not.toContain("&&");
  });

  it("a SUCATA fica INTOCADA — tabela pequena, 0,05 ms, não precisa", async () => {
    const { sucata } = await sqlCru();
    expect(sucata.sql).toContain('= ANY("imageUrls")');
    expect(sucata.sql).not.toContain("@>");
    expect(sucata.valores).toEqual([OLD, NEW, "u1", OLD]);
  });

  it("as duas consultas continuam escopadas por tenant", async () => {
    const { produto, sucata } = await sqlCru();
    // Se isto sumir não é lentidão, é vazamento entre clientes.
    for (const q of [produto, sucata]) {
      expect(q.sql).toContain('"userId" = ?');
      expect(q.valores).toContain("u1");
    }
  });

  it("o schema declara o índice como GIN", () => {
    const bloco = fs
      .readFileSync(SCHEMA, "utf8")
      .match(/^model Product \{$([\s\S]*?)^\}$/m);
    if (!bloco) throw new Error("model Product não encontrado");
    const indices = bloco[1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("@@index("));

    expect(indices).toContain("@@index([imageUrls], type: Gin)");
    // Um btree comum sobre a coluna de array não serve para containment.
    expect(indices).not.toContain("@@index([imageUrls])");
  });

  it("o DDL de produção usa CONCURRENTLY e fastupdate=off", () => {
    const sql = comandos(DDL);
    expect(sql).toContain(`"${NOME_DO_INDICE}"`);
    expect(sql).toContain('USING gin ("imageUrls")');
    // O build leva ~25 s e ACCESS EXCLUSIVE bloqueia até LEITURA. Sem
    // CONCURRENTLY isso é apagão, não enfileiramento.
    expect(sql).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS");
    // Sem lista pendente: custo previsível em vez de pico numa transação
    // azarada.
    expect(sql).toMatch(/fastupdate\s*=\s*off/);
    // CONCURRENTLY não roda em transação — este arquivo não pode ter BEGIN.
    expect(sql).not.toMatch(/\bBEGIN\b/i);
  });

  it("a migration (banco limpo) declara o MESMO índice, e SEM concurrently", () => {
    const sql = comandos(MIGRATION);
    expect(sql).toContain(`"${NOME_DO_INDICE}"`);
    expect(sql).toContain('USING gin ("imageUrls")');
    expect(sql).toMatch(/fastupdate\s*=\s*off/);
    // `migrate` roda a migration dentro de uma transação, onde CONCURRENTLY é
    // proibido. Se alguém colocar, a migration passa a FALHAR.
    expect(sql).not.toMatch(/\bCONCURRENTLY\b/i);
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS");
  });

  it("o comentário do serviço aponta o índice pelo nome e o arquivo de DDL", () => {
    const fonte = fs.readFileSync(SERVICO, "utf8");
    expect(fonte).toContain(NOME_DO_INDICE);
    expect(fonte).toContain("2026-08-24-product-imageurls-gin.sql");
  });

  it("as três etapas seguem sendo disparadas, na mesma ordem", async () => {
    // Controle de não-regressão: o que o swap FAZ não pode ter mudado.
    const db = makeDb();
    const contas = await swapImageUrlReferences({
      userId: "u1",
      oldUrl: OLD,
      newUrl: NEW,
      db,
    });

    const d = db as unknown as {
      product: { updateMany: { mock: { calls: unknown[][] } } };
      $executeRaw: { mock: { calls: unknown[][] } };
      productListing: { findMany: { mock: { calls: unknown[][] } } };
    };

    expect(d.product.updateMany.mock.calls).toHaveLength(1);
    expect(d.$executeRaw.mock.calls).toHaveLength(2);
    expect(d.productListing.findMany.mock.calls).toHaveLength(1);
    expect(contas).toEqual({
      productImageUrl: 0,
      productImageUrls: 0,
      scrapImageUrls: 0,
      listingOverrides: 0,
    });
  });
});
