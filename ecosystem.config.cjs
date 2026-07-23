/**
 * ecosystem.config.cjs — definição CANÔNICA dos processos pm2 do Dexo (VPS).
 *
 * Por que este arquivo existe (incidente 23/07/2026, DUAS vezes no mesmo dia):
 * o deploy usava `pm2 restart all --update-env`, que injeta o ambiente do
 * SHELL ATUAL nos processos. Num shell que tinha feito `source .env`, isso
 * injetou PORT=3333 (porta da API Fastify) no dexo-frontend → o `next start`
 * subiu na porta da API, a API entrou em crash-loop de EADDRINUSE e o site
 * caiu com 502. Com as portas PINADAS aqui, o estado do shell deixa de
 * importar.
 *
 * Regras de operação:
 *  - As DEMAIS variáveis NÃO vêm daqui: a API importa `dotenv/config`
 *    (app/api/api.ts), o Next carrega .env nativamente e os scripts importam
 *    `dotenv/config`. Editar /var/www/dexo/.env + `pm2 restart <app>` basta.
 *  - NUNCA use `--update-env`. Nunca. As portas já estão pinadas aqui.
 *
 * Migração (UMA vez, ~5s de indisponibilidade):
 *   cd /var/www/dexo && pm2 delete all && pm2 start ecosystem.config.cjs && pm2 save
 *
 * Deploy dali em diante:
 *   cd /var/www/dexo && git pull && npm ci && npm run build && pm2 restart all && pm2 save
 *
 * Comandos/paths espelham EXATAMENTE o `pm2 describe` da produção em
 * 23/07/2026 — nada de comportamento novo, só a porta explícita.
 */
module.exports = {
  apps: [
    {
      name: "dexo-frontend",
      cwd: "/var/www/dexo",
      script: "/usr/bin/npm",
      args: "start",
      // `next start` obedece PORT do ambiente — pinada para nunca mais
      // depender do shell do deploy.
      env: { PORT: "3000" },
    },
    {
      name: "dexo-api",
      cwd: "/var/www/dexo",
      script: "/usr/bin/npx",
      args: "tsx app/api/api.ts",
      env: { PORT: "3333" },
    },
    {
      name: "dexo-sync-orders",
      cwd: "/var/www/dexo",
      script: "/usr/bin/bash",
      args: ["-c", "npx tsx scripts/sync-orders-and-metrics-loop.ts"],
    },
    {
      // Batch de estatísticas de catálogo. O caminho do npm/node do nvm é o
      // que roda hoje em produção (pm2 describe) — se atualizar o Node do
      // nvm, ajustar os dois paths abaixo.
      name: "dexo-catalog-stats",
      cwd: "/var/www/dexo",
      script: "/root/.nvm/versions/node/v22.22.2/bin/npm",
      args: "run stats:catalog",
      interpreter: "/root/.nvm/versions/node/v22.22.2/bin/node",
    },
  ],
};
