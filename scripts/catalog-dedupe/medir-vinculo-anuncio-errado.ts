/**
 * Mede quantos anuncios ATIVOS estao ligados a peca ERRADA: o anuncio que esta
 * no ar no Mercado Livre anuncia uma peca e a Dexo aponta para outra. Quando
 * esse anuncio vende, a baixa cai no produto errado.
 *
 * Existe porque a auditoria da fusao de 18/09 achou o defeito numa amostra
 * ENVIESADA (produtos com anuncio empilhado). Aqui a amostra e ALEATORIA, para
 * nao confundir a taxa do subconjunto suspeito com a taxa do cliente.
 *
 * SOMENTE LEITURA: consulta com `default_transaction_read_only = on`, GET no
 * Mercado Livre com token que JA esta valido, nunca renova e nunca imprime o
 * token.
 *
 * Uso (na VPS, a partir de /var/www/dexo):
 *   npx tsx <caminho>/medir-vinculo-anuncio-errado.ts \
 *     --tenants=<id>,<id> --amostra=200 --teto=40 --saida=/root/auditoria-fusao-18-09
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SEMELHANCA_MINIMA, semelhancaDeNomes } from "./lib/veredito-fusao";

const SEPARADOR = "\u0001";
const POR_CHAMADA = 20;

type Argumentos = { tenants: string[]; amostra: number; teto: number; saida: string; env: string };

function lerArgumentos(): Argumentos {
  const bruto = new Map<string, string>();
  for (const argumento of process.argv.slice(2)) {
    const par = /^--([^=]+)=(.*)$/.exec(argumento);
    if (par) bruto.set(par[1], par[2]);
  }
  const tenants = (bruto.get("tenants") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (tenants.length === 0) throw new Error("Informe --tenants=<id>,<id>.");
  return {
    tenants,
    amostra: Number(bruto.get("amostra") ?? "200"),
    teto: Number(bruto.get("teto") ?? "40"),
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
    input: `SET default_transaction_read_only = on;\nSET statement_timeout = '120s';\n${sql}`,
    env: { ...process.env, ...conexao },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return saida
    .split("\n")
    .filter((linha) => linha.trim().length > 0)
    .map((linha) => linha.split(SEPARADOR));
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
        AND ma."expiresAt" > now() + interval '15 minutes'
        AND COALESCE(u."parentUserId", u.id) = '${tenantId.replace(/'/g, "''")}';`,
  );
  const tokens = new Map<string, string>();
  for (const [contaId, token] of linhas) if (token) tokens.set(contaId, token);
  if (tokens.size === 0) {
    throw new Error(`Nenhuma conta ML do tenant ${tenantId} tem token com folga. Nao vou renovar nada.`);
  }
  return tokens;
}




type ItemDoMl = { id: string; status?: string; title?: string; available_quantity?: number };

async function lerTitulos(ids: string[], token: string, teto: { restante: number }): Promise<Map<string, ItemDoMl>> {
  const itens = new Map<string, ItemDoMl>();
  for (let inicio = 0; inicio < ids.length; inicio += POR_CHAMADA) {
    if (teto.restante <= 0) break;
    const fatia = ids.slice(inicio, inicio + POR_CHAMADA);
    const resposta = await fetch(
      `https://api.mercadolibre.com/items?ids=${fatia.join(",")}&attributes=id,status,title,available_quantity`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    teto.restante -= 1;
    if (resposta.status === 401 || resposta.status === 403) {
      throw new Error(`Mercado Livre recusou a leitura (HTTP ${resposta.status}). Nao vou renovar token.`);
    }
    if (!resposta.ok) continue;
    const corpo = (await resposta.json()) as { code: number; body: ItemDoMl }[];
    for (const linha of corpo) {
      if (linha?.code === 200 && linha.body?.id) itens.set(linha.body.id, linha.body);
    }
  }
  return itens;
}

async function medir(): Promise<void> {
  const argumentos = lerArgumentos();
  const conexao = conexaoDeLeitura(argumentos.env);
  const teto = { restante: argumentos.teto };
  const porTenant: Record<string, unknown> = {};
  const errados: { tenant: string; externo: string; peca: string; anuncio: string; semelhanca: number }[] = [];

  for (const tenantId of argumentos.tenants) {
    // `md5(pl.id)` da uma ordem estavel e independente de data de criacao: sem
    // isso a amostra pegaria so o pedaco mais novo ou mais antigo do catalogo.
    const tokens = tokensPorConta(conexao, tenantId);
    const linhas = consultar(
      conexao,
      `SELECT pl."externalListingId", p.name, COALESCE(p.sku,''), pl."marketplaceAccountId"
         FROM "ProductListing" pl
         JOIN "Product" p ON p.id = pl."productId"
         JOIN "User" u ON u.id = p."userId"
         JOIN "MarketplaceAccount" ma ON ma.id = pl."marketplaceAccountId"
        WHERE pl.status = 'active' AND ma.platform = 'MERCADO_LIVRE'
          AND pl."externalListingId" LIKE 'MLB%'
          AND pl."marketplaceAccountId" IN (${[...tokens.keys()].map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})
          AND COALESCE(u."parentUserId", u.id) = '${tenantId.replace(/'/g, "''")}'
        ORDER BY md5(pl.id)
        LIMIT ${Math.trunc(argumentos.amostra)};`,
    );
    const nomePorId = new Map<string, { nome: string; sku: string }>();
    const porConta = new Map<string, string[]>();
    for (const [externo, nome, sku, contaId] of linhas) {
      nomePorId.set(externo, { nome, sku });
      porConta.set(contaId, [...(porConta.get(contaId) ?? []), externo]);
    }

    const itens = new Map<string, ItemDoMl>();
    for (const [contaId, ids] of porConta) {
      const token = tokens.get(contaId);
      if (!token) continue;
      const lidos = await lerTitulos(ids, token, teto);
      for (const [id, item] of lidos) itens.set(id, item);
    }

    let batem = 0;
    let naoBatem = 0;
    let naoConferidos = 0;
    for (const [externo, peca] of nomePorId) {
      const item = itens.get(externo);
      if (!item || !item.title) {
        naoConferidos += 1;
        continue;
      }
      const nota = semelhancaDeNomes(item.title, peca.nome);
      if (nota >= SEMELHANCA_MINIMA) batem += 1;
      else {
        naoBatem += 1;
        errados.push({ tenant: tenantId, externo, peca: `${peca.sku} ${peca.nome}`.trim(), anuncio: item.title, semelhanca: Number(nota.toFixed(2)) });
      }
    }
    porTenant[tenantId] = {
      amostrados: nomePorId.size,
      conferidos: batem + naoBatem,
      batem,
      naoBatem,
      naoConferidos,
      proporcaoErrada: batem + naoBatem > 0 ? Number((naoBatem / (batem + naoBatem)).toFixed(3)) : null,
    };
  }

  const resumo = { geradoEm: new Date().toISOString(), chamadasUsadas: argumentos.teto - teto.restante, porTenant };
  fs.mkdirSync(argumentos.saida, { recursive: true });
  fs.writeFileSync(
    path.join(argumentos.saida, "vinculo-anuncio-errado.json"),
    JSON.stringify({ resumo, errados }, null, 1),
  );
  console.log(JSON.stringify(resumo, null, 1));
  for (const linha of errados.slice(0, 6)) {
    console.log(`  ${linha.externo} | peca: ${linha.peca.slice(0, 45)} | anuncio: ${linha.anuncio.slice(0, 45)}`);
  }
}

void medir();
