import { describe, it, expect } from "vitest";
import {
  COMPAT_POSITION_LABELS,
  COMPAT_POSITION_MAX_VALUES,
  buildCompatRestrictions,
  compatPositionRoot,
  conflictsWithCompatPositions,
  inspectRestrictionsEcho,
  resolveCompatPositions,
  sanitizeCompatPositions,
} from "../app/marketplaces/lib/ml-compat-position.logic";

/**
 * Posição das compatibilidades do ML.
 *
 * O contrato de escrita foi medido contra a API em 05/08/2026 (sonda
 * `probe-ml-compat-positions`), e o achado que mais pesa no desenho é este: com
 * `value_id` inválido o ML responde **200 com `restrictions: []`** — aceita o
 * corpo e descarta o conteúdo em silêncio. Por isso este módulo resolve os ids
 * contra a API e confere o eco, em vez de confiar no status HTTP.
 */

/**
 * Valores reais devolvidos por
 * GET /catalog_compatibilities/restrictions/values
 *   ?main_domain_id=MLB-CARS_AND_VANS&secondary_domain_id=MLB-VEHICLE_HEADLIGHTS
 * — os 12 rótulos da UI existem nesse par.
 */
const VALORES_REAIS = [
  { value_id: "13701104", value_name: "Dianteira" },
  { value_id: "13701105", value_name: "Traseira" },
  { value_id: "2262158", value_name: "Esquerda" },
  { value_id: "2262160", value_name: "Direita" },
  { value_id: "13373175", value_name: "Motorista" },
  { value_id: "13373176", value_name: "Passageiro" },
  { value_id: "13373177", value_name: "Interno" },
  { value_id: "13373178", value_name: "Externo" },
  { value_id: "4774238", value_name: "Superior" },
  { value_id: "4774239", value_name: "Inferior" },
  { value_id: "13373179", value_name: "Intermédio" },
  { value_id: "13373180", value_name: "Centro" },
];

describe("compatPositionRoot", () => {
  it("apaga a flexão de gênero: o ML escreve Interno, o operador digita Interna", () => {
    expect(compatPositionRoot("Interna")).toBe(compatPositionRoot("Interno"));
    expect(compatPositionRoot("Externa")).toBe(compatPositionRoot("Externo"));
    expect(compatPositionRoot("Intermediária")).toBe(
      compatPositionRoot("Intermédio"),
    );
  });

  it("ignora acento e caixa", () => {
    expect(compatPositionRoot("  DIANTEIRA ")).toBe(
      compatPositionRoot("dianteira"),
    );
    expect(compatPositionRoot("Intermedio")).toBe(
      compatPositionRoot("Intermédio"),
    );
  });

  it("não confunde rótulos diferentes", () => {
    const raizes = COMPAT_POSITION_LABELS.map(compatPositionRoot);
    expect(new Set(raizes).size).toBe(COMPAT_POSITION_LABELS.length);
  });
});

describe("conflictsWithCompatPositions", () => {
  it("bloqueia os 5 pares opostos nos dois sentidos", () => {
    const pares: Array<[string, string]> = [
      ["Dianteira", "Traseira"],
      ["Esquerda", "Direita"],
      ["Motorista", "Passageiro"],
      ["Interno", "Externo"],
      ["Superior", "Inferior"],
    ];
    for (const [a, b] of pares) {
      expect(conflictsWithCompatPositions([a], b)).toBe(true);
      expect(conflictsWithCompatPositions([b], a)).toBe(true);
    }
  });

  it("libera combinação de eixos diferentes — é o caso de uso real", () => {
    expect(conflictsWithCompatPositions(["Dianteira"], "Esquerda")).toBe(false);
    expect(conflictsWithCompatPositions(["Dianteira", "Esquerda"], "Superior")).toBe(
      false,
    );
  });

  it("Intermédio e Centro não têm oposto — é o que a API devolve", () => {
    expect(conflictsWithCompatPositions(["Centro"], "Intermédio")).toBe(false);
    expect(conflictsWithCompatPositions(["Intermédio"], "Centro")).toBe(false);
    expect(conflictsWithCompatPositions(["Centro"], "Dianteira")).toBe(false);
  });

  it("o conflito é por raiz, não por string", () => {
    expect(conflictsWithCompatPositions(["Interna"], "Externo")).toBe(true);
  });
});

