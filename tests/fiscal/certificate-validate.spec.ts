import { describe, it, expect } from "vitest";
import {
  extractCnpjFromCert,
  validateCertForEmitter,
} from "../../app/fiscal/certificate/certificate-loader.service";
import { generateTestCertificate } from "./__helpers__/test-certificate";

const EMITTER_CNPJ = "51195502000156";
const SAME_BASE_FILIAL = "51195502000237"; // mesma base 8, filial diferente
const OTHER_CNPJ = "11222333000181";

describe("extractCnpjFromCert", () => {
  it("extrai o CNPJ do CN no formato 'RAZAO:CNPJ'", () => {
    expect(extractCnpjFromCert("EMPRESA LTDA:51195502000156")).toBe(
      "51195502000156",
    );
  });

  it("retorna o ultimo grupo de 14 digitos quando ha mais de um", () => {
    expect(extractCnpjFromCert("12345678000199 EMPRESA:51195502000156")).toBe(
      "51195502000156",
    );
  });

  it("retorna null para CN sem CNPJ ou nulo", () => {
    expect(extractCnpjFromCert("DEXO TEST CERT")).toBeNull();
    expect(extractCnpjFromCert(null)).toBeNull();
  });
});

describe("validateCertForEmitter", () => {
  it("aprova certificado valido com CNPJ do emissor", () => {
    const tc = generateTestCertificate({
      subjectCN: `EMPRESA TESTE LTDA:${EMITTER_CNPJ}`,
      daysValid: 200,
    });

    const r = validateCertForEmitter(tc.pfxBuffer, tc.password, EMITTER_CNPJ);

    expect(r.ok).toBe(true);
    expect(r.cnpjMatched).toBe(true);
    expect(r.certCnpj).toBe(EMITTER_CNPJ);
    expect(r.notAfter?.getTime()).toBeGreaterThan(Date.now());
  });

  it("aceita matriz/filial (mesma base de 8 digitos)", () => {
    const tc = generateTestCertificate({
      subjectCN: `EMPRESA TESTE LTDA:${SAME_BASE_FILIAL}`,
      daysValid: 200,
    });

    const r = validateCertForEmitter(tc.pfxBuffer, tc.password, EMITTER_CNPJ);

    expect(r.ok).toBe(true);
    expect(r.cnpjMatched).toBe(true);
  });

  it("rejeita senha incorreta", () => {
    const tc = generateTestCertificate({
      subjectCN: `EMPRESA:${EMITTER_CNPJ}`,
    });

    const r = validateCertForEmitter(tc.pfxBuffer, "senha-errada", EMITTER_CNPJ);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/senha/i);
  });

  it("rejeita certificado expirado", () => {
    const tc = generateTestCertificate({
      subjectCN: `EMPRESA:${EMITTER_CNPJ}`,
      daysValid: -1,
    });

    const r = validateCertForEmitter(tc.pfxBuffer, tc.password, EMITTER_CNPJ);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expirad/i);
  });

  it("rejeita certificado de CNPJ com base diferente do emissor", () => {
    const tc = generateTestCertificate({
      subjectCN: `OUTRA EMPRESA:${OTHER_CNPJ}`,
      daysValid: 200,
    });

    const r = validateCertForEmitter(tc.pfxBuffer, tc.password, EMITTER_CNPJ);

    expect(r.ok).toBe(false);
    expect(r.cnpjMatched).toBe(false);
    expect(r.error).toMatch(/CNPJ/);
  });

  it("nao bloqueia quando o CN nao tem CNPJ, mas sinaliza cnpjMatched=false", () => {
    const tc = generateTestCertificate({
      subjectCN: "DEXO TEST CERT",
      daysValid: 200,
    });

    const r = validateCertForEmitter(tc.pfxBuffer, tc.password, EMITTER_CNPJ);

    expect(r.ok).toBe(true);
    expect(r.cnpjMatched).toBe(false);
    expect(r.certCnpj).toBeNull();
  });
});
