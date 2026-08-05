import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import {
  MLApiService,
  __resetCompatCacheForTests,
} from "../app/marketplaces/services/ml-api.service";

/**
 * A LIGAÇÃO entre a posição escolhida no produto e o corpo que sai para o ML.
 *
 * O módulo puro (`ml-compat-position.spec.ts`) prova as regras; aqui provamos
 * que elas chegam ao payload — e, principalmente, que **quem não usa posição
 * continua com o corpo byte-idêntico ao de antes desta funcionalidade**.
 */

vi.mock("axios");
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

/** Item user-product: é o caminho que roteia para o PUT, o que vence em prod. */
const ITEM_USER_PRODUCT = {
  user_product_id: "MLBU999",
  category_id: "MLB63462",
  domain_id: "MLB-VEHICLE_HEADLIGHTS",
};

const VALORES_POSITION = {
  attributes_values: [
    {
      attribute_id: "POSITION",
      values: [
        { value_id: "13701104", value_name: "Dianteira" },
        { value_id: "13701105", value_name: "Traseira" },
        { value_id: "2262158", value_name: "Esquerda" },
        { value_id: "2262160", value_name: "Direita" },
      ],
    },
  ],
};

/** Resposta de sucesso: o ML ecoa as restrições preenchidas. */
const PUT_OK_COM_POSICAO = {
  create: {
    products: [
      {
        id: "MLB1000",
        product_type: "PRODUCT",
        restrictions: [
          {
            attribute_id: "POSITION",
            attribute_code: 37,
            attribute_values: [
              {
                values: [
                  { value_id: "13701104", value_name: "Dianteira", value_code: 1 },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

function mockarGets() {
  (mockedAxios as any).get = vi.fn((url: string) => {
    if (url.includes("/catalog_compatibilities/restrictions/values")) {
      return Promise.resolve({ data: VALORES_POSITION });
    }
    return Promise.resolve({ data: ITEM_USER_PRODUCT });
  });
}

describe("posição no payload de compatibilidade", () => {
  beforeEach(() => {
    __resetCompatCacheForTests();
    delete process.env.ML_COMPAT_POSITIONS_DISABLED;
    (mockedAxios as any).isAxiosError = () => false;
    (mockedAxios as any).post = vi.fn().mockResolvedValue({ data: {} });
    (mockedAxios as any).put = vi
      .fn()
      .mockResolvedValue({ data: PUT_OK_COM_POSICAO });
    mockarGets();
  });

  afterEach(() => {
    delete process.env.ML_COMPAT_POSITIONS_DISABLED;
    vi.restoreAllMocks();
  });

  it("SEM posição: corpo idêntico ao de antes — sem restrictions e sem creation_source", async () => {
    await MLApiService.setItemCompatibilities("tok", "MLB123", ["MLB1000"]);

    const [url, body] = (mockedAxios as any).put.mock.calls[0];
    expect(url).toMatch(/\/user-products\/MLBU999\/compatibilities$/);
    expect(body).toEqual({
      domain_id: "MLB-CARS_AND_VANS",
      category_id: "MLB63462",
      create: { products: [{ id: "MLB1000" }], universal: false },
    });
  });

  it("SEM posição: não consulta os valores de POSITION — zero egress a mais", async () => {
    await MLApiService.setItemCompatibilities("tok", "MLB123", ["MLB1000"]);

    const consultas = (mockedAxios as any).get.mock.calls.filter(
      ([u]: [string]) => u.includes("/restrictions/values"),
    );
    expect(consultas).toHaveLength(0);
  });

  it("COM posição: emite restrictions e creation_source no degrau create.products", async () => {
    const r = await MLApiService.setItemCompatibilities("tok", "MLB123", [
      "MLB1000",
    ], { positionLabels: ["Dianteira", "Esquerda"] });

    const [, body] = (mockedAxios as any).put.mock.calls[0];
    // Este é o corpo medido contra a API em 05/08/2026.
    expect(body).toEqual({
      domain_id: "MLB-CARS_AND_VANS",
      category_id: "MLB63462",
      create: {
        products: [
          {
            id: "MLB1000",
            creation_source: "DEFAULT",
            restrictions: [
              {
                attribute_id: "POSITION",
                attribute_values: [
                  {
                    values: [
                      { value_id: "13701104", value_name: "Dianteira" },
                      { value_id: "2262158", value_name: "Esquerda" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        universal: false,
      },
    });
    expect(r.positions?.echo).toBe("echoed");
    expect(r.positions?.unresolved).toEqual([]);
  });

  it("COM posição: resolve o value_id pelo domínio DA PEÇA, não o do veículo", async () => {
    await MLApiService.setItemCompatibilities("tok", "MLB123", ["MLB1000"], {
      positionLabels: ["Dianteira"],
    });

    const [url] = (mockedAxios as any).get.mock.calls.find(([u]: [string]) =>
      u.includes("/restrictions/values"),
    );
    expect(url).toContain("main_domain_id=MLB-CARS_AND_VANS");
    expect(url).toContain("secondary_domain_id=MLB-VEHICLE_HEADLIGHTS");
  });

  it("KILL-SWITCH devolve o corpo de hoje byte-a-byte", async () => {
    process.env.ML_COMPAT_POSITIONS_DISABLED = "1";

    await MLApiService.setItemCompatibilities("tok", "MLB123", ["MLB1000"], {
      positionLabels: ["Dianteira", "Esquerda"],
    });

    const [, body] = (mockedAxios as any).put.mock.calls[0];
    expect(body).toEqual({
      domain_id: "MLB-CARS_AND_VANS",
      category_id: "MLB63462",
      create: { products: [{ id: "MLB1000" }], universal: false },
    });
    const consultas = (mockedAxios as any).get.mock.calls.filter(
      ([u]: [string]) => u.includes("/restrictions/values"),
    );
    expect(consultas).toHaveLength(0);
  });

  it("200 com restrictions vazio é reportado como DESCARTE, não como sucesso", async () => {
    // A armadilha central: o `id` vem ecoado, então o verificador de
    // compatibilidade declara sucesso. Só o eco das restrições denuncia.
    (mockedAxios as any).put = vi.fn().mockResolvedValue({
      data: {
        create: {
          products: [
            { id: "MLB1000", product_type: "PRODUCT", restrictions: [] },
          ],
        },
      },
    });

    const r = await MLApiService.setItemCompatibilities("tok", "MLB123", [
      "MLB1000",
    ], { positionLabels: ["Dianteira"] });

    expect(r.success).toBe(true); // a compatibilidade em si foi criada
    expect(r.positions?.echo).toBe("dropped"); // a posição, não
  });

  it("rótulo que a categoria não expõe vira `unresolved`, sem impedir o resto", async () => {
    const r = await MLApiService.setItemCompatibilities("tok", "MLB123", [
      "MLB1000",
    ], { positionLabels: ["Dianteira", "Superior"] });

    const [, body] = (mockedAxios as any).put.mock.calls[0];
    expect(
      body.create.products[0].restrictions[0].attribute_values[0].values,
    ).toEqual([{ value_id: "13701104", value_name: "Dianteira" }]);
    expect(r.positions?.unresolved).toEqual(["Superior"]);
  });

  it("categoria sem POSITION nenhum: volta ao corpo de hoje em vez de mandar lixo", async () => {
    (mockedAxios as any).get = vi.fn((url: string) => {
      if (url.includes("/catalog_compatibilities/restrictions/values")) {
        return Promise.resolve({ data: { attributes_values: [] } });
      }
      return Promise.resolve({ data: ITEM_USER_PRODUCT });
    });

    const r = await MLApiService.setItemCompatibilities("tok", "MLB123", [
      "MLB1000",
    ], { positionLabels: ["Dianteira"] });

    const [, body] = (mockedAxios as any).put.mock.calls[0];
    expect(body.create.products).toEqual([{ id: "MLB1000" }]);
    expect(r.positions?.unresolved).toEqual(["Dianteira"]);
  });

  it("falha ao ler os valores não derruba a compatibilidade", async () => {
    (mockedAxios as any).get = vi.fn((url: string) => {
      if (url.includes("/catalog_compatibilities/restrictions/values")) {
        return Promise.reject(new Error("500 do ML"));
      }
      return Promise.resolve({ data: ITEM_USER_PRODUCT });
    });

    const r = await MLApiService.setItemCompatibilities("tok", "MLB123", [
      "MLB1000",
    ], { positionLabels: ["Dianteira"] });

    const [, body] = (mockedAxios as any).put.mock.calls[0];
    expect(body.create.products).toEqual([{ id: "MLB1000" }]);
    expect(r.success).toBe(true);
  });

  it("o cache evita reconsultar os valores do mesmo domínio", async () => {
    await MLApiService.setItemCompatibilities("tok", "MLB1", ["MLB1000"], {
      positionLabels: ["Dianteira"],
    });
    await MLApiService.setItemCompatibilities("tok", "MLB2", ["MLB1000"], {
      positionLabels: ["Esquerda"],
    });

    const consultas = (mockedAxios as any).get.mock.calls.filter(
      ([u]: [string]) => u.includes("/restrictions/values"),
    );
    expect(consultas).toHaveLength(1);
  });

  it("item sem domain_id não inventa posição", async () => {
    (mockedAxios as any).get = vi.fn(() =>
      Promise.resolve({
        data: { user_product_id: "MLBU999", category_id: "MLB63462" },
      }),
    );

    const r = await MLApiService.setItemCompatibilities("tok", "MLB123", [
      "MLB1000",
    ], { positionLabels: ["Dianteira"] });

    const [, body] = (mockedAxios as any).put.mock.calls[0];
    expect(body.create.products).toEqual([{ id: "MLB1000" }]);
    expect(r.positions?.unresolved).toEqual(["Dianteira"]);
  });
});

describe("applyCompatibilitiesVerified repassa a posição", () => {
  beforeEach(() => {
    __resetCompatCacheForTests();
    delete process.env.ML_COMPAT_POSITIONS_DISABLED;
    (mockedAxios as any).isAxiosError = () => false;
    (mockedAxios as any).post = vi.fn().mockResolvedValue({ data: {} });
    (mockedAxios as any).put = vi
      .fn()
      .mockResolvedValue({ data: PUT_OK_COM_POSICAO });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sem o 4º argumento o comportamento é o de sempre", async () => {
    // Guarda da compatibilidade da assinatura: os chamadores que não sabem de
    // posição continuam funcionando sem mudar uma linha.
    mockarGets();
    (mockedAxios as any).post = vi.fn().mockResolvedValue({ data: {} });

    const r = await MLApiService.applyCompatibilitiesVerified("tok", "MLB1", [
      { brand: "Fiat", model: "Uno" },
    ]);

    expect(r.positions).toBeUndefined();
  });
});
