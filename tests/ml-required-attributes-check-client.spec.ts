import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  postMlRequiredAttributesCheck,
  fetchMlRequiredAttrsEnabled,
  getKnownMlRequiredAttrsEnabled,
  checkMlRequiredAttributes,
  shouldBlockMlDraft,
  createMlCheckSequencer,
  mlLoteSemNadaParaEnviar,
  resolveMlExclusionsForSubmit,
  countRetryableBulkFailures,
  mlRequiredCheckKey,
  _resetMlRequiredStatusCache,
  ML_REQUIRED_CHECK_TIMEOUT_MS,
  type MlRequiredCheckItem,
  type MlRequiredCheckResult,
} from "../app/produtos/components/ml-required-attributes-check.client";

/**
 * Cliente do front: fail-open em tudo (null = não validar), lotes de 200,
 * timeout de 8 s, e com a checagem desligada nenhum POST.
 */

const BASE = "http://api.test";
const resposta = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as any;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetMlRequiredStatusCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const itens = (n: number): MlRequiredCheckItem[] =>
  Array.from({ length: n }, (_, i) => ({ key: `p${i}`, productId: `p${i}` }));

describe("postMlRequiredAttributesCheck", () => {
  it("K1: enabled:false → null", async () => {
    fetchMock.mockResolvedValue(resposta(200, { enabled: false, results: [] }));
    expect(await postMlRequiredAttributesCheck(BASE, "a@b", itens(1))).toBeNull();
  });

  it("K2: fetch lança → null (nunca lança)", async () => {
    fetchMock.mockRejectedValue(new Error("rede"));
    await expect(
      postMlRequiredAttributesCheck(BASE, "a@b", itens(2)),
    ).resolves.toBeNull();
  });

  it("K3: 450 itens → 3 POSTs de até 200 e Map com 450 chaves", async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const { items } = JSON.parse(init.body);
      return resposta(200, {
        enabled: true,
        results: items.map((i: any) => ({
          key: i.key,
          status: "ok",
          categoryId: null,
          blocking: [],
          warnings: [],
          message: null,
        })),
      });
    });
    const out = await postMlRequiredAttributesCheck(BASE, "a@b", itens(450));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const tamanhos = fetchMock.mock.calls.map(
      (c: any[]) => JSON.parse(c[1].body).items.length,
    );
    expect(tamanhos).toEqual([200, 200, 50]);
    expect(out?.size).toBe(450);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/marketplace/ml/required-attributes/check`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json", email: "a@b" });
  });

  it("K4: 500 (ou 404 da API antiga) → null", async () => {
    fetchMock.mockResolvedValue(resposta(500, { error: "x" }));
    expect(await postMlRequiredAttributesCheck(BASE, "a@b", itens(1))).toBeNull();
    fetchMock.mockResolvedValue(resposta(404, {}));
    expect(await postMlRequiredAttributesCheck(BASE, "a@b", itens(1))).toBeNull();
  });

  it("lista vazia → Map vazio sem request", async () => {
    const out = await postMlRequiredAttributesCheck(BASE, "a@b", []);
    expect(out?.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("D5: request pendurado → null depois de 8 s (não trava o envio)", async () => {
    vi.useFakeTimers();
    let sinal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: string, init: any) =>
        new Promise(() => {
          sinal = init.signal;
        }),
    );
    const pendente = postMlRequiredAttributesCheck(BASE, "a@b", itens(1));
    await vi.advanceTimersByTimeAsync(ML_REQUIRED_CHECK_TIMEOUT_MS + 10);
    await expect(pendente).resolves.toBeNull();
    expect(sinal?.aborted).toBe(true);
  });
});

describe("fetchMlRequiredAttrsEnabled / checkMlRequiredAttributes", () => {
  it("D5: aquecida desligada → o envio não faz POST nem GET", async () => {
    fetchMock.mockResolvedValue(resposta(200, { enabled: false }));
    await fetchMlRequiredAttrsEnabled(BASE, "a@b");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE}/marketplace/ml/required-attributes/status`,
    );
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    const out = await checkMlRequiredAttributes(BASE, "a@b", itens(3));
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("D5: sessão aberta há 180 s com a checagem desligada → o envio NÃO refaz o GET (1 fetch no total)", async () => {
    fetchMock.mockResolvedValue(resposta(200, { enabled: false }));
    const t0 = Date.now();
    await fetchMlRequiredAttrsEnabled(BASE, "a@b", t0);
    vi.useFakeTimers();
    vi.setSystemTime(t0 + 180_000);
    const out = await checkMlRequiredAttributes(BASE, "a@b", itens(1));
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("D5: status ainda sem resposta (GET pendurado) → o envio devolve null na hora, sem esperar", async () => {
    // Timers falsos e nunca avançados: o timeout de 8 s do GET não dispara.
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    void fetchMlRequiredAttrsEnabled(BASE, "a@b");
    let resolvido = false;
    const p = checkMlRequiredAttributes(BASE, "a@b", itens(1)).then((v) => {
      resolvido = true;
      return v;
    });
    // Só microtarefas: nenhum timer avançado, nenhum fetch respondido.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolvido).toBe(true);
    await expect(p).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("D5: sem aquecimento nenhum → null e nenhum fetch", async () => {
    const out = await checkMlRequiredAttributes(BASE, "a@b", itens(1));
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revalidação: o último valor conhecido vale enquanto o GET novo não volta", async () => {
    fetchMock.mockResolvedValueOnce(resposta(200, { enabled: true }));
    const t0 = 1_000_000;
    await fetchMlRequiredAttrsEnabled(BASE, "a@b", t0);
    expect(getKnownMlRequiredAttrsEnabled(BASE, "a@b")).toBe(true);
    let responder: (r: any) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (responder = resolve)),
    );
    const refresh = fetchMlRequiredAttrsEnabled(BASE, "a@b", t0 + 61_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getKnownMlRequiredAttrsEnabled(BASE, "a@b")).toBe(true);
    responder(resposta(200, { enabled: false }));
    await refresh;
    expect(getKnownMlRequiredAttrsEnabled(BASE, "a@b")).toBe(false);
    // Outro usuário não herda o valor.
    expect(getKnownMlRequiredAttrsEnabled(BASE, "outro@b")).toBeNull();
  });

  it("aquecimento: status em cache por 60 s (várias aberturas, um GET)", async () => {
    fetchMock.mockResolvedValue(resposta(200, { enabled: false }));
    const t0 = 1_000_000;
    await fetchMlRequiredAttrsEnabled(BASE, "a@b", t0);
    await fetchMlRequiredAttrsEnabled(BASE, "a@b", t0 + 30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchMlRequiredAttrsEnabled(BASE, "a@b", t0 + 61_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Outro usuário não reaproveita o cache.
    await fetchMlRequiredAttrsEnabled(BASE, "outro@b", t0 + 61_500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("status com erro/404/timeout → false", async () => {
    fetchMock.mockResolvedValue(resposta(404, {}));
    expect(await fetchMlRequiredAttrsEnabled(BASE, "a@b")).toBe(false);
    _resetMlRequiredStatusCache();
    fetchMock.mockRejectedValue(new Error("rede"));
    expect(await fetchMlRequiredAttrsEnabled(BASE, "a@b")).toBe(false);
    _resetMlRequiredStatusCache();
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const p = fetchMlRequiredAttrsEnabled(BASE, "a@b");
    await vi.advanceTimersByTimeAsync(ML_REQUIRED_CHECK_TIMEOUT_MS + 10);
    await expect(p).resolves.toBe(false);
  });

  it("ligada (aquecida) → o envio faz só o POST com os itens", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/status")
        ? resposta(200, { enabled: true })
        : resposta(200, {
            enabled: true,
            results: [
              {
                key: "draft",
                status: "blocked",
                categoryId: "MLB1",
                blocking: [],
                warnings: [],
                message: "falta",
              },
            ],
          }),
    );
    await fetchMlRequiredAttrsEnabled(BASE, "a@b");
    const out = await checkMlRequiredAttributes(BASE, "a@b", [
      { key: "draft", product: { name: "x" } },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${BASE}/marketplace/ml/required-attributes/check`,
    );
    expect(out?.get("draft")?.status).toBe("blocked");
  });
});

// ──────────────────────────────────────────────────────────
// Decisões que o modal e o wizard só ORQUESTRAM. Ficam aqui (node) porque a
// suíte não tem jsdom: o TSX chama estas funções, e o teste de fiação garante
// que chama.
// ──────────────────────────────────────────────────────────

const resultado = (over: Partial<MlRequiredCheckResult>): MlRequiredCheckResult => ({
  key: "draft",
  status: "ok",
  categoryId: "MLB1",
  blocking: [],
  warnings: [],
  message: null,
  ...over,
});

describe("shouldBlockMlDraft (modal)", () => {
  it("só bloqueado COM mensagem barra a criação", () => {
    expect(shouldBlockMlDraft(resultado({ status: "blocked", message: "falta" }))).toBe(true);
    expect(shouldBlockMlDraft(resultado({ status: "blocked", message: null }))).toBe(false);
    expect(shouldBlockMlDraft(resultado({ status: "blocked", message: "" }))).toBe(false);
    expect(shouldBlockMlDraft(resultado({ status: "ok", message: "x" }))).toBe(false);
    expect(shouldBlockMlDraft(resultado({ status: "unknown" }))).toBe(false);
    expect(shouldBlockMlDraft(null)).toBe(false);
    expect(shouldBlockMlDraft(undefined)).toBe(false);
  });
});

describe("createMlCheckSequencer (resposta antiga não sobrescreve)", () => {
  it("só o bilhete mais recente pode gravar; invalidate derruba todos os em voo", () => {
    const seq = createMlCheckSequencer();
    const primeira = seq.next();
    expect(primeira()).toBe(true);
    const segunda = seq.next();
    expect(primeira()).toBe(false);
    expect(segunda()).toBe(true);
    seq.invalidate();
    expect(segunda()).toBe(false);
    const terceira = seq.next();
    expect(terceira()).toBe(true);
  });
});

describe("mlLoteSemNadaParaEnviar (M12)", () => {
  const bloq = { p1: { message: "a" }, p2: { message: "b" } };
  it("só ML, todos bloqueados → true", () => {
    expect(
      mlLoteSemNadaParaEnviar({ mlAccounts: 1, otherAccounts: 0, productIds: ["p1", "p2"], blocked: bloq }),
    ).toBe(true);
  });
  it("com outra plataforma, com um produto livre, sem ML ou lista vazia → false", () => {
    expect(
      mlLoteSemNadaParaEnviar({ mlAccounts: 1, otherAccounts: 1, productIds: ["p1", "p2"], blocked: bloq }),
    ).toBe(false);
    expect(
      mlLoteSemNadaParaEnviar({ mlAccounts: 1, otherAccounts: 0, productIds: ["p1", "p3"], blocked: bloq }),
    ).toBe(false);
    expect(
      mlLoteSemNadaParaEnviar({ mlAccounts: 0, otherAccounts: 0, productIds: ["p1"], blocked: bloq }),
    ).toBe(false);
    expect(
      mlLoteSemNadaParaEnviar({ mlAccounts: 1, otherAccounts: 0, productIds: [], blocked: bloq }),
    ).toBe(false);
  });
});

describe("resolveMlExclusionsForSubmit (D8 no envio)", () => {
  const K = (cat: string) => mlRequiredCheckKey(cat, undefined);

  it("modo rápido: exclui os bloqueados selecionados, sem reavaliar", async () => {
    const recheck = vi.fn();
    const r = await resolveMlExclusionsForSubmit({
      blocked: { p1: { message: "a" }, fora: { message: "b" } },
      evaluatedKeys: null,
      current: null,
      selectedIds: ["p1", "p2"],
      recheck,
    });
    expect(r.excluded).toEqual(["p1"]);
    expect(recheck).not.toHaveBeenCalled();
  });

  it("revisão sem mudança desde a checagem: exclui sem reavaliar", async () => {
    const recheck = vi.fn();
    const r = await resolveMlExclusionsForSubmit({
      blocked: { p1: { message: "a", key: K("MLB1") } },
      evaluatedKeys: { p1: K("MLB1"), p2: K("MLB2") },
      current: { items: [], keys: { p1: K("MLB1"), p2: K("MLB2") } },
      selectedIds: ["p1", "p2"],
      recheck,
    });
    expect(recheck).not.toHaveBeenCalled();
    expect(r.excluded).toEqual(["p1"]);
  });

  it("revisão com categoria trocada depois da checagem: reavalia e decide pelo resultado NOVO", async () => {
    const itensAtuais = [{ key: "p1", productId: "p1", categoryId: "MLB9" }];
    const recheck = vi.fn(async () => ({}));
    const r = await resolveMlExclusionsForSubmit({
      blocked: { p1: { message: "a", key: K("MLB1") } },
      evaluatedKeys: { p1: K("MLB1") },
      current: { items: itensAtuais, keys: { p1: K("MLB9") } },
      selectedIds: ["p1"],
      recheck,
    });
    expect(recheck).toHaveBeenCalledWith(itensAtuais, { p1: K("MLB9") });
    expect(r.excluded).toEqual([]);
    expect(r.blocked).toEqual({});
  });

  it("resultado avaliado com OUTRA chave que a do envio não exclui (nem se a reavaliação devolver velho)", async () => {
    const r = await resolveMlExclusionsForSubmit({
      blocked: {},
      evaluatedKeys: { p1: K("MLB1") },
      current: { items: [], keys: { p1: K("MLB9") } },
      selectedIds: ["p1"],
      recheck: async () => ({ p1: { message: "a", key: K("MLB1") } }),
    });
    expect(r.excluded).toEqual([]);
  });
});

describe("countRetryableBulkFailures (D3)", () => {
  it("terminais por obrigatório do ML não contam para 'Tentar novamente os falhos'", () => {
    const results = [
      { success: false, code: "ML_REQUIRED_ATTRIBUTES_MISSING" },
      { success: false },
      { success: true },
    ];
    expect(countRetryableBulkFailures(results, 2)).toBe(1);
    expect(
      countRetryableBulkFailures([{ success: false, code: "ML_REQUIRED_ATTRIBUTES_MISSING" }], 1),
    ).toBe(0);
    // Sem `code` nas linhas = conta como sempre.
    expect(countRetryableBulkFailures([{ success: false }, { success: false }], 2)).toBe(2);
  });
});
