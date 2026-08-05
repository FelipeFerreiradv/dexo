// PRIMEIRA linha de propósito: carrega o .env antes de o import do prisma ser
// avaliado. Ver o comentário em scripts/lib/load-env.ts.
import "./lib/load-env";
import axios from "axios";
import prisma from "../app/lib/prisma";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { ML_CONSTANTS } from "../app/marketplaces/mercado-livre/ml-constants";
import { applyOemTags } from "../app/marketplaces/lib/ml-oem-tags.logic";

/**
 * Sonda do `family_name` — descobre o que uma categoria aceita ANTES de mexer
 * na escada de criação de anúncio.
 *
 * O PROBLEMA QUE ELA EXISTE PARA RESOLVER:
 *
 * A criação falha com `cause_id 369` / "The body does not contains some or none
 * of the following properties [family_name]" em categorias fora da allowlist de
 * `ListingUseCase.shouldIncludeFamilyName`. Medido em produção em 05/08/2026:
 * 136 ProductListing com esse erro, o mais antigo de 09/05/2026.
 *
 * ⚠️ CORREÇÃO DE UMA PREMISSA ERRADA: a escada JÁ reage a esse erro. Ela detecta
 * por SUBSTRING ("family_name" na mensagem), não por `cause_id` — é por isso que
 * um grep por "369" não acha nada. Ver listing.usercase.ts:2462-2469. O retry
 * reenvia com `family_name` e SEM `title`. Ou seja: o bug não é "falta o retry",
 * é que o retry também está falhando — e o erro gravado em `lastError` é o da
 * PRIMEIRA tentativa, que esconde a causa real.
 *
 * O QUE ESTA SONDA RESPONDE, contra a categoria de verdade:
 *   V1  title, sem family_name          (o que a 1ª tentativa manda hoje)
 *   V2  family_name, sem title          (o que o retry manda hoje)  <- A PERGUNTA
 *   V3  family_name + title             (a combinação que a allowlist evita)
 *   V4  igual a V2, sem os atributos opcionais  (isola ruído de atributo)
 *
 * SEGURANÇA: usa `POST /items/validate`, que valida o corpo e **não cria item
 * nenhum** — 204 significa "seria aceito". Nada é publicado, nada é cobrado,
 * nada aparece na conta do vendedor. A única escrita possível é a rotação do
 * access_token quando ele já expirou, com a mesma regra do app (só se faltar
 * menos de 60s). Nenhum token é impresso.
 *
 * Uso:
 *   tsx scripts/probe-ml-family-name.ts --sku=2789 --email=fulano@dominio.com
 *   tsx scripts/probe-ml-family-name.ts --sku=2789 --email=... --full
 */

const args = process.argv.slice(2);
const argValue = (name: string): string | null =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ??
  null;

const skuArg = argValue("sku");
const emailArg = argValue("email");
const full = args.includes("--full");

function log(msg: string): void {
  console.log(msg);
}

function section(titulo: string): void {
  log("");
  log("=".repeat(74));
  log(titulo);
  log("=".repeat(74));
}

/** Resume o corpo de erro do ML nas causas, que é o que interessa. */
function resumirErro(data: unknown): string {
  if (!data || typeof data !== "object") return String(data);
  const d = data as {
    message?: string;
    error?: string;
    cause?: Array<{ cause_id?: number; code?: string; message?: string }>;
  };
  const causas = Array.isArray(d.cause) ? d.cause : [];
  if (causas.length === 0) {
    return `${d.error ?? ""} ${d.message ?? ""}`.trim() || JSON.stringify(data);
  }
  return causas
    .map((c) => `[${c.cause_id ?? "?"}] ${c.code ?? ""} — ${c.message ?? ""}`)
    .join("\n         ");
}

interface Variante {
  nome: string;
  descricao: string;
  monta: (base: Record<string, unknown>) => Record<string, unknown>;
}

