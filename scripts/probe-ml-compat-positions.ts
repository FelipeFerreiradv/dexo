// PRIMEIRA linha de propósito: carrega o .env (subindo diretórios) antes que o
// import do prisma seja avaliado. Ver o comentário em scripts/lib/load-env.ts.
import "./lib/load-env";
import axios from "axios";
import prisma from "../app/lib/prisma";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { ML_CONSTANTS } from "../app/marketplaces/mercado-livre/ml-constants";

/**
 * Sonda das POSIÇÕES de compatibilidade do Mercado Livre.
 *
 * MOTIVO — o bloqueador que esta sonda existe para resolver:
 *
 * A documentação oficial põe as posições num array `restrictions`, irmão de
 * `attributes`, DENTRO de `products_families[]`:
 *
 *   "products_families": [{
 *     "domain_id": "MLB-CARS_AND_VANS", "creation_source": "DEFAULT",
 *     "attributes": [ ... ],
 *     "restrictions": [{ "attribute_id": "POSITION", "attribute_values": [
 *       { "values": [{ "value_id": "...", "value_name": "Dianteira" }] } ] }]
 *   }]
 *
 * Só que `products_families` é o degrau de FALLBACK da escada de
 * `applyCompatibilitiesVerified`. O degrau que vence em produção é o
 * `create.products: [{id}]` (ver o comentário em ml-api.service.ts:1780-1784,
 * "confirmado em prod 23/04", e inspectCompatWriteResponse:266-270, que registra
 * MLB7216055142 saindo de 0 para 57 compatibilidades com esse exato shape).
 *
 * Implementar só o documentado enviaria posição quase nunca — e o verificador
 * atual diria `ok: true, verified: true` de qualquer forma, porque ele declara
 * sucesso ao ver o `id` ecoado e é CEGO a `restrictions`. É a mesma família de
 * falha silenciosa que este código já sofreu duas vezes. Por isso: sonda antes
 * de código de produção.
 *
 * O QUE ESTA SONDA RESPONDE:
 *   1. `GET /items/{id}` devolve o `domain_id` DA PEÇA? Hoje o repositório só lê
 *      o domínio do VEÍCULO; o da peça é obrigatório para resolver os value_id
 *      das posições. Se não vier aqui, é request nova por publicação — muda o
 *      cálculo de egress.
 *   2. `GET /catalog_compatibilities/restrictions/values` devolve o quê para
 *      esse par de domínios? Dump dos value_id reais, dos `opposite_values`
 *      (combinações mutuamente exclusivas) e dos `combined_values`.
 *   3. Qual shape de ESCRITA o ML aceita E PERSISTE:
 *        H1  create.products: [{ id, restrictions: [...] }]   <- o degrau que vence
 *        H2  restrictions no nível do create
 *        H3  create.products_families[].restrictions          <- o documentado
 *      Cada hipótese é verificada por um GET de leitura de volta SEPARADO, com
 *      `?extended=true` — não dá para confiar no verificador do sistema.
 *   4. `creation_source` é aceito? É exigido? (a doc diz que virou obrigatório e
 *      o repositório não envia esse campo em lugar nenhum)
 *
 * SEGURANÇA — leia antes de rodar:
 * Por padrão a sonda é READ-ONLY: faz só os GETs de 1 e 2 e imprime os bodies
 * que ELA enviaria em 3, sem enviar nada. As escritas do passo 3 só acontecem
 * com --apply, e ESCREVEM DE VERDADE num anúncio real. Use um anúncio de TESTE
 * descartável: o código de compatibilidade do ML é ADITIVO (nunca emite delete),
 * então as posições gravadas aqui não têm como ser desfeitas pelo sistema.
 * Nenhum access_token é impresso.
 *
 * Uso:
 *   tsx scripts/probe-ml-compat-positions.ts --item=MLB1234567890
 *   tsx scripts/probe-ml-compat-positions.ts --item=MLB123 --apply
 *   tsx scripts/probe-ml-compat-positions.ts --item=MLB123 --apply --only=H1
 *
 * Flags:
 *   --item=MLB...        (obrigatório) anúncio a sondar
 *   --account-id=ID      conta ML específica; default = a conta dona do anúncio
 *   --product-id=MLB...  catalog product id do veículo para as escritas de H1/H2;
 *                        default = o primeiro que já estiver na compat do item
 *   --apply              EXECUTA as escritas do passo 3 (sem isso, só imprime)
 *   --only=H1|H2|H3      roda só uma hipótese
 *   --full               imprime bodies completos em vez de resumo + amostra
 */

const args = process.argv.slice(2);
const argValue = (name: string): string | null =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ??
  null;

