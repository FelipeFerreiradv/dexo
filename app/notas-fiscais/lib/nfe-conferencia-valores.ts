// Quadro de conferencia de valores do ULTIMO passo do wizard de NF-e
// ("Finalizar"), em modulo puro — mesmo padrao do `nfe-aviso-emissao.ts` e do
// `nfe-erro-calculo-ui.ts` ao lado: o texto que a dona do desmanche le é o
// produto, e produto se testa.
//
// ── O defeito (DLS AUTO PEÇAS, 24/09/2026) ──
// A tela mostrava um quadro ambar "Divergência nos valores — Total dos produtos
// (R$ X) difere do total dos pagamentos (R$ Y)" sempre que
// |produtos + frete − pagamentos| > 0,01. Numa DEVOLUÇÃO isso dispara SEMPRE e é
// FALSO: devolução não tem pagamento. O rascunho carrega
// `[{meio:"SEM_PAGAMENTO", valor:0}]` e o XML correto sai com
// `<pag><detPag><tPag>90</tPag><vPag>0.00</vPag></detPag></pag>`. A cliente
// passou o dia lendo "Diferença: R$ 864,58" em ambar ao lado do botão de emitir
// e achou que era esse o defeito que a impedia de emitir. Não era: o quadro
// nunca bloqueou nada, e naquela nota os dois números estavam CERTOS.
//
// ── Por que não basta esconder o quadro na devolução ──
// O alarme existe para pegar nota de VENDA em que alguém esqueceu de lançar o
// pagamento. Apagá-lo na devolução mata o alarme falso, mas abre um silêncio
// novo: quem lançar PIX de R$ 500 numa devolução não seria avisado de nada — e
// esse pagamento É DESCARTADO na emissão. Isso não é opinião desta tela, é o
// que o emissor faz, em três lugares independentes:
//   * `app/fiscal/devolucao/emissao.ts` sobrescreve `pagamentosJson` com
//     `[{meio:"SEM_PAGAMENTO", valor:0}]`;
//   * `nfe-xml-builder-sefaz.service.ts` monta o `<pag>` da devolução com esse
//     mesmo literal, ignorando o que está no rascunho;
//   * `decorarFocusDevolucao` troca `formas_pagamento` por
//     `[{forma_pagamento:"90", valor_pagamento:"0.00"}]`.
// E `app/fiscal/devolucao/validacao.ts` já emite o AVISO `PAGAMENTO_SERA_90`
// ("será enviado 'Sem pagamento' (tPag 90, Rejeição 871)") — só que lá atrás, no
// servidor, onde ela não lê.
//
// Por isso, na devolução, o quadro TROCA DE ASSUNTO em vez de sumir:
//   * pagamento zerado (o normal) ⇒ nenhum quadro. Silêncio é a verdade.
//   * pagamento lançado           ⇒ quadro dizendo que ele NÃO vai na nota e
//                                   que isso NÃO impede a emissão.
// Assim a regra não mente em nenhum dos dois sentidos: não inventa divergência
// onde ela é o estado normal, nem cala sobre dinheiro que vai ser jogado fora.
//
// ⚠️ A regra numérica da nota NORMAL não foi tocada: continua sendo, letra por
// letra, `Math.abs(totalProdutos + valorFrete - totalPagamentos) > 0.01`.
// Desligar o alarme da venda é a regressão óbvia desta mudança, e o critério
// aqui é a FINALIDADE da nota — nada mais.
//
// Modulo PURO: sem React, sem fetch, sem DOM.

import { ehDevolucao } from "./nfe-aviso-emissao";

/** Linha da etapa "Pagamentos" do formulario, do jeito que o form a entrega. */
export interface LinhaPagamento {
  meio?: string | null;
  valor?: unknown;
}

export interface EntradaConferenciaValores {
  /** Finalidade do rascunho. So "DEVOLUCAO" muda a regra. */
  finalidade?: string | null;
  totalProdutos: number;
  /**
   * Frete JA com o kill-switch aplicado pela tela (0 quando
   * NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED esta desligado). Entra no total da
   * nota pela regra W16.
   */
  totalFrete?: number;
  pagamentos?: ReadonlyArray<LinhaPagamento | null | undefined> | null;
}

export type MotivoConferencia = "SEM_ALERTA" | "DIVERGENCIA" | "PAGAMENTO_NAO_VAI";

export interface ConferenciaValores {
  motivo: MotivoConferencia;
  /** `false` ⇒ a tela não desenha quadro nenhum. */
  mostrar: boolean;
  titulo: string;
  linhas: string[];
  /** Soma dos pagamentos lançados, para a tela não somar duas vezes. */
  totalPagamentos: number;
  /** |produtos + frete − pagamentos|, sempre — inclusive quando não há quadro. */
  diferenca: number;
}

/**
 * Tolerancia historica desta tela: ate um centavo de diferenca nao vira quadro.
 * Mantida IDENTICA (`> 0.01`, sem arredondar antes) de proposito — mexer nela
 * mudaria o comportamento da nota de VENDA, que esta fora do escopo aqui.
 */
export const TOLERANCIA_DIVERGENCIA = 0.01;

