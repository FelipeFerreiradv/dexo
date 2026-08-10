// Leitura, escrita e formatação da memória da loja. Fase 11.
//
// ⭐ TUDO AQUI É ESCOPADO POR `dataOwnerId`, sem exceção e sem sobrecarga que
// aceite omiti-lo. A memória é o único texto do agente que atravessa TODOS os
// usuários de um tenant — um vazamento aqui não seria "um dado de outra loja
// numa consulta", seria a regra de negócio de um concorrente entrando no prompt
// de todo turno de outra empresa.

import prisma from "../../lib/prisma";
import { normalizeTerm } from "../../repositories/product-search-terms";
import {
  ehTopico,
  MAX_MEMORIAS_POR_TENANT,
  type AiMemoria,
  type AiMemoriaTopico,
} from "./memoria.types";

/**
 * As memórias da loja, da mais nova para a mais velha.
 *
 * O teto é aplicado no `take`: se um dia houver mais linhas que o teto (import
 * manual, teto reduzido num deploy), o prompt continua com um tamanho previsível
 * e são as MAIS RECENTES que sobrevivem — a regra nova é a que vale.
 */
export async function listarMemorias(input: {
  dataOwnerId: string;
  db?: any;
}): Promise<AiMemoria[]> {
  const db = input.db ?? (prisma as any);

  const linhas = await db.aiMemory.findMany({
    where: { dataOwnerId: input.dataOwnerId },
    orderBy: { createdAt: "desc" },
    take: MAX_MEMORIAS_POR_TENANT,
    select: { id: true, topico: true, conteudo: true, createdAt: true },
  });

  return (Array.isArray(linhas) ? linhas : []).map((l: any) => ({
    id: String(l.id),
    // Tópico desconhecido (linha antiga, deploy revertido) cai em "geral" em vez
    // de quebrar a tela. O vocabulário é fechado na ENTRADA; na leitura, tolerar
    // é mais seguro do que lançar.
    topico: (ehTopico(l.topico) ? l.topico : "geral") as AiMemoriaTopico,
    conteudo: String(l.conteudo ?? ""),
    createdAt: l.createdAt instanceof Date ? l.createdAt : new Date(l.createdAt),
  }));
}

/** Quantas a loja já tem. Usado para o teto, antes de propor e antes de gravar. */
export async function contarMemorias(input: {
  dataOwnerId: string;
  db?: any;
}): Promise<number> {
  const db = input.db ?? (prisma as any);
  const n = await db.aiMemory.count({
    where: { dataOwnerId: input.dataOwnerId },
  });
  return typeof n === "number" ? n : 0;
}

/** Grava. Chamado SÓ pelo executor, depois do clique de confirmação. */
export async function criarMemoria(input: {
  dataOwnerId: string;
  createdByUserId: string;
  topico: AiMemoriaTopico;
  conteudo: string;
  conversationId?: string | null;
  db?: any;
}): Promise<{ id: string }> {
  const db = input.db ?? (prisma as any);
  const linha = await db.aiMemory.create({
    data: {
      dataOwnerId: input.dataOwnerId,
      createdByUserId: input.createdByUserId,
      topico: input.topico,
      conteudo: input.conteudo,
      conversationId: input.conversationId ?? null,
    },
    select: { id: true },
  });
  return { id: String(linha.id) };
}

/**
 * Apaga. `deleteMany` COM o tenant no `where` — nunca `delete` por id.
 *
 * Mesmo padrão de `idor-isolation.spec.ts`: um id de outra loja não apaga nada
 * e devolve `0`, em vez de apagar e depois descobrir que não podia.
 */
export async function apagarMemoria(input: {
  id: string;
  dataOwnerId: string;
  db?: any;
}): Promise<boolean> {
  const db = input.db ?? (prisma as any);
  const { count } = await db.aiMemory.deleteMany({
    where: { id: input.id, dataOwnerId: input.dataOwnerId },
  });
  return count > 0;
}

/**
 * O texto que entra no prompt.
 *
 * ⚠️ ESTA FUNÇÃO NÃO EMBRULHA NADA. Quem chama passa o retorno por
 * `wrapSystemData`, que é o que neutraliza o envelope. Deixar o embrulho aqui
 * dentro daria a impressão de que o conteúdo já sai seguro, e alguém acabaria
 * usando o retorno cru em outro lugar.
 */
export function formatarMemoriasParaPrompt(memorias: AiMemoria[]): string {
  return memorias.map((m) => `- ${m.conteudo}`).join("\n");
}

/**
 * Memórias parecidas com o texto que está sendo ensinado.
 *
 * ⭐ AVISO, NUNCA BLOQUEIO — e é o mesmo precedente da Fase 10 (peça homônima).
 * Substituir automaticamente seria pior do que parece: "farol: anuncio como
 * usado" e "farol de milha: anuncio como novo" dividem quase todas as palavras
 * e são regras diferentes. Trocar uma pela outra em silêncio apagaria uma regra
 * que ninguém mandou apagar.
 *
 * A comparação é por sobreposição de palavras normalizadas, com as curtas fora
 * (artigo e preposição casariam tudo com tudo).
 */
export function memoriasParecidas(
  conteudo: string,
  existentes: AiMemoria[],
  limiar = 0.5,
): AiMemoria[] {
  const alvo = palavrasDe(conteudo);
  if (alvo.size === 0) return [];

  return existentes.filter((m) => {
    const outras = palavrasDe(m.conteudo);
    if (outras.size === 0) return false;
    let comuns = 0;
    for (const p of alvo) if (outras.has(p)) comuns++;
    // Sobre o MENOR dos dois: "meu markup é 2x" contra "meu markup padrão de
    // venda é 2x, sem exceção" tem de contar como parecido.
    return comuns / Math.min(alvo.size, outras.size) >= limiar;
  });
}

function palavrasDe(texto: string): Set<string> {
  return new Set(
    normalizeTerm(texto ?? "")
      .split(/\s+/)
      .filter((p) => p.length > 3),
  );
}
