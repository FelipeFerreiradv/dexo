import { describe, it, expect, vi, afterEach } from "vitest";

import { ProductUseCase } from "@/app/usecases/product.usercase";

// Fakes in-memory: o ProductUseCase recebe um par de repositórios por injeção
// (sobrescrevendo os campos privados depois de construído). A reserva fake faz
// um read-modify-write SÍNCRONO (sem await entre ler e gravar) — como o Node é
// single-threaded, isso modela exatamente a serialização que o Postgres garante
// no `UPDATE ... RETURNING` sob lock de linha.
function makeFakes(opts?: {
  existingSkus?: string[];
  counterStart?: number | null;
}) {
  const products = new Map<string, any>(); // chave: `${userId}::${sku}`
  for (const s of opts?.existingSkus ?? []) {
    products.set(`u1::${s}`, { id: `seed-${s}`, sku: s, userId: "u1" });
  }
  let counter: number | null =
    opts?.counterStart === undefined ? null : opts.counterStart;

  const userRepository = {
    findById: vi.fn(async (_id: string) => ({
      id: "u1",
      defaultProductDescription: null,
    })),
    getLastSkuSequential: vi.fn(async () => counter),
    bumpLastSkuSequential: vi.fn(async (_id: string, c: number) => {
      if (counter == null || counter < c) counter = c;
    }),
    reserveNextSkuSequential: vi.fn(async (_id: string) => {
      counter = (counter ?? 0) + 1; // atômico: sem await entre ler e gravar
      return counter;
    }),
  };

  const productRepository = {
    findBySku: vi.fn(
      async (sku: string, userId: string) =>
        products.get(`${userId}::${sku}`) ?? null,
    ),
    existsBySku: vi.fn(
      async (sku: string, userId: string) => products.has(`${userId}::${sku}`),
    ),
    getMaxSkuNumber: vi.fn(async (userId?: string) => {
      let max = 0;
      for (const key of products.keys()) {
        const [uid, sku] = key.split("::");
        if (userId && uid !== userId) continue;
        const m = sku.match(/^(\d{1,6})$/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
      return max;
    }),
    create: vi.fn(async (data: any) => {
      const key = `${data.userId}::${data.sku}`;
      if (products.has(key)) {
        // Mesma mensagem que o ProductRepositoryPrisma relança ao tratar o P2002.
        throw new Error("Produto com esse sku já existe");
      }
      const created = { id: `p-${data.sku}`, ...data };
      products.set(key, created);
      return created;
    }),
  };

  return { products, userRepository, productRepository };
}

function makeUseCase(fakes: ReturnType<typeof makeFakes>) {
  const uc = new ProductUseCase();
  (uc as any).userRepository = fakes.userRepository;
  (uc as any).productRepository = fakes.productRepository;
  return uc;
}

const base = (over: Record<string, any> = {}) => ({
  userId: "u1",
  name: "Roda",
  price: 10,
  stock: 1,
  imageUrl: "http://x/y.jpg",
  sku: "",
  autoSku: true,
  ...over,
});

describe("ProductUseCase.createWithAutoSku — concorrência", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("N criações autoSku em paralelo → N SKUs distintos, zero colisão", async () => {
    const fakes = makeFakes({ counterStart: 300 });
    const uc = makeUseCase(fakes);

    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () => uc.create(base())),
    );

    const skus = results.map((r) => r.sku);
    expect(new Set(skus).size).toBe(N); // todos distintos
    expect([...skus].sort()).toEqual(
      Array.from({ length: N }, (_, i) =>
        String(301 + i).padStart(3, "0"),
      ).sort(),
    );
    expect(fakes.products.size).toBe(N); // todo create persistiu
  });

  it("pula número já ocupado por importação na janela e pega o próximo", async () => {
    // contador=300 → reserva 301; "301" já existe → pula → 302
    const fakes = makeFakes({ counterStart: 300, existingSkus: ["301"] });
    const uc = makeUseCase(fakes);

    const r = await uc.create(base());
    expect(r.sku).toBe("302");
  });

  it("semeia pelo maior SKU numérico quando o contador é null (nunca '001')", async () => {
    // Estilo JOTABÊ: importação até 32762, contador nunca inicializado.
    const fakes = makeFakes({
      counterStart: null,
      existingSkus: ["32762", "700210067", "12345678"],
    });
    const uc = makeUseCase(fakes);

    const r = await uc.create(base());
    expect(r.sku).toBe("32763"); // max+1, não "001"
    expect(fakes.userRepository.bumpLastSkuSequential).toHaveBeenCalledWith(
      "u1",
      32762,
    );
  });

  it("faz retry quando o insert colide por corrida (mensagem de sku já existe)", async () => {
    const fakes = makeFakes({ counterStart: 300 });
    const uc = makeUseCase(fakes);

    // Faz o PRIMEIRO create lançar a colisão uma vez, simulando uma corrida
    // perdida entre o pre-check e o insert; o retry deve vencer com o próximo.
    const realCreate = fakes.productRepository.create.getMockImplementation()!;
    let first = true;
    fakes.productRepository.create.mockImplementation(async (data: any) => {
      if (first) {
        first = false;
        throw new Error("Produto com esse sku já existe");
      }
      return realCreate(data);
    });

    const r = await uc.create(base());
    expect(r.sku).toBe("302"); // 301 "perdeu a corrida", 302 vence
  });

  it("caminho custom (sem autoSku): SKU duplicado lança, SKU novo cria — inalterado", async () => {
    const fakes = makeFakes({ counterStart: 300, existingSkus: ["ABC-1"] });
    const uc = makeUseCase(fakes);

    await expect(
      uc.create(base({ autoSku: false, sku: "ABC-1" })),
    ).rejects.toThrow("Produto com esse sku já existe");

    const ok = await uc.create(base({ autoSku: false, sku: "XYZ-9" }));
    expect(ok.sku).toBe("XYZ-9");
    // SKU não-numérico não toca o contador sequencial.
    expect(fakes.userRepository.bumpLastSkuSequential).not.toHaveBeenCalled();
  });
});

