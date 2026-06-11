/**
 * Setup do certificado A1 + provider SEFAZ_DIRECT para uma empresa.
 *
 * Existe porque a UI de Configuracao Fiscal ainda NAO faz upload do .pfx (o
 * card "Certificado digital A1" e apenas um aviso — o fluxo original era Focus,
 * que guarda o cert no painel dele). Este script cadastra o certificado direto
 * no CompanyFiscalConfig de forma segura:
 *   - valida que o .pfx abre com a senha informada (extrai validade + CN);
 *   - copia o .pfx para FISCAL_STORAGE_PATH/certs/<userId>.pfx;
 *   - cifra a senha com FISCAL_CERT_ENC_KEY (AES-256-GCM);
 *   - grava certificadoPath / certificadoSenhaEnc / certificadoValidoAte e
 *     define providerName=SEFAZ_DIRECT (e uf/ambiente se informados).
 *
 * PRE-REQUISITO: a empresa ja deve ter um CompanyFiscalConfig salvo (preencha
 * Identificacao + Endereco fiscal pela UI e clique "Salvar configuracao").
 *
 * Uso:
 *   npx tsx scripts/fiscal/setup-sefaz-direct.ts \
 *     --user-id=<id> \
 *     --pfx="/var/dexo-fiscal-storage/certs/jotabe.pfx" \
 *     --senha="SENHA_DO_CERTIFICADO" \
 *     [--ambiente=HOMOLOGACAO] [--uf=SP]
 */

import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";

import prisma from "../../app/lib/prisma";
import { parsePfx } from "../../app/fiscal/certificate/certificate-loader.service";
import { CertificateManagerService } from "../../app/fiscal/certificate/certificate-manager.service";

function arg(name: string): string | null {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : null;
}

/**
 * Extrai o CNPJ (14 digitos) do CN do certificado A1. O CN de um e-CNPJ tem o
 * formato "RAZAO SOCIAL:CNPJ" (ex.: "CENTRO DE DESMONTE JOTABE LTDA:51195502000156").
 * Retorna o ultimo grupo de 14 digitos encontrado, ou null.
 */
function extractCnpjFromCN(cn: string | null): string | null {
  if (!cn) return null;
  const matches = cn.match(/\d{14}/g);
  return matches && matches.length ? matches[matches.length - 1] : null;
}

