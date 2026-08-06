// PRIMEIRA linha de propósito: carrega o .env antes de o import do prisma ser
// avaliado. Ver o comentário em scripts/lib/load-env.ts.
import "./lib/load-env";
import axios from "axios";
import prisma from "../app/lib/prisma";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { ML_CONSTANTS } from "../app/marketplaces/mercado-livre/ml-constants";
import { applyOemTags } from "../app/marketplaces/lib/ml-oem-tags.logic";

/**
 * Tabula a causa REAL dos anúncios parados com erro de `family_name`.
 *
 * POR QUE ISTO EXISTE: o `lastError` desses anúncios guarda o erro da PRIMEIRA
 * tentativa (`family_name`), que a escada já resolve sozinha. A causa que o
 * operador consegue corrigir só aparece nas retentativas e nunca é persistida —
 * por isso 136 anúncios ficaram meses parados sem ninguém saber o motivo.
 *
 * Esta sonda reproduz o payload NO FORMATO QUE A ESCADA JÁ ENVIA na retentativa
 * (com `family_name`, sem `title`, OEM como lista de tags) e pergunta ao ML o
 * que ele acha — em lote, agrupando as causas.
 *
 * SEGURANÇA: `POST /items/validate` valida o corpo e NÃO cria item nenhum. Nada
 * é publicado. A única escrita é a rotação de access_token expirado, com a mesma
 * regra do app. Nenhum token é impresso.
 *
 * Uso:
 *   tsx scripts/probe-ml-family-name-tabular.ts --limite=12
 */

const args = process.argv.slice(2);
const argValue = (n: string) =>
  args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? null;
const limite = Number(argValue("limite") ?? "12");

interface Causa {
  cause_id?: number;
  code?: string;
  message?: string;
}

function causasDe(data: unknown): Causa[] {
  if (!data || typeof data !== "object") return [];
  const c = (data as { cause?: Causa[] }).cause;
  return Array.isArray(c) ? c : [];
}

async function tokenDaConta(conta: {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}): Promise<string> {
  if (new Date(conta.expiresAt).getTime() > Date.now() + 60_000) {
    return conta.accessToken;
  }
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
  return novo.accessToken;
}

async function main(): Promise<void> {
  const listings = await prisma.productListing.findMany({
    where: {
      lastError: { contains: "family_name" },
      marketplaceAccount: { status: "ACTIVE", platform: "MERCADO_LIVRE" },
    },
    select: {
      id: true,
      marketplaceAccount: {
        select: {
          id: true,
          accountName: true,
          accessToken: true,
          refreshToken: true,
          expiresAt: true,
        },
      },
      product: {
        select: {
          sku: true,
          name: true,
          price: true,
          stock: true,
          brand: true,
          partNumber: true,
          imageUrl: true,
          imageUrls: true,
          attributes: true,
          mlCategory: { select: { externalId: true } },
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: limite,
  });

  console.log(
    `[tabular] ${listings.length} anuncios parados | POST /items/validate (nao cria nada)\n`,
  );

  const tokens = new Map<string, string>();
  const contagem = new Map<string, number>();
  const exemplos = new Map<string, string>();

  for (const l of listings) {
    const p = l.product;
    const conta = l.marketplaceAccount;
    if (!p || !conta || !p.mlCategory?.externalId) continue;

    if (!tokens.has(conta.id)) {
      tokens.set(conta.id, await tokenDaConta(conta));
    }
    const token = tokens.get(conta.id)!;

    const imagens = (
      Array.isArray(p.imageUrls) ? (p.imageUrls as string[]) : []
    ).filter((u) => typeof u === "string" && u.length > 0);
    if (imagens.length === 0 && p.imageUrl) imagens.push(p.imageUrl);

    const attrsProduto = (p.attributes ?? {}) as Record<
      string,
      { value_id?: string; value_name?: string }
    >;
    const attributes: Array<{
      id: string;
      value_id?: string;
      value_name?: string;
    }> = Object.entries(attrsProduto).map(([id, v]) => ({
      id,
      ...(v?.value_id ? { value_id: v.value_id } : {}),
      ...(v?.value_name ? { value_name: v.value_name } : {}),
    }));
    if (p.brand && !attrsProduto.BRAND) {
      attributes.push({ id: "BRAND", value_name: p.brand });
    }
    if (p.partNumber && !attrsProduto.PART_NUMBER) {
      attributes.push({ id: "PART_NUMBER", value_name: p.partNumber });
    }

    // Formato que a escada JÁ envia na retentativa, com o OEM pós-#243.
    const body: Record<string, unknown> = {
      family_name: p.name.slice(0, 60),
      category_id: p.mlCategory.externalId,
      price: Number(p.price),
      currency_id: "BRL",
      available_quantity: Math.max(1, Math.min(p.stock, 999999)),
      buying_mode: "buy_it_now",
      listing_type_id: "gold_special",
      condition: "used",
      pictures: imagens.slice(0, 10).map((source) => ({ source })),
      attributes: applyOemTags(attributes, new Set(["OEM"])),
      description: { plain_text: p.name },
    };

    let chave = "(sem resposta)";
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
      if (resp.status === 204 || resp.status === 200) {
        chave = "PASSARIA";
      } else {
        const cs = causasDe(resp.data);
        chave =
          cs.length > 0
            ? cs
                .map((c) => `${c.cause_id ?? "?"} ${c.code ?? ""}`.trim())
                .sort()
                .join(" + ")
            : `HTTP ${resp.status}`;
        if (!exemplos.has(chave) && cs[0]?.message) {
          exemplos.set(chave, cs[0].message);
        }
      }
    } catch (e) {
      chave = `rede: ${e instanceof Error ? e.message : String(e)}`;
    }

    contagem.set(chave, (contagem.get(chave) ?? 0) + 1);
    console.log(
      `  ${String(p.sku).padEnd(14)} ${String(p.mlCategory.externalId).padEnd(10)} ${chave}`,
    );
  }

  console.log("\n" + "=".repeat(74));
  console.log("CAUSA REAL, AGRUPADA");
  console.log("=".repeat(74));
  const ordenado = [...contagem.entries()].sort((a, b) => b[1] - a[1]);
  for (const [chave, n] of ordenado) {
    console.log(`${String(n).padStart(3)}x  ${chave}`);
    const ex = exemplos.get(chave);
    if (ex) console.log(`      "${ex.slice(0, 150)}"`);
  }
  console.log("");
  console.log(
    "Nenhuma dessas causas aparece no `lastError` — la esta gravado o erro de",
  );
  console.log("family_name da 1a tentativa, que a escada ja resolve sozinha.");
}

main()
  .catch((e) => {
    console.error("[tabular] erro:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
