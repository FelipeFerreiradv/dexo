import { describe, it, expect, vi } from "vitest";
import {
  focusBaseUrl,
  FOCUS_BASE_URL,
  resolvedParaLog,
  resolveNfeProviderConfig,
  resolveRespTec,
  respTecParaPayloadSefaz,
  type NfeProviderResolved,
  type ResolveNfeProviderOpcoes,
  type RespTecRow,
} from "../../../app/fiscal/providers/nfe-provider-resolver";
import { avisosRespTec } from "../../../app/fiscal/domain/resp-tec";
import type { CompanyFiscalConfig } from "../../../app/interfaces/company-fiscal.interface";

// Sentinelas: nunca podem aparecer em erro nem em log.
const TOKEN = "TOKEN-SENTINELA-abc123";
const CSRT = "CSRT-SENTINELA-XYZ789";
const CSRT_ENC = "iv:tag:CSRTENC-SENTINELA";
// CNPJ sintético (DV válido).
const CNPJ_RT = "11222333000181";

function config(extra: Partial<CompanyFiscalConfig> = {}): CompanyFiscalConfig {
  return {
    id: "cfg-teste",
    userId: "user-teste",
    cnpj: "11444777000161",
    razaoSocial: "Empresa Teste",
    nomeFantasia: null,
    inscricaoEstadual: "123",
    inscricaoMunicipal: null,
    regimeTributario: "SIMPLES",
    cnae: null,
    ambiente: "HOMOLOGACAO",
    cep: null,
    logradouro: null,
    numero: null,
    complemento: null,
    bairro: null,
    municipio: null,
    codMunicipio: null,
    uf: "SP",
    codPais: null,
    pais: null,
    certificadoPath: null,
    certificadoSenhaEnc: null,
    certificadoValidoAte: null,
    certificadoSubjectCN: null,
    providerName: "FOCUS_NFE",
    providerToken: TOKEN,
    serieNfe: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...extra,
  };
}

function row(extra: Partial<RespTecRow> = {}): RespTecRow {
  return {
    modo: "PERSONALIZADO",
    cnpj: CNPJ_RT,
    xContato: "Suporte Fornecedor",
    email: "suporte@fornecedor.com.br",
    fone: "4133334444",
    idCsrt: null,
    csrtEnc: null,
    ...extra,
  };
}

function opcoes(extra: Partial<ResolveNfeProviderOpcoes> = {}): ResolveNfeProviderOpcoes {
  return {
    modelo: "55",
    respTecRow: null,
    respTecAtivo: true,
    numeracaoDexoFocus: false,
    decryptSecret: vi.fn((enc: string) => (enc === CSRT_ENC ? CSRT : "outro")),
    ...extra,
  };
}

const decryptOk = () => vi.fn((_enc: string) => CSRT);
const SP_HOM = { uf: "SP", ambiente: "HOMOLOGACAO" as const };

function capturar(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("esperava exceção");
}

/** A rota /issue devolve 400 só com estes trechos (fiscal.routes.ts). */
function mapeiaPara400(msg: string): boolean {
  return (
    msg.includes("incompleto") ||
    msg.includes("obrigat") ||
    msg.includes("invalid") ||
    msg.includes("Token")
  );
}

