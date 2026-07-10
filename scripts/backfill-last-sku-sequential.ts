import "dotenv/config";
import prisma from "../app/lib/prisma";
import { computeMaxNumericSku } from "../app/repositories/product.repository";

/**
 * Recalcula `User.lastSkuSequential` (contador da sugestão "Novo Produto").
 *
 * Só produtos de ORIGEM HUMANA entram na sequência: o cálculo filtra
 * `createdFromMarketplace = false`, então SKUs custom de anúncios de marketplace
 * (ex.: "13340") param de contaminar o contador.
 *
 * Migrações/importações que gravam SKUs numéricos EXTERNOS como
 * createdFromMarketplace=false (código do sistema de origem, código de barras)
 * NÃO são excluídas pelo filtro de proveniência — para esses casos use um valor
 * explícito (`--value=N`) ou o mapa OVERRIDES abaixo.
 *
 * Uso:
 *   tsx scripts/backfill-last-sku-sequential.ts                      # dry-run, todos
 *   tsx scripts/backfill-last-sku-sequential.ts --email=x@y.com      # dry-run, 1 user
 *   tsx scripts/backfill-last-sku-sequential.ts --email=x@y.com --value=5123
 *   tsx scripts/backfill-last-sku-sequential.ts --email=x@y.com --value=5123 --apply
 *
 * Sem `--apply` o script é DRY-RUN e não grava nada.
 */

// Override explícito para usuários cuja sequência humana NÃO bate com o máximo
// numérico por causa de códigos externos de importação/migração gravados como
// createdFromMarketplace=false (o filtro de proveniência não os exclui).
const OVERRIDES: Record<string, { value: number; reason: string }> = {
  cmn5yc4rn0000vsasmwv9m8nc: {
    value: 32762,
    reason:
      "Leonardo (JOTABÊ): importação inclui códigos 80xxx/90xxx/100xxx que inflam o cálculo",
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const found = args.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
  };
  const rawValue = get("value");
  return {
    email: get("email"),
    userId: get("user-id"),
    value: rawValue !== undefined ? parseInt(rawValue, 10) : undefined,
    apply: args.includes("--apply"),
  };
}

async function computeHumanMax(userId: string): Promise<number> {
  const skus = await prisma.product.findMany({
    where: { userId, createdFromMarketplace: false },
    select: { sku: true },
  });
  return computeMaxNumericSku(skus.map((p) => p.sku));
}

async function main() {
  const { email, userId, value, apply } = parseArgs();
  if (value !== undefined && !Number.isSafeInteger(value)) {
    throw new Error("--value inválido (esperado um inteiro).");
  }
  console.log(
    `Modo: ${apply ? "APPLY (grava)" : "DRY-RUN (não grava)"}` +
      (value !== undefined ? `  | value explícito = ${value}` : ""),
  );

  const where = email ? { email } : userId ? { id: userId } : {};
  const users = await prisma.user.findMany({
    where,
    select: { id: true, email: true, lastSkuSequential: true },
  });
  console.log(`Usuários alvo: ${users.length}\n`);

  if (value !== undefined && users.length !== 1) {
    throw new Error(
      "--value exige exatamente um usuário (use --email ou --user-id).",
    );
  }

  let touched = 0;
  for (const u of users) {
    let target: number;
    let source: string;

    if (value !== undefined) {
      target = value;
      source = "VALUE explícito";
    } else if (OVERRIDES[u.id]) {
      target = OVERRIDES[u.id].value;
      source = `OVERRIDE (${OVERRIDES[u.id].reason})`;
    } else {
      const count = await prisma.product.count({ where: { userId: u.id } });
      if (count === 0) {
        console.log(`[SKIP]      ${u.email}  (sem produtos)`);
        continue;
      }
      target = await computeHumanMax(u.id);
      source = "CALC (max numérico humano, createdFromMarketplace=false)";
    }

    if (target <= 0) {
      console.log(`[SKIP-ZERO] ${u.email}  (max=0, nenhum SKU sequencial)`);
      continue;
    }
    if (u.lastSkuSequential === target) {
      console.log(`[NOOP]      ${u.email}  já em ${target}`);
      continue;
    }

    if (apply) {
      await prisma.user.update({
        where: { id: u.id },
        data: { lastSkuSequential: target },
      });
      touched++;
    }
    console.log(
      `[${apply ? "SET" : "WOULD-SET"}]  ${u.email}  ${u.lastSkuSequential ?? "null"} → ${target}  ${source}`,
    );
  }

  console.log(
    `\nDone. ${apply ? `${touched} usuário(s) atualizados.` : "DRY-RUN — nada gravado (use --apply)."}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
