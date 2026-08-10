// Propor, confirmar e cancelar uma escrita do Bitz. Fase 9.
//
// ⭐ O DESENHO EM UMA LINHA: a tool PROPÕE, o clique EXECUTA, e o que é
// executado sai do banco — nunca do que o navegador devolveu.
//
// Por que isso importa mais do que parece: se o `payload` viajasse até o
// navegador e voltasse no clique, a rota de confirmação seria uma rota de
// escrita genérica com o nome de confirmação. Um `curl` mandaria
// `{ produtoId: "...", preco: 1 }` e o servidor obedeceria, porque "o usuário
// confirmou". Guardando a proposta, o cliente só devolve um ID — e ID de
// proposta de outra pessoa não resolve.

import prisma from "../../lib/prisma";
import { auditAiAction } from "../audit/ai-audit";
import type { AiScope } from "../core/scope";
import {
  mensagemDeFalhaDeAcao,
  PROPOSTA_VALIDA_POR_MS,
  type AiAcaoFalha,
  type AiAcaoPreview,
  type AiAcaoProposta,
  type AiAcaoResultado,
  type AiAcaoTipo,
} from "./acao.types";
import { executarAcao } from "./executores";

/**
 * Grava a proposta e devolve o que o cartão precisa.
 *
 * ⚠️ NÃO ESCREVE NADA DE NEGÓCIO. A única linha criada aqui é a da própria
 * proposta; produto, cliente e preço continuam exatamente como estavam.
 */
export async function proporAcao(input: {
  scope: AiScope;
  tipo: AiAcaoTipo;
  /** Os campos JÁ VALIDADOS, com o alvo resolvido dentro do tenant. */
  payload: Record<string, unknown>;
  preview: AiAcaoPreview;
  conversationId?: string;
  db?: any;
  now?: Date;
}): Promise<AiAcaoProposta> {
  const db = input.db ?? (prisma as any);
  const agora = input.now ?? new Date();
  const expiresAt = new Date(agora.getTime() + PROPOSTA_VALIDA_POR_MS);

  // ⭐ A PROPOSTA NOVA APOSENTA A ANTERIOR DO MESMO TIPO, na mesma conversa.
  //
  // ⚠️ Conserto de um achado da revisão, e o cenário é banal: o lojista pede
  // "cadastra o coxim, R$ 90", relê e corrige — "errei, é R$ 190". Nasce o
  // cartão B, ele confirma B. Depois rola a conversa para cima, vê o cartão A
  // ainda com o botão ativo, acha que esqueceu de confirmar, e clica: SEGUNDO
  // produto criado, com o preço errado. Duas propostas vivas para a mesma coisa
  // são uma armadilha, não uma comodidade.
  //
  // Escopado por conversa E por ator: a proposta de um colaborador não encosta
  // na de outro.
  if (input.conversationId) {
    await db.aiAction.updateMany({
      where: {
        conversationId: input.conversationId,
        dataOwnerId: input.scope.dataOwnerId,
        actorUserId: input.scope.actorId,
        action: input.tipo,
        status: "pendente",
      },
      data: {
        status: "cancelada",
        errorCode: "substituida",
        decidedAt: agora,
      },
    });
  }

  const linha = await db.aiAction.create({
    data: {
      dataOwnerId: input.scope.dataOwnerId,
      actorUserId: input.scope.actorId,
      conversationId: input.conversationId ?? null,
      action: input.tipo,
      status: "pendente",
      payload: input.payload as any,
      preview: input.preview as any,
      expiresAt,
    },
    select: { id: true },
  });

  return {
    id: linha.id,
    tipo: input.tipo,
    preview: input.preview,
    expiraEm: expiresAt.toISOString(),
  };
}

