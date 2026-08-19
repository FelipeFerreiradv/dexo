import { Platform } from "@prisma/client";
import { ListingRepository } from "../repositories/listing.repository";
import { MLApiService } from "./ml-api.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { SystemLogService } from "../../services/system-log.service";
import { MLOAuthService } from "./ml-oauth.service";
import { isPlatformDisabled } from "@/app/lib/integration-flags";
import {
  classifyFacebookRemoveError,
  classifyOlxRemoveError,
} from "./listing-removal.helpers";

const BACKOFF_SECONDS = [30, 60, 120, 300, 900]; // exponential-ish backoff
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;
// Candidatos por passada. Cada um custa varias chamadas sequenciais ao ML, e
// nao ha rate limit no servico — lotes grandes fazem a passada durar dezenas
// de minutos.
const RETRY_BATCH_SIZE = Number(process.env.LISTING_RETRY_BATCH || 25);
// Lease do claim atômico por candidato (trava entre processos). Precisa
// cobrir o pior caso de UM candidato (escada completa + upload de imagens,
// ~1-2min); se o processo morrer no meio, o candidato volta à fila sozinho
// quando o lease expira. Os caminhos normais sobrescrevem o lease no fim
// (sucesso desliga o retry; falha grava o backoff real).
const CLAIM_LEASE_MS = 10 * 60 * 1000;
const errMsg = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// Pre-compiled regex for Shopee terminal error detection
const SHOPEE_TERMINAL_RE =
  /excede os limites de todos os canais|duplicates? another|duplicate.*shop|selecione uma categoria|categoria.*inv[aá]lida|n[ãa]o foi poss[ií]vel obter os atributos da categoria/i;

export class ListingRetryService {
  private static running = false;
  private static intervalId: NodeJS.Timeout | null = null;
  /** Trava de reentrância de runOnce. `running` só controla o setInterval. */
  private static passInFlight = false;

  /**
   * Run a single pass: find placeholders / pending retries and try to create them on ML.
   *
   * Guarda contra passadas sobrepostas: cada candidato faz ~13-23 chamadas
   * sequenciais ao ML, então uma passada cheia pode durar mais que o intervalo
   * do setInterval (e o endpoint POST /ml/retry-pending dispara runOnce em
   * paralelo ao cron). Sem a trava, duas passadas leem o mesmo lote — a
   * primeira escrita de um candidato só acontece no fim do seu ciclo — e
   * chamam createItem para os mesmos listings, criando anúncios DUPLICADOS
   * e órfãos no ML (sem linha no banco, invisíveis à plataforma).
   */
  static async runOnce() {
    if (this.passInFlight) {
      console.log(
        "[ListingRetryService] passada anterior ainda em execução — ignorando este disparo",
      );
      return;
    }
    this.passInFlight = true;
    try {
      return await this.runPass();
    } finally {
      this.passInFlight = false;
    }
  }

