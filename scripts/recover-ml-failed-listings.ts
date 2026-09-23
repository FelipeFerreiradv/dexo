// Sobe a árvore até achar o .env — permite rodar de dentro de um git worktree.
// Precisa vir antes do import do prisma.
import "./lib/load-env";
import fs from "node:fs";
import path from "node:path";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { ListingRetryService } from "../app/marketplaces/services/listing-retry.service";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { decideReconcile } from "../app/marketplaces/lib/ml-reconcile.logic";
import { gravarSeIntacta as gravarCondicional } from "./lib/recover-ml-apply";
import { REARM_DELAY_MS } from "../app/marketplaces/lib/ml-rearm.logic";
import { sanitizeMLTitle } from "../app/marketplaces/lib/ml-title";
import {
  isMlRequiredAttrsBlockEnabled,
  shouldSkipMlRequiredBlockForCatalog,
} from "../app/marketplaces/lib/ml-required-attributes.logic";
import { placeholderMlSettings } from "../app/marketplaces/lib/ml-placeholder-settings";
import { formatListingError } from "../app/produtos/lib/listing-error-format";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";
import { LAST_ERROR_MARKER } from "../app/marketplaces/lib/ml-error-normalizer";
import {
  classifyRecoverRow,
  detectRecoverInFlight,
  recoverPreflightBlocks,
  type RecoverClass,
  type RecoverInput,
} from "./lib/recover-ml-classify";

/**
 * Recupera os anúncios do Mercado Livre presos em "Aguardando publicação"
 * (placeholder PENDING_ em erro, ou `pending` sem retentativa) de UM cliente.
 *
 * Uso (NA VPS — renovar token da máquina local derruba a conta):
 *   tsx scripts/recover-ml-failed-listings.ts --user-email=cliente@x.com --since=30d
 *   tsx scripts/recover-ml-failed-listings.ts --user-email=… --since=30d --apply
 *   --account-id=…   só uma conta ML do cliente
 *   --limit=N        no máximo N linhas
 *   --verify         só leitura: estado no ML dos anúncios criados na janela
 *                    (status, tipo, condição, frete grátis)
 *
 * Dry-run é o padrão e NÃO escreve nada — nem renova token: conta com token
 * vencido fica "não verificado" (o app renova sozinho; rode de novo depois).
 *
 * Para cada linha, na conta DA PRÓPRIA LINHA (nunca publica em conta que a
 * pessoa não escolheu):
 *   1. anúncio vivo local no mesmo par        ⇒ ja_publicado
 *   2. anúncio criado no ML depois do pendente (busca por seller_sku)
 *                                              ⇒ adotar (sem criar nada)
 *   3. outro anúncio vivo com o mesmo SKU      ⇒ duplicidade_possivel
 *   4. pré-validação atual bloqueia (obrigatório/valor), ou o último erro é
 *      dado que só a pessoa corrige (INMETRO, medidas, foto…). O
 *      `updatedAt` do produto NÃO conta como correção — estoque e preço
 *      também o movem —, só muda o texto do motivo
 *                                              ⇒ precisa_cliente
 *   5. resto                                   ⇒ publicavel
 *
 * --apply:
 *   ja_publicado  ⇒ pendente encerrado ([TERMINAL], mesma frase da guarda
 *                   anti-duplicata do create);
 *   adotar        ⇒ ListingRetryService.reconcileBeforeRecreate (relê no ML e
 *                   vincula o item existente);
 *   precisa_cliente ⇒ [TERMINAL][CORRIGIVEL] + motivo (a edição re-arma);
 *   publicavel    ⇒ re-arma (retryEnabled, 0 tentativas, horários escalonados
 *                   de 30 s). Quem publica é o cron, pelo createMLListing, com
 *                   as configurações do PRÓPRIO pendente (tipo de anúncio,
 *                   condição, frete) — nada de padrão global.
 *   duplicidade_possivel / nao_verificado / conta_inativa / em_andamento /
 *   agendado ⇒ nada.
 *
 * Toda escrita do --apply é CONDICIONAL: só vale se a linha continua como o
 * dry-run a leu (mesmo `updatedAt`, ainda placeholder). Linha que mudou no
 * meio — o cron publicou, a pessoa clicou em "Tentar publicar novamente" — é
 * pulada, nunca sobrescrita (sobrescrever uma linha recém-publicada devolvia
 * ao cron algo que ele criaria de novo).
 *
 * Saída: scripts/out/recover-ml-<userId>-<data>.json (todas as linhas) e
 * .csv só com o que precisa da cliente (produto, SKU, conta, motivo).
 */

