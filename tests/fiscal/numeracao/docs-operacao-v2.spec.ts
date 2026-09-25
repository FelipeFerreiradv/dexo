import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cooldownRepeticaoMs,
  consumoIndevidoCooldownMs,
  devolucaoRefItemProdDesde,
  focusGetTimeoutMs,
  focusPausasConsultaMs,
  focusPostTimeoutMs,
  isDevolucaoAtiva,
  isNumeracaoV2ParaEmissao,
  leaseEnvioFocusMs,
  leaseEnvioSefazMs,
  leasePreEnvioMs,
  naoConstaMinMs,
  type FiscalEnv,
} from "../../../app/fiscal/flags";
import { DEVOLUCAO_REF_ITEM_PROD_DESDE_PADRAO } from "../../../app/fiscal/devolucao/modo-referencia";
import { avaliarFaixa } from "../../../app/fiscal/numeracao/decisao";
import { ESTADOS_RESERVA } from "../../../app/fiscal/numeracao/estados";

// ──────────────────────────────────────────────────────────────────────────────
// Documentação operacional da numeração V2 × código (prontidão de 25/09/2026).
//
// Nenhum outro teste lê estes arquivos, e é deles que o operador copia comando
// e bloco de `.env` para a VPS. Este spec amarra:
//  1. o `.env.example` e os blocos `dotenv` dos docs a `app/fiscal/flags.ts`:
//     nenhum bloco copiável liga a Focus, usa `"*"` ou desliga o global;
//  2. nenhum comando copiável — nem frase fora de negação — manda
//     `pm2 restart all` ou `--update-env`, e o deploy padrão (pull --ff-only →
//     backup do .next → build → gate de rotina → restart nomeado) está escrito
//     onde o operador procura, com o `prisma generate` pinado quando o
//     `prisma/schema.prisma` muda sem `npm ci`;
//  3. as decisões de 25/09: lista explícita, a MESMA nas duas allowlists, e a
//     devolução ligando JUNTO com a numeração (decisão do dono), com a proteção
//     de rollback da devolução no ar ANTES; rollback sem desligar
//     `NFE_NUMERACAO_V2_ENABLED`, com o gate estrito e o pré-voo filtrado pela
//     config; gate de rotina (lease vivo e notas em voo) × gate estrito (ligar,
//     ampliar, rollback); canário de 3 configs substituído pela vigília; e a
//     faixa 8–10 da série 3 da Kiko NÃO se inutiliza (no V1 Focus o contador do
//     Dexo é fictício);
//  4. o item da inutilização lista o que `avaliarFaixa` bloqueia e o que ela
//     pede para confirmar, estado por estado.
// `ecosystem.config.cjs` e o bloco NF-e do `.env.example` só mudam em
// comentário: os valores ficam fixados aqui. Mudou um processo ou um padrão de
// propósito? Atualize o valor fixado junto, no mesmo commit.
// ──────────────────────────────────────────────────────────────────────────────

const RAIZ = path.resolve(__dirname, "../../..");

/** Lê normalizando CRLF: três destes arquivos são CRLF na árvore de trabalho. */
const ler = (rel: string) =>
  readFileSync(path.join(RAIZ, rel), "utf8").replace(/\r\n/g, "\n");

const DOC_V2 = "docs/fiscal-numeracao-v2.md";
const ROTEIRO = "docs/roteiro-emissao-focus-nfe.md";
const ROLLOUT = "docs/handoff-nfe-evolucao/05-testes-rollout.md";
const DEPLOY = "docs/handoff-nfe-evolucao/12-DEPLOY-VPS.md";
const DOCS = [DOC_V2, ROTEIRO, ROLLOUT, DEPLOY];

/** Única config na V2 e na devolução em 25/09/2026 (SEFAZ direto). */
const DLS = "cmr9omjlt30xw18jqt3m5oyc3";
/** Config Focus hipotética: nunca está numa lista explícita de SEFAZ direto. */
const FOCUS_FORA = "config-focus-fora-da-lista";

type Bloco = { lang: string; corpo: string };

function blocos(md: string, lang?: string): Bloco[] {
  const out: Bloco[] = [];
  for (const m of md.matchAll(/```([\w-]*)\n([\s\S]*?)```/g)) {
    if (lang === undefined || m[1] === lang) out.push({ lang: m[1], corpo: m[2] });
  }
  return out;
}