describe("sanitizeCompatPositions", () => {
  it("preserva a ordem de escolha", () => {
    expect(sanitizeCompatPositions(["Esquerda", "Dianteira"])).toEqual([
      "Esquerda",
      "Dianteira",
    ]);
  });

  it("normaliza para a grafia do ML", () => {
    expect(sanitizeCompatPositions(["interna", " EXTERNA "])).toEqual([
      "Interno",
    ]);
  });

  it("descarta o que não é rótulo conhecido", () => {
    expect(
      sanitizeCompatPositions(["Dianteira", "Turbo", "", null, 42, {}]),
    ).toEqual(["Dianteira"]);
  });

  it("descarta repetido por raiz", () => {
    expect(
      sanitizeCompatPositions(["Dianteira", "dianteira", "DIANTEIRA"]),
    ).toEqual(["Dianteira"]);
  });

  it("descarta o conflitante e mantém o primeiro", () => {
    expect(sanitizeCompatPositions(["Esquerda", "Direita"])).toEqual([
      "Esquerda",
    ]);
  });

  it(`corta em ${COMPAT_POSITION_MAX_VALUES} valores`, () => {
    const entrada = [
      "Dianteira",
      "Esquerda",
      "Superior",
      "Interno",
      "Centro",
      "Motorista",
    ];
    const saida = sanitizeCompatPositions(entrada);
    expect(saida).toHaveLength(COMPAT_POSITION_MAX_VALUES);
    expect(saida).toEqual(["Dianteira", "Esquerda", "Superior", "Interno"]);
  });

  it("entrada que não é array vira lista vazia", () => {
    expect(sanitizeCompatPositions(undefined)).toEqual([]);
    expect(sanitizeCompatPositions(null)).toEqual([]);
    expect(sanitizeCompatPositions("Dianteira")).toEqual([]);
    expect(sanitizeCompatPositions({ 0: "Dianteira" })).toEqual([]);
  });

  it("é idempotente e devolve array novo", () => {
    const uma = sanitizeCompatPositions(["Dianteira", "Esquerda"]);
    const duas = sanitizeCompatPositions(uma);
    expect(duas).toEqual(uma);
    expect(duas).not.toBe(uma);
  });

  it("todos os 12 rótulos da UI sobrevivem à sanitização", () => {
    for (const label of COMPAT_POSITION_LABELS) {
      expect(sanitizeCompatPositions([label])).toEqual([label]);
    }
  });
});

describe("resolveCompatPositions", () => {
  it("resolve os value_id reais do par de domínios", () => {
    const r = resolveCompatPositions(["Dianteira", "Esquerda"], VALORES_REAIS);
    expect(r.resolved).toEqual([
      { value_id: "13701104", value_name: "Dianteira" },
      { value_id: "2262158", value_name: "Esquerda" },
    ]);
    expect(r.unresolved).toEqual([]);
  });

  it("resolve mesmo com a flexão de gênero trocada", () => {
    const r = resolveCompatPositions(["Interna"], VALORES_REAIS);
    expect(r.resolved).toEqual([
      { value_id: "13373177", value_name: "Interno" },
    ]);
  });

  it("resolve PARCIALMENTE: manda o que existe e reporta o que faltou", () => {
    // Nem toda categoria de peça expõe os 12 rótulos. Mandar "Dianteira"
    // sozinha é melhor do que não mandar posição nenhuma — desde que o que
    // ficou de fora volte para quem chamou registrar.
    const soEixo = [
      { value_id: "13701104", value_name: "Dianteira" },
      { value_id: "13701105", value_name: "Traseira" },
    ];
    const r = resolveCompatPositions(["Dianteira", "Esquerda"], soEixo);
    expect(r.resolved).toEqual([
      { value_id: "13701104", value_name: "Dianteira" },
    ]);
    expect(r.unresolved).toEqual(["Esquerda"]);
  });

  it("lista de permitidos vazia não resolve nada", () => {
    const r = resolveCompatPositions(["Dianteira"], []);
    expect(r.resolved).toEqual([]);
    expect(r.unresolved).toEqual(["Dianteira"]);
  });

  it("ignora entrada malformada do ML sem quebrar", () => {
    const sujo = [
      { value_id: null, value_name: "Dianteira" },
      { value_id: "1", value_name: "" },
      { value_name: "Esquerda" },
      { value_id: "2262158", value_name: "Esquerda" },
    ] as Array<{ value_id?: unknown; value_name?: unknown }>;
    const r = resolveCompatPositions(["Dianteira", "Esquerda"], sujo);
    expect(r.resolved).toEqual([
      { value_id: "2262158", value_name: "Esquerda" },
    ]);
    expect(r.unresolved).toEqual(["Dianteira"]);
  });
});