const itemIdArg = argValue("item");
const accountIdArg = argValue("account-id");
const productIdArg = argValue("product-id");
const onlyArg = (argValue("only") ?? "").toUpperCase();
const apply = args.includes("--apply");
const full = args.includes("--full");

const VEHICLE_DOMAIN = "MLB-CARS_AND_VANS";

/** Os 12 rótulos do modal "Adicione as posições" da Central de Vendedores. */
const ROTULOS_UI = [
  "Passageiro",
  "Motorista",
  "Direita",
  "Esquerda",
  "Traseira",
  "Dianteira",
  "Externo",
  "Interno",
  "Inferior",
  "Superior",
  "Intermédio",
  "Centro",
];

function log(msg: string): void {
  console.log(msg);
}

function section(title: string): void {
  log("");
  log("=".repeat(78));
  log(title);
  log("=".repeat(78));
}

function dump(data: unknown, maxChars = 2500): string {
  let text: string;
  try {
    text = JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
  if (text === undefined) return "undefined";
  if (full || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncado — rode com --full; ${text.length} chars]`;
}

interface ProbeResult {
  ok: boolean;
  status: number | null;
  data: unknown;
  error?: string;
}

async function probeGet(url: string, token: string): Promise<ProbeResult> {
  log("");
  log(`--- GET ${url}`);
  try {
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000,
      validateStatus: () => true,
    });
    log(`    status: ${resp.status}`);
    log(`    body: ${dump(resp.data)}`);
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      data: resp.data,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`    FALHOU (rede/timeout): ${msg}`);
    return { ok: false, status: null, data: null, error: msg };
  }
}

/** PUT de escrita. Só roda com --apply; sem a flag, apenas imprime o body. */
async function probePut(
  url: string,
  body: unknown,
  token: string,
): Promise<ProbeResult | null> {
  log("");
  log(`--- PUT ${url}`);
  log(`    body: ${JSON.stringify(body, null, 2)}`);
  if (!apply) {
    log("    [dry-run] nada enviado. Use --apply para executar.");
    return null;
  }
  try {
    const resp = await axios.put(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
      validateStatus: () => true,
    });
    log(`    status: ${resp.status}`);
    log(`    body: ${dump(resp.data)}`);
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      data: resp.data,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`    FALHOU (rede/timeout): ${msg}`);
    return { ok: false, status: null, data: null, error: msg };
  }
}

async function resolveToken(): Promise<{
  token: string;
  accountId: string;
  accountName: string;
} | null> {
  let account: {
    id: string;
    accountName: string | null;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  } | null = null;

  const select = {
    id: true,
    accountName: true,
    accessToken: true,
    refreshToken: true,
    expiresAt: true,
  } as const;

  if (accountIdArg) {
    account = await prisma.marketplaceAccount.findFirst({
      where: { id: accountIdArg, platform: "MERCADO_LIVRE" },
      select,
    });
    if (!account) {
      console.error(`[probe] Conta ML ${accountIdArg} não encontrada.`);
      return null;
    }
  } else {
    const listing = await prisma.productListing.findFirst({
      where: {
        externalListingId: itemIdArg!,
        marketplaceAccount: { platform: "MERCADO_LIVRE" },
      },
      select: { marketplaceAccount: { select } },
    });
    if (!listing?.marketplaceAccount) {
      console.error(
        `[probe] Não achei ProductListing para ${itemIdArg}. Passe --account-id.`,
      );
      return null;
    }
    account = listing.marketplaceAccount;
  }

  // Refresca só se faltar menos de 60s para expirar — mesma regra e mesma
  // sequência da probe-ml-compat-read (é a única escrita do modo read-only).
  let token = account.accessToken;
  if (new Date(account.expiresAt).getTime() <= Date.now() + 60_000) {
    log("[probe] access_token expirado — rotacionando.");
    const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
      account.id,
      account.refreshToken,
    );
    await prisma.marketplaceAccount.update({
      where: { id: account.id },
      data: {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      },
    });
    token = refreshed.accessToken;
  }

  return {
    token,
    accountId: account.id,
    accountName: account.accountName ?? "(sem nome)",
  };
}

/** Monta o bloco `restrictions` a partir de posições resolvidas. */
function montarRestrictions(
  posicoes: Array<Array<{ value_id: string; value_name: string }>>,
) {
  return [
    {
      attribute_id: "POSITION",
      attribute_values: posicoes.map((combo) => ({ values: combo })),
    },
  ];
}

async function main(): Promise<void> {
  if (!itemIdArg) {
    console.error(
      "[probe] Uso: tsx scripts/probe-ml-compat-positions.ts --item=MLB... [--apply]",
    );
    process.exit(1);
  }

  const auth = await resolveToken();
  if (!auth) process.exit(1);
  const { token } = auth;

  log(`[probe] anúncio: ${itemIdArg}`);
  log(`[probe] conta: ${auth.accountName} (${auth.accountId})`);
  log(`[probe] modo: ${apply ? "APPLY (ESCREVE NO ML)" : "dry-run (read-only)"}`);

  // ---------------------------------------------------------------------
  section("1. O GET /items devolve o domain_id DA PEÇA?");
  // ---------------------------------------------------------------------
  const item = await probeGet(
    `${ML_CONSTANTS.API_URL}/items/${itemIdArg}`,
    token,
  );
  const itemData = (item.data ?? {}) as Record<string, unknown>;
  const partDomain = itemData.domain_id as string | undefined;
  const userProductId = itemData.user_product_id as string | undefined;
  const categoryId = itemData.category_id as string | undefined;

  log("");
  log(`>>> domain_id da peça: ${partDomain ?? "AUSENTE — precisa de request extra"}`);
  log(`>>> user_product_id:   ${userProductId ?? "(nenhum — item legado)"}`);
  log(`>>> category_id:       ${categoryId ?? "?"}`);
  log(
    `>>> tags relevantes:   ${JSON.stringify(
      ((itemData.tags as string[]) ?? []).filter((t) =>
        /compatibilit/i.test(t),
      ),
    )}`,
  );

  // ---------------------------------------------------------------------
  section("2. Valores permitidos de POSITION para esse par de domínios");
  // ---------------------------------------------------------------------
  if (!partDomain) {
    log("PULADO: sem domain_id da peça não dá para consultar as restrições.");
  } else {
    const restr = await probeGet(
      `${ML_CONSTANTS.API_URL}/catalog_compatibilities/restrictions/values` +
        `?main_domain_id=${encodeURIComponent(VEHICLE_DOMAIN)}` +
        `&secondary_domain_id=${encodeURIComponent(partDomain)}`,
      token,
    );

    const attrs = (restr.data as { attributes_values?: unknown[] })
      ?.attributes_values;
    const position = Array.isArray(attrs)
      ? (attrs.find(
          (a) => (a as { attribute_id?: string }).attribute_id === "POSITION",
        ) as
          | {
              values?: Array<{
                value_id: string;
                value_name: string;
                opposite_values?: string[];
              }>;
              combined_values?: Array<{
                values: Array<{ value_id: string; value_name: string }>;
              }>;
            }
          | undefined)
      : undefined;

    log("");
    if (!position) {
      log(">>> Essa categoria NÃO expõe restrição de POSITION.");
    } else {
      const vals = position.values ?? [];
      log(`>>> ${vals.length} valores simples:`);
      for (const v of vals) {
        const op = v.opposite_values?.length
          ? ` (exclui: ${v.opposite_values.join(", ")})`
          : "";
        log(`      ${v.value_id.padEnd(12)} ${v.value_name}${op}`);
      }
      log(`>>> ${(position.combined_values ?? []).length} combinações prontas.`);

      // Confere se os 12 rótulos da UI casam com o que o ML devolve aqui.
      const norm = (s: string) =>
        s
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .trim()
          .toLowerCase();
      const disponiveis = new Set(vals.map((v) => norm(v.value_name)));
      const semCorrespondencia = ROTULOS_UI.filter(
        (r) => !disponiveis.has(norm(r)),
      );
      log("");
      log(
        `>>> rótulos da UI SEM correspondência nesse domínio (${semCorrespondencia.length}/12): ` +
          (semCorrespondencia.join(", ") || "nenhum"),
      );
    }
  }

  // ---------------------------------------------------------------------
  section("3. Compatibilidades atuais (base para o read-back)");
  // ---------------------------------------------------------------------
  const antes = await probeGet(
    `${ML_CONSTANTS.API_URL}/items/${itemIdArg}/compatibilities?extended=true`,
    token,
  );
  const produtosAtuais = ((antes.data as { products?: Array<{ id?: string }> })
    ?.products ?? []) as Array<Record<string, unknown>>;
  const productIdParaTeste =
    productIdArg ??
    (produtosAtuais.find((p) => typeof p.catalog_product_id === "string")
      ?.catalog_product_id as string | undefined) ??
    (produtosAtuais.find((p) => typeof p.id === "string")?.id as
      | string
      | undefined);

  log("");
  log(`>>> compatibilidades hoje: ${produtosAtuais.length}`);
  log(`>>> product id para o teste de escrita: ${productIdParaTeste ?? "NENHUM"}`);
  log(
    ">>> alguma já tem `restrictions`? " +
      JSON.stringify(
        produtosAtuais.filter((p) => p.restrictions !== undefined).length,
      ),
  );

  // ---------------------------------------------------------------------
  section("4. Hipóteses de ESCRITA");
  // ---------------------------------------------------------------------
  if (!apply) {
    log("MODO DRY-RUN: os bodies abaixo seriam enviados. Nada foi escrito.");
  }
  if (!productIdParaTeste) {
    log(
      "SEM product id — passe --product-id=MLB... para testar as escritas de H1/H2.",
    );
  }

  // Posições de teste: uma simples e uma combinada. Os value_id reais saem do
  // passo 2; aqui usamos placeholders explícitos para o dry-run não mentir.
  const posicoesTeste = montarRestrictions([
    [{ value_id: "PREENCHER_COM_O_PASSO_2", value_name: "Dianteira" }],
    [
      { value_id: "PREENCHER_COM_O_PASSO_2", value_name: "Dianteira" },
      { value_id: "PREENCHER_COM_O_PASSO_2", value_name: "Esquerda" },
    ],
  ]);

  const alvo = userProductId
    ? `${ML_CONSTANTS.API_URL}/user-products/${userProductId}/compatibilities`
    : `${ML_CONSTANTS.API_URL}/items/${itemIdArg}/compatibilities`;

  const hipoteses: Array<{ nome: string; body: Record<string, unknown> }> = [];

  // H1 — restrictions DENTRO de cada product. É o degrau que vence em produção.
  if (productIdParaTeste) {
    hipoteses.push({
      nome: "H1",
      body: {
        domain_id: VEHICLE_DOMAIN,
        ...(categoryId ? { category_id: categoryId } : {}),
        create: {
          products: [
            {
              id: productIdParaTeste,
              creation_source: "DEFAULT",
              restrictions: posicoesTeste,
            },
          ],
          universal: false,
        },
      },
    });

    // H2 — restrictions no nível do create. Se funcionar, é o mais econômico:
    // uma posição por produto não precisa ser repetida em N famílias.
    hipoteses.push({
      nome: "H2",
      body: {
        domain_id: VEHICLE_DOMAIN,
        ...(categoryId ? { category_id: categoryId } : {}),
        create: {
          products: [{ id: productIdParaTeste }],
          restrictions: posicoesTeste,
          universal: false,
        },
      },
    });
  }

  // H3 — o shape documentado, dentro de products_families.
  hipoteses.push({
    nome: "H3",
    body: {
      domain_id: VEHICLE_DOMAIN,
      ...(categoryId ? { category_id: categoryId } : {}),
      create: {
        products_families: [
          {
            domain_id: VEHICLE_DOMAIN,
            creation_source: "DEFAULT",
            attributes: [
              { id: "BRAND", value_name: "Volkswagen" },
              { id: "MODEL", value_name: "Gol" },
              { id: "YEAR", value_name: "2014" },
            ],
            restrictions: posicoesTeste,
          },
        ],
        universal: false,
      },
    },
  });

  for (const h of hipoteses) {
    if (onlyArg && onlyArg !== h.nome) continue;
    section(`4.${h.nome} — ${h.nome}`);
    await probePut(alvo, h.body, token);

    if (apply) {
      // Read-back SEPARADO. O verificador do sistema é cego a restrictions:
      // ele declara sucesso só por ver o id ecoado.
      log("");
      log(`>>> read-back de ${h.nome}:`);
      const depois = await probeGet(
        `${ML_CONSTANTS.API_URL}/items/${itemIdArg}/compatibilities?extended=true`,
        token,
      );
      const lista = ((depois.data as { products?: unknown[] })?.products ??
        []) as Array<Record<string, unknown>>;
      const comRestricao = lista.filter((p) => p.restrictions !== undefined);
      log(
        `>>> ${h.nome}: ${lista.length} compatibilidades, ${comRestricao.length} COM restrictions`,
      );
      if (comRestricao.length > 0) {
        log(`>>> amostra: ${dump(comRestricao[0])}`);
      }
    }
  }

  section("VEREDITO — preencher à mão depois de rodar com --apply");
  log("  [ ] O GET /items devolve domain_id da peça?");
  log("  [ ] A categoria expõe restrição de POSITION?");
  log("  [ ] Quantos dos 12 rótulos da UI existem nesse domínio?");
  log("  [ ] H1 aceitou (2xx) E o read-back mostrou restrictions?");
  log("  [ ] H2 aceitou E persistiu?");
  log("  [ ] H3 aceitou E persistiu?");
  log("  [ ] creation_source foi aceito sem erro?");
  log("");
  log(
    "  Se só H3 persistir: NÃO implementar o envio — o degrau documentado é o " +
      "fallback, e forçar a escada a mudar de ordem é risco alto num código com " +
      "histórico de falha silenciosa.",
  );
}

main()
  .catch((err) => {
    console.error("[probe] erro:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