/**
 * ⭐ CONFIRMA E EXECUTA — e a ordem das travas aqui é o coração da segurança.
 *
 *  1. A busca é escopada por `(id, dataOwnerId, actorUserId)`. Id de outra
 *     pessoa simplesmente NÃO RESOLVE — não é 403, é "não encontrada", para não
 *     confirmar a existência de um id alheio (mesma regra de idor-isolation).
 *  2. Validade: proposta vencida não executa.
 *  3. ⭐ REIVINDICAÇÃO ATÔMICA. `updateMany where status = "pendente"` devolve
 *     `count: 1` para exatamente UM chamador — clique duplo, retry de rede ou
 *     duas abas executam UMA vez. O segundo lê a linha e devolve o que já foi
 *     feito, em vez de fazer de novo.
 *  4. Só então executa. Se o usecase lançar, a linha vira `falhou` com o motivo,
 *     e a proposta NÃO volta a ser pendente: reexecutar por conta própria uma
 *     escrita que pode ter aplicado metade é pior que pedir de novo.
 *
 * A permissão NÃO é conferida aqui: quem confere é a rota, com o `scope` da
 * requisição, ANTES de chamar. Repetir a checagem aqui daria a impressão de que
 * esta função é segura sozinha — e ela recebe o scope já pronto.
 */
export async function confirmarAcao(input: {
  id: string;
  scope: AiScope;
  db?: any;
  now?: Date;
}): Promise<AiAcaoResultado> {
  const db = input.db ?? (prisma as any);
  const agora = input.now ?? new Date();
  const { scope } = input;

  const linha = await db.aiAction.findFirst({
    where: {
      id: input.id,
      dataOwnerId: scope.dataOwnerId,
      actorUserId: scope.actorId,
    },
  });
  if (!linha) return falha("nao_encontrada");

  // Clique duplo que chegou DEPOIS da primeira execução: não é erro, e não pode
  // virar mensagem de erro na cara de quem só clicou rápido.
  if (linha.status === "confirmada") {
    return {
      ok: true,
      status: "confirmada",
      resultId: linha.resultId ?? null,
      jaEstava: true,
    };
  }
  // Outro clique reivindicou e ainda está executando. Não é erro de ninguém, e
  // dizer "já foi decidida" deixaria o lojista sem saber se deu certo.
  if (linha.status === "executando") return falha("em_andamento");
  if (linha.status !== "pendente") return falha("ja_decidida");

  if (new Date(linha.expiresAt).getTime() <= agora.getTime()) {
    // Marca para o cartão parar de oferecer o botão, mas sem virar "falhou":
    // expirar não é erro de ninguém.
    await db.aiAction.updateMany({
      where: { id: linha.id, status: "pendente" },
      data: { status: "cancelada", errorCode: "expirada", decidedAt: agora },
    });
    return falha("expirada");
  }

  // ⭐ A REIVINDICAÇÃO. Daqui para baixo, só um chamador passa.
  //
  // ⚠️ O ESTADO INTERMEDIÁRIO É "executando", NÃO "confirmada" — e isso foi
  // conserto de um achado da revisão. Marcar "confirmada" ANTES de executar
  // torna indistinguíveis dois estados muito diferentes: "executou e deu certo"
  // e "o processo morreu no meio" (pm2 reload, OOM). O segundo ficaria parecendo
  // sucesso para sempre, e o retry responderia "Feito." sobre uma escrita que
  // nunca aconteceu.
  //
  // Com um estado próprio, uma linha presa em "executando" é um sinal — dá para
  // achá-la, dá para investigar, e ela nunca mente dizendo que deu certo.
  const { count } = await db.aiAction.updateMany({
    where: { id: linha.id, status: "pendente" },
    data: { status: "executando", decidedAt: agora },
  });
  if (count === 0) {
    // Alguém reivindicou entre a leitura e o update. Devolve o que ficou.
    const atual = await db.aiAction.findFirst({
      where: { id: linha.id },
      select: { status: true, resultId: true },
    });
    if (atual?.status === "confirmada") {
      return {
        ok: true,
        status: "confirmada",
        resultId: atual.resultId ?? null,
        jaEstava: true,
      };
    }
    return falha(atual?.status === "executando" ? "em_andamento" : "ja_decidida");
  }

  let resultId: string | null = null;
  try {
    ({ resultId } = await executarAcao(
      linha.action as AiAcaoTipo,
      linha.payload,
      scope,
    ));
  } catch (error) {
    // ⚠️ Fica `falhou` e NÃO volta a `pendente`. Uma escrita que estourou no
    // meio pode ter aplicado parte; reoferecer o botão convidaria a aplicar a
    // outra metade duas vezes. O caminho de volta é pedir de novo ao Bitz, que
    // relê o estado atual.
    //
    // O `catch` aqui é best-effort: se o próprio banco estiver fora, não há
    // como registrar — mas isso não pode virar uma exceção que o handler global
    // transforma em 500 sem nenhum registro.
    await marcar(db, linha.id, {
      status: "falhou",
      errorCode: curtinho(error),
      decidedAt: agora,
    });

    auditAiAction({
      dataOwnerId: scope.dataOwnerId,
      actorUserId: scope.actorId,
      conversationId: linha.conversationId ?? undefined,
      acaoId: linha.id,
      tipo: linha.action,
      status: "falhou",
      erro: curtinho(error),
    });

    return falha("erro_execucao");
  }

  // ⭐⭐ DAQUI PARA BAIXO A ESCRITA JÁ ACONTECEU, E NADA PODE DIZER O CONTRÁRIO.
  //
  // ⚠️ ISTO JÁ ESTAVA ERRADO, e era o achado mais grave da revisão: o `update`
  // que grava o `resultId` morava DENTRO do mesmo `try` da execução. Se o
  // preço já tivesse ido para o Mercado Livre e o pool do Prisma estourasse na
  // linha seguinte (P2024, incidente conhecido deste repositório), o `catch`
  // marcava a ação como "falhou", gravava isso no `SystemLog` e respondia ao
  // lojista **"Nada foi alterado"** — com o anúncio já alterado. A única trilha
  // que existe registrava o oposto do que tinha acontecido.
  //
  // Agora a escrita de CONTROLE é best-effort e separada: falhar em anotar o
  // resultado não pode reescrever a história de uma escrita irreversível.
  await marcar(db, linha.id, { status: "confirmada", resultId });

  auditAiAction({
    dataOwnerId: scope.dataOwnerId,
    actorUserId: scope.actorId,
    conversationId: linha.conversationId ?? undefined,
    acaoId: linha.id,
    tipo: linha.action,
    status: "confirmada",
    resultId: resultId ?? undefined,
  });

  return { ok: true, status: "confirmada", resultId, jaEstava: false };
}

