import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Rascunho automático (Bloco 4) e histórico de cadastros (Bloco 3).
 *
 * A suíte roda em `environment: node`, sem jsdom e sem @testing-library/react
 * (os `.spec.tsx` do repo usam apenas `renderToString`). Por isso toda a lógica
 * mora em módulos PUROS — serializador, storage, agendador do autosave e
 * política de merge — e é aqui que ela é provada. O que fica sem cobertura
 * automática é o clique real no modal, que está declarado no relatório.
 *
 * O `window.localStorage` é falsificado: as funções de storage guardam
 * `typeof window === "undefined"` para SSR, então sem este stub elas viram
 * no-op e os testes passariam sem testar nada.
 */

// ── localStorage falso, com os modos de falha reais ──────────────────────────

class FakeStorage {
  private map = new Map<string, string>();
  /** Quando setado, toda escrita explode (quota / modo privado). */
  public throwOnWrite: Error | null = null;
  /** Quando setado, toda leitura explode (storage desabilitado por política). */
  public throwOnRead: Error | null = null;

  getItem(k: string): string | null {
    if (this.throwOnRead) throw this.throwOnRead;
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    if (this.throwOnWrite) throw this.throwOnWrite;
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  /** Só para os testes: injeta lixo direto. */
  seed(k: string, v: string) {
    this.map.set(k, v);
  }
  raw(k: string) {
    return this.map.get(k) ?? null;
  }
  get size() {
    return this.map.size;
  }
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  (globalThis as any).window = { localStorage: storage };
});

afterEach(() => {
  delete (globalThis as any).window;
  vi.useRealTimers();
});

import {
  HISTORY_BLOCKED_FIELDS,
  NEVER_PERSISTED_FIELDS,
  SNAPSHOT_VERSION,
  hasMeaningfulContent,
  isExpired,
  parseSnapshot,
  serializeProductForm,
} from "../app/produtos/lib/product-form-snapshot";
import {
  HISTORY_MAX_ENTRIES,
  clearHistory,
  draftKey,
  historyKey,
  pushHistory,
  readDraft,
  readHistory,
  scopeKeyFor,
  writeDraft,
} from "../app/produtos/lib/product-form-storage";
import { createDebouncedWriter } from "../app/produtos/lib/debounced-writer";
import { applyProductHistory } from "../app/produtos/lib/apply-product-history";

const T0 = 1_700_000_000_000;

const formValues = (over: Record<string, unknown> = {}) => ({
  sku: "SKU-123",
  name: "Farol Esquerdo Gol G5",
  brand: "Volkswagen",
  model: "Gol",
  year: "2012",
  version: "G5",
  category: "Iluminação",
  partNumber: "PN-999",
  quality: "SEMINOVO",
  sourceVehicle: "Gol G5 2012",
  price: 250,
  costPrice: 100,
  stock: 1,
  imageUrl: "https://cdn/x.png",
  imageUrls: ["https://cdn/x.png"],
  heightCm: 20,
  widthCm: 30,
  lengthCm: 40,
  weightKg: 2,
  attributes: { BRAND: { value_name: "VW" } },
  createMLListing: true,
  mlAccountIds: ["acc-1"],
  mlCategory: "MLB7863",
  mlCatalogProductId: "MLB-CAT-1",
  ...over,
});

const snap = (over: Record<string, unknown> = {}, now = T0) =>
  serializeProductForm({
    values: formValues(over),
    compatibilities: [
      { brand: "VW", model: "Gol", yearFrom: 2008, yearTo: 2013 },
    ],
    scrap: { id: "scrap-1" },
    magaluCategoryLabel: "Auto > Farol",
    currentStep: 3,
    now,
  });

// ─────────────────────────────────────────────────────────────────────────────

