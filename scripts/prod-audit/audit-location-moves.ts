import "../lib/load-env"; // PRIMEIRA linha: o worktree nao tem .env proprio.
/**
 * Audit FORENSE: movimentacao de produtos entre localizacoes.
 *
 * Read-only. GARANTIA: nenhum create/update/delete/upsert.
 *
 * POR QUE EXISTE
 * --------------
 * A MK2 Autopecas relatou pecas que "sumiram" ao usar a gaveta
 * /localizacoes -> olho -> selecionar -> Mover. Nem `LocationUseCase.moveProducts`
 * nem `LocationRepositoryPrisma.moveProducts` gravam SystemLog ou StockLog.
 *
 * MAS o `loggingMiddleware` e global (app/api/api.ts:172) e classifica QUALQUER
 * `POST /locations*` como `CREATE_LOCATION` — entao a requisicao de movimentacao
 * ESTA no SystemLog, sob o rotulo errado, com `details.body.productIds`.
 * E a mesma armadilha ja documentada para o `POST /products/bulk-delete`
 * (tests/logging-middleware-action-type.spec.ts, caso Portal Eco Pecas).
 *
 * O DESTINO DA MOVIMENTACAO NAO SOBREVIVE: `sanitizeDeep` redige toda chave cujo
 * nome contenha "rg", e "targetLocationId" contem "rg" (ta-RG-etlocationid).
 * Vira "[REDACTED]" tanto para id real quanto para null. `productIds` passa.
 *
 * MAS outros caminhos declaram o destino em claro, e servem de ancora:
 *   - POST /locations/:id/attach-products -> details.params.id (chave "id", nao redige)
 *   - PUT  /products/:id                  -> details.body.locationId E body.location
 *   - POST /products                      -> idem
 *
 * NAO REGISTRAR em run-all.ts: exige argumentos e sai com codigo 1 quando ACHA
 * coisa — num agregado de saude isso viraria falso alarme permanente.
 *
 * USO
 * ---
 *   npx tsx scripts/prod-audit/audit-location-moves.ts --email mk2autopecas@gmail.com \
 *      --de 2026-09-07 --ate 2026-09-10 --csv scripts/out/mk2-0907-0910
 *   (--ate omitido = agora)
 *
 * Rodar com PRISMA_CONNECTION_LIMIT=3: o default de app/lib/prisma.ts e 15 e a
 * VPS ja mantem 4 processos pm2 no mesmo pool do Supavisor.
 */
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  prisma,
  section,
  sub,
  printTable,
  newOutcome,
  logFinding,
  withPrisma,
  type AuditOutcome,
} from "./shared";

const ROTA_MOVE = "/locations/move-products";
const CAIXAS_DO_VIDEO = [
  "1P1CX102",
  "1P2CX102",
  "1P3CX102",
  "1P4CX102",
  "09110209",
];

// ------------------------------------------------------------------ args

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf("--" + nome);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * O Brasil nao tem horario de verao desde 2019 -> offset FIXO -03:00. Explicitar
 * evita depender do fuso da maquina (a minha e a da VPS nao sao a mesma coisa).
 * Se o pais voltar a ter DST, esta conta passa a estar 1h errada.
 */
function paraInstante(texto: string): Date {
  let d: Date;
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(texto)) {
    d = new Date(texto + "T00:00:00-03:00");
  } else if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}/.test(texto)) {
    d = new Date(texto + "-03:00");
  } else {
    throw new Error(
      "--de/--ate invalido: " + texto + " (use AAAA-MM-DD ou AAAA-MM-DDTHH:mm)",
    );
  }
  if (Number.isNaN(d.getTime())) throw new Error("Data invalida: " + texto);
  return d;
}

/** Formata em horario de Brasilia, sem depender do fuso do processo. */
function brt(d: Date | string | null | undefined): string {
  if (d === null || d === undefined || d === "") return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return String(d);
  const deslocado = new Date(dt.getTime() - 3 * 60 * 60 * 1000);
  return deslocado.toISOString().replace("T", " ").slice(0, 19) + "-03:00";
}

/**
 * Recusa rodar fora de producao. O .env de worktree ja apontou para a replica de
 * Ohio (congelada, que ACEITA escrita em silencio) — e um relatorio forense feito
 * contra o banco errado e pior que relatorio nenhum.
 */
function assertBanco(): string {
  const url = process.env.DATABASE_URL ?? "";
  const host = /@([^:/?]+)/.exec(url)?.[1] ?? "(desconhecido)";
  if (!host.includes("sa-east-1")) {
    throw new Error(
      "[abortado] Banco nao e producao (Sao Paulo). Host lido: " +
        host +
        ". Esperado conter sa-east-1.",
    );
  }
  return host;
}

/**
 * Tripwire, nao muralha: `$queryRawUnsafe` aceitaria uma CTE que escreve, e a
 * unica garantia de verdade seria um papel read-only no Postgres, que este
 * projeto nao tem. Serve para pegar engano, nao para conter ma-fe.
 */
async function ro<T>(sql: string, ...p: unknown[]): Promise<T[]> {
  const inicio = sql
    .replace(/--[^\n]*/g, "")
    .trim()
    .slice(0, 6)
    .toUpperCase();
  if (inicio !== "SELECT" && inicio.slice(0, 4) !== "WITH") {
    throw new Error(
      "[abortado] SQL nao comeca em SELECT/WITH: " + sql.slice(0, 80),
    );
  }
  return prisma.$queryRawUnsafe<T[]>(sql, ...p);
}

