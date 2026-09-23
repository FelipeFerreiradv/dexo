/**
 * Reenvia a descrição dos anúncios do Mercado Livre que ficaram SEM descrição
 * porque o texto tinha emoji (23/09/2026 — SKU 7167 de um cliente; ver
 * app/marketplaces/lib/ml-description-text.ts). Roda NA VPS.
 *
 *   npx tsx scripts/fix-ml-empty-descriptions.ts --user-email=x [--limit=N]          (dry-run: só lê)
 *   npx tsx scripts/fix-ml-empty-descriptions.ts --user-email=x [--limit=N] --apply  (reenvia)
 *   npx tsx scripts/fix-ml-empty-descriptions.ts --all [--limit=N] [--apply]         (todos os clientes)
 *
 * Seleção: anúncio ML ativo/pausado cujo texto efetivo tem símbolo ou emoji (a
 * partir de U+2190). O texto efetivo segue a mesma precedência do resto da
 * Dexo: o texto próprio do anúncio (`descriptionOverride`), senão a descrição
 * do produto, senão a descrição padrão do dono (como a criação faz). Para cada
 * um, LÊ a descrição no ML: só a que está VAZIA entra. O texto enviado é o
 * que a criação enviaria (ListingUseCase.buildMLDescription: texto + bloco de
 * compatibilidade), pelo `upsertDescription` corrigido, e o script LÊ de novo
 * para conferir.
 *
 * Nunca renova token: conta com token vencido é pulada e listada. Cada item
 * vai para o relatório .jsonl assim que termina (uma interrupção não apaga o
 * registro do que já foi gravado no ML).
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import prisma from "../app/lib/prisma";
import { ML_CONSTANTS } from "../app/marketplaces/mercado-livre/ml-constants";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import {
  MLDescriptionNotSavedError,
  sanitizeMLDescription,
} from "../app/marketplaces/lib/ml-description-text";

const USO =
  "uso: npx tsx scripts/fix-ml-empty-descriptions.ts (--user-email=EMAIL | --all) [--limit=N] [--apply]";

function lerArgs(argv: string[]) {
  let apply = false;
  let all = false;
  let userEmail: string | undefined;
  let limit: number | undefined;
  for (const a of argv) {
    if (a === "--apply") apply = true;
    else if (a === "--all") all = true;
    else if (/^--user-email=[^@\s]+@[^@\s]+$/.test(a)) userEmail = a.slice("--user-email=".length);
    else if (/^--limit=[1-9]\d*$/.test(a)) limit = Number(a.slice("--limit=".length));
    else throw new Error(`argumento inválido: ${a}\n${USO}`);
  }
  if (all && userEmail) throw new Error(`use --user-email OU --all, não os dois\n${USO}`);
  if (!all && !userEmail) throw new Error(`informe --user-email=EMAIL ou --all\n${USO}`);
  return { apply, userEmail, limit };
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

function comPrazo<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error(`sem resposta em ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/** Texto da descrição no ML (`plain_text`, ou o `text` HTML sem tags); "" = vazia; null = não leu. */
async function lerDescricao(token: string, itemId: string): Promise<string | null> {
  try {
    const res = await axios.get(`${ML_CONSTANTS.API_URL}/items/${itemId}/description`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const d = res?.data as { plain_text?: unknown; text?: unknown } | undefined;
    const plano = typeof d?.plain_text === "string" ? d.plain_text : "";
    if (plano.trim()) return plano;
    return typeof d?.text === "string" ? d.text.replace(/<[^>]*>/g, "") : "";
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
  origemTexto: string;
  situacao: string;
  detalhe: string;
};

async function main() {
  const { apply, userEmail, limit } = lerArgs(process.argv.slice(2));

  let userId: string | undefined;
  if (userEmail) {
    const u = await prisma.user.findUnique({ where: { email: userEmail }, select: { id: true } });
    if (!u) throw new Error(`usuário não encontrado: ${userEmail}`);
    userId = u.id;
  }

  const candidatos = await prisma.$queryRaw<
    Array<{
      listingId: string;
      itemId: string;
      productId: string;
      accountId: string;
      descriptionOverride: string | null;
      defaultDescription: string | null;
    }>
  >`
    SELECT l.id AS "listingId", l."externalListingId" AS "itemId", l."productId" AS "productId",
           l."marketplaceAccountId" AS "accountId", l."descriptionOverride" AS "descriptionOverride",
           u."defaultProductDescription" AS "defaultDescription"
    FROM "ProductListing" l
    JOIN "MarketplaceAccount" a ON a.id = l."marketplaceAccountId"
    JOIN "Product" p ON p.id = l."productId"
    JOIN "User" u ON u.id = p."userId"
    WHERE a.platform = 'MERCADO_LIVRE'
      AND a.status = 'ACTIVE'
      AND l.status IN ('active', 'paused')
      AND l."externalListingId" LIKE 'MLB%'
      AND COALESCE(NULLIF(l."descriptionOverride", ''), NULLIF(p.description, ''), u."defaultProductDescription")
          ~ '[\\u2190-\\U0010FFFF]'
      AND (${userId ?? null}::text IS NULL OR p."userId" = ${userId ?? null}::text)
    ORDER BY l."createdAt" DESC
  `;
  const lista = limit ? candidatos.slice(0, limit) : candidatos;
  console.log(
    `[fix-desc] modo=${apply ? "APPLY" : "dry-run"} ${userEmail ? `cliente=${userEmail}` : "todos os clientes"} candidatos=${candidatos.length}${limit ? ` (limit ${limit})` : ""}`,
  );

  const dir = path.resolve(__dirname, "out");
  fs.mkdirSync(dir, { recursive: true });
  const nome = `fix-ml-empty-descriptions-${new Date().toISOString().replace(/[:.]/g, "-")}${apply ? "-apply" : ""}`;
  const jsonl = path.join(dir, `${nome}.jsonl`);
  const linhas: Linha[] = [];
  const registrar = (l: Linha) => {
    linhas.push(l);
    fs.appendFileSync(jsonl, `${JSON.stringify(l)}\n`);
    console.log(`[fix-desc] ${l.itemId} ${l.sku} ${l.situacao}: ${l.detalhe}`);
  };

  const contas = new Map<string, { token: string; valido: boolean; nome: string; email: string }>();
  for (const c of lista) {
    const base: Omit<Linha, "situacao" | "detalhe"> = {
      listingId: c.listingId,
      itemId: c.itemId,
      produto: "",
      sku: "",
      conta: c.accountId,
      cliente: "",
      origemTexto: "",
    };
    try {
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
      base.produto = produto?.name ?? "";
      base.sku = produto?.sku ?? "";
      base.conta = conta.nome;
      base.cliente = conta.email;
      if (!produto) {
        registrar({ ...base, situacao: "sem_texto", detalhe: "produto não encontrado" });
        continue;
      }
      if (!conta.valido) {
        registrar({ ...base, situacao: "pulado", detalhe: "token vencido (o script não renova)" });
        continue;
      }

      // Mesma precedência do resto da Dexo: texto do anúncio > produto > padrão do dono.
      let textoBase: string | null = null;
      if (c.descriptionOverride?.trim()) {
        textoBase = c.descriptionOverride;
        base.origemTexto = "anuncio";
      } else if (produto.description?.trim()) {
        textoBase = produto.description;
        base.origemTexto = "produto";
      } else if (c.defaultDescription?.trim()) {
        textoBase = c.defaultDescription;
        base.origemTexto = "padrao_do_cliente";
      }

      const noMl = await lerDescricao(conta.token, c.itemId);
      await esperar(250);
      if (noMl === null) {
        registrar({ ...base, situacao: "nao_lida", detalhe: "falha ao ler a descrição no ML" });
        continue;
      }
      if (noMl.trim()) {
        registrar({ ...base, situacao: "ok", detalhe: `já tem descrição (${noMl.length} caracteres)` });
        continue;
      }
      if (!textoBase) {
        registrar({ ...base, situacao: "sem_texto", detalhe: "sem descrição para enviar" });
        continue;
      }
      const texto = (
        ListingUseCase as unknown as {
          buildMLDescription: (p: unknown) => { text: string };
        }
      ).buildMLDescription({ ...produto, description: textoBase }).text;

      if (!apply) {
        const previa = sanitizeMLDescription(texto, "basico").text.slice(0, 80).replace(/\n/g, " / ");
        registrar({ ...base, situacao: "vazia_no_ml", detalhe: `seria reenviada: "${previa}…"` });
        continue;
      }

      try {
        await comPrazo(MLApiService.upsertDescription(conta.token, c.itemId, texto), 60_000);
      } catch (err) {
        const naoGuardou = err instanceof MLDescriptionNotSavedError;
        registrar({
          ...base,
          situacao: naoGuardou ? "ml_nao_guardou" : "erro",
          detalhe: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        });
        await esperar(500);
        continue;
      }
      await esperar(1500);
      const conferida = await lerDescricao(conta.token, c.itemId);
      if (conferida === null) {
        registrar({ ...base, situacao: "enviada_sem_conferencia", detalhe: "reenviada; a releitura falhou" });
      } else if (conferida.trim()) {
        registrar({ ...base, situacao: "corrigida", detalhe: `conferida no ML: ${conferida.length} caracteres` });
      } else {
        registrar({ ...base, situacao: "ml_nao_guardou", detalhe: "reenviada, mas o ML continua sem descrição" });
      }
      await esperar(500);
    } catch (err) {
      registrar({
        ...base,
        situacao: "erro",
        detalhe: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
  }

  const resumo = linhas.reduce<Record<string, number>>((acc, l) => {
    acc[l.situacao] = (acc[l.situacao] || 0) + 1;
    return acc;
  }, {});
  console.log("[fix-desc] resumo:", resumo);

  fs.writeFileSync(path.join(dir, `${nome}.json`), JSON.stringify(linhas, null, 2));
  const csv = [
    "listingId;itemId;sku;produto;conta;cliente;origemTexto;situacao;detalhe",
    ...linhas.map((l) =>
      [l.listingId, l.itemId, l.sku, l.produto, l.conta, l.cliente, l.origemTexto, l.situacao, l.detalhe]
        .map((v) => String(v).replace(/[;\r\n]/g, " "))
        .join(";"),
    ),
  ].join("\n");
  fs.writeFileSync(path.join(dir, `${nome}.csv`), csv);
  console.log(`[fix-desc] relatório: ${path.join(dir, nome)}.jsonl / .json / .csv`);
}

main()
  .catch((e) => {
    console.error("[fix-desc] falhou:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
