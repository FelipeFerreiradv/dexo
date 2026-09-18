import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumoIndevidoCooldownMs,
  cooldownRepeticaoMs,
  devolucaoRefItemProdDesde,
  focusGetTimeoutMs,
  focusPostTimeoutMs,
  isDevolucaoAtiva,
  isFiscalFeatureOn,
  isNumeracaoV2ParaEmissao,
  leaseEnvioFocusMs,
  leaseEnvioSefazMs,
  leasePreEnvioMs,
  modelosNumeracaoV2,
  naoConstaMinMs,
  type FiscalEnv,
  type FiscalFeature,
} from "../../../app/fiscal/flags";

// Flags do módulo fiscal novo: liga só com "true" exato + allowlist por
// companyFiscalConfigId, fail-closed. Env sempre injetado (ou vi.stubEnv).

const CFG = "cfg_kiko";
const OUTRA = "cfg_outra";

const FEATURES: Array<[FiscalFeature, string, string]> = [
  ["NUMERACAO_V2", "NFE_NUMERACAO_V2_ENABLED", "NFE_NUMERACAO_V2_CONFIG_IDS"],
  ["DEVOLUCAO", "NFE_DEVOLUCAO_ENABLED", "NFE_DEVOLUCAO_CONFIG_IDS"],
  ["RESP_TEC_EMPRESA", "NFE_RESP_TEC_EMPRESA_ENABLED", "NFE_RESP_TEC_EMPRESA_CONFIG_IDS"],
];

describe("isFiscalFeatureOn — allowlist por configId, fail-closed", () => {
  describe.each(FEATURES)("%s", (feature, enabled, ids) => {
    it("liga com ENABLED=true e config na lista", () => {
      expect(isFiscalFeatureOn(feature, CFG, { [enabled]: "true", [ids]: CFG })).toBe(true);
    });

    it("lista com espaços e vírgulas sobrando é aparada", () => {
      const env = { [enabled]: "true", [ids]: `  ${OUTRA} , ${CFG} ,, ` };
      expect(isFiscalFeatureOn(feature, CFG, env)).toBe(true);
      expect(isFiscalFeatureOn(feature, OUTRA, env)).toBe(true);
      expect(isFiscalFeatureOn(feature, "cfg_terceira", env)).toBe(false);
    });

    it("\"*\" libera todas as configs", () => {
      const env = { [enabled]: "true", [ids]: " * " };
      expect(isFiscalFeatureOn(feature, CFG, env)).toBe(true);
      expect(isFiscalFeatureOn(feature, "qualquer", env)).toBe(true);
    });

    it("\"*\" misturado a ids NÃO libera todas (ambíguo ⇒ fechado)", () => {
      const env = { [enabled]: "true", [ids]: `${OUTRA},*` };
      expect(isFiscalFeatureOn(feature, CFG, env)).toBe(false);
      expect(isFiscalFeatureOn(feature, OUTRA, env)).toBe(true);
    });

    it.each([
      ["allowlist ausente", { [enabled]: "true" }],
      ["allowlist vazia", { [enabled]: "true", [ids]: "" }],
      ["allowlist só espaços/vírgulas", { [enabled]: "true", [ids]: " , ," }],
      ["config fora da lista", { [enabled]: "true", [ids]: OUTRA }],
      ["ENABLED ausente", { [ids]: "*" }],
      ["ENABLED=1", { [enabled]: "1", [ids]: "*" }],
      ["ENABLED=TRUE", { [enabled]: "TRUE", [ids]: "*" }],
      ["ENABLED=' true'", { [enabled]: " true", [ids]: "*" }],
      ["ENABLED=false", { [enabled]: "false", [ids]: "*" }],
    ])("desligada: %s", (_rotulo, env) => {
      expect(isFiscalFeatureOn(feature, CFG, env as FiscalEnv)).toBe(false);
    });

    it.each([[null], [undefined], [""], ["   "]])("configId %j nunca liga, nem com \"*\"", (id) => {
      expect(isFiscalFeatureOn(feature, id, { [enabled]: "true", [ids]: "*" })).toBe(false);
    });

    it("id parcial não casa (sem substring)", () => {
      expect(isFiscalFeatureOn(feature, "cfg", { [enabled]: "true", [ids]: CFG })).toBe(false);
    });
  });

  it("allowlists são independentes entre features", () => {
    const env = {
      NFE_NUMERACAO_V2_ENABLED: "true",
      NFE_NUMERACAO_V2_CONFIG_IDS: CFG,
      NFE_DEVOLUCAO_ENABLED: "true",
      NFE_DEVOLUCAO_CONFIG_IDS: OUTRA,
    };
    expect(isFiscalFeatureOn("NUMERACAO_V2", CFG, env)).toBe(true);
    expect(isFiscalFeatureOn("DEVOLUCAO", CFG, env)).toBe(false);
    expect(isFiscalFeatureOn("RESP_TEC_EMPRESA", CFG, env)).toBe(false);
  });

  describe("NUMERACAO_V2_FOCUS (sub-flag)", () => {
    const base = { NFE_NUMERACAO_V2_ENABLED: "true", NFE_NUMERACAO_V2_CONFIG_IDS: CFG };

    it("usa a allowlist da V2 e exige a V2 ligada", () => {
      expect(
        isFiscalFeatureOn("NUMERACAO_V2_FOCUS", CFG, { ...base, NFE_NUMERACAO_V2_FOCUS_ENABLED: "true" }),
      ).toBe(true);
      expect(
        isFiscalFeatureOn("NUMERACAO_V2_FOCUS", OUTRA, { ...base, NFE_NUMERACAO_V2_FOCUS_ENABLED: "true" }),
      ).toBe(false);
    });

    it("sub-flag desligada ⇒ off", () => {
      expect(isFiscalFeatureOn("NUMERACAO_V2_FOCUS", CFG, base)).toBe(false);
      expect(
        isFiscalFeatureOn("NUMERACAO_V2_FOCUS", CFG, { ...base, NFE_NUMERACAO_V2_FOCUS_ENABLED: "1" }),
      ).toBe(false);
    });

    it("V2 desligada ⇒ off mesmo com a sub-flag ligada", () => {
      expect(
        isFiscalFeatureOn("NUMERACAO_V2_FOCUS", CFG, {
          NFE_NUMERACAO_V2_ENABLED: "false",
          NFE_NUMERACAO_V2_CONFIG_IDS: "*",
          NFE_NUMERACAO_V2_FOCUS_ENABLED: "true",
        }),
      ).toBe(false);
    });

    it("não existe allowlist própria da Focus", () => {
      expect(
        isFiscalFeatureOn("NUMERACAO_V2_FOCUS", CFG, {
          NFE_NUMERACAO_V2_FOCUS_ENABLED: "true",
          NFE_NUMERACAO_V2_FOCUS_CONFIG_IDS: CFG,
        }),
      ).toBe(false);
    });
  });
});

