import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  avisosRespTec,
  csrtFormatoValido,
  isRespTecModo,
  modosPermitidos,
  MSG_CSRT_NAO_ENVIADO_FOCUS,
  normalizarProvedorFiscal,
  paraMensagemSemAcento,
  REQUISITOS_RT_POR_UF,
  requisitosRespTecUf,
  RESP_TEC_MODOS,
  validarRespTec,
  type RespTecContexto,
  type RespTecEntrada,
} from "../../../app/fiscal/domain/resp-tec";
import { isValidCnpj } from "../../../app/lib/masks";

// CNPJs sintéticos (DV válido), nenhum é de cliente.
const CNPJ_OK = "11222333000181";
const CNPJ_OK_2 = "11444777000161";

const SEFAZ_SP_HOM: RespTecContexto = {
  providerName: "SEFAZ_DIRECT",
  uf: "SP",
  ambiente: "HOMOLOGACAO",
};
const FOCUS_SP_HOM: RespTecContexto = {
  providerName: "FOCUS_NFE",
  uf: "SP",
  ambiente: "HOMOLOGACAO",
};

function personalizado(extra: Partial<RespTecEntrada> = {}): RespTecEntrada {
  return {
    modo: "PERSONALIZADO",
    cnpj: CNPJ_OK,
    xContato: "Suporte Fornecedor",
    email: "suporte@fornecedor.com.br",
    fone: "4133334444",
    csrtConfigurado: false,
    ...extra,
  };
}

function erros(r: ReturnType<typeof validarRespTec>): Record<string, string> {
  if (r.ok) throw new Error("esperava erro, veio ok");
  return r.erros;
}

function ok(r: ReturnType<typeof validarRespTec>) {
  if (!r.ok) throw new Error(`esperava ok, veio ${JSON.stringify(r.erros)}`);
  return r.normalizado;
}

describe("resp-tec — modos", () => {
  it("modosPermitidos: SEFAZ direto não tem Provedor; Focus (e null/padrão) não tem Nenhum", () => {
    expect(modosPermitidos("SEFAZ_DIRECT")).toEqual([
      "PADRAO",
      "PERSONALIZADO",
      "NENHUM",
    ]);
    for (const p of ["FOCUS_NFE", null, "", "OUTRO"]) {
      expect(modosPermitidos(p)).toEqual(["PADRAO", "PROVEDOR", "PERSONALIZADO"]);
    }
  });

  it("normalizarProvedorFiscal segue o default do provider-factory", () => {
    expect(normalizarProvedorFiscal("SEFAZ_DIRECT")).toBe("SEFAZ_DIRECT");
    expect(normalizarProvedorFiscal("FOCUS_NFE")).toBe("FOCUS_NFE");
    expect(normalizarProvedorFiscal(null)).toBe("FOCUS_NFE");
    expect(normalizarProvedorFiscal(undefined)).toBe("FOCUS_NFE");
    expect(normalizarProvedorFiscal("sefaz_direct")).toBe("FOCUS_NFE");
  });

  it("isRespTecModo aceita só os 4 modos exatos", () => {
    for (const m of RESP_TEC_MODOS) expect(isRespTecModo(m)).toBe(true);
    for (const m of ["personalizado", "", " PADRAO", null, undefined, 1, "OUTRO"]) {
      expect(isRespTecModo(m)).toBe(false);
    }
  });

  it("modo desconhecido/ausente é erro em `modo`", () => {
    for (const modo of ["X", "", null, undefined, "personalizado"]) {
      const e = erros(
        validarRespTec({ modo, csrtConfigurado: false }, SEFAZ_SP_HOM),
      );
      expect(Object.keys(e)).toEqual(["modo"]);
    }
  });

  it("SEFAZ direto + Provedor é erro; Focus + Nenhum é erro", () => {
    const e1 = erros(
      validarRespTec({ modo: "PROVEDOR", csrtConfigurado: false }, SEFAZ_SP_HOM),
    );
    expect(e1.modo).toMatch(/Provedor não se aplica ao SEFAZ Direto/);
    const e2 = erros(
      validarRespTec({ modo: "NENHUM", csrtConfigurado: false }, FOCUS_SP_HOM),
    );
    expect(e2.modo).toMatch(/Nenhum/);
  });

  it("modo com espaços em volta é aparado", () => {
    const n = ok(
      validarRespTec({ modo: "  PADRAO ", csrtConfigurado: false }, SEFAZ_SP_HOM),
    );
    expect(n.modo).toBe("PADRAO");
  });
});

