import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import fastify from "fastify";
import fastifyCors from "@fastify/cors";

// ──────────────────────────────────────────────────────────
// A configuração de CORS é infraestrutura crítica: ela é o que impede outra
// origem de ler dados autenticados do cliente. Este spec trava as três
// propriedades que não podem regredir — origem exata, credenciais e o
// fail-closed em produção — e cobre o `maxAge` adicionado para parar de
// repetir o preflight OPTIONS a cada requisição.
//
// `api.ts` não pode ser importado aqui: o módulo chama listen() e inicia os
// workers de background no import. Por isso a configuração é verificada no
// TEXTO-FONTE (mesmo padrão de tests/dashboard-routes-page-gate.spec.ts), e o
// comportamento do header é verificado num Fastify isolado.
// ──────────────────────────────────────────────────────────

const FONTE = fs.readFileSync(
  path.resolve(__dirname, "..", "app", "api", "api.ts"),
  "utf8",
);

describe("configuração de CORS da API", () => {
  it("mantém a origem exata (nunca curinga) e as credenciais", () => {
    expect(FONTE).toContain(`origin: corsOrigin || "http://localhost:3000"`);
    expect(FONTE).toContain("credentials: true");
    expect(FONTE).not.toContain(`origin: "*"`);
    expect(FONTE).not.toContain("origin: true");
  });

  it("continua abortando o boot em produção sem CORS_ORIGIN (fail-closed)", () => {
    expect(FONTE).toContain(
      `process.env.NODE_ENV === "production" && !corsOrigin`,
    );
    expect(FONTE).toContain("process.exit(1)");
  });

  it("declara maxAge para não repetir o preflight a cada requisição", () => {
    const m = FONTE.match(/maxAge:\s*(\d+)/);
    expect(m, "maxAge sumiu da configuração de CORS").toBeTruthy();
    const segundos = Number(m![1]);
    expect(segundos).toBeGreaterThan(0);
    // Teto de 24h: além disso os browsers ignoram e o cache fica longo demais
    // para uma eventual mudança de política.
    expect(segundos).toBeLessThanOrEqual(86400);
  });

  it("mantém os headers expostos do endpoint público de imagem", () => {
    for (const h of [
      "X-Removed-Background",
      "X-Shadow-Applied",
      "X-Image-Format",
    ]) {
      expect(FONTE).toContain(h);
    }
  });
});

describe("comportamento do preflight com maxAge", () => {
  async function buildApp(maxAge: number) {
    const app = fastify();
    await app.register(fastifyCors, {
      origin: "http://localhost:3000",
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      maxAge,
    });
    app.get("/ping", async () => ({ ok: true }));
    return app;
  }

  it("responde o preflight com Access-Control-Max-Age", async () => {
    const app = await buildApp(86400);
    const res = await app.inject({
      method: "OPTIONS",
      url: "/ping",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-max-age"]).toBe("86400");
    await app.close();
  });

  it("o GET real continua liberado para a origem permitida", async () => {
    const app = await buildApp(86400);
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    await app.close();
  });

  it("origem não permitida não recebe liberação", async () => {
    const app = await buildApp(86400);
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { origin: "https://site-malicioso.example" },
    });
    expect(res.headers["access-control-allow-origin"]).not.toBe(
      "https://site-malicioso.example",
    );
    await app.close();
  });
});