describe("leitura em tempo de chamada (process.env)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reflete vi.stubEnv sem recarregar o módulo", () => {
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFG);
    expect(isFiscalFeatureOn("NUMERACAO_V2", CFG)).toBe(true);
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "false");
    expect(isFiscalFeatureOn("NUMERACAO_V2", CFG)).toBe(false);
  });

  it("tunables também leem process.env na chamada", () => {
    vi.stubEnv("NFE_NUMERACAO_V2_LEASE_PRE_ENVIO_MS", "1234");
    expect(leasePreEnvioMs()).toBe(1234);
  });
});

describe("modelosNumeracaoV2 / isNumeracaoV2ParaEmissao", () => {
  const v2 = { NFE_NUMERACAO_V2_ENABLED: "true", NFE_NUMERACAO_V2_CONFIG_IDS: CFG };

  it.each([
    [undefined, ["55"]],
    ["", ["55"]],
    ["   ", ["55"]],
    ["65", ["65"]],
    ["55,65", ["55", "65"]],
    [" 65 , 55 ,55", ["65", "55"]],
    ["57,abc", []],
  ])("MODELOS=%j ⇒ %j", (raw, esperado) => {
    expect(modelosNumeracaoV2({ NFE_NUMERACAO_V2_MODELOS: raw })).toEqual(esperado);
  });

  it("SEFAZ direto, modelo 55 default ⇒ V2", () => {
    expect(isNumeracaoV2ParaEmissao(CFG, "55", "SEFAZ_DIRECT", v2)).toBe(true);
  });

  it("modelo 65 fora do default ⇒ V1", () => {
    expect(isNumeracaoV2ParaEmissao(CFG, "65", "SEFAZ_DIRECT", v2)).toBe(false);
    expect(
      isNumeracaoV2ParaEmissao(CFG, "65", "SEFAZ_DIRECT", { ...v2, NFE_NUMERACAO_V2_MODELOS: "55,65" }),
    ).toBe(true);
  });

  it("MODELOS=65 exclui o 55", () => {
    expect(isNumeracaoV2ParaEmissao(CFG, "55", "SEFAZ_DIRECT", { ...v2, NFE_NUMERACAO_V2_MODELOS: "65" })).toBe(
      false,
    );
  });

  it.each([["FOCUS_NFE"], [null], ["OUTRO"]])("provedor %j exige a sub-flag da Focus", (provider) => {
    expect(isNumeracaoV2ParaEmissao(CFG, "55", provider, v2)).toBe(false);
    expect(
      isNumeracaoV2ParaEmissao(CFG, "55", provider, { ...v2, NFE_NUMERACAO_V2_FOCUS_ENABLED: "true" }),
    ).toBe(true);
  });

  it("config fora da allowlist ⇒ V1 em qualquer provedor", () => {
    const env = { ...v2, NFE_NUMERACAO_V2_FOCUS_ENABLED: "true" };
    expect(isNumeracaoV2ParaEmissao(OUTRA, "55", "SEFAZ_DIRECT", env)).toBe(false);
    expect(isNumeracaoV2ParaEmissao(OUTRA, "55", "FOCUS_NFE", env)).toBe(false);
    expect(isNumeracaoV2ParaEmissao(null, "55", "SEFAZ_DIRECT", env)).toBe(false);
  });

  it("V2 desligada ⇒ V1", () => {
    expect(isNumeracaoV2ParaEmissao(CFG, "55", "SEFAZ_DIRECT", { NFE_NUMERACAO_V2_CONFIG_IDS: CFG })).toBe(false);
  });
});

