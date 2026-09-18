import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  calcularDvChaveAcesso,
  formatarChaveAcesso,
  isChaveAcessoValida,
  normalizarChaveAcesso,
  parseChaveAcesso,
  validarChaveAcesso,
} from "../../../app/fiscal/domain/chave-acesso-dv";
// Só no teste: o original importa node:crypto e é a referência de paridade.
import {
  calcularDV,
  chaveToString,
  isCnfProibido,
  montarChave,
  parseChave,
} from "../../../app/fiscal/sefaz/chave-acesso";

/** LCG determinístico (sem Math.random: falha reproduzível). */
function lcg(semente: number) {
  let s = semente >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

function base43(rand: () => number): string {
  let out = "";
  while (out.length < 43) out += String(rand() % 10);
  return out;
}

describe("chave-acesso-dv — paridade com app/fiscal/sefaz/chave-acesso.ts", () => {
  it("DV idêntico a calcularDV em 200 bases geradas", () => {
    const rand = lcg(20260917);
    for (let i = 0; i < 200; i++) {
      const b = base43(rand);
      expect(calcularDvChaveAcesso(b)).toBe(calcularDV(b));
    }
  });

  it("DV idêntico em 200 chaves de montarChave (cNF explícito) e partes batem com parseChave", () => {
    const rand = lcg(42);
    const ufs = ["PR", "SP", "RJ", "MG", "SC", "RS", "BA", "GO"] as const;
    let geradas = 0;
    while (geradas < 200) {
      const numero = (rand() % 999_999_998) + 1;
      const cNF = String(rand() % 100_000_000).padStart(8, "0");
      if (isCnfProibido(cNF) || Number(cNF) === numero) continue;
      const partesOrig = montarChave({
        uf: ufs[rand() % ufs.length],
        ano: 2020 + (rand() % 7),
        mes: (rand() % 12) + 1,
        cnpj: String(rand()).padStart(14, "1").slice(0, 14),
        modelo: rand() % 2 === 0 ? "55" : "65",
        serie: rand() % 1000,
        numero,
        tpEmis: 1,
        cNF,
      });
      const chave = chaveToString(partesOrig);
      expect(isChaveAcessoValida(chave)).toBe(true);
      expect(calcularDvChaveAcesso(chave.slice(0, 43))).toBe(partesOrig.cDV);
      const p = parseChaveAcesso(chave)!;
      const ref = parseChave(chave);
      expect(p.cUF).toBe(ref.cUF);
      expect(p.aamm).toBe(ref.AAMM);
      expect(p.cnpjCpf).toBe(ref.CNPJ);
      expect(p.modelo).toBe(ref.mod);
      expect(p.serie).toBe(Number(ref.serie));
      expect(p.numero).toBe(Number(ref.nNF));
      expect(p.tpEmis).toBe(ref.tpEmis);
      expect(p.cNF).toBe(ref.cNF);
      expect(p.dv).toBe(ref.cDV);
      expect(p.dvValido).toBe(true);
      geradas++;
    }
  });

  it("chave com DV trocado é inválida nos dois módulos", () => {
    const b = "4126091138627600017655003000000012100000012";
    const dv = calcularDV(b);
    const errado = String((Number(dv) + 1) % 10);
    expect(isChaveAcessoValida(b + errado)).toBe(false);
    expect(() => parseChave(b + errado)).toThrow();
    expect(parseChaveAcesso(b + errado)!.dvValido).toBe(false);
  });
});

describe("chave-acesso-dv — normalização e validação de entrada", () => {
  const b = "4126091138627600017655003000000012100000012";
  const chave = b + calcularDV(b);

  it("aceita prefixo NFe (Focus grava 47 caracteres) e separadores", () => {
    expect(normalizarChaveAcesso("NFe" + chave)).toBe(chave);
    expect(normalizarChaveAcesso(" nfe" + chave + " ")).toBe(chave);
    expect(normalizarChaveAcesso(formatarChaveAcesso(chave))).toBe(chave);
    expect(normalizarChaveAcesso("4126.0911-3862 7600/0176" + chave.slice(20))).toBe(chave);
  });

  it("letra no meio não é limpa em silêncio", () => {
    expect(normalizarChaveAcesso(chave.slice(0, 10) + "A" + chave.slice(11))).toBeNull();
    expect(normalizarChaveAcesso(12345 as unknown)).toBeNull();
    expect(normalizarChaveAcesso(null)).toBeNull();
  });

  it("isChaveAcessoValida é estrita (não normaliza)", () => {
    expect(isChaveAcessoValida(chave)).toBe(true);
    expect(isChaveAcessoValida("NFe" + chave)).toBe(false);
    expect(isChaveAcessoValida(chave.slice(0, 43))).toBe(false);
    expect(isChaveAcessoValida(undefined)).toBe(false);
  });

  it("parseChaveAcesso lê nNF e série REAIS da chave", () => {
    const p = parseChaveAcesso("NFe" + chave)!;
    expect(p.chave).toBe(chave);
    expect(p.uf).toBe("PR");
    expect(p.ano).toBe(2026);
    expect(p.mes).toBe(9);
    expect(p.cnpjCpf).toBe("11386276000176");
    expect(p.modelo).toBe("55");
    expect(p.serie).toBe(3);
    expect(p.numero).toBe(12);
    expect(parseChaveAcesso(chave.slice(0, 40))).toBeNull();
  });

  it("validarChaveAcesso devolve o código certo para cada falha", () => {
    expect(validarChaveAcesso("")).toMatchObject({ ok: false, codigo: "VAZIA" });
    expect(validarChaveAcesso("41x")).toMatchObject({ ok: false, codigo: "CARACTER_INVALIDO" });
    expect(validarChaveAcesso(chave.slice(0, 43))).toMatchObject({ ok: false, codigo: "TAMANHO", mensagem: "Faltam 1 dígitos." });
    expect(validarChaveAcesso(chave + "1")).toMatchObject({ ok: false, codigo: "TAMANHO" });
    const errado = b + String((Number(calcularDV(b)) + 1) % 10);
    expect(validarChaveAcesso(errado)).toMatchObject({ ok: false, codigo: "DV" });

    const b57 = b.slice(0, 20) + "57" + b.slice(22);
    expect(validarChaveAcesso(b57 + calcularDV(b57))).toMatchObject({ ok: false, codigo: "MODELO" });
    const bMes = b.slice(0, 4) + "13" + b.slice(6);
    expect(validarChaveAcesso(bMes + calcularDV(bMes))).toMatchObject({ ok: false, codigo: "MES" });

    const ok = validarChaveAcesso("NFe" + chave);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.chave).toBe(chave);
    expect(validarChaveAcesso(chave, { modelos: ["65"] })).toMatchObject({ ok: false, codigo: "MODELO" });
  });

  it("formatarChaveAcesso gera 11 grupos de 4", () => {
    expect(formatarChaveAcesso(chave).split(" ")).toHaveLength(11);
    expect(formatarChaveAcesso("abc")).toBe("abc");
  });
});