const args = process.argv.slice(2);
const arg = (k: string) =>
  args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const userEmail = arg("user-email");
const userIdArg = arg("user");
const accountIdArg = arg("account-id");
const apply = args.includes("--apply");
const verifyOnly = args.includes("--verify");
const limit = Number(arg("limit") ?? "0") || 0;
const since: Date | null = (() => {
  const s = arg("since");
  if (!s) return null;
  const dias = /^(\d+)d$/.exec(s);
  const d = dias ? new Date(Date.now() - Number(dias[1]) * 86_400_000) : new Date(s);
  if (Number.isNaN(d.getTime())) {
    console.error(`--since inválido: ${s}`);
    process.exit(1);
  }
  return d;
})();

const ESCALONAMENTO_MS = 30_000;
/**
 * Linha alterada há menos que isto pode estar no meio de uma publicação
 * (mesma régua da "Publicação interrompida" do card) — não é tocada.
 */
const PUBLICANDO_AGORA_MS = 30 * 60_000;
const TOKEN_FOLGA_MS = 5 * 60_000;

interface Linha {
  listingId: string;
  productId: string;
  sku: string | null;
  produto: string;
  conta: string;
  contaId: string;
  status: string;
  retryEnabled: boolean;
  lastError: string | null;
  erroLegivel: string | null;
  config: ReturnType<typeof placeholderMlSettings> | null;
  classe: RecoverClass;
  motivo: string;
  acao?: string;
}

async function resolveUserId(): Promise<string> {
  if (userIdArg) return userIdArg;
  if (!userEmail) {
    console.error("Informe --user-email=… (ou --user=ID).");
    process.exit(1);
  }
  const u = await prisma.user.findUnique({
    where: { email: userEmail },
    select: { id: true },
  });
  if (!u) {
    console.error(`Usuário ${userEmail} não encontrado.`);
    process.exit(1);
  }
  return u.id;
}

function tokenValido(expiresAt: Date | null | undefined): boolean {
  return !!expiresAt && new Date(expiresAt).getTime() > Date.now() + TOKEN_FOLGA_MS;
}

