// Sobe a árvore até achar o .env — permite rodar de dentro de um git worktree,
// que não tem .env próprio. Precisa vir antes do import do prisma.
import "./lib/load-env";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";

/**
 * Reenvia as compatibilidades veiculares (brand/model/year) cadastradas
 * no produto local para os anúncios ML vinculados. Resolve casos onde o
 * ML mostra o anúncio em "Inativos por descumprir políticas" porque a
 * ficha técnica de compatibilidades nunca foi populada (ou ficou
 * incompleta) durante a criação.
 *
 * Por padrão, opera APENAS na conta "MATEUSLASCADO" do user-alvo. Para
 * trocar de conta, use `--account-name=X` (busca case-insensitive contains)
 * ou `--account-id=Y` para forçar uma conta específica. `--all-accounts`
 * remove o filtro e processa todas as contas ML do user.
 *
 * Uso:
 *   tsx scripts/backfill-product-compatibilities-on-ml.ts             (user+conta default)
 *   tsx scripts/backfill-product-compatibilities-on-ml.ts --user=ID   (outro user)
 *   tsx scripts/backfill-product-compatibilities-on-ml.ts --account-name=fat  (outra conta por nome)
 *   tsx scripts/backfill-product-compatibilities-on-ml.ts --account-id=cmp... (conta exata)
 *   tsx scripts/backfill-product-compatibilities-on-ml.ts --all-accounts  (sem filtro de conta)
 *   tsx scripts/backfill-product-compatibilities-on-ml.ts --item=MLB123 (restringe a um
 *       anúncio; combina com --report e --apply)
 *   tsx scripts/backfill-product-compatibilities-on-ml.ts --report   (só diagnóstico:
 *       compara "banco tem N" com "ML tem M" por anúncio, sem escrever nada)
 *   tsx scripts/backfill-product-compatibilities-on-ml.ts --apply    (ESCREVE no ML;
 *       sem esta flag o script é dry-run)
 *   tsx scripts/backfill-product-compatibilities-on-ml.ts --only-missing  (só envia
 *       para anúncios cujo HAS_COMPATIBILITIES não é "Sim" — pula os que já têm)
 *
 * Como funciona:
 *  1. Busca produtos do user que têm pelo menos 1 ProductCompatibility cadastrada.
 *  2. Para cada produto, itera os ProductListings ML ativos.
 *  3. Reenvia via MLApiService.applyCompatibilitiesVerified — mesma escada
 *     usada na criação, que só considera uma estratégia bem-sucedida depois de
 *     RELER as compatibilidades do ML. Isso importa porque o ML responde 200
 *     com `ids: []` quando aceita e ignora o vínculo; o relatório e o log
 *     passam a mostrar quantas ficaram gravadas, não quantas foram enviadas.
 *  4. O ML, ao receber compatibilidades válidas, automaticamente reativa o
 *     anúncio caso ele estivesse pausado por falta de ficha técnica.
 *
 * Idempotente: re-enviar para anúncios que já têm a compat correta é no-op
 * pelo lado do ML. Use --only-missing se quiser pular esses por economia.
 *
 * Rode `--report` PRIMEIRO: ele lista "banco tem 15, ML tem 0" por anúncio sem
 * escrever nada, e é o que diz se o backfill é necessário.
 */

const DEFAULT_USER_ID = "cmnq8opbl0000vsiw19duv1i0";
const DEFAULT_ACCOUNT_NAME_MATCH = "mateuslascado"; // case-insensitive contains

const args = process.argv.slice(2);
const userId =
  args.find((a) => a.startsWith("--user="))?.split("=")[1] ?? DEFAULT_USER_ID;
const accountIdOverride =
  args.find((a) => a.startsWith("--account-id="))?.split("=")[1] ?? null;
const accountNameOverride =
  args.find((a) => a.startsWith("--account-name="))?.split("=")[1] ?? null;
