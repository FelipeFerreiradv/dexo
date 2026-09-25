// O campo de CFOP do passo "Produtos" da devolução: SELETOR com os CFOPs que o
// servidor aceita, cada um com o nome da operação — módulo puro, testado em node.
//
// ── O caso real (DLS AUTO PEÇAS, 24/09/2026) ──
// Cada peça mostrava "CFOP original: 5102" ao lado de uma caixa de CFOP em
// branco. O 5102 é o CFOP de VENDA da DISAUTO. Ela copiou o 5102 e recebeu "CFOP
// inválido para esta devolução.", sem dizer qual servia; com a caixa em branco,
// "Dados da requisição inválidos."; e o `maxLength={4}` cortava o "50202" que
// ela quis digitar em "5020", também recusado. As opções certas JÁ chegavam do
// servidor (`cfopOpcoes`) e a tela as ignorava.
//
// ── As regras deste arquivo ──
//  1. "Sugeridos" = `cfopOpcoes` do servidor (o mapeamento da nota original).
//  2. "Outros CFOPs de devolução" = o RESTO do que o servidor aceita
//     (`cfopsPermitidosDevolucao` no destino da nota original). A lista de
//     sugeridos é um SUBCONJUNTO: limitar a ela esconderia código certo (o 5661
//     do óleo lubrificante da DISAUTO, antes do conserto do mapeamento).
//  3. O CFOP da nota original aparece como REFERÊNCIA, com o nome certo para o
//     tipo da devolução — nunca como valor do campo.
//  4. Os nomes vêm do catálogo oficial (`CFOP_CATALOG`), não de texto novo.
//
// Módulo PURO: sem React, sem fetch, sem DOM.

import { cfopsPermitidosDevolucao, idDestDoCfop } from "@/app/fiscal/domain/devolucao-cfop";
import { findCfop } from "@/app/fiscal/domain/cfop-catalog";
import type { CrtEmitente, IdDest, TipoDevolucao } from "@/app/fiscal/devolucao/tipos";

export const PLACEHOLDER_CFOP = "Escolha o CFOP de devolução";
export const GRUPO_SUGERIDOS = "Sugeridos para esta peça";
export const GRUPO_OUTROS = "Outros CFOPs de devolução";
export const CFOP_OBRIGATORIO = "Escolha o CFOP de devolução desta peça.";

export interface OpcaoCfop {
  codigo: string;
  rotulo: string;
}

export function rotuloCfop(codigo: string): string {
  const e = findCfop(codigo);
  return e ? `${codigo} — ${e.descricao}` : `${codigo} — CFOP de devolução`;
}

/**
 * O destino (idDest) da nota ORIGINAL. O `DevolucaoDetalhe.originais` traz o
 * snapshot da origem (com `idDest`) mesmo sem o tipo declarar o campo; sem ele,
 * o 1º dígito do primeiro CFOP sugerido diz o mesmo. `null` = não dá para saber.
 */
export function idDestDaOriginal(
  originais: ReadonlyArray<unknown> | null | undefined,
  chaveAcesso: string,
  sugeridos: readonly string[],
): IdDest | null {
  const o = (originais ?? []).find(
    (x) => !!x && typeof x === "object" && (x as { chaveAcesso?: unknown }).chaveAcesso === chaveAcesso,
  ) as { idDest?: unknown } | undefined;
  const n = Number(o?.idDest);
  if (n === 1 || n === 2 || n === 3) return n;
  for (const c of sugeridos) {
    const d = idDestDoCfop(c);
    if (d) return d;
  }
  return null;
}

/**
 * Como chamar o CFOP da nota original, pelo tipo da devolução e pelo 1º dígito:
 * na devolução de COMPRA, um 5/6/7 é a VENDA do fornecedor (não serve), e um
 * 1/2/3 é a entrada dela; na devolução de VENDA é a venda dela.
 */
export function referenciaCfopOriginal(tipo: TipoDevolucao | null | undefined, cfopOriginal: string | null | undefined): string {
  const c = (cfopOriginal ?? "").replace(/\D/g, "");
  if (c.length !== 4) return "";
  if (tipo === "VENDA_ENTRADA") return `CFOP da sua venda: ${c}.`;
  if ("567".includes(c[0])) return `CFOP de saída do fornecedor: ${c}. É a venda dele e não serve na devolução — escolha abaixo o de devolução.`;
  return `CFOP da sua entrada: ${c}.`;
}

export interface CampoCfopView {
  /** Valor do seletor: o CFOP gravado ("" quando ainda não foi escolhido). */
  valor: string;
  placeholder: string;
  sugeridos: OpcaoCfop[];
  outros: OpcaoCfop[];
  /** O gravado que não está em nenhuma das listas — entra como opção própria. */
  gravadoForaDaLista: OpcaoCfop | null;
  /** Frase do CFOP da nota original ("" quando não veio). */
  referencia: string;
}

export function campoCfop(entrada: {
  tipo: TipoDevolucao;
  crt: CrtEmitente | string | null | undefined;
  idDest: IdDest | null;
  /** `item.cfopOpcoes` do detalhe. */
  sugeridos: readonly string[] | null | undefined;
  /** O CFOP da linha agora (gravado ou escolhido nesta sessão). */
  cfop: string | null | undefined;
  cfopOriginal: string | null | undefined;
}): CampoCfopView {
  const sug = Array.from(new Set((entrada.sugeridos ?? []).filter((c) => /^\d{4}$/.test(c))));
  const permitidos = entrada.idDest
    ? cfopsPermitidosDevolucao({ tipo: entrada.tipo, idDest: entrada.idDest, crt: entrada.crt ?? null })
    : [];
  const outros = permitidos.filter((c) => !sug.includes(c));
  const valor = (entrada.cfop ?? "").trim();
  const conhecido = valor === "" || sug.includes(valor) || outros.includes(valor);
  return {
    valor,
    placeholder: PLACEHOLDER_CFOP,
    sugeridos: sug.map((codigo) => ({ codigo, rotulo: rotuloCfop(codigo) })),
    outros: outros.map((codigo) => ({ codigo, rotulo: rotuloCfop(codigo) })),
    gravadoForaDaLista: conhecido ? null : { codigo: valor, rotulo: `${valor} — o que está gravado neste item` },
    referencia: referenciaCfopOriginal(entrada.tipo, entrada.cfopOriginal),
  };
}
