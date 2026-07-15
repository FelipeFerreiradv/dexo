import "dotenv/config";
import path from "path";
import fs from "fs";
import prisma from "../app/lib/prisma";

/**
 * RECUPERA notas AUTORIZADAS na SEFAZ que ficaram "invisíveis" com status
 * DRAFT (ou SENDING) por causa do BUG "nota autorizada some da listagem": um
 * autosave atrasado do wizard (updateDraft) rebaixava a nota já autorizada para
 * DRAFT. Como updateDraft NÃO mexe em chaveAcesso/protocoloAutorizacao/
 * dataAutorizacao, a linha guarda a evidência da autorização — este script só
 * restaura o `status` para AUTHORIZED (NÃO é migration de schema; NÃO chama a
 * SEFAZ). Após o fix da Parte A, a corrida não acontece mais; isto limpa o
 * passivo já criado.
 *
 * ELEGIBILIDADE (trava): status ∈ {DRAFT, SENDING} E chaveAcesso E
 * protocoloAutorizacao E dataAutorizacao TODOS preenchidos. Esses 3 campos só
 * são gravados por handleAuthorized DEPOIS de a SEFAZ autorizar — então a
 * presença dos 3 é prova de autorização real. Notas sem eles NÃO são tocadas.
 *
 * IDEMPOTENTE: o apply usa updateMany condicional ao status; rodar de novo não
 * altera nada (as recuperadas já viraram AUTHORIZED). Sem `--apply` = dry-run
 * (só lê e imprime; escreve 0 linhas).
 *
 *   npx tsx scripts/recover-authorized-drafts.ts --dry-run
 *   npx tsx scripts/recover-authorized-drafts.ts --user-id=<cuid> --dry-run
 *   npx tsx scripts/recover-authorized-drafts.ts --apply
 */

const OUT_DIR = path.resolve(__dirname, "out");

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const f = process.argv.slice(2).find((a) => a.startsWith(p));
  return f ? f.slice(p.length) : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dryRun = !apply; // dry-run é o DEFAULT (só escreve com --apply)
  const userId = arg("user-id");
  const statuses = (arg("status") ?? "DRAFT,SENDING")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  console.log(
    `[recover-nfe] modo=${dryRun ? "DRY-RUN" : "APPLY"} status=${statuses.join("|")} ${userId ? `user=${userId}` : "(todos os tenants)"}`,
  );

  // Autorizadas-porém-invisíveis: status editável/pendente COM evidência de
  // autorização (os 3 campos só existem após a SEFAZ autorizar).
  const candidatas = await prisma.nfeEmitida.findMany({
    where: {
      status: { in: statuses },
      chaveAcesso: { not: null },
      protocoloAutorizacao: { not: null },
      dataAutorizacao: { not: null },
      ...(userId ? { userId } : {}),
    },
    select: {
      id: true,
      userId: true,
      serie: true,
      numero: true,
      ambiente: true,
      status: true,
      chaveAcesso: true,
      protocoloAutorizacao: true,
      dataAutorizacao: true,
      xmlAutorizadoPath: true,
      danfePdfPath: true,
      destinatarioJson: true,
      updatedAt: true,
    },
    orderBy: [{ userId: "asc" }, { serie: "asc" }, { numero: "asc" }],
  });

  // Enriquecimento READ-ONLY: impressão digital da corrida (AUTORIZADA seguida,
  // mais tarde, de EDITADA_DRAFT) — confirma a causa sem alterar nada.
  const linhas: any[] = [];
  for (const n of candidatas) {
    const [autorizada, editada, owner] = await Promise.all([
      prisma.nfeAuditLog.findFirst({
        where: { nfeId: n.id, evento: "AUTORIZADA" },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      prisma.nfeAuditLog.findFirst({
        where: { nfeId: n.id, evento: "EDITADA_DRAFT" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      prisma.user.findUnique({ where: { id: n.userId }, select: { email: true } }),
    ]);
    const dest = n.destinatarioJson as any;
    linhas.push({
      id: n.id,
      userEmail: owner?.email ?? null,
      serie: n.serie,
      numero: n.numero,
      ambiente: n.ambiente,
      status: n.status,
      destinatario: dest?.nome ?? null,
      chaveAcesso: n.chaveAcesso,
      protocolo: n.protocoloAutorizacao,
      dataAutorizacao: n.dataAutorizacao,
      autorizadaEm: autorizada?.createdAt ?? null,
      editadaDraftEm: editada?.createdAt ?? null,
      fingerprintCorrida: !!(
        autorizada &&
        editada &&
        editada.createdAt > autorizada.createdAt
      ),
      hasXml: !!n.xmlAutorizadoPath,
      hasDanfe: !!n.danfePdfPath,
    });
  }

  const porStatus: Record<string, number> = {};
  for (const l of linhas) porStatus[l.status] = (porStatus[l.status] ?? 0) + 1;

  // APPLY: restaura status → AUTHORIZED (atômico/idempotente) + auditoria.
  let recuperadas = 0;
  if (apply) {
    for (const n of candidatas) {
      const upd = await prisma.nfeEmitida.updateMany({
        where: {
          id: n.id,
          status: { in: statuses },
          chaveAcesso: { not: null },
          protocoloAutorizacao: { not: null },
          dataAutorizacao: { not: null },
        },
        data: { status: "AUTHORIZED" },
      });
      if (upd.count > 0) {
        await prisma.nfeAuditLog.create({
          data: {
            nfeId: n.id,
            userId: n.userId,
            evento: "STATUS_RECONCILIADO",
            detalhes: {
              de: n.status,
              para: "AUTHORIZED",
              chaveAcesso: n.chaveAcesso,
              protocolo: n.protocoloAutorizacao,
              motivo:
                "Recuperacao do BUG nota-autorizada-some: nota autorizada na SEFAZ cujo status foi rebaixado por autosave. Restaurado para AUTHORIZED.",
            },
          },
        });
        recuperadas += upd.count;
      }
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(OUT_DIR, `recover-authorized-drafts-${stamp}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        mode: dryRun ? "dry-run" : "apply",
        statuses,
        userId: userId ?? null,
        totalCandidatas: candidatas.length,
        porStatus,
        recuperadas: apply ? recuperadas : 0,
        candidatas: linhas,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log("\n===== RECUPERAR NF-e autorizadas-porém-invisíveis =====");
  console.log(`  modo:                 ${dryRun ? "DRY-RUN (0 escritas)" : "APPLY"}`);
  console.log(`  candidatas (total):   ${candidatas.length}`);
  console.log(`  por status:           ${JSON.stringify(porStatus)}`);
  if (apply) console.log(`  recuperadas → AUTHORIZED: ${recuperadas}`);
  console.log(`  relatorio:            ${reportPath}`);
  console.log("========================================================\n");
  for (const l of linhas.slice(0, 25)) {
    console.log(
      `  [${l.status}] ${l.userEmail} · série ${l.serie} nº ${l.numero} · ${l.destinatario ?? "?"} · chave ${l.chaveAcesso?.slice(0, 12)}… · fingerprint=${l.fingerprintCorrida}`,
    );
  }
  if (linhas.length > 25) console.log(`  … (+${linhas.length - 25} — ver relatorio)`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[recover-nfe][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
