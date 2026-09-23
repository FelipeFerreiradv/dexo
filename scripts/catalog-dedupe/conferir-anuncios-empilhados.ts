/**
 * Confere no Mercado Livre se os anuncios que ficaram empilhados na MESMA conta
 * depois da fusao estao MESMO no ar. Existe porque `ProductListing.status` e um
 * espelho local e pode estar velho: sem esta conferencia a auditoria acusaria
 * peca dupla onde ha apenas espelho desatualizado.
 *
 * SOMENTE LEITURA, e com dois cuidados deliberados:
 *   - nunca renova token (ver reference_ml_refresh_local_marca_error: renovar de
 *     fora da producao derruba a conta). Usa um accessToken que JA esta valido e,
 *     se ele nao servir, para e avisa;
 *   - nunca imprime, grava ou repassa o token.
 *
 * Uso (na VPS, a partir de /var/www/dexo):
 *   npx tsx <caminho>/conferir-anuncios-empilhados.ts \
 *     --veredito=/root/auditoria-fusao-18-09/veredito-fusao.json \
 *     --saida=/root/auditoria-fusao-18-09 --teto=60
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  contasComDoisNoAr,
  decidirVeredito,
  falaDaMesmaPeca,
  type AnuncioConferido,
  type VereditoDoMl,
} from "./lib/veredito-fusao";

const SEPARADOR = "\u0001";
const POR_CHAMADA = 20;

type Argumentos = { veredito: string; saida: string; teto: number; env: string };

function lerArgumentos(): Argumentos {
  const bruto = new Map<string, string>();
  for (const argumento of process.argv.slice(2)) {
    const par = /^--([^=]+)=(.*)$/.exec(argumento);
    if (par) bruto.set(par[1], par[2]);
  }
  return {
    veredito: bruto.get("veredito") ?? "/root/auditoria-fusao-18-09/veredito-fusao.json",
    saida: bruto.get("saida") ?? "/root/auditoria-fusao-18-09",
    teto: Number(bruto.get("teto") ?? "60"),
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
    input: `SET default_transaction_read_only = on;\nSET statement_timeout = '60s';\n${sql}`,
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
 * Pega um token que ainda tem folga de validade. A folga evita que a chamada
 * caia justo no vencimento e alguem conclua que "o token morreu por causa da
 * auditoria".
 */
function tokenJaValido(conexao: Record<string, string>, tenantId: string): string {
  const linhas = consultar(
    conexao,
    `SELECT ma."accessToken"
       FROM "MarketplaceAccount" ma
       JOIN "User" u ON u.id = ma."userId"
      WHERE ma.platform = 'MERCADO_LIVRE'
        AND ma.status = 'ACTIVE'
        AND ma."expiresAt" > now() + interval '15 minutes'
        AND COALESCE(u."parentUserId", u.id) = '${tenantId.replace(/'/g, "''")}'
      ORDER BY ma."expiresAt" DESC
      LIMIT 1;`,
  );
  if (linhas.length === 0 || !linhas[0][0]) {
    throw new Error(`Nenhuma conta ML do tenant ${tenantId} tem token com folga. Nao vou renovar nada: pare aqui.`);
  }
  return linhas[0][0];
}

type ItemDoMl = {
  id: string;
  status?: string;
  sub_status?: string[];
  available_quantity?: number;
  sold_quantity?: number;
  title?: string;
};

