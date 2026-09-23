import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

/**
 * INTEGRAÇÃO com Postgres REAL — travas anti-duplicata da publicação no ML.
 *
 * Os specs unitários mockam o repositório; aqui ele é o de verdade, contra um
 * banco descartável. Prova que as instruções condicionais são atômicas no
 * Postgres e que, sob concorrência real (Promise.all), sai UM POST /items por
 * produto e conta. O Mercado Livre é stub (nada sai para a internet).
 *
 * Só roda com DEXO_IT_DATABASE_URL apontando para um banco LOCAL cujo nome
 * contém "dexo_it" (ex.: container Docker descartável). Sem ela, é pulado.
 *
 *   docker run -d --name dexo-it-pg -e POSTGRES_USER=dexo -e POSTGRES_PASSWORD=dexo_it_local \
 *     -e POSTGRES_DB=dexo_it -e PGDATA=/pgdata --tmpfs /pgdata:rw,size=1g \
 *     -p 127.0.0.1:55432:5432 postgres:16 -c fsync=off -c max_connections=200
 *   DATABASE_URL=… DIRECT_URL=… prisma db push --skip-generate   (NO BANCO LOCAL)
 *   DEXO_IT_DATABASE_URL=postgresql://dexo:dexo_it_local@127.0.0.1:55432/dexo_it \
 *     npx vitest run --pool=forks --no-file-parallelism tests/it
 *
 * `--no-file-parallelism`: os arquivos de tests/it dividem o banco, e o cron
 * (findPendingRetries) é global — em paralelo, um arquivo pegaria as linhas
 * do outro.
 */

const IT_URL = process.env.DEXO_IT_DATABASE_URL ?? "";

// ─── Ambiente ANTES de qualquer import da aplicação ─────────────────────────
// O Prisma deste ambiente injeta o .env do checkout principal (produção) em
// toda chave que ainda não existe — por isso tudo é fixado aqui, e o banco é
// conferido depois do import.
const HOST_OK = /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(IT_URL);
const NOME_OK = /\/[^/?]*dexo_it[^/?]*(\?|$)/.test(IT_URL);
if (IT_URL && HOST_OK && NOME_OK) {
  process.env.DATABASE_URL = IT_URL;
  process.env.DIRECT_URL = IT_URL;
  process.env.PRISMA_CONNECTION_LIMIT = "20";
  process.env.ML_API_URL = "http://127.0.0.1:9";
  process.env.ML_AUTH_URL = "http://127.0.0.1:9";
  process.env.APP_BACKEND_URL = "http://127.0.0.1:9";
  process.env.HTTP_PROXY = "http://127.0.0.1:9";
  process.env.HTTPS_PROXY = "http://127.0.0.1:9";
  process.env.NO_PROXY = "127.0.0.1,localhost";
  process.env.ML_FAMILY_NAME_ALLOWLIST = "";
  process.env.ML_NO_TITLE_WITH_FAMILY = "";
  process.env.EMAIL_ENABLED = "false";
  process.env.LISTING_STATUS_SYNC_DISABLED = "0";
  process.env.BACKGROUND_WORKERS_DISABLED = "1";
  process.env.ML_REQUIRED_ATTRS_BLOCK = "";
}

// ─── Mercado Livre: stubs de rede; helpers puros continuam os originais ─────
const ml = vi.hoisted(() => {
  const estado = {
    criados: 0,
    segurar: null as Promise<void> | null,
    naBusca: [] as any[],
  };
  const stubs: Record<string, any> = {
    getSellerItemIds: async () => [],
    suggestCategoryId: async () => null,
    createItem: async (_tok: string, payload: any) => {
      estado.criados += 1;
      const n = estado.criados;
      if (estado.segurar) await estado.segurar;
      return {
        id: `MLB${900000 + n}`,
        permalink: `https://produto.mercadolivre.com.br/MLB-${900000 + n}`,
        status: "active",
        listing_type_id: payload?.listing_type_id,
        title: payload?.title ?? payload?.family_name ?? "",
      };
    },
    changeListingType: async () => ({}),
    upsertDescription: async () => ({}),
    updateItem: async () => ({}),
    getItemDetails: async () => ({ status: "active", sub_status: [] }),
    uploadPicture: async () => ({ id: "pic" }),
    uploadPictureFromUrl: async () => ({ id: "pic" }),
    findItemsBySellerSku: async () => estado.naBusca,
    applyCompatibilitiesVerified: async (_t: string, _i: string, vehicles: any[]) => ({
      ok: true,
      strategy: "catalog_products",
      requested: vehicles.length,
      persisted: vehicles.length * 3,
      verified: true,
      unresolved: [],
      errors: [],
      budgetExhausted: false,
      userProductId: null,
      catalogResolved: vehicles.length * 3,
    }),
  };
  const chamadas: Record<string, number> = {};
  return { estado, stubs, chamadas };
});