describe("resp-tec — tabela por UF", () => {
  it("PR exige RT e CSRT em produção (974/975)", () => {
    expect(REQUISITOS_RT_POR_UF.PR).toMatchObject({
      exigeRespTec: true,
      exigeCsrtEmProducao: true,
      validaFornecedorAutorizado: true,
    });
  });

  it("AM, MS, PE, SC, TO exigem RT; CSRT desconhecido = false", () => {
    for (const uf of ["AM", "MS", "PE", "SC", "TO"]) {
      expect(REQUISITOS_RT_POR_UF[uf]).toMatchObject({
        exigeRespTec: true,
        exigeCsrtEmProducao: false,
      });
    }
  });

  it("UF sem entrada, vazia, nula ou chave de protótipo → sem exigência", () => {
    for (const uf of ["SP", "", null, undefined, "__proto__", "constructor", "toString"]) {
      expect(requisitosRespTecUf(uf)).toMatchObject({
        exigeRespTec: false,
        exigeCsrtEmProducao: false,
        validaFornecedorAutorizado: false,
      });
    }
  });

  it("UF é normalizada (minúscula, espaços)", () => {
    expect(requisitosRespTecUf(" pr ").exigeCsrtEmProducao).toBe(true);
  });

  it("tabela é imutável em runtime", () => {
    expect(Object.isFrozen(REQUISITOS_RT_POR_UF)).toBe(true);
    expect(Object.isFrozen(REQUISITOS_RT_POR_UF.PR)).toBe(true);
  });
});

describe("resp-tec — modos sem dados", () => {
  it("PADRAO sem dados é válido nos dois provedores", () => {
    expect(
      validarRespTec({ modo: "PADRAO", csrtConfigurado: false }, SEFAZ_SP_HOM).ok,
    ).toBe(true);
    expect(
      validarRespTec({ modo: "PADRAO", csrtConfigurado: false }, FOCUS_SP_HOM).ok,
    ).toBe(true);
  });

  it("campos não são validados, mas seguem aparados para preservar o salvo; CSRT novo é ignorado", () => {
    const n = ok(
      validarRespTec(
        {
          modo: "PROVEDOR",
          cnpj: "11.222.333/0001-99", // DV errado: não validado neste modo
          xContato: "  x ",
          email: " nao-e-email ",
          fone: "(41) 3333-4444",
          idCsrt: " 1 ",
          csrtNovo: "SEGREDO",
          csrtConfigurado: true,
        },
        FOCUS_SP_HOM,
      ),
    );
    expect(n).toEqual({
      modo: "PROVEDOR",
      cnpj: "11222333000199",
      xContato: "x",
      email: "nao-e-email",
      fone: "4133334444",
      idCsrt: "1",
      csrtNovo: null,
      removerCsrt: false,
    });
  });

  it("NENHUM no SEFAZ direto fora das UFs que exigem RT é válido; removerCsrt zera idCsrt", () => {
    const n = ok(
      validarRespTec(
        { modo: "NENHUM", idCsrt: "01", csrtConfigurado: true, removerCsrt: true },
        SEFAZ_SP_HOM,
      ),
    );
    expect(n.idCsrt).toBeNull();
    expect(n.removerCsrt).toBe(true);
  });
});

