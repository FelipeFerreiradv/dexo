import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import {
  MLApiService,
  inspectCompatWriteResponse,
  countCompatibilitiesFromPayload,
  __resetCompatCacheForTests,
} from "../app/marketplaces/services/ml-api.service";

/**
 * O ML responde HTTP 200 ao PUT de compatibilidade mesmo quando não amarra o
 * item a veículo nenhum — o corpo volta com `ids: []`. O sistema tratava isso
 * como sucesso, declarava "publicado" e a vendedora só descobria semanas depois
 * que o painel de Compatibilidades do anúncio estava vazio.
 *
 * Estes testes travam as duas metades da correção: reconhecer o vínculo
 * fantasma no corpo da escrita, e confirmar por leitura o que ficou gravado.
 */

vi.mock("axios");
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

// Respostas reais capturadas no pm2 log de produção em 24/07/2026.
const PROD_GHOST_FAMILIES = {
  create: {
    products_families: [
      {
        domain_id: "MLB-CARS_AND_VANS",
        attributes: [
          { id: "BRAND", value_name: "CAOA Chery" },
          { id: "MODEL", value_name: "iCar" },
          { id: "YEAR", value_name: "2024" },
        ],
        product_type: "PRODUCT_FAMILY",
        ids: [],
      },
    ],
    universal: false,
  },
  domain_id: "MLB-CARS_AND_VANS",
  category_id: "MLB63462",
};

const PROD_GHOST_PRODUCTS = {
  create: {
    products: [
      { id: "MLB7425569", product_type: "PRODUCT", attributes: [], ids: [] },
    ],
  },
};

describe("inspectCompatWriteResponse", () => {
  it('corpo sem chave "ids" é inconclusivo, não falha', () => {
    // Guarda de regressão: é o que a suíte existente mocka (`{ data: {} }`).
    // Se isto virasse "empty", passaríamos a reprovar publicações que funcionam.
    expect(inspectCompatWriteResponse({}).verdict).toBe("unknown");
    expect(inspectCompatWriteResponse(null).verdict).toBe("unknown");
    expect(inspectCompatWriteResponse(undefined).verdict).toBe("unknown");
    expect(inspectCompatWriteResponse("").verdict).toBe("unknown");
    expect(
      inspectCompatWriteResponse({ create: { universal: false } }).verdict,
    ).toBe("unknown");
  });

  it("reconhece o vínculo fantasma de products_families (log de prod)", () => {
    const r = inspectCompatWriteResponse(PROD_GHOST_FAMILIES);
    expect(r.verdict).toBe("empty");
    expect(r.count).toBe(0);
  });

  it("reconhece o vínculo fantasma de products (log de prod)", () => {
    // `id` presente com `ids: []` NÃO é sucesso — foi exatamente o que fez o
    // caminho por catalog products parecer que tinha funcionado.
    const r = inspectCompatWriteResponse(PROD_GHOST_PRODUCTS);
    expect(r.verdict).toBe("empty");
  });

  it("reconhece persistência real e conta os vínculos", () => {
    const r = inspectCompatWriteResponse({
      create: { products_families: [{ ids: ["MLB1", "MLB2"] }] },
    });
    expect(r.verdict).toBe("persisted");
    expect(r.count).toBe(2);
  });

  it("basta um ids não-vazio entre vários para valer como persistido", () => {
    const r = inspectCompatWriteResponse({
      create: { products_families: [{ ids: [] }, { ids: ["MLB9"] }] },
    });
    expect(r.verdict).toBe("persisted");
    expect(r.count).toBe(1);
  });

  it("funciona com o payload fora de create", () => {
    expect(
      inspectCompatWriteResponse({ products: [{ ids: ["MLB1"] }] }).verdict,
    ).toBe("persisted");
  });
});

describe("countCompatibilitiesFromPayload", () => {
  it("shape desconhecido é indisponível, não zero", () => {
    expect(countCompatibilitiesFromPayload({}).available).toBe(false);
    expect(countCompatibilitiesFromPayload(null).available).toBe(false);
  });

  it("conta products[].id", () => {
    const r = countCompatibilitiesFromPayload({
      products: [{ id: "MLB1" }, { id: "MLB2" }],
    });
    expect(r.available).toBe(true);
    expect(r.count).toBe(2);
  });

  it("conta ids dentro de products_families", () => {
    const r = countCompatibilitiesFromPayload({
      products_families: [{ ids: ["MLB1", "MLB2", "MLB3"] }],
    });
    expect(r.count).toBe(3);
  });

  it("deduplica ids repetidos entre estruturas", () => {
    const r = countCompatibilitiesFromPayload({
      products: [{ id: "MLB1" }],
      products_families: [{ ids: ["MLB1", "MLB2"] }],
    });
    expect(r.count).toBe(2);
  });

  it("lista vazia é leitura válida com zero", () => {
    const r = countCompatibilitiesFromPayload({ products: [] });
    expect(r.available).toBe(true);
    expect(r.count).toBe(0);
  });

  it("universal sem lista conta como leitura válida", () => {
    const r = countCompatibilitiesFromPayload({ universal: true });
    expect(r.available).toBe(true);
    expect(r.universal).toBe(true);
  });
});