  private static async runPass() {
    console.log("[ListingRetryService] runOnce start");
    const now = new Date();
    const candidates = await ListingRepository.findPendingRetries(
      now,
      RETRY_BATCH_SIZE,
    );
    console.log(`[ListingRetryService] candidates=${candidates?.length || 0}`);

    for (const cand of candidates) {
      try {
        console.log(`[ListingRetryService] processing candidate ${cand.id}`);

        // Claim atômico ANTES de qualquer efeito: a trava `passInFlight` só
        // vale dentro deste processo, e em produção já houve um segundo cron
        // em paralelo (node órfão de um restart do pm2, rodando código de um
        // deploy anterior). Sem o claim, dois processos leem o mesmo lote e
        // criam o mesmo anúncio duas vezes no ML. O UPDATE condicional é
        // atômico — quem perder a corrida pula o candidato.
        const claimed = await ListingRepository.claimRetryCandidate(
          cand.id,
          CLAIM_LEASE_MS,
        );
        if (!claimed) {
          console.log(
            `[ListingRetryService] skipping ${cand.id} (claimed por outro processo ou estado mudou)`,
          );
          continue;
        }

        // only handle placeholders (externals starting with PENDING_) or retryEnabled
        if (
          !cand.externalListingId?.startsWith("PENDING_") &&
          !cand.retryEnabled
        ) {
          console.log(
            `[ListingRetryService] skipping ${cand.id} (not placeholder/retryEnabled)`,
          );
          continue;
        }

        // defensive: skip if product missing
        if (!cand.product) {
          console.log(`[ListingRetryService] skipping ${cand.id} (no product)`);
          continue;
        }

        const account = cand.marketplaceAccount;

        // Shopee placeholders: delegar para ListingUseCase.createShopeeListing
        if (
          account?.platform === "SHOPEE" ||
          cand.externalListingId?.startsWith("PENDING_SHP_")
        ) {
          console.log(
            `[ListingRetryService] delegating Shopee retry for ${cand.id} to createShopeeListing`,
          );
          try {
            const { ListingUseCase } =
              await import("../usecases/listing.usercase");
            const result = await ListingUseCase.createShopeeListing(
              account?.userId || "",
              cand.productId,
              cand.requestedCategoryId || undefined,
              account?.id,
            );
            if (result.success) {
              console.log(
                `[ListingRetryService] Shopee retry succeeded for ${cand.id}: ${result.externalListingId}`,
              );
            } else {
              // createShopeeListing already updates the listing placeholder in its
              // own catch block (with terminal classification and attempt tracking).
              // Log here for observability only.
              console.warn(
                `[ListingRetryService] Shopee retry failed for ${cand.id}: ${result.error}`,
              );
            }
          } catch (shopeeErr) {
            const msg = errMsg(shopeeErr);
            console.error(
              `[ListingRetryService] Shopee retry exception for ${cand.id}:`,
              msg,
            );
            // Classify terminal Shopee errors that should stop retry
            const isTerminal = SHOPEE_TERMINAL_RE.test(msg);

            const attempts = (cand.retryAttempts || 0) + 1;
            const shouldRetry = !isTerminal && attempts < MAX_ATTEMPTS;
            const nextDelay =
              BACKOFF_SECONDS[
                Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)
              ];
            await ListingRepository.incrementRetryAttempts(cand.id, {
              lastError:
                (isTerminal ? "[TERMINAL] " : "") + msg.substring(0, 490),
              nextRetryAt: shouldRetry
                ? new Date(Date.now() + nextDelay * 1000)
                : null,
              retryEnabled: shouldRetry,
            });
            if (isTerminal) {
              console.warn(
                `[ListingRetryService] Shopee terminal error for ${cand.id} — retry disabled`,
              );
            }
          }
          continue;
        }
        // OLX e Facebook: delegar ao create da própria plataforma, no mesmo
        // desenho do branch da Shopee acima. Antes destes ramos, os dois caíam
        // no guard abaixo e tinham o retry DESLIGADO — ou seja, uma falha
        // transitória (5xx da OLX, rate limit da Meta) matava o anúncio na
        // primeira tentativa e ele nunca mais era republicado.
        // Não replicar a condição `startsWith("PENDING_")`: OLX/Facebook não
        // usam placeholder — o externalListingId deles já é o SKU.
        if (
          account?.platform === Platform.OLX ||
          account?.platform === Platform.FACEBOOK
        ) {
          const ehOlx = account.platform === Platform.OLX;
          const nome = ehOlx ? "OLX" : "Facebook";

          // Kill-switch: com a integração pausada, este cron NÃO pode continuar
          // publicando. Reagenda sem consumir tentativa — quando o operador
          // religar, o candidato volta à fila no estado em que estava.
          if (isPlatformDisabled(account.platform)) {
            await ListingRepository.incrementRetryAttempts(
              cand.id,
              {
                nextRetryAt: new Date(Date.now() + 30 * 60 * 1000),
                lastError: `${nome} pausado por kill-switch — retry adiado`,
              },
              // O comentário acima prometia "sem consumir tentativa" e o código
              // fazia o contrário: com o cron a cada 30 min, 2h30 de pausa
              // esgotavam as 5 tentativas e o anúncio saía da fila sem NUNCA
              // ter sido publicado.
              { increment: false },
            );
            continue;
          }

          try {
            const { ListingUseCase } =
              await import("../usecases/listing.usercase");
            const result = ehOlx
              ? await ListingUseCase.createOlxListing(
                  account?.userId || "",
                  cand.productId,
                  cand.requestedCategoryId || undefined,
                  account?.id,
                )
              : await ListingUseCase.createFacebookListing(
                  account?.userId || "",
                  cand.productId,
                  cand.requestedCategoryId || undefined,
                  account?.id,
                );
            if (!result.success) {
              // TETO DE TENTATIVAS.
              //
              // Diferente do branch da Shopee, createOlxListing e
              // createFacebookListing NÃO lançam: devolvem { success:false } e o
              // catch deles regrava `retryEnabled: true` com nextRetryAt de 60s.
              // Sem o bloco abaixo, uma recusa DEFINITIVA (preço suspeito, sem
              // vaga no plano, imagem pequena) voltaria a ser publicada a cada
              // 60 segundos, para sempre — ~1.440 chamadas/dia por anúncio.
              //
              // Classifica com o mesmo vocabulário já usado na remoção, para
              // erro permanente sair da fila na primeira vez.
              // ⚠️ O Error precisa carregar os SINAIS, não só o texto.
              //
              // Os classificadores decidem permanente vs. transitório lendo
              // `status` (5xx/429), `responseData.statusCode` (OLX) e
              // `responseData.error.code` (rate limit da Graph: 4/17/32/613),
              // além de `code` para ECONNRESET/ETIMEDOUT. Um `new Error(msg)`
              // nu deixa todos eles `undefined` e o DEFAULT dos dois
              // classificadores é "permanent" — então um 503 da OLX ou um rate
              // limit da Meta tirava o anúncio da fila para SEMPRE, que é o
              // oposto do que este bloco existe para fazer. Só as poucas
              // substrings ("timeout", "socket hang up") escapavam.
              const msg = result.error ?? "Erro desconhecido";
              const erroRico = new Error(msg);
              (erroRico as any).status = result.errorStatus;
              (erroRico as any).responseData = result.errorResponseData;
              (erroRico as any).code = result.errorCode;
              const classificacao = ehOlx
                ? classifyOlxRemoveError(erroRico)
                : classifyFacebookRemoveError(erroRico);
              const ehPermanente = classificacao.kind === "permanent";
              const attempts = (cand.retryAttempts || 0) + 1;
              const shouldRetry = !ehPermanente && attempts < MAX_ATTEMPTS;
              const nextDelay =
                BACKOFF_SECONDS[
                  Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)
                ];
              await ListingRepository.incrementRetryAttempts(cand.id, {
                lastError:
                  (ehPermanente ? "[TERMINAL] " : "") + msg.substring(0, 490),
                nextRetryAt: shouldRetry
                  ? new Date(Date.now() + nextDelay * 1000)
                  : null,
                retryEnabled: shouldRetry,
              });
              console.warn(
                `[ListingRetryService] retry ${nome} falhou para ${cand.id} (tentativa ${attempts}/${MAX_ATTEMPTS}${ehPermanente ? ", TERMINAL" : ""}): ${msg}`,
              );
            }
          } catch (err) {
            const msg = errMsg(err);
            console.error(
              `[ListingRetryService] exceção no retry ${nome} para ${cand.id}:`,
              msg,
            );
            const attempts = (cand.retryAttempts || 0) + 1;
            const shouldRetry = attempts < MAX_ATTEMPTS;
            const nextDelay =
              BACKOFF_SECONDS[
                Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)
              ];
            await ListingRepository.incrementRetryAttempts(cand.id, {
              lastError: msg.substring(0, 490),
              nextRetryAt: shouldRetry
                ? new Date(Date.now() + nextDelay * 1000)
                : null,
              retryEnabled: shouldRetry,
            });
          }
          continue;
        }