describe("resp-tec — PERSONALIZADO: dados", () => {
  it("dados completos válidos → normalizado só com dígitos em CNPJ e fone", () => {
    const n = ok(
      validarRespTec(
        personalizado({
          cnpj: "11.222.333/0001-81",
          xContato: "  Suporte Fornecedor  ",
          email: " suporte@fornecedor.com.br ",
          fone: "(41) 3333-4444",
        }),
        SEFAZ_SP_HOM,
      ),
    );
    expect(n).toEqual({
      modo: "PERSONALIZADO",
      cnpj: CNPJ_OK,
      xContato: "Suporte Fornecedor",
      email: "suporte@fornecedor.com.br",
      fone: "4133334444",
      idCsrt: null,
      csrtNovo: null,
      removerCsrt: false,
    });
  });

  it("todos os campos obrigatórios ausentes → um erro por campo", () => {
    const e = erros(
      validarRespTec({ modo: "PERSONALIZADO", csrtConfigurado: false }, SEFAZ_SP_HOM),
    );
    expect(Object.keys(e).sort()).toEqual(["cnpj", "email", "fone", "xContato"]);
  });

  describe("CNPJ", () => {
    it("DV errado é recusado", () => {
      const e = erros(
        validarRespTec(personalizado({ cnpj: "11222333000182" }), SEFAZ_SP_HOM),
      );
      expect(e.cnpj).toMatch(/verificadores/);
    });

    it("13 e 15 dígitos, letras e todos iguais são recusados", () => {
      for (const cnpj of [
        "1122233300018",
        "112223330001811",
        "11222333000181X",
        "1A222333000181",
        "00000000000000",
        "11111111111111",
      ]) {
        expect(
          validarRespTec(personalizado({ cnpj }), SEFAZ_SP_HOM).ok,
          cnpj,
        ).toBe(false);
      }
    });

    it("concorda com isValidCnpj em amostra de válidos e inválidos", () => {
      const amostra = [
        CNPJ_OK,
        CNPJ_OK_2,
        "11222333000180",
        "11444777000162",
        "22222222222222",
        "12345678000195",
        "12345678000196",
      ];
      for (const cnpj of amostra) {
        expect(
          validarRespTec(personalizado({ cnpj }), SEFAZ_SP_HOM).ok,
          cnpj,
        ).toBe(isValidCnpj(cnpj));
      }
    });
  });

  describe("xContato (2–60, aparado)", () => {
    const caso = (xContato: string) =>
      validarRespTec(personalizado({ xContato }), SEFAZ_SP_HOM);

    it("1 caractere recusa; 2 aceita; 60 aceita; 61 recusa", () => {
      expect(erros(caso("a")).xContato).toMatch(/2 a 60/);
      expect(caso("ab").ok).toBe(true);
      expect(caso("a".repeat(60)).ok).toBe(true);
      expect(erros(caso("a".repeat(61))).xContato).toMatch(/2 a 60/);
    });

    it("conta depois de aparar", () => {
      expect(caso("   a   ").ok).toBe(false);
      expect(ok(caso(`  ${"a".repeat(60)}  `)).xContato).toBe("a".repeat(60));
    });

    it("aceita acentos Latin-1; recusa caracteres fora do leiaute", () => {
      expect(caso("João Conceição").ok).toBe(true);
      expect(caso("Suporte — Fornecedor").ok).toBe(false);
      expect(caso("Suporte 😀").ok).toBe(false);
    });
  });

  describe("e-mail (6–60)", () => {
    const caso = (email: string) =>
      validarRespTec(personalizado({ email }), SEFAZ_SP_HOM);

    it("5 recusa; 6 aceita; 60 aceita; 61 recusa", () => {
      expect(caso("a@b.c").ok).toBe(false); // 5 e TLD de 1
      expect(caso("a@b.co").ok).toBe(true); // 6
      const local60 = `${"a".repeat(60 - "@b.co".length)}@b.co`;
      expect(local60).toHaveLength(60);
      expect(caso(local60).ok).toBe(true);
      expect(caso(`a${local60}`).ok).toBe(false);
    });

    it("formato inválido é recusado", () => {
      for (const email of [
        "semarroba.com.br",
        "a@b",
        "a b@c.com",
        "a@@b.com",
        "@fornecedor.com",
        "suporte@fornecedor.c",
      ]) {
        expect(caso(email).ok, email).toBe(false);
      }
    });
  });

  describe("fone (6–14 dígitos)", () => {
    const caso = (fone: string) =>
      validarRespTec(personalizado({ fone }), SEFAZ_SP_HOM);

    it("5 recusa; 6 aceita; 14 aceita; 15 recusa", () => {
      expect(erros(caso("12345")).fone).toMatch(/6 a 14/);
      expect(ok(caso("123456")).fone).toBe("123456");
      expect(ok(caso("12345678901234")).fone).toBe("12345678901234");
      expect(erros(caso("123456789012345")).fone).toMatch(/6 a 14/);
    });

    it("máscara comum é aceita e vira dígitos; letras são recusadas", () => {
      expect(ok(caso("+55 (41) 3333-4444")).fone).toBe("554133334444");
      expect(caso("41 3333-44AB").ok).toBe(false);
    });
  });
});