describe("MLApiService.readCompatibilities", () => {
  beforeEach(() => {
    (mockedAxios as any).get = vi.fn();
    (mockedAxios as any).post = vi.fn();
    (mockedAxios as any).put = vi.fn();
    (mockedAxios as any).isAxiosError = () => false;
    __resetCompatCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lê o item legado na URL certa", async () => {
    (mockedAxios as any).get.mockResolvedValue({
      data: { products: [{ id: "MLB1" }, { id: "MLB2" }] },
    });
    const r = await MLApiService.getItemCompatibilities("tok", "MLB123");
    const [url] = (mockedAxios as any).get.mock.calls[0];
    expect(url).toMatch(/\/items\/MLB123\/compatibilities$/);
    expect(r.count).toBe(2);
  });

  it("prefere user-products quando o item tem um", async () => {
    (mockedAxios as any).get.mockResolvedValue({
      data: { products: [{ id: "MLB1" }] },
    });
    await MLApiService.readCompatibilities("tok", "MLB123", "MLBU9");
    const [url] = (mockedAxios as any).get.mock.calls[0];
    expect(url).toMatch(/\/user-products\/MLBU9\/compatibilities$/);
  });

  it("erro de rede vira indisponível, sem lançar", async () => {
    (mockedAxios as any).get.mockRejectedValue(new Error("ECONNRESET"));
    const r = await MLApiService.getItemCompatibilities("tok", "MLB123");
    expect(r.available).toBe(false);
    expect(r.count).toBe(0);
  });

  it("resposta sem data não explode", async () => {
    (mockedAxios as any).get.mockResolvedValue(undefined);
    const r = await MLApiService.getItemCompatibilities("tok", "MLB123");
    expect(r.available).toBe(false);
  });
});

describe("setItemCompatibilitiesByAttributes — verificação de persistência", () => {
  beforeEach(() => {
    (mockedAxios as any).get = vi.fn().mockResolvedValue({ data: {} });
    (mockedAxios as any).post = vi.fn().mockResolvedValue({ data: { values: [] } });
    (mockedAxios as any).put = vi.fn();
    (mockedAxios as any).isAxiosError = () => false;
    __resetCompatCacheForTests();
    delete process.env.ML_COMPAT_VERIFY_DISABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ML_COMPAT_VERIFY_DISABLED;
  });

  const VEICULO = [{ brand: "Fiat", model: "Uno", yearFrom: 2010, yearTo: 2010 }];

  it("200 com ids:[] NÃO é sucesso", async () => {
    (mockedAxios as any).put.mockResolvedValue({ data: PROD_GHOST_FAMILIES });
    const r = await MLApiService.setItemCompatibilitiesByAttributes(
      "tok",
      "MLB123",
      VEICULO,
      { verify: true },
    );
    expect(r.success).toBe(false);
  });

  it("200 inconclusivo + leitura zerada reprova", async () => {
    (mockedAxios as any).put.mockResolvedValue({ data: {} });
    (mockedAxios as any).get = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/compatibilities")) {
        return Promise.resolve({ data: { products: [] } });
      }
      return Promise.resolve({ data: {} });
    });
    const r = await MLApiService.setItemCompatibilitiesByAttributes(
      "tok",
      "MLB123",
      VEICULO,
      { verify: true },
    );
    expect(r.verified).toBe(true);
    expect(r.persisted).toBe(0);
    expect(r.success).toBe(false);
  });

  it("200 inconclusivo + leitura com veículos aprova", async () => {
    (mockedAxios as any).put.mockResolvedValue({ data: {} });
    (mockedAxios as any).get = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/compatibilities")) {
        return Promise.resolve({
          data: { products: [{ id: "MLB1" }, { id: "MLB2" }, { id: "MLB3" }] },
        });
      }
      return Promise.resolve({ data: {} });
    });
    const r = await MLApiService.setItemCompatibilitiesByAttributes(
      "tok",
      "MLB123",
      VEICULO,
      { verify: true },
    );
    expect(r.success).toBe(true);
    expect(r.persisted).toBe(3);
  });

  it("leitura indisponível mantém o veredito legado (otimista)", async () => {
    // Invariante que impede a verificação de virar um regressor: sem leitura,
    // nada muda em relação ao comportamento anterior.
    (mockedAxios as any).put.mockResolvedValue({ data: {} });
    (mockedAxios as any).get = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/compatibilities")) {
        return Promise.reject(new Error("500"));
      }
      return Promise.resolve({ data: {} });
    });
    const r = await MLApiService.setItemCompatibilitiesByAttributes(
      "tok",
      "MLB123",
      VEICULO,
      { verify: true },
    );
    expect(r.verified).toBe(false);
    expect(r.success).toBe(true);
  });

  it("ML_COMPAT_VERIFY_DISABLED=1 não faz nenhuma leitura extra", async () => {
    process.env.ML_COMPAT_VERIFY_DISABLED = "1";
    (mockedAxios as any).put.mockResolvedValue({ data: {} });
    const r = await MLApiService.setItemCompatibilitiesByAttributes(
      "tok",
      "MLB123",
      VEICULO,
      { verify: true },
    );
    const compatReads = (mockedAxios as any).get.mock.calls.filter(
      ([url]: [string]) => url.includes("/compatibilities"),
    );
    expect(compatReads).toHaveLength(0);
    expect(r.success).toBe(true);
  });

  it("requireFullValueIds pula sem chamar a API quando nada tem value_id", async () => {
    // top_values devolve vazio → nenhum tuplo resolve → não gasta um PUT que
    // voltaria ids:[]; quem orquestra desce para o próximo degrau.
    (mockedAxios as any).put.mockResolvedValue({ data: {} });
    const r = await MLApiService.setItemCompatibilitiesByAttributes(
      "tok",
      "MLB123",
      VEICULO,
      { requireFullValueIds: true, verify: true },
    );
    expect(r.skipped).toBe("no_full_value_ids");
    expect((mockedAxios as any).put).not.toHaveBeenCalled();
  });

  it("teto de lookups corta as chamadas a top_values", async () => {
    (mockedAxios as any).put.mockResolvedValue({ data: {} });
    const r = await MLApiService.setItemCompatibilitiesByAttributes(
      "tok",
      "MLB123",
      [
        { brand: "Fiat", model: "Uno", yearFrom: 2010, yearTo: 2010 },
        { brand: "Ford", model: "Ka", yearFrom: 2018, yearTo: 2018 },
        { brand: "Chevrolet", model: "Onix", yearFrom: 2015, yearTo: 2015 },
      ],
      { lookupBudget: 1, verify: false },
    );
    const topValuesCalls = (mockedAxios as any).post.mock.calls.filter(
      ([url]: [string]) => url.includes("/top_values"),
    );
    expect(topValuesCalls.length).toBeLessThanOrEqual(1);
    expect(r.budgetExhausted).toBe(true);
  });
});

