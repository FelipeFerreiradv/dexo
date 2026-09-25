/**
 * Saldo devolvível por item da nota ORIGINAL (chave + det@nItem).
 *
 * Regras (plano §6.2):
 *   AUTHORIZED                    → devolvidaAutorizada  (consome)
 *   VALIDATING | SIGNING | SENDING → emProcessamento     (reserva — consome)
 *   DRAFT | REJECTED              → emRascunho           (só informa)
 *   CANCELLED | INUTILIZED        → ignorado
 *   status desconhecido           → emProcessamento (conservador: nunca libera saldo)
 *   disponivel = max(0, original − autorizada − emProcessamento)
 *
 * Aritmética em inteiros de 1/10000 (qCom tem 4 casas): 0,1 + 0,2 = 0,3 exato.
 * O valor autoritativo é recalculado pelo repositório sob advisory lock na
 * transação da reserva; este módulo só faz a conta.
 *
 * Módulo PURO — seguro para backend, testes e client.
 */

import { normalizarChaveAcesso } from "../domain/chave-acesso-dv";
import type { DevolucaoIssue, EscopoDevolucao, SaldoItemOriginal } from "./tipos";

export const ESCALA_QUANTIDADE = 10_000;

const DECIMAL_TEXTO = /^\s*(-?)(\d+)(?:\.(\d*))?\s*$/;

function arredondarMeioParaCima(n: number): number {
  const sinal = n < 0 ? -1 : 1;
  return sinal * Math.floor(Math.abs(n) + 0.5);
}

/**
 * Quantidade → inteiro de 1/10000 (arredondamento meio-para-cima na 5ª casa).
 * Aceita number finito ou texto decimal ("1.0001", vindo de `numeric::text`).
 * `null` para qualquer outra coisa (NaN, "", "1,5", objeto).
 */
export function quantidadeParaUnidades(valor: unknown): number | null {
  let unidades: number;
  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) return null;
    // toFixed(6) absorve o erro binário (1.0001 * 1e4 = 10000.999999999998).
    unidades = arredondarMeioParaCima(Number((valor * ESCALA_QUANTIDADE).toFixed(6)));
  } else if (typeof valor === "string") {
    const m = DECIMAL_TEXTO.exec(valor);
    if (!m) return null;
    const frac = (m[3] ?? "").padEnd(5, "0");
    let abs = Number(m[2]) * ESCALA_QUANTIDADE + Number(frac.slice(0, 4));
    if (Number(frac[4]) >= 5) abs += 1;
    unidades = m[1] === "-" ? -abs : abs;
  } else {
    return null;
  }
  return Number.isSafeInteger(unidades) ? unidades : null;
}

export function unidadesParaQuantidade(unidades: number): number {
  return unidades / ESCALA_QUANTIDADE;
}

/** true ⇔ número/texto decimal com no máximo 4 casas (qCom da NF-e). */
export function temAteQuatroCasas(valor: unknown): boolean {
  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) return false;
    const escalado = valor * ESCALA_QUANTIDADE;
    return Math.abs(escalado - Math.round(escalado)) < 1e-6;
  }
  if (typeof valor === "string") {
    const m = DECIMAL_TEXTO.exec(valor);
    if (!m) return false;
    return (m[3] ?? "").replace(/0+$/, "").length <= 4;
  }
  return false;
}

export type BaldeSaldo = "AUTORIZADA" | "EM_PROCESSAMENTO" | "RASCUNHO" | "IGNORADA";

export function baldeDoStatus(status: string): BaldeSaldo {
  switch (status) {
    case "AUTHORIZED":
      return "AUTORIZADA";
    case "VALIDATING":
    case "SIGNING":
    case "SENDING":
      return "EM_PROCESSAMENTO";
    case "DRAFT":
    case "REJECTED":
      return "RASCUNHO";
    case "CANCELLED":
    case "INUTILIZED":
      return "IGNORADA";
    default:
      return "EM_PROCESSAMENTO";
  }
}