describe("resp-tec — PERSONALIZADO: idCSRT e CSRT (SEFAZ direto)", () => {
  const sefaz = (extra: Partial<RespTecEntrada>) =>
    validarRespTec(personalizado(extra), SEFAZ_SP_HOM);

  it('idCsrt "1" e "001" recusam; "01" aceita', () => {
    expect(erros(sefaz({ idCsrt: "1", csrtNovo: "ABC" })).idCsrt).toMatch(/2 dígitos/);
    expect(erros(sefaz({ idCsrt: "001", csrtNovo: "ABC" })).idCsrt).toMatch(/2 dígitos/);
    expect(erros(sefaz({ idCsrt: "ab", csrtNovo: "ABC" })).idCsrt).toBeDefined();
    const n = ok(sefaz({ idCsrt: "01", csrtNovo: "ABC" }));
    expect(n.idCsrt).toBe("01");
    expect(n.csrtNovo).toBe("ABC");
  });

  it("CSRT: 1 e 128 aceitam; 129 recusa; espaço interno recusa; aparado nas bordas", () => {
    expect(ok(sefaz({ idCsrt: "01", csrtNovo: "A" })).csrtNovo).toBe("A");
    expect(ok(sefaz({ idCsrt: "01", csrtNovo: "A".repeat(128) })).csrtNovo).toHaveLength(128);
    expect(erros(sefaz({ idCsrt: "01", csrtNovo: "A".repeat(129) })).csrt).toMatch(/128/);
    expect(erros(sefaz({ idCsrt: "01", csrtNovo: "AB CD" })).csrt).toMatch(/espaços/);
    expect(ok(sefaz({ idCsrt: "01", csrtNovo: "  ABCD  " })).csrtNovo).toBe("ABCD");
  });

  it("csrtFormatoValido", () => {
    expect(csrtFormatoValido("")).toBe(false);
    expect(csrtFormatoValido("A")).toBe(true);
    expect(csrtFormatoValido("A".repeat(128))).toBe(true);
    expect(csrtFormatoValido("A".repeat(129))).toBe(false);
    expect(csrtFormatoValido("A\tB")).toBe(false);
  });

  it("par: idCsrt sem CSRT recusa; CSRT novo sem idCsrt recusa; CSRT salvo sem idCsrt recusa", () => {
    expect(erros(sefaz({ idCsrt: "01" })).csrt).toMatch(/junto/);
    expect(erros(sefaz({ csrtNovo: "ABC" })).idCsrt).toMatch(/junto/);
    expect(erros(sefaz({ csrtConfigurado: true })).idCsrt).toMatch(/junto/);
  });

  it("par: idCsrt + CSRT salvo (sem CSRT novo) é válido e mantém o salvo", () => {
    const n = ok(sefaz({ idCsrt: "01", csrtConfigurado: true }));
    expect(n.idCsrt).toBe("01");
    expect(n.csrtNovo).toBeNull();
  });

  it("removerCsrt: ignora idCsrt enviado e zera; junto com CSRT novo é erro", () => {
    const n = ok(sefaz({ idCsrt: "01", csrtConfigurado: true, removerCsrt: true }));
    expect(n.idCsrt).toBeNull();
    expect(n.csrtNovo).toBeNull();
    expect(n.removerCsrt).toBe(true);
    expect(
      erros(sefaz({ idCsrt: "01", csrtNovo: "NOVO", csrtConfigurado: true, removerCsrt: true })).csrt,
    ).toMatch(/não os dois/);
  });

  it("nenhuma mensagem de erro repete o CSRT digitado", () => {
    const segredo = "SEGREDO-CSRT-SENTINELA-" + "X".repeat(120);
    const e = erros(sefaz({ idCsrt: "1", csrtNovo: segredo }));
    expect(JSON.stringify(e)).not.toContain("SENTINELA");
  });
});

