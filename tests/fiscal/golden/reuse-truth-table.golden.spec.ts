import { describe, expect, it } from "vitest";

import { shouldReuseNumero } from "../../../app/fiscal/domain/nfe-number-reuse";
import { lookupCStat } from "../../../app/fiscal/sefaz/cstat-mapper";

// GOLDEN F0 — tabela-verdade de shouldReuseNumero × lookupCStat().categoria
// em 1549bc4. O plano manda NÃO alterar nenhum dos dois (a classificação V2 é
// um arquivo novo); este golden prova isso. Codifica, para cada cStat, a
// categoria e uma máscara de 16 bits com o resultado de TODAS as combinações:
//
//   bit i (esquerda → direita, i = 0..15) = shouldReuseNumero(...) com
//     status   = i & 8 ? "REJECTED" : "DRAFT"
//     numero   = i & 4 ? 101        : -1
//     ambiente = i & 2 ? diferente  : igual     (draft HOMOLOGACAO × atual)
//     flag     = i & 1 ? true       : false
//
// cStats consecutivos com a mesma (categoria, máscara) são agrupados em faixa.

type ValorCStat = number | string | null | undefined;

function mascara(cStat: ValorCStat): string {
  let bits = "";
  for (let i = 0; i < 16; i++) {
    const reuso = shouldReuseNumero(
      {
        status: i & 8 ? "REJECTED" : "DRAFT",
        numero: i & 4 ? 101 : -1,
        ambiente: "HOMOLOGACAO",
        // String "974" (formato Focus) entra como veio: o tipo declara number,
        // mas o valor em runtime é o que o provider devolve.
        cStatRejeicao: cStat as number | null | undefined,
      },
      i & 2 ? "PRODUCAO" : "HOMOLOGACAO",
      Boolean(i & 1),
    );
    bits += reuso ? "1" : "0";
  }
  return bits;
}

function categoria(cStat: ValorCStat): string {
  return lookupCStat(cStat as number | null | undefined).categoria;
}

function rotulo(v: ValorCStat): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

function montarTabela(): string {
  const linhas: string[] = [
    "# shouldReuseNumero × lookupCStat(c).categoria — golden F0 (1549bc4)",
    "# formato: <cStat | faixa> | categoria | máscara (bit i: status=i&8 REJECTED, numero=i&4 101, ambiente=i&2 diferente, flag=i&1 true)",
  ];
  for (const especial of [null, undefined, "974"] as ValorCStat[]) {
    linhas.push(`${rotulo(especial)} | ${categoria(especial)} | ${mascara(especial)}`);
  }
  let inicio = 0;
  let atual = `${categoria(0)} | ${mascara(0)}`;
  for (let c = 1; c <= 1101; c++) {
    const sig = c <= 1100 ? `${categoria(c)} | ${mascara(c)}` : "__fim__";
    if (sig !== atual) {
      const faixa = inicio === c - 1 ? String(inicio) : `${inicio}-${c - 1}`;
      linhas.push(`${faixa} | ${atual}`);
      inicio = c;
      atual = sig;
    }
  }
  return linhas.join("\n") + "\n";
}

describe("golden F0 — tabela-verdade de reaproveitamento de número", () => {
  it("shouldReuseNumero × lookupCStat para cStat 0..1100, null, undefined e \"974\"", async () => {
    await expect(montarTabela()).toMatchFileSnapshot("./__snapshots__/reuse-truth-table.txt");
  });

  it("âncoras legíveis (as mesmas do diagnóstico R2)", () => {
    // Só a combinação REJECTED + 101 + mesmo ambiente + flag ligada reaproveita.
    const SO_REUSO = "0000000000000100";
    expect(mascara(225)).toBe(SO_REUSO);
    expect(mascara(205)).toBe(SO_REUSO); // aceito como reaproveitável hoje (R2)
    expect(mascara(206)).toBe(SO_REUSO);
    expect(mascara(539)).toBe("0".repeat(16)); // duplicidade
    expect(mascara(110)).toBe("0".repeat(16)); // denegada
    expect(mascara(974)).toBe("0".repeat(16)); // ≥ 600 nunca reaproveita (R2)
    expect(mascara("974")).toBe("0".repeat(16)); // string do Focus (R3)
    expect(categoria(974)).toBe("desconhecido");
  });
});
