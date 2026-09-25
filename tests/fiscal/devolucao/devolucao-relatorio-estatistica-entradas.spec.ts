/**
 * G4 #4 (N-completude-3): o card "Autorizadas" (getStats) e o relatório mensal XML somam
 * ENTRADA e SAÍDA juntas — com a devolução de venda (nota de entrada), o valor dela entra
 * no "valor total" como se fosse venda. O número que a tela e o contador JÁ usam NÃO muda
 * (`valorTotal`); o que entra é o RÓTULO/a separação: quanto dele é entrada.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sqlStats: "" }));
vi.mock("../../../app/lib/prisma", () => ({
  default: {
    nfeEmitida: {
      groupBy: async () => [
        { status: "AUTHORIZED", _count: { _all: 3 } },
        { status: "REJECTED", _count: { _all: 1 } },
      ],
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      h.sqlStats = strings.join("?");
      return [{ valorTotal: 1419.44, valorEntradas: 120, autorizadasEntrada: 1 }];
    },
  },
}));

import { NfeRepository } from "../../../app/repositories/nfe.repository";
import { buildRelatorioMensalXml, type RelatorioNota } from "../../../app/fiscal/generators/relatorio-mensal-xml";

const nota = (numero: number, over: Partial<RelatorioNota> = {}): RelatorioNota => ({
  numero, serie: 1, chaveAcesso: "4".repeat(44), status: "AUTHORIZED", dataEmissao: new Date("2026-09-10T15:00:00Z"),
  dataAutorizacao: new Date("2026-09-10T15:00:31Z"), protocoloAutorizacao: "142260000000001", destinatarioNome: "CLIENTE",
  destinatarioDocumento: "00000000000100", valorTotal: 100, xmlAutorizado: null, ...over,
});
const relatorio = (notas: RelatorioNota[]) =>
  buildRelatorioMensalXml({ emitente: { cnpj: "57502966000144", razaoSocial: "DLS AUTO PECAS" }, ano: 2026, mes: 9, geradoEm: new Date("2026-10-01T12:00:00Z"), notas });

describe("relatório mensal XML: entrada e devolução ROTULADAS, valorTotal igual", () => {
  it("mês só com saídas: o XML sai BYTE A BYTE como antes (os campos novos não mudam nada)", () => {
    const antes = relatorio([nota(711), nota(713, { valorTotal: 50 })]);
    const agora = relatorio([nota(711, { tipoOperacao: "SAIDA", finalidade: "NORMAL" }), nota(713, { valorTotal: 50, tipoOperacao: "SAIDA", finalidade: "NORMAL" })]);
    expect(agora).toBe(antes);
    expect(agora).not.toContain("Entradas");
    expect(agora).not.toContain("tipoOperacao");
  });

  it("com uma devolução de VENDA (entrada): valorTotal continua a soma de tudo; o resumo diz quanto é entrada e a linha diz o que ela é", () => {
    const xml = relatorio([nota(711, { valorTotal: 1299.44, tipoOperacao: "SAIDA", finalidade: "NORMAL" }), nota(715, { valorTotal: 120, tipoOperacao: "ENTRADA", finalidade: "DEVOLUCAO" })]);
    expect(xml).toContain('<resumo quantidade="2" valorTotal="1419.44" quantidadeEntradas="1" valorEntradas="120.00">');
    expect(xml).toMatch(/<nota numero="715"[^>]* valorTotal="120\.00" tipoOperacao="ENTRADA" finalidade="DEVOLUCAO"\/>/);
    expect(xml).toMatch(/<nota numero="711"[^>]* valorTotal="1299\.44"\/>/);
  });

  it("devolução de COMPRA (saída) é rotulada como devolução, sem virar entrada", () => {
    const xml = relatorio([nota(716, { tipoOperacao: "SAIDA", finalidade: "DEVOLUCAO" })]);
    expect(xml).toContain('<resumo quantidade="1" valorTotal="100.00">');
    expect(xml).toMatch(/<nota numero="716"[^>]* valorTotal="100\.00" finalidade="DEVOLUCAO"\/>/);
  });
});

describe("card de estatística (getStats): quanto do valor autorizado é ENTRADA, na MESMA consulta", () => {
  it("valorTotal e autorizadas iguais aos de sempre; valorEntradas e autorizadasEntrada a mais", async () => {
    const s = await new NfeRepository().getStats("tenant");
    expect(s).toEqual({ total: 4, autorizadas: 3, rejeitadas: 1, canceladas: 0, valorTotal: 1419.44, valorEntradas: 120, autorizadasEntrada: 1 });
    // A soma de sempre continua a mesma expressão; as entradas são um FILTER da mesma linha.
    expect(h.sqlStats).toContain(`COALESCE(SUM(("totaisJson"->>'totalNota')::numeric), 0)::float8 AS "valorTotal"`);
    expect(h.sqlStats).toContain(`FILTER (WHERE "tipoOperacao" = 'ENTRADA')`);
    expect(h.sqlStats).toContain(`"status" = 'AUTHORIZED'`);
  });
});