async function lerItens(ids: string[], token: string, teto: { restante: number }): Promise<Map<string, ItemDoMl>> {
  const itens = new Map<string, ItemDoMl>();
  for (let inicio = 0; inicio < ids.length; inicio += POR_CHAMADA) {
    if (teto.restante <= 0) {
      console.warn(`Teto de chamadas atingido com ${ids.length - inicio} ids sem conferir.`);
      break;
    }
    const fatia = ids.slice(inicio, inicio + POR_CHAMADA);
    const alvo =
      `https://api.mercadolibre.com/items?ids=${fatia.join(",")}` +
      `&attributes=id,status,sub_status,available_quantity,sold_quantity,title`;
    const resposta = await fetch(alvo, { headers: { Authorization: `Bearer ${token}` } });
    teto.restante -= 1;
    if (resposta.status === 401 || resposta.status === 403) {
      throw new Error(`Mercado Livre recusou a leitura (HTTP ${resposta.status}). Nao vou renovar token: pare aqui.`);
    }
    if (!resposta.ok) {
      console.warn(`HTTP ${resposta.status} na fatia iniciada em ${inicio}; segue para a proxima.`);
      continue;
    }
    const corpo = (await resposta.json()) as { code: number; body: ItemDoMl }[];
    for (const linha of corpo) {
      if (linha?.code === 200 && linha.body?.id) itens.set(linha.body.id, linha.body);
    }
  }

  return itens;
}

/**
 * O multiget devolve o id apenas quando da 200; id que nao voltou fica sem
 * resposta e viraria "nao conferido" - o mesmo rotulo de "faltou chamada".
 * Resolvemos um a um, porque a diferenca importa: anuncio apagado NAO expoe
 * peca. So vale a pena gastar chamada com o id que ainda DECIDE um grupo.
 */
