/**
 * Monta o registro de auditoria de uma movimentação de peças entre localizações.
 *
 * POR QUE EXISTE
 * --------------
 * Até 09/2026 mover peça não deixava rastro próprio: nem `SystemLog`, nem
 * `StockLog`. O `loggingMiddleware` (global) gravava a requisição, mas sob o
 * rótulo `CREATE_LOCATION` — junto com a criação de localização — e com o
 * `targetLocationId` **redigido**, porque a regra que protege "cnpj"/"rg" casa
 * por substring com o `ta`**`rg`**`etLocationId`. Sobrava quem, quando e quais
 * peças; sumia para onde, e a origem nunca existiu.
 *
 * Este registro é gravado pela rota via `SystemLogService`, que **não** passa
 * pelo `sanitizeDeep` — os valores vão inteiros. Ainda assim os nomes dos campos
 * abaixo foram escolhidos para não colidir com nenhum padrão sensível, para o
 * registro sobreviver caso um dia alguém roteie logs explícitos pelo sanitizador.
 */
// Import RELATIVO, não pelo alias `@/`: nenhum arquivo servido pelo Fastify
// (app/routes, app/usecases, app/repositories) usa o alias — ele é convenção do
// bundle do Next, e este módulo é importado pela rota, que roda sob `tsx`.
import type { LogAction } from "../../interfaces/system-log.interface";
import type { ResumoOrigens } from "./move-products-origins";

/**
 * Teto de ids no registro. A lição do `bulk-delete` do Portal Eco Peças
 * (tests/logging-middleware-action-type.spec.ts): depois do fato, o `details` é
 * a ÚNICA lista do que foi tocado. Truncar é ruim; gravar um blob de 5 mil ids
 * em toda movimentação é pior. O truncamento é sinalizado, nunca silencioso.
 */
export const MAX_IDS_REGISTRADOS = 200;

export interface EntradaAuditoriaMovimentacao {
  targetLocationId: string | null;
  targetCode?: string | null;
  targetPath?: string | null;
  productIds: string[];
  /** o que o `updateMany` reportou (contrato antigo). */
  count: number;
  /** `null` quando a leitura de origem falhou — e isso vira campo no registro. */
  resumo: ResumoOrigens | null;
  outcome: "ok" | "erro";
  errorMessage?: string;
  statusCode?: number;
}

export interface RegistroAuditoriaMovimentacao {
  action: LogAction;
  message: string;
  details: Record<string, unknown>;
}

export function buildMoveProductsAudit(
  e: EntradaAuditoriaMovimentacao,
): RegistroAuditoriaMovimentacao {
  const desvinculo = e.targetLocationId === null;
  const action: LogAction = desvinculo
    ? "UNBIND_PRODUCTS_LOCATION"
    : "MOVE_PRODUCTS_LOCATION";

  const ids = [...new Set(e.productIds)];
  const destinoLegivel = e.targetPath || e.targetCode || e.targetLocationId || null;
  const origensLegiveis = (e.resumo?.origens ?? [])
    .map((o) => o.caminho ?? o.locationId ?? "sem localizacao")
    .join(", ");

  const message =
    e.outcome === "erro"
      ? (desvinculo
          ? `Falha ao desvincular ${ids.length} peça(s)`
          : `Falha ao mover ${ids.length} peça(s) para "${destinoLegivel ?? "?"}"`) +
        (e.errorMessage ? `: ${e.errorMessage}` : "")
      : desvinculo
        ? `${e.resumo?.movidos ?? e.count} peça(s) deixada(s) SEM localização` +
          (origensLegiveis ? ` (de ${origensLegiveis})` : "")
        : `${e.resumo?.movidos ?? e.count} peça(s) movida(s) para "${destinoLegivel ?? "?"}"` +
          (origensLegiveis ? ` (de ${origensLegiveis})` : "");

  return {
    action,
    message,
    details: {
      resultado: e.outcome,
      destinoId: e.targetLocationId,
      destinoCodigo: e.targetCode ?? null,
      destinoCaminho: e.targetPath ?? null,
      origens: e.resumo?.origens ?? [],
      origensTruncadas: e.resumo?.origensTruncadas ?? false,
      solicitados: e.resumo?.solicitados ?? ids.length,
      movidos: e.resumo?.movidos ?? null,
      jaNoDestino: e.resumo?.jaNoDestino ?? null,
      naoEncontrados: e.resumo?.naoEncontrados ?? null,
      // `count` do updateMany fica ao lado de `movidos` de propósito: os dois
      // discordam exatamente quando havia peça já no destino, e é essa
      // discordância que se quer poder auditar depois.
      countUpdateMany: e.count,
      // A leitura de origem é best-effort e não pode derrubar o movimento do
      // operador. Quando ela falha, o buraco fica REGISTRADO em vez de silencioso.
      origemIndisponivel: e.resumo === null,
      productIds: ids.slice(0, MAX_IDS_REGISTRADOS),
      productIdsTruncados: ids.length > MAX_IDS_REGISTRADOS,
      ...(e.statusCode !== undefined ? { statusCode: e.statusCode } : {}),
      ...(e.errorMessage ? { erro: e.errorMessage } : {}),
    },
  };
}