/** Rotulo exato do meio na etapa "Pagamentos" (ver `nfe-defaults.ts`). */
const ROTULO_SEM_PAGAMENTO = "Sem Pagamento";

// Mesmo formato do `formatToBRL` de `components/ui/currency-input` ("1.234,56"),
// reescrito aqui so para este modulo continuar puro (aquele mora num .tsx).
const BRL = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function brl(valor: number): string {
  return `R$ ${BRL.format(Number.isFinite(valor) ? valor : 0)}`;
}

/**
 * Soma os pagamentos lancados. Mesma aritmetica que a tela ja fazia
 * (`Number(p.valor) || 0`), exportada para que o total exibido e o total
 * conferido nao possam divergir entre si.
 */
export function somarPagamentos(
  pagamentos?: ReadonlyArray<LinhaPagamento | null | undefined> | null,
): number {
  return (pagamentos ?? []).reduce<number>(
    (soma, p) => soma + (Number(p?.valor) || 0),
    0,
  );
}

/** Em centavos: evita que 0,1 + 0,2 responda "tem dinheiro aqui". */
function temValor(total: number): boolean {
  return Number.isFinite(total) && Math.round(total * 100) !== 0;
}

/**
 * `true` quando a devolucao leva pagamento que a emissao vai DESCARTAR. Espelha
 * o criterio do servidor (`validacao.ts`: qualquer meio != SEM_PAGAMENTO) e
 * ainda pega o caso em que o meio esta certo mas sobrou valor.
 */
export function pagamentoSeraDescartado(
  pagamentos?: ReadonlyArray<LinhaPagamento | null | undefined> | null,
): boolean {
  const linhas = pagamentos ?? [];
  const meioDiferente = linhas.some(
    (p) => p != null && typeof p.meio === "string" && p.meio !== "SEM_PAGAMENTO",
  );
  return meioDiferente || temValor(somarPagamentos(linhas));
}

const SEM_ALERTA = (totalPagamentos: number, diferenca: number): ConferenciaValores => ({
  motivo: "SEM_ALERTA",
  mostrar: false,
  titulo: "",
  linhas: [],
  totalPagamentos,
  diferenca,
});

/**
 * Decide o quadro de conferencia do passo "Finalizar". Sem estado, sem rede: so
 * o que a tela ja tem em maos via `getValues()`.
 */
export function conferirValores(entrada: EntradaConferenciaValores): ConferenciaValores {
  const totalProdutos = Number(entrada.totalProdutos) || 0;
  const totalFrete = Number(entrada.totalFrete) || 0;
  const totalPagamentos = somarPagamentos(entrada.pagamentos);
  // Letra por letra a conta que a tela sempre fez.
  const diferenca = Math.abs(totalProdutos + totalFrete - totalPagamentos);

  if (ehDevolucao(entrada.finalidade)) {
    // Devolucao nao tem pagamento: a "divergencia" aqui e o estado normal e
    // dizer o contrario foi o dia inteiro perdido da DLS.
    if (!pagamentoSeraDescartado(entrada.pagamentos)) {
      return SEM_ALERTA(totalPagamentos, diferenca);
    }
    return {
      motivo: "PAGAMENTO_NAO_VAI",
      mostrar: true,
      titulo: "O pagamento lançado não vai nesta devolução",
      linhas: [
        `Devolução não leva forma de pagamento: o Dexo envia "${ROTULO_SEM_PAGAMENTO}" (tPag 90) e R$ 0,00, que é como a SEFAZ aceita.`,
        `O que está lançado aqui (${brl(totalPagamentos)}) não será enviado. Isso não impede a emissão.`,
        `Para tirar este aviso, deixe a etapa Pagamentos com "${ROTULO_SEM_PAGAMENTO}" e valor zero.`,
      ],
      totalPagamentos,
      diferenca,
    };
  }

  if (diferenca > TOLERANCIA_DIVERGENCIA) {
    // Com frete na conta, citar so o total dos produtos faria o quadro mostrar
    // dois numeros IGUAIS e afirmar que diferem (produtos 100 + frete 20 vs
    // pagamentos 100: "Total dos produtos (R$ 100,00) difere do total dos
    // pagamentos (R$ 100,00). Diferença: R$ 20,00"). Sem frete, a frase é a de
    // sempre — palavra por palavra.
    const abertura =
      totalFrete > 0
        ? `Total da nota (produtos ${brl(totalProdutos)} + frete ${brl(totalFrete)} = ${brl(
            totalProdutos + totalFrete,
          )}) difere do total dos pagamentos (${brl(totalPagamentos)}).`
        : `Total dos produtos (${brl(totalProdutos)}) difere do total dos pagamentos (${brl(
            totalPagamentos,
          )}).`;
    return {
      motivo: "DIVERGENCIA",
      mostrar: true,
      titulo: "Divergência nos valores",
      linhas: [
        `${abertura} Diferença: ${brl(diferenca)}.`,
        "Volte na etapa Pagamentos e confira: o total lançado ali precisa fechar com o total da nota.",
      ],
      totalPagamentos,
      diferenca,
    };
  }

  return SEM_ALERTA(totalPagamentos, diferenca);
}