async function main(): Promise<void> {
  const userId = arg("user-id");
  const pfxPath = arg("pfx");
  const senha = arg("senha");
  const ambiente = (arg("ambiente") ?? "").toUpperCase();
  const uf = (arg("uf") ?? "").toUpperCase();

  if (!userId || !pfxPath || !senha) {
    console.error(
      "Uso: npx tsx scripts/fiscal/setup-sefaz-direct.ts --user-id=<id> --pfx=<caminho.pfx> --senha=<senha> [--ambiente=HOMOLOGACAO] [--uf=SP]",
    );
    process.exit(2);
  }

  if (!fs.existsSync(pfxPath)) {
    console.error(`Arquivo .pfx nao encontrado: ${pfxPath}`);
    process.exit(3);
  }

  // 1. Empresa precisa existir
  const config = await (prisma as any).companyFiscalConfig.findUnique({
    where: { userId },
  });
  if (!config) {
    console.error(
      `Nenhum CompanyFiscalConfig para userId=${userId}. Preencha Identificacao + Endereco pela UI e salve antes de rodar este script.`,
    );
    process.exit(4);
  }

  // 2. Validar o .pfx abrindo com a senha (prova que a senha esta correta)
  const pfxBuffer = await fs.promises.readFile(pfxPath);
  let cert;
  try {
    cert = parsePfx(pfxBuffer, senha);
  } catch (e) {
    console.error(
      `Falha ao abrir o .pfx com a senha informada: ${(e as Error).message}\n` +
        "Verifique se a senha esta correta e se o arquivo e um A1 valido (PKCS#12).",
    );
    process.exit(5);
  }

  if (cert.notAfter.getTime() < Date.now()) {
    console.error(
      `Certificado EXPIRADO em ${cert.notAfter.toISOString()}. Renove antes de usar.`,
    );
    process.exit(6);
  }

  // 2b. TRAVA: o CNPJ do certificado precisa pertencer ao emissor.
  // A SEFAZ rejeita NFe assinada por certificado de CNPJ diferente do emitente
  // (comparacao pela BASE de 8 digitos — matriz e filiais compartilham a base).
  const certCnpj = extractCnpjFromCN(cert.subjectCN);
  const configCnpj = String(config.cnpj ?? "").replace(/\D/g, "");
  const forceMismatch = process.argv.includes("--force-cnpj-mismatch");

  if (!certCnpj) {
    console.warn(
      `\n⚠ Nao consegui extrair o CNPJ do certificado (CN="${cert.subjectCN ?? "?"}").\n` +
        "  Confirme manualmente que o certificado pertence ao emissor antes de emitir.\n",
    );
  } else if (certCnpj.slice(0, 8) !== configCnpj.slice(0, 8)) {
    console.error(
      `\n✗ CNPJ do CERTIFICADO (${certCnpj}) nao corresponde ao CNPJ do EMISSOR (${configCnpj || "(vazio)"}).`,
    );
    console.error(
      "  A SEFAZ rejeita NFe assinada por certificado de CNPJ diferente do emitente (base de 8 digitos).",
    );
    console.error(
      "  Corrija o CNPJ/IE/Razao na Configuracao Fiscal para os do certificado,\n" +
        "  OU use o A1 do CNPJ que vai emitir.",
    );
    if (!forceMismatch) {
      console.error(
        "  (Para gravar mesmo assim, sob sua responsabilidade: --force-cnpj-mismatch)\n",
      );
      await prisma.$disconnect();
      process.exit(7);
    }
    console.warn("  --force-cnpj-mismatch informado: gravando apesar da divergencia.\n");
  } else if (certCnpj !== configCnpj) {
    console.warn(
      `\n⚠ Base do CNPJ confere (${certCnpj.slice(0, 8)}), mas a filial difere ` +
        `(certificado ${certCnpj} x emissor ${configCnpj}). Matriz/filial — prosseguindo.\n`,
    );
  }

  // 3. Copiar o .pfx para o local canonico FISCAL_STORAGE_PATH/certs/<userId>.pfx
  const storageBase = process.env.FISCAL_STORAGE_PATH || ".fiscal-storage";
  const certsDir = path.join(storageBase, "certs");
  await fs.promises.mkdir(certsDir, { recursive: true });
  const destPath = path.join(certsDir, `${userId}.pfx`);
  if (path.resolve(pfxPath) !== path.resolve(destPath)) {
    await fs.promises.copyFile(pfxPath, destPath);
  }

  // 4. Cifrar a senha
  const manager = new CertificateManagerService();
  const senhaEnc = manager.encryptPassword(senha);

  // 5. Atualizar config: cert + provider (+ uf/ambiente se informados)
  const data: Record<string, unknown> = {
    certificadoPath: destPath,
    certificadoSenhaEnc: senhaEnc,
    certificadoValidoAte: cert.notAfter,
    providerName: "SEFAZ_DIRECT",
  };
  if (uf) data.uf = uf;
  if (ambiente === "HOMOLOGACAO" || ambiente === "PRODUCAO") {
    data.ambiente = ambiente;
  }

  await (prisma as any).companyFiscalConfig.update({
    where: { userId },
    data,
  });

  const updated = await (prisma as any).companyFiscalConfig.findUnique({
    where: { userId },
  });

  console.log("\n✓ Certificado A1 cadastrado e provider definido como SEFAZ_DIRECT.\n");
  console.log(`  Empresa (CNPJ):   ${updated.cnpj}`);
  console.log(`  UF:               ${updated.uf ?? "(NAO DEFINIDA — defina via --uf ou na UI)"}`);
  console.log(`  Ambiente:         ${updated.ambiente}`);
  console.log(`  Provider:         ${updated.providerName}`);
  console.log(`  Certificado CN:   ${cert.subjectCN ?? "(n/d)"}`);
  console.log(`  Valido ate:       ${cert.notAfter.toISOString()}`);
  console.log(`  Cert path:        ${updated.certificadoPath}`);
  console.log(`  Senha cifrada:    ${updated.certificadoSenhaEnc ? "sim" : "NAO"}`);
  console.log("\nProximo passo: rodar o smoke");
  console.log(`  npx tsx scripts/fiscal/smoke-status-servico.ts --user-id=${userId}\n`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("Erro:", e);
  try {
    await prisma.$disconnect();
  } catch {
    /* noop */
  }
  process.exit(1);
});