export interface ItemOriginalParaSaldo {
  nItem: number;
  /** qCom do XML autorizado; null = original sem XML. */
  quantidade: number | string | null;
}

/** Uma linha de NfeDevolucaoItem já juntada com o status da nota de devolução. */
export interface LinhaSaldoDevolucao {
  chave: string;
  nItem: number;
  quantidade: number | string;
  statusDevolucao: string;
  devolucaoNfeId: string;
  /**
   * qCom da original gravado NESTA devolução (`NfeDevolucaoItem.quantidadeOriginal`,
   * `numeric::text`); null = a devolução não sabia. Opcional: leitor antigo não traz.
   */
  quantidadeOriginal?: number | string | null;
  /** `NfeDevolucao.fonte` da devolução desta linha (DEXO | XML_IMPORTADO | MANUAL). */
  fonteDevolucao?: string | null;
  /** nº e série da NF-e de devolução (nº negativo = rascunho, não é número fiscal). */
  numeroDevolucao?: number | null;
  serieDevolucao?: number | null;
  /** Quando a devolução desta linha foi criada. */
  criadaEm?: Date | string | null;
}

/**
 * Só estas fontes montam a devolução a partir do XML AUTORIZADO da original — a
 * quantidade original que gravaram é o qCom da SEFAZ. A fonte MANUAL é número
 * digitado à mão e nunca serve de régua de saldo para outra devolução.
 */
const FONTES_QUANTIDADE_DO_XML: ReadonlySet<string> = new Set(["DEXO", "XML_IMPORTADO"]);

/**
 * A quantidade do item (chave, nItem) na nota ORIGINAL que o livro de devoluções
 * já conhece — vinda de uma devolução montada do XML autorizado. `null` = nenhuma
 * devolução confiável desse item gravou a quantidade.
 *
 * É o que impede a devolução pela CHAVE (sem XML) de devolver de novo uma peça que
 * outra devolução, feita do XML, já devolveu: sem a quantidade original o saldo
 * saía "não verificável" mesmo com o livro sabendo quanto a nota vendeu.
 */
export function quantidadeOriginalDoLivro(
  linhas: readonly LinhaSaldoDevolucao[],
  chave: string,
  nItem: number,
): number | null {
  const alvo = normalizarChaveAcesso(chave);
  let maior: number | null = null;
  for (const l of linhas) {
    if (l.nItem !== nItem || !FONTES_QUANTIDADE_DO_XML.has(l.fonteDevolucao ?? "")) continue;
    if (normalizarChaveAcesso(l.chave) !== alvo) continue;
    const u =
      l.quantidadeOriginal === null || l.quantidadeOriginal === undefined
        ? null
        : quantidadeParaUnidades(l.quantidadeOriginal);
    if (u === null || u <= 0) continue;
    if (maior === null || u > maior) maior = u;
  }
  return maior === null ? null : unidadesParaQuantidade(maior);
}

/**
 * `itensOriginais` para `calcularSaldoPorItem`: a quantidade do snapshot da
 * devolução; quando ela é desconhecida (0/null — devolução pela chave sem a
 * quantidade da nota), a que o livro conhece (`quantidadeOriginalDoLivro`).
 */
export function itensOriginaisComLivro(
  itens: ReadonlyArray<{ nItem: number; quantidade: number | string | null }>,
  linhas: readonly LinhaSaldoDevolucao[],
  chave: string,
): ItemOriginalParaSaldo[] {
  return itens.map((i) => {
    const u = i.quantidade === null || i.quantidade === undefined ? null : quantidadeParaUnidades(i.quantidade);
    return {
      nItem: i.nItem,
      quantidade: u !== null && u > 0 ? i.quantidade : quantidadeOriginalDoLivro(linhas, chave, i.nItem),
    };
  });
}

