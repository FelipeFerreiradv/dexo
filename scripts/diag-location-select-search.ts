/**
 * DIAGNÓSTICO SOMENTE-LEITURA da busca de localização do combobox de produto.
 *
 * O que faz: LÊ o usuário, LÊ as localizações do tenant pelo MESMO caminho da
 * aplicação (`LocationUseCase.listForSelect`) e simula o filtro do combobox.
 * O que NÃO faz: nenhum create/update/delete, nenhuma chamada a marketplace.
 *
 * Uso:
 *   npx tsx scripts/diag-location-select-search.ts <email> "<termo>"
 */
import { PrismaClient } from "@prisma/client";
import { LocationUseCase } from "@/app/usecases/location.usercase";
import {
  buildLocationSearchIndex,
  filterLocationIndex,
  LOCATION_SELECT_MAX_RESULTS,
  type LocationSelectItem,
} from "@/app/produtos/lib/location-select-filter";
import { tokenize } from "@/app/localizacoes/lib/search-utils";

const prisma = new PrismaClient();

/** Reimplementação do filtro ANTIGO (corte no primeiro `max`, sem ranking). */
function filtroAntigo(
  options: LocationSelectItem[],
  query: string,
  max = LOCATION_SELECT_MAX_RESULTS,
): LocationSelectItem[] {
  const index = buildLocationSearchIndex(options);
  const tokens = tokenize(query);
  const out: LocationSelectItem[] = [];
  for (const entry of index) {
    if (tokens.every((t) => entry.haystack.includes(t))) {
      out.push(entry.item);
      if (out.length >= max) break;
    }
  }
  return out;
}

async function main() {
  const email = process.argv[2];
  const termo = process.argv[3] ?? "";
  if (!email) {
    console.error(
      'Uso: tsx scripts/diag-location-select-search.ts <email> "<termo>"',
    );
    process.exit(1);
  }

  // 1. Usuário e dono dos dados
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      parentUserId: true,
      isActive: true,
    },
  });
  if (!user) {
    console.log(`Usuário ${email} NÃO encontrado.`);
    return;
  }
  const dataOwnerId = user.parentUserId ?? user.id;
  console.log("=== 1. USUÁRIO ===");
  console.log({
    ...user,
    dataOwnerId,
    ehColaborador: Boolean(user.parentUserId),
  });

  // 2. Localizações brutas do tenant
  const total = await prisma.location.count({ where: { userId: dataOwnerId } });
  console.log(`\n=== 2. LOCALIZAÇÕES DO TENANT ===\ntotal: ${total}`);

  // 3. Saída REAL do endpoint que o combobox consome
  const options = (await new LocationUseCase().listForSelect(
    dataOwnerId,
  )) as LocationSelectItem[];
  console.log(`/locations/select devolveu: ${options.length}`);

  // 4. Candidatas ao termo (por prefixo do 1º token), com flags de visibilidade
  const [primeiro] = tokenize(termo);
  if (primeiro) {
    const candidatas = options.filter((o) =>
      buildLocationSearchIndex([o])[0].haystack.includes(primeiro),
    );
    console.log(
      `\n=== 3. CANDIDATAS QUE CONTÊM "${primeiro}" (${candidatas.length}) ===`,
    );
    for (const c of candidatas.slice(0, 30)) {
      console.log(
        `  ${c.id}  cap=${c.maxCapacity} prods=${c.productsCount} lotada=${c.isFull}  ${c.fullPath}`,
      );
    }
    if (candidatas.length > 30) console.log(`  … +${candidatas.length - 30}`);
  }

  // 5. Dono de cada candidata (prova de isolamento / dono errado)
  if (primeiro) {
    const donos = await prisma.location.groupBy({
      by: ["userId"],
      where: { code: { contains: primeiro, mode: "insensitive" } },
      _count: { _all: true },
    });
    console.log(
      `\n=== 4. DONOS DE TODA LOCALIZAÇÃO COM "${primeiro}" NO CÓDIGO ===`,
    );
    for (const d of donos) {
      console.log(
        `  userId=${d.userId} ${d.userId === dataOwnerId ? "(ESTE TENANT)" : "(outro)"} → ${d._count._all}`,
      );
    }
  }

  // 6. O veredito: posição do alvo no filtro ANTIGO vs. NOVO
  if (termo) {
    const alvoNorm = tokenize(termo).join(" ");
    const alvo = options.find((o) => tokenize(o.code).join(" ") === alvoNorm);
    const antigo = filtroAntigo(options, termo);
    const novo = filterLocationIndex(buildLocationSearchIndex(options), termo);
    const semCap = filtroAntigo(options, termo, Number.MAX_SAFE_INTEGER);

    console.log(`\n=== 5. VEREDITO para a busca "${termo}" ===`);
    console.log(
      `alvo (code == "${alvoNorm}"): ${alvo ? alvo.fullPath : "NÃO EXISTE NO TENANT"}`,
    );
    console.log(`matches totais (sem cap): ${semCap.length}`);
    if (alvo) {
      const posAntes = semCap.findIndex((o) => o.id === alvo.id);
      const posAntigo = antigo.findIndex((o) => o.id === alvo.id);
      const posNovo = novo.findIndex((o) => o.id === alvo.id);
      console.log(`matches ANTES do alvo: ${posAntes}`);
      console.log(
        `posição no filtro ANTIGO: ${posAntigo < 0 ? "AUSENTE (cortado pelo cap)" : "#" + (posAntigo + 1)}`,
      );
      console.log(
        `posição no filtro NOVO  : ${posNovo < 0 ? "AUSENTE" : "#" + (posNovo + 1)}`,
      );
      console.log(
        posAntes >= LOCATION_SELECT_MAX_RESULTS
          ? "→ CAUSA RAIZ CONFIRMADA (forma extrema: cortado pelo cap de 50)"
          : posAntes >= 8
            ? "→ CAUSA RAIZ CONFIRMADA (forma 'abaixo da dobra': ~9 linhas visíveis)"
            : "→ o ranking sozinho não explica; checar isFull / lista velha / dados",
      );
    }
    console.log(
      `\ntop 8 ANTIGO: ${antigo
        .slice(0, 8)
        .map((o) => o.fullPath)
        .join(" | ")}`,
    );
    console.log(
      `top 8 NOVO  : ${novo
        .slice(0, 8)
        .map((o) => o.fullPath)
        .join(" | ")}`,
    );
  }

  // 7. Contingência: import WebDesmonte grava o caminho inteiro no `code`
  const pathAsCode = await prisma.location.count({
    where: {
      userId: dataOwnerId,
      parentId: { not: null },
      code: { contains: ">" },
    },
  });
  console.log(
    `\n=== 6. CÓDIGOS QUE JÁ CONTÊM O CAMINHO (import WebDesmonte) ===\n${pathAsCode} (0 = ok)`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