describe("serializador do formulário", () => {
  it("nunca persiste o SKU (é revalidado a cada abertura)", () => {
    const s = snap();
    expect(NEVER_PERSISTED_FIELDS).toContain("sku");
    expect(s.values.sku).toBeUndefined();
    expect(JSON.stringify(s.values)).not.toContain("SKU-123");
  });

  it("guarda o SKU só como rótulo de exibição, nunca em values", () => {
    const s = snap();
    expect(s.label.sku).toBe("SKU-123");
    expect(s.label.name).toBe("Farol Esquerdo Gol G5");
  });

  it("carrega estado que vive fora do react-hook-form", () => {
    const s = snap();
    expect(s.compatibilities).toHaveLength(1);
    expect(s.scrap).toEqual({ id: "scrap-1" });
    expect(s.magaluCategoryLabel).toBe("Auto > Farol");
    expect(s.currentStep).toBe(3);
  });

  it("imagens entram como URL, nunca base64", () => {
    const s = snap();
    expect(s.values.imageUrls).toEqual(["https://cdn/x.png"]);
    expect(JSON.stringify(s)).not.toContain("data:image");
  });

  it("descarta undefined em vez de gravar chave morta", () => {
    const s = serializeProductForm({
      values: { name: "x", brand: undefined },
      compatibilities: [],
      now: T0,
    });
    expect("brand" in s.values).toBe(false);
  });
});

describe("parse e validade", () => {
  it("versão desconhecida é descartada em silêncio", () => {
    expect(parseSnapshot({ ...snap(), v: 999 })).toBeNull();
  });

  it("payload corrompido é descartado", () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot("nao sou objeto")).toBeNull();
    expect(parseSnapshot({ v: SNAPSHOT_VERSION })).toBeNull();
    expect(parseSnapshot({ v: SNAPSHOT_VERSION, savedAt: T0 })).toBeNull();
    expect(
      parseSnapshot({ v: SNAPSHOT_VERSION, savedAt: T0, values: [] }),
    ).toBeNull();
  });

  it("TTL de 24h: dentro vale, fora expira", () => {
    const s = snap();
    const dia = 24 * 60 * 60 * 1000;
    expect(isExpired(s, T0 + dia - 1, dia)).toBe(false);
    expect(isExpired(s, T0 + dia + 1, dia)).toBe(true);
  });

  it("modal aberto e fechado sem digitar nada não é rascunho", () => {
    const vazio = serializeProductForm({
      values: {
        name: "",
        brand: "",
        price: 0,
        stock: 0,
        description: "padrão",
      },
      compatibilities: [],
      now: T0,
    });
    expect(hasMeaningfulContent(vazio)).toBe(false);
    expect(hasMeaningfulContent(snap())).toBe(true);
  });

  it("só uma compatibilidade já conta como conteúdo", () => {
    const s = serializeProductForm({
      values: { name: "" },
      compatibilities: [{ brand: "VW", model: "Gol" }],
      now: T0,
    });
    expect(hasMeaningfulContent(s)).toBe(true);
  });
});

describe("escopo das chaves", () => {
  it("usa o dono dos dados (parentUserId) quando o usuário é colaborador", () => {
    expect(scopeKeyFor("dono-1", "colab-9")).toBe("dono-1");
    expect(scopeKeyFor(null, "admin-2")).toBe("admin-2");
    expect(scopeKeyFor(undefined, undefined)).toBeNull();
    expect(scopeKeyFor("  ", "  ")).toBeNull();
  });

  it("rascunho de um usuário NÃO é oferecido a outro no mesmo navegador", () => {
    writeDraft(draftKey("dono-A", "manual"), snap());
    expect(readDraft(draftKey("dono-A", "manual"))).not.toBeNull();
    expect(readDraft(draftKey("dono-B", "manual"))).toBeNull();
  });

  it("o rascunho do fluxo normal não vaza para NF-e nem para sucata", () => {
    writeDraft(draftKey("dono-A", "manual"), snap());
    expect(readDraft(draftKey("dono-A", "nfe"))).toBeNull();
    expect(readDraft(draftKey("dono-A", "scrap"))).toBeNull();
  });

  it("histórico também é escopado por dono", () => {
    pushHistory(historyKey("dono-A"), snap());
    expect(readHistory(historyKey("dono-A"))).toHaveLength(1);
    expect(readHistory(historyKey("dono-B"))).toHaveLength(0);
  });
});