describe("MLApiService.applyCompatibilitiesVerified — escada", () => {
  beforeEach(() => {
    (mockedAxios as any).get = vi.fn().mockResolvedValue({ data: {} });
    (mockedAxios as any).post = vi.fn().mockResolvedValue({ data: { values: [] } });
    (mockedAxios as any).put = vi.fn().mockResolvedValue({ data: {} });
    (mockedAxios as any).isAxiosError = () => false;
    __resetCompatCacheForTests();
    delete process.env.ML_COMPAT_VERIFY_DISABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ML_COMPAT_VERIFY_DISABLED;
  });

  it("sem veículos, não chama nada e reporta none", async () => {
    const r = await MLApiService.applyCompatibilitiesVerified("tok", "MLB1", []);
    expect(r.strategy).toBe("none");
    expect(r.requested).toBe(0);
    expect((mockedAxios as any).put).not.toHaveBeenCalled();
  });

  it("desce da estratégia por atributos quando o ML devolve ids:[]", async () => {
    // Todos os PUTs voltam fantasma e a leitura confirma zero: a escada tem
    // que percorrer os degraus e terminar em falha explícita, nunca em sucesso.
    (mockedAxios as any).put.mockResolvedValue({ data: PROD_GHOST_FAMILIES });
    (mockedAxios as any).get = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/compatibilities")) {
        return Promise.resolve({ data: { products: [] } });
      }
      return Promise.resolve({ data: {} });
    });

    const r = await MLApiService.applyCompatibilitiesVerified("tok", "MLB1", [
      { brand: "CAOA Chery", model: "iCar", yearFrom: 2024, yearTo: 2024 },
    ]);

    expect(r.ok).toBe(false);
    expect(r.strategy).toBe("none");
    expect(r.persisted).toBe(0);
    expect(r.requested).toBe(1);
  });

  it("para no primeiro degrau que persiste de verdade", async () => {
    (mockedAxios as any).put.mockResolvedValue({ data: {} });
    (mockedAxios as any).get = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/compatibilities")) {
        return Promise.resolve({ data: { products: [{ id: "MLB1" }] } });
      }
      return Promise.resolve({ data: {} });
    });

    const r = await MLApiService.applyCompatibilitiesVerified("tok", "MLB1", [
      { brand: "Fiat", model: "Uno", yearFrom: 2010, yearTo: 2010 },
    ]);

    expect(r.ok).toBe(true);
    expect(r.persisted).toBe(1);
    expect(r.verified).toBe(true);
    // Não deve seguir para o degrau seguinte depois de confirmar persistência.
    expect(r.strategy).not.toBe("none");
  });
});