describe("ProductUseCase.create — contador ignora SKU de marketplace", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("SKU numérico humano incrementa o contador (comportamento preservado)", async () => {
    const fakes = makeFakes({ counterStart: 5120 });
    const uc = makeUseCase(fakes);

    const r = await uc.create(base({ autoSku: false, sku: "5121" }));
    expect(r.sku).toBe("5121");
    expect(fakes.userRepository.bumpLastSkuSequential).toHaveBeenCalledWith(
      "u1",
      5121,
    );
  });

  it("SKU numérico de anúncio de marketplace NÃO incrementa o contador", async () => {
    // Auto-detecção de anúncio: createdFromMarketplace=true + SKU numérico alto
    // do vendedor (ex.: "13340") não pode contaminar a sequência humana.
    const fakes = makeFakes({ counterStart: 5120 });
    const uc = makeUseCase(fakes);

    const r = await uc.create(
      base({ autoSku: false, sku: "13340", createdFromMarketplace: true }),
    );
    expect(r.sku).toBe("13340");
    expect(fakes.userRepository.bumpLastSkuSequential).not.toHaveBeenCalled();
  });
});

describe("ProductUseCase — existsBySku (perf/egress no check de duplicidade)", () => {
  it("usa existsBySku (SELECT id), nao findBySku, ao checar SKU ja existente", async () => {
    const fakes = makeFakes({ existingSkus: ["ABC"] });
    const uc = makeUseCase(fakes);

    await expect(
      uc.create(base({ sku: "ABC", autoSku: false })),
    ).rejects.toThrow(/já existe/i);

    expect(fakes.productRepository.existsBySku).toHaveBeenCalledWith("ABC", "u1");
    expect(fakes.productRepository.findBySku).not.toHaveBeenCalled();
  });
});