vi.mock("../../app/marketplaces/services/ml-api.service", async (importOriginal) => {
  const orig: any = await importOriginal();
  const Original = orig.MLApiService;
  const Stubbed = new Proxy(Original, {
    get(t, k, r) {
      if (typeof k === "string" && k in ml.stubs) {
        ml.chamadas[k] = (ml.chamadas[k] ?? 0) + 1;
        return ml.stubs[k];
      }
      return Reflect.get(t, k, r);
    },
  });
  return { ...orig, MLApiService: Stubbed };
});

vi.mock("../../app/marketplaces/services/ml-oauth.service", () => ({
  MLOAuthService: {
    getUserInfo: vi.fn(async () => ({ id: 123456, tags: [] })),
    refreshAccessTokenForAccount: vi.fn(async () => {
      throw new Error("renovação de token não deveria acontecer no teste");
    }),
  },
}));

vi.mock("../../app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn(async () => undefined),
    logWarning: vi.fn(async () => undefined),
    logInfo: vi.fn(async () => undefined),
    log: vi.fn(async () => undefined),
  },
}));

vi.mock("../../app/marketplaces/services/category-resolution.service", () => ({
  CategoryResolutionService: {
    resolveMLCategory: vi.fn(async ({ explicitCategoryId }: any) => ({
      externalId: explicitCategoryId || "MLB46723",
      fullPath: "Acessórios para Veículos > Peças",
      source: "explicit",
    })),
    ensureLeafLocalOnly: vi.fn(async () => null),
    assertWithinVehicleRoot: vi.fn(async () => ({ ok: true, reason: "ok" })),
    assertConditionCoherent: vi.fn(async () => ({ ok: true, reason: "unknown" })),
  },
  getVehicleRootSet: vi.fn(async () => new Set()),
}));

// ─── Utilidades ──────────────────────────────────────────────────────────────
type Mod = {
  prisma: any;
  ListingUseCase: any;
  ListingRepository: any;
  ListingRetryService: any;
  listingRoutes: any;
  fastify: any;
};
let M: Mod;
let seq = 0;

/** Barreira: solta quando `n` chegarem (ou no timeout, sem travar o teste). */
function barreira(n: number, timeoutMs = 5_000) {
  let chegaram = 0;
  let abrir: () => void = () => {};
  const aberta = new Promise<void>((r) => (abrir = r));
  const t = setTimeout(() => abrir(), timeoutMs);
  return async () => {
    chegaram += 1;
    if (chegaram >= n) {
      clearTimeout(t);
      abrir();
    }
    await aberta;
  };
}

/** Segura o createItem até `soltar()`. */
function segurarCreateItem() {
  let soltar: () => void = () => {};
  ml.estado.segurar = new Promise<void>((r) => (soltar = r));
  return () => {
    ml.estado.segurar = null;
    soltar();
  };
}

/**
 * Limpeza GLOBAL de propósito: o cron (runPass → findPendingRetries) varre o
 * banco inteiro, então qualquer linha agendada de fora deste arquivo seria
 * publicada no meio de um teste e contaria nos POSTs. Só é seguro porque o
 * arquivo recusa qualquer banco que não seja o local "dexo_it" (acima).
 */
async function limparBanco() {
  const p = M.prisma;
  await p.stockSyncJob.deleteMany({});
  await p.productListing.deleteMany({});
  await p.productCompatibility.deleteMany({});
  await p.product.deleteMany({});
  await p.marketplaceAccount.deleteMany({});
  await p.user.deleteMany({ where: { email: { endsWith: "@dexo-it.test" } } });
}