describe("isDevolucaoAtiva — devolução exige a numeração V2 da mesma config", () => {
  const dev = { NFE_DEVOLUCAO_ENABLED: "true", NFE_DEVOLUCAO_CONFIG_IDS: CFG };
  const v2 = { NFE_NUMERACAO_V2_ENABLED: "true", NFE_NUMERACAO_V2_CONFIG_IDS: CFG };

  it("devolução + V2 na mesma config ⇒ ativa", () => {
    expect(isDevolucaoAtiva(CFG, { ...dev, ...v2 })).toBe(true);
  });

  it("devolução sem V2 ⇒ inativa", () => {
    expect(isDevolucaoAtiva(CFG, dev)).toBe(false);
    expect(isDevolucaoAtiva(CFG, { ...dev, NFE_NUMERACAO_V2_ENABLED: "true" })).toBe(false);
  });

  it("V2 de OUTRA config não serve", () => {
    expect(isDevolucaoAtiva(CFG, { ...dev, NFE_NUMERACAO_V2_ENABLED: "true", NFE_NUMERACAO_V2_CONFIG_IDS: OUTRA })).toBe(
      false,
    );
  });

  it("V2 sem devolução ⇒ inativa", () => {
    expect(isDevolucaoAtiva(CFG, v2)).toBe(false);
  });

  it("V2 cobrindo só o modelo 65 ⇒ inativa (devolução é modelo 55)", () => {
    expect(isDevolucaoAtiva(CFG, { ...dev, ...v2, NFE_NUMERACAO_V2_MODELOS: "65" })).toBe(false);
  });

  it("allowlists com \"*\"", () => {
    expect(
      isDevolucaoAtiva("qualquer", {
        NFE_DEVOLUCAO_ENABLED: "true",
        NFE_DEVOLUCAO_CONFIG_IDS: "*",
        NFE_NUMERACAO_V2_ENABLED: "true",
        NFE_NUMERACAO_V2_CONFIG_IDS: "*",
      }),
    ).toBe(true);
  });

  it("configId nulo ⇒ inativa", () => {
    expect(isDevolucaoAtiva(null, { ...dev, ...v2 })).toBe(false);
  });
});

