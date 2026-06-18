import { describe, it, expect } from "vitest";
import {
  caixaNumero,
  isCaixaNumericaSimples,
  matchConverted,
  matchRawVaapt,
  isExcluivel,
  bucketOf,
  type BucketCtx,
} from "./legacy-cleanup-rules";

const noHistory: Omit<BucketCtx, "inScope"> = {
  hasOrderItem: false,
  hasNfeItem: false,
  hasReceivableItem: false,
};
const inScope = (extra: Partial<BucketCtx> = {}): BucketCtx => ({
  inScope: true,
  ...noHistory,
  ...extra,
});

describe("isCaixaNumericaSimples / caixaNumero", () => {
  it("aceita as 3 formas numéricas (espaço, colado, hífen)", () => {
    expect(caixaNumero("Caixa 437")).toBe(437);
    expect(caixaNumero("CAIXA276")).toBe(276);
    expect(caixaNumero("CAIXA-155")).toBe(155);
    expect(caixaNumero("caixa  1 ")).toBe(1);
    expect(caixaNumero("Caixa 728")).toBe(728);
    expect(isCaixaNumericaSimples("CAIXA276")).toBe(true);
  });

  it("rejeita madeira em qualquer variação (intocável)", () => {
    for (const c of [
      "Caixa de madeira 3",
      "CAIXA MADEIRA 04",
      "caixa de Madeira",
      "Caixa Madeiras 12",
    ]) {
      expect(caixaNumero(c)).toBeNull();
      expect(isCaixaNumericaSimples(c)).toBe(false);
    }
  });

  it("rejeita caixas não-numéricas e não-caixas", () => {
    for (const c of [
      "CAIXA MAIOR",
      "CAIXA GRANDE",
      "CAIXA FERRO 11",
      "CAIXA 3R5",
      "GALPÃO 1",
      "PRATELEIRA 6 V 17",
      "S1P4N2",
      "Caixa",
      "Caixa 12345", // 5 dígitos fora de \d{1,4}
      "",
      null,
      undefined,
    ]) {
      expect(caixaNumero(c as string)).toBeNull();
    }
  });
});

describe("matchConverted (centena 100/200/300/400/500/800 + sufixo 3-4)", () => {
  it("casa convertidos reais", () => {
    expect(matchConverted("3005801")).toEqual({ prefix: 300 });
    expect(matchConverted("300883")).toEqual({ prefix: 300 });
    expect(matchConverted("2002389")).toEqual({ prefix: 200 });
    expect(matchConverted("1001452")).toEqual({ prefix: 100 });
    expect(matchConverted("5003632")).toEqual({ prefix: 500 });
    expect(matchConverted("800451")).toEqual({ prefix: 800 });
    expect(matchConverted("400123")).toEqual({ prefix: 400 }); // 400 está no set
  });

  it("NÃO casa prefixos fora do set nem comprimentos errados", () => {
    expect(matchConverted("600123")).toBeNull(); // 600 fora do set
    expect(matchConverted("900123")).toBeNull();
    expect(matchConverted("359444")).toBeNull(); // 359 fora do set
    expect(matchConverted("20034")).toBeNull(); // len 5 (preserve)
    expect(matchConverted("10012")).toBeNull(); // 100+12: sufixo 2 díg
    expect(matchConverted("30012345")).toBeNull(); // sufixo 5 díg (len 8)
    expect(matchConverted("100")).toBeNull();
    expect(matchConverted("22625")).toBeNull();
    expect(matchConverted("11298")).toBeNull();
  });
});

describe("matchRawVaapt (^[HJY]-?\\d+$)", () => {
  it("casa crus H/J/Y com ou sem hífen, case-insensitive", () => {
    expect(matchRawVaapt("J-4997")).toEqual({ letter: "J" });
    expect(matchRawVaapt("Y-5881")).toEqual({ letter: "Y" });
    expect(matchRawVaapt("H-802")).toEqual({ letter: "H" });
    expect(matchRawVaapt("Y7526")).toEqual({ letter: "Y" });
    expect(matchRawVaapt("h-12")).toEqual({ letter: "H" });
  });

  it("NÃO casa outras letras nem ML nem puro numérico", () => {
    expect(matchRawVaapt("V45-99")).toBeNull();
    expect(matchRawVaapt("Gs23")).toBeNull();
    expect(matchRawVaapt("K-12")).toBeNull();
    expect(matchRawVaapt("ML-MLB3895158286")).toBeNull();
    expect(matchRawVaapt("22625")).toBeNull();
    expect(matchRawVaapt("J-")).toBeNull(); // sem dígito
  });
});

