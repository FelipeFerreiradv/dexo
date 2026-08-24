/**
 * Swap de referências de imagem (recorte assíncrono, PR 4).
 *
 * Quando o worker conclui um recorte, o produto pode JÁ ter sido salvo com a
 * URL da WebP otimizada (decisão do Felipe: salvar nunca espera o recorte).
 * Este módulo troca a URL antiga pela nova em TODOS os lugares que guardam
 * URLs de imagem, de forma idempotente e escopada pelo tenant:
 *
 *  - Product.imageUrl   (updateMany simples)
 *  - Product.imageUrls  (String[] — array_replace via SQL cru; Prisma não
 *                        tem update de elemento de lista escalar)
 *  - Scrap.imageUrls    (idem)
 *  - ProductListing.imageUrlsOverride (Json — read-modify-write best-effort,
 *                        escopado via Product.userId)
 *
 * NUNCA passa por ProductUseCase.update: aquele caminho dispara sync de
 * anúncio nos marketplaces — trocar a foto local não pode republicar nada.
 *
 * Idempotente por construção (WHERE pela URL antiga): rodar de novo depois
 * que nada mais referencia a URL antiga é no-op — é o que permite as
 * varreduras extras (+2min/+10min) cobrirem a corrida save-vs-complete.
 *
 * ── CUSTO MEDIDO EM PRODUÇÃO (pg_stat_statements, janela de 28,69 dias) ────
 *
 * Este é o caminho mais caro do banco inteiro. As quatro etapas rodam sempre
 * juntas — as 68.211 chamadas idênticas confirmam isso — e o total passa de
 * 2h40min de tempo de banco por mês. Cada recorte dispara o swap 3x (o
 * imediato mais as duas varreduras de segurança do worker), então são ~22,7
 * mil recortes, ~790 por dia.
 *
 *   etapa                              chamadas    linhas     tempo    média
 *   ────────────────────────────────   ─────────   ────────   ──────   ──────
 *   4. SELECT anúncios c/ override        68.211  1.806.535  6.507,9s  95,4ms
 *   2. UPDATE Product.imageUrls           68.211     13.423  1.787,2s  26,2ms
 *   1. UPDATE Product.imageUrl            68.211      1.937  1.387,7s  20,3ms
 *   3. UPDATE Scrap.imageUrls             68.211         33      3,5s  0,05ms
 *
 * A ETAPA 4 é a que o índice parcial resolve (ver a nota no `findMany` abaixo):
 * ~95ms -> ~7,6ms.
 *
 * ⚠️ SOBRE AS 919 LINHAS QUE A ETAPA 4 CARREGA: só UMA delas tem de fato um
 * array de imagens. As outras 918 guardam o literal JSON `null`, que em SQL
 * NÃO é nulo e por isso casa com `IS NOT NULL`. A origem é "limpar o
 * override": o caminho de edição grava `null` do JavaScript numa coluna Json,
 * e isso vira o literal JSON `null` em vez de `NULL` do SQL. A mesma marca
 * está em `attributesOverride` (626 JSON null contra 3 valores reais), e o
 * volume cresce (664 linhas em agosto, 187 em julho).
 *
 * Na LEITURA é inofensivo: o Prisma devolve `null` do JavaScript nos dois
 * casos, e o laço abaixo faz `Array.isArray` antes de usar — as 918 caem no
 * `continue`. É desperdício, não bug de comportamento.
 *
 * Corrigir isso (gravar `Prisma.DbNull` e converter o passivo) é entrega
 * própria, e NÃO é pré-requisito do índice: sem índice, tirar as 918 linhas
 * não mudaria nada, porque o custo é ENCONTRAR as linhas, não devolvê-las.
 *
 * A ETAPA 1 FOI RESOLVIDA DEPOIS, e a etapa 2 NÃO. As duas pareciam o mesmo
 * problema; não são.
 *
 * A etapa 1 é IGUALDADE PURA (`"imageUrl" = $4`), que é o caso canônico de
 * b-tree composto. Ganhou `@@index([userId, imageUrl])` — ver
 * prisma/ddl/2026-08-24-product-userid-imageurl-idx.sql. Medido em transação
 * desfeita contra produção: 50,09ms/25.541 páginas -> 0,101ms/4 páginas.
 *
 * A etapa 2 usa `$4 = ANY("imageUrls")`, e isso NÃO aproveita índice GIN: para
 * aproveitar, a consulta teria de virar `"imageUrls" @> ARRAY[$4]`. Ou seja,
 * mudança de índice E de código, com custo de escrita de um GIN sobre 1.822.813
 * elementos de array na tabela mais escrita do sistema (517 MB de dados, 384 MB
 * de índices) — custo que NÃO foi medido. Enquanto não for, mexer ali é trocar
 * uma lentidão conhecida por um risco desconhecido. A etapa 3 mostra que a
 * forma da consulta não é o problema: idêntica, na tabela pequena, custa
 * 0,05ms.
 *
 * A etapa 3 não tem o que otimizar: 3,5 segundos no mês inteiro.
 */

import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";

export interface SwapCounts {
  productImageUrl: number;
  productImageUrls: number;
  scrapImageUrls: number;
  listingOverrides: number;
}

