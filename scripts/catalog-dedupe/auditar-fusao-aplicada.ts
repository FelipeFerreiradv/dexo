/**
 * Auditoria independente das fusoes de catalogo ja aplicadas em producao.
 *
 * SOMENTE LEITURA. O script nunca escreve no banco: toda consulta roda com
 * `default_transaction_read_only = on`, e a unica escrita em disco sao os
 * relatorios de saida. Ele tambem nao fala com marketplace nenhum, entao nao ha
 * risco de renovar token (ver reference_ml_refresh_local_marca_error).
 *
 * O que ele responde: das fusoes aplicadas, quais grupos juntaram pecas que
 * provavelmente sao FISICAMENTE DIFERENTES. O sinal mais forte e a guarda que o
 * executor nao tem: a Dexo publica no maximo UM anuncio por conta, entao um
 * produto com dois anuncios ativos na MESMA conta e, quase sempre, duas pecas.
 *
 * Uso (na VPS, a partir de /var/www/dexo):
 *   npx tsx <caminho>/auditar-fusao-aplicada.ts \
 *     --backups=/var/www/dexo/scripts/out \
 *     --saida=/root/auditoria-fusao-18-09
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  decidirBalde,
  eixoDe,
  ladoDe,
  normalizar,
  semTokensDeUmCaractere,
  type Balde,
} from "./lib/veredito-fusao";

const SEPARADOR = "\u0001";
const ENV_PRODUCAO = "/var/www/dexo/.env";

type Argumentos = { backups: string; saida: string; env: string };

function lerArgumentos(): Argumentos {
  const bruto = new Map<string, string>();
  for (const argumento of process.argv.slice(2)) {
    const par = /^--([^=]+)=(.*)$/.exec(argumento);
    if (par) bruto.set(par[1], par[2]);
  }
  return {
    backups: bruto.get("backups") ?? "/var/www/dexo/scripts/out",
    saida: bruto.get("saida") ?? "/root/auditoria-fusao-18-09",
    env: bruto.get("env") ?? ENV_PRODUCAO,
  };
}

/**
 * Le a URL direta do .env de producao e devolve as variaveis do psql. A URL
 * NUNCA vai para a linha de comando: o `ps` de qualquer usuario da maquina
 * mostraria a senha.
 */
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
  const saida = execFileSync(
    "psql",
    ["-X", "-A", "-F", SEPARADOR, "-t", "-q", "-v", "ON_ERROR_STOP=1"],
    {
      input: `SET default_transaction_read_only = on;\nSET statement_timeout = '240s';\n${sql}`,
      env: { ...process.env, ...conexao },
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  return saida
    .split("\n")
    .filter((linha) => linha.trim().length > 0)
    .map((linha) => linha.split(SEPARADOR));
}

function listaSql(ids: string[]): string {
  return ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
}

// ---------------------------------------------------------------- entrada

type Grupo = {
  ownerId: string;
  duplicateIds: string[];
  name: string;
  exactNormalizedTitle?: boolean;
  exactFullGallery?: boolean;
  sourceCode?: string;
  expected?: {
    listingIdsToMove?: string[];
    donorStocksNotSummed?: { productId: string; stock: number }[];
  };
  evidence?: { photoIds?: string[] };
};

type FichaDoBackup = { name: string; sku: string | null; stock: number };

type Lote = {
  rotulo: string;
  tenantId: string;
  aplicadoEm: string;
  manifesto: string;
  grupos: Grupo[];
  fichas: Map<string, FichaDoBackup>;
};

function carregarLotes(diretorioBackups: string): Lote[] {
  const lotes: Lote[] = [];
  for (const arquivo of fs.readdirSync(diretorioBackups).sort()) {
    if (!arquivo.startsWith("catalog-duplicates-backup-") || !arquivo.endsWith(".json")) continue;
    const backup = JSON.parse(fs.readFileSync(path.join(diretorioBackups, arquivo), "utf8"));
    if (backup?.metadata?.mode !== "APPLY") continue;

    const caminhoManifesto: string = backup.metadata.manifestPath;
    if (!fs.existsSync(caminhoManifesto)) {
      throw new Error(`Manifesto aplicado nao esta mais no disco: ${caminhoManifesto}`);
    }
    // O manifesto so vale como prova se for o MESMO que foi aplicado.
    const digest = crypto.createHash("sha256").update(fs.readFileSync(caminhoManifesto)).digest("hex");
    if (digest !== backup.metadata.manifestSha256) {
      throw new Error(`sha256 do manifesto ${caminhoManifesto} nao confere com o registrado na fusao.`);
    }
    const manifesto = JSON.parse(fs.readFileSync(caminhoManifesto, "utf8"));

    const fichas = new Map<string, FichaDoBackup>();
    for (const produto of backup.tables?.Product ?? []) {
      fichas.set(produto.id, {
        name: produto.name ?? "",
        sku: produto.sku ?? null,
        stock: produto.stock ?? 0,
      });
    }

    lotes.push({
      rotulo: path.basename(caminhoManifesto).replace(/-final-manifest\.json$/, ""),
      tenantId: backup.tenantId,
      aplicadoEm: backup.createdAt,
      manifesto: caminhoManifesto,
      grupos: manifesto.groups ?? [],
      fichas,
    });
  }
  return lotes;
}

// -------------------------------------------------------------- producao

type AnuncioVivo = {
  productId: string;
  contaId: string;
  listingId: string;
  externo: string;
  plataforma: string;
  conta: string;
};

type SaldoDoDono = { sku: string; nome: string; estoque: number; reservado: number };

function emFatias<T>(itens: T[], passo: number): T[][] {
  const fatias: T[][] = [];
  for (let inicio = 0; inicio < itens.length; inicio += passo) {
    fatias.push(itens.slice(inicio, inicio + passo));
  }
  return fatias;
}

function anunciosAtivosDosDonos(conexao: Record<string, string>, donos: string[]): AnuncioVivo[] {
  const vivos: AnuncioVivo[] = [];
  for (const fatia of emFatias(donos, 2000)) {
    const linhas = consultar(
      conexao,
      `SELECT pl."productId", pl."marketplaceAccountId", pl.id, COALESCE(pl."externalListingId",''),
              ma.platform, COALESCE(ma."accountName",'')
         FROM "ProductListing" pl
         JOIN "MarketplaceAccount" ma ON ma.id = pl."marketplaceAccountId"
        WHERE pl.status = 'active' AND pl."productId" IN (${listaSql(fatia)});`,
    );
    for (const [productId, contaId, listingId, externo, plataforma, conta] of linhas) {
      vivos.push({ productId, contaId, listingId, externo, plataforma, conta });
    }
  }
  return vivos;
}

function saldoDosDonos(conexao: Record<string, string>, donos: string[]): Map<string, SaldoDoDono> {
  const saldos = new Map<string, SaldoDoDono>();
  for (const fatia of emFatias(donos, 2000)) {
    const linhas = consultar(
      conexao,
      `SELECT p.id, COALESCE(p.sku,''), p.name, p.stock, p."reservedStock"
         FROM "Product" p WHERE p.id IN (${listaSql(fatia)});`,
    );
    for (const [id, sku, nome, estoque, reservado] of linhas) {
      saldos.set(id, { sku, nome, estoque: Number(estoque), reservado: Number(reservado) });
    }
  }
  return saldos;
}

function doadoresQueSobreviveram(conexao: Record<string, string>, doadores: string[]): string[] {
  const vivos: string[] = [];
  for (const fatia of emFatias(doadores, 2000)) {
    const linhas = consultar(conexao, `SELECT p.id FROM "Product" p WHERE p.id IN (${listaSql(fatia)});`);
    for (const [id] of linhas) vivos.push(id);
  }
  return vivos;
}

// -------------------------------------------------------------- veredito

type ContaEmpilhada = {
  conta: string;
  plataforma: string;
  anuncios: { listingId: string; externo: string; movido: boolean }[];
};

type Veredito = {
  lote: string;
  tenantId: string;
  ownerId: string;
  donoSku: string;
  donoNome: string;
  donoEstoque: number;
  doadores: { id: string; sku: string | null; nome: string; estoque: number }[];
  contasEmpilhadas: ContaEmpilhada[];
  colisaoDesteGrupo: boolean;
  colisaoPreexistente: boolean;
  ladoOpostoPorTokenCurto: boolean;
  ladoDivergente: boolean;
  eixoDivergente: boolean;
  tituloExato: boolean;
  galeriaCompleta: boolean;
  fotos: string[];
  balde: Balde;
};

function auditar(): void {
  const argumentos = lerArgumentos();
  const conexao = conexaoDeLeitura(argumentos.env);
  const lotes = carregarLotes(argumentos.backups);
  if (lotes.length === 0) throw new Error("Nenhum backup de fusao aplicada encontrado.");

  const donos = [...new Set(lotes.flatMap((lote) => lote.grupos.map((grupo) => grupo.ownerId)))];
  const doadores = [...new Set(lotes.flatMap((lote) => lote.grupos.flatMap((grupo) => grupo.duplicateIds)))];

  const sobreviventes = doadoresQueSobreviveram(conexao, doadores);
  const vivos = anunciosAtivosDosDonos(conexao, donos);
  const saldos = saldoDosDonos(conexao, donos);

  const porDono = new Map<string, AnuncioVivo[]>();
  for (const anuncio of vivos) {
    const lista = porDono.get(anuncio.productId) ?? [];
    lista.push(anuncio);
    porDono.set(anuncio.productId, lista);
  }

  const vereditos: Veredito[] = [];
  for (const lote of lotes) {
    for (const grupo of lote.grupos) {
      const movidos = new Set(grupo.expected?.listingIdsToMove ?? []);
      const anuncios = porDono.get(grupo.ownerId) ?? [];

      const porConta = new Map<string, AnuncioVivo[]>();
      for (const anuncio of anuncios) {
        const lista = porConta.get(anuncio.contaId) ?? [];
        lista.push(anuncio);
        porConta.set(anuncio.contaId, lista);
      }

      const contasEmpilhadas: ContaEmpilhada[] = [];
      let colisaoDesteGrupo = false;
      let colisaoPreexistente = false;
      for (const lista of porConta.values()) {
        if (lista.length < 2) continue;
        const desteGrupo = lista.some((anuncio) => movidos.has(anuncio.listingId));
        if (desteGrupo) colisaoDesteGrupo = true;
        else colisaoPreexistente = true;
        contasEmpilhadas.push({
          conta: lista[0].conta,
          plataforma: lista[0].plataforma,
          anuncios: lista.map((anuncio) => ({
            listingId: anuncio.listingId,
            externo: anuncio.externo,
            movido: movidos.has(anuncio.listingId),
          })),
        });
      }

      const saldoDono = saldos.get(grupo.ownerId);
      const nomeDono = saldoDono?.nome ?? lote.fichas.get(grupo.ownerId)?.name ?? grupo.name;
      const fichasDoadoras = grupo.duplicateIds.map((id) => {
        const doBackup = lote.fichas.get(id);
        return { id, sku: doBackup?.sku ?? null, nome: doBackup?.name ?? "", estoque: doBackup?.stock ?? 0 };
      });

      let ladoOpostoPorTokenCurto = false;
      let ladoDivergente = false;
      let eixoDivergente = false;
      for (const doador of fichasDoadoras) {
        if (!doador.nome) continue;
        if (
          semTokensDeUmCaractere(nomeDono) === semTokensDeUmCaractere(doador.nome) &&
          normalizar(nomeDono) !== normalizar(doador.nome)
        ) {
          ladoOpostoPorTokenCurto = true;
        }
        const ladoDoDono = ladoDe(nomeDono);
        const ladoDoDoador = ladoDe(doador.nome);
        if (ladoDoDono && ladoDoDoador && ladoDoDono !== ladoDoDoador) ladoDivergente = true;
        const eixoDoDono = eixoDe(nomeDono);
        const eixoDoDoador = eixoDe(doador.nome);
        if (eixoDoDono && eixoDoDoador && eixoDoDono !== eixoDoDoador) eixoDivergente = true;
      }

      const balde = decidirBalde({
        colisaoDesteGrupo,
        colisaoPreexistente,
        ladoOpostoPorTokenCurto,
        ladoDivergente,
        eixoDivergente,
      });

      vereditos.push({
        lote: lote.rotulo,
        tenantId: lote.tenantId,
        ownerId: grupo.ownerId,
        donoSku: saldoDono?.sku ?? "",
        donoNome: nomeDono,
        donoEstoque: saldoDono?.estoque ?? 0,
        doadores: fichasDoadoras,
        contasEmpilhadas,
        colisaoDesteGrupo,
        colisaoPreexistente,
        ladoOpostoPorTokenCurto,
        ladoDivergente,
        eixoDivergente,
        tituloExato: grupo.exactNormalizedTitle === true,
        galeriaCompleta: grupo.exactFullGallery === true,
        fotos: (grupo.evidence?.photoIds ?? []).slice(0, 4),
        balde,
      });
    }
  }

  fs.mkdirSync(argumentos.saida, { recursive: true });
  const resumo = {
    geradoEm: new Date().toISOString(),
    lotes: lotes.map((lote) => ({
      rotulo: lote.rotulo,
      tenantId: lote.tenantId,
      aplicadoEm: lote.aplicadoEm,
      manifesto: lote.manifesto,
      grupos: lote.grupos.length,
    })),
    doadoresQueSobreviveram: sobreviventes.length,
    totais: {
      grupos: vereditos.length,
      desfazerSugerido: vereditos.filter((v) => v.balde === "DESFAZER_SUGERIDO").length,
      revisar: vereditos.filter((v) => v.balde === "REVISAR").length,
      ok: vereditos.filter((v) => v.balde === "OK").length,
      colisaoDesteGrupo: vereditos.filter((v) => v.colisaoDesteGrupo).length,
      colisaoPreexistente: vereditos.filter((v) => v.colisaoPreexistente).length,
      ladoOpostoPorTokenCurto: vereditos.filter((v) => v.ladoOpostoPorTokenCurto).length,
      ladoDivergente: vereditos.filter((v) => v.ladoDivergente).length,
      eixoDivergente: vereditos.filter((v) => v.eixoDivergente).length,
    },
  };

  fs.writeFileSync(path.join(argumentos.saida, "veredito-fusao.json"), JSON.stringify({ resumo, vereditos }, null, 1));
  fs.writeFileSync(path.join(argumentos.saida, "conferencia-fusao.html"), montarHtml(resumo, vereditos));
  console.log(JSON.stringify(resumo, null, 1));
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function escapar(texto: string): string {
  return texto.replace(/[&<>"]/g, (caractere) => ESCAPES[caractere]);
}

function urlDaFoto(id: string): string {
  const limpo = id.replace(/^ml:/, "");
  return `https://http2.mlstatic.com/D_${limpo.toUpperCase()}-V.jpg`;
}

function montarHtml(resumo: unknown, vereditos: Veredito[]): string {
  const suspeitos = vereditos.filter((v) => v.balde !== "OK");
  const linhas = suspeitos
    .map((v) => {
      const motivos = [
        v.colisaoDesteGrupo ? "2 anuncios ativos na MESMA conta (criado por esta fusao)" : "",
        v.colisaoPreexistente ? "2 anuncios ativos na mesma conta (ja existia antes)" : "",
        v.ladoOpostoPorTokenCurto ? "nomes so diferem em token de 1 caractere (L/e x L/d)" : "",
        v.ladoDivergente ? "lado divergente" : "",
        v.eixoDivergente ? "eixo divergente" : "",
      ].filter(Boolean);
      const contas = v.contasEmpilhadas
        .map(
          (c) =>
            `<div><b>${escapar(c.conta)}</b> (${escapar(c.plataforma)}): ` +
            c.anuncios
              .map((a) => `${escapar(a.externo || a.listingId)}${a.movido ? " <i>(movido na fusao)</i>" : ""}`)
              .join(" + ") +
            `</div>`,
        )
        .join("");
      const fotos = v.fotos.map((f) => `<img src="${urlDaFoto(f)}" loading="lazy">`).join("");
      const doadores = v.doadores
        .map((d) => `<div>${escapar(d.sku ?? "")} - ${escapar(d.nome)} (estoque ${d.estoque})</div>`)
        .join("");
      return `<tr class="${v.balde}">
  <td>${escapar(v.balde)}<div class="motivo">${motivos.map(escapar).join("<br>")}</div></td>
  <td><b>${escapar(v.donoSku)}</b> - ${escapar(v.donoNome)}<div class="motivo">estoque ${v.donoEstoque}</div></td>
  <td>${doadores}</td>
  <td>${contas}</td>
  <td class="fotos">${fotos}</td>
</tr>`;
    })
    .join("\n");

  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<title>Conferencia da fusao de catalogo</title>
<style>
 body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#111}
 table{border-collapse:collapse;width:100%}
 td,th{border:1px solid #ddd;padding:8px;vertical-align:top}
 .DESFAZER_SUGERIDO td{background:#fff3f3}
 .REVISAR td{background:#fffdf0}
 .motivo{color:#666;font-size:12px;margin-top:4px}
 .fotos img{width:72px;height:72px;object-fit:cover;margin:2px;border-radius:4px}
 pre{background:#f6f6f6;padding:12px;overflow:auto}
</style>
<h1>Conferencia da fusao de catalogo de 18/09/2026</h1>
<p>Somente leitura. Cada linha e um grupo que a fusao juntou e que caiu em alguma suspeita.</p>
<pre>${escapar(JSON.stringify(resumo, null, 1))}</pre>
<table>
<tr><th>veredito</th><th>peca que ficou (dono)</th><th>fichas apagadas</th><th>anuncios empilhados</th><th>fotos do anuncio</th></tr>
${linhas}
</table></html>`;
}

auditar();