describe("resolveNfeProviderConfig — provedor, ambiente, Focus", () => {
  it("Focus homologação: base URL, path nfe, token aparado, numeração do provedor", () => {
    const r = resolveNfeProviderConfig(
      config({ providerToken: `  ${TOKEN}  ` }),
      opcoes(),
    );
    expect(r).toEqual<NfeProviderResolved>({
      providerName: "FOCUS_NFE",
      ambiente: "HOMOLOGACAO",
      modelo: "55",
      focus: {
        baseUrl: "https://homologacao.focusnfe.com.br",
        path: "nfe",
        token: TOKEN,
      },
      sefaz: null,
      numeracao: "PROVEDOR",
      respTec: { origem: "PROVEDOR" },
    });
  });

  it("Focus produção + modelo 65 → api.focusnfe.com.br e path nfce", () => {
    const r = resolveNfeProviderConfig(
      config({ ambiente: "PRODUCAO" }),
      opcoes({ modelo: "65" }),
    );
    expect(r.ambiente).toBe("PRODUCAO");
    expect(r.modelo).toBe("65");
    expect(r.focus).toEqual({
      baseUrl: "https://api.focusnfe.com.br",
      path: "nfce",
      token: TOKEN,
    });
  });

  it("focusBaseUrl e constantes", () => {
    expect(focusBaseUrl("HOMOLOGACAO")).toBe("https://homologacao.focusnfe.com.br");
    expect(focusBaseUrl("PRODUCAO")).toBe("https://api.focusnfe.com.br");
    expect(Object.isFrozen(FOCUS_BASE_URL)).toBe(true);
  });

  it("numeração Dexo no Focus só com a sub-flag decidida pelo chamador", () => {
    expect(resolveNfeProviderConfig(config(), opcoes({ numeracaoDexoFocus: true })).numeracao).toBe("DEXO");
    expect(resolveNfeProviderConfig(config(), opcoes({ numeracaoDexoFocus: false })).numeracao).toBe("PROVEDOR");
  });

  it("providerName null ou desconhecido cai no Focus (default do provider-factory)", () => {
    for (const providerName of [null, "OUTRO", ""]) {
      expect(resolveNfeProviderConfig(config({ providerName }), opcoes()).providerName).toBe("FOCUS_NFE");
    }
  });

  it("Focus sem token → erro com o ambiente, mapeado para 400", () => {
    for (const providerToken of [null, "", "   "]) {
      for (const ambiente of ["HOMOLOGACAO", "PRODUCAO"] as const) {
        const e = capturar(() =>
          resolveNfeProviderConfig(config({ providerToken, ambiente }), opcoes()),
        );
        expect(e.message).toBe(
          `Token do provedor Focus NFe nao configurado para o ambiente ${ambiente}`,
        );
        expect(mapeiaPara400(e.message)).toBe(true);
      }
    }
  });

  it("SEFAZ direto: sem bloco Focus (mesmo com token salvo), UF normalizada, numeração sempre Dexo", () => {
    const r = resolveNfeProviderConfig(
      config({ providerName: "SEFAZ_DIRECT", uf: " pr ", providerToken: TOKEN }),
      opcoes({ numeracaoDexoFocus: false }),
    );
    expect(r.providerName).toBe("SEFAZ_DIRECT");
    expect(r.focus).toBeNull();
    expect(r.sefaz).toEqual({ uf: "PR" });
    expect(r.numeracao).toBe("DEXO");
    expect(r.respTec).toEqual({ origem: "ENV_LEGADO" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("SEFAZ direto sem token não lança (autentica por certificado)", () => {
    expect(() =>
      resolveNfeProviderConfig(
        config({ providerName: "SEFAZ_DIRECT", providerToken: null }),
        opcoes(),
      ),
    ).not.toThrow();
  });

  it("aceita subconjunto da config (Pick)", () => {
    const r = resolveNfeProviderConfig(
      { providerName: "SEFAZ_DIRECT", providerToken: null, ambiente: "PRODUCAO", uf: "SP" },
      opcoes(),
    );
    expect(r.sefaz).toEqual({ uf: "SP" });
  });

  it("repassa UF e ambiente da config para as regras de RT", () => {
    const e = capturar(() =>
      resolveNfeProviderConfig(
        config({ providerName: "SEFAZ_DIRECT", uf: "PR", ambiente: "PRODUCAO" }),
        opcoes({ respTecRow: row() }),
      ),
    );
    expect(e.message).toMatch(/975/);
  });
});

describe("resolveRespTec — tabela de modos", () => {
  describe("flag desligada ou sem linha → comportamento atual", () => {
    it("SEFAZ → ENV_LEGADO; Focus → PROVEDOR, para qualquer linha (inclusive inválida)", () => {
      const linhas: (RespTecRow | null)[] = [
        null,
        row(),
        row({ modo: "NENHUM" }),
        row({ modo: "PROVEDOR" }),
        row({ modo: "LIXO", cnpj: "x" }),
        row({ idCsrt: "01", csrtEnc: CSRT_ENC }),
      ];
      for (const linha of linhas) {
        const decrypt = decryptOk();
        expect(resolveRespTec("SEFAZ_DIRECT", linha, false, decrypt, SP_HOM)).toEqual({ origem: "ENV_LEGADO" });
        expect(resolveRespTec("FOCUS_NFE", linha, false, decrypt, SP_HOM)).toEqual({ origem: "PROVEDOR" });
        expect(decrypt).not.toHaveBeenCalled();
      }
    });

    it("flag ligada sem linha → idem", () => {
      expect(resolveRespTec("SEFAZ_DIRECT", null, true, decryptOk(), SP_HOM)).toEqual({ origem: "ENV_LEGADO" });
      expect(resolveRespTec(null, null, true, decryptOk(), SP_HOM)).toEqual({ origem: "PROVEDOR" });
    });

    it("SEFAZ PADRAO em PR PRODUCAO continua ENV_LEGADO (sem bloqueio novo)", () => {
      expect(
        resolveRespTec("SEFAZ_DIRECT", row({ modo: "PADRAO" }), true, decryptOk(), { uf: "PR", ambiente: "PRODUCAO" }),
      ).toEqual({ origem: "ENV_LEGADO" });
    });
  });

  describe("SEFAZ direto", () => {
    it("PADRAO → ENV_LEGADO (dados salvos ignorados)", () => {
      expect(resolveRespTec("SEFAZ_DIRECT", row({ modo: "PADRAO", cnpj: "lixo" }), true, decryptOk(), SP_HOM)).toEqual({ origem: "ENV_LEGADO" });
    });

    it("PROVEDOR → erro com a mensagem exata, mapeado para 400", () => {
      const e = capturar(() => resolveRespTec("SEFAZ_DIRECT", row({ modo: "PROVEDOR" }), true, decryptOk(), SP_HOM));
      expect(e.message).toBe("Responsavel tecnico invalido: o modo Provedor nao se aplica ao SEFAZ Direto");
      expect(mapeiaPara400(e.message)).toBe(true);
    });

    it("NENHUM fora das UFs que exigem RT → OMITIR, sem decifrar", () => {
      const decrypt = decryptOk();
      expect(resolveRespTec("SEFAZ_DIRECT", row({ modo: "NENHUM", idCsrt: "01", csrtEnc: CSRT_ENC }), true, decrypt, SP_HOM)).toEqual({ origem: "OMITIR" });
      expect(decrypt).not.toHaveBeenCalled();
    });

    it("PERSONALIZADO sem CSRT → EMPRESA só com os 4 campos", () => {
      const decrypt = decryptOk();
      const p = resolveRespTec(
        "SEFAZ_DIRECT",
        row({ cnpj: "11.222.333/0001-81", fone: "(41) 3333-4444", xContato: "  Suporte Fornecedor " }),
        true,
        decrypt,
        SP_HOM,
      );
      expect(p).toEqual({
        origem: "EMPRESA",
        dados: {
          cnpj: CNPJ_RT,
          xContato: "Suporte Fornecedor",
          email: "suporte@fornecedor.com.br",
          fone: "4133334444",
        },
      });
      expect(decrypt).not.toHaveBeenCalled();
    });

    it("PERSONALIZADO com idCsrt + CSRT salvo → EMPRESA com idCSRT e CSRT decifrado", () => {
      const decrypt = vi.fn((enc: string) => (enc === CSRT_ENC ? `  ${CSRT} ` : "errado"));
      const p = resolveRespTec("SEFAZ_DIRECT", row({ idCsrt: "01", csrtEnc: CSRT_ENC }), true, decrypt, SP_HOM);
      expect(p).toEqual({
        origem: "EMPRESA",
        dados: {
          cnpj: CNPJ_RT,
          xContato: "Suporte Fornecedor",
          email: "suporte@fornecedor.com.br",
          fone: "4133334444",
          idCSRT: "01",
          csrt: CSRT,
        },
      });
      expect(decrypt).toHaveBeenCalledTimes(1);
      expect(decrypt).toHaveBeenCalledWith(CSRT_ENC);
    });

    it("PERSONALIZADO com só metade do par → erro (não envia grupo pela metade)", () => {
      const e1 = capturar(() => resolveRespTec("SEFAZ_DIRECT", row({ idCsrt: "01" }), true, decryptOk(), SP_HOM));
      expect(e1.message).toMatch(/Responsavel tecnico incompleto ou invalido/);
      const e2 = capturar(() => resolveRespTec("SEFAZ_DIRECT", row({ csrtEnc: CSRT_ENC }), true, decryptOk(), SP_HOM));
      expect(e2.message).toMatch(/Responsavel tecnico incompleto ou invalido/);
    });

    it("PERSONALIZADO incompleto → erro sem acento, com todos os campos faltantes, mapeado para 400", () => {
      const e = capturar(() =>
        resolveRespTec("SEFAZ_DIRECT", row({ cnpj: "11222333000182", email: null, fone: "123" }), true, decryptOk(), SP_HOM),
      );
      expect(e.message).toMatch(/^Responsavel tecnico incompleto ou invalido: /);
      expect(e.message).toMatch(/^[\x20-\x7E]*$/);
      expect(e.message).toMatch(/CNPJ/);
      expect(e.message).toMatch(/e-mail/);
      expect(e.message).toMatch(/Telefone/);
      expect(mapeiaPara400(e.message)).toBe(true);
    });

    it("CSRT ilegível → erro próprio, sem vazar o erro do decrypt nem o cifrado", () => {
      const decrypt = vi.fn(() => {
        throw new Error(`falha ao decifrar ${CSRT} ${CSRT_ENC}`);
      });
      const e = capturar(() => resolveRespTec("SEFAZ_DIRECT", row({ idCsrt: "01", csrtEnc: CSRT_ENC }), true, decrypt, SP_HOM));
      expect(e.message).toBe(
        "Responsavel tecnico invalido: CSRT ilegivel no cadastro da empresa, cadastre o CSRT novamente",
      );
      expect((e as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(JSON.stringify({ m: e.message, s: e.stack })).not.toContain("SENTINELA");
    });

    it("CSRT decifrado vazio ou com espaço interno → erro de formato, sem repetir o valor", () => {
      for (const claro of ["", "   ", "CSRT SENTINELA"]) {
        const e = capturar(() =>
          resolveRespTec("SEFAZ_DIRECT", row({ idCsrt: "01", csrtEnc: CSRT_ENC }), true, () => claro, SP_HOM),
        );
        expect(e.message).toMatch(/CSRT salvo em formato invalido/);
        expect(e.message).not.toContain("SENTINELA");
      }
    });

    it("modo desconhecido no banco com a flag ligada → erro (fail-closed)", () => {
      const e = capturar(() => resolveRespTec("SEFAZ_DIRECT", row({ modo: "personalizado" }), true, decryptOk(), SP_HOM));
      expect(e.message).toMatch(/invalido: modo desconhecido/);
      expect(mapeiaPara400(e.message)).toBe(true);
    });
  });

  describe("Focus", () => {
    it("PADRAO, PROVEDOR e NENHUM → PROVEDOR (dados ignorados, nada decifrado)", () => {
      for (const modo of ["PADRAO", "PROVEDOR", "NENHUM"]) {
        const decrypt = decryptOk();
        expect(
          resolveRespTec("FOCUS_NFE", row({ modo, cnpj: "lixo", idCsrt: "01", csrtEnc: CSRT_ENC }), true, decrypt, { uf: "PR", ambiente: "PRODUCAO" }),
        ).toEqual({ origem: "PROVEDOR" });
        expect(decrypt).not.toHaveBeenCalled();
      }
    });

    it("PERSONALIZADO → EMPRESA com os 4 campos e NUNCA idCSRT/CSRT, mesmo com CSRT salvo", () => {
      const decrypt = decryptOk();
      const p = resolveRespTec("FOCUS_NFE", row({ idCsrt: "01", csrtEnc: CSRT_ENC }), true, decrypt, SP_HOM);
      expect(p).toEqual({
        origem: "EMPRESA",
        dados: {
          cnpj: CNPJ_RT,
          xContato: "Suporte Fornecedor",
          email: "suporte@fornecedor.com.br",
          fone: "4133334444",
        },
      });
      if (p.origem !== "EMPRESA") throw new Error("inesperado");
      expect(p.dados).not.toHaveProperty("idCSRT");
      expect(p.dados).not.toHaveProperty("csrt");
      expect(decrypt).not.toHaveBeenCalled();
      expect(JSON.stringify(p)).not.toContain("SENTINELA");
    });

    it("PERSONALIZADO incompleto → erro mapeado para 400", () => {
      const e = capturar(() => resolveRespTec("FOCUS_NFE", row({ xContato: "a" }), true, decryptOk(), SP_HOM));
      expect(e.message).toMatch(/incompleto ou invalido/);
      expect(e.message).toMatch(/^[\x20-\x7E]*$/);
    });
  });
});

describe("resolveRespTec — exigências por UF", () => {
  const PR_PROD = { uf: "PR", ambiente: "PRODUCAO" as const };
  const PR_HOM = { uf: "PR", ambiente: "HOMOLOGACAO" as const };

  it("SEFAZ PERSONALIZADO em PR PRODUCAO sem CSRT → erro 975 antes do envio", () => {
    const e = capturar(() => resolveRespTec("SEFAZ_DIRECT", row(), true, decryptOk(), PR_PROD));
    expect(e.message).toMatch(/975/);
    expect(e.message).toMatch(/^[\x20-\x7E]*$/);
    expect(mapeiaPara400(e.message)).toBe(true);
  });

  it("SEFAZ PERSONALIZADO em PR PRODUCAO com CSRT → EMPRESA com CSRT", () => {
    const p = resolveRespTec("SEFAZ_DIRECT", row({ idCsrt: "02", csrtEnc: CSRT_ENC }), true, decryptOk(), PR_PROD);
    expect(p).toMatchObject({ origem: "EMPRESA", dados: { idCSRT: "02", csrt: CSRT } });
  });

  it("SEFAZ PERSONALIZADO em PR HOMOLOGACAO sem CSRT → EMPRESA sem CSRT", () => {
    const p = resolveRespTec("SEFAZ_DIRECT", row(), true, decryptOk(), PR_HOM);
    expect(p.origem).toBe("EMPRESA");
    if (p.origem !== "EMPRESA") throw new Error("inesperado");
    expect(p.dados).not.toHaveProperty("csrt");
  });

  it("Focus PERSONALIZADO em PR PRODUCAO → erro (o Focus precisa continuar RT); em HOMOLOGACAO → EMPRESA", () => {
    const e = capturar(() => resolveRespTec("FOCUS_NFE", row(), true, decryptOk(), PR_PROD));
    expect(e.message).toMatch(/975/);
    expect(e.message).toMatch(/Padrao ou Provedor/);
    expect(mapeiaPara400(e.message)).toBe(true);
    expect(resolveRespTec("FOCUS_NFE", row(), true, decryptOk(), PR_HOM).origem).toBe("EMPRESA");
  });

  it("SEFAZ NENHUM nas UFs que exigem RT → erro 972 (produção e homologação)", () => {
    for (const uf of ["PR", "AM", "MS", "PE", "SC", "TO"]) {
      for (const ambiente of ["PRODUCAO", "HOMOLOGACAO"] as const) {
        const e = capturar(() => resolveRespTec("SEFAZ_DIRECT", row({ modo: "NENHUM" }), true, decryptOk(), { uf, ambiente }));
        expect(e.message, `${uf}/${ambiente}`).toMatch(/972/);
        expect(mapeiaPara400(e.message)).toBe(true);
      }
    }
  });

  it("UF nula não aplica regras por UF", () => {
    expect(resolveRespTec("SEFAZ_DIRECT", row({ modo: "NENHUM" }), true, decryptOk(), { uf: null, ambiente: "PRODUCAO" })).toEqual({ origem: "OMITIR" });
  });

  it("bloqueios de avisosRespTec coincidem com os erros do resolver (dados completos)", () => {
    const ufs = ["PR", "SC", "SP", null];
    const modos = ["PADRAO", "PROVEDOR", "PERSONALIZADO", "NENHUM"];
    let casos = 0;
    for (const provedor of ["SEFAZ_DIRECT", "FOCUS_NFE"]) {
      for (const uf of ufs) {
        for (const ambiente of ["HOMOLOGACAO", "PRODUCAO"] as const) {
          for (const modo of modos) {
            for (const comCsrt of [false, true]) {
              const linha = row({
                modo,
                idCsrt: comCsrt ? "01" : null,
                csrtEnc: comCsrt ? CSRT_ENC : null,
              });
              let lancou = false;
              try {
                resolveRespTec(provedor, linha, true, decryptOk(), { uf, ambiente });
              } catch {
                lancou = true;
              }
              const bloqueia = avisosRespTec({
                providerName: provedor,
                uf,
                ambiente,
                modo,
                idCsrt: linha.idCsrt,
                csrtConfigurado: linha.csrtEnc !== null,
              }).some((a) => a.nivel === "bloqueio");
              expect(bloqueia, `${provedor}/${uf}/${ambiente}/${modo}/csrt=${comCsrt}`).toBe(lancou);
              casos++;
            }
          }
        }
      }
    }
    expect(casos).toBe(2 * 4 * 2 * 4 * 2);
  });
});

describe("segredos nunca aparecem em erro", () => {
  it("nenhum erro do resolver contém token, CSRT ou cifrado", () => {
    const cenarios: Array<() => unknown> = [
      () => resolveNfeProviderConfig(config({ providerToken: "   " }), opcoes()),
      () => resolveNfeProviderConfig(config(), opcoes({ respTecRow: row({ cnpj: "1" }) })),
      () => resolveNfeProviderConfig(config({ uf: "PR", ambiente: "PRODUCAO" }), opcoes({ respTecRow: row() })),
      () => resolveNfeProviderConfig(config({ uf: "PR", ambiente: "PRODUCAO" }), opcoes({ respTecRow: row({ idCsrt: "01", csrtEnc: CSRT_ENC }) })),
      () => resolveNfeProviderConfig(config({ providerName: "SEFAZ_DIRECT" }), opcoes({ respTecRow: row({ modo: "PROVEDOR" }) })),
      () =>
        resolveNfeProviderConfig(
          config({ providerName: "SEFAZ_DIRECT" }),
          opcoes({
            respTecRow: row({ idCsrt: "01", csrtEnc: CSRT_ENC }),
            decryptSecret: () => {
              throw new Error(`${TOKEN} ${CSRT}`);
            },
          }),
        ),
      () =>
        resolveNfeProviderConfig(
          config({ providerName: "SEFAZ_DIRECT" }),
          opcoes({ respTecRow: row({ idCsrt: "01", csrtEnc: CSRT_ENC }), decryptSecret: () => `${CSRT} ${TOKEN}` }),
        ),
    ];
    for (const [i, c] of cenarios.entries()) {
      const e = capturar(c);
      const serializado = JSON.stringify({ m: e.message, s: e.stack, c: (e as Error & { cause?: unknown }).cause ?? null });
      expect(serializado, `cenario ${i}`).not.toContain("SENTINELA");
      expect(e.message, `cenario ${i}`).toMatch(/^[\x20-\x7E]*$/);
      expect(mapeiaPara400(e.message), `cenario ${i}`).toBe(true);
    }
  });
});

describe("respTecParaPayloadSefaz", () => {
  it("ENV_LEGADO/PROVEDOR → undefined (env atual); OMITIR → null; EMPRESA → cópia dos dados", () => {
    expect(respTecParaPayloadSefaz({ origem: "ENV_LEGADO" })).toBeUndefined();
    expect(respTecParaPayloadSefaz({ origem: "PROVEDOR" })).toBeUndefined();
    expect(respTecParaPayloadSefaz({ origem: "OMITIR" })).toBeNull();
    const dados = { cnpj: CNPJ_RT, xContato: "Suporte", email: "a@b.co", fone: "123456", idCSRT: "01", csrt: CSRT };
    const out = respTecParaPayloadSefaz({ origem: "EMPRESA", dados });
    expect(out).toEqual(dados);
    expect(out).not.toBe(dados);
  });
});

describe("resolvedParaLog", () => {
  it("Focus: remove o token (fica só tokenConfigurado) e não altera o original", () => {
    const r = resolveNfeProviderConfig(config({ ambiente: "PRODUCAO" }), opcoes({ numeracaoDexoFocus: true }));
    const log = resolvedParaLog(r);
    expect(log).toEqual({
      providerName: "FOCUS_NFE",
      ambiente: "PRODUCAO",
      modelo: "55",
      focus: { baseUrl: "https://api.focusnfe.com.br", path: "nfe", tokenConfigurado: true },
      sefaz: null,
      numeracao: "DEXO",
      respTec: { origem: "PROVEDOR" },
    });
    expect(JSON.stringify(log)).not.toContain("SENTINELA");
    expect(r.focus?.token).toBe(TOKEN);
  });

  it("SEFAZ EMPRESA: remove o CSRT (fica csrtConfigurado), mantém idCSRT e dados públicos", () => {
    const r = resolveNfeProviderConfig(
      config({ providerName: "SEFAZ_DIRECT", uf: "PR", ambiente: "PRODUCAO" }),
      opcoes({ respTecRow: row({ idCsrt: "01", csrtEnc: CSRT_ENC }) }),
    );
    const log = resolvedParaLog(r);
    expect(log.respTec).toEqual({
      origem: "EMPRESA",
      dados: {
        cnpj: CNPJ_RT,
        xContato: "Suporte Fornecedor",
        email: "suporte@fornecedor.com.br",
        fone: "4133334444",
        idCSRT: "01",
        csrtConfigurado: true,
      },
    });
    expect(JSON.stringify(log)).not.toContain("SENTINELA");
    expect(r.respTec).toMatchObject({ dados: { csrt: CSRT } });
  });

  it("EMPRESA sem CSRT, ENV_LEGADO e OMITIR", () => {
    const empresa = resolvedParaLog(
      resolveNfeProviderConfig(config({ providerName: "SEFAZ_DIRECT" }), opcoes({ respTecRow: row() })),
    );
    expect(empresa.respTec).toMatchObject({ origem: "EMPRESA", dados: { csrtConfigurado: false } });
    expect((empresa.respTec as { dados: object }).dados).not.toHaveProperty("idCSRT");

    expect(
      resolvedParaLog(resolveNfeProviderConfig(config({ providerName: "SEFAZ_DIRECT" }), opcoes())).respTec,
    ).toEqual({ origem: "ENV_LEGADO" });
    expect(
      resolvedParaLog(
        resolveNfeProviderConfig(config({ providerName: "SEFAZ_DIRECT" }), opcoes({ respTecRow: row({ modo: "NENHUM" }) })),
      ),
    ).toMatchObject({ focus: null, sefaz: { uf: "SP" }, respTec: { origem: "OMITIR" } });
  });

  it("log de Focus PERSONALIZADO não tem CSRT em lugar nenhum", () => {
    const r = resolveNfeProviderConfig(config(), opcoes({ respTecRow: row({ idCsrt: "01", csrtEnc: CSRT_ENC }) }));
    const texto = JSON.stringify(resolvedParaLog(r));
    expect(texto).not.toContain("SENTINELA");
    expect(texto).not.toContain("csrt\"");
  });
});