// ---------------------------------------------------------------- tenant

type Tenant = {
  dataOwnerId: string;
  userIds: string[];
  rotulos: Map<string, string>;
};

/**
 * Colaborador herda do admin: o dono dos dados e sempre parentUserId ?? id.
 *
 * DIVERGE DE PROPOSITO de SystemLogService.getTenantUserIds: la, um colaborador
 * so enxerga os proprios logs, porque aquilo e fronteira de AUTORIZACAO. Aqui
 * queremos o tenant INTEIRO mesmo que --email seja de um colaborador. Nao
 * "consertar" para ficar igual.
 */
async function resolverTenant(email: string): Promise<Tenant> {
  const u = await prisma.user.findUnique({
    where: { email },
    select: { id: true, parentUserId: true },
  });
  if (!u) throw new Error("Usuario nao encontrado: " + email);
  const dataOwnerId = u.parentUserId ?? u.id;

  const membros = await prisma.user.findMany({
    where: { OR: [{ id: dataOwnerId }, { parentUserId: dataOwnerId }] },
    select: { id: true, name: true, email: true },
  });
  return {
    dataOwnerId,
    userIds: membros.map((m) => m.id),
    rotulos: new Map(
      membros.map((m) => [m.id, (m.name ?? "sem nome") + " <" + m.email + ">"]),
    ),
  };
}

// ------------------------------------------------------------------- csv