describe("buildCompatRestrictions", () => {
  it("monta exatamente o bloco que a API aceitou em produção", () => {
    const bloco = buildCompatRestrictions([
      { value_id: "13701104", value_name: "Dianteira" },
      { value_id: "2262158", value_name: "Esquerda" },
    ]);
    expect(bloco).toEqual([
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
    ]);
  });

  it("uma posição por produto: sempre UMA entrada em attribute_values", () => {
    const bloco = buildCompatRestrictions([
      { value_id: "13701104", value_name: "Dianteira" },
      { value_id: "2262158", value_name: "Esquerda" },
      { value_id: "4774238", value_name: "Superior" },
    ]);
    expect(bloco?.[0].attribute_values).toHaveLength(1);
    expect(bloco?.[0].attribute_values[0].values).toHaveLength(3);
  });

  it("sem valores devolve null — é o que mantém o payload de hoje intacto", () => {
    expect(buildCompatRestrictions([])).toBeNull();
    expect(
      buildCompatRestrictions(undefined as unknown as never[]),
    ).toBeNull();
  });

  it("não vaza referência dos valores de entrada", () => {
    const entrada = [{ value_id: "13701104", value_name: "Dianteira" }];
    const bloco = buildCompatRestrictions(entrada);
    expect(bloco?.[0].attribute_values[0].values[0]).not.toBe(entrada[0]);
  });
});

describe("inspectRestrictionsEcho", () => {
  it("resposta REAL de sucesso medida em produção conta como gravada", () => {
    // Corpo do PUT que levou o item MLBU4609176634 de 57 para 58
    // compatibilidades, a nova com as duas posições.
    const ok = {
      create: {
        products: [
          {
            id: "MLB22568426",
            product_type: "PRODUCT",
            restrictions: [
              {
                attribute_id: "POSITION",
                attribute_code: 37,
                attribute_values: [
                  {
                    values: [
                      {
                        value_id: "13701104",
                        value_name: "Dianteira",
                        value_code: 1,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(inspectRestrictionsEcho(ok)).toEqual({
      verdict: "echoed",
      count: 1,
    });
  });

  it("200 com restrictions VAZIO é descarte silencioso, não sucesso", () => {
    // O caso que motiva a função inteira: é assim que o ML responde quando o
    // value_id não vale para o par de domínios. O `id` vem ecoado normalmente,
    // então o inspectCompatWriteResponse leria isto como sucesso.
    const descartado = {
      create: {
        products: [
          { id: "MLB10231260", product_type: "PRODUCT", restrictions: [] },
        ],
      },
    };
    expect(inspectRestrictionsEcho(descartado)).toEqual({
      verdict: "dropped",
      count: 0,
    });
  });

  it("resposta sem a chave é inconclusiva, nunca reprovada", () => {
    // Mesma regra do inspectCompatWriteResponse: só reprovamos com evidência
    // positiva. Sem isso, todo mock de teste e todo formato novo viraria erro.
    expect(inspectRestrictionsEcho({})).toEqual({
      verdict: "unknown",
      count: 0,
    });
    expect(inspectRestrictionsEcho(null)).toEqual({
      verdict: "unknown",
      count: 0,
    });
    expect(inspectRestrictionsEcho("nao é objeto")).toEqual({
      verdict: "unknown",
      count: 0,
    });
    expect(
      inspectRestrictionsEcho({ create: { products: [{ id: "MLB1" }] } }),
    ).toEqual({ verdict: "unknown", count: 0 });
  });

  it("conta as posições de todos os produtos da resposta", () => {
    const dois = {
      create: {
        products: [
          {
            id: "MLB1",
            restrictions: [
              { attribute_id: "POSITION", attribute_values: [{ values: [] }] },
            ],
          },
          {
            id: "MLB2",
            restrictions: [
              { attribute_id: "POSITION", attribute_values: [{ values: [] }] },
            ],
          },
        ],
      },
    };
    expect(inspectRestrictionsEcho(dois)).toEqual({
      verdict: "echoed",
      count: 2,
    });
  });

  it("aceita a resposta sem o envelope `create`", () => {
    const semEnvelope = {
      products: [
        {
          id: "MLB1",
          restrictions: [
            { attribute_id: "POSITION", attribute_values: [{ values: [] }] },
          ],
        },
      ],
    };
    expect(inspectRestrictionsEcho(semEnvelope).verdict).toBe("echoed");
  });

  it("um produto sem posição não apaga a evidência de outro que gravou", () => {
    const misto = {
      create: {
        products: [
          { id: "MLB1", restrictions: [] },
          {
            id: "MLB2",
            restrictions: [
              { attribute_id: "POSITION", attribute_values: [{ values: [] }] },
            ],
          },
        ],
      },
    };
    expect(inspectRestrictionsEcho(misto).verdict).toBe("echoed");
  });
});
