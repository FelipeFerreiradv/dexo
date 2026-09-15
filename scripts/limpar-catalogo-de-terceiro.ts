/**
 * Limpeza de catálogo de terceiro — remove produtos DENTRO da Dexo sem tocar
 * nos anúncios do marketplace, e grava cada anúncio na lista de ignorados da
 * ingestão (ListingIngestionIgnore) para que a varredura NÃO os recrie.
 *
 * O CASO QUE MOTIVOU (Ducelo, 15/09/2026): pai e filho dividiam o mesmo
 * estoque e a MESMA conta de Mercado Livre. O botão "Importar anúncios" criou
 * no tenant do filho ~4.5 mil produtos que são do catálogo do PAI. A ordem do
 * cliente: "excluir da Dexo, mas NÃO excluir os anúncios — senão o meu pai
 * perde venda". Por isso:
 *   - ⛔ NUNCA usar ProductUseCase.bulkDelete aqui: ele ENCERRA o anúncio no
 *     marketplace antes de apagar (product.usercase.ts:479→532-573) — o
 *     oposto exato do pedido (10.567 anúncios seriam fechados).
 *   - ⛔ NUNCA chamar API de marketplace neste script. Zero. Nem leitura.
 *   - A recriação é bloqueada pela lista, não pela sorte: no MK2, 998 limpos
 *     viraram 1.934 em UM dia porque a lista não existia.
 *
 * USO (tsx DIRETO — `npm run` engole as flags, inclusive --apply):
 *   npx tsx scripts/limpar-catalogo-de-terceiro.ts \
 *     --user-email=desmanchetijucopreto@gmail.com \
 *     --ids-file=scripts/data/limpeza/alvo-pai-celao.txt \
 *     --reason=pai-celao-2026-09 \
 *     [--lote=200] [--apply --confirmar]
 *
 * Dry-run por padrão. `--apply` exige `--confirmar`. Idempotente: produto já
 * ausente conta como "ja_removido"; anúncio já na lista não duplica (upsert na
 * unique). Relatório JSON em scripts/out/.
 *
 * RE-VERIFICAÇÃO EM RUNTIME (o arquivo de ids é decisão, não passaporte):
 *   - o produto pertence ao tenant informado;
 *   - nasceu de anúncio: createdFromMarketplace OU sku sintético (VAAPT-/ML-/
 *     SHP-/MGL-) — os 571 restaurados em 15/09 não carregam a flag, por isso
 *     o critério é a UNIÃO, nunca só a flag;
 *   - SEM OrderItem, SEM NfeItem, SEM ReceivableItem, SEM BudgetItem — quem
 *     tem histórico de negócio é PULADO e listado (fusão, não exclusão).
 * StockLog do produto é apagado junto (RESTRICT impediria o delete; é
 * histórico de movimentação de um produto que está saindo do catálogo, sem
 * nenhuma venda — os com venda nem chegam aqui).
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import prisma from "@/app/lib/prisma";

const argv = process.argv.slice(2);
const flag = (nome: string) => argv.includes(`--${nome}`);
const valor = (nome: string) => {
  const hit = argv.find((a) => a.startsWith(`--${nome}=`));
  return hit ? hit.slice(nome.length + 3) : undefined;
};

const CONHECIDAS = new Set([
  "user-email",
  "ids-file",
  "reason",
  "lote",
  "apply",
  "confirmar",
]);
for (const a of argv) {
  const nome = a.replace(/^--/, "").split("=")[0];
  if (!CONHECIDAS.has(nome)) {
    console.error(`Flag desconhecida: --${nome} — abortando (typo vira apply global).`);
    process.exit(2);
  }
}

const userEmail = valor("user-email");
const idsFile = valor("ids-file");
const reason = valor("reason");
const lote = Math.min(Math.max(parseInt(valor("lote") ?? "200", 10) || 200, 10), 500);
const apply = flag("apply") && flag("confirmar");

if (!userEmail || !idsFile || !reason) {
  console.error("Obrigatórias: --user-email= --ids-file= --reason=");
  process.exit(2);
}
if (flag("apply") && !flag("confirmar")) {
  console.error("--apply exige --confirmar. Rodando como DRY-RUN.");
}

function assertBanco() {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "";
  if (!host) throw new Error("DATABASE_URL ausente ou ilegível — abortando.");
  if (apply && !host.includes("sa-east-1")) {
    throw new Error(
      `--apply bloqueado: host "${host}" não é sa-east-1 (produção São Paulo).`,
    );
  }
  console.log(`[preflight] banco=${host} modo=${apply ? "APPLY" : "dry-run"}`);
}

const NASCEU_DE_ANUNCIO = (p: { createdFromMarketplace: boolean; sku: string }) =>
  p.createdFromMarketplace ||
  /^(VAAPT-|ML-|SHP-|MGL-)/.test(p.sku);

async function main() {
  assertBanco();

  const user = await prisma.user.findUnique({
    where: { email: userEmail },
    select: { id: true, email: true, parentUserId: true },
  });
  if (!user) throw new Error(`Usuário ${userEmail} não encontrado.`);
  const dataOwnerId = user.parentUserId ?? user.id;
  console.log(`[preflight] tenant=${user.email} dataOwner=${dataOwnerId} reason=${reason}`);

  const ids = fs
    .readFileSync(idsFile!, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  console.log(`[preflight] ids no arquivo: ${ids.length} (lotes de ${lote})`);

  const sum = {
    modo: apply ? "APPLY" : "dry-run",
    tenant: dataOwnerId,
    reason,
    idsNoArquivo: ids.length,
    removidos: 0,
    anunciosNaListaDeIgnorados: 0,
    jaRemovidos: 0,
    puladosTenantErrado: 0,
    puladosNaoNasceuDeAnuncio: 0,
    puladosComHistorico: 0,
    erros: 0,
    detalhesPulados: [] as Array<Record<string, unknown>>,
    amostra: [] as Array<Record<string, unknown>>,
  };

  for (let i = 0; i < ids.length; i += lote) {
    const fatia = ids.slice(i, i + lote);
    const produtos = await prisma.product.findMany({
      where: { id: { in: fatia } },
      select: {
        id: true,
        userId: true,
        sku: true,
        name: true,
        stock: true,
        createdFromMarketplace: true,
        listings: {
          select: {
            id: true,
            externalListingId: true,
            marketplaceAccount: { select: { platform: true } },
          },
        },
        _count: {
          select: {
            orderItems: true,
            nfeItens: true,
            receivableItems: true,
            budgetItems: true,
          },
        },
      },
    });
    const porId = new Map(produtos.map((p) => [p.id, p]));

    for (const id of fatia) {
      const p = porId.get(id);
      if (!p) {
        sum.jaRemovidos++;
        continue;
      }
      if (p.userId !== dataOwnerId) {
        sum.puladosTenantErrado++;
        sum.detalhesPulados.push({ id, motivo: "tenant_errado", userId: p.userId });
        continue;
      }
      if (!NASCEU_DE_ANUNCIO(p)) {
        sum.puladosNaoNasceuDeAnuncio++;
        sum.detalhesPulados.push({ id, sku: p.sku, motivo: "nao_nasceu_de_anuncio" });
        continue;
      }
      const c = p._count;
      if (c.orderItems > 0 || c.nfeItens > 0 || c.receivableItems > 0 || c.budgetItems > 0) {
        sum.puladosComHistorico++;
        sum.detalhesPulados.push({
          id,
          sku: p.sku,
          motivo: "tem_historico",
          counts: c,
        });
        continue;
      }

      if (sum.amostra.length < 30) {
        sum.amostra.push({
          sku: p.sku,
          nome: p.name.slice(0, 60),
          stock: p.stock,
          anuncios: p.listings.map(
            (l) => `${l.marketplaceAccount?.platform}:${l.externalListingId}`,
          ),
        });
      }

      if (!apply) {
        sum.removidos++;
        sum.anunciosNaListaDeIgnorados += p.listings.length;
        continue;
      }

      try {
        // Transação por PRODUTO: ou o anúncio entra na lista E o produto sai,
        // ou nada acontece. Meio-termo (produto fora, lista vazia) é o estado
        // que recria tudo na varredura seguinte.
        await prisma.$transaction(async (tx) => {
          for (const l of p.listings) {
            const platform = l.marketplaceAccount?.platform;
            if (!platform) continue;
            await (tx as any).listingIngestionIgnore.upsert({
              where: {
                userId_platform_externalListingId: {
                  userId: dataOwnerId,
                  platform,
                  externalListingId: l.externalListingId,
                },
              },
              create: {
                userId: dataOwnerId,
                platform,
                externalListingId: l.externalListingId,
                reason,
              },
              update: {},
            });
          }
          await tx.stockLog.deleteMany({ where: { productId: p.id } });
          await tx.productListing.deleteMany({ where: { productId: p.id } });
          await tx.product.delete({ where: { id: p.id } });
        });
        sum.removidos++;
        sum.anunciosNaListaDeIgnorados += p.listings.length;
      } catch (err) {
        sum.erros++;
        sum.detalhesPulados.push({
          id,
          sku: p.sku,
          motivo: "erro",
          erro: err instanceof Error ? err.message : String(err),
        });
      }
    }

    console.log(
      `[lote ${Math.floor(i / lote) + 1}] processados=${Math.min(i + lote, ids.length)}/${ids.length} removidos=${sum.removidos} pulados=${sum.puladosComHistorico + sum.puladosNaoNasceuDeAnuncio + sum.puladosTenantErrado} erros=${sum.erros}`,
    );

    if (apply) {
      // Verificação entre lotes. Órfão de listing é impossível por construção
      // (ProductListing.productId é FK RESTRICT — o delete do Product falharia
      // antes), então a checagem honesta é outra: TODO anúncio de produto
      // removido neste lote precisa estar na lista de ignorados, senão a
      // varredura seguinte o recria (a falha do MK2: 998 limpos, 1.934 de
      // volta em um dia). A transação por produto garante; isto CONFERE.
      const idsRemovidosNoLote = fatia.filter(
        (id) => porId.get(id) && !sum.detalhesPulados.some((x) => x.id === id),
      );
      const anunciosEsperados = idsRemovidosNoLote.flatMap((id) =>
        (porId.get(id)?.listings ?? []).map((l) => l.externalListingId),
      );
      if (anunciosEsperados.length > 0) {
        const naLista = await (prisma as any).listingIngestionIgnore.count({
          where: {
            userId: dataOwnerId,
            externalListingId: { in: anunciosEsperados },
          },
        });
        if (naLista < anunciosEsperados.length) {
          throw new Error(
            `ABORTADO: ${anunciosEsperados.length - naLista} anúncio(s) de produto removido FORA da lista de ignorados — a varredura os recriaria. Investigar antes de continuar.`,
          );
        }
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join("scripts", "out");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(
    outDir,
    `limpar-catalogo-terceiro-${apply ? "apply" : "dryrun"}-${stamp}.json`,
  );
  fs.writeFileSync(outFile, JSON.stringify(sum, null, 2));

  console.log("\n══════════ RESUMO ══════════");
  console.log(JSON.stringify({ ...sum, detalhesPulados: sum.detalhesPulados.length, amostra: undefined }, null, 2));
  console.log("\n── AMOSTRA (30 primeiros aptos) ──");
  for (const a of sum.amostra) {
    console.log(`  ${a.sku} | ${a.nome} | estoque=${a.stock} | ${(a.anuncios as string[]).join(", ")}`);
  }
  console.log(`\nRelatório: ${outFile}`);
  if (!apply) {
    console.log("DRY-RUN — nada foi escrito. Apply: --apply --confirmar");
  }
}

main()
  .catch((e) => {
    console.error("FALHA:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