const allAccounts = args.includes("--all-accounts");
const onlyMissing = args.includes("--only-missing");
/**
 * Escrita agora é OPT-IN. O default seguro passou a ser dry-run: este script
 * escreve na ficha técnica de anúncios reais em produção, e o padrão anterior
 * (escrever a menos que passassem --dry-run) tornava um esquecimento caro.
 * `--dry-run` continua aceito para não quebrar quem já usa.
 */
const apply = args.includes("--apply");
const dryRun = !apply;
/**
 * Só relatório: compara o que o banco tem com o que o ML devolve na LEITURA de
 * compatibilidades e lista as divergências. Não escreve nada, nem com --apply.
 */
const reportOnly = args.includes("--report");
/**
 * Restringe a UM anúncio (ou a uma lista separada por vírgula). Existe para
 * validar a correção num item só antes de mexer na conta inteira — escrever em
 * ficha técnica de anúncio ativo não é operação para estrear em lote.
 */
const itemFilter = (
  args.find((a) => a.startsWith("--item="))?.split("=")[1] ?? ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Resolve quais contas ML serão alvo. Por padrão filtra para a conta
 * MATEUSLASCADO; `--account-id` força uma conta específica; `--account-name`
 * troca o filtro de nome; `--all-accounts` remove o filtro.
 */
async function resolveTargetAccountIds(): Promise<{
  ids: string[];
  label: string;
} | null> {
  if (allAccounts) {
    const all = await prisma.marketplaceAccount.findMany({
      where: { userId, platform: "MERCADO_LIVRE" },
      select: { id: true, accountName: true },
    });
    return {
      ids: all.map((a) => a.id),
      label: `todas as contas ML (${all.length})`,
    };
  }

  if (accountIdOverride) {
    const acc = await prisma.marketplaceAccount.findUnique({
      where: { id: accountIdOverride },
      select: {
        id: true,
        accountName: true,
        platform: true,
        userId: true,
      },
    });
    if (!acc) {
      console.error(
        `[backfill-compat] Conta ${accountIdOverride} não encontrada.`,
      );
      return null;
    }
    if (acc.platform !== "MERCADO_LIVRE") {
      console.error(
        `[backfill-compat] Conta ${accountIdOverride} não é ML (platform=${acc.platform}).`,
      );
      return null;
    }
    if (acc.userId !== userId) {
      console.error(
        `[backfill-compat] Conta ${accountIdOverride} não pertence ao user ${userId}.`,
      );
      return null;
    }
    return { ids: [acc.id], label: `${acc.accountName} (${acc.id})` };
  }

  const nameMatch = (accountNameOverride ?? DEFAULT_ACCOUNT_NAME_MATCH).toLowerCase();
  const candidates = await prisma.marketplaceAccount.findMany({
    where: { userId, platform: "MERCADO_LIVRE" },
    select: { id: true, accountName: true },
  });
  const matching = candidates.filter((a) =>
    (a.accountName || "").toLowerCase().includes(nameMatch),
  );
  if (matching.length === 0) {
    console.error(
      `[backfill-compat] Nenhuma conta ML com "${nameMatch}" no nome para user ${userId}.`,
    );
    console.error(
      `[backfill-compat] Contas ML disponíveis: ${
        candidates.map((c) => `${c.id} (${c.accountName})`).join(", ") || "(nenhuma)"
      }`,
    );
    return null;
  }
  if (matching.length > 1) {
    console.warn(
      `[backfill-compat] Múltiplas contas com "${nameMatch}": ${matching
        .map((m) => `${m.id} (${m.accountName})`)
        .join(", ")}. Use --account-id=ID se quiser escolher uma específica.`,
    );
  }
  return {
    ids: matching.map((m) => m.id),
    label: matching.map((m) => m.accountName).join(", "),
  };
}

interface AccountTokenLite {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

const tokenCache = new Map<string, string>();

async function getValidToken(account: AccountTokenLite): Promise<string> {
  const cached = tokenCache.get(account.id);
  if (cached) return cached;

  const now = Date.now();
  if (new Date(account.expiresAt).getTime() > now + 60_000) {
    tokenCache.set(account.id, account.accessToken);
    return account.accessToken;
  }

  const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
    account.id,
    account.refreshToken,
  );
  await prisma.marketplaceAccount.update({
    where: { id: account.id },
    data: {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
    },
  });
  tokenCache.set(account.id, refreshed.accessToken);
  return refreshed.accessToken;
}

/**
 * Verifica se o item ML já tem HAS_COMPATIBILITIES="Sim" — usado pelo
 * modo --only-missing para evitar reprocessar anúncios saudáveis.
 */
async function itemAlreadyHasCompatibilities(
  itemId: string,
  token: string,
): Promise<boolean> {
  try {
    const item = await MLApiService.getItemDetails(token, itemId);
    const attrs = (item as { attributes?: Array<{ id: string; value_name?: string }> })
      .attributes;
    if (!Array.isArray(attrs)) return false;
    const hasCompat = attrs.find((a) => a.id === "HAS_COMPATIBILITIES");
    if (!hasCompat) return false;
    return (hasCompat.value_name || "").toLowerCase().startsWith("sim");
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log(
    `[backfill-compat] userId=${userId} modo=${reportOnly ? "report" : dryRun ? "dry-run" : "APPLY"} onlyMissing=${onlyMissing}`,
  );

  const target = await resolveTargetAccountIds();
  if (!target) {
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log(
    `[backfill-compat] Conta(s) alvo: ${target.label}${target.ids.length === 1 ? "" : ` [${target.ids.length} contas]`}`,
  );

  const products = await prisma.product.findMany({
    where: {
      userId,
      compatibilities: { some: {} },
    },
    include: {
      compatibilities: true,
      listings: {
        where: {
          marketplaceAccountId: { in: target.ids },
          marketplaceAccount: { platform: "MERCADO_LIVRE" },
          externalListingId: { startsWith: "MLB" },
        },
        include: { marketplaceAccount: true },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      },
    },
  });

  console.log(
    `[backfill-compat] produtos do user com compatibilidades cadastradas: ${products.length}`,
  );

  const productsWithListings = products.filter((p) => p.listings.length > 0);
  console.log(
    `[backfill-compat] desses, com pelo menos 1 anúncio ML: ${productsWithListings.length}`,
  );

  if (productsWithListings.length === 0) {
    console.log("[backfill-compat] nada a fazer.");
    await prisma.$disconnect();
    return;
  }

  let listingsOk = 0;
  let listingsSkippedAlreadyOk = 0;
  let listingsFailed = 0;
  let totalCompatSent = 0;
  // Relatório de divergência banco × ML.
  const divergentes: Array<{
    itemId: string;
    sku: string;
    noBanco: number;
    noMl: number;
  }> = [];
  let reportOk = 0;
  let reportIlegivel = 0;
  // Agrupa os ilegíveis por CAUSA. Sem isto o relatório só sabia dizer
  // "inconclusivo", e 404 (vínculo quebrado), 403 (anúncio de outra conta) e
  // 429 (throttling) — que pedem ações opostas — ficavam indistinguíveis.
  const ilegiveisPorMotivo = new Map<string, number>();
  // Primeiros exemplos de cada causa, para conferir sem reprocessar tudo.
  const exemploPorMotivo = new Map<string, string[]>();

  for (let i = 0; i < productsWithListings.length; i++) {
    const product = productsWithListings[i];
    // Deduplica (marca, modelo, ano) antes de qualquer comparação.
    //
    // O cadastro acumula linhas repetidas do mesmo veículo — visto em produção
    // um produto com "Fiat Palio 2006" 16 vezes. Comparar 16 com o que o ML
    // devolve produz falso "DIVERGENTE": o ML guarda VEÍCULOS, e ainda expande
    // cada um em vários catalog products (aquele Palio 2006 virou 11). Sem o
    // dedupe o relatório manda corrigir anúncio que já está certo.
    const vistos = new Set<string>();
    const vehicles: Array<{
      brand: string;
      model: string;
      yearFrom: number | null;
      yearTo: number | null;
    }> = [];
    for (const c of product.compatibilities) {
      const chave = `${(c.brand || "").trim().toLowerCase()}|${(c.model || "")
        .trim()
        .toLowerCase()}|${c.yearFrom ?? ""}|${c.yearTo ?? ""}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      vehicles.push({
        brand: c.brand,
        model: c.model,
        yearFrom: c.yearFrom,
        yearTo: c.yearTo,
      });
    }
    const duplicadas = product.compatibilities.length - vehicles.length;
    const prefix =
      `[${i + 1}/${productsWithListings.length}] sku=${product.sku ?? "?"} ` +
      `(${vehicles.length} veiculo(s) unico(s)${duplicadas > 0 ? `, ${duplicadas} linha(s) duplicada(s) no cadastro` : ""})`;

    if (vehicles.length === 0) {
      console.log(`  ${prefix}: sem compats efetivas — skip`);
      continue;
    }

    for (const listing of product.listings) {
      if (
        itemFilter.length > 0 &&
        !itemFilter.includes(listing.externalListingId)
      ) {
        continue;
      }
      const lprefix = `  ${prefix} listing=${listing.externalListingId} (status=${listing.status})`;
      try {
        const token = await getValidToken(listing.marketplaceAccount);

        if (reportOnly) {
          // Lê o que está gravado no ML e compara com o banco. É o diagnóstico
          // que faltava: "o banco tem 15, o ML tem 0" era invisível antes.
          const item = await MLApiService.getItemDetails(
            token,
            listing.externalListingId,
          ).catch(() => null);
          const upId =
            (item as { user_product_id?: string | null } | null)
              ?.user_product_id ?? null;
          const read = await MLApiService.readCompatibilities(
            token,
            listing.externalListingId,
            upId,
          );
          if (!read.available) {
            const motivo = read.reason ?? "desconhecido";
            const httpTxt =
              read.httpStatus != null ? ` HTTP ${read.httpStatus}` : "";
            console.warn(
              `${lprefix}: leitura indisponível (${motivo}${httpTxt}) — inconclusivo`,
            );
            reportIlegivel++;
            ilegiveisPorMotivo.set(
              motivo,
              (ilegiveisPorMotivo.get(motivo) ?? 0) + 1,
            );
            const exemplos = exemploPorMotivo.get(motivo) ?? [];
            if (exemplos.length < 3) {
              exemplos.push(listing.externalListingId);
              exemploPorMotivo.set(motivo, exemplos);
            }
          } else if (read.count < vehicles.length) {
            console.warn(
              `${lprefix}: banco tem ${vehicles.length}, ML tem ${read.count} → DIVERGENTE`,
            );
            divergentes.push({
              itemId: listing.externalListingId,
              sku: product.sku ?? "?",
              noBanco: vehicles.length,
              noMl: read.count,
            });
          } else {
            console.log(
              `${lprefix}: banco tem ${vehicles.length}, ML tem ${read.count} → ok`,
            );
            reportOk++;
          }
          continue;
        }

        if (onlyMissing) {
          const already = await itemAlreadyHasCompatibilities(
            listing.externalListingId,
            token,
          );
          if (already) {
            console.log(`${lprefix}: HAS_COMPATIBILITIES=Sim — skip`);
            listingsSkippedAlreadyOk++;
            continue;
          }
        }

        if (dryRun) {
          console.log(
            `${lprefix}: [dry-run] would send ${vehicles.length} compat entries`,
          );
          listingsOk++;
          totalCompatSent += vehicles.length;
          continue;
        }

        // Escada verificada: cada estratégia só vale se o read-back confirmar
        // veículos gravados. Antes usávamos direto o caminho por atributos,
        // que o ML aceita com 200 e ignora (ids:[]).
        const result = await MLApiService.applyCompatibilitiesVerified(
          token,
          listing.externalListingId,
          vehicles,
        );

        if (result.ok) {
          console.log(
            `${lprefix}: ✓ ${result.persisted}/${result.requested} gravadas no ML ` +
              `(estrategia=${result.strategy}, verificado=${result.verified})`,
          );
          listingsOk++;
          totalCompatSent += result.persisted;
        } else {
          const err =
            result.errors.length > 0 ? result.errors.join("; ") : "sem detalhes";
          console.warn(
            `${lprefix}: ✗ nao persistiu — ${result.persisted}/${result.requested}, ` +
              `estrategia=${result.strategy}, verificado=${result.verified} — ${err}`,
          );
          listingsFailed++;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`${lprefix}: ✗ exception — ${msg}`);
        listingsFailed++;
      }
    }
  }

  console.log("");
  console.log("=== Resumo ===");
  console.log(`  Produtos com compats locais:           ${products.length}`);
  console.log(`  Produtos com pelo menos 1 listing ML:  ${productsWithListings.length}`);

  if (reportOnly) {
    console.log(`  Anuncios ok (ML cobre o banco):        ${reportOk}`);
    console.log(`  Anuncios DIVERGENTES:                  ${divergentes.length}`);
    console.log(`  Anuncios ilegiveis (inconclusivo):     ${reportIlegivel}`);
    if (ilegiveisPorMotivo.size > 0) {
      // A ação muda por causa, então o resumo precisa separá-las: reenviar
      // compat num anuncio 404 nunca vai funcionar, e num 429 basta repetir.
      const acao: Record<string, string> = {
        item_inexistente:
          "anuncio nao existe no ML — corrigir o VINCULO, nao a compat",
        sem_permissao: "anuncio de outra conta — conferir a qual conta pertence",
        rate_limit: "throttling do ML — repetir depois, o dado esta la",
        timeout: "estourou o tempo — repetir",
        erro_http: "erro do ML — ver o status",
        shape_desconhecido: "respondeu 200 com corpo nao reconhecido — investigar",
        erro_rede: "falhou antes da resposta — repetir",
      };
      console.log("");
      console.log("  Ilegiveis por causa:");
      const ordenado = [...ilegiveisPorMotivo.entries()].sort(
        (a, b) => b[1] - a[1],
      );
      for (const [motivo, qtd] of ordenado) {
        console.log(`    ${qtd} x ${motivo} — ${acao[motivo] ?? "?"}`);
        const exemplos = exemploPorMotivo.get(motivo) ?? [];
        if (exemplos.length > 0) {
          console.log(`        ex.: ${exemplos.join(", ")}`);
        }
      }
    }
    if (divergentes.length > 0) {
      const piores = [...divergentes]
        .sort((a, b) => b.noBanco - b.noMl - (a.noBanco - a.noMl))
        .slice(0, 20);
      console.log("");
      console.log(`  Top ${piores.length} por diferenca:`);
      for (const d of piores) {
        console.log(
          `    ${d.itemId} (sku ${d.sku}): banco tem ${d.noBanco}, ML tem ${d.noMl}`,
        );
      }
      if (divergentes.length > piores.length) {
        console.log(
          `    ... e mais ${divergentes.length - piores.length} anuncio(s) divergente(s) nao listados aqui.`,
        );
      }
    }
    console.log("");
    console.log("  Nada foi escrito. Para corrigir: rode de novo com --apply.");
    await prisma.$disconnect();
    return;
  }

  console.log(`  Listings OK${dryRun ? " (dry-run)" : ""}:                ${listingsOk}`);
  if (onlyMissing) {
    console.log(`  Listings skip (já tinham compat):       ${listingsSkippedAlreadyOk}`);
  }
  console.log(`  Listings com falha:                     ${listingsFailed}`);
  console.log(`  Total compat gravadas no ML:            ${totalCompatSent}`);
  if (dryRun) {
    console.log("");
    console.log("  DRY-RUN: nada foi escrito. Use --apply para valer.");
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[backfill-compat] erro fatal:", e);
  await prisma.$disconnect();
  process.exit(1);
});
