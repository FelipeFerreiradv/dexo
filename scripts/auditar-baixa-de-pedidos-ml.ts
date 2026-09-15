/**
 * A VENDA DEU BAIXA NA PECA CERTA? (somente leitura)
 * ==================================================
 *
 * Pergunta ao proprio Mercado Livre o que cada pedido vendeu e compara com o
 * que a Dexo baixou. E a unica auditoria que nao depende dos nossos vinculos
 * estarem certos — justamente o que esta em duvida.
 *
 * POR QUE NAO DA PARA AUDITAR SO PELO BANCO
 * `OrderItem.listingId` e NULO em boa parte dos pedidos (importados antes de o
 * vinculo existir): no Desmanche Tijuco Preto, 105 de 191 itens. Auditar por
 * `listingId` acha 1 problema; perguntando ao ML aparecem 56.
 *
 * MEDICAO DE 14/09/2026 (Desmanche Tijuco Preto, 220 pedidos desde 28/07):
 *   164 consistentes
 *    22 baixaram em produto DIFERENTE do dono do anuncio
 *    29 sem baixa nenhuma (parte dos 34 com anuncio sem vinculo)
 *
 * CAUSA: a autodeteccao casa anuncio->produto por igualdade textual de SKU, e
 * o `seller_sku` dessas bases esta poluido ("1" em 945 anuncios num cliente).
 * O pedido segue o vinculo — se ele esta errado, a baixa sai na peca errada;
 * se nao existe, a venda passa sem baixa e em SILENCIO (o SyncLog sai SUCCESS).
 *
 * ⚠️ RODAR NA VPS. Refresh de token do ML da maquina local marca a conta como
 * ERROR e o lojista para de receber pedidos. Este script so LE.
 *
 * CLI (na VPS):
 *   npx tsx scripts/auditar-baixa-de-pedidos-ml.ts --user-email=<email>
 *   npx tsx scripts/auditar-baixa-de-pedidos-ml.ts --todos
 *   npx tsx scripts/auditar-baixa-de-pedidos-ml.ts --todos --dias=90
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import prisma from "../app/lib/prisma";

const args = process.argv.slice(2);
const arg = (n: string) => {
  const p = `--${n}=`;
  const f = args.find((a) => a.startsWith(p));
  return f ? f.slice(p.length) : undefined;
};
const OUT_DIR = path.resolve(__dirname, "out");

type Achado = {
  Cliente: string;
  Pedido: string;
  Status: string;
  Data: string;
  Problema: string;
  "O ML vendeu": string;
  "A Dexo baixou": string;
  "Dono correto do anuncio": string;
};

type Resumo = {
  Cliente: string;
  Auditados: number;
  Consistentes: number;
  "Baixou peca errada": number;
  "Sem baixa nenhuma": number;
  "Anuncio sem vinculo": number;
  "Itens divergem": number;
  "Sem resposta do ML": number;
  "% com problema": number;
};

const P_ERRADA = "baixou em produto diferente do dono do anuncio";
const P_SEM_BAIXA = "pedido sem nenhuma baixa";
const P_SEM_VINCULO = "anuncio sem vinculo na Dexo";

async function auditarUsuario(
  user: { id: string; name: string | null; email: string },
  dias: number,
): Promise<{ achados: Achado[]; resumo: Resumo }> {
  const rotulo = user.name || user.email;

  const contas = await prisma.marketplaceAccount.findMany({
    where: { userId: user.id, platform: "MERCADO_LIVRE", status: "ACTIVE" },
    select: { id: true, accountName: true, accessToken: true },
  });

  const orders = await prisma.order.findMany({
    where: {
      marketplaceAccount: {
        userId: user.id,
        platform: "MERCADO_LIVRE",
        status: "ACTIVE",
      },
      ...(dias > 0
        ? { createdAt: { gte: new Date(Date.now() - dias * 86_400_000) } }
        : {}),
    },
    select: {
      externalOrderId: true,
      status: true,
      createdAt: true,
      marketplaceAccountId: true,
      items: {
        select: {
          quantity: true,
          product: { select: { id: true, sku: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Dono atual de cada anúncio, na visão da Dexo.
  const pls = await prisma.productListing.findMany({
    where: { marketplaceAccount: { userId: user.id } },
    select: {
      externalListingId: true,
      productId: true,
      product: { select: { sku: true, name: true } },
    },
  });
  const porAnuncio = new Map<string, (typeof pls)[number]>();
  for (const p of pls)
    if (!porAnuncio.has(p.externalListingId)) porAnuncio.set(p.externalListingId, p);

  const achados: Achado[] = [];
  let ok = 0;
  let semResposta = 0;

  for (const o of orders) {
    const acc = contas.find((c) => c.id === o.marketplaceAccountId);
    if (!acc) continue;
    let ml: {
      order_items?: Array<{ item: { id: string; title: string }; quantity: number }>;
    };
    try {
      const r = await fetch(
        `https://api.mercadolibre.com/orders/${o.externalOrderId}`,
        { headers: { Authorization: `Bearer ${acc.accessToken}` } },
      );
      if (!r.ok) {
        semResposta++;
        continue;
      }
      ml = await r.json();
    } catch {
      semResposta++;
      continue;
    }

    const vendidos = (ml.order_items ?? []).map((oi) => ({
      id: oi.item.id,
      titulo: oi.item.title,
      q: oi.quantity,
    }));
    const baixados = o.items.map((i) => i.product?.id).filter(Boolean) as string[];

    let problema: string | null = null;
    for (const v of vendidos) {
      const dono = porAnuncio.get(v.id);
      if (!dono) {
        problema = problema ?? P_SEM_VINCULO;
        continue;
      }
      if (!baixados.includes(dono.productId)) problema = P_ERRADA;
    }
    if (o.items.length === 0) problema = P_SEM_BAIXA;
    else if (o.items.length !== vendidos.length)
      problema =
        problema ?? `itens divergem (ML ${vendidos.length} x Dexo ${o.items.length})`;

    if (!problema) {
      ok++;
      continue;
    }
    achados.push({
      Cliente: rotulo,
      Pedido: o.externalOrderId,
      Status: o.status,
      Data: o.createdAt.toISOString().slice(0, 10),
      Problema: problema,
      "O ML vendeu": vendidos.map((v) => `${v.id} "${v.titulo}" x${v.q}`).join(" + "),
      "A Dexo baixou":
        o.items
          .map((i) =>
            i.product
              ? `${i.product.sku} "${i.product.name}" x${i.quantity}`
              : "(sem produto)",
          )
          .join(" + ") || "(nada)",
      "Dono correto do anuncio": vendidos
        .map((v) => {
          const d = porAnuncio.get(v.id);
          return d ? `${d.product.sku} "${d.product.name}"` : "(anuncio sem vinculo)";
        })
        .join(" + "),
    });
  }

  const conta = (p: string) => achados.filter((a) => a.Problema === p).length;
  const resumo: Resumo = {
    Cliente: rotulo,
    Auditados: orders.length,
    Consistentes: ok,
    "Baixou peca errada": conta(P_ERRADA),
    "Sem baixa nenhuma": conta(P_SEM_BAIXA),
    "Anuncio sem vinculo": conta(P_SEM_VINCULO),
    "Itens divergem": achados.filter((a) => a.Problema.startsWith("itens divergem")).length,
    "Sem resposta do ML": semResposta,
    "% com problema": orders.length
      ? Number(((achados.length / orders.length) * 100).toFixed(1))
      : 0,
  };
  return { achados, resumo };
}

async function main() {
  const dias = Number(arg("dias") ?? 0);
  const todos = args.includes("--todos");
  const email = arg("user-email");
  const userIdFlag = arg("user-id");
  if (!todos && !email && !userIdFlag)
    throw new Error("Informe --user-email=, --user-id= ou --todos");

  let usuarios: Array<{ id: string; name: string | null; email: string }>;
  if (todos) {
    // Só quem tem conta ML ATIVA — é o universo em que a auditoria faz sentido.
    usuarios = await prisma.user.findMany({
      where: {
        accounts: { some: { platform: "MERCADO_LIVRE", status: "ACTIVE" } },
      },
      select: { id: true, name: true, email: true },
      orderBy: { email: "asc" },
    });
    console.log(`[auditar] ${usuarios.length} clientes com conta ML ativa`);
  } else {
    const u = userIdFlag
      ? await prisma.user.findUniqueOrThrow({
          where: { id: userIdFlag },
          select: { id: true, name: true, email: true },
        })
      : await prisma.user.findFirstOrThrow({
          where: { email: { equals: email as string, mode: "insensitive" } },
          select: { id: true, name: true, email: true },
        });
    usuarios = [u];
  }

  const todosAchados: Achado[] = [];
  const resumos: Resumo[] = [];
  for (const u of usuarios) {
    process.stdout.write(`[auditar] ${u.email} ... `);
    try {
      const { achados, resumo } = await auditarUsuario(u, dias);
      todosAchados.push(...achados);
      resumos.push(resumo);
      console.log(
        `${resumo.Auditados} pedidos · ${achados.length} com problema` +
          (achados.length
            ? ` (errada ${resumo["Baixou peca errada"]}, sem baixa ${resumo["Sem baixa nenhuma"]})`
            : ""),
      );
    } catch (e) {
      console.log(`FALHOU: ${(e as Error).message}`);
    }
  }

  console.log("\n--- VEREDITO GERAL ---");
  const soma = (k: keyof Resumo) =>
    resumos.reduce((a, r) => a + (r[k] as number), 0);
  console.log(`clientes auditados      ${resumos.length}`);
  console.log(`pedidos auditados       ${soma("Auditados")}`);
  console.log(`consistentes            ${soma("Consistentes")}`);
  console.log(`baixou peca ERRADA      ${soma("Baixou peca errada")}`);
  console.log(`sem baixa nenhuma       ${soma("Sem baixa nenhuma")}`);
  console.log(`anuncio sem vinculo     ${soma("Anuncio sem vinculo")}`);
  console.log(`itens divergem          ${soma("Itens divergem")}`);
  console.log(`sem resposta do ML      ${soma("Sem resposta do ML")}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      resumos.sort((a, b) => b["% com problema"] - a["% com problema"]),
    ),
    "Por cliente",
  );
  const criticos = todosAchados.filter(
    (a) => a.Problema === P_ERRADA || a.Problema === P_SEM_BAIXA,
  );
  if (criticos.length)
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(criticos),
      "Estoque afetado",
    );
  if (todosAchados.length)
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(todosAchados.slice(0, 50000)),
      "Todos os achados",
    );
  const out = path.join(
    OUT_DIR,
    `baixa-de-pedidos-${todos ? "todos" : "cliente"}-${stamp}.xlsx`,
  );
  XLSX.writeFile(wb, out);
  fs.writeFileSync(
    path.join(OUT_DIR, `baixa-de-pedidos-${todos ? "todos" : "cliente"}-${stamp}.json`),
    JSON.stringify({ resumos, achados: todosAchados }, null, 1),
  );
  console.log(`\nplanilha ${out}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[auditar][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
