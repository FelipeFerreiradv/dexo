// Gera o build id UMA única vez por build e grava em .build-id (raiz do projeto).
//
// Por que um arquivo (e não Date.now() direto no next.config): o next.config é
// avaliado VÁRIAS vezes — workers de build do cliente, do servidor e de novo no
// `next start`. Se o id usasse Date.now() no config, cada avaliação geraria um
// valor diferente: o cliente embutiria um timestamp e o servidor (/api/version)
// responderia outro, e o aviso de "nova versão" reapareceria em loop mesmo sem
// deploy novo. Gerando aqui UMA vez e gravando no arquivo, TODAS as leituras
// (config + rota) enxergam exatamente o mesmo valor para um dado build.
//
// O timestamp garante que todo build gere um id diferente (mesmo do mesmo
// commit); o sha identifica o commit. Roda antes do `next build` (ver
// package.json: "build" e "vercel-build").

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const commit =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ||
  (() => {
    try {
      return execSync("git rev-parse --short HEAD").toString().trim();
    } catch {
      return "dev";
    }
  })();

const buildId = `${commit}-${Date.now()}`;
writeFileSync(".build-id", buildId);
console.log(`[build-id] ${buildId}`);
