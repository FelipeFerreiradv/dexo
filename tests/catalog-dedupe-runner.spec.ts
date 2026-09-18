import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = fs.readFileSync(
  path.resolve("scripts/catalog-dedupe/run-catalog-merge.sh"),
  "utf8",
);
const finalizer = fs.readFileSync(
  path.resolve("scripts/catalog-dedupe/finalize-live-manifest.ts"),
  "utf8",
);

describe("catalog merge operational runner", () => {
  it("drains sync before stopping the API and never targets the frontend", () => {
    const syncStop = script.indexOf("pm2 stop dexo-sync-orders");
    const apiStop = script.indexOf("pm2 stop dexo-api");
    expect(syncStop).toBeGreaterThan(-1);
    expect(apiStop).toBeGreaterThan(syncStop);
    expect(script).not.toMatch(/pm2\s+(?:stop|delete|restart).*frontend/i);
  });

  it("installs restoration before either stop and saves PM2 after both reloads", () => {
    const trap = script.indexOf("trap restore_services EXIT");
    const firstStop = script.indexOf("pm2 stop dexo-sync-orders");
    const apiReload = script.indexOf(
      "pm2 startOrReload ecosystem.config.cjs --only dexo-api",
    );
    const syncReload = script.indexOf(
      "pm2 startOrReload ecosystem.config.cjs --only dexo-sync-orders",
    );
    const save = script.indexOf("pm2 save");
    expect(trap).toBeGreaterThan(-1);
    expect(trap).toBeLessThan(firstStop);
    expect(apiReload).toBeGreaterThan(-1);
    expect(syncReload).toBeGreaterThan(apiReload);
    expect(save).toBeGreaterThan(syncReload);
  });

  it("performs dry-run first and only attests drained workers for apply", () => {
    expect(script.indexOf('"${cli[@]}"')).toBeLessThan(
      script.indexOf("trap restore_services EXIT"),
    );
    expect(script).toContain('CATALOG_MERGE_WORKERS_DRAINED=1 "${cli[@]}"');
    expect(script).toContain("--identity-sha256=$identity_sha256");
  });

  it("requests repeatable-read through Prisma before the transaction starts", () => {
    expect(finalizer).toContain('isolationLevel: "RepeatableRead"');
    expect(finalizer).not.toMatch(/SET TRANSACTION ISOLATION LEVEL/i);
  });
});