async function semear(opts: { comCompat?: boolean } = {}) {
  seq += 1;
  const p = M.prisma;
  const user = await p.user.create({
    data: { email: `it-${Date.now()}-${seq}@dexo-it.test`, password: "x", name: "IT" },
  });
  const acc = await p.marketplaceAccount.create({
    data: {
      userId: user.id,
      platform: "MERCADO_LIVRE",
      accountName: `LOJA IT ${seq}`,
      accessToken: "tok-it",
      refreshToken: "ref-it",
      expiresAt: new Date(Date.now() + 3600_000),
      status: "ACTIVE",
      externalUserId: `it-seller-${Date.now()}-${seq}`,
    },
  });
  const product = await p.product.create({
    data: {
      userId: user.id,
      sku: `IT-${seq}`,
      skuNormalized: `it-${seq}`,
      name: "Farol Dianteiro Esquerdo Gol G5",
      price: 350,
      stock: 3,
      imageUrl: "/uploads/it.jpg",
      imageUrls: [],
      heightCm: 20,
      widthCm: 30,
      lengthCm: 40,
      weightKg: 2,
      ...(opts.comCompat
        ? {
            compatibilityPositions: ["Dianteira", "Esquerda"],
            compatibilities: {
              create: [{ brand: "Volkswagen", model: "Gol", yearFrom: 2009, yearTo: 2012 }],
            },
          }
        : {}),
    },
  });
  return { user, acc, product };
}

