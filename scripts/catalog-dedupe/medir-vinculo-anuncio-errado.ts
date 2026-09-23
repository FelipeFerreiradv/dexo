/**
 * Mede quantos anuncios ATIVOS estao ligados a peca ERRADA: o anuncio que esta
 * no ar no Mercado Livre anuncia uma peca e a Dexo aponta para outra. Quando
 * esse anuncio vende, a baixa cai no produto errado.
 *
 * Existe porque a auditoria da fusao de 18/09 achou o defeito numa amostra
 * ENVIESADA (so produtos com anuncio empilhado) e deu 25%; em amostra aleatoria
 * a taxa caiu para menos de 2%. Com `--todos` a varredura deixa de estimar e
 * passa a NOMEAR cada anuncio errado, que e o que da para consertar.
 *
 * ⚠️ JA EXISTE UM PARENTE: `scripts/conferir-anuncio-vs-produto-ml.ts` (14/09)
 * faz a mesma comparacao titulo x nome, com cache resumivel. Este aqui nasceu
 * depois por engano meu — nao procurei antes. Ficou por dois motivos concretos:
 * ele nunca RENOVA token (le do banco e rele no 401, enquanto o outro passa por
 * `MLOAuthService`), e amostra por CONTA, que e o que torna a taxa confiavel.
 * Para varrer um cliente inteiro, os dois servem; para medir taxa, use este.
 *
 * SOMENTE LEITURA: consulta com `default_transaction_read_only = on`, GET no
 * Mercado Livre com token que JA esta valido, nunca renova e nunca imprime o
 * token.
 *
 * Uso (na VPS, a partir de /var/www/dexo):
 *   npx tsx <caminho>/medir-vinculo-anuncio-errado.ts \
 *     --tenants=<id>,<id> --todos --saida=/root/auditoria-fusao-18-09
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SEMELHANCA_MINIMA, semelhancaDeNomes } from "./lib/veredito-fusao";

const SEPARADOR = "\u0001";
const POR_CHAMADA = 20;
/** Folga entre chamadas: o ML tolera rajada curta, mas cobra rajada longa. */
const PAUSA_MS = 120;
const TENTATIVAS_NO_429 = 5;

type Argumentos = {
  tenants: string[];
  amostra: number;
  todos: boolean;
  teto: number;
  saida: string;
  env: string;
};

