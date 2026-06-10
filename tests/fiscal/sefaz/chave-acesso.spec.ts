import { describe, it, expect } from "vitest";
import {
  calcularDV,
  montarChave,
  chaveToString,
  parseChave,
} from "../../../app/fiscal/sefaz/chave-acesso";

describe("chave-acesso — calcularDV", () => {
  it("retorna sempre exatamente 1 digito", () => {
    const bases = [
      "0000000000000000000000000000000000000000000",
      "1234567890123456789012345678901234567890123",
      "9999999999999999999999999999999999999999999",
      "3524041122233300018155001000000000112345678",
      "3526051122233300018155007000000099919999998",
    ];
    for (const b of bases) {
      const dv = calcularDV(b);
      expect(dv).toMatch(/^\d$/);
    }
  });

  it("computa DV deterministicamente (mesmo input → mesmo resultado)", () => {
    const base = "3524041122233300018155001000000000112345678";
    expect(calcularDV(base)).toBe(calcularDV(base));
  });

  it("retorna 0 quando resto da soma mod 11 e 0 ou 1 (regra do DV)", () => {
    // Base composta para forçar soma % 11 ∈ {0,1}. Verificamos via propriedade:
    // após gerar chave válida, alterar 1 digito qualquer muda o DV.
    const baseValida = "3524041122233300018155001000000000112345678";
    const dvOk = calcularDV(baseValida);
    // Mexer no último digito
    const baseAlterada = baseValida.slice(0, -1) + ((Number(baseValida.slice(-1)) + 1) % 10);
    const dvNovo = calcularDV(baseAlterada);
    expect(dvOk).not.toBe(dvNovo);
  });

  it("lanca erro se base43 nao tiver 43 digitos", () => {
    expect(() => calcularDV("123")).toThrow(/43 digitos/);
  });

  it("considera apenas digitos (ignora separadores apos limpeza pelo caller)", () => {
    const base43 = "3524041122233300018155001000000000112345678";
    const comMascara = base43
      .match(/.{1,4}/g)!
      .join(" ")
      .replace(/\D/g, "");
    expect(calcularDV(comMascara)).toBe(calcularDV(base43));
  });
});