describe("resp-tec — PERSONALIZADO no Focus", () => {
  it("dados sem CSRT são válidos e nunca carregam idCsrt/CSRT", () => {
    const n = ok(validarRespTec(personalizado(), FOCUS_SP_HOM));
    expect(n.idCsrt).toBeNull();
    expect(n.csrtNovo).toBeNull();
  });

  it("CSRT novo ou idCsrt → erro com a mensagem do hash do cNF", () => {
    const e1 = erros(validarRespTec(personalizado({ csrtNovo: "ABC" }), FOCUS_SP_HOM));
    expect(e1.csrt).toBe(`${MSG_CSRT_NAO_ENVIADO_FOCUS}.`);
    expect(e1.csrt).toContain(
      "O CSRT não é enviado via Focus: o hash depende do cNF gerado pelo Focus",
    );
    const e2 = erros(validarRespTec(personalizado({ idCsrt: "01" }), FOCUS_SP_HOM));
    expect(e2.csrt).toBe(`${MSG_CSRT_NAO_ENVIADO_FOCUS}.`);
  });

  it("CSRT salvo de antes (empresa era SEFAZ direto) é inerte: não bloqueia", () => {
    const n = ok(validarRespTec(personalizado({ csrtConfigurado: true }), FOCUS_SP_HOM));
    expect(n.idCsrt).toBeNull();
    expect(n.csrtNovo).toBeNull();
  });
});

describe("resp-tec — exigências por UF", () => {
  const ctx = (
    providerName: string,
    uf: string | null,
    ambiente: "HOMOLOGACAO" | "PRODUCAO",
  ): RespTecContexto => ({ providerName, uf, ambiente });

  describe("PR, SEFAZ direto, PERSONALIZADO (975)", () => {
    it("PRODUCAO sem CSRT → erro com 975", () => {
      const e = erros(validarRespTec(personalizado(), ctx("SEFAZ_DIRECT", "PR", "PRODUCAO")));
      expect(e.csrt).toMatch(/975/);
      expect(e.csrt).toMatch(/incompleto/);
    });

    it("HOMOLOGACAO sem CSRT → válido", () => {
      expect(
        validarRespTec(personalizado(), ctx("SEFAZ_DIRECT", "PR", "HOMOLOGACAO")).ok,
      ).toBe(true);
    });

    it("PRODUCAO com idCsrt + CSRT novo ou salvo → válido", () => {
      const c = ctx("SEFAZ_DIRECT", "PR", "PRODUCAO");
      expect(validarRespTec(personalizado({ idCsrt: "01", csrtNovo: "ABC" }), c).ok).toBe(true);
      expect(validarRespTec(personalizado({ idCsrt: "01", csrtConfigurado: true }), c).ok).toBe(true);
    });

    it("PRODUCAO só com metade do par → erro", () => {
      const c = ctx("SEFAZ_DIRECT", "PR", "PRODUCAO");
      expect(validarRespTec(personalizado({ idCsrt: "01" }), c).ok).toBe(false);
      expect(validarRespTec(personalizado({ csrtConfigurado: true }), c).ok).toBe(false);
    });

    it("PRODUCAO removendo o CSRT → erro 975", () => {
      const e = erros(
        validarRespTec(
          personalizado({ idCsrt: "01", csrtConfigurado: true, removerCsrt: true }),
          ctx("SEFAZ_DIRECT", "PR", "PRODUCAO"),
        ),
      );
      expect(e.csrt).toMatch(/975/);
    });

    it("UF em minúscula com espaços também aplica a regra", () => {
      expect(
        validarRespTec(personalizado(), ctx("SEFAZ_DIRECT", " pr ", "PRODUCAO")).ok,
      ).toBe(false);
    });

    it("UF que exige RT mas sem CSRT conhecido (SC) → PRODUCAO sem CSRT é válido", () => {
      expect(
        validarRespTec(personalizado(), ctx("SEFAZ_DIRECT", "SC", "PRODUCAO")).ok,
      ).toBe(true);
    });
  });

  describe("PR, Focus, PERSONALIZADO", () => {
    it("PRODUCAO → erro em `modo`: o Focus precisa continuar RT", () => {
      const e = erros(validarRespTec(personalizado(), ctx("FOCUS_NFE", "PR", "PRODUCAO")));
      expect(e.modo).toMatch(/975/);
      expect(e.modo).toMatch(/Padrão ou Provedor/);
    });

    it("HOMOLOGACAO → válido; SP PRODUCAO → válido", () => {
      expect(validarRespTec(personalizado(), ctx("FOCUS_NFE", "PR", "HOMOLOGACAO")).ok).toBe(true);
      expect(validarRespTec(personalizado(), ctx("FOCUS_NFE", "SP", "PRODUCAO")).ok).toBe(true);
    });

    it("Focus PADRAO e PROVEDOR em PR PRODUCAO → válidos", () => {
      const c = ctx("FOCUS_NFE", "PR", "PRODUCAO");
      expect(validarRespTec({ modo: "PADRAO", csrtConfigurado: false }, c).ok).toBe(true);
      expect(validarRespTec({ modo: "PROVEDOR", csrtConfigurado: false }, c).ok).toBe(true);
    });
  });

  describe("NENHUM (972)", () => {
    it("UFs que exigem RT recusam NENHUM em produção e homologação", () => {
      for (const uf of ["PR", "AM", "MS", "PE", "SC", "TO"]) {
        for (const amb of ["PRODUCAO", "HOMOLOGACAO"] as const) {
          const e = erros(
            validarRespTec({ modo: "NENHUM", csrtConfigurado: false }, ctx("SEFAZ_DIRECT", uf, amb)),
          );
          expect(e.modo, `${uf}/${amb}`).toMatch(/972/);
        }
      }
    });

    it("SP ou UF nula aceitam NENHUM", () => {
      expect(
        validarRespTec({ modo: "NENHUM", csrtConfigurado: false }, ctx("SEFAZ_DIRECT", "SP", "PRODUCAO")).ok,
      ).toBe(true);
      expect(
        validarRespTec({ modo: "NENHUM", csrtConfigurado: false }, ctx("SEFAZ_DIRECT", null, "PRODUCAO")).ok,
      ).toBe(true);
    });
  });

  it("SEFAZ PADRAO em PR PRODUCAO NÃO é bloqueado (idêntico ao atual; só aviso)", () => {
    expect(
      validarRespTec({ modo: "PADRAO", csrtConfigurado: false }, ctx("SEFAZ_DIRECT", "PR", "PRODUCAO")).ok,
    ).toBe(true);
  });
});