export interface CalcularSaldoInput {
  itensOriginais: ItemOriginalParaSaldo[];
  linhas: LinhaSaldoDevolucao[];
  /** Exclui as linhas desta devolução (validar a própria nota contra o resto). */
  excluirDevolucaoNfeId?: string | null;
  /** Quando informada, considera só linhas desta chave (aceita prefixo "NFe"). */
  chave?: string | null;
}

/** Saldo por nItem, na ordem de `itensOriginais` (nItem repetido: vale o primeiro). */
export function calcularSaldoPorItem(input: CalcularSaldoInput): SaldoItemOriginal[] {
  const chaveFiltro =
    input.chave !== undefined && input.chave !== null
      ? normalizarChaveAcesso(input.chave)
      : undefined;

  const acumulado = new Map<number, { aut: number; proc: number; rasc: number }>();
  for (const l of input.linhas) {
    if (input.excluirDevolucaoNfeId && l.devolucaoNfeId === input.excluirDevolucaoNfeId) continue;
    if (chaveFiltro !== undefined && normalizarChaveAcesso(l.chave) !== chaveFiltro) continue;
    const balde = baldeDoStatus(l.statusDevolucao);
    if (balde === "IGNORADA") continue;
    // Quantidade ilegível numa linha persistida (Decimal) não acontece; se
    // acontecer, não é somada — o recálculo sob lock no repositório é a guarda.
    const u = quantidadeParaUnidades(l.quantidade) ?? 0;
    const acc = acumulado.get(l.nItem) ?? { aut: 0, proc: 0, rasc: 0 };
    if (balde === "AUTORIZADA") acc.aut += u;
    else if (balde === "EM_PROCESSAMENTO") acc.proc += u;
    else acc.rasc += u;
    acumulado.set(l.nItem, acc);
  }

  const vistos = new Set<number>();
  const saida: SaldoItemOriginal[] = [];
  for (const it of input.itensOriginais) {
    if (vistos.has(it.nItem)) continue;
    vistos.add(it.nItem);
    const acc = acumulado.get(it.nItem) ?? { aut: 0, proc: 0, rasc: 0 };
    const original =
      it.quantidade === null || it.quantidade === undefined
        ? null
        : quantidadeParaUnidades(it.quantidade);
    saida.push({
      nItem: it.nItem,
      quantidadeOriginal: original === null ? null : unidadesParaQuantidade(original),
      devolvidaAutorizada: unidadesParaQuantidade(acc.aut),
      emProcessamento: unidadesParaQuantidade(acc.proc),
      emRascunho: unidadesParaQuantidade(acc.rasc),
      disponivel:
        original === null
          ? null
          : unidadesParaQuantidade(Math.max(0, original - acc.aut - acc.proc)),
    });
  }
  return saida;
}

/** Todos os itens com saldo conhecido e zerado (lista vazia ⇒ false). */
export function isTotalmenteDevolvida(saldos: readonly SaldoItemOriginal[]): boolean {
  return saldos.length > 0 && saldos.every((s) => s.disponivel === 0);
}

/** Algum item já teve devolução autorizada ou em processamento. */
export function temDevolucaoConsumindo(saldos: readonly SaldoItemOriginal[]): boolean {
  return saldos.some((s) => s.devolvidaAutorizada > 0 || s.emProcessamento > 0);
}

/**
 * O escopo que a lista de itens DE FATO devolve — derivado, nunca pedido.
 *
 * TOTAL = a nota original inteira: todo item com quantidade original conhecida,
 * nada dele devolvido ou em envio por OUTRA devolução, e esta devolvendo a
 * quantidade cheia de cada um. Qualquer outra coisa é PARCIAL — inclusive item
 * sem quantidade original (devolução pela chave): sem ela não há como provar que
 * a devolução é total. É a mesma leitura de `montarRascunhoDeOriginal`, que
 * recusa "total" numa nota já parcialmente devolvida.
 *
 * Existe porque o escopo era um seletor LIVRE com uma trava de igualdade: marcado
 * "Total", devolver MENOS peças voltava "Quantidade maior que o saldo disponível"
 * (DLS, 24/09, rascunho 36730421: três recusas em 12 minutos). O escopo não vai
 * ao XML — não há campo total/parcial na NF-e —, então ele só descreve.
 */