        // Só MERCADO_LIVRE segue no caminho ML: Magalu não pode enviar
        // seu token para api.mercadolibre.com (vazamento de token).
        // DESABILITA o retry ao pular: este é o único publish-retry e
        // claimRetryCandidate é agnóstico de plataforma — sem desligar, um
        // candidato Magalu/OLX/FB é reivindicado (write no banco) a cada ciclo,
        // p/ sempre, e nunca sai da fila.
        if (account?.platform && account.platform !== Platform.MERCADO_LIVRE) {
          console.log(
            `[ListingRetryService] skipping ${cand.id} (plataforma ${account.platform} não suportada pelo retry ML) — retry desabilitado`,
          );
          await ListingRepository.incrementRetryAttempts(cand.id, {
            retryEnabled: false,
            nextRetryAt: null,
            lastError: "[TERMINAL] plataforma sem retry",
          });
          continue;
        }

        if (!account || !account.accessToken) {
          console.log(
            `[ListingRetryService] skipping ${cand.id} (no account/token)`,
          );
          continue;
        }

        // Token do ML expirado: renovar antes de falar com a API.
        //
        // O fluxo interativo (ListingUseCase.createMLListing) já faz isso, e
        // por isso o cron raramente pegava token vencido: quando um anúncio
        // falha e entra na fila, o token acabou de ser renovado por lá. Mas o
        // cron também processa candidatos que ficaram parados (fila drenando
        // após um deploy, backlog reabilitado em lote) — aí o token pode ter
        // vencido no meio do caminho. Sem renovar, o capability check abaixo
        // falha, as tentativas se esgotam e o anúncio é desligado por token
        // vencido, não por problema no anúncio: um motivo falso no lugar do
        // outro que este serviço acabou de deixar de dar.
        //
        // Renova o objeto em memória (como createMLListing faz com `acc`), de
        // modo que os usos seguintes de account.accessToken peguem o valor
        // novo sem tocar em cada call site.
        if (account.expiresAt < new Date()) {
          try {
            console.log(
              `[ListingRetryService] ML token expirado (conta ${account.id}) — renovando`,
            );
            const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
              account.id,
              account.refreshToken,
            );
            await MarketplaceRepository.updateTokens(account.id, {
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
            });
            account.accessToken = refreshed.accessToken;
            account.refreshToken = refreshed.refreshToken;
          } catch (refreshErr) {
            // Deliberadamente NÃO marca a conta como ERROR (o createMLListing
            // marca). Um erro transitório de rede aqui derrubaria a conta para
            // todos os fluxos — sync, pedidos, mensagens — a partir de um cron
            // sem contexto de usuário. Reagenda: se o refreshToken estiver
            // mesmo inválido, as tentativas se esgotam e o anúncio para com uma
            // mensagem acionável, e a reconexão passa pelo fluxo interativo.
            const attempts = (cand.retryAttempts || 0) + 1;
            const shouldRetry = attempts < MAX_ATTEMPTS;
            const nextDelay =
              BACKOFF_SECONDS[
                Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)
              ];
            console.warn(
              `[ListingRetryService] falha ao renovar token da conta ${account.id}: ${errMsg(refreshErr)}`,
            );
            await ListingRepository.incrementRetryAttempts(cand.id, {
              lastError: `Token do Mercado Livre expirado e não foi possível renovar — reconecte a conta "${account.accountName || account.id}" em Integrações`,
              nextRetryAt: shouldRetry
                ? new Date(Date.now() + nextDelay * 1000)
                : null,
              retryEnabled: shouldRetry,
            });
            continue;
          }
        }

        // Quick capability check
        try {
          console.log(
            `[ListingRetryService] capability check for account ${account.id}`,
          );
          await MLApiService.getSellerItemIds(
            account.accessToken,
            String(account.externalUserId || account.userId),
            "active",
            1,
          );
        } catch (capErr) {
          console.log(
            `[ListingRetryService] capability check failed for ${cand.id}: ${errMsg(capErr)}`,
          );
          // schedule next retry
          const attempts = (cand.retryAttempts || 0) + 1;
          const nextDelay =
            BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
          await ListingRepository.incrementRetryAttempts(cand.id, {
            lastError: errMsg(capErr),
            nextRetryAt: new Date(Date.now() + nextDelay * 1000),
            retryEnabled: attempts < MAX_ATTEMPTS,
          });

          await SystemLogService.logError(
            "RETRY_LISTING" as any,
            `Capability check failed for placeholder ${cand.id} (scheduling retry): ${errMsg(capErr)}`,
            { resource: "ProductListing", resourceId: cand.id },
          );
          continue;
        }

        console.log(
          `[ListingRetryService] capability OK for ${cand.id}, delegando criação`,
        );

        const product = cand.product as any;

        // Guard terminal: stock/price inválidos nunca serão aceitos pelo ML
        // (item.stock.invalid / item.price.invalid). O createMLListing valida o
        // mesmo, mas retorna sem marcar terminal — o candidato gastaria os 5
        // ciclos de backoff para morrer no mesmo ponto. Cortar aqui poupa a
        // rotação até o usuário corrigir o cadastro.
        //
        // `cand.product` vem do `include: { product: true }` de
        // findPendingRetries, ou seja, é o Product CRU do Prisma: `price` é um
        // Decimal (typeof === "object"), não number. Comparar com
        // `typeof === "number"` reprovava TODO produto, com qualquer preço, e
        // marcava o anúncio como terminal com a mensagem falsa "price=0" —
        // sobrescrevendo o lastError real. Daí o Number() antes de comparar.
        const stockNum = Number(product.stock);
        const priceNum = Number(product.price);
        const hasValidStock = Number.isFinite(stockNum) && stockNum > 0;
        const hasValidPrice = Number.isFinite(priceNum) && priceNum > 0;
        if (!hasValidStock || !hasValidPrice) {
          const reason =
            !hasValidStock && !hasValidPrice
              ? "sem estoque e sem preço"
              : !hasValidStock
                ? "sem estoque (stock=0)"
                : "sem preço (price=0)";
          console.warn(
            `[ListingRetryService] skipping ${cand.id} permanently — produto ${reason}`,
          );
          await ListingRepository.incrementRetryAttempts(cand.id, {
            lastError: `[TERMINAL] Produto ${reason} — corrija no cadastro e recrie o anúncio`,
            nextRetryAt: null,
            retryEnabled: false,
          });
          continue;
        }

        // Criacao no ML: delegar para ListingUseCase.createMLListing — o mesmo
        // padrao que este servico ja usa para o Shopee acima.
        //
        // Ate aqui, este arquivo REIMPLEMENTAVA a criacao (payload, titulo,
        // descricao, atributos, upload de imagem, preflight, escada de retry).
        // A copia foi ficando para tras do original e acumulou defeitos que o
        // fluxo principal ja tinha resolvido: 5 variantes de createItem contra
        // 12, sem retry por categoria sugerida, mandando family_name junto com
        // title (o ML rejeita: UP flow nao aceita os dois), e reportando sempre
        // o erro da 1a tentativa. Medido em producao: 2 lotes piloto de 25
        // anuncios reabilitados, 0 publicados nos dois.
        //
        // Delegar herda tudo do original — escada completa, categoria sugerida,
        // compatibilidades, reconciliacao de listing_type e a mensagem
        // acionavel — e elimina a duplicacao que causava a divergencia.
        //
        // createMLListing REUSA a linha existente (findByProductAndAccount),
        // entao o placeholder deste candidato e atualizado no lugar.
        const { ListingUseCase } = await import("../usecases/listing.usercase");
        const result = await ListingUseCase.createMLListing(
          account.userId,
          cand.productId,
          cand.requestedCategoryId || undefined,
          account.id,
        );

        if (result.success) {
          console.log(
            `[ListingRetryService] ML retry succeeded for ${cand.id}: ${(result as any).externalListingId}`,
          );
          await SystemLogService.logError(
            "RETRY_LISTING" as any,
            `Placeholder ${cand.id} successfully posted to ML (${(result as any).externalListingId})`,
            { resource: "ProductListing", resourceId: cand.id },
          );
          continue;
        }

        // Falhou. O createMLListing ja gravou o erro na linha, mas reagenda com
        // `retryEnabled: true` fixo, sem olhar MAX_ATTEMPTS — e o loop infinito
        // que este servico existe para cortar. Reaplicamos o backoff daqui.
        //
        // Antes, relemos a linha DO CANDIDATO (pelo id — o par produto/conta
        // pode ter varias linhas): se o createMLListing classificou o erro como
        // TERMINAL (ex.: PolicyAgent, ou anuncio duplicado nesta conta), ele
        // deixa retryEnabled=false e nao devemos ressuscitar o candidato.
        const afterAttempt = await ListingRepository.findRetryStateById(
          cand.id,
        );
        if (afterAttempt && afterAttempt.retryEnabled === false) {
          console.warn(
            `[ListingRetryService] ML retry terminal for ${cand.id}: ${result.error}`,
          );
          continue;
        }

        const attempts = (cand.retryAttempts || 0) + 1;
        const shouldRetry = attempts < MAX_ATTEMPTS;
        const nextDelay =
          BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
        console.warn(
          `[ListingRetryService] ML retry failed for ${cand.id} (tentativa ${attempts}/${MAX_ATTEMPTS}): ${result.error}`,
        );
        await ListingRepository.incrementRetryAttempts(cand.id, {
          lastError: (result.error || "erro desconhecido").substring(0, 490),
          nextRetryAt: shouldRetry
            ? new Date(Date.now() + nextDelay * 1000)
            : null,
          retryEnabled: shouldRetry,
        });
      } catch (err) {
        // unexpected error
        try {
          // Respeita MAX_ATTEMPTS como os demais ramos: `retryEnabled: true`
          // fixo reagendava o candidato a cada 60s para sempre — o loop
          // infinito que o guard terminal acima existe para cortar.
          const attempts = (cand.retryAttempts || 0) + 1;
          const shouldRetry = attempts < MAX_ATTEMPTS;
          await ListingRepository.incrementRetryAttempts(cand.id, {
            lastError: errMsg(err),
            nextRetryAt: shouldRetry ? new Date(Date.now() + 60 * 1000) : null,
            retryEnabled: shouldRetry,
          });
        } catch (e) {
          /* ignore */
        }
        await SystemLogService.logError(
          "RETRY_LISTING" as any,
          `Unexpected error while retrying placeholder ${cand.id}: ${errMsg(err)}`,
          { resource: "ProductListing", resourceId: cand.id },
        );
      }
    }
  }

  static start(intervalMs = 60 * 1000) {
    if (this.running) return;
    this.running = true;
    this.intervalId = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
  }

  static stop() {
    if (this.intervalId) clearInterval(this.intervalId as NodeJS.Timeout);
    this.intervalId = null;
    this.running = false;
  }
}