/** Comando sem o comentário final (`# ...`), para não confundir aviso com ordem. */
const semComentario = (linha: string) => linha.replace(/(^|\s)#.*$/, "").trim();

/** Bloco dotenv → env (a última atribuição vence, como no dotenv). */
function envDoBloco(corpo: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const linha of corpo.split("\n")) {
    const l = semComentario(linha);
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const ids = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Sentenças: quebra em fim de frase e em linha. */
const sentencas = (texto: string) => texto.split(/(?<=[.!?])\s+|\n/);

/** Seção de nível 2 pelo título (até o próximo `## `). */
function secao(md: string, titulo: string): string {
  const ini = md.indexOf(`\n## ${titulo}`);
  if (ini < 0) return "";
  const fim = md.indexOf("\n## ", ini + 4);
  return fim < 0 ? md.slice(ini) : md.slice(ini, fim);
}

/** Subseção de nível 3 pelo título (até o próximo `### ` ou `## `). */
function subsecao(md: string, titulo: string): string {
  const ini = md.indexOf(`\n### ${titulo}`);
  if (ini < 0) return "";
  const resto = md.slice(ini + 5);
  const fim = resto.search(/\n##(#)? /);
  return fim < 0 ? md.slice(ini) : md.slice(ini, ini + 5 + fim);
}

/** Os passos do deploy padrão aparecem nesta ordem na mesma sequência de comandos. */
const PASSOS_DEPLOY = [
  "git pull --ff-only",
  "cp -a .next .next.bak-",
  "npm run build",
  "pm2 restart dexo-api dexo-frontend",
];
function temDeployPadrao(texto: string): boolean {
  let pos = -1;
  for (const passo of PASSOS_DEPLOY) {
    const i = texto.indexOf(passo, pos + 1);
    if (i < 0) return false;
    pos = i;
  }
  return true;
}

/** Generate com o binário pinado (6.2.1): `npx prisma` pode baixar outra versão. */
const GENERATE_PINADO = "node node_modules/prisma/build/index.js generate --schema=prisma/schema.prisma";

/** Trecho "Deploy padrão" do cabeçalho do ecosystem, sem o ` * ` do comentário. */
function deployDoEcosystem(): string {
  const fonte = ler("ecosystem.config.cjs");
  const ini = fonte.indexOf("Deploy padrão");
  const fim = fonte.indexOf("Comandos/paths espelham");
  if (ini < 0 || fim < ini) return "";
  return fonte
    .slice(ini, fim)
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, ""))
    .join("\n");
}

/** Bloco bash do deploy padrão COM os comentários (é neles que ficam os passos condicionais). */
function blocoDeploy(doc: string): string {
  const achado = blocos(ler(doc), "bash").find((b) =>
    temDeployPadrao(b.corpo.split("\n").map(semComentario).join("\n")),
  );
  return achado?.corpo ?? "";
}

const FONTES_DEPLOY: Array<[string, () => string]> = [
  ["ecosystem.config.cjs", deployDoEcosystem],
  [ROLLOUT, () => blocoDeploy(ROLLOUT)],
  [DEPLOY, () => blocoDeploy(DEPLOY)],
];

/**
 * Posição da linha de COMANDO (não de uma menção em texto): `npm run build` também
 * aparece na explicação de por que o generate vem antes.
 */
function posComando(texto: string, comando: RegExp): number {
  let pos = 0;
  for (const linha of texto.split("\n")) {
    if (comando.test(linha.trim())) return pos;
    pos += linha.length + 1;
  }
  return -1;
}
const CMD_BUILD = /^(cd \/var\/www\/dexo && )?npm run build\b/;
const CMD_GENERATE = new RegExp(`^(#\\s+)?(cd /var/www/dexo && )?${GENERATE_PINADO.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`);
const CMD_RESTART = /^(cd \/var\/www\/dexo && )?pm2 restart dexo-api dexo-frontend\b/;

/** Estados de reserva que o pré-voo de uma config tem de listar. */
const ESTADOS_PRE_VOO_CONFIG = ["RESERVADO", "REJEITADO", "EM_TRANSMISSAO", "INCERTO", "BLOQUEADO"];

/** Frase que proíbe (ou só descreve sem mandar): palavra de negação em pt ou en. */
const NEGACAO = /\b(nunca|n[ãa]o|sem|never|avoid)\b/i;

/** Frase que AUTORIZA `*` (a regra é nunca). */
const AUTORIZA_ESTRELA = /\b(pode|podem|use|usar|usa|vale|permitid\w*|liberad\w*|aceit\w*)\b[^.\n]{0,20}(`\*`|"\*")/i;

// ───────────────────────────── ecosystem.config.cjs ─────────────────────────────

describe("ecosystem.config.cjs — só o comentário muda", () => {
  const fonte = ler("ecosystem.config.cjs");
  const cabecalho = fonte.slice(0, fonte.indexOf("module.exports"));
  /** Linhas copiáveis do cabeçalho: as que começam com `cd /var/www/dexo`. */
  const comandos = cabecalho
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trim())
    .filter((l) => l.startsWith("cd /var/www/dexo"));

  it("a definição dos processos pm2 é a de produção (valores fixados)", () => {
    const req = createRequire(path.join(RAIZ, "package.json"));
    const cfg = req(path.join(RAIZ, "ecosystem.config.cjs"));
    expect(cfg).toEqual({
      apps: [
        { name: "dexo-frontend", cwd: "/var/www/dexo", script: "/usr/bin/npm", args: "start", env: { PORT: "3000" } },
        { name: "dexo-api", cwd: "/var/www/dexo", script: "/usr/bin/npx", args: "tsx app/api/api.ts", env: { PORT: "3333" } },
        {
          name: "dexo-sync-orders",
          cwd: "/var/www/dexo",
          script: "/usr/bin/bash",
          args: ["-c", "npx tsx scripts/sync-orders-and-metrics-loop.ts"],
          stop_exit_codes: [0],
          kill_timeout: 60000,
        },
        {
          name: "dexo-catalog-stats",
          cwd: "/var/www/dexo",
          script: "/root/.nvm/versions/node/v22.22.2/bin/npm",
          args: "run stats:catalog",
          interpreter: "/root/.nvm/versions/node/v22.22.2/bin/node",
          autorestart: false,
        },
      ],
    });
  });

  it("nenhum comando do cabeçalho usa `restart all` ou `--update-env`", () => {
    expect(comandos.length).toBeGreaterThan(0);
    for (const c of comandos) {
      expect(c, c).not.toMatch(/restart\s+all\b/);
      expect(c, c).not.toMatch(/--update-env/);
    }
  });

  it("o comando de deploy é o padrão (pull --ff-only, backup do .next, build, restart nomeado)", () => {
    // Um passo por linha: a ordem vale para a sequência inteira de comandos.
    expect(temDeployPadrao(comandos.join("\n"))).toBe(true);
  });
});

// ─────────────────────── deploy padrão: client do Prisma e gate ───────────────────────

