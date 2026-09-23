/**
 * Reenvia a descrição dos anúncios do Mercado Livre que ficaram SEM descrição
 * porque o texto tinha emoji (23/09/2026 — SKU 7167 da Portal Eco Peças; ver
 * app/marketplaces/lib/ml-description-text.ts). Roda NA VPS.
 *
 *   npx tsx scripts/fix-ml-empty-descriptions.ts [--user-email=x] [--limit=N]          (dry-run: só lê)
 *   npx tsx scripts/fix-ml-empty-descriptions.ts [--user-email=x] [--limit=N] --apply  (reenvia)
 *
 * Seleção: anúncio ML ativo/pausado cuja descrição do produto tem símbolo ou
 * emoji (a partir de U+2190). Para cada um, LÊ a descrição no ML: só a que
 * está VAZIA entra. O texto é o mesmo que a criação enviaria
 * (ListingUseCase.buildMLDescription: descrição do produto + bloco de
 * compatibilidade), e vai pelo `upsertDescription` corrigido, que tira o emoji
 * recusado e confere o que ficou gravado.
 *
 * Nunca renova token: conta com token vencido é pulada e listada.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import prisma from "../app/lib/prisma";
import { ML_CONSTANTS } from "../app/marketplaces/mercado-livre/ml-constants";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { sanitizeMLDescription } from "../app/marketplaces/lib/ml-description-text";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const arg = (nome: string) =>
  args.find((a) => a.startsWith(`--${nome}=`))?.split("=").slice(1).join("=");
const userEmail = arg("user-email");
const limit = Number(arg("limit") || 0) || undefined;

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function lerDescricao(token: string, itemId: string): Promise<string | null> {
  try {
    const res = await axios.get(`${ML_CONSTANTS.API_URL}/items/${itemId}/description`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const d = res?.data as { plain_text?: unknown } | undefined;
    return typeof d?.plain_text === "string" ? d.plain_text : "";
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    // 404 = o item não tem descrição nenhuma: também é "vazia".
    return status === 404 ? "" : null;
  }
}

type Linha = {
  listingId: string;
  itemId: string;
  produto: string;
  sku: string;
  conta: string;
  cliente: string;
  situacao: string;
  detalhe: string;
};

async function main() {
  let userId: string | undefined;
  if (userEmail) {
    const u = await prisma.user.findUnique({ where: { email: userEmail }, select: { id: true } });
    if (!u) throw new Error(`usuário não encontrado: ${userEmail}`);
    userId = u.id;
  }

  const candidatos = await prisma.$queryRaw<
    Array<{ listingId: string; itemId: string; productId: string; accountId: string }>
  >`
    SELECT l.id AS "listingId", l."externalListingId" AS "itemId", l."productId" AS "productId", l."marketplaceAccountId" AS "accountId"
    FROM "ProductListing" l
    JOIN "MarketplaceAccount" a ON a.id = l."marketplaceAccountId"
    JOIN "Product" p ON p.id = l."productId"
    WHERE a.platform = 'MERCADO_LIVRE'
      AND a.status = 'ACTIVE'
      AND l.status IN ('active', 'paused')
      AND l."externalListingId" LIKE 'MLB%'
      AND p.description ~ '[\\u2190-\\U0010FFFF]'
      AND (${userId ?? null}::text IS NULL OR p."userId" = ${userId ?? null}::text)
    ORDER BY l."createdAt" DESC
  `;
  const lista = limit ? candidatos.slice(0, limit) : candidatos;
  console.log(
    `[fix-desc] modo=${apply ? "APPLY" : "dry-run"} ${userEmail ? `cliente=${userEmail} ` : ""}candidatos=${candidatos.length}${limit ? ` (limit ${limit})` : ""}`,
  );

  const linhas: Linha[] = [];
  const contas = new Map<string, { token: string; valido: boolean; nome: string; email: string }>();
  for (const c of lista) {
    let conta = contas.get(c.accountId);
    if (!conta) {
      const a = await prisma.marketplaceAccount.findUnique({
        where: { id: c.accountId },
        select: { accessToken: true, expiresAt: true, accountName: true, user: { select: { email: true } } },
      });
      conta = {
        token: a?.accessToken ?? "",
        valido: !!a?.expiresAt && a.expiresAt.getTime() > Date.now() + 60_000,
        nome: a?.accountName ?? c.accountId,
        email: a?.user?.email ?? "",
      };
      contas.set(c.accountId, conta);
    }
    const produto = await prisma.product.findUnique({
      where: { id: c.productId },
      include: { compatibilities: true },
    });
    const base: Omit<Linha, "situacao" | "detalhe"> = {
      listingId: c.listingId,
      itemId: c.itemId,
      produto: produto?.name ?? "",
      sku: produto?.sku ?? "",
      conta: conta.nome,
      cliente: conta.email,
    };
    if (!conta.valido) {
      linhas.push({ ...base, situacao: "pulado", detalhe: "token vencido (o script não renova)" });
      continue;
    }
    const noMl = await lerDescricao(conta.token, c.itemId);
    await esperar(250);
    if (noMl === null) {
      linhas.push({ ...base, situacao: "nao_lida", detalhe: "falha ao ler a descrição no ML" });
      continue;
    }
    if (noMl.trim()) {
      linhas.push({ ...base, situacao: "ok", detalhe: `já tem descrição (${noMl.length} caracteres)` });
      continue;
    }
    const texto = (
      ListingUseCase as unknown as {
        buildMLDescription: (p: unknown) => { text: string };
      }
    ).buildMLDescription(produto).text;
    if (!texto.trim()) {
      linhas.push({ ...base, situacao: "sem_texto", detalhe: "produto sem descrição para enviar" });
      continue;
    }
    if (!apply) {
      const previa = sanitizeMLDescription(texto, "basico").text.slice(0, 80).replace(/\n/g, " / ");
      linhas.push({ ...base, situacao: "vazia_no_ml", detalhe: `seria reenviada: "${previa}…"` });
      continue;
    }
    try {
      await MLApiService.upsertDescription(conta.token, c.itemId, texto);
      linhas.push({ ...base, situacao: "corrigida", detalhe: "descrição reenviada e conferida" });
    } catch (err) {
      linhas.push({
        ...base,
        situacao: "erro",
        detalhe: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
    await esperar(500);
  }

  const resumo = linhas.reduce<Record<string, number>>((acc, l) => {
    acc[l.situacao] = (acc[l.situacao] || 0) + 1;
    return acc;
  }, {});
  console.log("[fix-desc] resumo:", resumo);

  const dir = path.resolve(__dirname, "out");
  fs.mkdirSync(dir, { recursive: true });
  const nome = `fix-ml-empty-descriptions-${new Date().toISOString().replace(/[:.]/g, "-")}${apply ? "-apply" : ""}`;
  fs.writeFileSync(path.join(dir, `${nome}.json`), JSON.stringify(linhas, null, 2));
  const csv = [
    "listingId;itemId;sku;produto;conta;cliente;situacao;detalhe",
    ...linhas.map((l) =>
      [l.listingId, l.itemId, l.sku, l.produto, l.conta, l.cliente, l.situacao, l.detalhe]
        .map((v) => String(v).replace(/;/g, ","))
        .join(";"),
    ),
  ].join("\n");
  fs.writeFileSync(path.join(dir, `${nome}.csv`), csv);
  console.log(`[fix-desc] relatório: ${path.join(dir, nome)}.json / .csv`);
}

main()
  .catch((e) => {
    console.error("[fix-desc] falhou:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
