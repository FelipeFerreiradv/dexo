import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

/**
 * Carrega o `.env` subindo a árvore de diretórios até encontrar um.
 *
 * `import "dotenv/config"` só olha o cwd. Isso quebra ao rodar de dentro de um
 * git worktree, que não tem `.env` próprio — ele fica no checkout principal.
 * O sintoma é o Prisma explodindo já no import, antes de qualquer código do
 * script rodar: "Invalid value undefined for datasource".
 *
 * Precisa viver em módulo separado, não num IIFE dentro do script: imports são
 * hoisted, então o `import prisma` seria avaliado antes de qualquer corpo de
 * função. Importando ESTE módulo primeiro, a ordem de avaliação é respeitada.
 *
 * Uso: `import "./lib/load-env";` como PRIMEIRA linha do script.
 */
function carregarEnv(): void {
  if (process.env.DATABASE_URL) return;

  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidato = path.join(dir, ".env");
    if (fs.existsSync(candidato)) {
      dotenv.config({ path: candidato });
      if (process.env.DATABASE_URL) return;
    }
    const pai = path.dirname(dir);
    if (pai === dir) break;
    dir = pai;
  }
}

carregarEnv();

export {};