describe("deploy padrão — client do Prisma e gate antes do restart", () => {
  it.each(FONTES_DEPLOY)(
    "%s regenera o client com o binário pinado quando prisma/schema.prisma muda, antes do build",
    (_, texto) => {
      // `npm run build` não gera o client (só o postinstall do `npm ci` gera): um PR com
      // schema novo e lock intacto subiria o dexo-api (tsx, sem checagem de tipo) com o
      // client velho.
      const t = texto();
      expect(t).toMatch(/git diff --name-only[^\n]*prisma\/schema\.prisma/);
      const gen = posComando(t, CMD_GENERATE);
      expect(gen).toBeGreaterThan(-1);
      expect(gen).toBeLessThan(posComando(t, CMD_BUILD));
      expect(t).toMatch(/\.prisma\/client\/index\.js[\s\S]{0,80}200\s*KB/i);
      for (const linha of t.split("\n").filter((l) => /npx prisma/.test(l))) {
        expect(linha, linha).toMatch(/\b(nunca|never)\b/i);
      }
    },
  );

  it.each(FONTES_DEPLOY)("%s põe o gate de pré-voo entre o build e o restart, sem encadear os dois", (_, texto) => {
    const t = texto();
    const build = posComando(t, CMD_BUILD);
    const restart = posComando(t, CMD_RESTART);
    expect(build).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(build);
    const gate = t.slice(build).search(/gate de pr[ée]-voo|pre-flight gate/i);
    expect(gate).toBeGreaterThan(-1);
    expect(build + gate).toBeLessThan(restart);
    for (const linha of t.split("\n")) {
      expect(/npm run build/.test(linha) && /pm2 restart/.test(linha), linha).toBe(false);
    }
  });

  it.each(FONTES_DEPLOY)(
    "%s: o gate do deploy de rotina é o do lease vivo e das notas em voo; ligar ou ampliar flag usa o estrito",
    (_, texto) => {
      // "Tudo tem de voltar zero" incluía BLOQUEADO de qualquer config: com 22 configs, uma
      // reserva estacionada à espera de conferência travaria todo deploy de rotina, e o
      // operador aprenderia a ignorar o gate. O critério de rotina está no doc V2.
      const t = texto();
      const trecho = t.slice(posComando(t, CMD_BUILD), posComando(t, CMD_RESTART));
      expect(trecho).toMatch(/\blease\b/i);
      expect(trecho).toMatch(/VALIDATING\/SIGNING\/SENDING/);
      expect(trecho).toMatch(/estrito|strict/i);
      expect(trecho).not.toMatch(/tudo tem de voltar zero|no live reservation/i);
    },
  );
});

// ───────────────────────────────── .env.example ─────────────────────────────────

/** Bloco NF-e do .env.example: linhas contíguas em volta de NFE_NUMERACAO_V2_ENABLED. */
function blocoNfeEnvExample() {
  const linhas = ler(".env.example").split("\n");
  const ancora = linhas.findIndex((l) => l.startsWith("NFE_NUMERACAO_V2_ENABLED="));
  let ini = ancora;
  while (ini > 0 && linhas[ini - 1].trim() !== "") ini--;
  let fim = ancora;
  while (fim < linhas.length && linhas[fim].trim() !== "") fim++;
  const bloco = linhas.slice(ini, fim);
  return {
    ancora,
    atribuicoes: bloco.filter((l) => /^[A-Z0-9_]+=/.test(l)),
    comentarios: bloco.filter((l) => l.trim().startsWith("#")),
  };
}