describe("resp-tec — avisosRespTec", () => {
  const codigos = (a: ReturnType<typeof avisosRespTec>) => a.map((x) => x.codigo);

  it("SEFAZ PADRAO em PR PRODUCAO com padrão sem CSRT → alerta 975", () => {
    for (const padraoSistema of [
      { configurado: true, temCsrt: false },
      null,
      undefined,
    ]) {
      const a = avisosRespTec({
        providerName: "SEFAZ_DIRECT",
        uf: "PR",
        ambiente: "PRODUCAO",
        modo: "PADRAO",
        padraoSistema,
      });
      const aviso = a.find((x) => x.codigo === "PADRAO_SEM_CSRT_PRODUCAO");
      expect(aviso?.nivel).toBe("alerta");
      expect(aviso?.mensagem).toMatch(/975/);
    }
  });

  it("SEFAZ PADRAO em PR: padrão com CSRT ou HOMOLOGACAO → sem alerta 975", () => {
    expect(
      codigos(
        avisosRespTec({
          providerName: "SEFAZ_DIRECT",
          uf: "PR",
          ambiente: "PRODUCAO",
          modo: null,
          padraoSistema: { configurado: true, temCsrt: true },
        }),
      ),
    ).not.toContain("PADRAO_SEM_CSRT_PRODUCAO");
    expect(
      codigos(
        avisosRespTec({
          providerName: "SEFAZ_DIRECT",
          uf: "PR",
          ambiente: "HOMOLOGACAO",
          modo: "PADRAO",
        }),
      ),
    ).not.toContain("PADRAO_SEM_CSRT_PRODUCAO");
  });

  it("SEFAZ PADRAO em UF que exige RT com padrão vazio → alerta 972 (e não duplica com 975)", () => {
    const a = avisosRespTec({
      providerName: "SEFAZ_DIRECT",
      uf: "PR",
      ambiente: "PRODUCAO",
      modo: "PADRAO",
      padraoSistema: { configurado: false, temCsrt: false },
    });
    expect(codigos(a)).toContain("PADRAO_SEM_RESP_TEC");
    expect(codigos(a)).not.toContain("PADRAO_SEM_CSRT_PRODUCAO");
  });

  it("SEFAZ PADRAO em SP → nenhum aviso", () => {
    expect(
      avisosRespTec({ providerName: "SEFAZ_DIRECT", uf: "SP", ambiente: "PRODUCAO", modo: "PADRAO" }),
    ).toEqual([]);
  });

  it("bloqueios espelham as regras: NENHUM em PR, PERSONALIZADO sem CSRT em PR PRODUCAO, Focus PERSONALIZADO em PR PRODUCAO, Provedor no SEFAZ", () => {
    const bloqueio = (c: Parameters<typeof avisosRespTec>[0]) =>
      avisosRespTec(c).filter((x) => x.nivel === "bloqueio").map((x) => x.codigo);

    expect(bloqueio({ providerName: "SEFAZ_DIRECT", uf: "PR", ambiente: "HOMOLOGACAO", modo: "NENHUM" })).toEqual(["NENHUM_UF_EXIGE"]);
    expect(bloqueio({ providerName: "SEFAZ_DIRECT", uf: "PR", ambiente: "PRODUCAO", modo: "PERSONALIZADO" })).toEqual(["PERSONALIZADO_SEM_CSRT_PRODUCAO"]);
    expect(bloqueio({ providerName: "SEFAZ_DIRECT", uf: "PR", ambiente: "PRODUCAO", modo: "PERSONALIZADO", idCsrt: "01", csrtConfigurado: true })).toEqual([]);
    expect(bloqueio({ providerName: "FOCUS_NFE", uf: "PR", ambiente: "PRODUCAO", modo: "PERSONALIZADO" })).toEqual(["FOCUS_PERSONALIZADO_UF_EXIGE_CSRT"]);
    expect(bloqueio({ providerName: "SEFAZ_DIRECT", uf: "SP", ambiente: "PRODUCAO", modo: "PROVEDOR" })).toEqual(["PROVEDOR_NO_SEFAZ"]);
    expect(bloqueio({ providerName: "SEFAZ_DIRECT", uf: "SP", ambiente: "PRODUCAO", modo: "LIXO" })).toEqual(["MODO_DESCONHECIDO"]);
  });

  it("homologação antecipa o bloqueio de produção como alerta", () => {
    expect(
      codigos(avisosRespTec({ providerName: "SEFAZ_DIRECT", uf: "PR", ambiente: "HOMOLOGACAO", modo: "PERSONALIZADO" })),
    ).toContain("PERSONALIZADO_SEM_CSRT_HOMOLOGACAO");
    expect(
      codigos(avisosRespTec({ providerName: "FOCUS_NFE", uf: "PR", ambiente: "HOMOLOGACAO", modo: "PERSONALIZADO" })),
    ).toContain("FOCUS_PERSONALIZADO_UF_EXIGE_CSRT_HOMOLOGACAO");
  });

  it("Focus: CSRT salvo vira informação; PR informa a conferência do fornecedor (974) citando o Focus", () => {
    const a1 = avisosRespTec({ providerName: "FOCUS_NFE", uf: "SP", ambiente: "PRODUCAO", modo: "PERSONALIZADO", csrtConfigurado: true });
    expect(a1.find((x) => x.codigo === "CSRT_IGNORADO_NO_FOCUS")?.nivel).toBe("info");

    const a2 = avisosRespTec({ providerName: "FOCUS_NFE", uf: "PR", ambiente: "HOMOLOGACAO", modo: "PROVEDOR" });
    const f = a2.find((x) => x.codigo === "FORNECEDOR_AUTORIZADO_UF");
    expect(f?.nivel).toBe("info");
    expect(f?.mensagem).toMatch(/974/);
    expect(f?.mensagem).toMatch(/Focus/);
  });
});