/**
 * Escrita de CONTROLE, best-effort.
 *
 * Nunca lança: uma falha ao anotar o estado não pode virar uma exceção que o
 * handler global transforma em 500 — e muito menos depois de a escrita de
 * negócio já ter acontecido.
 */
async function marcar(db: any, id: string, data: Record<string, unknown>) {
  try {
    await db.aiAction.update({ where: { id }, data });
  } catch (err) {
    console.error(`[bitz-acao] não consegui anotar o estado de ${id}:`, err);
  }
}

/** Cancela uma proposta pendente. Idempotente e sem efeito de negócio. */
export async function cancelarAcao(input: {
  id: string;
  scope: AiScope;
  db?: any;
  now?: Date;
}): Promise<AiAcaoResultado> {
  const db = input.db ?? (prisma as any);
  const agora = input.now ?? new Date();
  const { scope } = input;

  const { count } = await db.aiAction.updateMany({
    where: {
      id: input.id,
      dataOwnerId: scope.dataOwnerId,
      actorUserId: scope.actorId,
      status: "pendente",
    },
    data: { status: "cancelada", decidedAt: agora },
  });

  if (count === 0) {
    // Já cancelada, já confirmada, ou de outra pessoa. Nos três casos não há o
    // que fazer, e o cartão só precisa parar de oferecer os botões.
    return falha("ja_decidida");
  }

  return { ok: true, status: "cancelada", resultId: null, jaEstava: false };
}

function falha(motivo: AiAcaoFalha): AiAcaoResultado {
  return { ok: false, motivo, mensagem: mensagemDeFalhaDeAcao(motivo) };
}

/** Detalhe curto e sem segredo, para a coluna de erro. */
function curtinho(error: unknown): string {
  const bruto = error instanceof Error ? error.message : String(error ?? "erro");
  return bruto.replace(/\s+/g, " ").trim().slice(0, 180);
}