describe("storage indisponível degrada em silêncio", () => {
  it("escrita que estoura a quota não lança", () => {
    storage.throwOnWrite = new Error("QuotaExceededError");
    expect(() => writeDraft(draftKey("u", "manual"), snap())).not.toThrow();
    expect(readDraft(draftKey("u", "manual"))).toBeNull();
  });

  it("leitura bloqueada devolve null em vez de explodir", () => {
    storage.throwOnRead = new Error("SecurityError");
    expect(() => readDraft(draftKey("u", "manual"))).not.toThrow();
    expect(readDraft(draftKey("u", "manual"))).toBeNull();
  });

  it("JSON corrompido no storage vira 'não existe'", () => {
    storage.seed(draftKey("u", "manual"), "{isso nao e json");
    expect(readDraft(draftKey("u", "manual"))).toBeNull();
  });

  it("histórico com uma entrada corrompida não perde as válidas", () => {
    const bom = snap();
    storage.seed(
      historyKey("u"),
      JSON.stringify([{ lixo: true }, bom, { v: 42 }]),
    );
    const lido = readHistory(historyKey("u"));
    expect(lido).toHaveLength(1);
    expect(lido[0].label.name).toBe(bom.label.name);
  });

  it("sem window (SSR) nada acontece", () => {
    delete (globalThis as any).window;
    expect(() => writeDraft(draftKey("u", "manual"), snap())).not.toThrow();
    expect(readDraft(draftKey("u", "manual"))).toBeNull();
    expect(readHistory(historyKey("u"))).toEqual([]);
  });
});

describe("limite do histórico", () => {
  it("guarda no máximo 5 e descarta o mais antigo", () => {
    const key = historyKey("u");
    for (let i = 1; i <= 7; i++) {
      pushHistory(key, snap({ name: `Peça ${i}` }, T0 + i));
    }
    const lido = readHistory(key);
    expect(lido).toHaveLength(HISTORY_MAX_ENTRIES);
    // Mais recente primeiro; "Peça 1" e "Peça 2" saíram.
    expect(lido.map((s) => s.label.name)).toEqual([
      "Peça 7",
      "Peça 6",
      "Peça 5",
      "Peça 4",
      "Peça 3",
    ]);
  });

  it("snapshot gigante é ignorado sem derrubar o que já existe", () => {
    const key = historyKey("u");
    pushHistory(key, snap({ name: "Normal" }));
    const gigante = snap({ description: "x".repeat(60 * 1024) });
    pushHistory(key, gigante);
    const lido = readHistory(key);
    expect(lido).toHaveLength(1);
    expect(lido[0].label.name).toBe("Normal");
  });

  it("limpar o histórico apaga tudo", () => {
    const key = historyKey("u");
    pushHistory(key, snap());
    clearHistory(key);
    expect(readHistory(key)).toEqual([]);
  });
});

