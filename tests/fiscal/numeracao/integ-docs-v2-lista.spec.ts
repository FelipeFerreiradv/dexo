/**
 * Integração G2 × G5 — o runbook da V2 tem de dizer o que o CÓDIGO faz, e o que o plano manda.
 *
 * 1) Passo 4 da ligação ("Aplicar e verificar"): o runbook mandava conferir que `GET /fiscal/nfe`
 *    de um tenant recém-incluído "traz a chave `numeracao`". Com o A2 (G2, metadata.ts) a nota
 *    que nunca teve reserva sai SEM a chave e com `legadoV1:true` — e num tenant recém-incluído
 *    todas são assim. Lido ao pé da letra, o critério falhava logo depois de uma ligação correta
 *    e empurrava o operador para um rollback à toa. O teste roda o `attachFiscalLista` de verdade
 *    (prisma simulado) e amarra a frase do doc à chave que ele produz.
 * 2) "Regra das listas": uma regra nova ("config com números usados fora do Dexo só entra depois
 *    de o cliente informar o último número") contrariava a decisão do dono de 25/09 (contador
 *    atrás não impede: trava de 3 + card de ajuste) e tirava da ligação boa parte das 22. Fica
 *    fora só a config inativa, e o passo 2 traz o SQL somente leitura que gera a lista.
 * 3) Frases de operação que um mutante invertia sem nenhum teste cair (revisão do G5): o `pm2 env`
 *    tem de voltar VAZIO, o gate estrito conta inutilização PENDENTE, a vigília pega reserva
 *    PARADA (updatedAt ANTERIOR a 15 min), o restart do 12 nomeia só os processos certos e os
 *    comentários novos do ecosystem e do .env.example nunca mandam `restart all`/`--update-env`.
 */
import { readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  configs: [] as Array<{ id: string; providerName: string; isDefault: boolean; temToken: boolean }>,
}));
// O ledger está vazio: é o tenant recém-incluído, com todas as notas vindas do V1.
vi.mock("../../../app/lib/prisma", () => ({
  default: {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes(`FROM "CompanyFiscalConfig"`)) return h.configs;
      if (sql.includes(`FROM "NfeNumeroReserva"`)) return [];
      throw new Error("consulta inesperada: " + sql);
    },
  },
}));

import { attachFiscalLista } from "../../../app/fiscal/numeracao/metadata";

const ler = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const DOC_V2 = "docs/fiscal-numeracao-v2.md";
const DEPLOY = "docs/handoff-nfe-evolucao/12-DEPLOY-VPS.md";
const VIP_INATIVA = "cmrmh6iwp01i418u6r4yux253";
const CFC = "cfg-recem-incluida";