export function escopoDaDevolucao(e: {
  saldos: ReadonlyArray<SaldoItemOriginal & { chaveAcesso?: string | null }>;
  itens: ReadonlyArray<{ chaveAcesso?: string | null; nItem: number; quantidade: number | string }>;
}): EscopoDevolucao {
  if (e.saldos.length === 0) return "PARCIAL";
  const mesmaChave = (a?: string | null, b?: string | null) =>
    !a || !b || normalizarChaveAcesso(a) === normalizarChaveAcesso(b);
  const total = e.saldos.every((s) => {
    const original = s.quantidadeOriginal === null ? null : quantidadeParaUnidades(s.quantidadeOriginal);
    if (original === null || original <= 0) return false;
    const disponivel = s.disponivel === null ? null : quantidadeParaUnidades(s.disponivel);
    if (disponivel !== original) return false;
    const item = e.itens.find((i) => i.nItem === s.nItem && mesmaChave(i.chaveAcesso, s.chaveAcesso));
    return !!item && quantidadeParaUnidades(item.quantidade) === original;
  });
  return total ? "TOTAL" : "PARCIAL";
}

function quantidadeBR(q: number): string {
  return String(q).replace(".", ",");
}

/**
 * A recusa de saldo de UM item, com o que dá para agir: qual peça, quanto ela
 * pediu, quanto ainda pode ser devolvido e onde está o resto. Antes a tela
 * recebia só "Quantidade maior que o saldo disponível para devolução.", sem item
 * nem número.
 *
 * `ordem` é o item como a tela o mostra; o código e o nº do item na nota
 * original vão no texto, porque a ordem muda quando um item sai da lista.
 */
export function issueSaldoExcedido(e: {
  ordem: number;
  nItemOriginal: number;
  codigo: string;
  pedida: number;
  /** Saldo do item; `disponivel: null` = só se conhece a quantidade original. */
  saldo: Pick<SaldoItemOriginal, "disponivel" | "devolvidaAutorizada" | "emProcessamento"> | null;
  /** Quantidade da nota original, quando o saldo não é conhecido. */
  quantidadeOriginal?: number | null;
}): DevolucaoIssue {
  const peca = `Item ${e.ordem}: ${e.codigo} (item ${e.nItemOriginal} da nota original)`;
  const partes: string[] = [];
  if (e.saldo && e.saldo.devolvidaAutorizada > 0) {
    partes.push(`${quantidadeBR(e.saldo.devolvidaAutorizada)} já devolvido em NF-e autorizada`);
  }
  if (e.saldo && e.saldo.emProcessamento > 0) {
    partes.push(`${quantidadeBR(e.saldo.emProcessamento)} numa devolução em envio à SEFAZ`);
  }
  const porque = partes.length > 0 ? ` (${partes.join("; ")})` : "";
  const disponivel = e.saldo?.disponivel ?? null;
  let mensagem: string;
  if (disponivel !== null && disponivel <= 0) {
    mensagem = `${peca}: este item não tem mais saldo para devolver${porque}. Tire o item desta devolução.`;
  } else if (disponivel !== null) {
    mensagem =
      `${peca}: a quantidade ${quantidadeBR(e.pedida)} passa do que ainda pode ser devolvido, ` +
      `que é ${quantidadeBR(disponivel)}${porque}.`;
  } else {
    mensagem =
      `${peca}: a quantidade ${quantidadeBR(e.pedida)} passa da quantidade da nota original, ` +
      `que é ${quantidadeBR(e.quantidadeOriginal ?? 0)}.`;
  }
  return { code: "SALDO_EXCEDIDO", severidade: "ERRO", ordem: e.ordem, mensagem };
}