function csvEscape(v: unknown, sep: string): string {
  const s = v === null || v === undefined ? "" : String(v);
  const precisa = s.includes('"') || s.includes(sep) || /[\n\r\t]/.test(s);
  return precisa ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * BOM na frente: sem ele o Excel em pt-BR le UTF-8 como Latin-1 e "Localizacao"
 * vira mojibake. O repo so tinha codigo que REMOVE BOM; este escreve — a planilha
 * vai para o cliente, nao para um desenvolvedor.
 *
 * Delimitador ";" porque o Excel pt-BR usa ";" como separador de lista; com ","
 * o arquivo inteiro cai na coluna A.
 *
 * As ressalvas NAO vao no topo deste arquivo de proposito: linhas de prosa antes
 * do cabecalho fazem o Excel errar a deteccao de cabecalho e quebram
 * csv.DictReader. Elas vao no 00-LEIA-ANTES.*, que ordena primeiro na pasta.
 */
function escreverCsv(
  dir: string | null,
  nome: string,
  linhas: Array<Record<string, unknown>>,
  sep = ";",
): void {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const destino = join(dir, nome);
  const cols = linhas.length > 0 ? Object.keys(linhas[0]) : ["vazio"];
  const corpo = [
    cols.join(sep),
    ...linhas.map((l) => cols.map((c) => csvEscape(l[c], sep)).join(sep)),
  ].join("\r\n");
  writeFileSync(destino, "\ufeff" + corpo, "utf8");
  console.log("  [csv] " + destino + " (" + linhas.length + " linha(s))");
}

const RESSALVAS: string[] = [
  "Product.updatedAt e bumpado por QUALQUER escrita na peca (preco, estoque, sync de marketplace, edicao, republicacao). 'Pecas com updatedAt na janela' NAO e 'pecas movidas na janela'. Tem falso positivo, sempre.",
  "moveProducts (location.repository.ts:392) nao filtra pela origem: peca que JA estava no destino e atualizada do mesmo jeito e entra na contagem. O count da resposta SUPERESTIMA o movimento real - e nem esse count esta no log (so o pedido e logado).",
  "details.body.productIds e o que foi PEDIDO. O updateMany ainda filtra por userId; id de outro dono e descartado em silencio.",
  "targetLocationId sai do log como [REDACTED] por colisao de substring (ta-RG-etlocationid). Destino marcado RECONSTRUIDO e INFERENCIA - veja a coluna confianca_destino.",
  "A ORIGEM da movimentacao NAO foi gravada em lugar nenhum e nao existe tabela de historico de localizacao. Onde esta DESCONHECIDA, e desconhecida - nao e vazio.",
  "Evento com status diferente de 200 NAO moveu nada: a validacao de destino e de capacidade roda ANTES do update.",
  "Log ausente NAO e movimento ausente: o middleware grava dentro de um setImmediate e engole a propria falha. Script ou SQL direto no banco nao passa por HTTP e nao gera log NENHUM.",
  "Mover com o seletor em 'Sem localizacao' e clicar em 'Desvincular' emitem requisicoes BYTE A BYTE identicas. Nenhum metodo baseado em log separa as duas. Este relatorio NAO atribui um desvinculo a um botao especifico.",
  "Este relatorio diz quem CLICOU. Nao diz quem levantou a caixa.",
];

// ------------------------------------------------------------------ tipos

type LinhaLog = {
  id: string;
  ts: Date;
  user_id: string | null;
  ip: string | null;
  user_agent: string | null;
  action: string;
  nivel: string;
  rota: string | null;
  metodo: string | null;
  status: number | null;
  duracao_ms: number | null;
  destino_bruto: string | null;
  destino_param: string | null;
  destino_body: string | null;
  destino_texto: string | null;
  resource_id: string | null;
  product_ids: string[] | null;
};

type ProdutoAtual = {
  id: string;
  sku: string;
  name: string;
  stock: number;
  preco: number;
  location_id: string | null;
  texto_legado: string | null;
  updated_at: Date;
};

type Evento = LinhaLog & {
  tipo: "move" | "attach" | "edita-produto" | "cria-produto" | "outro";
  destinoId: string | null;
  destinoCaminho: string | null;
  confianca: "declarado" | "reconstruido-alta" | "reconstruido-media" | "desconhecida";
  heuristicaUi: string;
};

// ------------------------------------------------------- arvore de locais

type NoLocal = { id: string; code: string; parentId: string | null };

/**
 * Reimplementa o caminho em memoria espelhando LocationUseCase.listForSelect
 * (location.usercase.ts:454-463): sobe por parentId, unshift do code, junta com
 * " > " e guarda anti-ciclo em 50.
 *
 * DE PROPOSITO nao importa o LocationUseCase: um relatorio forense precisa seguir
 * dizendo o que o banco dizia no dia em que rodou, mesmo depois que o construtor
 * de caminho da aplicacao mudar.
 */
function montarCaminhos(nos: NoLocal[]): Map<string, string> {
  const mapa = new Map(nos.map((n) => [n.id, n]));
  const saida = new Map<string, string>();
  for (const no of nos) {
    const partes: string[] = [];
    let cur: NoLocal | undefined = no;
    let guarda = 0;
    while (cur && guarda++ < 50) {
      partes.unshift(cur.code);
      cur = cur.parentId ? mapa.get(cur.parentId) : undefined;
    }
    saida.set(no.id, partes.join(" > "));
  }
  return saida;
}

function normalizarCodigo(c: string): string {
  return c.replace(/[\s-]/g, "").toUpperCase();
}

// ------------------------------------------------------------- auditoria

export type OpcoesAuditoria = {
  email: string;
  de: Date;
  ate: Date;
  csvDir?: string | null;
  toleranciaMs?: number;
  limiteTabela?: number;
};

export async function auditLocationMoves(
  opts: OpcoesAuditoria,
): Promise<AuditOutcome> {
  const outcome = newOutcome("location-moves");
  const csv = opts.csvDir ?? null;
  const tol = opts.toleranciaMs ?? 5000;
  const lim = opts.limiteTabela ?? 40;

  // ---------------------------------------------------------- secao 0
  section("COMO LER ESTE RELATORIO - LEIA ANTES DOS NUMEROS");
  RESSALVAS.forEach((r, i) => console.log("  " + (i + 1) + ". " + r));
  escreverCsv(
    csv,
    "00-LEIA-ANTES.csv",
    RESSALVAS.map((aviso, i) => ({ n: i + 1, aviso })),
  );

  const tenant = await resolverTenant(opts.email);
  section("ESCOPO");
  sub("tenant (dataOwnerId)", tenant.dataOwnerId);
  sub("userIds do tenant (admin + colaboradores)", tenant.userIds.length);
  printTable(
    tenant.userIds.map((id) => ({ id, quem: tenant.rotulos.get(id) ?? "?" })),
    50,
  );
  sub("janela de (UTC)", opts.de.toISOString());
  sub("janela de (BRT)", brt(opts.de));
  sub("janela ate (UTC, exclusivo)", opts.ate.toISOString());
  sub("janela ate (BRT, exclusivo)", brt(opts.ate));

  const P = [tenant.userIds, opts.de, opts.ate, tenant.dataOwnerId] as const;

  // ---------------------------------------------------------- secao 1
  section("1. EXISTE LOG? ESTA REDIGIDO? A JANELA CABE NA RETENCAO?");

  const horizonte = await ro<{
    mais_antigo: Date | null;
    mais_novo: Date | null;
    total: number;
  }>(
    `SELECT min(sl."createdAt") AS mais_antigo,
            max(sl."createdAt") AS mais_novo,
            count(*)::int       AS total
       FROM "SystemLog" sl
      WHERE sl."userId" = ANY($1::text[])`,
    P[0],
  );
  sub("logs do tenant (total, toda a historia)", horizonte[0]?.total ?? 0);
  sub("log mais antigo", brt(horizonte[0]?.mais_antigo));
  sub("log mais novo", brt(horizonte[0]?.mais_novo));
  if (horizonte[0]?.mais_antigo && horizonte[0].mais_antigo > opts.de) {
    logFinding(
      outcome,
      "A RETENCAO COMECA DEPOIS DO INICIO DA JANELA (" +
        brt(horizonte[0].mais_antigo) +
        "). Linha do tempo vazia aqui NAO prova ausencia de movimentacao - a poda de scripts/prune-system-logs.ts pode ter levado.",
    );
  }

  /**
   * DESCOBERTA sem apostar no rotulo: se producao algum dia ficar atras de um
   * proxy que prefixa caminho, `cleanUrl.startsWith("/locations")` deixa de casar
   * e as linhas caem em USER_ACTIVITY. Por isso NAO filtramos por `action` aqui.
   */
  const descoberta = await ro<{
    action: string;
    nivel: string;
    rota: string;
    metodo: string;
    n: number;
  }>(
    `WITH base AS (
        SELECT sl.action, sl.level::text AS nivel, (sl.details)::jsonb AS d
          FROM "SystemLog" sl
         WHERE sl."userId" = ANY($1::text[])
           AND sl."createdAt" >= $2 AND sl."createdAt" < $3
      )
      SELECT action, nivel,
             split_part(d->>'url', '?', 1) AS rota,
             d->>'method'                  AS metodo,
             count(*)::int                 AS n
        FROM base
       WHERE d->>'url' LIKE '%move-products%'
          OR d->>'url' LIKE '%attach-products%'
       GROUP BY 1,2,3,4 ORDER BY 5 DESC`,
    P[0],
    P[1],
    P[2],
  );
  sub("rotas de movimentacao encontradas no log", descoberta.length);
  printTable(descoberta, lim);
  if (descoberta.length === 0) {
    logFinding(
      outcome,
      "NENHUM registro de move/attach na janela. Ver a ressalva 7 antes de concluir que nao houve movimentacao.",
    );
  }

  const censo = await ro<{
    eventos: number;
    destino_redigido: number;
    destino_legivel: number;
    chave_ausente: number;
    com_lista_de_ids: number;
  }>(
    `WITH base AS (
        SELECT (sl.details)::jsonb AS d
          FROM "SystemLog" sl
         WHERE sl."userId" = ANY($1::text[])
           AND sl."createdAt" >= $2 AND sl."createdAt" < $3
      )
      SELECT count(*)::int AS eventos,
             count(*) FILTER (WHERE d#>>'{body,targetLocationId}' = '[REDACTED]')::int AS destino_redigido,
             count(*) FILTER (WHERE d#>>'{body,targetLocationId}' IS NOT NULL
                                AND d#>>'{body,targetLocationId}' <> '[REDACTED]')::int AS destino_legivel,
             count(*) FILTER (WHERE NOT ((d#>'{body}') ? 'targetLocationId'))::int AS chave_ausente,
             count(*) FILTER (WHERE jsonb_typeof(d#>'{body,productIds}') = 'array')::int AS com_lista_de_ids
        FROM base
       WHERE split_part(d->>'url','?',1) LIKE '%' || $4`,
    P[0],
    P[1],
    P[2],
    ROTA_MOVE,
  );
  const c0 = censo[0];
  sub("eventos de move-products na janela", c0?.eventos ?? 0);
  sub("  com destino REDIGIDO", c0?.destino_redigido ?? 0);
  sub("  com destino LEGIVEL", c0?.destino_legivel ?? 0);
  sub("  sem a chave targetLocationId", c0?.chave_ausente ?? 0);
  sub("  com a lista de productIds preservada", c0?.com_lista_de_ids ?? 0);
  if ((c0?.destino_redigido ?? 0) > 0) {
    logFinding(
      outcome,
      (c0?.destino_redigido ?? 0) +
        " evento(s) com destino redigido pelo sanitizador. O destino destes sai por INFERENCIA do estado atual.",
    );
  }

  // Logs sem dono (401/403 antes do authMiddleware setar request.user).
  const semDono = await ro<{ n: number }>(
    `WITH base AS (
        SELECT (sl.details)::jsonb AS d
          FROM "SystemLog" sl
         WHERE sl."userId" IS NULL
           AND sl."createdAt" >= $1 AND sl."createdAt" < $2
      )
      SELECT count(*)::int AS n FROM base
       WHERE d->>'url' LIKE '%move-products%'`,
    P[1],
    P[2],
  );
  sub(
    "move-products SEM userId (401/403; nao atribuiveis a nenhum tenant)",
    semDono[0]?.n ?? 0,
  );

  // ---------------------------------------------------------- secao 2
  section("2. LINHA DO TEMPO DOS EVENTOS QUE MEXEM EM LOCALIZACAO");

  const brutos = await ro<LinhaLog>(
    `WITH base AS (
        SELECT sl.id, sl."createdAt" AS ts, sl."userId" AS user_id,
               sl."ipAddress" AS ip, sl."userAgent" AS user_agent,
               sl.action, sl.level::text AS nivel, sl."resourceId" AS resource_id,
               (sl.details)::jsonb AS d
          FROM "SystemLog" sl
         WHERE sl."userId" = ANY($1::text[])
           AND sl."createdAt" >= $2 AND sl."createdAt" < $3
      )
      SELECT id, ts, user_id, ip, user_agent, action, nivel, resource_id,
             split_part(d->>'url','?',1)   AS rota,
             d->>'method'                  AS metodo,
             (d->>'statusCode')::int       AS status,
             (d->>'duration')::int         AS duracao_ms,
             d#>>'{body,targetLocationId}' AS destino_bruto,
             d#>>'{params,id}'             AS destino_param,
             d#>>'{body,locationId}'       AS destino_body,
             d#>>'{body,location}'         AS destino_texto,
             CASE WHEN jsonb_typeof(d#>'{body,productIds}') = 'array'
                  THEN ARRAY(SELECT jsonb_array_elements_text(d#>'{body,productIds}'))
             END AS product_ids
        FROM base
       WHERE split_part(d->>'url','?',1) LIKE '%/locations/%products'
          OR (split_part(d->>'url','?',1) LIKE '/products/%' AND d->>'method' = 'PUT')
          OR (split_part(d->>'url','?',1) = '/products' AND d->>'method' = 'POST')
       ORDER BY ts ASC`,
    P[0],
    P[1],
    P[2],
  );

  const eventos: Evento[] = brutos.map((l) => {
    const rota = l.rota ?? "";
    let tipo: Evento["tipo"] = "outro";
    if (rota.endsWith(ROTA_MOVE)) tipo = "move";
    else if (/\/locations\/[^/]+\/attach-products$/.test(rota)) tipo = "attach";
    else if (rota.startsWith("/products/") && l.metodo === "PUT")
      tipo = "edita-produto";
    else if (rota === "/products" && l.metodo === "POST") tipo = "cria-produto";

    let destinoId: string | null = null;
    let confianca: Evento["confianca"] = "desconhecida";
    if (tipo === "attach" && l.destino_param) {
      destinoId = l.destino_param;
      confianca = "declarado";
    } else if (
      (tipo === "edita-produto" || tipo === "cria-produto") &&
      l.destino_body !== null
    ) {
      destinoId = l.destino_body;
      confianca = "declarado";
    } else if (
      tipo === "move" &&
      l.destino_bruto &&
      l.destino_bruto !== "[REDACTED]"
    ) {
      destinoId = l.destino_bruto;
      confianca = "declarado";
    }
    return {
      ...l,
      tipo,
      destinoId,
      destinoCaminho: null,
      confianca,
      heuristicaUi: "",
    };
  });

  sub("eventos na janela", eventos.length);
  const porTipo = new Map<string, number>();
  for (const e of eventos) porTipo.set(e.tipo, (porTipo.get(e.tipo) ?? 0) + 1);
  printTable([...porTipo].map(([tipo, n]) => ({ tipo, n })), 20);

  const moves = eventos.filter((e) => e.tipo === "move");
  const movesOk = moves.filter((e) => e.status === 200);
  sub("eventos de MOVE", moves.length);
  sub("  com status 200 (realmente executaram)", movesOk.length);
  sub("  com status != 200 (TENTATIVA, nao moveu nada)", moves.length - movesOk.length);

  // Prova do rotulo errado, em vez de afirmacao.
  const rotulos = new Map<string, number>();
  for (const e of moves) rotulos.set(e.action, (rotulos.get(e.action) ?? 0) + 1);
  if (rotulos.size > 0) {
    sub("rotulo sob o qual o MOVE aparece na auditoria", "");
    printTable([...rotulos].map(([action, n]) => ({ action, n })), 10);
    if (rotulos.has("CREATE_LOCATION")) {
      logFinding(
        outcome,
        "Confirmado: " +
          rotulos.get("CREATE_LOCATION") +
          " movimentacao(oes) auditada(s) como CREATE_LOCATION (rotulo errado).",
      );
    }
  }

  // ------------------------------------------- estado atual dos produtos
  const idsEnvolvidos = [
    ...new Set(eventos.flatMap((e) => e.product_ids ?? [])),
  ];
  const produtos = new Map<string, ProdutoAtual>();
  for (let i = 0; i < idsEnvolvidos.length; i += 5000) {
    const lote = idsEnvolvidos.slice(i, i + 5000);
    const rows = await ro<ProdutoAtual>(
      `SELECT p.id, p.sku, p.name, p.stock, p.price::float8 AS preco,
              p."locationId" AS location_id, p.location AS texto_legado,
              p."updatedAt"  AS updated_at
         FROM "Product" p
        WHERE p."userId" = $1 AND p.id = ANY($2::text[])`,
      P[3],
      lote,
    );
    for (const r of rows) produtos.set(r.id, r);
  }
  sub("produtos distintos citados nos eventos", idsEnvolvidos.length);
  sub("  desses, ainda existentes e do tenant", produtos.size);

  const locais = await ro<NoLocal>(
    `SELECT l.id, l.code, l."parentId" AS "parentId"
       FROM "Location" l WHERE l."userId" = $1`,
    P[3],
  );
  const caminhos = montarCaminhos(locais);
  const porCodigo = new Map(locais.map((l) => [normalizarCodigo(l.code), l]));
  sub("localizacoes cadastradas hoje", locais.length);

  // ---------------------------------------------------------- secao 3
  section("3. RECONSTRUCAO DO DESTINO E ENCADEAMENTO DA ORIGEM");
  console.log(
    "  A origem do PRIMEIRO evento de cada peca nao existe em lugar nenhum do banco.\n" +
      "  `Product` guarda so o estado atual e nao ha tabela de historico de locationId.\n" +
      "  Onde sai DESCONHECIDA, e desconhecida - nao e vazio.",
  );

  // Ultimo evento de cada produto: so nele o estado atual e uma semente valida.
  const ultimoEventoDoProduto = new Map<string, string>();
  for (const e of eventos) {
    if (e.status !== 200 && e.status !== 201) continue;
    for (const pid of e.product_ids ?? []) ultimoEventoDoProduto.set(pid, e.id);
  }

  for (const e of eventos) {
    if (e.confianca === "declarado") {
      e.destinoCaminho = e.destinoId ? (caminhos.get(e.destinoId) ?? null) : null;
      continue;
    }
    if (e.status !== 200) continue;
    const terminais = (e.product_ids ?? []).filter(
      (pid) => ultimoEventoDoProduto.get(pid) === e.id && produtos.has(pid),
    );
    if (terminais.length === 0) continue;

    const distintos = new Set(
      terminais.map((pid) => produtos.get(pid)!.location_id ?? "__SEM__"),
    );
    if (distintos.size !== 1) continue; // discordam -> nao preencher

    const alvo = [...distintos][0];
    // Teste de toque: updatedAt dentro da janela do evento recupera, por peca, o
    // que o `count` da resposta diria - e a resposta nao e logada.
    const inicio = e.ts.getTime() - (e.duracao_ms ?? 0) - tol;
    const fim = e.ts.getTime() + tol;
    const todosTocados = terminais.every((pid) => {
      const t = produtos.get(pid)!.updated_at.getTime();
      return t >= inicio && t <= fim;
    });
    e.destinoId = alvo === "__SEM__" ? null : alvo;
    e.destinoCaminho = e.destinoId
      ? (caminhos.get(e.destinoId) ?? null)
      : "(SEM LOCALIZACAO)";
    e.confianca = todosTocados ? "reconstruido-alta" : "reconstruido-media";
  }

  // Heuristica de origem de UI - com o limite declarado junto.
  const attachRecentes = eventos.filter((e) => e.tipo === "attach");
  for (const e of moves) {
    const n = (e.product_ids ?? []).length;
    if (n > 1) {
      e.heuristicaUi = "lote (so pode ser a tela de localizacoes) [MEDIA]";
    } else if (n === 1) {
      const pid = e.product_ids![0];
      const casou = attachRecentes.some(
        (a) =>
          a.user_id === e.user_id &&
          (a.product_ids ?? []).includes(pid) &&
          a.ts.getTime() < e.ts.getTime() &&
          e.ts.getTime() - a.ts.getTime() < 30 * 60 * 1000,
      );
      e.heuristicaUi = casou
        ? "desfazer do scan [ALTA]"
        : "indeterminado [BAIXA]";
    }
  }
  console.log(
    "\n  LIMITE DECLARADO: `handleMoveProducts` com o seletor em __none__ e\n" +
      "  `handleUnbindProducts` emitem requisicoes BYTE A BYTE identicas (mesma URL,\n" +
      "  mesmo metodo, mesmo corpo). Nenhum metodo baseado em log separa as duas.",
  );

  const linhasEventos = eventos.map((e) => ({
    log_id: e.id,
    ts_brt: brt(e.ts),
    ts_utc: e.ts.toISOString(),
    usuario: e.user_id ? (tenant.rotulos.get(e.user_id) ?? e.user_id) : "",
    action: e.action,
    rota: e.rota ?? "",
    metodo: e.metodo ?? "",
    status: e.status ?? "",
    duracao_ms: e.duracao_ms ?? "",
    tipo: e.tipo,
    n_ids_pedidos: (e.product_ids ?? []).length,
    destino_id: e.destinoId ?? "",
    destino_caminho: e.destinoCaminho ?? "",
    confianca_destino: e.confianca,
    heuristica_ui: e.heuristicaUi,
    ip: e.ip ?? "",
  }));
  printTable(linhasEventos, lim);
  escreverCsv(csv, "01-eventos.csv", linhasEventos);

  // Grao (evento, produto), com origem encadeada.
  const eventosDoProduto = new Map<string, Evento[]>();
  for (const e of eventos) {
    for (const pid of e.product_ids ?? []) {
      if (!eventosDoProduto.has(pid)) eventosDoProduto.set(pid, []);
      eventosDoProduto.get(pid)!.push(e);
    }
  }
  const linhasEvProd: Array<Record<string, unknown>> = [];
  for (const [pid, lista] of eventosDoProduto) {
    const p = produtos.get(pid);
    lista.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    lista.forEach((e, k) => {
      const anterior = k > 0 ? lista[k - 1] : null;
      const inicio = e.ts.getTime() - (e.duracao_ms ?? 0) - tol;
      const fim = e.ts.getTime() + tol;
      const tocado = p
        ? p.updated_at.getTime() >= inicio && p.updated_at.getTime() <= fim
          ? "S"
          : "N"
        : "?";
      linhasEvProd.push({
        log_id: e.id,
        ts_brt: brt(e.ts),
        usuario: e.user_id ? (tenant.rotulos.get(e.user_id) ?? e.user_id) : "",
        tipo: e.tipo,
        status: e.status ?? "",
        produto_id: pid,
        sku: p?.sku ?? "(nao existe mais)",
        nome: p?.name ?? "",
        origem_id: anterior ? (anterior.destinoId ?? "") : "",
        origem_caminho: anterior
          ? (anterior.destinoCaminho ?? "DESCONHECIDA")
          : "DESCONHECIDA (primeiro evento da peca na janela)",
        destino_id: e.destinoId ?? "",
        destino_caminho: e.destinoCaminho ?? "",
        confianca_destino: e.confianca,
        tocado_pelo_evento: tocado,
        produto_updated_at: p ? brt(p.updated_at) : "",
        location_id_hoje: p?.location_id ?? "",
        texto_legado_hoje: p?.texto_legado ?? "",
      });
    });
  }
  sub("linhas (evento x produto)", linhasEvProd.length);
  printTable(linhasEvProd, lim);
  escreverCsv(csv, "02-evento-produto.csv", linhasEvProd);

  // ---------------------------------------------------------- secao 4
  section("4. PECAS ORFAS (locationId IS NULL)");

  const baseline = await ro<{
    antes: number;
    na_janela: number;
    depois: number;
    mais_antigo: Date | null;
  }>(
    `SELECT count(*) FILTER (WHERE p."updatedAt" <  $2)::int AS antes,
            count(*) FILTER (WHERE p."updatedAt" >= $2 AND p."updatedAt" < $3)::int AS na_janela,
            count(*) FILTER (WHERE p."updatedAt" >= $3)::int AS depois,
            min(p."updatedAt") AS mais_antigo
       FROM "Product" p
      WHERE p."userId" = $1 AND p."locationId" IS NULL`,
    P[3],
    P[1],
    P[2],
  );
  const b = baseline[0];
  sub("orfas com ultima escrita ANTES da janela", b?.antes ?? 0);
  sub("orfas com ultima escrita NA janela", b?.na_janela ?? 0);
  sub("orfas com ultima escrita DEPOIS da janela", b?.depois ?? 0);
  console.log(
    "  Estes tres baldes particionam por ULTIMA ESCRITA, nao por 'quando virou orfa'.\n" +
      "  Peca desvinculada em 08/09 e reprecificada em 14/09 cai no balde DEPOIS.\n" +
      "  Por isso as DUAS janelas precisam ser rodadas.",
  );

  const orfas = await ro<ProdutoAtual>(
    `SELECT p.id, p.sku, p.name, p.stock, p.price::float8 AS preco,
            p."locationId" AS location_id, p.location AS texto_legado,
            p."updatedAt" AS updated_at
       FROM "Product" p
      WHERE p."userId" = $1 AND p."locationId" IS NULL
        AND p."updatedAt" >= $2 AND p."updatedAt" < $3
      ORDER BY p."updatedAt" ASC`,
    P[3],
    P[1],
    P[2],
  );

  // Cruzamento DEFINITIVO: o id aparece no productIds de um evento?
  const moveDoProduto = new Map<string, Evento>();
  for (const e of moves) {
    if (e.status !== 200) continue;
    for (const pid of e.product_ids ?? []) moveDoProduto.set(pid, e);
  }
  const edicaoLimpouLocal = new Map<string, Evento>();
  for (const e of eventos) {
    if (e.tipo !== "edita-produto") continue;
    if (e.destino_body !== null) continue; // so quando mandou locationId: null
    if (e.resource_id) edicaoLimpouLocal.set(e.resource_id, e);
  }

  const linhasOrfas = orfas.map((o) => {
    const ev = moveDoProduto.get(o.id);
    const ed = edicaoLimpouLocal.get(o.id);
    let balde: string;
    let confianca: string;
    if (o.texto_legado !== null) {
      balde = "D4 - localizacao EXCLUIDA ou import legado sem FK";
      confianca = "alta quanto a causa";
    } else if (ev) {
      balde = "D1 - desvinculo pela tela de localizacoes ou desfazer do scan";
      confianca = "alta";
    } else if (ed) {
      balde = "D2 - operador limpou a localizacao na edicao da peca";
      confianca = "alta";
    } else {
      balde = "D3 - sem log correspondente (script, SQL direto, ou log perdido)";
      confianca = "baixa";
    }
    const casado = ev ?? ed ?? null;
    return {
      sku: o.sku,
      nome: o.name,
      estoque: o.stock,
      preco: String(o.preco).replace(".", ","),
      updated_at: brt(o.updated_at),
      texto_legado: o.texto_legado ?? "",
      balde,
      confianca,
      evento_casado_ts: casado ? brt(casado.ts) : "",
      evento_casado_usuario:
        casado && casado.user_id
          ? (tenant.rotulos.get(casado.user_id) ?? casado.user_id)
          : "",
    };
  });
  sub("orfas na janela", linhasOrfas.length);
  const porBalde = new Map<string, number>();
  for (const l of linhasOrfas)
    porBalde.set(l.balde, (porBalde.get(l.balde) ?? 0) + 1);
  printTable([...porBalde].map(([balde, n]) => ({ balde, n })), 10);
  printTable(linhasOrfas, lim);
  escreverCsv(csv, "03-orfas.csv", linhasOrfas);
  if (linhasOrfas.length > 0) {
    logFinding(
      outcome,
      linhasOrfas.length +
        " peca(s) sem localizacao com ultima escrita na janela - estas sao as candidatas a 'peca que o sistema nao sabe apontar'.",
    );
  }

  // Caixas apagadas, recuperadas pelo texto legado que o deleteRecursive deixa.
  const caixasApagadas = await ro<{
    caixa: string;
    pecas: number;
    primeira: Date;
    ultima: Date;
  }>(
    `SELECT p.location AS caixa, count(*)::int AS pecas,
            min(p."updatedAt") AS primeira, max(p."updatedAt") AS ultima
       FROM "Product" p
      WHERE p."userId" = $1 AND p."locationId" IS NULL AND p.location IS NOT NULL
        AND p."updatedAt" >= $2 AND p."updatedAt" < $3
      GROUP BY 1 ORDER BY 2 DESC`,
    P[3],
    P[1],
    P[2],
  );
  const deletes = eventos.filter((e) => e.action === "DELETE_LOCATION");
  sub("textos de caixa orfaos (candidatos a caixa excluida)", caixasApagadas.length);
  sub("eventos DELETE_LOCATION na janela", deletes.length);
  console.log(
    "  D4 NAO separa 'caixa excluida nesta janela' de 'import legado que nunca teve FK'.\n" +
      "  O separador e a existencia de um DELETE_LOCATION na janela, e isso e indireto.\n" +
      "  Um DELETE_LOCATION cascateia para as filhas, entao 1 evento pode gerar varios textos.",
  );
  const linhasCaixas = caixasApagadas.map((c) => ({
    caixa_apagada: c.caixa,
    pecas: c.pecas,
    primeira: brt(c.primeira),
    ultima: brt(c.ultima),
    existe_hoje: porCodigo.has(normalizarCodigo(c.caixa)) ? "SIM" : "NAO",
  }));
  printTable(linhasCaixas, lim);
  escreverCsv(csv, "04-caixas-apagadas.csv", linhasCaixas);

  // ---------------------------------------------------------- secao 5
  section("5. PANORAMA POR CAIXA (onde as pecas estao HOJE)");
  const panorama = await ro<{
    location_id: string | null;
    pecas: number;
    primeira: Date;
    ultima: Date;
  }>(
    `SELECT p."locationId" AS location_id, count(*)::int AS pecas,
            min(p."updatedAt") AS primeira, max(p."updatedAt") AS ultima
       FROM "Product" p
      WHERE p."userId" = $1
        AND p."updatedAt" >= $2 AND p."updatedAt" < $3
      GROUP BY 1 ORDER BY 2 DESC`,
    P[3],
    P[1],
    P[2],
  );
  const linhasPanorama = panorama.map((p) => ({
    location_id: p.location_id ?? "",
    caminho: p.location_id
      ? (caminhos.get(p.location_id) ?? "(localizacao nao existe mais)")
      : "(SEM LOCALIZACAO)",
    pecas_tocadas_na_janela: p.pecas,
    primeira: brt(p.primeira),
    ultima: brt(p.ultima),
  }));
  sub("caixas com peca tocada na janela", linhasPanorama.length);
  printTable(linhasPanorama, lim);
  escreverCsv(csv, "05-panorama-por-caixa.csv", linhasPanorama);
  console.log(
    "  A coluna diz TOCADAS, nao MOVIDAS - ver ressalva 1. Este e um recorte do\n" +
      "  presente filtrado por updatedAt, nao uma foto de como a caixa estava em 07/09.",
  );

  // ---------------------------------------------------------- secao 6
  section("6. AS CAIXAS CITADAS NO VIDEO");
  const alvos = await ro<{
    id: string;
    code: string;
    pecas_hoje: number;
    tocadas: number;
  }>(
    `SELECT l.id, l.code,
            (SELECT count(*) FROM "Product" p WHERE p."locationId" = l.id)::int AS pecas_hoje,
            (SELECT count(*) FROM "Product" p
              WHERE p."locationId" = l.id
                AND p."updatedAt" >= $2 AND p."updatedAt" < $3)::int AS tocadas
       FROM "Location" l
      WHERE l."userId" = $1
        AND ( upper(regexp_replace(l.code, '[[:space:]-]', '', 'g')) = ANY($4::text[])
              OR l.code ILIKE '%102%'
              OR l.code ILIKE '%0911%' )
      ORDER BY l.code`,
    P[3],
    P[1],
    P[2],
    CAIXAS_DO_VIDEO,
  );
  const linhasAlvo = alvos.map((a) => ({
    code: a.code,
    caminho: caminhos.get(a.id) ?? a.code,
    pecas_hoje: a.pecas_hoje,
    pecas_tocadas_na_janela: a.tocadas,
  }));
  printTable(linhasAlvo, lim);
  for (const pedido of CAIXAS_DO_VIDEO) {
    if (!porCodigo.has(pedido)) {
      logFinding(
        outcome,
        "Caixa do video NAO EXISTE HOJE: " +
          pedido +
          " - cruzar com os textos legados da secao 4.",
      );
    }
  }
  escreverCsv(csv, "06-caixas-alvo.csv", linhasAlvo);

  // ---------------------------------------------------------- secao 7
  section("7. VARREDURA GERAL DA JANELA");
  const acoes = await ro<{ action: string; nivel: string; n: number }>(
    `SELECT sl.action, sl.level::text AS nivel, count(*)::int AS n
       FROM "SystemLog" sl
      WHERE sl."userId" = ANY($1::text[])
        AND sl."createdAt" >= $2 AND sl."createdAt" < $3
      GROUP BY 1,2 ORDER BY 3 DESC`,
    P[0],
    P[1],
    P[2],
  );
  sub("actions distintas no SystemLog", acoes.length);
  printTable(acoes, lim);
  escreverCsv(csv, "07-systemlog-por-acao.csv", acoes);

  const estoque = await ro<{
    reason: string;
    n: number;
    delta: number;
    pecas: number;
  }>(
    `SELECT s.reason, count(*)::int AS n, sum(s.change)::int AS delta,
            count(DISTINCT s."productId")::int AS pecas
       FROM "StockLog" s
       JOIN "Product" p ON p.id = s."productId"
      WHERE p."userId" = $1
        AND s."createdAt" >= $2 AND s."createdAt" < $3
      GROUP BY 1 ORDER BY 2 DESC`,
    P[3],
    P[1],
    P[2],
  );
  sub("motivos distintos no StockLog", estoque.length);
  printTable(estoque, lim);
  escreverCsv(csv, "08-stocklog-por-motivo.csv", estoque);
  console.log(
    "  StockLog registra QUANTIDADE, nunca POSICAO. Peca que mudou de caixa sem\n" +
      "  mexer no estoque nao deixa rastro NENHUM aqui. Serve so para explicar o\n" +
      "  ruido de updatedAt e mostrar o que mais acontecia na janela.",
  );

  return outcome;
}

// -------------------------------------------------------------- main

if (require.main === module) {
  const host = assertBanco();
  console.log("[banco] " + host);
  const de = paraInstante(arg("de") ?? "2026-09-07");
  const ate = arg("ate") ? paraInstante(arg("ate")!) : new Date();
  withPrisma(async () =>
    auditLocationMoves({
      email: arg("email") ?? "mk2autopecas@gmail.com",
      de,
      ate,
      csvDir: arg("csv") ?? null,
      toleranciaMs: arg("tolerancia-ms")
        ? Number(arg("tolerancia-ms"))
        : undefined,
      limiteTabela: arg("limite") ? Number(arg("limite")) : undefined,
    }),
  )
    .then((o) => {
      console.log("\n[fim] achados: " + o.findings.length);
      process.exit(o.findings.length > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