async function linha(productId: string, accId: string, over: Record<string, unknown> = {}) {
  return M.prisma.productListing.create({
    data: {
      productId,
      marketplaceAccountId: accId,
      externalListingId: `PENDING_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: "error",
      retryEnabled: false,
      nextRetryAt: null,
      retryAttempts: 0,
      lastError: "[TERMINAL][CORRIGIVEL] O campo GTIN aceita só código de barras.",
      requestedCategoryId: "MLB46723",
      listingType: "gold_special",
      createdAt: new Date(Date.now() - 3600_000),
      ...over,
    },
  });
}

const publicar = (s: { user: any; acc: any; product: any }) =>
  M.ListingUseCase.createMLListing(s.user.id, s.product.id, "MLB46723", s.acc.id);

async function linhasDoPar(productId: string, accId: string) {
  return M.prisma.productListing.findMany({
    where: { productId, marketplaceAccountId: accId },
    orderBy: { createdAt: "asc" },
  });
}

function montarRota() {
  const app = M.fastify();
  return app
    .register(M.listingRoutes, { prefix: "/listings" })
    .then(() => app);
}

// ─── Suíte ───────────────────────────────────────────────────────────────────
describe.skipIf(!(IT_URL && HOST_OK && NOME_OK))(
  "IT (Postgres real) — travas anti-duplicata da publicação no ML",
  () => {
    beforeAll(async () => {
      const prisma = (await import("../../app/lib/prisma")).default;
      const [{ current_database: banco }] = await prisma.$queryRaw<
        Array<{ current_database: string }>
      >`SELECT current_database()`;
      if (!/dexo_it/.test(banco)) {
        throw new Error(`banco inesperado: ${banco} — abortando`);
      }
      const fx = await import("fs");
      const path = await import("path");
      const bruto = JSON.parse(
        fx.readFileSync(
          path.resolve(__dirname, "../fixtures/ml-category-attributes/MLB46723.raw.json"),
          "utf8",
        ),
      );
      ml.stubs.getCategoryAttributes = async () => bruto;
      M = {
        prisma,
        ListingUseCase: (await import("../../app/marketplaces/usecases/listing.usercase"))
          .ListingUseCase,
        ListingRepository: (
          await import("../../app/marketplaces/repositories/listing.repository")
        ).ListingRepository,
        ListingRetryService: (
          await import("../../app/marketplaces/services/listing-retry.service")
        ).ListingRetryService,
        listingRoutes: (await import("../../app/routes/listing.routes")).listingRoutes,
        fastify: (await import("fastify")).default,
      };
      // Sem fotos: o upload não é o que está em teste.
      vi.spyOn(M.ListingUseCase as any, "collectProductImageUrls").mockReturnValue([]);
      for (const m of ["log", "warn", "info", "debug"] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
      }
    });

    beforeEach(async () => {
      ml.estado.criados = 0;
      ml.estado.segurar = null;
      ml.estado.naBusca = [];
      delete process.env.ML_RETRY_BUTTON_WAIT_MS;
      await limparBanco();
    });

    afterAll(async () => {
      if (M?.prisma) {
        await limparBanco();
        await M.prisma.$disconnect();
      }
    });

    // ── Premissas do Postgres que as travas usam ────────────────────────────
    it("premissa: o horário da reserva volta do banco com o mesmo milissegundo", async () => {
      const s = await semear();
      const l = await linha(s.product.id, s.acc.id);
      const at = await M.ListingRepository.claimInteractiveRetry(l.id, 600_000);
      const lida = await M.prisma.productListing.findUnique({ where: { id: l.id } });
      expect(lida.nextRetryAt.getTime()).toBe(at.getTime());
    });

    it("premissa: updateMany (claim) atualiza o updatedAt — base das gravações condicionais", async () => {
      const s = await semear();
      const l = await linha(s.product.id, s.acc.id, {
        retryEnabled: true,
        nextRetryAt: new Date(Date.now() - 1000),
      });
      const antes = l.updatedAt.getTime();
      await new Promise((r) => setTimeout(r, 15));
      await M.ListingRepository.claimRetryCandidate(l.id, 600_000, { markPublishing: true });
      const depois = (await M.prisma.productListing.findUnique({ where: { id: l.id } }))
        .updatedAt.getTime();
      expect(depois).toBeGreaterThan(antes);
    });

    // ── 1ª publicação ────────────────────────────────────────────────────────
    it(
      "1ª publicação: 5 'Anunciar' simultâneos do mesmo produto e conta ⇒ UM POST /items e UMA linha",
      async () => {
        const s = await semear();
        const soltar = segurarCreateItem();
        const corrida = Promise.all(Array.from({ length: 5 }, () => publicar(s)));
        await new Promise((r) => setTimeout(r, 1500));
        soltar();
        const res = await corrida;
        expect(ml.estado.criados).toBe(1);
        expect(res.filter((r: any) => r.success)).toHaveLength(1);
        for (const r of res.filter((x: any) => !x.success)) {
          expect(r.skipped).toBe(true);
        }
        const ls = await linhasDoPar(s.product.id, s.acc.id);
        expect(ls).toHaveLength(1);
        expect(ls[0].externalListingId).toMatch(/^MLB/);
        expect(ls[0].nextRetryAt).toBeNull();
      },
      45_000,
    );

    it(
      "1ª publicação, janela forçada: as 5 leem 'nenhuma linha' ANTES de qualquer uma gravar ⇒ o lock deixa UMA criar",
      async () => {
        const s = await semear();
        const orig = M.ListingRepository.findByProductAndAccount.bind(M.ListingRepository);
        const todasLeram = barreira(5);
        const spy = vi
          .spyOn(M.ListingRepository, "findByProductAndAccount")
          .mockImplementation(async (...a: any[]) => {
            const r = await orig(...a);
            await todasLeram();
            return r;
          });
        try {
          const res = await Promise.all(Array.from({ length: 5 }, () => publicar(s)));
          expect(ml.estado.criados).toBe(1);
          expect(res.filter((r: any) => r.success)).toHaveLength(1);
          // Cada perdedor recua SEM POST: ou a linha da outra ainda está em
          // andamento, ou ela já terminou (anúncio vivo) — nos dois casos,
          // nenhuma linha nova.
          for (const r of res.filter((x: any) => !x.success)) {
            expect(r.skipped).toBe(true);
            expect(
              r.code === "PUBLICATION_IN_PROGRESS" || /já tem anúncio/.test(r.error),
            ).toBe(true);
          }
          expect(await linhasDoPar(s.product.id, s.acc.id)).toHaveLength(1);
        } finally {
          spy.mockRestore();
        }
      },
      45_000,
    );

    it(
      "escalonado: B começa com A preso no POST ⇒ B recua na checagem do começo (sem montar o anúncio)",
      async () => {
        const s = await semear();
        const soltar = segurarCreateItem();
        const a = publicar(s);
        await vi.waitFor(() => expect(ml.estado.criados).toBe(1), { timeout: 15_000 });
        const b = await publicar(s);
        expect(b.success).toBe(false);
        expect(b.code).toBe("PUBLICATION_IN_PROGRESS");
        soltar();
        expect((await a).success).toBe(true);
        expect(ml.estado.criados).toBe(1);
      },
      45_000,
    );

    // ── Botão × Anunciar × cron ─────────────────────────────────────────────
    it(
      "botão 'Tentar publicar novamente' + 'Anunciar' simultâneos sobre pendente livre ⇒ UM POST",
      async () => {
        const s = await semear();
        const l = await linha(s.product.id, s.acc.id);
        const app = await montarRota();
        try {
          const [resp, anunciar] = await Promise.all([
            app.inject({
              method: "POST",
              url: `/listings/${l.id}/retry-ml`,
              headers: { email: s.user.email },
            }),
            publicar(s),
          ]);
          expect(ml.estado.criados).toBe(1);
          const ok =
            (resp.statusCode === 200 ? 1 : 0) + (anunciar.success ? 1 : 0);
          expect(ok).toBe(1);
          const ls = await linhasDoPar(s.product.id, s.acc.id);
          expect(ls).toHaveLength(1);
          expect(ls[0].externalListingId).toMatch(/^MLB/);
        } finally {
          await app.close();
        }
      },
      45_000,
    );

    it(
      "dois cliques simultâneos no botão ⇒ um publica, o outro recebe 409; UM POST",
      async () => {
        const s = await semear();
        const l = await linha(s.product.id, s.acc.id);
        const app = await montarRota();
        try {
          const req = () =>
            app.inject({
              method: "POST",
              url: `/listings/${l.id}/retry-ml`,
              headers: { email: s.user.email },
            });
          const [r1, r2] = await Promise.all([req(), req()]);
          expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
          expect(ml.estado.criados).toBe(1);
        } finally {
          await app.close();
        }
      },
      45_000,
    );

    it(
      "dois crons (dois processos) sobre a mesma linha agendada ⇒ UM POST; o outro pula",
      async () => {
        const s = await semear();
        await linha(s.product.id, s.acc.id, {
          retryEnabled: true,
          nextRetryAt: new Date(Date.now() - 1000),
          lastError: "Instabilidade no Mercado Livre (503).",
          retryAttempts: 1,
        });
        await Promise.all([
          (M.ListingRetryService as any).runPass(),
          (M.ListingRetryService as any).runPass(),
        ]);
        expect(ml.estado.criados).toBe(1);
        const [l] = await linhasDoPar(s.product.id, s.acc.id);
        expect(l.externalListingId).toMatch(/^MLB/);
        expect(l.status).toBe("active");
      },
      45_000,
    );

    it(
      "cron publicando + 'Anunciar' na mesma linha ⇒ o Anunciar recua (linha marcada 'pending' pelo claim); UM POST",
      async () => {
        const s = await semear();
        await linha(s.product.id, s.acc.id, {
          retryEnabled: true,
          nextRetryAt: new Date(Date.now() - 1000),
          lastError: "Instabilidade no Mercado Livre (503).",
        });
        const soltar = segurarCreateItem();
        const cron = (M.ListingRetryService as any).runPass();
        await vi.waitFor(() => expect(ml.estado.criados).toBe(1), { timeout: 15_000 });
        const [durante] = await linhasDoPar(s.product.id, s.acc.id);
        expect(durante.status).toBe("pending");
        const anunciar = await publicar(s);
        expect(anunciar.code).toBe("PUBLICATION_IN_PROGRESS");
        soltar();
        await cron;
        expect(ml.estado.criados).toBe(1);
        const [depois] = await linhasDoPar(s.product.id, s.acc.id);
        expect(depois.externalListingId).toMatch(/^MLB/);
        expect(depois.status).toBe("active");
      },
      45_000,
    );

    it(
      "linha só AGENDADA (re-arme da edição): o 'Anunciar' ASSUME e publica; o cron depois não publica de novo",
      async () => {
        const s = await semear();
        await linha(s.product.id, s.acc.id, {
          retryEnabled: true,
          nextRetryAt: new Date(Date.now() + 5 * 60_000),
        });
        const r = await publicar(s);
        expect(r.success).toBe(true);
        await (M.ListingRetryService as any).runPass();
        expect(ml.estado.criados).toBe(1);
        const ls = await linhasDoPar(s.product.id, s.acc.id);
        expect(ls).toHaveLength(1);
        expect(ls[0].retryEnabled).toBe(false);
      },
      45_000,
    );

    it(
      "cron + 'Anunciar' disputando a MESMA linha agendada e vencida, ao mesmo tempo ⇒ UM POST",
      async () => {
        const s = await semear();
        await linha(s.product.id, s.acc.id, {
          retryEnabled: true,
          nextRetryAt: new Date(Date.now() - 1000),
          lastError: "Instabilidade no Mercado Livre (503).",
        });
        await Promise.all([(M.ListingRetryService as any).runPass(), publicar(s)]);
        expect(ml.estado.criados).toBe(1);
        const ls = await linhasDoPar(s.product.id, s.acc.id);
        expect(ls).toHaveLength(1);
        expect(ls[0].externalListingId).toMatch(/^MLB/);
      },
      45_000,
    );

    // ── Reservas atômicas: 100 rodadas ────────────────────────────────────────
    it(
      "100 rodadas: assumir × claim do cron × reserva do botão na mesma linha agendada ⇒ exatamente UM vence",
      async () => {
        const s = await semear();
        const l = await linha(s.product.id, s.acc.id);
        for (let i = 0; i < 100; i++) {
          await M.prisma.productListing.update({
            where: { id: l.id },
            data: {
              retryEnabled: true,
              nextRetryAt: new Date(Date.now() - 1000),
              status: "error",
              lastError: "Instabilidade no Mercado Livre (503).",
            },
          });
          const [assumiu, cron, botao] = await Promise.all([
            M.ListingRepository.takeOverScheduledRetry(l.id, 600_000),
            M.ListingRepository.claimRetryCandidate(l.id, 600_000, { markPublishing: true }),
            M.ListingRepository.claimInteractiveRetry(l.id, 600_000),
          ]);
          const vencedores = [assumiu, cron].filter(Boolean).length;
          expect(vencedores).toBe(1);
          expect(botao).toBeNull();
          const final = await M.prisma.productListing.findUnique({ where: { id: l.id } });
          if (assumiu) {
            expect(final.retryEnabled).toBe(false);
            expect(final.status).toBe("error");
          } else {
            expect(final.retryEnabled).toBe(true);
            expect(final.status).toBe("pending");
          }
        }
      },
      60_000,
    );

    // ── Devoluções ───────────────────────────────────────────────────────────
    it(
      "status 'pending' do claim do cron é devolvido mesmo quando a criação sai sem gravar",
      async () => {
        const s = await semear();
        await M.prisma.product.update({ where: { id: s.product.id }, data: { imageUrl: null } });
        await linha(s.product.id, s.acc.id, {
          retryEnabled: true,
          nextRetryAt: new Date(Date.now() - 1000),
          lastError: "Instabilidade no Mercado Livre (503).",
        });
        await (M.ListingRetryService as any).runPass();
        const [l] = await linhasDoPar(s.product.id, s.acc.id);
        expect(l.status).not.toBe("pending");
        expect(ml.estado.criados).toBe(0);
      },
      45_000,
    );

    it(
      "erro inesperado depois de ASSUMIR a linha agendada ⇒ ela volta à fila do cron (retry religado)",
      async () => {
        const s = await semear();
        const l = await linha(s.product.id, s.acc.id, {
          retryEnabled: true,
          nextRetryAt: new Date(Date.now() + 5 * 60_000),
        });
        const spy = vi
          .spyOn(M.ListingUseCase as any, "sanitizePackageDimensions")
          .mockImplementation(() => {
            throw new Error("inesperado");
          });
        try {
          const r = await publicar(s);
          expect(r.success).toBe(false);
        } finally {
          spy.mockRestore();
        }
        const lida = await M.prisma.productListing.findUnique({ where: { id: l.id } });
        expect(lida.retryEnabled).toBe(true);
        expect(lida.nextRetryAt.getTime()).toBeGreaterThan(Date.now());
        expect(ml.estado.criados).toBe(0);
      },
      45_000,
    );

    // ── Botão: resposta 202 com a publicação ainda rodando ────────────────────
    it(
      "botão responde 202 com o POST preso; 2º clique 409; 'Anunciar' recua; ao soltar, UM anúncio e reserva limpa",
      async () => {
        process.env.ML_RETRY_BUTTON_WAIT_MS = "200";
        const s = await semear();
        const l = await linha(s.product.id, s.acc.id);
        const app = await montarRota();
        const soltar = segurarCreateItem();
        try {
          const r1 = await app.inject({
            method: "POST",
            url: `/listings/${l.id}/retry-ml`,
            headers: { email: s.user.email },
          });
          expect(r1.statusCode).toBe(202);
          const r2 = await app.inject({
            method: "POST",
            url: `/listings/${l.id}/retry-ml`,
            headers: { email: s.user.email },
          });
          expect(r2.statusCode).toBe(409);
          const anunciar = await publicar(s);
          expect(anunciar.code).toBe("PUBLICATION_IN_PROGRESS");
          soltar();
          await vi.waitFor(
            async () => {
              const lida = await M.prisma.productListing.findUnique({ where: { id: l.id } });
              expect(lida.externalListingId).toMatch(/^MLB/);
              expect(lida.nextRetryAt).toBeNull();
            },
            { timeout: 15_000, interval: 100 },
          );
          expect(ml.estado.criados).toBe(1);
        } finally {
          soltar();
          await app.close();
        }
      },
      45_000,
    );

    // ── Re-arme da edição × reserva ───────────────────────────────────────────
    it("re-arme da edição não pega linha reservada; depois de liberada, pega", async () => {
      const s = await semear();
      const l = await linha(s.product.id, s.acc.id, {
        updatedAt: new Date(Date.now() - 3600_000),
      });
      const at = await M.ListingRepository.claimInteractiveRetry(l.id, 600_000);
      expect(at).toBeInstanceOf(Date);
      expect(await M.ListingRepository.rearmCorrectableMlPlaceholders(s.product.id, 300_000)).toBe(0);
      await M.ListingRepository.releaseInteractiveRetry(l.id, at);
      expect(await M.ListingRepository.rearmCorrectableMlPlaceholders(s.product.id, 300_000)).toBe(1);
    });

    // ── Adoção ───────────────────────────────────────────────────────────────
    it(
      "cron adota o item que já existia no ML ⇒ nenhum POST; compatibilidade enviada e job de estoque na fila",
      async () => {
        const s = await semear({ comCompat: true });
        const l = await linha(s.product.id, s.acc.id, {
          retryEnabled: true,
          nextRetryAt: new Date(Date.now() - 1000),
          lastError: "[VERIFICAR] O Mercado Livre não respondeu a tempo.",
        });
        ml.estado.naBusca = [
          {
            id: "MLB555000",
            status: "active",
            title: "Farol Dianteiro Esquerdo Gol G5",
            dateCreated: new Date(Date.now() - 1000).toISOString(),
            permalink: "https://produto.mercadolivre.com.br/MLB-555000",
            sellerCustomField: s.product.sku,
          },
        ];
        await (M.ListingRetryService as any).runPass();
        expect(ml.estado.criados).toBe(0);
        const lida = await M.prisma.productListing.findUnique({ where: { id: l.id } });
        expect(lida.externalListingId).toBe("MLB555000");
        expect(lida.status).toBe("active");
        expect((lida.compatDiagnostics as any)?.origin).toBe("adoption");
        const jobs = await M.prisma.stockSyncJob.findMany({ where: { listingId: l.id } });
        expect(jobs).toHaveLength(1);
        expect(jobs[0].targetStock).toBe(3);
      },
      45_000,
    );
  },
);