describe("autosave: debounce agrupa a digitação", () => {
  it("N digitações viram UMA escrita", () => {
    vi.useFakeTimers();
    const escritas: string[] = [];
    const w = createDebouncedWriter<string>((v) => escritas.push(v), 600);

    for (const t of ["F", "Fa", "Far", "Faro", "Farol"]) {
      w.schedule(t);
      vi.advanceTimersByTime(100);
    }
    expect(escritas).toHaveLength(0); // ainda dentro da janela

    vi.advanceTimersByTime(600);
    expect(escritas).toEqual(["Farol"]);
    expect(w.writes()).toBe(1);
  });

  it("pausa entre rajadas gera duas escritas", () => {
    vi.useFakeTimers();
    const escritas: string[] = [];
    const w = createDebouncedWriter<string>((v) => escritas.push(v), 600);
    w.schedule("a");
    vi.advanceTimersByTime(700);
    w.schedule("b");
    vi.advanceTimersByTime(700);
    expect(escritas).toEqual(["a", "b"]);
  });

  it("flush grava o pendente na hora (fechar o modal antes do timer)", () => {
    vi.useFakeTimers();
    const escritas: string[] = [];
    const w = createDebouncedWriter<string>((v) => escritas.push(v), 600);
    w.schedule("quase perdido");
    w.flush();
    expect(escritas).toEqual(["quase perdido"]);
  });

  it("cancel descarta o pendente (submit bem-sucedido)", () => {
    vi.useFakeTimers();
    const escritas: string[] = [];
    const w = createDebouncedWriter<string>((v) => escritas.push(v), 600);
    w.schedule("nao deve ressuscitar");
    w.cancel();
    vi.advanceTimersByTime(5000);
    expect(escritas).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("aplicação do histórico: preenche só o que está vazio", () => {
  const anterior = snap();

  it("preenche campo vazio", () => {
    const r = applyProductHistory({ brand: "", model: "" }, [], anterior);
    expect(r.next.brand).toBe("Volkswagen");
    expect(r.next.model).toBe("Gol");
    expect(r.applied).toEqual(expect.arrayContaining(["brand", "model"]));
  });

  it("NÃO sobrescreve o que o usuário já digitou — vira conflito", () => {
    const r = applyProductHistory({ brand: "Fiat" }, [], anterior);
    expect(r.next.brand).toBe("Fiat");
    expect(r.applied).not.toContain("brand");
    expect(r.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "brand", currentValue: "Fiat" }),
      ]),
    );
  });

  it("medidas zeradas contam como vazias e são preenchidas", () => {
    const r = applyProductHistory({ heightCm: 0, weightKg: 0 }, [], anterior);
    expect(r.next.heightCm).toBe(20);
    expect(r.next.weightKg).toBe(2);
  });

  it("attributes faz merge sem perder chave existente", () => {
    const r = applyProductHistory(
      { attributes: { COLOR: { value_name: "Preto" } } },
      [],
      anterior,
    );
    expect(r.next.attributes).toEqual({
      COLOR: { value_name: "Preto" },
      BRAND: { value_name: "VW" },
    });
  });

  it("compatibilities faz união sem duplicar", () => {
    const r = applyProductHistory(
      {},
      [{ brand: "VW", model: "Gol", yearFrom: 2008, yearTo: 2013 }],
      anterior,
    );
    expect(r.compatibilities).toBeNull(); // nada novo a acrescentar

    const r2 = applyProductHistory(
      {},
      [{ brand: "Fiat", model: "Uno" }],
      anterior,
    );
    expect(r2.compatibilities).toHaveLength(2);
  });

  it("contas de marketplace só entram quando a seleção está vazia", () => {
    const vazio = applyProductHistory({ mlAccountIds: [] }, [], anterior);
    expect(vazio.next.mlAccountIds).toEqual(["acc-1"]);

    const cheio = applyProductHistory(
      { mlAccountIds: ["outra"] },
      [],
      anterior,
    );
    expect(cheio.next.mlAccountIds).toEqual(["outra"]);
  });
});

describe("aplicação do histórico: campos bloqueados", () => {
  const anterior = snap();
  const atual = {
    sku: "",
    name: "",
    partNumber: "",
    imageUrl: "",
    imageUrls: [],
    stock: 0,
    price: 0,
    costPrice: 0,
    markup: 0,
    mlCatalogProductId: "",
    scrapId: "",
  };

  it("NENHUM campo bloqueado é copiado, mesmo estando vazio", () => {
    const r = applyProductHistory(atual, [], anterior);
    for (const campo of HISTORY_BLOCKED_FIELDS) {
      expect(r.applied).not.toContain(campo);
      expect(r.next[campo]).toEqual(atual[campo as keyof typeof atual]);
    }
  });

  it("o SKU não existe no snapshot, então não há como vazar", () => {
    const r = applyProductHistory(atual, [], anterior);
    expect(r.next.sku).toBe("");
  });

  it("imagem nunca é copiada (é do produto físico)", () => {
    const r = applyProductHistory(atual, [], anterior);
    expect(r.next.imageUrl).toBe("");
    expect(r.next.imageUrls).toEqual([]);
  });

  it("custo e markup não são copiados (o custo é da peça específica)", () => {
    const r = applyProductHistory(atual, [], anterior);
    expect(r.next.costPrice).toBe(0);
    expect(r.next.markup).toBe(0);
  });
});