async function verificar(userId: string) {
  const contas = await prisma.marketplaceAccount.findMany({
    where: {
      userId,
      platform: "MERCADO_LIVRE",
      ...(accountIdArg ? { id: accountIdArg } : {}),
    },
    select: { id: true, accountName: true, accessToken: true, expiresAt: true },
  });
  for (const c of contas) {
    const linhas = await prisma.productListing.findMany({
      where: {
        marketplaceAccountId: c.id,
        NOT: { externalListingId: { startsWith: "PENDING_" } },
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      select: { externalListingId: true },
      take: limit || undefined,
    });
    if (!tokenValido(c.expiresAt)) {
      console.log(`[${c.accountName}] token vencido — não verifico (não renovo token).`);
      continue;
    }
    const ids = linhas.map((l) => l.externalListingId);
    const resumo: Record<string, number> = {};
    {
      // Multiget de 20 em 20 (dentro do service); só leitura.
      const itens = await MLApiService.getItemsDetails(c.accessToken, ids).catch(
        () => [] as any[],
      );
      for (const it of itens as any[]) {
        const chave = [
          it?.status ?? "?",
          it?.listing_type_id ?? "?",
          it?.condition ?? "?",
          it?.shipping?.free_shipping ? "frete_gratis" : "sem_frete_gratis",
        ].join(" | ");
        resumo[chave] = (resumo[chave] ?? 0) + 1;
      }
    }
    console.log(`\n[${c.accountName}] ${ids.length} anúncios na janela:`);
    for (const [k, n] of Object.entries(resumo).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${k}`);
    }
  }
}

async function main() {
  const userId = await resolveUserId();
  console.log(
    `[recover-ml] user=${userId} janela=${since?.toISOString() ?? "toda"} modo=${
      verifyOnly ? "verify" : apply ? "APPLY" : "dry-run"
    }`,
  );
  if (verifyOnly) {
    await verificar(userId);
    return;
  }

  const pendentes = await prisma.productListing.findMany({
    where: {
      marketplaceAccount: {
        userId,
        platform: "MERCADO_LIVRE",
        ...(accountIdArg ? { id: accountIdArg } : {}),
      },
      externalListingId: { startsWith: "PENDING_" },
      NOT: { externalListingId: { startsWith: "PENDING_REPUBLISH_" } },
      status: { in: ["error", "pending"] },
      // Janela pelo pendente OU pelo produto: um anúncio preso de produto
      // antigo também entra.
      ...(since
        ? {
            OR: [
              { createdAt: { gte: since } },
              { product: { createdAt: { gte: since } } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      productId: true,
      status: true,
      retryEnabled: true,
      retryAttempts: true,
      nextRetryAt: true,
      lastError: true,
      attributesOverride: true,
      createdAt: true,
      updatedAt: true,
      requestedCategoryId: true,
      listingType: true,
      itemCondition: true,
      hasWarranty: true,
      warrantyUnit: true,
      warrantyDuration: true,
      shippingMode: true,
      freeShipping: true,
      localPickup: true,
      manufacturingTime: true,
      marketplaceAccountId: true,
      product: { select: { sku: true, name: true, updatedAt: true } },
      marketplaceAccount: {
        select: {
          id: true,
          accountName: true,
          status: true,
          accessToken: true,
          expiresAt: true,
          externalUserId: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
    take: limit || undefined,
  });
  console.log(`[recover-ml] ${pendentes.length} pendentes`);

  const produtos = await new ProductRepositoryPrisma().findMlRequiredAttrsInput(
    Array.from(new Set(pendentes.map((p) => p.productId))),
    userId,
  );
  const porProduto = new Map(produtos.map((p) => [p.id, p]));
  const cacheCategoria = new Map<string, Promise<any>>();

  const linhas: Linha[] = [];
  for (const p of pendentes) {
    const acc = p.marketplaceAccount;
    const sku = (p.product?.sku ?? "").trim() || null;

    const liveLocal = await ListingRepository.findLiveByProductAndAccount(
      p.productId,
      acc.id,
    );

    const inFlight: RecoverInput["inFlight"] = detectRecoverInFlight({
      retryEnabled: !!p.retryEnabled,
      nextRetryAt: p.nextRetryAt,
      updatedAt: p.updatedAt,
      now: Date.now(),
      recenteMs: PUBLICANDO_AGORA_MS,
    });

    let remote: RecoverInput["remote"];
    if (inFlight) {
      remote = { status: "skipped" };
    } else if (!sku || !acc.externalUserId) {
      remote = { status: "skipped" };
    } else if (!tokenValido(acc.expiresAt)) {
      remote = { status: "not_checked" };
    } else {
      try {
        const itens = await MLApiService.findItemsBySellerSku(
          acc.accessToken,
          acc.externalUserId,
          sku,
        );
        // Mesma decisão do cron: status, campo de SKU e TÍTULO.
        const decisao = decideReconcile(itens, {
          placeholderCreatedAt: new Date(p.createdAt),
          sku,
          desiredTitle: p.product?.name ? sanitizeMLTitle(p.product.name, sku) : null,
        });
        const adotavel = decisao.kind === "adopt" ? decisao.item : null;
        const ambiguo = decisao.kind === "ambiguous" ? decisao.item : null;
        remote = {
          status: "ok",
          adoptable: adotavel,
          ambiguous: ambiguo,
          others: itens.filter((it) => it.id !== adotavel?.id && it.id !== ambiguo?.id),
        };
      } catch {
        remote = { status: "search_failed" };
      }
    }

    let preflight: RecoverInput["preflight"] = null;
    const produto = porProduto.get(p.productId);
    if (produto && !inFlight) {
      try {
        const ficha =
          p.attributesOverride &&
          typeof p.attributesOverride === "object" &&
          !Array.isArray(p.attributesOverride)
            ? (p.attributesOverride as Record<string, unknown>)
            : null;
        const ev = await ListingUseCase.evaluateMLRequiredAttributesForProduct({
          product: produto,
          categoryId: p.requestedCategoryId ?? undefined,
          attributeOverrides: ficha,
          categoryCache: cacheCategoria,
        });
        // Espelha o que o create de PRODUÇÃO bloqueia: valor inválido sempre;
        // obrigatório faltando só com ML_REQUIRED_ATTRS_BLOCK=1; e nada antes
        // do POST quando é anúncio de catálogo ligado.
        const catalogo = shouldSkipMlRequiredBlockForCatalog(
          (produto as { mlCatalogProductId?: unknown }).mlCatalogProductId,
        );
        const bloqueios = catalogo
          ? []
          : recoverPreflightBlocks({
              blocking: ev.blocking,
              valueIssues: ev.valueIssues,
              requiredBlockEnabled: isMlRequiredAttrsBlockEnabled(),
            });
        preflight = {
          blocked: bloqueios.length > 0,
          message:
            bloqueios.length === 0
              ? null
              : bloqueios.length === 1
                ? bloqueios[0].message
                : `A ficha técnica tem ${bloqueios.length} valores a corrigir: ${bloqueios.map((b) => b.message).join(" ")}`,
        };
      } catch (err) {
        console.warn(
          `[recover-ml] pré-validação falhou para ${p.productId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Item remoto adotável que não é o vivo local: só é suspeito de ser órfão
    // do POST perdido se não tiver vínculo em nenhuma linha desta conta. Só
    // leitura; falha = "failed" (a linha fica sem escrita, nunca "exclua").
    let adoptableLink: RecoverInput["adoptableLink"];
    if (
      liveLocal &&
      remote.status === "ok" &&
      remote.adoptable &&
      remote.adoptable.id !== liveLocal.externalListingId
    ) {
      try {
        adoptableLink = (await ListingRepository.findLinkByExternalListingId(
          acc.id,
          remote.adoptable.id,
        ))
          ? "linked"
          : "unlinked";
      } catch {
        adoptableLink = "failed";
      }
    }

    const editedAfterError =
      !!p.product?.updatedAt &&
      new Date(p.product.updatedAt).getTime() > new Date(p.updatedAt).getTime();

    const d = classifyRecoverRow({
      accountActive: acc.status === "ACTIVE",
      inFlight,
      liveLocal: liveLocal
        ? { externalListingId: liveLocal.externalListingId, status: liveLocal.status }
        : null,
      remote,
      adoptableLink,
      preflight,
      lastError: p.lastError,
      editedAfterError,
    });

    linhas.push({
      listingId: p.id,
      productId: p.productId,
      sku,
      produto: p.product?.name ?? "",
      conta: acc.accountName,
      contaId: acc.id,
      status: p.status,
      retryEnabled: p.retryEnabled,
      lastError: p.lastError,
      erroLegivel: formatListingError(p.lastError, "MERCADO_LIVRE")?.summary ?? null,
      config: placeholderMlSettings(p) ?? null,
      classe: d.classe,
      motivo: d.motivo,
    });
  }

  // Resumo
  const contagem: Record<string, number> = {};
  for (const l of linhas) contagem[l.classe] = (contagem[l.classe] ?? 0) + 1;
  console.log("[recover-ml] classificação:", contagem);
  const configs: Record<string, number> = {};
  for (const l of linhas.filter((x) => x.classe === "publicavel")) {
    const k = `${l.config?.listingType ?? "(padrão)"} | ${
      l.config?.freeShipping === true ? "frete grátis" : l.config?.freeShipping === false ? "sem frete grátis" : "(padrão)"
    }`;
    configs[k] = (configs[k] ?? 0) + 1;
  }
  console.log("[recover-ml] configurações dos publicáveis (do próprio pendente):", configs);

  if (apply) {
    let ordem = 0;
    const lidoEm = new Map(pendentes.map((p) => [p.id, p.updatedAt]));
    // Escrita condicional: só se a linha continua EXATAMENTE como foi lida
    // (scripts/lib/recover-ml-apply.ts; provada contra Postgres real).
    const gravarSeIntacta = (
      listingId: string,
      data: Record<string, unknown>,
    ): Promise<boolean> =>
      gravarCondicional(prisma, listingId, lidoEm.get(listingId), data);
    for (const l of linhas) {
      try {
        if (l.classe === "ja_publicado") {
          const ok = await gravarSeIntacta(l.listingId, {
            status: "error",
            lastError: `[TERMINAL] Produto já tem anúncio nesta conta — ${l.motivo} Exclua este pendente.`,
            retryEnabled: false,
            nextRetryAt: null,
          });
          l.acao = ok ? "encerrado" : "pulado: linha mudou durante a execução";
        } else if (l.classe === "adotar") {
          const cand = pendentes.find((p) => p.id === l.listingId)!;
          const atual = await prisma.productListing.findUnique({
            where: { id: cand.id },
            select: { updatedAt: true, externalListingId: true },
          });
          if (
            !atual ||
            !String(atual.externalListingId).startsWith("PENDING_") ||
            atual.updatedAt.getTime() !== new Date(cand.updatedAt).getTime()
          ) {
            l.acao = "pulado: linha mudou durante a execução";
            continue;
          }
          const r = await ListingRetryService.reconcileBeforeRecreate(
            {
              id: cand.id,
              createdAt: cand.createdAt,
              retryAttempts: cand.retryAttempts,
              lastError: cand.lastError,
              marketplaceAccountId: cand.marketplaceAccountId,
              productId: cand.productId,
              product: {
                sku: cand.product?.sku ?? null,
                name: cand.product?.name ?? null,
              },
            },
            {
              id: cand.marketplaceAccount.id,
              accessToken: cand.marketplaceAccount.accessToken,
              externalUserId: cand.marketplaceAccount.externalUserId,
            },
          );
          l.acao = `reconcile:${r}`;
        } else if (l.classe === "precisa_cliente") {
          const ok = await gravarSeIntacta(l.listingId, {
            status: "error",
            lastError: `${LAST_ERROR_MARKER.CORRIGIVEL} ${l.motivo}`.slice(0, 490),
            retryEnabled: false,
            nextRetryAt: null,
          });
          l.acao = ok ? "marcado_corrigivel" : "pulado: linha mudou durante a execução";
        } else if (l.classe === "publicavel") {
          // lastError limpo: o motivo antigo (quase sempre o 369 que
          // mascarava a causa) fica no relatório; a nova tentativa grava o
          // motivo real, já classificado.
          const ok = await gravarSeIntacta(l.listingId, {
            status: "error",
            lastError: null,
            retryEnabled: true,
            retryAttempts: 0,
            // Mesma folga do re-arme da edição (5 min): quem estiver no meio
            // de uma publicação termina antes do cron olhar a linha.
            nextRetryAt: new Date(
              Date.now() + REARM_DELAY_MS + ordem * ESCALONAMENTO_MS,
            ),
          });
          if (ok) ordem++;
          l.acao = ok ? "rearmado" : "pulado: linha mudou durante a execução";
        }
      } catch (err) {
        l.acao = `falhou: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    // Leitura depois da escrita: o estado gravado de cada linha tocada.
    const tocadas = linhas.filter((l) => l.acao);
    const relidas = await prisma.productListing.findMany({
      where: { id: { in: tocadas.map((l) => l.listingId) } },
      select: { id: true, status: true, retryEnabled: true, nextRetryAt: true, externalListingId: true, lastError: true },
    });
    const porId = new Map(relidas.map((r) => [r.id, r]));
    let divergentes = 0;
    for (const l of tocadas) {
      const r = porId.get(l.listingId);
      const esperadoRetry = l.acao === "rearmado";
      const acao = l.acao ?? "";
      if (
        !r ||
        (!acao.startsWith("falhou") &&
          !acao.startsWith("reconcile") &&
          !acao.startsWith("pulado") &&
          r.retryEnabled !== esperadoRetry)
      ) {
        divergentes++;
        console.warn(`[recover-ml] releitura divergente: ${l.listingId}`, r);
      }
    }
    console.log(`[recover-ml] escrita conferida: ${tocadas.length - divergentes}/${tocadas.length}`);
  }

  const outDir = path.resolve(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(outDir, `recover-ml-${userId}-${carimbo}${apply ? "-apply" : ""}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(linhas, null, 2));
  const csv = [
    "produto;sku;conta;motivo",
    ...linhas
      .filter((l) => l.classe === "precisa_cliente" || l.classe === "duplicidade_possivel")
      .map((l) =>
        [l.produto, l.sku ?? "", l.conta, l.motivo]
          .map((c) => `"${String(c).replace(/"/g, '""')}"`)
          .join(";"),
      ),
  ].join("\n");
  fs.writeFileSync(`${base}.csv`, csv);
  console.log(`[recover-ml] relatório: ${base}.json / .csv`);
}

main()
  .catch((err) => {
    console.error("[recover-ml] falhou:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