describe("isExcluivel", () => {
  it("true só para convertido ou cru; nunca para puro numérico", () => {
    expect(isExcluivel("3005801")).toBe(true);
    expect(isExcluivel("J-4997")).toBe(true);
    expect(isExcluivel("800451")).toBe(true);
    for (const s of ["22625", "11298", "7800", "99999", "1", "18000", "17999"]) {
      expect(isExcluivel(s)).toBe(false);
    }
  });
});

describe("bucketOf — precedência e classificação", () => {
  it("convertido em escopo, sem histórico → a_excluir", () => {
    const r = bucketOf("3005801", inScope());
    expect(r.bucket).toBe("a_excluir");
    expect(r.rule).toBe("convertido");
    expect(r.detail).toBe("300");
  });

  it("cru H/J/Y em escopo, sem histórico → a_excluir", () => {
    expect(bucketOf("J-4997", inScope())).toMatchObject({ bucket: "a_excluir", rule: "cru_hjy", detail: "J" });
  });

  it("excluível COM histórico → protegido_historico (não excluir)", () => {
    expect(bucketOf("3005801", inScope({ hasOrderItem: true })).bucket).toBe("protegido_historico");
    expect(bucketOf("J-4997", inScope({ hasNfeItem: true })).bucket).toBe("protegido_historico");
    expect(bucketOf("800451", inScope({ hasReceivableItem: true })).bucket).toBe("protegido_historico");
  });

  it("excluível mas fora de escopo → fora_de_escopo", () => {
    expect(bucketOf("3005801", { ...inScope(), inScope: false }).bucket).toBe("fora_de_escopo");
  });

  it("numérico puro em escopo → preservado (inclui <18000 e >=18000)", () => {
    for (const s of ["22625", "29865", "11298", "7800", "18000", "17999", "1"]) {
      expect(bucketOf(s, inScope()).bucket).toBe("preservado");
    }
  });

  it("anomalias → revisar (não excluir)", () => {
    expect(bucketOf("ML-MLB3895158286", inScope())).toMatchObject({ bucket: "revisar", detail: "ml" });
    expect(bucketOf("50021-57", inScope())).toMatchObject({ bucket: "revisar", detail: "dash" });
    expect(bucketOf("359444", inScope())).toMatchObject({ bucket: "revisar", detail: "num_6_7" });
    expect(bucketOf("V45-99", inScope())).toMatchObject({ bucket: "revisar", detail: "letra" });
    expect(bucketOf("Gs23", inScope())).toMatchObject({ bucket: "revisar", detail: "letra" });
    expect(bucketOf("", inScope())).toMatchObject({ bucket: "revisar", detail: "lixo" });
    expect(bucketOf("1234567500600170000000000000", inScope())).toMatchObject({ bucket: "revisar", detail: "lixo" });
  });
});

describe("INVARIANTE DE SEGURANÇA — numérico puro nunca é excluído", () => {
  it("nenhum SKU numérico puro (sem prefixo de centena) cai em a_excluir, em qualquer ctx", () => {
    const purosNumericos = [
      "1", "17999", "18000", "18001", "22625", "29865", "99999",
      "7800", "11298", "15710", "032763", "100", "200", "300", "500", "800",
      "20034", "10012", "80012", "50012",
    ];
    const ctxs: BucketCtx[] = [];
    for (const inS of [true, false])
      for (const o of [true, false])
        for (const n of [true, false])
          for (const r of [true, false])
            ctxs.push({ inScope: inS, hasOrderItem: o, hasNfeItem: n, hasReceivableItem: r });

    for (const sku of purosNumericos) {
      for (const ctx of ctxs) {
        const { bucket } = bucketOf(sku, ctx);
        expect(bucket, `sku=${sku} ctx=${JSON.stringify(ctx)}`).not.toBe("a_excluir");
      }
    }
  });
});