describe("fronteira dos módulos puros de devolução", () => {
  const raiz = path.resolve(__dirname, "../../..");
  const arquivos = [
    "app/fiscal/domain/chave-acesso-dv.ts",
    "app/fiscal/domain/devolucao-cfop.ts",
    "app/fiscal/devolucao/tipos.ts",
    "app/fiscal/devolucao/contrato.ts",
    "app/fiscal/devolucao/modo-referencia.ts",
    "app/fiscal/devolucao/saldo.ts",
    "app/fiscal/devolucao/validacao.ts",
    "app/fiscal/devolucao/tributacao.ts",
    "app/fiscal/devolucao/montagem.ts",
  ];

  it.each(arquivos)("%s não importa node:*, prisma nem módulo de servidor em runtime", (rel) => {
    const fonte = readFileSync(path.join(raiz, rel), "utf-8");
    const imports = fonte.match(/^import[\s\S]*?from\s+["'][^"']+["'];?/gm) ?? [];
    for (const imp of imports) {
      expect(imp).not.toMatch(/["']node:/);
      expect(imp).not.toMatch(/prisma|fast-xml-parser|process\.env/);
      const spec = /from\s+["']([^"']+)["']/.exec(imp)![1];
      const soTipo = /^import\s+type\s/.test(imp);
      if (/sefaz\/|interfaces\/|repositories\/|usecases\//.test(spec)) {
        expect(soTipo, `${rel}: ${imp}`).toBe(true);
      }
    }
    expect(fonte).not.toMatch(/process\.env/);
    expect(fonte).not.toMatch(/require\(/);
  });
});
