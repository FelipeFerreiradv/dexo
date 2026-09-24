import { describe, it, expect } from "vitest";
import {
  ORDEM_SEQUENCIA,
  dadosDoEmitente,
  resolverEscopoSequencia,
  soDigitos,
  whereSequencia,
  type ConfigFiscalDoTenant,
} from "../scripts/lib/nfe-sequence-scope";

/**
 * Contador de NF-e avançando no CNPJ ERRADO (23/09/2026).
 *
 * `scripts/migracao-vaapt-nfes.ts`, `scripts/migracao-ibr.ts` e
 * `scripts/delete-migrated-nfes.ts` procuravam a linha de `NfeSequence` só por
 * (userId, ambiente, serie, modelo). O @@unique por `userId` virou índice
 * NORMAL quando o multi-CNPJ entrou — a unicidade real é
 * (companyFiscalConfigId, ambiente, serie, modelo) —, então num tenant com
 * duas `CompanyFiscalConfig` o `findFirst` devolve uma linha ARBITRÁRIA: o
 * script avançava (e, no delete, APAGAVA) o contador da outra empresa, em
 * silêncio. O tenant VN Motors é exatamente esse caso: duas configs, uma delas
 * o CNPJ padrão "Veiga Auto Peças".
 *
 * O que estes testes travam é a decisão, não o SQL: quando dá para saber o
 * emitente, o escopo é dele; quando NÃO dá, o resolvedor LANÇA — escolher
 * errado é irreversível do lado da SEFAZ, abortar custa uma flag.
 */

const PADRAO: ConfigFiscalDoTenant = {
  id: "cfg-veiga",
  cnpj: "65.416.054/0001-88",
  isDefault: true,
};
const SEGUNDA: ConfigFiscalDoTenant = {
  id: "cfg-vnmotors",
  cnpj: "11222333000144",
  isDefault: false,
};

const CHAVE = { userId: "u1", ambiente: "PRODUCAO", serie: 1, modelo: "55" };

describe("nfe-sequence-scope — de qual CNPJ é o contador", () => {
  it("tenant com UMA config: escopa nela e adota a linha legada (configId NULL)", () => {
    const escopo = resolverEscopoSequencia([PADRAO]);
    expect(escopo).toMatchObject({
      tipo: "CONFIG",
      companyFiscalConfigId: "cfg-veiga",
      adotaLegadoNulo: true,
    });
    expect(whereSequencia(CHAVE, escopo)).toEqual({
      ...CHAVE,
      OR: [{ companyFiscalConfigId: "cfg-veiga" }, { companyFiscalConfigId: null }],
    });
  });

  it("config única NÃO-padrão também adota a legada — o NULL só pode ser dela", () => {
    const escopo = resolverEscopoSequencia([{ ...SEGUNDA, isDefault: false }]);
    expect(escopo.adotaLegadoNulo).toBe(true);
  });

  it("tenant SEM config: recorte legado, where byte-idêntico ao de antes", () => {
    const escopo = resolverEscopoSequencia([]);
    expect(escopo.tipo).toBe("SEM_CONFIG");
    expect(whereSequencia(CHAVE, escopo)).toEqual(CHAVE);
    expect(dadosDoEmitente(escopo)).toEqual({});
  });

  it("multi-CNPJ: o CNPJ da chave de acesso escolhe a config, comparando só dígitos", () => {
    const escopo = resolverEscopoSequencia([PADRAO, SEGUNDA], {
      cnpj: "65416054000188", // como vem da chave: 14 dígitos crus
    });
    expect(escopo).toMatchObject({
      tipo: "CONFIG",
      companyFiscalConfigId: "cfg-veiga",
      adotaLegadoNulo: true, // é o padrão do tenant
    });
  });

  it("multi-CNPJ: emitente NÃO-padrão nunca adota a linha legada NULL", () => {
    const escopo = resolverEscopoSequencia([PADRAO, SEGUNDA], {
      cnpj: "11222333000144",
    });
    expect(escopo).toMatchObject({
      companyFiscalConfigId: "cfg-vnmotors",
      adotaLegadoNulo: false,
    });
    expect(whereSequencia(CHAVE, escopo)).toEqual({
      ...CHAVE,
      OR: [{ companyFiscalConfigId: "cfg-vnmotors" }],
    });
  });

  it("multi-CNPJ SEM dica: LANÇA em vez de escolher (é o defeito que se corrige)", () => {
    expect(() => resolverEscopoSequencia([PADRAO, SEGUNDA])).toThrow(
      /2 CNPJs|--config-id/,
    );
  });

  it("multi-CNPJ com CNPJ que não bate com nenhuma config: LANÇA", () => {
    expect(() =>
      resolverEscopoSequencia([PADRAO, SEGUNDA], { cnpj: "99999999000199" }),
    ).toThrow(/não corresponde a nenhuma/);
  });

  it("--config-id de outro tenant: LANÇA (digitação errada não vira alvo de escrita)", () => {
    expect(() =>
      resolverEscopoSequencia([PADRAO, SEGUNDA], { configId: "cfg-de-outro" }),
    ).toThrow(/não é uma CompanyFiscalConfig deste tenant/);
  });

  it("--config-id vence a dica de CNPJ e carimba o create com o emitente", () => {
    const escopo = resolverEscopoSequencia([PADRAO, SEGUNDA], {
      configId: "cfg-vnmotors",
      cnpj: "65416054000188",
    });
    expect(escopo.companyFiscalConfigId).toBe("cfg-vnmotors");
    expect(dadosDoEmitente(escopo)).toEqual({
      companyFiscalConfigId: "cfg-vnmotors",
    });
  });

  it("ordem ASC (NULLS LAST) — prefere a linha já adotada à legada, igual ao serviço", () => {
    expect(ORDEM_SEQUENCIA).toEqual({ companyFiscalConfigId: "asc" });
  });

  it("soDigitos tolera CNPJ formatado, com espaço ou nulo", () => {
    expect(soDigitos("65.416.054/0001-88")).toBe("65416054000188");
    expect(soDigitos(" 112223330001-44 ")).toBe("11222333000144");
    expect(soDigitos(null)).toBe("");
  });
});