const sentencas = (texto: string) => texto.split(/(?<=[.!?])\s+|\n/);
function subsecao(md: string, titulo: string): string {
  const ini = md.indexOf(`\n### ${titulo}`);
  if (ini < 0) return "";
  const resto = md.slice(ini + 5);
  const fim = resto.search(/\n##(#)? /);
  return fim < 0 ? md.slice(ini) : md.slice(ini, ini + 5 + fim);
}
function blocosSql(md: string): string[] {
  return [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
}
/** Item numerado `n.` de uma lista, com as linhas indentadas que vêm depois dele. */
function passo(md: string, n: number): string {
  const linhas = md.split("\n");
  const ini = linhas.findIndex((l) => l.startsWith(`${n}. `));
  if (ini < 0) return "";
  const fim = linhas.findIndex((l, i) => i > ini && /^\d+\. /.test(l));
  return linhas.slice(ini, fim < 0 ? undefined : fim).join("\n");
}

beforeEach(() => {
  vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
  vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFC);
  vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
  vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
  h.configs = [{ id: CFC, providerName: "SEFAZ_DIRECT", isDefault: true, temToken: false }];
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("passo 4 da ligação × attachFiscalLista (A2)", () => {
  const lig = subsecao(ler(DOC_V2), "Ligação para as configs SEFAZ direto");

  it("a nota antiga de um tenant recém-incluído sai sem `numeracao` e com legadoV1 — e o passo 4 manda esperar exatamente isso", async () => {
    // O que o código entrega hoje para a nota V1 de uma config que acabou de entrar na lista.
    const [n] = await attachFiscalLista("tenant", [{ id: "antiga", companyFiscalConfigId: CFC, modelo: "55", status: "AUTHORIZED" }]);
    expect(n).not.toHaveProperty("numeracao");
    expect(n).toMatchObject({ legadoV1: true });

    const frase = sentencas(passo(lig, 4)).find((s) => /GET \/fiscal\/nfe`/.test(s)) ?? "";
    expect(frase, "o passo 4 cita o GET /fiscal/nfe").not.toBe("");
    expect(frase).toContain("`legadoV1: true`");
    expect(frase).toMatch(/\bsem\b[^.]*a chave `numeracao`/i);
    // O critério antigo, que um operador leria como "a inclusão não pegou".
    expect(passo(lig, 4)).not.toMatch(/traz a chave `numeracao`/);
  });

  it("a descrição das respostas V2 (Focus/lista) distingue `numeracao: null` de chave ausente com legadoV1", () => {
    const md = ler(DOC_V2);
    const par = md.split("\n").find((l) => l.startsWith("Respostas V2 ")) ?? "";
    expect(par).toMatch(/GET \/fiscal\/nfe/);
    expect(par).toContain("`legadoV1: true`");
    expect(par).toMatch(/\bsem\b\*{0,2} a chave/);
  });
});

describe("Regra das listas e passo 2: fiéis ao plano de 25/09 (22 configs, fora só a inativa)", () => {
  const md = ler(DOC_V2);
  const regra = subsecao(md, "Regra das listas");
  const lig = subsecao(md, "Ligação para as configs SEFAZ direto");

  it("contador atrás da SEFAZ NÃO impede a entrada: trava de 3 + card de ajuste; só a inativa fica fora", () => {
    // A regra que o revisor derrubou condicionava a entrada ao último número informado pelo cliente.
    for (const s of sentencas(regra).filter((x) => /(informar|informe)[^.]*[úu]ltimo n[úu]mero/i.test(x))) {
      expect(s, s).toContain(VIP_INATIVA);
    }
    const contador = sentencas(regra).find((s) => /SEQUENCIA_ATRAS_DA_SEFAZ/.test(s)) ?? "";
    expect(contador).toMatch(/\bn[ãa]o\b\*{0,2} impede/i);
    expect(contador).toMatch(/Ajustar próximo número/);
    expect(contador).toMatch(/\b3\b/);
    // É o card para onde a própria mensagem do 409 manda (G1, B6).
    expect(ler("app/fiscal/numeracao/numeracao.service.ts")).toMatch(/Ajustar próximo número/);
  });

  it("o passo 2 traz o SQL somente leitura da lista, sem a inativa, com a conferência de provedor e o total de 22", () => {
    const p2 = passo(lig, 2);
    const [sql] = blocosSql(p2);
    expect(sql, "bloco sql no passo 2").toBeTruthy();
    expect(sql.trim().startsWith("BEGIN READ ONLY;")).toBe(true);
    expect(sql.trim().endsWith("ROLLBACK;")).toBe(true);
    expect(sql).toMatch(/string_agg\("id"/);
    expect(sql).toContain(`"providerName"='SEFAZ_DIRECT'`);
    expect(sql).toContain(`"id"<>'${VIP_INATIVA}'`);
    expect(sql).toContain(`IS DISTINCT FROM 'SEFAZ_DIRECT'`);
    // Nada de escrita no bloco que o operador copia.
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP|TRUNCATE)\b/i);
    expect(p2).toMatch(/\b22\b/);
    expect(p2).toMatch(/sem linhas/);
  });
});

describe("vigília × motivos de ABANDONADO gravados pelo G1", () => {
  // A regra de parada da vigília ("achado sem explicação ⇒ tirar a config da lista") lê o `motivo`.
  // Os motivos das saídas novas (descarte do BLOQUEADO, inutilização confirmada) e o da exclusão
  // são ação CONFIRMADA na tela: sem estarem no runbook, a vigília os leria como anomalia.
  const vig = passo(subsecao(ler(DOC_V2), "Ligação para as configs SEFAZ direto"), 5);
  const servico = ler("app/fiscal/numeracao/numeracao.service.ts");

  it.each(["RASCUNHO_EXCLUIDO", "NUMERO_RETIDO_DESCARTADO", "INUTILIZACAO_CONFIRMADA"])("%s: gravado pelo serviço e explicado na vigília", (motivo) => {
    expect(servico).toContain(`"${motivo}"`);
    const frase = sentencas(vig).find((s) => s.includes(`\`${motivo}\``)) ?? "";
    expect(frase, `vigília cita ${motivo}`).not.toBe("");
    expect(frase).toMatch(/n[ãa]o achado sem explica[çc][ãa]o/);
  });

  it("a consulta da vigília traz a coluna `motivo`", () => {
    const sql = blocosSql(vig).join("\n").split(";").find((s) => /'ABANDONADO'/.test(s)) ?? "";
    expect(sql).toContain(`"motivo"`);
  });
});

describe("frases de operação que a revisão do G5 inverteu sem teste cair", () => {
  const md = ler(DOC_V2);

  it("Restart: o `pm2 env` tem de voltar VAZIO (flag presa no dump anula o rollback pelo .env)", () => {
    const frase = sentencas(subsecao(md, "Restart")).find((s) => /pm2 env/.test(s)) ?? "";
    expect(frase).toMatch(/tem de voltar vazio/);
    expect(frase).not.toMatch(/tem de listar/);
  });

  it("gate estrito: a terceira consulta conta inutilização PENDENTE dos últimos 15 min", () => {
    const sql = blocosSql(subsecao(md, "Gate de pré-voo")).join("\n");
    const inut = sql.split(";").find((s) => /"NfeInutilizacao"/.test(s)) ?? "";
    expect(inut).toContain(`"status"='PENDENTE'`);
    expect(inut).toMatch(/"createdAt" > \(NOW\(\) AT TIME ZONE 'UTC'\) - interval '15 minutes'/);
  });

  it("vigília: reserva PARADA é a de updatedAt ANTERIOR a 15 min (o `>` pegaria as recém-mexidas)", () => {
    const sql = blocosSql(subsecao(md, "Ligação para as configs SEFAZ direto")).join("\n");
    const parada = sql.split(";").find((s) => /'EM_TRANSMISSAO','INCERTO','BLOQUEADO'/.test(s) && /interval '15 minutes'/.test(s)) ?? "";
    expect(parada).toMatch(/"updatedAt" < \(NOW\(\) AT TIME ZONE 'UTC'\) - interval '15 minutes'/);
  });

  it("12-DEPLOY: o restart do deploy padrão nomeia exatamente dexo-api e dexo-frontend", () => {
    const restarts = [...ler(DEPLOY).matchAll(/^\s*pm2 restart ([^#\n]*)/gm)].map((m) => m[1].trim());
    expect(restarts.length).toBeGreaterThan(0);
    for (const r of restarts) expect(r.split(/\s+/), r).toEqual(["dexo-api", "dexo-frontend"]);
  });

  // Os comentários NOVOS (deploy padrão do ecosystem, bloco NF-e do .env.example): toda frase que
  // cita `restart all` ou `--update-env` tem de ser negativa. O histórico do incidente de 23/07
  // no topo do ecosystem ("o deploy usava ...") fica de fora de propósito.
  const semMarcadorDeComentario = (t: string) => t.split("\n").map((l) => l.replace(/^\s*(\*|\/\/|#)\s?/, "")).join(" ");
  const trechos: Array<[string, string]> = (() => {
    const eco = ler("ecosystem.config.cjs");
    const deploy = eco.slice(eco.indexOf("Deploy padrão"), eco.indexOf("Comandos/paths"));
    const stats = eco.slice(eco.indexOf("O agendamento diário"), eco.indexOf("autorestart: false"));
    const env = ler(".env.example");
    const nfe = env.slice(env.indexOf("# Evolução NF-e"), env.indexOf("NFE_NUMERACAO_V2_LEASE_PRE_ENVIO_MS"));
    return [["ecosystem: deploy padrão", deploy], ["ecosystem: dexo-catalog-stats", stats], [".env.example: bloco NF-e", nfe]];
  })();

  it.each(trechos)("%s: nenhuma frase manda `restart all` ou `--update-env`", (_nome, trecho) => {
    expect(trecho.length).toBeGreaterThan(40);
    const frases = sentencas(semMarcadorDeComentario(trecho)).filter((s) => /restart all|--update-env/.test(s));
    for (const s of frases) expect(s, s).toMatch(/\b(nunca|NUNCA|n[ãa]o|sem)\b/);
  });

  it("os trechos novos citam as proibições (senão o teste acima passaria vazio)", () => {
    const todos = trechos.map(([, t]) => semMarcadorDeComentario(t)).join(" ");
    expect(todos).toMatch(/NUNCA `pm2 restart all`/);
    expect(todos).toMatch(/sem --update-env/);
  });
});