describe(".env.example — bloco da evolução NF-e", () => {
  const { ancora, atribuicoes, comentarios } = blocoNfeEnvExample();
  const textoComentario = comentarios.join("\n");

  it("as atribuições não mudaram (só comentário pode mudar)", () => {
    expect(ancora).toBeGreaterThan(0);
    expect(atribuicoes).toEqual([
      "NFE_NUMERACAO_V2_ENABLED=false",
      "NFE_NUMERACAO_V2_CONFIG_IDS=",
      "NFE_NUMERACAO_V2_MODELOS=55",
      "NFE_NUMERACAO_V2_FOCUS_ENABLED=false",
      "NFE_RESP_TEC_EMPRESA_ENABLED=false",
      "NFE_RESP_TEC_EMPRESA_CONFIG_IDS=",
      "NFE_DEVOLUCAO_ENABLED=false",
      "NFE_DEVOLUCAO_CONFIG_IDS=",
      "NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE=2026-10-05",
      "NFE_NUMERACAO_V2_LEASE_PRE_ENVIO_MS=600000",
      "NFE_NUMERACAO_V2_LEASE_SEFAZ_MS=570000",
      "NFE_NUMERACAO_V2_LEASE_FOCUS_MS=180000",
      "NFE_NUMERACAO_V2_NAO_CONSTA_MIN_MS=285000",
      "NFE_NUMERACAO_V2_COOLDOWN_REPETICAO_MS=60000",
      "NFE_NUMERACAO_V2_COOLDOWN_CONSUMO_INDEVIDO_MS=3600000",
      "FOCUS_V2_POST_TIMEOUT_MS=45000",
      "FOCUS_V2_GET_TIMEOUT_MS=15000",
      "NFE_NUMERACAO_V2_FOCUS_PAUSAS_MS=2000,3000,4000",
    ]);
  });

  it("toda chave do bloco é lida por app/fiscal/flags.ts", () => {
    const flags = ler("app/fiscal/flags.ts");
    for (const a of atribuicoes) {
      const chave = a.slice(0, a.indexOf("="));
      // Lida como string (`"NFE_..."`) ou como propriedade (`env.NFE_...`).
      expect(flags, chave).toMatch(new RegExp(`[".]${chave}\\b`));
    }
  });

  it("os ajustes finos do exemplo são exatamente os padrões do código", () => {
    const vazio: FiscalEnv = {};
    const env = Object.fromEntries(atribuicoes.map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
    expect(Number(env.NFE_NUMERACAO_V2_LEASE_PRE_ENVIO_MS)).toBe(leasePreEnvioMs(vazio));
    expect(Number(env.NFE_NUMERACAO_V2_LEASE_SEFAZ_MS)).toBe(leaseEnvioSefazMs(vazio));
    expect(Number(env.NFE_NUMERACAO_V2_LEASE_FOCUS_MS)).toBe(leaseEnvioFocusMs(vazio));
    expect(Number(env.NFE_NUMERACAO_V2_NAO_CONSTA_MIN_MS)).toBe(naoConstaMinMs(vazio));
    expect(Number(env.NFE_NUMERACAO_V2_COOLDOWN_REPETICAO_MS)).toBe(cooldownRepeticaoMs(vazio));
    expect(Number(env.NFE_NUMERACAO_V2_COOLDOWN_CONSUMO_INDEVIDO_MS)).toBe(consumoIndevidoCooldownMs(vazio));
    expect(Number(env.FOCUS_V2_POST_TIMEOUT_MS)).toBe(focusPostTimeoutMs(vazio));
    expect(Number(env.FOCUS_V2_GET_TIMEOUT_MS)).toBe(focusGetTimeoutMs(vazio));
    expect(env.NFE_NUMERACAO_V2_FOCUS_PAUSAS_MS.split(",").map(Number)).toEqual(focusPausasConsultaMs(vazio));
    expect(env.NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE).toBe(devolucaoRefItemProdDesde(vazio));
  });

  it("documenta a regra da lista explícita e proíbe a sub-flag Focus com \"*\"", () => {
    expect(textoComentario).toMatch(/lista expl[ií]cita/i);
    expect(
      comentarios.some(
        (c) => /nunca/i.test(c) && /NFE_NUMERACAO_V2_FOCUS_ENABLED=true/.test(c) && /"\*"/.test(c),
      ),
    ).toBe(true);
    // Rollback é tirar da lista; desligar o global é o rollback PROIBIDO.
    expect(comentarios.some((c) => /nunca/i.test(c) && /NFE_NUMERACAO_V2_ENABLED=false/.test(c))).toBe(true);
  });

  it("documenta NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE: padrão do código, regra VC02-14 da NT 2025.002, valor global", () => {
    // O padrão escrito no comentário é o mesmo nos dois lugares do código que o leem.
    expect(devolucaoRefItemProdDesde({})).toBe(DEVOLUCAO_REF_ITEM_PROD_DESDE_PADRAO);
    const sobreADevolucao = comentarios.filter((c) => /REF_ITEM_PROD_DESDE|ITEM|DFeReferenciado/.test(c)).join("\n");
    expect(sobreADevolucao).toContain(DEVOLUCAO_REF_ITEM_PROD_DESDE_PADRAO);
    expect(textoComentario).toMatch(/VC02-14/);
    expect(textoComentario).toMatch(/NT 2025\.002/);
    expect(textoComentario).toMatch(/global/i);
  });

  it("proíbe \"*\" na devolução pelo motivo do código (isDevolucaoAtiva não olha o provedor)", () => {
    const corrido = comentarios.map((c) => c.replace(/^\s*#\s?/, "")).join(" ");
    expect(
      sentencas(corrido).some((s) => /\bnunca "\*"/i.test(s) && /isDevolucaoAtiva/.test(s) && /Focus/.test(s)),
    ).toBe(true);
  });
});

// ───────────────────────────── blocos dotenv dos docs ─────────────────────────────

describe("blocos dotenv dos docs × app/fiscal/flags.ts", () => {
  const todos = DOCS.flatMap((doc) => blocos(ler(doc), "dotenv").map((b) => ({ doc, env: envDoBloco(b.corpo) })));

  it("existe pelo menos um bloco dotenv para conferir", () => {
    expect(todos.length).toBeGreaterThan(0);
  });

  it("nenhum bloco usa \"*\" numa allowlist, liga a sub-flag Focus ou desliga o global", () => {
    for (const { doc, env } of todos) {
      for (const chave of ["NFE_NUMERACAO_V2_CONFIG_IDS", "NFE_DEVOLUCAO_CONFIG_IDS"]) {
        if (chave in env) expect(ids(env[chave]), `${doc} ${chave}`).not.toContain("*");
      }
      expect(env.NFE_NUMERACAO_V2_FOCUS_ENABLED, doc).not.toBe("true");
      expect(env.NFE_NUMERACAO_V2_ENABLED, doc).not.toBe("false");
    }
  });

  it("nenhum bloco põe uma config Focus na V2 ou na devolução", () => {
    for (const { doc, env } of todos) {
      expect(isNumeracaoV2ParaEmissao(FOCUS_FORA, "55", "FOCUS_NFE", env), doc).toBe(false);
      expect(isNumeracaoV2ParaEmissao(FOCUS_FORA, "55", null, env), doc).toBe(false);
      expect(isDevolucaoAtiva(FOCUS_FORA, env), doc).toBe(false);
    }
  });

  it("toda config da lista da devolução está também na lista da V2 (senão a devolução fica morta)", () => {
    for (const { doc, env } of todos) {
      if (env.NFE_DEVOLUCAO_ENABLED !== "true" || env.NFE_NUMERACAO_V2_ENABLED !== "true") continue;
      for (const id of ids(env.NFE_DEVOLUCAO_CONFIG_IDS)) {
        expect(isDevolucaoAtiva(id, env), `${doc} ${id}`).toBe(true);
      }
    }
  });

  it("o estado de produção do roteiro liga a V2 e a devolução para a DLS, só no modelo 55", () => {
    const estado = blocos(ler(ROTEIRO), "dotenv")
      .map((b) => envDoBloco(b.corpo))
      .filter((env) => "NFE_NUMERACAO_V2_ENABLED" in env);
    expect(estado.length).toBeGreaterThan(0);
    for (const env of estado) {
      expect(isNumeracaoV2ParaEmissao(DLS, "55", "SEFAZ_DIRECT", env)).toBe(true);
      expect(isNumeracaoV2ParaEmissao(DLS, "65", "SEFAZ_DIRECT", env)).toBe(false);
      expect(isDevolucaoAtiva(DLS, env)).toBe(true);
    }
  });
});

// ─────────────────────────────── comandos dos docs ───────────────────────────────

describe("comandos copiáveis dos docs", () => {
  it("nenhum comando bash usa `restart all` ou `--update-env`", () => {
    for (const doc of DOCS) {
      for (const b of blocos(ler(doc), "bash")) {
        for (const linha of b.corpo.split("\n").map(semComentario)) {
          expect(linha, `${doc}: ${linha}`).not.toMatch(/restart\s+all\b/);
          expect(linha, `${doc}: ${linha}`).not.toMatch(/--update-env/);
        }
      }
    }
  });

  it("nenhuma frase dos docs cita `restart all` ou `--update-env` fora de negação", () => {
    // O texto corrido também é ordem: "Pode usar `pm2 restart all --update-env`" num
    // parágrafo ensina o que o bloco bash proíbe.
    let citadas = 0;
    for (const doc of DOCS) {
      for (const s of sentencas(ler(doc)).filter((x) => /restart\s+all\b|--update-env/.test(x))) {
        citadas++;
        expect(s, `${doc}: ${s}`).toMatch(NEGACAO);
      }
    }
    expect(citadas).toBeGreaterThan(0);
  });

  it("12-DEPLOY-VPS.md: o parágrafo do deploy padrão proíbe `--update-env` e `pm2 restart all`", () => {
    // No 12 a proibição só existe no texto corrido: o comentário do restart no bloco não a repete.
    expect(ler(DEPLOY)).toMatch(/Nunca `--update-env` e nunca `pm2 restart all`\./);
  });

  it("vigília: o nNF sai das posições 26–34 da chave (cUF 2, AAMM 4, CNPJ 14, mod 2, série 3)", () => {
    const sql = DOCS.flatMap((doc) => blocos(ler(doc), "sql").map((b) => b.corpo)).join("\n");
    const usos = [...sql.matchAll(/substr\(regexp_replace\("chaveAcesso",'\[\^0-9\]','','g'\),(\d+),(\d+)\)::int/g)];
    expect(usos.length).toBeGreaterThan(0);
    const chave = "42" + "2609" + "12345678000195" + "55" + "003" + "000000717" + "1" + "87654321" + "9";
    expect(chave).toHaveLength(44);
    for (const u of usos) {
      // substr do SQL é 1-based.
      expect(Number(chave.slice(Number(u[1]) - 1, Number(u[1]) - 1 + Number(u[2]))), u[0]).toBe(717);
    }
  });

  it.each([ROLLOUT, DEPLOY])("%s traz o deploy padrão num bloco bash", (doc) => {
    const bash = blocos(ler(doc), "bash").map((b) => b.corpo.split("\n").map(semComentario).join("\n"));
    expect(bash.some(temDeployPadrao)).toBe(true);
  });

  it("SQL de vigília e de gate compara timestamp do Prisma com NOW() em UTC", () => {
    // Coluna do Prisma é `timestamp` SEM fuso: comparar com NOW() cru depende do
    // TimeZone da sessão. O padrão do projeto é `(NOW() AT TIME ZONE 'UTC')`.
    for (const doc of DOCS) {
      for (const b of blocos(ler(doc), "sql")) {
        for (const linha of b.corpo.split("\n")) {
          if (/now\(\)/i.test(linha)) expect(linha, `${doc}: ${linha}`).toMatch(/NOW\(\) AT TIME ZONE 'UTC'/);
        }
      }
    }
  });
});

// ─────────────────────────── decisões de 25/09/2026 ───────────────────────────

describe("docs/fiscal-numeracao-v2.md — ligação e rollback", () => {
  const md = ler(DOC_V2);
  const rollout = secao(md, "Rollout e rollback");

  it("rollout por lista explícita nas DUAS allowlists, nunca \"*\"", () => {
    expect(rollout).toMatch(/lista expl[ií]cita/i);
    expect(rollout).toContain("NFE_NUMERACAO_V2_CONFIG_IDS");
    expect(rollout).toContain("NFE_DEVOLUCAO_CONFIG_IDS");
    expect(rollout).toMatch(/duas (listas|allowlists)/i);
    // A regra em si, no texto corrido: uma frase manda "nunca `*`" e nenhuma o autoriza.
    const regra = sentencas(subsecao(md, "Regra das listas"));
    expect(regra.some((s) => /\bnunca\b[^.\n]{0,20}(`\*`|"\*")/i.test(s))).toBe(true);
    for (const s of sentencas(rollout).filter((x) => AUTORIZA_ESTRELA.test(x))) {
      expect(s, s).toMatch(/\b(nunca|n[ãa]o)\b/i);
    }
  });

  it("Estado em produção: a devolução está ligada desde 24/09/2026", () => {
    const linha =
      subsecao(md, "Estado em produção")
        .split("\n")
        .find((l) => l.startsWith("- **Devolução:**")) ?? "";
    expect(linha).toMatch(/ligada desde 24\/09\/2026/);
    expect(linha).not.toMatch(/desligad/i);
  });

  it("Restart: só o dexo-api, nunca `--update-env` e nunca `pm2 restart all`", () => {
    const restart = subsecao(md, "Restart");
    expect(restart).toMatch(/\bnunca `--update-env`/i);
    expect(restart).toMatch(/\bnunca `pm2 restart all`/i);
    // Todo `pm2 restart` da seção que nomeia processo nomeia só o dexo-api: é o único que lê as flags.
    let nomeados = 0;
    for (const m of rollout.matchAll(/pm2 restart ([a-z][\w-]*(?: [a-z][\w-]*)*)/g)) {
      const processos = m[1].split(" ").filter((n) => n.startsWith("dexo-"));
      if (!processos.length) continue;
      nomeados++;
      expect(processos, m[0]).toEqual(["dexo-api"]);
    }
    expect(nomeados).toBeGreaterThan(0);
  });

  it("rollback nunca desliga NFE_NUMERACAO_V2_ENABLED", () => {
    // "desligar `NFE_NUMERACAO_V2_ENABLED`" ou "NFE_NUMERACAO_V2_ENABLED=false": só em frase negativa.
    const citam = sentencas(rollout).filter((s) =>
      /deslig\w*\s+(o\s+)?`?NFE_NUMERACAO_V2_ENABLED|NFE_NUMERACAO_V2_ENABLED=false/.test(s),
    );
    expect(citam.length).toBeGreaterThan(0);
    for (const s of citam) expect(s, s).toMatch(/\b(nunca|n[ãa]o)\b/i);
  });

  it("gate de pré-voo: reservas e notas em voo têm de dar zero antes do restart, que é só do dexo-api", () => {
    // O SQL do GATE (não o da vigília, que repete os estados) cobre os três estados vivos.
    const gate = blocos(subsecao(md, "Gate de pré-voo"), "sql").map((b) => b.corpo).join("\n");
    expect(gate).toContain("'EM_TRANSMISSAO','INCERTO','BLOQUEADO'");
    expect(gate).toContain("'VALIDATING','SIGNING','SENDING'");
    const restart = subsecao(md, "Restart");
    expect(restart).toContain("pm2 restart dexo-api");
    expect(restart).toMatch(/grep -oE "\^NFE_\[A-Z0-9_\]\+"/);
  });

  it("gate de rotina × gate estrito: rotina é o lease vivo (sem BLOQUEADO); ligar, ampliar e rollback usam o estrito", () => {
    const gate = subsecao(md, "Gate de pré-voo");
    const consultas = blocos(gate, "sql").flatMap((b) => b.corpo.split(";"));
    const rotina = consultas.filter((s) => /"leaseAte" > \(NOW\(\) AT TIME ZONE 'UTC'\)/.test(s));
    expect(rotina).toHaveLength(1);
    expect(rotina[0]).toContain("'EM_TRANSMISSAO','INCERTO'");
    expect(rotina[0]).not.toContain("BLOQUEADO");
    const frases = sentencas(gate);
    expect(frases.some((s) => /\bligar\b/i.test(s) && /rollback/.test(s) && /sem linhas/.test(s))).toBe(true);
    // Na rotina, as notas em voo e a inutilização pendente continuam valendo.
    expect(frases.some((s) => /rotina/i.test(s) && /VALIDATING|em voo/.test(s))).toBe(true);
  });

  it("config SEFAZ nova entra na lista no onboarding", () => {
    expect(rollout).toMatch(/onboarding/i);
  });

  it("fase A (bloco que o operador copia): numeração e devolução ligam JUNTAS, com a mesma lista; NFC-e e Focus ficam fora", () => {
    // Decisão do dono de 25/09/2026: a devolução liga junto com a numeração para toda a lista.
    const faseA = blocos(subsecao(md, "Ligação para as configs SEFAZ direto"), "dotenv").map((b) => envDoBloco(b.corpo));
    expect(faseA.length).toBe(1);
    for (const env of faseA) {
      expect(env.NFE_NUMERACAO_V2_ENABLED).toBe("true");
      expect(env.NFE_NUMERACAO_V2_MODELOS).toBe("55");
      expect(env.NFE_NUMERACAO_V2_FOCUS_ENABLED).toBe("false");
      expect(env.NFE_DEVOLUCAO_ENABLED).toBe("true");
      const lista = ids(env.NFE_NUMERACAO_V2_CONFIG_IDS);
      expect(ids(env.NFE_DEVOLUCAO_CONFIG_IDS)).toEqual(lista);
      expect(lista).toContain(DLS);
      expect(lista.length).toBeGreaterThan(1);
      for (const id of lista) {
        expect(isNumeracaoV2ParaEmissao(id, "55", "SEFAZ_DIRECT", env), id).toBe(true);
        expect(isNumeracaoV2ParaEmissao(id, "65", "SEFAZ_DIRECT", env), id).toBe(false);
        expect(isNumeracaoV2ParaEmissao(id, "55", "FOCUS_NFE", env), id).toBe(false);
        expect(isDevolucaoAtiva(id, env), id).toBe(true);
      }
    }
  });

  it("a proteção de rollback da devolução por config sobe ANTES da fase A, e não sobra fase C", () => {
    const lig = subsecao(md, "Ligação para as configs SEFAZ direto");
    const faseA = lig.search(/\*\*Fase A/);
    const protecao = lig.search(/prote[çc][ãa]o de rollback da devolu[çc][ãa]o por config/);
    expect(faseA).toBeGreaterThan(-1);
    expect(protecao).toBeGreaterThan(-1);
    expect(protecao).toBeLessThan(faseA);
    expect(lig).not.toMatch(/\*\*Fase C/);
    // A verificação pós-ligação espera a devolução ligada na config recém-incluída.
    const incluida = sentencas(lig).find((s) => /rec[ée]m-inclu[íi]da/.test(s)) ?? "";
    expect(incluida).toMatch(/`true`, `false` e `true`/);
  });

  it("modo ITEM: provado em homologação (SVRS, 25/09/2026); primeira devolução por autorizadora vigiada; a data não se antecipa", () => {
    const lig = subsecao(md, "Ligação para as configs SEFAZ direto");
    const frases = sentencas(lig);
    expect(frases.some((s) => /342260000975434/.test(s) && /homologa[çc][ãa]o/.test(s) && /SVRS/.test(s))).toBe(true);
    expect(
      frases.some(
        (s) => ["GO", "MG", "PR", "SP"].every((uf) => new RegExp(`\\b${uf}\\b`).test(s)) && /225/.test(s) && /321/.test(s) && /1010/.test(s),
      ),
    ).toBe(true);
    // Com a devolução na lista inteira, antecipar o ITEM valeria para todas: a variável é global.
    const refItem = frases.filter((s) => /NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE/.test(s));
    expect(refItem.some((s) => /global/i.test(s))).toBe(true);
    for (const s of refItem) expect(s, s).not.toMatch(/NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE=</);
  });

  it("inutilização confirmada: a nota que segurava o número volta a rascunho e recebe número novo", () => {
    const item =
      secao(md, "Situação e descarte")
        .split("\n")
        .find((l) => l.startsWith("- **Inutilização.**")) ?? "";
    expect(item).toMatch(/confirmarDescarteNumeros: true/);
    expect(item).toMatch(/volta a rascunho/);
    expect(item).toMatch(/n[úu]mero provis[óo]rio/);
    expect(item).toMatch(/n[úu]mero novo/);
  });

  it("inutilização: o item lista, estado por estado, o que avaliarFaixa bloqueia (400) e o que pede confirmação (409)", () => {
    const item =
      secao(md, "Situação e descarte")
        .split("\n")
        .find((l) => l.startsWith("- **Inutilização.**")) ?? "";
    const frases = sentencas(item);
    const bloqueio = frases.filter((s) => /FAIXA_COM_NUMERO_VIVO/.test(s)).join(" ");
    const descarte = frases.filter((s) => /NUMERACAO_CONFIRMAR_DESCARTE/.test(s)).join(" ");
    expect(bloqueio).toMatch(/\b400\b/);
    expect(bloqueio).toMatch(/qualquer outra/i);
    const cita = (texto: string, v: string) => texto.includes(`\`${v}\``);
    const faixa = { ini: 5, fim: 5 };
    for (const estado of ESTADOS_RESERVA) {
      const { acao } = avaliarFaixa({ ...faixa, linhas: [], reservas: [{ numero: 5, estado, id: "r1", nfeId: null }] });
      if (acao === "BLOQUEAR") expect(cita(bloqueio, estado), `reserva ${estado} bloqueia`).toBe(true);
      else expect(cita(bloqueio, estado), `reserva ${estado} não bloqueia`).toBe(false);
      if (acao === "CONFIRMAR_DESCARTE") expect(cita(descarte, estado), `reserva ${estado} pede confirmação`).toBe(true);
    }
    // Os status da nota vêm do comentário da coluna no schema (a coluna é String).
    const schema = ler("prisma/schema.prisma");
    const status = (/^\s*status\s+String\s*\/\/\s*(DRAFT\b[^\n]*)$/m.exec(schema)?.[1] ?? "").split("|").map((s) => s.trim());
    expect(status).toContain("AUTHORIZED");
    for (const st of status) {
      const { acao } = avaliarFaixa({ ...faixa, linhas: [{ id: "n1", numero: 5, status: st }], reservas: [] });
      expect(cita(bloqueio, st), `nota ${st} ${acao === "BLOQUEAR" ? "bloqueia" : "não bloqueia"}`).toBe(acao === "BLOQUEAR");
    }
    // BLOQUEADO também entra no descarte da inutilização: a conferência vale aqui como no descartar-bloqueado.
    expect(frases.some((s) => /`BLOQUEADO`/.test(s) && /conferir/i.test(s) && /autorizad/.test(s))).toBe(true);
  });
});

describe("docs/fiscal-numeracao-v2.md — rollback de uma config", () => {
  const md = ler(DOC_V2);
  const rb = subsecao(md, "Rollback de uma config");

  it("o pré-voo filtrado pela config lista as reservas vivas e as em voo", () => {
    const sql = blocos(rb, "sql")
      .map((b) => b.corpo)
      .join("\n");
    const daReserva = sql.split(";").filter((s) => /"NfeNumeroReserva"/.test(s));
    expect(daReserva.length).toBeGreaterThan(0);
    for (const s of daReserva) {
      expect(s).toMatch(/"companyFiscalConfigId"='<X>'/);
      const estados = /"estado" IN \(([^)]*)\)/.exec(s)?.[1] ?? "";
      for (const e of ESTADOS_PRE_VOO_CONFIG) expect(estados, e).toContain(`'${e}'`);
    }
  });

  it("o passo 2 tira a config das duas listas, cada uma pelo nome, e proíbe desligar o global", () => {
    const passo2 = rb.split("\n").find((l) => /^2\. /.test(l)) ?? "";
    expect(passo2).toContain("NFE_NUMERACAO_V2_CONFIG_IDS");
    expect(passo2).toContain("NFE_DEVOLUCAO_CONFIG_IDS");
    expect(passo2).toMatch(/\*\*Nunca\*\* `NFE_NUMERACAO_V2_ENABLED=false`/);
  });

  it("o rollback usa o gate ESTRITO (BLOQUEADO de qualquer config); relaxar é decisão do dono", () => {
    // Plano de 25/09, §5.1: "para ligar ou fazer rollback, a versão estrita (inclui BLOQUEADO)".
    const frases = sentencas(rb);
    expect(frases.some((s) => /gate estrito/i.test(s) && /BLOQUEADO/.test(s))).toBe(true);
    for (const s of frases.filter((x) => /BLOQUEADO/.test(x) && /(outra|demais) config/i.test(x))) {
      expect(s, s).not.toMatch(/n[ãa]o (impede|trava|segura)/i);
    }
    expect(frases.some((s) => /BLOQUEADO/.test(s) && /decis[ãa]o do dono/i.test(s))).toBe(true);
    expect(subsecao(md, "Gate de pré-voo")).not.toMatch(/n[ãa]o trave uma emerg[êe]ncia/);
    expect(ler(ROLLOUT)).not.toMatch(/does not hold the rollback back/);
  });

  it("o rollback global volta as DUAS linhas guardadas, e o backup guarda as duas", () => {
    const global = sentencas(rb.slice(rb.indexOf("**Rollback global:**")))[0] ?? "";
    expect(global).toContain("NFE_NUMERACAO_V2_CONFIG_IDS");
    expect(global).toContain("NFE_DEVOLUCAO_CONFIG_IDS");
    const backup = sentencas(subsecao(md, "Restart")).find((s) => /guardar/.test(s)) ?? "";
    expect(backup).toContain("NFE_NUMERACAO_V2_CONFIG_IDS");
    expect(backup).toContain("NFE_DEVOLUCAO_CONFIG_IDS");
  });
});

describe("vigília — transição de estado desde a ligação", () => {
  it("toda consulta que compara com a ligação usa \"updatedAt\" (reserva antiga que muda de estado conta)", () => {
    let comLigacao = 0;
    for (const doc of DOCS) {
      for (const b of blocos(ler(doc), "sql")) {
        for (const s of b.corpo.split(";").filter((x) => x.includes("'<ligação UTC>'"))) {
          comLigacao++;
          expect(s, `${doc}: ${s}`).toMatch(/"updatedAt" >= '<ligação UTC>'/);
          expect(s, `${doc}: ${s}`).not.toMatch(/"createdAt" >= '<ligação UTC>'/);
        }
      }
    }
    expect(comLigacao).toBeGreaterThanOrEqual(2);
    // A consulta de ABANDONADO/INUTILIZADO/CONSUMIDO_EXTERNO é a que a regra mira.
    const abandonadas = blocos(ler(DOC_V2), "sql")
      .flatMap((b) => b.corpo.split(";"))
      .filter((s) => /'ABANDONADO'/.test(s) && s.includes("'<ligação UTC>'"));
    expect(abandonadas).toHaveLength(1);
    // O resumo em inglês do 05 diz o mesmo critério.
    const vigil05 = ler(ROLLOUT)
      .split("\n")
      .find((l) => l.startsWith("- Vigil at 24 h and 48 h")) ?? "";
    expect(vigil05).toMatch(/ABANDONADO[^;]*`updatedAt`/);
  });
});

describe("05-testes-rollout.md §6.3 — linhas substituídas apontam o status de 25/09", () => {
  const tabela = (() => {
    const md = ler(ROLLOUT);
    const ini = md.indexOf("### 6.3 Flag sequence");
    return md.slice(ini, md.indexOf("### 6.4", ini));
  })();
  const linha = (n: number) => tabela.split("\n").find((l) => l.startsWith(`| ${n} |`)) ?? "";

  it.each([3, 9])("a linha %i remete ao \"Status on 25/09/2026\"", (n) => {
    expect(linha(n)).toMatch(/superseded[^|]*Status on 25\/09\/2026/i);
  });

  it("a linha 6 registra a substituição do canário de 3 configs", () => {
    expect(linha(6)).toMatch(/Replaced on 25\/09\/2026/);
    expect(linha(6)).not.toMatch(/then `\*`/);
  });
});

describe("devolução ligada e faixa 8–10 da Kiko", () => {
  it("nenhum doc diz que a devolução está desligada", () => {
    for (const doc of DOCS) {
      for (const linha of ler(doc).split("\n")) {
        expect(linha, `${doc}: ${linha}`).not.toMatch(/NFE_DEVOLUCAO_ENABLED=false/);
        expect(linha, `${doc}: ${linha}`).not.toMatch(/NFE_DEVOLUCAO_ENABLED`[^.\n]*desligad/);
      }
    }
  });

  it("nenhum doc recomenda (nem dá prazo para) inutilizar a faixa 8–10", () => {
    for (const doc of DOCS) {
      for (const linha of ler(doc).split("\n")) {
        const recomenda = /8\s*[–-]\s*10/.test(linha) && /inutiliz[^\n]{0,40}(dispon[ií]vel|at[ée] 10\/10|prazo)/i.test(linha);
        expect(recomenda, `${doc}: ${linha}`).toBe(false);
      }
    }
  });

  it("docs/fiscal-numeracao-v2.md diz para NÃO inutilizar os números 8–10 da série 3 da Kiko", () => {
    const frases = sentencas(ler(DOC_V2)).filter((s) => /8\s*[–-]\s*10/.test(s) && /Kiko/.test(s));
    expect(frases.some((s) => /\b(n[ãa]o|nunca)\b[^.]{0,60}inutiliz/i.test(s))).toBe(true);
  });
});

describe("roteiro Focus — trilha própria", () => {
  const md = ler(ROTEIRO);

  it("lista os pré-requisitos antes de qualquer NFE_NUMERACAO_V2_FOCUS_ENABLED=true", () => {
    expect(md).toMatch(/218\/420/);
    expect(md).toMatch(/206\/563/);
    expect(md).toMatch(/allowlist pr[óo]pria/i);
    expect(md).toMatch(/troca de token/i);
    expect(md).toMatch(/homologa[çc][ãa]o/i);
    expect(md).toMatch(/can[áa]rio/i);
  });

  it("proíbe a sub-flag Focus com `NFE_NUMERACAO_V2_CONFIG_IDS=*`", () => {
    expect(sentencas(md).some((s) => /\bnunca\b/i.test(s) && /NFE_NUMERACAO_V2_CONFIG_IDS=\*/.test(s))).toBe(true);
  });

  it("o exemplo de acrescentar config parte da lista ATUAL (redefinir com um id tira as demais da V2)", () => {
    const exemplos = blocos(md, "dotenv")
      .map((b) => envDoBloco(b.corpo))
      .filter((env) => "NFE_NUMERACAO_V2_CONFIG_IDS" in env && !("NFE_NUMERACAO_V2_ENABLED" in env));
    expect(exemplos.length).toBeGreaterThan(0);
    for (const env of exemplos) expect(ids(env.NFE_NUMERACAO_V2_CONFIG_IDS)[0]).toBe("<lista atual>");
  });
});

describe("handoff — canário de 3 configs substituído", () => {
  it.each([ROLLOUT, DEPLOY])("%s registra a lista explícita e a vigília de 24 h/48 h", (doc) => {
    const md = ler(doc);
    expect(md).toMatch(/lista expl[ií]cita|explicit list/i);
    expect(md).toMatch(/24\s*h/);
    expect(md).toMatch(/48\s*h/);
  });

  it("nenhum doc manda ampliar para \"*\"", () => {
    for (const doc of DOCS) {
      expect(ler(doc), doc).not.toMatch(/(then|depois|e então)\s+`\*`/i);
    }
  });

  it("nenhum doc deixa a devolução para uma fase C: pela decisão do dono ela liga junto", () => {
    for (const doc of DOCS) expect(ler(doc), doc).not.toMatch(/\b(fase|phase) C\b/i);
  });

  it.each([ROLLOUT, DEPLOY])("%s registra que a devolução liga junto com a numeração", (doc) => {
    expect(ler(doc)).toMatch(/devolu[çc][ãa]o (liga junto com a numera[çc][ãa]o|goes on together with numbering)/i);
  });
});