async function main(): Promise<void> {
  if (!skuArg || !emailArg) {
    console.error(
      "[probe] Uso: tsx scripts/probe-ml-family-name.ts --sku=2789 --email=fulano@dominio.com",
    );
    process.exit(1);
  }

  const user = await prisma.user.findFirst({
    where: { email: emailArg },
    select: { id: true },
  });
  if (!user) {
    console.error(`[probe] usuário ${emailArg} não encontrado.`);
    process.exit(1);
  }

  const product = await prisma.product.findFirst({
    where: { sku: skuArg, userId: user.id },
    select: {
      id: true,
      name: true,
      sku: true,
      price: true,
      stock: true,
      brand: true,
      partNumber: true,
      imageUrls: true,
      imageUrl: true,
      attributes: true,
      mlCategory: { select: { externalId: true, fullPath: true } },
      listings: {
        select: {
          externalListingId: true,
          status: true,
          marketplaceAccount: {
            select: {
              id: true,
              accountName: true,
              platform: true,
              accessToken: true,
              refreshToken: true,
              expiresAt: true,
            },
          },
        },
      },
    },
  });
  if (!product) {
    console.error(`[probe] SKU ${skuArg} não encontrado para ${emailArg}.`);
    process.exit(1);
  }

  const listagem = product.listings.find(
    (l) => l.marketplaceAccount?.platform === "MERCADO_LIVRE",
  );
  if (!listagem?.marketplaceAccount) {
    console.error("[probe] produto sem conta do Mercado Livre vinculada.");
    process.exit(1);
  }
  const conta = listagem.marketplaceAccount;

  let token = conta.accessToken;
  if (new Date(conta.expiresAt).getTime() <= Date.now() + 60_000) {
    log("[probe] access_token expirado — rotacionando.");
    const novo = await MLOAuthService.refreshAccessTokenForAccount(
      conta.id,
      conta.refreshToken,
    );
    await prisma.marketplaceAccount.update({
      where: { id: conta.id },
      data: {
        accessToken: novo.accessToken,
        refreshToken: novo.refreshToken,
        expiresAt: new Date(Date.now() + novo.expiresIn * 1000),
      },
    });
    token = novo.accessToken;
  }

  const categoria = product.mlCategory?.externalId;
  if (!categoria) {
    console.error("[probe] produto sem categoria do ML resolvida.");
    process.exit(1);
  }

  const imagens = (
    Array.isArray(product.imageUrls) ? (product.imageUrls as string[]) : []
  ).filter((u) => typeof u === "string" && u.length > 0);
  if (imagens.length === 0 && product.imageUrl) imagens.push(product.imageUrl);

  // Atributos no mesmo formato que o payload de produção monta.
  const attrsProduto = (product.attributes ?? {}) as Record<
    string,
    { value_id?: string; value_name?: string }
  >;
  const attributes: Array<Record<string, unknown>> = Object.entries(
    attrsProduto,
  ).map(([id, v]) => ({
    id,
    ...(v?.value_id ? { value_id: v.value_id } : {}),
    ...(v?.value_name ? { value_name: v.value_name } : {}),
  }));
  if (product.brand && !attrsProduto.BRAND) {
    attributes.push({ id: "BRAND", value_name: product.brand });
  }
  if (product.partNumber && !attrsProduto.PART_NUMBER) {
    attributes.push({ id: "PART_NUMBER", value_name: product.partNumber });
  }

  const titulo = product.name.slice(0, 60);

  const base: Record<string, unknown> = {
    category_id: categoria,
    price: Number(product.price),
    currency_id: "BRL",
    available_quantity: Math.max(1, Math.min(product.stock, 999999)),
    buying_mode: "buy_it_now",
    listing_type_id: "gold_special",
    condition: "used",
    pictures: imagens.slice(0, 10).map((source) => ({ source })),
    attributes,
    description: { plain_text: product.name },
  };

  section("CONTEXTO");
  log(`produto ....... ${product.name}`);
  log(`sku ........... ${product.sku}`);
  log(`conta ......... ${conta.accountName}`);
  log(`categoria ..... ${categoria} — ${product.mlCategory?.fullPath}`);
  log(`imagens ....... ${imagens.length}`);
  log(`atributos ..... ${attributes.map((a) => a.id).join(", ")}`);
  log("");
  log("MODO: POST /items/validate — NENHUM item e criado.");

  const variantes: Variante[] = [
    {
      nome: "V1",
      descricao: "title, SEM family_name  (o que a 1a tentativa manda hoje)",
      monta: (b) => ({ ...b, title: titulo }),
    },
    {
      nome: "V2",
      descricao: "family_name, SEM title  (o que o retry manda hoje)",
      monta: (b) => ({ ...b, family_name: titulo }),
    },
    {
      nome: "V3",
      descricao: "family_name + title  (a combinacao que a allowlist evita)",
      monta: (b) => ({ ...b, family_name: titulo, title: titulo }),
    },
    {
      nome: "V4",
      descricao: "family_name, SEM title, SO com os atributos obrigatorios",
      monta: (b) => ({
        ...b,
        family_name: titulo,
        attributes: attributes.filter((a) =>
          ["BRAND", "PART_NUMBER", "VEHICLE_TYPE"].includes(String(a.id)),
        ),
      }),
    },
    {
      // O que a PRODUCAO manda desde o deploy do #243: o OEM vira lista de
      // tags, e o split faz dedup. Se o ML reclamava de valor repetido no
      // `value_name` com virgulas, esta variante e a mesma coisa sem o repetido.
      nome: "V5",
      descricao: "family_name, SEM title, OEM como TAGS deduplicadas (pos-#243)",
      monta: (b) => ({
        ...b,
        family_name: titulo,
        attributes: applyOemTags(
          attributes as Array<{
            id: string;
            value_id?: string;
            value_name?: string;
          }>,
          new Set(["OEM"]),
        ),
      }),
    },
    {
      // Isola o ruido do proprio probe: o payload de producao carrega
      // `shipping`, e sem ele o ML reclama de modo de envio.
      nome: "V6",
      descricao: "igual a V5, mais o bloco shipping (elimina ruido do probe)",
      monta: (b) => ({
        ...b,
        family_name: titulo,
        attributes: applyOemTags(
          attributes as Array<{
            id: string;
            value_id?: string;
            value_name?: string;
          }>,
          new Set(["OEM"]),
        ),
        shipping: { mode: "me2", local_pick_up: false, free_shipping: false },
      }),
    },
  ];

  const veredito: Array<{ nome: string; ok: boolean; resumo: string }> = [];

  for (const v of variantes) {
    section(`${v.nome} — ${v.descricao}`);
    const body = v.monta(base);
    if (full) {
      log(JSON.stringify(body, null, 2));
    } else {
      log(
        `campos: ${Object.keys(body).join(", ")}` +
          `${body.title ? ` | title="${body.title}"` : ""}` +
          `${body.family_name ? ` | family_name="${body.family_name}"` : ""}`,
      );
    }

    try {
      const resp = await axios.post(
        `${ML_CONSTANTS.API_URL}/items/validate`,
        body,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
          validateStatus: () => true,
        },
      );
      const ok = resp.status === 204 || resp.status === 200;
      log("");
      log(`status: ${resp.status}${ok ? "  >>> ACEITARIA" : ""}`);
      if (!ok) {
        log(`causas:  ${resumirErro(resp.data)}`);
      }
      veredito.push({
        nome: v.nome,
        ok,
        resumo: ok ? "aceitaria" : resumirErro(resp.data).split("\n")[0],
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`FALHOU (rede): ${msg}`);
      veredito.push({ nome: v.nome, ok: false, resumo: `rede: ${msg}` });
    }
  }

  section("VEREDITO");
  for (const v of veredito) {
    log(`${v.nome}  ${v.ok ? "OK        " : "RECUSADO  "}  ${v.resumo}`);
  }
  log("");
  log(
    "Se V2 for OK, a escada atual ja bastaria e o problema esta em outro ponto.",
  );
  log(
    "Se V2 for RECUSADO, a causa que aparecer nele e o bloqueio REAL — o que o",
  );
  log("lastError esconde por guardar o erro da 1a tentativa.");
}

main()
  .catch((err) => {
    console.error("[probe] erro:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