describe("aplicação do histórico: nome, part number, preço e estoque", () => {
  // Passaram a ser copiados em 05/08/2026 (pedido do Felipe). O que os torna
  // seguros é a política de merge: só preenchem campo VAZIO.
  const anterior = snap();
  const vazio = {
    name: "",
    partNumber: "",
    price: 0,
    stock: 0,
  };

  it("preenche os quatro quando o formulário está vazio", () => {
    const r = applyProductHistory(vazio, [], anterior);
    expect(r.next.name).toBe(anterior.values.name);
    expect(r.next.partNumber).toBe(anterior.values.partNumber);
    expect(r.next.price).toBe(anterior.values.price);
    expect(r.next.stock).toBe(anterior.values.stock);
    for (const campo of ["name", "partNumber", "price", "stock"]) {
      expect(r.applied).toContain(campo);
    }
  });

  it("NÃO sobrescreve o que o usuário já digitou — vira conflito", () => {
    const digitado = {
      name: "Farol Direito Gol 2015",
      partNumber: "PN-DIREITO",
      price: 199.9,
      stock: 7,
    };
    const r = applyProductHistory(digitado, [], anterior);
    expect(r.next.name).toBe("Farol Direito Gol 2015");
    expect(r.next.partNumber).toBe("PN-DIREITO");
    expect(r.next.price).toBe(199.9);
    expect(r.next.stock).toBe(7);
    for (const campo of ["name", "partNumber", "price", "stock"]) {
      expect(r.applied).not.toContain(campo);
      expect(r.conflicts.map((c) => c.field)).toContain(campo);
    }
  });

  it("o SKU continua fora, mesmo com os outros liberados", () => {
    const r = applyProductHistory({ ...vazio, sku: "" }, [], anterior);
    expect(r.applied).not.toContain("sku");
    expect(r.next.sku).toBe("");
  });
});

describe("contrato do autoSku continua intacto", () => {
  /**
   * Reprodução da decisão de `onSubmit` (create-product-dialog.tsx):
   *   useManualSku = sku digitado não-vazio E diferente da sugestão do servidor
   * Aplicar histórico ou restaurar rascunho não pode fazer este ramo mudar.
   */
  const decidirSku = (typed: string, sugerido: string) => {
    const t = (typed || "").trim();
    const manual = t.length > 0 && t !== sugerido.trim();
    return { autoSku: !manual, sku: manual ? t : undefined };
  };

  it("aplicar histórico e submeter sem tocar no SKU => autoSku:true, sku omitido", () => {
    const sugeridoPeloServidor = "AUTO-0042";
    const r = applyProductHistory(
      { sku: sugeridoPeloServidor, brand: "" },
      [],
      snap(),
    );
    expect(r.next.sku).toBe(sugeridoPeloServidor);
    expect(decidirSku(r.next.sku as string, sugeridoPeloServidor)).toEqual({
      autoSku: true,
      sku: undefined,
    });
  });

  it("campo de SKU vazio também segue o caminho automático", () => {
    const r = applyProductHistory({ sku: "" }, [], snap());
    expect(decidirSku(r.next.sku as string, "AUTO-0042")).toEqual({
      autoSku: true,
      sku: undefined,
    });
  });

  it("SKU digitado à mão continua indo pelo caminho manual", () => {
    expect(decidirSku("MEU-SKU", "AUTO-0042")).toEqual({
      autoSku: false,
      sku: "MEU-SKU",
    });
  });
});

describe("precedência dos contextos NF-e e sucata", () => {
  /**
   * O modal aplica o pré-preenchimento externo (NF-e / sucata travada) uma vez
   * por abertura, guardado por ref. O histórico usa a MESMA política de
   * "preenche só o que está vazio", então o que o contexto colocou sobrevive.
   */
  it("valor vindo da NF-e não é sobrescrito pelo histórico", () => {
    const daNfe = { name: "PARAFUSO M8 (da NF-e)", brand: "Fornecedor X" };
    const r = applyProductHistory(daNfe, [], snap());
    expect(r.next.name).toBe("PARAFUSO M8 (da NF-e)");
    expect(r.next.brand).toBe("Fornecedor X");
  });

  it("marca/modelo da sucata travada não são sobrescritos", () => {
    const daSucata = { brand: "Chevrolet", model: "Onix", year: "2018" };
    const r = applyProductHistory(daSucata, [], snap());
    expect(r.next.brand).toBe("Chevrolet");
    expect(r.next.model).toBe("Onix");
    expect(r.next.year).toBe("2018");
  });

  it("cada contexto tem rascunho próprio e eles não se cruzam", () => {
    writeDraft(draftKey("dono", "manual"), snap({ name: "Normal" }));
    writeDraft(draftKey("dono", "nfe"), snap({ name: "Da nota" }));
    expect(readDraft(draftKey("dono", "manual"))!.label.name).toBe("Normal");
    expect(readDraft(draftKey("dono", "nfe"))!.label.name).toBe("Da nota");
    expect(readDraft(draftKey("dono", "scrap"))).toBeNull();
  });
});
