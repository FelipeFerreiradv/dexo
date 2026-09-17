/**
 * Master gate for processes that perform background work against the database
 * or marketplace APIs.
 *
 * The opt-in flag is deliberately evaluated at call time.  A process can be
 * started with the local `.env` and the caller can still turn the kill-switch
 * off before the next tick without having to rely on a value captured during
 * module import.  The explicit disable flag wins when both variables are set;
 * this makes the local safety switch useful even if a shared environment has
 * the production opt-in enabled.
 */
export function isBackgroundWorkersEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    env.BACKGROUND_WORKERS_ENABLED === "1" &&
    env.BACKGROUND_WORKERS_DISABLED !== "1"
  );
}
