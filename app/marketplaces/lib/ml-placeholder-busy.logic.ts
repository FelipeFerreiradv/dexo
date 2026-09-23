/**
 * Quem pode publicar no pendente do ML agora — a regra única usada pela
 * checagem enxuta do começo do createMLListing e pela reserva do passo 3.1.
 *
 * Estados de uma linha reaproveitável (placeholder `PENDING_`, fora da
 * republicação, ou anúncio encerrado com id real):
 *  - retry DESLIGADO + horário futuro ⇒ reservada (botão ou outra criação);
 *  - retry LIGADO + status `pending` ⇒ o CRON está publicando agora (o claim
 *    dele marca `pending` só para o ML);
 *  - retry LIGADO + `[VERIFICAR]` ⇒ a tentativa anterior pode ter criado o
 *    item: só o cron, que confere pelo SKU antes de recriar, publica;
 *  - retry LIGADO sem nada disso, em placeholder `PENDING_` ⇒ apenas
 *    AGENDADA: quem chama pode assumir (atômico) — "Anunciar em massa" logo
 *    depois de corrigir o produto publica com as escolhas do lote, como
 *    antes. Linha com id REAL agendada não é assumida (o claim do cron não
 *    a marca, então não dá para saber se ele está nela);
 *  - o resto ⇒ livre (reserva atômica normal).
 *
 * Revisão de 23/09/2026 (4ª rodada): recusar toda linha com retry ligado
 * jogava fora as escolhas do lote (preço, categoria da Revisão individual)
 * durante a espera do re-arme/backoff — regressão em relação a main.
 */

export interface PlaceholderRowLite {
  id: string;
  externalListingId?: string | null;
  retryEnabled?: boolean | null;
  nextRetryAt?: Date | string | null;
  status?: string | null;
  lastError?: string | null;
}

export type PlaceholderDecision = "owned" | "free" | "takeover" | "busy";

export function placeholderDecision(
  row: PlaceholderRowLite,
  reservation: { listingId: string; at: Date } | null | undefined,
  now: number = Date.now(),
): PlaceholderDecision {
  const proxima = row.nextRetryAt ? new Date(row.nextRetryAt).getTime() : null;
  if (
    reservation &&
    reservation.listingId === row.id &&
    proxima !== null &&
    proxima === new Date(reservation.at).getTime()
  ) {
    return "owned";
  }
  if (row.retryEnabled) {
    if (String(row.status ?? "").toLowerCase() === "pending") return "busy";
    if (String(row.lastError ?? "").startsWith("[VERIFICAR]")) return "busy";
    // Linha com id REAL (anúncio encerrado sendo publicado de novo): o claim
    // do cron não a marca `pending` (marcar escondia uma linha viva das
    // guardas anti-duplicata) — sem essa marca não dá para saber se o cron
    // está nela, então não é assumida.
    if (!String(row.externalListingId ?? "").startsWith("PENDING_")) {
      return "busy";
    }
    return "takeover";
  }
  if (proxima !== null && proxima > now) return "busy";
  return "free";
}

/** A linha participa da regra? (republicação é do sync; anúncio vivo, da guarda). */
export function isReusableMlPlaceholder(row: {
  externalListingId?: string | null;
}): boolean {
  const ext = String(row.externalListingId ?? "");
  return ext.startsWith("PENDING_") && !ext.startsWith("PENDING_REPUBLISH_");
}

/** Mensagem para quem chama quando a linha está ocupada. */
export function busyMessage(row: PlaceholderRowLite): string {
  return row.retryEnabled
    ? "Já existe uma nova tentativa agendada para este anúncio — a Dexo publica sozinha em instantes."
    : "Esta publicação já está em andamento. Aguarde alguns minutos e confira o anúncio.";
}