describe("resp-tec — mensagem da emissão e fronteira de client", () => {
  it("paraMensagemSemAcento devolve ASCII imprimível que casa com o mapeamento 400 da rota /issue", () => {
    const m = paraMensagemSemAcento(
      "Responsável técnico incompleto ou inválido: CNPJ não confere — ação.",
    );
    expect(m).toMatch(/^[\x20-\x7E]*$/);
    expect(m).toContain("Responsavel tecnico incompleto ou invalido");
    expect(m).toContain("acao");
  });

  it("resp-tec.ts só importa masks (sem imports) e tipos — seguro no client", () => {
    const raiz = path.resolve(__dirname, "../../..");
    const fonte = readFileSync(path.join(raiz, "app/fiscal/domain/resp-tec.ts"), "utf8");
    const imports = fonte.match(/^import[^;]+;/gm) ?? [];
    expect(imports).toEqual([
      'import { isValidCnpj } from "../../lib/masks";',
      'import type { AmbienteFiscal, ProvedorFiscal } from "../numeracao/tipos";',
    ]);
    const masks = readFileSync(path.join(raiz, "app/lib/masks.ts"), "utf8");
    expect(masks).not.toMatch(/^\s*import\s/m);
    expect(masks).not.toMatch(/require\(/);
  });
});