describe("tunables", () => {
  it("naoConstaMinMs deriva do transporte SOAP de produção: 60000×4 + 15000 + 30000", () => {
    expect(naoConstaMinMs({})).toBe(285_000);
    expect(naoConstaMinMs({ SEFAZ_TIMEOUT_MS: "60000", SEFAZ_RETRY_MAX: "3" })).toBe(285_000);
  });

  it("naoConstaMinMs acompanha SEFAZ_TIMEOUT_MS e SEFAZ_RETRY_MAX", () => {
    expect(naoConstaMinMs({ SEFAZ_TIMEOUT_MS: "30000", SEFAZ_RETRY_MAX: "0" })).toBe(30_000 + 15_000 + 30_000);
    expect(naoConstaMinMs({ SEFAZ_TIMEOUT_MS: "20000", SEFAZ_RETRY_MAX: "1" })).toBe(40_000 + 15_000 + 30_000);
  });

  it("backoff real acima do orçamento mínimo é somado (retry alto)", () => {
    // Σ min(500·2^i, 8000) para i=0..9 = 500+1000+2000+4000+8000×6 = 55 500
    expect(naoConstaMinMs({ SEFAZ_TIMEOUT_MS: "1000", SEFAZ_RETRY_MAX: "10" })).toBe(11_000 + 55_500 + 30_000);
  });

  it("valores inválidos do transporte seguem o default do SoapClient", () => {
    expect(naoConstaMinMs({ SEFAZ_TIMEOUT_MS: "abc", SEFAZ_RETRY_MAX: "-1" })).toBe(285_000);
    expect(naoConstaMinMs({ SEFAZ_TIMEOUT_MS: "0", SEFAZ_RETRY_MAX: "" })).toBe(285_000);
  });

  it("override explícito de naoConstaMinMs", () => {
    expect(naoConstaMinMs({ NFE_NUMERACAO_V2_NAO_CONSTA_MIN_MS: "120000" })).toBe(120_000);
  });

  it.each([["abc"], ["-5"], ["0"], ["1.5"], ["1e6"], [""], ["9999999999999999999"]])(
    "override inválido %j ⇒ default derivado",
    (raw) => {
      expect(naoConstaMinMs({ NFE_NUMERACAO_V2_NAO_CONSTA_MIN_MS: raw })).toBe(285_000);
    },
  );

  it("leaseEnvioSefazMs = 2 × naoConstaMinMs, com piso de 300 000", () => {
    expect(leaseEnvioSefazMs({})).toBe(570_000);
    expect(leaseEnvioSefazMs({ NFE_NUMERACAO_V2_NAO_CONSTA_MIN_MS: "100000" })).toBe(300_000);
    expect(leaseEnvioSefazMs({ NFE_NUMERACAO_V2_NAO_CONSTA_MIN_MS: "200000" })).toBe(400_000);
    expect(leaseEnvioSefazMs({ NFE_NUMERACAO_V2_LEASE_SEFAZ_MS: "900000" })).toBe(900_000);
    expect(leaseEnvioSefazMs({ NFE_NUMERACAO_V2_LEASE_SEFAZ_MS: "60000" })).toBe(300_000);
  });

  it("lease SEFAZ cobre o pior caso de uma transmissão em voo", () => {
    const env = { SEFAZ_TIMEOUT_MS: "60000", SEFAZ_RETRY_MAX: "3" };
    const piorCasoTransporte = 60_000 * 4 + 3_500;
    expect(leaseEnvioSefazMs(env)).toBeGreaterThan(piorCasoTransporte);
    expect(naoConstaMinMs(env)).toBeGreaterThan(piorCasoTransporte);
  });

  it.each([
    [leasePreEnvioMs, "NFE_NUMERACAO_V2_LEASE_PRE_ENVIO_MS", 600_000],
    [leaseEnvioFocusMs, "NFE_NUMERACAO_V2_LEASE_FOCUS_MS", 180_000],
    [focusPostTimeoutMs, "FOCUS_V2_POST_TIMEOUT_MS", 45_000],
    [focusGetTimeoutMs, "FOCUS_V2_GET_TIMEOUT_MS", 15_000],
    [cooldownRepeticaoMs, "NFE_NUMERACAO_V2_COOLDOWN_REPETICAO_MS", 60_000],
    [consumoIndevidoCooldownMs, "NFE_NUMERACAO_V2_COOLDOWN_CONSUMO_INDEVIDO_MS", 3_600_000],
  ] as const)("%o: default, override e inválido (%s)", (fn, nome, padrao) => {
    expect(fn({})).toBe(padrao);
    expect(fn({ [nome]: " 4321 " })).toBe(4321);
    expect(fn({ [nome]: "0" })).toBe(padrao);
    expect(fn({ [nome]: "-10" })).toBe(padrao);
    expect(fn({ [nome]: "10ms" })).toBe(padrao);
    expect(fn({ [nome]: "NaN" })).toBe(padrao);
  });

  it.each([
    [undefined, "2026-10-05"],
    ["", "2026-10-05"],
    ["2026-11-01", "2026-11-01"],
    [" 2027-01-31 ", "2027-01-31"],
    ["2026-02-30", "2026-10-05"],
    ["2026-13-01", "2026-10-05"],
    ["05/10/2026", "2026-10-05"],
    ["2026-10-5", "2026-10-05"],
    ["amanhã", "2026-10-05"],
    ["2024-02-29", "2024-02-29"],
  ])("devolucaoRefItemProdDesde(%j) ⇒ %s", (raw, esperado) => {
    expect(devolucaoRefItemProdDesde({ NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE: raw })).toBe(esperado);
  });
});
