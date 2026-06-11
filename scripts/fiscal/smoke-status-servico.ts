/**
 * Smoke test SEFAZ direto — consulta de status do serviço.
 *
 * Não emite nada, não cancela nada. Só carrega o certificado A1 da empresa
 * piloto, abre conexão mTLS com a SEFAZ de homologação da UF dela, e
 * pede `NfeStatusServico4`. Se voltar cStat=107 ("Servico em Operacao"),
 * toda a fundação (PFX, signer, SOAP, mTLS, endpoints) está OK.
 *
 * Uso:
 *   npx tsx scripts/fiscal/smoke-status-servico.ts --user-id=<userId>
 *
 * Pré-requisitos:
 *   - .env preenchido (DATABASE_URL, FISCAL_CERT_ENC_KEY)
 *   - CompanyFiscalConfig existente para o userId com:
 *       - uf preenchida (ex.: "SP")
 *       - certificadoPath apontando para um .pfx válido no disco
 *       - certificadoSenhaEnc com a senha encriptada (via tela de Configuração
 *         Fiscal OU manualmente via CertificateManagerService.encryptPassword)
 *       - ambiente="HOMOLOGACAO" (recomendado)
 */

import "dotenv/config";
import { CompanyFiscalRepository } from "../../app/repositories/company-fiscal.repository";
import { createSefazDirectProvider } from "../../app/fiscal/providers/provider-factory";
import type { UF } from "../../app/fiscal/sefaz/endpoints";

async function main(): Promise<void> {
  const userId = parseArg("user-id");
  if (!userId) {
    console.error("Uso: npx tsx scripts/fiscal/smoke-status-servico.ts --user-id=<id>");
    process.exit(2);
  }

  const repo = new CompanyFiscalRepository();
  const config = await repo.findByUserId(userId);
  if (!config) {
    console.error(`Nenhum CompanyFiscalConfig encontrado para userId=${userId}.`);
    process.exit(3);
  }

  if (!config.uf) throw new Error("config.uf ausente — preencha em /notas-fiscais/configuracao");
  if (!config.certificadoPath) {
    throw new Error("config.certificadoPath ausente — faca upload do .pfx primeiro");
  }
  if (!config.certificadoSenhaEnc) {
    throw new Error("config.certificadoSenhaEnc ausente");
  }

  console.log("Empresa:");
  console.log(`  CNPJ:           ${config.cnpj}`);
  console.log(`  Razao social:   ${config.razaoSocial}`);
  console.log(`  UF:             ${config.uf}`);
  console.log(`  Ambiente:       ${config.ambiente}`);
  console.log(`  Provider:       ${config.providerName ?? "(default)"}`);
  console.log(`  Cert path:      ${config.certificadoPath}`);
  console.log("");

  const provider = await createSefazDirectProvider({
    providerName: "SEFAZ_DIRECT",
    ambiente: config.ambiente as "HOMOLOGACAO" | "PRODUCAO",
    uf: config.uf as UF,
    certificadoPath: config.certificadoPath,
    certificadoSenhaEnc: config.certificadoSenhaEnc,
    timeoutMs: 30_000,
  });

  console.log("Chamando NfeStatusServico4 ...");
  const t0 = Date.now();
  const result = await provider.consultarStatusServico();
  const elapsed = Date.now() - t0;

  console.log("");
  console.log(`Latencia:       ${elapsed} ms`);
  console.log(`cStat:          ${result.cStat}`);
  console.log(`xMotivo:        ${result.xMotivo}`);
  console.log(`verAplic:       ${result.verAplic ?? "(n/a)"}`);
  console.log(`tMed (s):       ${result.tMed ?? "(n/a)"}`);
  console.log(`cUF resposta:   ${result.cUFResposta ?? "(n/a)"}`);
  console.log(`dhRecbto:       ${result.dataResposta?.toISOString() ?? "(n/a)"}`);
  console.log(`emOperacao:     ${result.emOperacao ? "SIM ✓" : "NAO ✗"}`);

  if (result.cStat === 107) {
    console.log("\n✓ Smoke OK — toda a stack SEFAZ direto esta funcional.");
    process.exit(0);
  }
  if (result.cStat === 108 || result.cStat === 109) {
    console.log("\n⚠ SEFAZ esta paralisada momentaneamente, mas nossa stack respondeu OK.");
    process.exit(0);
  }
  console.log("\n✗ cStat inesperado. Investigar.");
  process.exit(1);
}

function parseArg(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

main().catch((err) => {
  console.error("Erro no smoke:", err);
  process.exit(1);
});
