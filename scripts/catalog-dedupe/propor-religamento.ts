/**
 * PLANO DE RELIGAMENTO — SOMENTE LEITURA.
 *
 * Le a lista de anuncios que estao vendendo outra peca (saida de
 * `medir-vinculo-anuncio-errado.ts --todos` + o detalhe do ML) e diz, para cada
 * um, se da para religar e por que nao, aplicando `lib/veredito-religamento.ts`.
 *
 * Nao escreve no banco: toda consulta roda com
 * `default_transaction_read_only = on`. Nao fala com marketplace: o detalhe do
 * anuncio ja veio do medidor. Nao renova token.
 *
 * Uso (na VPS, a partir de /var/www/dexo):
 *   npx tsx <caminho>/propor-religamento.ts --entrada=/root/auditoria-fusao-18-09
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  decidirReligamento,
  LIMIARES,
  type Anuncio,
  type Candidato,
  type Contexto,
  type Decisao,
} from "./lib/veredito-religamento";

const SEPARADOR = "\u0001";

type Argumentos = { entrada: string; saida: string; env: string };

function lerArgumentos(): Argumentos {
  const bruto = new Map<string, string>();
  for (const argumento of process.argv.slice(2)) {
    const par = /^--([^=]+)(?:=(.*))?$/.exec(argumento);
    if (par) bruto.set(par[1], par[2] ?? "1");
  }
  const entrada = bruto.get("entrada") ?? "/root/auditoria-fusao-18-09";
  return { entrada, saida: bruto.get("saida") ?? entrada, env: bruto.get("env") ?? "/var/www/dexo/.env" };
}

function conexaoDeLeitura(caminhoEnv: string): Record<string, string> {
  const texto = fs.readFileSync(caminhoEnv, "utf8");
  const achado = /^DIRECT_URL="?([^"\r\n]+)"?/m.exec(texto);
  if (!achado) throw new Error("DIRECT_URL nao encontrada no .env informado.");
  const url = new URL(achado[1]);
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.replace(/^\//, "") || "postgres",
    PGSSLMODE: url.searchParams.get("sslmode") ?? "require",
  };
}

function consultar(conexao: Record<string, string>, sql: string): string[][] {
  const saida = execFileSync("psql", ["-X", "-A", "-F", SEPARADOR, "-t", "-q", "-v", "ON_ERROR_STOP=1"], {
    input: `SET default_transaction_read_only = on;\nSET statement_timeout='300s';\n${sql}`,
    env: { ...process.env, ...conexao },
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  return saida.split("\n").filter((l) => l.trim().length > 0).map((l) => l.split(SEPARADOR));
}

const aspas = (v: string) => `'${String(v).replace(/'/g, "''")}'`;
const normalizar = (s: string) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const palavras = (s: string) => new Set(normalizar(s).split(" ").filter((t) => t.length > 2));
function semelhanca(a: string, b: string): number {
  const A = palavras(a), B = palavras(b);
  if (!A.size || !B.size) return 0;
  let comuns = 0;
  for (const t of A) if (B.has(t)) comuns += 1;
  return comuns / (A.size + B.size - comuns);
}
const idDaFoto = (u: string) => {
  const m = /\/D_([A-Za-z0-9-]+_\d+)-/.exec(u || "");
  return m ? m[1].toUpperCase() : null;
};

type Peca = { id: string; sku: string; nome: string; disponivel: number; recebivel: boolean; tenant: string };

function principal(): void {
  const argumentos = lerArgumentos();
  const conexao = conexaoDeLeitura(argumentos.env);
  const errados = JSON.parse(fs.readFileSync(path.join(argumentos.entrada, "vinculo-anuncio-errado.json"), "utf8")).errados as Array<{
    externo: string; contaId: string; conta: string; produtoId: string; sku: string; peca: string;
  }>;
  const detalhe = JSON.parse(fs.readFileSync(path.join(argumentos.entrada, "detalhe-dos-566.json"), "utf8")) as Record<
    string,
    { titulo: string; sku: string | null; quantidade: number; status: string; fotos: string[]; link: string }
  >;

  const tenantDaConta = new Map<string, string>(
    consultar(
      conexao,
      `SELECT ma.id, COALESCE(u."parentUserId", u.id) FROM "MarketplaceAccount" ma
         JOIN "User" u ON u.id = ma."userId"
        WHERE ma.id IN (${[...new Set(errados.map((e) => e.contaId))].map(aspas).join(",")});`,
    ).map((linha) => [linha[0], linha[1]] as [string, string]),
  );
  const tenants: string[] = [...new Set([...tenantDaConta.values()])];

  // As colunas de override vem do banco, nao de uma lista fixa: sao 22 hoje e a
  // proxima que nascer entraria em silencio na lista fixa.
  const colunasOverride = consultar(
    conexao,
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'ProductListing' AND column_name LIKE '%Override';`,
  ).map((r) => r[0]);
  const temOverride = colunasOverride.map((c) => `"${c}" IS NOT NULL`).join(" OR ");

  const listingsComOverride = new Set(
    consultar(
      conexao,
      `SELECT pl."externalListingId" FROM "ProductListing" pl
        WHERE pl."externalListingId" IN (${errados.map((e) => aspas(e.externo)).join(",")})
          AND (${temOverride});`,
    ).map((r) => r[0]),
  );

  const catalogo = new Map<string, { porToken: Map<string, Peca[]>; porFoto: Map<string, Peca[]>; porId: Map<string, Peca> }>();
  for (const tenant of tenants) {
    const linhas = consultar(
      conexao,
      `SELECT p.id, COALESCE(p.sku,''), p.name, (p.stock - p."reservedStock"),
              EXISTS (SELECT 1 FROM "ReceivableItem" ri JOIN "Receivable" r ON r.id = ri."receivableId"
                       WHERE ri."productId" = p.id AND r.status = 'PENDENTE'),
              COALESCE(array_to_string(p."imageUrls", ' '), '')
         FROM "Product" p JOIN "User" u ON u.id = p."userId"
        WHERE COALESCE(u."parentUserId", u.id) = ${aspas(tenant)};`,
    );
    const porToken = new Map<string, Peca[]>();
    const porFoto = new Map<string, Peca[]>();
    const porId = new Map<string, Peca>();
    for (const [id, sku, nome, disponivel, recebivel, urls] of linhas) {
      const peca: Peca = { id, sku, nome, disponivel: Number(disponivel), recebivel: recebivel === "t", tenant };
      porId.set(id, peca);
      for (const token of palavras(nome)) porToken.set(token, [...(porToken.get(token) ?? []), peca]);
      for (const foto of new Set((urls || "").split(" ").map(idDaFoto).filter(Boolean) as string[])) {
        porFoto.set(foto, [...(porFoto.get(foto) ?? []), peca]);
      }
    }
    catalogo.set(tenant, { porToken, porFoto, porId });
  }

  // Frequencia do seller_sku no tenant: e ela que separa identidade de rotulo
  // de caixa. Conta nos ANUNCIOS, nao nos produtos.
  const usoDoSku = new Map<string, number>();
  for (const tenant of tenants) {
    for (const [sku, n] of consultar(
      conexao,
      `SELECT COALESCE(p.sku,''), count(*)::text FROM "Product" p JOIN "User" u ON u.id = p."userId"
        WHERE COALESCE(u."parentUserId", u.id) = ${aspas(tenant)} AND p.sku IS NOT NULL
        GROUP BY 1;`,
    )) {
      usoDoSku.set(`${tenant}|${sku}`, Number(n));
    }
  }

  const anunciosVivosPorProdutoEConta = new Set(
    consultar(
      conexao,
      `SELECT pl."productId" || '|' || pl."marketplaceAccountId" FROM "ProductListing" pl
         JOIN "Product" p ON p.id = pl."productId" JOIN "User" u ON u.id = p."userId"
        WHERE pl.status = 'active' AND COALESCE(u."parentUserId", u.id) IN (${tenants.map(aspas).join(",")});`,
    ).map((r) => r[0]),
  );

  const resultados: Array<Decisao & { externo: string; conta: string; link: string; tituloNoMl: string; de: string; para: string | null }> = [];
  for (const e of errados) {
    const d = detalhe[e.externo];
    const tenant = tenantDaConta.get(e.contaId);
    const cat = tenant ? catalogo.get(tenant) : undefined;
    if (!d || !tenant || !cat) continue;

    const anuncio: Anuncio = {
      externo: e.externo,
      titulo: d.titulo,
      sku: d.sku,
      statusNoMl: d.status,
      quantidadeNoMl: Number(d.quantidade ?? 0),
      contaId: e.contaId,
      tenantDaConta: tenant,
    };

    // candidatos por titulo
    const vistos = new Map<string, Peca>();
    for (const token of palavras(d.titulo)) for (const peca of cat.porToken.get(token) ?? []) vistos.set(peca.id, peca);
    const ranking = [...vistos.values()]
      .filter((p) => p.id !== e.produtoId)
      .map((p) => ({ peca: p, nota: semelhanca(d.titulo, p.nome) }))
      .sort((a, b) => b.nota - a.nota);

    // candidato por foto, como canal independente
    const contagemPorFoto = new Map<Peca, number>();
    let maiorUsoDaFoto = 0;
    for (const foto of new Set((d.fotos ?? []).map((f) => String(f).toUpperCase()))) {
      const donos = cat.porFoto.get(foto) ?? [];
      maiorUsoDaFoto = Math.max(maiorUsoDaFoto, donos.length);
      for (const peca of donos) {
        if (peca.id === e.produtoId) continue;
        contagemPorFoto.set(peca, (contagemPorFoto.get(peca) ?? 0) + 1);
      }
    }
    const porFotoOrdenado = [...contagemPorFoto.entries()].sort((a, b) => b[1] - a[1]);
    const campeaoDaFoto = porFotoOrdenado[0]?.[0] ?? null;

    const campeao = ranking[0]?.peca ?? campeaoDaFoto ?? null;
    const contexto: Contexto = {
      notaDoCampeao: campeao ? semelhanca(d.titulo, campeao.nome) : 0,
      notaDoSegundo: ranking.length > 1 ? ranking[1].nota : null,
      notaDoAtual: semelhanca(d.titulo, e.peca),
      canalApontaOutroProduto: Boolean(campeao && campeaoDaFoto && campeaoDaFoto.id !== campeao.id),
    };

    const candidato: Candidato | null = campeao
      ? {
          id: campeao.id,
          nome: campeao.nome,
          sku: campeao.sku || null,
          tenantDoProduto: campeao.tenant,
          disponivel: campeao.disponivel,
          fotosEmComum: contagemPorFoto.get(campeao) ?? 0,
          usoDoSku: usoDoSku.get(`${tenant}|${String(d.sku ?? "")}`) ?? 0,
          usoDaFoto: maiorUsoDaFoto,
          temAnuncioVivoNaConta: anunciosVivosPorProdutoEConta.has(`${campeao.id}|${e.contaId}`),
          anuncioTemOverride: listingsComOverride.has(e.externo),
          recebivelPendente: campeao.recebivel,
        }
      : null;

    resultados.push({
      ...decidirReligamento(anuncio, candidato, contexto),
      externo: e.externo,
      conta: e.conta,
      link: d.link,
      tituloNoMl: d.titulo,
      de: `${e.sku} ${e.peca}`,
      para: candidato ? `${candidato.sku ?? ""} ${candidato.nome}` : null,
    });
  }

  const porVeredito: Record<string, number> = {};
  const porMotivo: Record<string, number> = {};
  for (const r of resultados) {
    porVeredito[r.veredito] = (porVeredito[r.veredito] ?? 0) + 1;
    for (const m of r.motivos) porMotivo[m.replace(/ [\d.,]+ /g, " N ")] = (porMotivo[m.replace(/ [\d.,]+ /g, " N ")] ?? 0) + 1;
  }
  const resumo = { geradoEm: new Date().toISOString(), limiares: LIMIARES, total: resultados.length, porVeredito, porMotivo };
  fs.mkdirSync(argumentos.saida, { recursive: true });
  fs.writeFileSync(path.join(argumentos.saida, "religamento-plano.json"), JSON.stringify({ resumo, resultados }, null, 1));
  console.log(JSON.stringify(resumo, null, 1));
}

principal();
