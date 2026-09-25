// O campo de QUANTIDADE do passo "Produtos" da devolução — módulo puro, testado
// em node.
//
// ── O caso real (DLS AUTO PEÇAS, 24/09/2026) ──
// `max={disponivel}` era só dica de HTML (não há <form> para o navegador
// conferir): ela digitou 10 onde o disponível era 1 e só descobriu no save. E
// `Number("") === 0`: apagar o número para redigitar e clicar "Salvar" no meio
// TIRAVA a peça da devolução em silêncio (o corpo filtra quantidade 0) — e a
// tela ainda caía logo depois (`value.itens[index]` indefinido).
//
// ── As regras deste arquivo ──
//  * Guarda-se o TEXTO digitado; o número sai daqui.
//  * Vazio NÃO é zero: é "falta informar", e bloqueia o salvar.
//  * Zero digitado é a escolha de tirar a peça — dita na tela antes de salvar.
//  * Acima do disponível bloqueia com o número certo ("no máximo X"). O
//    `disponivel` do detalhe já desconta o próprio rascunho, então o teto bate
//    com a recusa SALDO_INSUFICIENTE do servidor. Disponível nulo (nota sem
//    XML) = sem teto na tela, como no servidor.
//  * No máximo 4 casas decimais (qCom da NF-e), igual ao contrato.
//
// Módulo PURO: sem React, sem fetch, sem DOM.

import { quantidadeParaUnidades } from "@/app/fiscal/devolucao/saldo";

export type EstadoQuantidade = "OK" | "ZERO" | "VAZIA" | "INVALIDA" | "ACIMA_DO_DISPONIVEL";

export interface QuantidadeLida {
  estado: EstadoQuantidade;
  /** O número (null quando o texto não é número). */
  valor: number | null;
  /** "" quando está tudo certo. */
  mensagem: string;
  /** true ⇒ o "Salvar devolução" fica travado até ela acertar. */
  bloqueia: boolean;
}

export const QUANTIDADE_VAZIA =
  'Informe a quantidade que está voltando. Para tirar a peça desta devolução, use "Tirar desta devolução".';
export const QUANTIDADE_ZERO = "Com 0, esta peça sai da devolução quando você salvar.";
export const QUANTIDADE_CASAS = "Use no máximo 4 casas depois da vírgula.";
export const QUANTIDADE_NAO_NUMERO = "Use só números, por exemplo 1 ou 2,5.";

/** 2.5 → "2,5" (como ela lê e digita). */
export function formatarQuantidade(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  return String(n).replace(".", ",");
}

const QUANTIDADE_MAX = 999_999_999;

export function lerQuantidadeDevolucao(texto: string | null | undefined, disponivel: number | null | undefined): QuantidadeLida {
  const t = (texto ?? "").trim().replace(",", ".");
  if (t === "") return { estado: "VAZIA", valor: null, mensagem: QUANTIDADE_VAZIA, bloqueia: true };
  if (/^\d+\.\d{5,}$/.test(t)) return { estado: "INVALIDA", valor: null, mensagem: QUANTIDADE_CASAS, bloqueia: true };
  if (!/^\d+(\.\d{1,4})?$/.test(t)) return { estado: "INVALIDA", valor: null, mensagem: QUANTIDADE_NAO_NUMERO, bloqueia: true };
  const valor = Number(t);
  if (!Number.isFinite(valor) || valor > QUANTIDADE_MAX) {
    return { estado: "INVALIDA", valor: null, mensagem: QUANTIDADE_NAO_NUMERO, bloqueia: true };
  }
  if (valor === 0) return { estado: "ZERO", valor: 0, mensagem: QUANTIDADE_ZERO, bloqueia: false };
  if (typeof disponivel === "number" && Number.isFinite(disponivel)) {
    // Em unidades de 1/10000, como o servidor: sem erro binário na comparação.
    const q = quantidadeParaUnidades(t);
    const d = quantidadeParaUnidades(disponivel);
    if (q !== null && d !== null && q > d) {
      return {
        estado: "ACIMA_DO_DISPONIVEL",
        valor,
        mensagem:
          d === 0
            ? "Esta peça não tem mais nada para devolver: o disponível é 0. Tire-a desta devolução."
            : `No máximo ${formatarQuantidade(disponivel)}: é o que ainda pode ser devolvido desta peça.`,
        bloqueia: true,
      };
    }
  }
  return { estado: "OK", valor, mensagem: "", bloqueia: false };
}
