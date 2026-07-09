import "dotenv/config";
import prisma from "@/app/lib/prisma";
import { toFullSizeMLImage, toFullSizeMLImages } from "@/app/lib/ml-image";

/**
 * Corrige o TAMANHO das imagens dos produtos criados a partir de anúncios do
 * Mercado Livre.
 *
 * Causa: `normalizeMLItem` gravava `item.thumbnail` (variante `-I`, ~100px) em
 * vez de `pictures[].secure_url` (variante `-O`, original). O bug já foi
 * corrigido no código; este script conserta as linhas JÁ gravadas.
 *
 * O CDN do ML expõe a mesma foto em tamanhos por sufixo, então a correção é uma
 * reescrita determinística da URL (`-I.jpg` -> `-O.jpg`) + https. NÃO chama a
 * API do Mercado Livre e NÃO baixa imagem alguma.
 *
 * Uso:
 *   tsx scripts/fix-ml-product-image-size.ts                 (dry-run, padrão)
 *   tsx scripts/fix-ml-product-image-size.ts --apply         (grava)
 *   tsx scripts/fix-ml-product-image-size.ts --user=<userId> (restringe ao dono)
 *
 * Salvaguardas:
 *  - Só toca produtos com `createdFromMarketplace = true` E
 *    `originPlatform = MERCADO_LIVRE` (ou seja, criados pelo import/auto-detecção).
 *    Fotos definidas à mão pelo lojista nunca são alteradas.
 *  - Só reescreve URLs do domínio `mlstatic.com`; qualquer outra origem passa batido.
 *  - Idempotente: rodar de novo não encontra nada (URLs `-O` já estão corretas).
 *  - Dry-run por padrão: sem `--apply` nada é gravado.
 */

const APPLY = process.argv.includes("--apply");
const userArg = process.argv.find((a) => a.startsWith("--user="));
const USER_ID = userArg ? userArg.slice("--user=".length) : undefined;

const PAGE_SIZE = 500;
const WRITE_CONCURRENCY = 20;

async function run() {
  const where = {
    createdFromMarketplace: true,
    originPlatform: "MERCADO_LIVRE" as const,
    imageUrl: { contains: "mlstatic" },
    ...(USER_ID ? { userId: USER_ID } : {}),
  };

  const total = await prisma.product.count({ where });
  console.log(
    `[fix-ml-image] candidatos (produtos ML com imagem do mlstatic): ${total}`,
  );
  console.log(`[fix-ml-image] modo: ${APPLY ? "APPLY (grava)" : "DRY-RUN"}`);
  if (USER_ID) console.log(`[fix-ml-image] restrito ao user ${USER_ID}`);

  let scanned = 0;
  let changed = 0;
  let unchanged = 0;
  const samples: string[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await prisma.product.findMany({
      where,
      // EGRESS: só as colunas necessárias.
      select: { id: true, imageUrl: true, imageUrls: true },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    const updates: { id: string; imageUrl: string; imageUrls: string[] }[] = [];
    for (const p of page) {
      scanned++;
      const nextUrl = toFullSizeMLImage(p.imageUrl);
      const nextUrls = toFullSizeMLImages(p.imageUrls);
      const urlChanged = !!nextUrl && nextUrl !== p.imageUrl;
      const urlsChanged =
        JSON.stringify(nextUrls) !== JSON.stringify(p.imageUrls ?? []);

      if (!urlChanged && !urlsChanged) {
        unchanged++;
        continue;
      }
      changed++;
      if (samples.length < 5 && urlChanged) {
        samples.push(`  ${p.imageUrl}\n    -> ${nextUrl}`);
      }
      updates.push({
        id: p.id,
        imageUrl: nextUrl as string,
        imageUrls: nextUrls,
      });
    }

    if (APPLY && updates.length > 0) {
      for (let i = 0; i < updates.length; i += WRITE_CONCURRENCY) {
        const slice = updates.slice(i, i + WRITE_CONCURRENCY);
        await Promise.all(
          slice.map((u) =>
            prisma.product.update({
              where: { id: u.id },
              data: { imageUrl: u.imageUrl, imageUrls: u.imageUrls },
            }),
          ),
        );
      }
    }

    console.log(
      `[fix-ml-image] ${scanned}/${total} varridos · ${changed} a corrigir · ${unchanged} já ok`,
    );
  }

  if (samples.length > 0) {
    console.log(`\n[fix-ml-image] amostra da reescrita:\n${samples.join("\n")}`);
  }
  console.log(
    `\n[fix-ml-image] FIM — varridos ${scanned}, ${APPLY ? "corrigidos" : "seriam corrigidos"} ${changed}, já ok ${unchanged}`,
  );
  if (!APPLY && changed > 0) {
    console.log(`[fix-ml-image] rode com --apply para gravar.`);
  }
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