async function resolverUmAUm(
  ids: string[],
  token: string,
  teto: { restante: number },
  itens: Map<string, ItemDoMl>,
): Promise<void> {
  for (const id of ids) {
    if (teto.restante <= 0) break;
    if (itens.has(id)) continue;
    const resposta = await fetch(
      `https://api.mercadolibre.com/items/${id}?attributes=id,status,sub_status,available_quantity,sold_quantity,title`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    teto.restante -= 1;
    if (resposta.status === 200) {
      const item = (await resposta.json()) as ItemDoMl;
      if (item?.id) itens.set(item.id, item);
      continue;
    }
    // 404/403 aqui significa que o anuncio nao esta acessivel como item vivo.
    itens.set(id, { id, status: `http_${resposta.status}`, available_quantity: 0 });
  }
}

type Veredito = {
  lote: string;
  tenantId: string;
  ownerId: string;
  donoSku: string;
  donoNome: string;
  donoEstoque: number;
  doadores: { id: string; sku: string | null; nome: string; estoque: number }[];
  contasEmpilhadas: { conta: string; plataforma: string; anuncios: { listingId: string; externo: string; movido: boolean }[] }[];
  balde: string;
};

type LinhaConferida = {
  lote: string;
  tenantId: string;
  ownerId: string;
  donoSku: string;
  donoNome: string;
  donoEstoque: number;
  doadores: Veredito["doadores"];
  anuncios: (AnuncioConferido & {
    externo: string;
    movido: boolean;
    subStatus: string[];
    vendidos: number | null;
    titulo: string;
  })[];
  contasComDoisNoAr: number;
  naoConferidos: number;
  veredito: VereditoDoMl;
};

/**
 * "No ar de verdade" exige `active` E quantidade acima de zero: anuncio pausado
 * ou zerado nao expoe a peca, e tratar os dois como iguais transformaria espelho
 * velho em acusacao de peca dupla.
 */
function classificar(suspeitos: Veredito[], itens: Map<string, ItemDoMl>): LinhaConferida[] {
  return suspeitos.map((suspeito) => {
    const anunciosMl = suspeito.contasEmpilhadas
      .filter((conta) => conta.plataforma === "MERCADO_LIVRE")
      .flatMap((conta) => conta.anuncios.map((anuncio) => ({ conta: conta.conta, ...anuncio })));

    const detalhe = anunciosMl.map((anuncio) => {
      const item = itens.get(anuncio.externo);
      return {
        externo: anuncio.externo,
        conta: anuncio.conta,
        movido: anuncio.movido,
        statusNoMl: item?.status ?? "NAO_CONFERIDO",
        subStatus: item?.sub_status ?? [],
        quantidade: item?.available_quantity ?? null,
        vendidos: item?.sold_quantity ?? null,
        titulo: item?.title ?? "",
      };
    });

    const empilhadas = contasComDoisNoAr(detalhe);
    const naoConferidos = detalhe.filter((linha) => linha.statusNoMl === "NAO_CONFERIDO").length;

    return {
      lote: suspeito.lote,
      tenantId: suspeito.tenantId,
      ownerId: suspeito.ownerId,
      donoSku: suspeito.donoSku,
      donoNome: suspeito.donoNome,
      donoEstoque: suspeito.donoEstoque,
      doadores: suspeito.doadores,
      anuncios: detalhe,
      contasComDoisNoAr: empilhadas,
      naoConferidos,
      veredito: decidirVeredito(detalhe),
    };
  });
}

async function conferir(): Promise<void> {
  const argumentos = lerArgumentos();
  const conexao = conexaoDeLeitura(argumentos.env);
  const arquivo = JSON.parse(fs.readFileSync(argumentos.veredito, "utf8")) as { vereditos: Veredito[] };
  const suspeitos = arquivo.vereditos.filter((v) => v.balde === "DESFAZER_SUGERIDO");

  const idsPorTenant = new Map<string, Set<string>>();
  for (const suspeito of suspeitos) {
    for (const conta of suspeito.contasEmpilhadas) {
      if (conta.plataforma !== "MERCADO_LIVRE") continue;
      for (const anuncio of conta.anuncios) {
        if (!/^MLB\d+$/.test(anuncio.externo)) continue;
        const conjunto = idsPorTenant.get(suspeito.tenantId) ?? new Set<string>();
        conjunto.add(anuncio.externo);
        idsPorTenant.set(suspeito.tenantId, conjunto);
      }
    }
  }

  const teto = { restante: argumentos.teto };
  const itens = new Map<string, ItemDoMl>();
  const tokenPorTenant = new Map<string, string>();
  for (const [tenantId, conjunto] of idsPorTenant) {
    const token = tokenJaValido(conexao, tenantId);
    tokenPorTenant.set(tenantId, token);
    const lidos = await lerItens([...conjunto], token, teto);
    for (const [id, item] of lidos) itens.set(id, item);
  }

  // Segunda passada dirigida: gasta chamada individual so onde o grupo ainda nao
  // esta decidido. Nos grupos ja confirmados, conferir o resto nao muda nada.
  const aindaDecidem = new Map<string, Set<string>>();
  for (const linha of classificar(suspeitos, itens)) {
    if (linha.veredito !== "INCOMPLETO") continue;
    const suspeito = suspeitos.find((s) => s.ownerId === linha.ownerId && s.lote === linha.lote);
    if (!suspeito) continue;
    for (const anuncio of linha.anuncios) {
      if (anuncio.statusNoMl !== "NAO_CONFERIDO") continue;
      const conjunto = aindaDecidem.get(suspeito.tenantId) ?? new Set<string>();
      conjunto.add(anuncio.externo);
      aindaDecidem.set(suspeito.tenantId, conjunto);
    }
  }
  for (const [tenantId, conjunto] of aindaDecidem) {
    const token = tokenPorTenant.get(tenantId);
    if (!token) continue;
    await resolverUmAUm([...conjunto], token, teto, itens);
  }

  const conferidos = classificar(suspeitos, itens);

  const resumo = {
    geradoEm: new Date().toISOString(),
    gruposSuspeitos: suspeitos.length,
    chamadasUsadas: argumentos.teto - teto.restante,
    idsConferidos: itens.size,
    porVeredito: conferidos.reduce<Record<string, number>>((acumulado, linha) => {
      acumulado[linha.veredito] = (acumulado[linha.veredito] ?? 0) + 1;
      return acumulado;
    }, {}),
  };

  fs.mkdirSync(argumentos.saida, { recursive: true });
  fs.writeFileSync(
    path.join(argumentos.saida, "conferencia-no-mercado-livre.json"),
    JSON.stringify({ resumo, conferidos }, null, 1),
  );
  fs.writeFileSync(path.join(argumentos.saida, "conferencia-no-mercado-livre.html"), montarHtml(resumo, conferidos));
  console.log(JSON.stringify(resumo, null, 1));
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function escapar(texto: string): string {
  return texto.replace(/[&<>"]/g, (caractere) => ESCAPES[caractere]);
}

function montarHtml(resumo: unknown, conferidos: LinhaConferida[]): string {
  const ordem = { DUPLA_EXPOSICAO_CONFIRMADA: 0, INCOMPLETO: 1, ESPELHO_VELHO: 2 };
  const linhas = [...conferidos]
    .sort((a, b) => ordem[a.veredito] - ordem[b.veredito])
    .map((linha) => {
      const anuncios = linha.anuncios
        .map((anuncio) => {
          const noAr = anuncio.statusNoMl === "active" && (anuncio.quantidade ?? 0) > 0;
          const mesmaPeca = falaDaMesmaPeca(anuncio.titulo, linha.donoNome);
          const marca = !noAr ? "fora" : mesmaPeca ? "no-ar" : "outra-peca";
          return `<div class="anuncio ${marca}">
  <a href="https://produto.mercadolivre.com.br/${escapar(anuncio.externo)}" target="_blank" rel="noreferrer">${escapar(anuncio.externo)}</a>
  <span>${escapar(anuncio.conta)}</span>
  <span>${escapar(anuncio.statusNoMl)}${anuncio.quantidade === null ? "" : ` q=${anuncio.quantidade}`}${anuncio.vendidos ? ` vendidos=${anuncio.vendidos}` : ""}</span>
  <span class="titulo">${escapar(anuncio.titulo)}</span>
</div>`;
        })
        .join("");
      const apagadas = linha.doadores
        .map((doador) => `<div>${escapar(doador.sku ?? "")} - ${escapar(doador.nome)} (estoque ${doador.estoque})</div>`)
        .join("");
      return `<tr class="${linha.veredito}">
  <td>${escapar(linha.veredito)}</td>
  <td><b>${escapar(linha.donoSku)}</b><div>${escapar(linha.donoNome)}</div><div class="nota">estoque ${linha.donoEstoque} | lote ${escapar(linha.lote)}</div></td>
  <td>${apagadas}</td>
  <td>${anuncios}</td>
</tr>`;
    })
    .join("\n");

  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<title>Anuncios empilhados depois da fusao</title>
<style>
 body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#111}
 table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:8px;vertical-align:top}
 .DUPLA_EXPOSICAO_CONFIRMADA td{background:#fff3f3} .ESPELHO_VELHO td{background:#f3fbf3}
 .anuncio{margin-bottom:6px;padding:4px;border-left:3px solid #ccc}
 .anuncio.no-ar{border-color:#c00} .anuncio.outra-peca{border-color:#e69500;background:#fffaf0} .anuncio.fora{border-color:#bbb;color:#777}
 .anuncio span{display:inline-block;margin-right:10px;color:#555;font-size:12px}
 .titulo{display:block !important;color:#111 !important;font-size:13px !important}
 .nota{color:#666;font-size:12px} pre{background:#f6f6f6;padding:12px;overflow:auto}
</style>
<h1>Anuncios que ficaram empilhados na mesma conta</h1>
<p>Vermelho: no ar com quantidade. Laranja: o anuncio no ar fala de OUTRA peca (vinculo errado, anterior a fusao). Cinza: fora do ar.</p>
<pre>${escapar(JSON.stringify(resumo, null, 1))}</pre>
<table><tr><th>veredito</th><th>peca que ficou</th><th>fichas apagadas</th><th>anuncios</th></tr>
${linhas}
</table></html>`;
}


void conferir();
