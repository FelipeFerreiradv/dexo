import { describe, it, expect } from "vitest";
import {
  asNumber,
  asInt,
  padDoc,
  validCPF,
  validCNPJ,
  toCep,
  toUf,
  toEmail,
  cleanUndefined,
  isPlaceholderName,
  cleanChassis,
  cleanPlate,
  parseFlexibleDate,
  normKey,
  chunk,
} from "../../app/usecases/import/lib/normalize";

// Paridade com os helpers dos scripts de migração (migracao-vaapt.ts /
// migracao-vaapt-nfes.ts) — a semântica precisa ser idêntica para preservar
// a idempotência com tenants já migrados via CLI.
describe("import/normalize — decimais BR", () => {
  it("converte '1.234,56' → 1234.56 (ponto = milhar quando há vírgula)", () => {
    expect(asNumber("1.234,56")).toBe(1234.56);
  });
  it("mantém '1234.56' (sem vírgula, ponto é decimal)", () => {
    expect(asNumber("1234.56")).toBe(1234.56);
  });
  it("aceita number e rejeita lixo", () => {
    expect(asNumber(12.5)).toBe(12.5);
    expect(asNumber("abc")).toBeNull();
    expect(asNumber("")).toBeNull();
    expect(asNumber(null)).toBeNull();
  });
  it("asInt trunca", () => {
    expect(asInt("12,9")).toBe(12);
    expect(asInt(null)).toBeNull();
  });
});

describe("import/normalize — padDoc (CPF/CNPJ)", () => {
  it("recupera até 2 zeros à esquerda cortados pelo Excel", () => {
    expect(validCPF("1234567890")).toBe("01234567890"); // 10 díg → pad p/ 11
    expect(validCPF(1234567890)).toBe("01234567890"); // number do Excel
    expect(validCNPJ("1234567000195")).toBe("01234567000195");
  });
  it("rejeita comprimento irrecuperável (>2 dígitos faltando)", () => {
    expect(validCPF("12345678")).toBeNull();
  });
  it("rejeita placeholders (todos os dígitos iguais)", () => {
    expect(validCPF("00000000000")).toBeNull();
    expect(validCPF("99999999999")).toBeNull();
    expect(validCNPJ("11111111111111")).toBeNull();
  });
  it("aceita documento já completo", () => {
    expect(validCPF("52998224725")).toBe("52998224725");
  });
});

describe("import/normalize — CEP / UF / email / undefined", () => {
  it("toCep recupera zero à esquerda e exige 8 dígitos", () => {
    expect(toCep("1310100")).toBe("01310100");
    expect(toCep("88.010-000")).toBe("88010000");
    expect(toCep("123")).toBeNull();
  });
  it("toUf valida contra as 27 UFs", () => {
    expect(toUf("sc")).toBe("SC");
    expect(toUf("XX")).toBeNull();
    expect(toUf(null)).toBeNull();
  });
  it("toEmail valida formato simples", () => {
    expect(toEmail("a@b.com")).toBe("a@b.com");
    expect(toEmail("não-é-email")).toBeNull();
  });
  it("cleanUndefined trata o literal 'undefined' como vazio", () => {
    expect(cleanUndefined("undefined")).toBeNull();
    expect(cleanUndefined("Casa 2")).toBe("Casa 2");
  });
  it("isPlaceholderName detecta nomes-lixo das bases legadas", () => {
    expect(isPlaceholderName("NÃO IDENTIFICADO")).toBe(true);
    expect(isPlaceholderName("undefined undefined")).toBe(true);
    expect(isPlaceholderName("Maria da Silva")).toBe(false);
  });
});

describe("import/normalize — chassi / placa", () => {
  it("cleanChassis limpa e rejeita lixo, sem impor 17 (quem impõe é o usecase)", () => {
    expect(cleanChassis(" 9bwag4124ft592152 ")).toBe("9BWAG4124FT592152");
    expect(cleanChassis("0000000'0")).toBeNull(); // caractere inválido
    expect(cleanChassis("ABC")).toBeNull(); // curto demais
    expect(cleanChassis("AAAAAAAAAAAAA")).toBeNull(); // repetido
  });
  it("cleanPlate normaliza e valida comprimento 6-8", () => {
    expect(cleanPlate("abc-1234")).toBe("ABC1234");
    expect(cleanPlate("AB1")).toBeNull();
  });
});

describe("import/normalize — datas flexíveis", () => {
  it("ISO, dd/mm/yyyy e serial Excel", () => {
    expect(parseFlexibleDate("2024-05-31")?.toISOString().slice(0, 10)).toBe(
      "2024-05-31",
    );
    expect(parseFlexibleDate("31/05/2024")?.toISOString().slice(0, 10)).toBe(
      "2024-05-31",
    );
    // Serial 45443 = 2024-05-31 (base Excel 1900).
    expect(parseFlexibleDate(45443)?.toISOString().slice(0, 10)).toBe(
      "2024-05-31",
    );
    expect(parseFlexibleDate("lixo")).toBeNull();
  });
});

describe("import/normalize — normKey / chunk", () => {
  it("normKey remove acentos, parênteses, caixa e pontuação", () => {
    expect(normKey("N° NFe")).toBe("nnfe");
    expect(normKey("# Cod Peca")).toBe("codpeca");
    expect(normKey("Localização")).toBe("localizacao");
    expect(normKey("Valor (R$)")).toBe("valor");
  });
  it("chunk divide preservando a ordem", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
