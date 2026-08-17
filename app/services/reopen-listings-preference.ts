// Preferência do TENANT: reabrir o anúncio quando a peça volta ao estoque por
// CANCELAMENTO de venda. Default LIGADO = o comportamento que sempre existiu.
//
// POR QUE ISTO EXISTE
// Quem trabalha com peça USADA sofre com a reabertura automática: a venda é
// cancelada, o anúncio volta ao ar, outro comprador compra — e a peça física
// ainda não voltou ao pátio. O lojista cancela de novo, e a segunda vez custa
// reputação e métricas no marketplace. Quem trabalha com peça nova quer
// exatamente o contrário. Por isso a escolha é por conta, e não global.
//
// O QUE ELA GOVERNA, E SÓ
// Apenas a etapa de REABERTURA. Estorno de estoque, sincronização de
// quantidade, reconciliação de sucata e processamento de webhook continuam
// idênticos com a preferência desligada — ver o comentário em
// StockDeductionService.firePostEffects e os gates nos dois call sites.

import prisma from "../lib/prisma";
import { SystemLogService } from "./system-log.service";

/** Ausência de informação significa o comportamento de hoje: reabrir. */
export const REOPEN_ON_CANCEL_DEFAULT = true;

/**
 * Normaliza o valor cru da coluna. `null`/`undefined` ⇒ LIGADO.
 *
 * Puro de propósito: é a única definição de "o default é ligado" no projeto, e
 * dá para testá-la sem banco, sem mock e sem fixture.
 */
export function resolveReopenPref(raw: boolean | null | undefined): boolean {
  return raw ?? REOPEN_ON_CANCEL_DEFAULT;
}

/**
 * Lê a preferência do tenant.
 *
 * ⚠️ `tenantId` DEVE ser o dono dos dados (`parentUserId ?? id`). Colaborador
 * herda do admin: a linha do colaborador nunca governa nada.
 *
 * FAIL-OPEN, e a assimetria é o argumento. No dia 1 todo tenant tem `true`.
 * Um erro de leitura virando "não reabre" é perda de exposição SILENCIOSA —
 * ninguém percebe que o anúncio ficou parado. Virando "reabre", o erro é
 * visível, reversível num clique e nunca causa oversell, porque o estoque
 * restaurado é real. (O `whatsapp-entitlement` faz o oposto, fail-closed, e
 * está certo lá: gate de plano pago, onde "não sei" tem de virar "não pode".)
 *
 * Mas NÃO silencioso: a falha vira `REOPEN_PREFERENCE_READ_FAILED`. Fail-open
 * sem rastro deixaria o cliente que desligou sem nenhuma explicação para o
 * anúncio ter voltado.
 *
 * NUNCA lança e NUNCA cacheia. Sobre o cache: o `whatsapp-entitlement` guarda
 * 60s porque roda em caminho quente e atrasar uma liberação é inofensivo. Aqui
 * a janela produziria exatamente "desliguei e mesmo assim reativou" — o sintoma
 * que esta preferência existe para eliminar. E cancelamento é ação rara e cara
 * (transação de 60s, estorno de estoque, sync, reconciliação): um SELECT de um
 * booleano por chave primária é ruído nesse orçamento.
 */
export async function isReopenOnCancelEnabled(
  tenantId: string,
): Promise<boolean> {
  if (!tenantId) return REOPEN_ON_CANCEL_DEFAULT;
  try {
    const u = await prisma.user.findUnique({
      where: { id: tenantId },
      // Projeção de UMA coluna: este caminho não precisa do usuário inteiro.
      select: { reopenListingsOnSaleCancel: true },
    });
    return resolveReopenPref(u?.reopenListingsOnSaleCancel);
  } catch (err) {
    // Cobre inclusive `prisma.user === undefined` — o TypeError é síncrono e
    // cai aqui. É o estado real de vários specs de finance, que mockam o prisma
    // com um factory sem a tabela `user`; eles continuam verdes sem alteração.
    // ⚠️ O AVISO VAI DENTRO DO SEU PRÓPRIO try/catch, e não é paranoia: vários
    // specs mockam o SystemLogService só com os métodos que usam, sem
    // `logWarning`. Ali a chamada estoura TypeError SÍNCRONO — antes de existir
    // promessa para um `.catch()` segurar — e o erro escaparia deste bloco,
    // derrubando o cancelamento inteiro.
    //
    // Um tratador de erro que pode falhar não é tratador. O `try` externo
    // existe para o caminho nunca cair; deixar o log furá-lo anularia isso.
    try {
      void Promise.resolve(
        SystemLogService.logWarning(
          "REOPEN_PREFERENCE_READ_FAILED",
          "Não foi possível ler a preferência de reabertura de anúncio; assumindo LIGADO (comportamento padrão).",
          {
            userId: tenantId,
            resource: "user",
            resourceId: tenantId,
            details: {
              error: err instanceof Error ? err.message : String(err),
            },
          },
        ),
      ).catch(() => {});
    } catch {
      // Log é best-effort. Se nem ele funciona, o cancelamento segue mesmo assim.
    }
    return REOPEN_ON_CANCEL_DEFAULT;
  }
}