export async function swapImageUrlReferences(input: {
  userId: string;
  oldUrl: string;
  newUrl: string;
  /** Override para testes. */
  db?: typeof prisma;
}): Promise<SwapCounts> {
  const db = input.db ?? prisma;
  const { userId, oldUrl, newUrl } = input;

  // ⚠️ ESTE `where` ESTÁ CASADO COM UM ÍNDICE COMPOSTO NO BANCO:
  //
  //   CREATE INDEX "Product_userId_imageUrl_idx" ON "Product" ("userId", "imageUrl");
  //
  // (declarado em prisma/schema.prisma como @@index([userId, imageUrl]);
  // análise em prisma/ddl/2026-08-24-product-userid-imageurl-idx.sql)
  //
  // As DUAS colunas precisam continuar aqui como IGUALDADE. Tirar `userId`, ou
  // trocar `imageUrl` por `contains`/`startsWith`/`in`, faz o Postgres voltar a
  // ler todos os produtos do cliente e filtrar em memória — 59.602 linhas para
  // achar zero, no maior tenant. E o modo de falha é SILENCIOSO: continua
  // devolvendo o mesmo resultado, nenhum teste de comportamento fica vermelho,
  // só a conta de banco sobe de novo. Guarda em tests/image-bg-swap-product-index.spec.ts.
  const productImageUrl = (
    await db.product.updateMany({
      where: { userId, imageUrl: oldUrl },
      data: { imageUrl: newUrl },
    })
  ).count;

  const productImageUrls = await db.$executeRaw`
    UPDATE "Product"
       SET "imageUrls" = array_replace("imageUrls", ${oldUrl}, ${newUrl})
     WHERE "userId" = ${userId}
       AND ${oldUrl} = ANY("imageUrls")`;

  const scrapImageUrls = await db.$executeRaw`
    UPDATE "Scrap"
       SET "imageUrls" = array_replace("imageUrls", ${oldUrl}, ${newUrl})
     WHERE "userId" = ${userId}
       AND ${oldUrl} = ANY("imageUrls")`;

  // Overrides por anúncio (Json): raros e pequenos — read-modify-write.
  // Escopo de tenant via o produto dono do listing.
  //
  // ⚠️ ESTE `where` ESTÁ CASADO COM UM ÍNDICE PARCIAL NO BANCO. Não é
  // coincidência de escrita: o índice é
  //
  //   CREATE INDEX "ProductListing_productId_imageUrlsOverride_idx"
  //     ON "ProductListing" ("productId")
  //     WHERE "imageUrlsOverride" IS NOT NULL;
  //
  // (prisma/ddl/2026-08-21-product-listing-image-urls-override-idx.sql —
  // Prisma não expressa índice parcial no schema.)
  //
  // O Postgres só usa um índice parcial quando consegue PROVAR que o predicado
  // dele é implicado pelo WHERE da consulta. `{ not: Prisma.DbNull }` é o que
  // faz o Prisma emitir literalmente `"imageUrlsOverride" IS NOT NULL` — a
  // prova sai de graça. Qualquer outra forma de escrever "tem override" muda o
  // SQL gerado e o índice deixa de ser elegível: `Prisma.JsonNull` filtra o
  // valor JSON `null`, que é outra coisa, e não produz `IS NOT NULL`.
  //
  // O que torna isso perigoso é o SILÊNCIO. Trocar este filtro não quebra
  // nada: a consulta continua devolvendo as mesmas linhas e todo teste continua
  // verde. Só o plano volta a varrer os 381 mil anúncios para achar as 919 que
  // passam — de ~7,6 ms para ~155 ms por chamada, 68 mil chamadas por mês.
  //
  // ⚠️ Pelo mesmo motivo, NÃO aperte o predicado do índice para excluir o
  // literal JSON `null` (que hoje ocupa 918 das 919 linhas — ver o cabeçalho
  // deste arquivo). Predicado mais estreito não é implicado por um WHERE mais
  // largo, e o planner abandona o índice sem avisar.
  //
  // Guardado por tests/image-bg-swap-partial-index.spec.ts. Em produção, o
  // sinal de que o casamento quebrou é `idx_scan` parado em
  // pg_stat_user_indexes para esse índice.
  let listingOverrides = 0;
  const listings = await db.productListing.findMany({
    where: {
      product: { userId },
      // Filtro grosso no banco (só quem tem override); refinamento em JS.
      imageUrlsOverride: { not: Prisma.DbNull },
    },
    select: { id: true, imageUrlsOverride: true },
  });
  for (const l of listings) {
    const arr = l.imageUrlsOverride;
    if (!Array.isArray(arr) || !arr.includes(oldUrl)) continue;
    const next = arr.map((u) => (u === oldUrl ? newUrl : u));
    // CAS pelo valor lido: se o usuário editou o override entre o findMany e
    // este update (o sweep roda até ~12min depois), NÃO sobrescrevemos a
    // edição — o próximo sweep relê e tenta de novo se ainda houver a URL.
    const updated = await db.productListing.updateMany({
      where: { id: l.id, imageUrlsOverride: { equals: arr } },
      data: { imageUrlsOverride: next },
    });
    listingOverrides += updated.count;
  }

  return { productImageUrl, productImageUrls, scrapImageUrls, listingOverrides };
}
