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
 * Deploy padrão (25/09/2026), um passo por vez. O build é feito NA pasta: o
 * .next grava caminho absoluto e não se transplanta de outra pasta.
 *   cd /var/www/dexo && git rev-parse HEAD && git pull --ff-only && cp -a .next .next.bak-$(date +%Y%m%d-%H%M%S)
 *   → `git diff --name-only <sha anterior>..HEAD -- package-lock.json prisma/schema.prisma`:
 *     - package-lock.json mudou: `npm ci` (o postinstall roda o prisma
 *       generate). Install que falhou ⇒ não reiniciar nada.
 *     - só prisma/schema.prisma mudou: generate com o binário pinado, nunca `npx prisma`
 *       (o `npm run build` não gera o client):
 *   cd /var/www/dexo && node node_modules/prisma/build/index.js generate --schema=prisma/schema.prisma
 *     - nos dois casos, node_modules/.prisma/client/index.js tem de passar de
 *       200 KB. Client velho quebra o dexo-api em runtime (o tsx não checa
 *       tipo). DDL, se houver, é passo à parte, revisado e aplicado antes.
 *   cd /var/www/dexo && npm run build
 *   → gate de pré-voo de rotina da numeração NF-e (docs/fiscal-numeracao-v2.md,
 *     "Gate de pré-voo"): nenhuma reserva EM_TRANSMISSAO/INCERTO com lease vivo,
 *     nenhuma nota em VALIDATING/SIGNING/SENDING, nenhuma inutilização pendente.
 *     Ligar flag, ampliar lista ou fazer rollback usa o gate estrito. Só então:
 *   cd /var/www/dexo && pm2 restart dexo-api dexo-frontend
 *  - `dexo-sync-orders` entra no restart só quando o código de sync muda.
 *  - NUNCA `pm2 restart all`: também dispara o dexo-catalog-stats (batch
 *    one-shot, ver abaixo) e reinicia o sync-orders sem necessidade.
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
      // O worker é opt-in. Quando a flag não está presente (por exemplo, numa
      // máquina de desenvolvimento com o .env de produção), o entrypoint sai
      // com código 0; não o ressuscite em um loop de restart do PM2.
      stop_exit_codes: [0],
      // O handler de SIGTERM/SIGINT deixa as passadas em voo terminarem antes
      // de desconectar o Prisma. O default curto do PM2 mataria o processo no
      // meio de uma chamada externa; este prazo vale só para este worker.
      kill_timeout: 60000,
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
      // ⚠️ OBRIGATÓRIO: é um batch ONE-SHOT (termina e sai). O default do pm2
      // (autorestart true) transformou-o em LOOP INFINITO na migração de
      // 23/07 (↺190 execuções seguidas em ~18h, queimando CPU e banco — o
      // `pm2 describe` que este arquivo espelhou não exibe esse campo, e o
      // flag se perdeu). O agendamento diário continua sendo do cron do host.
      // O deploy padrão reinicia só os apps nomeados e não o dispara; um
      // `pm2 restart all` dispararia UMA execução a mais.
      autorestart: false,
    },
  ],
};