function lerArgumentos(): Argumentos {
  const bruto = new Map<string, string>();
  for (const argumento of process.argv.slice(2)) {
    const par = /^--([^=]+)(?:=(.*))?$/.exec(argumento);
    if (par) bruto.set(par[1], par[2] ?? "1");
  }
  const tenants = (bruto.get("tenants") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (tenants.length === 0) throw new Error("Informe --tenants=<id>,<id>.");
  return {
    tenants,
    amostra: Number(bruto.get("amostra") ?? "200"),
    todos: bruto.has("todos"),
    teto: Number(bruto.get("teto") ?? "4000"),
    saida: bruto.get("saida") ?? "/root/auditoria-fusao-18-09",
    env: bruto.get("env") ?? "/var/www/dexo/.env",
  };
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
    input: `SET default_transaction_read_only = on;\nSET statement_timeout = '180s';\n${sql}`,
    env: { ...process.env, ...conexao },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return saida
    .split("\n")
    .filter((linha) => linha.trim().length > 0)
    .map((linha) => linha.split(SEPARADOR));
}

function aspas(valor: string): string {
  return `'${valor.replace(/'/g, "''")}'`;
}

/**
 * Token POR CONTA, nao por tenant: o multiget do Mercado Livre so devolve 200
 * para item do vendedor dono do token. Com um token so, a conta vizinha volta
 * vazia e o resultado vira "nao conferido" - que e silencio, nao aprovacao.
 */
function tokensPorConta(conexao: Record<string, string>, tenantId: string): Map<string, string> {
  const linhas = consultar(
    conexao,
    `SELECT ma.id, ma."accessToken"
       FROM "MarketplaceAccount" ma
       JOIN "User" u ON u.id = ma."userId"
      WHERE ma.platform = 'MERCADO_LIVRE' AND ma.status = 'ACTIVE'
        AND ma."expiresAt" > now() + interval '5 minutes'
        AND COALESCE(u."parentUserId", u.id) = ${aspas(tenantId)};`,
  );
  const tokens = new Map<string, string>();
  for (const [contaId, token] of linhas) if (token) tokens.set(contaId, token);
  if (tokens.size === 0) {
    throw new Error(`Nenhuma conta ML do tenant ${tenantId} tem token com folga. Nao vou renovar nada.`);
  }
  return tokens;
}

/**
 * Rele o token no banco. NAO renova: quem renova e a producao, o tempo todo.
 * Numa varredura longa o token do inicio vence no meio, e reler e a diferenca
 * entre continuar e abandonar metade da lista.
 */
function relerToken(conexao: Record<string, string>, contaId: string): string | null {
  const linhas = consultar(
    conexao,
    `SELECT ma."accessToken" FROM "MarketplaceAccount" ma
      WHERE ma.id = ${aspas(contaId)} AND ma."expiresAt" > now() + interval '1 minute';`,
  );
  return linhas[0]?.[0] ?? null;
}

const esperar = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ItemDoMl = { id: string; status?: string; title?: string; available_quantity?: number };

type Contexto = { conexao: Record<string, string>; teto: { restante: number } };

async function buscarFatia(
  ids: string[],
  contaId: string,
  token: { valor: string },
  contexto: Contexto,
): Promise<ItemDoMl[] | "SEM_TOKEN"> {
  for (let tentativa = 1; tentativa <= TENTATIVAS_NO_429; tentativa += 1) {
    if (contexto.teto.restante <= 0) return [];
    const resposta = await fetch(
      `https://api.mercadolibre.com/items?ids=${ids.join(",")}&attributes=id,status,title,available_quantity`,
      { headers: { Authorization: `Bearer ${token.valor}` } },
    );
    contexto.teto.restante -= 1;

    if (resposta.status === 401 || resposta.status === 403) {
      const novo = relerToken(contexto.conexao, contaId);
      if (!novo || novo === token.valor) return "SEM_TOKEN";
      token.valor = novo;
      continue;
    }
    if (resposta.status === 429 || resposta.status >= 500) {
      await esperar(PAUSA_MS * 4 * tentativa);
      continue;
    }
    if (!resposta.ok) return [];
    const corpo = (await resposta.json()) as { code: number; body: ItemDoMl }[];
    return corpo.filter((linha) => linha?.code === 200 && linha.body?.id).map((linha) => linha.body);
  }
  return [];
}

type Anuncio = {
  externo: string;
  contaId: string;
  conta: string;
  produtoId: string;
  sku: string;
  peca: string;
  estoque: number;
  disponivel: number;
};

type Errado = Anuncio & { anuncioNoAr: string; quantidade: number | null; semelhanca: number };

async function medir(): Promise<void> {
  const argumentos = lerArgumentos();
  const conexao = conexaoDeLeitura(argumentos.env);
  const contexto: Contexto = { conexao, teto: { restante: argumentos.teto } };
  const porTenant: Record<string, unknown> = {};
  const errados: Errado[] = [];
  const contasSemToken: string[] = [];

  for (const tenantId of argumentos.tenants) {
    const tokens = tokensPorConta(conexao, tenantId);
    // `md5(pl.id)` da ordem estavel e independente de data: sem isso a amostra
    // pegaria so o pedaco mais novo ou mais antigo do catalogo.
    const linhas = consultar(
      conexao,
      `SELECT pl."externalListingId", pl."marketplaceAccountId", COALESCE(ma."accountName",''),
              p.id, COALESCE(p.sku,''), p.name, p.stock, (p.stock - p."reservedStock")
         FROM "ProductListing" pl
         JOIN "Product" p ON p.id = pl."productId"
         JOIN "User" u ON u.id = p."userId"
         JOIN "MarketplaceAccount" ma ON ma.id = pl."marketplaceAccountId"
        WHERE pl.status = 'active' AND ma.platform = 'MERCADO_LIVRE'
          AND pl."externalListingId" LIKE 'MLB%'
          AND pl."marketplaceAccountId" IN (${[...tokens.keys()].map(aspas).join(",")})
          AND COALESCE(u."parentUserId", u.id) = ${aspas(tenantId)}
        ORDER BY md5(pl.id)
        ${argumentos.todos ? "" : `LIMIT ${Math.trunc(argumentos.amostra)}`};`,
    );

    const porConta = new Map<string, Anuncio[]>();
    const anuncioPorId = new Map<string, Anuncio>();
    for (const [externo, contaId, conta, produtoId, sku, peca, estoque, disponivel] of linhas) {
      const anuncio: Anuncio = {
        externo,
        contaId,
        conta,
        produtoId,
        sku,
        peca,
        estoque: Number(estoque),
        disponivel: Number(disponivel),
      };
      anuncioPorId.set(externo, anuncio);
      porConta.set(contaId, [...(porConta.get(contaId) ?? []), anuncio]);
    }

    let batem = 0;
    let naoBatem = 0;
    let naoConferidos = 0;
    for (const [contaId, doConta] of porConta) {
      const token = { valor: tokens.get(contaId) as string };
      const ids = doConta.map((anuncio) => anuncio.externo);
      const vistos = new Set<string>();
      for (let inicio = 0; inicio < ids.length; inicio += POR_CHAMADA) {
        const fatia = ids.slice(inicio, inicio + POR_CHAMADA);
        const itens = await buscarFatia(fatia, contaId, token, contexto);
        if (itens === "SEM_TOKEN") {
          contasSemToken.push(doConta[0]?.conta ?? contaId);
          break;
        }
        for (const item of itens) {
          vistos.add(item.id);
          const anuncio = anuncioPorId.get(item.id);
          if (!anuncio || !item.title) continue;
          const nota = semelhancaDeNomes(item.title, anuncio.peca);
          if (nota >= SEMELHANCA_MINIMA) {
            batem += 1;
            continue;
          }
          naoBatem += 1;
          errados.push({
            ...anuncio,
            anuncioNoAr: item.title,
            quantidade: item.available_quantity ?? null,
            semelhanca: Number(nota.toFixed(2)),
          });
        }
        if (inicio > 0 && inicio % (POR_CHAMADA * 50) === 0) {
          console.warn(`  ${doConta[0]?.conta ?? contaId}: ${inicio}/${ids.length} conferidos`);
        }
        await esperar(PAUSA_MS);
      }
      naoConferidos += ids.filter((id) => !vistos.has(id)).length;
    }

    porTenant[tenantId] = {
      anunciosAtivos: anuncioPorId.size,
      conferidos: batem + naoBatem,
      batem,
      naoBatem,
      naoConferidos,
      proporcaoErrada: batem + naoBatem > 0 ? Number((naoBatem / (batem + naoBatem)).toFixed(4)) : null,
    };
    console.warn(`tenant ${tenantId}: ${naoBatem} errados de ${batem + naoBatem} conferidos.`);
  }

  const resumo = {
    geradoEm: new Date().toISOString(),
    modo: argumentos.todos ? "VARREDURA_COMPLETA" : `AMOSTRA_${argumentos.amostra}`,
    chamadasUsadas: argumentos.teto - contexto.teto.restante,
    contasSemToken,
    errosComEstoqueAVenda: errados.filter((erro) => erro.disponivel > 0).length,
    porTenant,
  };

  fs.mkdirSync(argumentos.saida, { recursive: true });
  fs.writeFileSync(
    path.join(argumentos.saida, "vinculo-anuncio-errado.json"),
    JSON.stringify({ resumo, errados }, null, 1),
  );
  fs.writeFileSync(path.join(argumentos.saida, "vinculo-anuncio-errado.html"), montarHtml(resumo, errados));
  console.log(JSON.stringify(resumo, null, 1));
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function escapar(texto: string): string {
  return texto.replace(/[&<>"]/g, (caractere) => ESCAPES[caractere]);
}

function montarHtml(resumo: unknown, errados: Errado[]): string {
  // Quem tem saldo a venda vem primeiro: e o que pode vender e baixar errado hoje.
  const linhas = [...errados]
    .sort((a, b) => b.disponivel - a.disponivel || a.conta.localeCompare(b.conta))
    .map(
      (erro) => `<tr class="${erro.disponivel > 0 ? "risco" : ""}">
  <td><a href="https://produto.mercadolivre.com.br/${escapar(erro.externo)}" target="_blank" rel="noreferrer">${escapar(erro.externo)}</a><div class="nota">${escapar(erro.conta)}</div></td>
  <td><b>${escapar(erro.sku)}</b><div>${escapar(erro.peca)}</div><div class="nota">estoque ${erro.estoque} | a venda ${erro.disponivel}</div></td>
  <td>${escapar(erro.anuncioNoAr)}<div class="nota">quantidade no ML: ${erro.quantidade ?? "?"}</div></td>
  <td>${erro.semelhanca.toFixed(2)}</td>
</tr>`,
    )
    .join("\n");

  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<title>Anuncio ligado a peca errada</title>
<style>
 body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#111}
 table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:8px;vertical-align:top}
 tr.risco td{background:#fff3f3}
 .nota{color:#666;font-size:12px} pre{background:#f6f6f6;padding:12px;overflow:auto}
</style>
<h1>Anuncios ligados a peca errada</h1>
<p>O anuncio esta no ar vendendo uma peca e a Dexo aponta para outra: quando ele vender, a baixa cai no produto errado. Linha vermelha = a peca apontada ainda tem saldo a venda.</p>
<pre>${escapar(JSON.stringify(resumo, null, 1))}</pre>
<table>
<tr><th>anuncio</th><th>peca que a Dexo aponta</th><th>o que o anuncio esta vendendo</th><th>semelhanca</th></tr>
${linhas}
</table></html>`;
}

void medir();
