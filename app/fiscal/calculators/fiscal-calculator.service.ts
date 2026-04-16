import {
  RegimeTributario,
  NfeItemInput,
  NfeItemTributos,
  NfeTotais,
  CalculoNfeResult,
} from "../domain/nfe.types";
import {
  getAliquotasPadrao,
  isIcmsTributado,
  isIcmsComReducao,
  isPisCofinsTributado,
  round2,
} from "./tribute-rules";

/**
 * Serviço puro de cálculo fiscal para NF-e.
 *
 * Não acessa banco, não muta estado. Recebe inputs → devolve totalizadores.
 * Todas as regras de negócio ficam aqui + tribute-rules.ts.
 */
export class FiscalCalculatorService {
  /**
   * Calcula tributos de todos os itens e totaliza a nota.
   */
  calcular(
    regime: RegimeTributario,
    itens: NfeItemInput[],
  ): CalculoNfeResult {
    if (!itens || itens.length === 0) {
      throw new Error("A nota deve ter ao menos 1 item");
    }

    const defaults = getAliquotasPadrao(regime);
    const itensCalculados = itens.map((item) =>
      this.calcularItem(item, defaults, regime),
    );

    const totais = this.totalizar(itensCalculados, itens);

    return { itens: itensCalculados, totais };
  }

  private calcularItem(
    item: NfeItemInput,
    defaults: { icms: number; ipi: number; pis: number; cofins: number },
    regime: RegimeTributario,
  ): NfeItemTributos {
    const valorBruto = round2(item.quantidade * item.valorUnitario);
    const desconto = round2(item.desconto ?? 0);
    const baseCalculo = round2(valorBruto - desconto);

    // ── ICMS ──
    let bcIcms = 0;
    let valorIcms = 0;
    let aliquotaIcms = item.aliquotaIcms ?? defaults.icms;

    if (regime === "SIMPLES") {
      // Simples Nacional: ICMS recolhido via DAS, não destaca na nota
      bcIcms = 0;
      valorIcms = 0;
      aliquotaIcms = 0;
    } else if (isIcmsTributado(item.cstIcms)) {
      bcIcms = baseCalculo;

      if (isIcmsComReducao(item.cstIcms) && item.reducaoBcIcms != null) {
        const fatorReducao = 1 - item.reducaoBcIcms / 100;
        bcIcms = round2(baseCalculo * fatorReducao);
      }

      valorIcms = round2(bcIcms * (aliquotaIcms / 100));
    } else {
      // Isento, não-tributado, substituição, etc.
      aliquotaIcms = 0;
    }

    // ── IPI ──
    const aliquotaIpi = item.aliquotaIpi ?? defaults.ipi;
    const bcIpi = aliquotaIpi > 0 ? baseCalculo : 0;
    const valorIpi = round2(bcIpi * (aliquotaIpi / 100));

    // ── PIS ──
    let aliquotaPis = item.aliquotaPis ?? defaults.pis;
    let bcPis = 0;
    let valorPis = 0;

    if (isPisCofinsTributado(item.cstPis)) {
      bcPis = baseCalculo;
      valorPis = round2(bcPis * (aliquotaPis / 100));
    } else {
      aliquotaPis = 0;
    }

    // ── COFINS ──
    let aliquotaCofins = item.aliquotaCofins ?? defaults.cofins;
    let bcCofins = 0;
    let valorCofins = 0;

    if (isPisCofinsTributado(item.cstCofins)) {
      bcCofins = baseCalculo;
      valorCofins = round2(bcCofins * (aliquotaCofins / 100));
    } else {
      aliquotaCofins = 0;
    }

    const valorTotalTributos = round2(
      valorIcms + valorIpi + valorPis + valorCofins,
    );

    return {
      bcIcms,
      valorIcms,
      aliquotaIcms,
      bcIpi,
      valorIpi,
      aliquotaIpi,
      bcPis,
      valorPis,
      aliquotaPis,
      bcCofins,
      valorCofins,
      aliquotaCofins,
      valorTotalTributos,
    };
  }

  private totalizar(
    itensCalc: NfeItemTributos[],
    itensInput: NfeItemInput[],
  ): NfeTotais {
    let totalProdutos = 0;
    let totalDesconto = 0;
    let totalBcIcms = 0;
    let totalIcms = 0;
    let totalBcIpi = 0;
    let totalIpi = 0;
    let totalPis = 0;
    let totalCofins = 0;
    let totalTributos = 0;

    for (let i = 0; i < itensCalc.length; i++) {
      const input = itensInput[i];
      const calc = itensCalc[i];

      const valorBruto = round2(input.quantidade * input.valorUnitario);
      totalProdutos += valorBruto;
      totalDesconto += round2(input.desconto ?? 0);

      totalBcIcms += calc.bcIcms;
      totalIcms += calc.valorIcms;
      totalBcIpi += calc.bcIpi;
      totalIpi += calc.valorIpi;
      totalPis += calc.valorPis;
      totalCofins += calc.valorCofins;
      totalTributos += calc.valorTotalTributos;
    }

    // Total da nota = produtos - desconto + IPI (ICMS/PIS/COFINS já estão dentro do preço)
    const totalNota = round2(totalProdutos - totalDesconto + totalIpi);

    return {
      totalProdutos: round2(totalProdutos),
      totalDesconto: round2(totalDesconto),
      totalBcIcms: round2(totalBcIcms),
      totalIcms: round2(totalIcms),
      totalBcIpi: round2(totalBcIpi),
      totalIpi: round2(totalIpi),
      totalPis: round2(totalPis),
      totalCofins: round2(totalCofins),
      totalNota,
      totalTributos: round2(totalTributos),
    };
  }
}
