/**
 * Status em que um anúncio conta como VIVO na conta — a régua da guarda
 * anti-duplicata (repositório e criação usam a mesma). Lido por chamada:
 * LISTING_STATUS_SYNC_DISABLED=1 volta ao par antigo (active/paused).
 */
export function liveListingStatuses(): string[] {
  return process.env.LISTING_STATUS_SYNC_DISABLED === "1"
    ? ["active", "paused"]
    : ["active", "paused", "under_review", "reviewing", "unlist", "inactive"];
}