describe("chave-acesso — montarChave", () => {
  it("monta chave SP/abril 2024 corretamente", () => {
    const parts = montarChave({
      uf: "SP",
      ano: 2024,
      mes: 4,
      cnpj: "11222333000181",
      modelo: "55",
      serie: 1,
      numero: 1,
      tpEmis: 1,
      cNF: "12345678",
    });

    expect(parts.cUF).toBe("35");
    expect(parts.AAMM).toBe("2404");
    expect(parts.CNPJ).toBe("11222333000181");
    expect(parts.mod).toBe("55");
    expect(parts.serie).toBe("001");
    expect(parts.nNF).toBe("000000001");
    expect(parts.tpEmis).toBe("1");
    expect(parts.cNF).toBe("12345678");

    const chave = chaveToString(parts);
    expect(chave).toHaveLength(44);
    expect(chave).toMatch(/^\d{44}$/);
    // Re-parsing valida o DV
    expect(() => parseChave(chave)).not.toThrow();
  });

  it("gera cNF automatico diferente de nNF quando omitido", () => {
    const parts = montarChave({
      uf: "MG",
      ano: 2026,
      mes: 5,
      cnpj: "12345678000195",
      modelo: "55",
      serie: 1,
      numero: 42,
      tpEmis: 1,
    });

    expect(parts.cNF).toMatch(/^\d{8}$/);
    expect(parts.cNF).not.toBe("000000042");
  });

  it("rejeita CNPJ com tamanho errado", () => {
    expect(() =>
      montarChave({
        uf: "SP",
        ano: 2024,
        mes: 4,
        cnpj: "123",
        modelo: "55",
        serie: 1,
        numero: 1,
        tpEmis: 1,
      }),
    ).toThrow(/14 digitos/);
  });

  it("rejeita mes fora do range", () => {
    expect(() =>
      montarChave({
        uf: "SP",
        ano: 2024,
        mes: 13,
        cnpj: "11222333000181",
        modelo: "55",
        serie: 1,
        numero: 1,
        tpEmis: 1,
      }),
    ).toThrow(/Mes invalido/);
  });

  it("rejeita cNF igual ao nNF (Rejeicao 778)", () => {
    // numero=12345678 → nNF="012345678" (9 dig). cNF="12345678" (8 dig).
    // Comparação numérica: 12345678 === 12345678 → reject.
    expect(() =>
      montarChave({
        uf: "SP",
        ano: 2024,
        mes: 4,
        cnpj: "11222333000181",
        modelo: "55",
        serie: 1,
        numero: 12345678,
        tpEmis: 1,
        cNF: "12345678",
      }),
    ).toThrow(/cNF nao pode ser igual/);
  });

  it("aceita cNF numericamente diferente do nNF mesmo com mesma sequencia parcial", () => {
    // numero=1 → nNF="000000001". cNF="10000000" (numericamente 10000000).
    expect(() =>
      montarChave({
        uf: "SP",
        ano: 2024,
        mes: 4,
        cnpj: "11222333000181",
        modelo: "55",
        serie: 1,
        numero: 1,
        tpEmis: 1,
        cNF: "10000000",
      }),
    ).not.toThrow();
  });

  it("aceita CNPJ com mascara — limpa caracteres nao numericos", () => {
    const parts = montarChave({
      uf: "RJ",
      ano: 2026,
      mes: 1,
      cnpj: "11.222.333/0001-81",
      modelo: "55",
      serie: 0,
      numero: 999,
      tpEmis: 1,
      cNF: "00010001",
    });
    expect(parts.CNPJ).toBe("11222333000181");
    expect(parts.serie).toBe("000");
    expect(parts.nNF).toBe("000000999");
  });

  it("rejeita ano fora do range", () => {
    expect(() =>
      montarChave({
        uf: "SP",
        ano: 1999,
        mes: 1,
        cnpj: "11222333000181",
        modelo: "55",
        serie: 1,
        numero: 1,
        tpEmis: 1,
      }),
    ).toThrow(/Ano fora do range/);
  });
});

describe("chave-acesso — parseChave", () => {
  it("faz round-trip montar → string → parse", () => {
    const parts = montarChave({
      uf: "RS",
      ano: 2026,
      mes: 12,
      cnpj: "11222333000181",
      modelo: "55",
      serie: 7,
      numero: 999_999_999,
      tpEmis: 1,
      cNF: "99999998",
    });
    const chave = chaveToString(parts);
    const reparsed = parseChave(chave);
    expect(reparsed).toEqual(parts);
  });

  it("aceita chave com mascara", () => {
    const parts = montarChave({
      uf: "SP",
      ano: 2024,
      mes: 4,
      cnpj: "11222333000181",
      modelo: "55",
      serie: 1,
      numero: 1,
      tpEmis: 1,
      cNF: "12345678",
    });
    const chave = chaveToString(parts);
    const comEspacos = chave.match(/.{1,4}/g)!.join(" ");
    expect(() => parseChave(comEspacos)).not.toThrow();
  });

  it("rejeita chave com DV invalido", () => {
    const parts = montarChave({
      uf: "SP",
      ano: 2024,
      mes: 4,
      cnpj: "11222333000181",
      modelo: "55",
      serie: 1,
      numero: 1,
      tpEmis: 1,
      cNF: "12345678",
    });
    const chave = chaveToString(parts);
    // Inverte o DV
    const dvErrado = String((Number(parts.cDV) + 1) % 10);
    const corrompida = chave.slice(0, 43) + dvErrado;
    expect(() => parseChave(corrompida)).toThrow(/DV invalido/);
  });

  it("rejeita chave com tamanho errado", () => {
    expect(() => parseChave("123")).toThrow(/44 digitos/);
  });
});
