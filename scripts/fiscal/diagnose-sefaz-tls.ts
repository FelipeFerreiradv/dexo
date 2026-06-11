/**
 * Diagnóstico de TLS/mTLS contra o web service da SEFAZ de uma empresa.
 *
 * Por que existe: o erro "unable to get local issuer certificate" na emissão
 * acontece quando o Node não consegue validar a cadeia do certificado do
 * SERVIDOR SEFAZ. Isso varia por UF/autorizador (SEFAZ próprio, SVRS, SVAN) e
 * por quais CAs estão no trust store. Este script mostra, com dados reais:
 *   1. a cadeia que o servidor APRESENTA no handshake (quantos certs, emissores);
 *   2. a composição da cadeia do A1 do cliente;
 *   3. qual configuração de confiança AUTORIZA o handshake — assim o fix é
 *      cirúrgico (anexar a âncora certa via SEFAZ_CA_BUNDLE_PATH / NODE_EXTRA_CA_CERTS).
 *
 * NÃO emite nada. Apenas abre conexões TLS e relata. Seguro para produção.
 *
 * Uso (no servidor, com o .env do projeto):
 *   npx tsx scripts/fiscal/diagnose-sefaz-tls.ts --email=<email-do-cliente>
 *   npx tsx scripts/fiscal/diagnose-sefaz-tls.ts --user-id=<id>
 *   npx tsx scripts/fiscal/diagnose-sefaz-tls.ts --email=<email> --servico=NfeStatusServico4
 */

import "dotenv/config";
import * as tls from "node:tls";
import { URL } from "node:url";

import prisma from "../../app/lib/prisma";
import { CertificateLoaderService } from "../../app/fiscal/certificate/certificate-loader.service";
import {
  getSefazEndpoint,
  type SefazAmbiente,
  type SefazServico,
  type UF,
} from "../../app/fiscal/sefaz/endpoints";

function arg(name: string): string | null {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : null;
}

function cnOf(field: unknown): string {
  if (!field || typeof field !== "object") return String(field ?? "?");
  const f = field as Record<string, unknown>;
  return (f.CN as string) ?? (f.O as string) ?? JSON.stringify(f);
}

function derToPem(der: Buffer): string {
  const b64 = der.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`;
}

interface ServerChain {
  pems: string[];
  topIssuer: string;
}

function inspectServerChain(host: string, port: number): Promise<ServerChain> {
  return new Promise((resolve) => {
    const pems: string[] = [];
    let topIssuer = "?";
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false, minVersion: "TLSv1.2" },
      () => {
        let cert = socket.getPeerCertificate(true) as tls.DetailedPeerCertificate | null;
        const seen = new Set<string>();
        console.log("\n── Cadeia que o SERVIDOR apresenta ──");
        let i = 0;
        while (cert && cert.subject && !seen.has(cert.fingerprint256)) {
          seen.add(cert.fingerprint256);
          console.log(
            `  [${i}] subject="${cnOf(cert.subject)}"  emissor="${cnOf(cert.issuer)}"`,
          );
          if (cert.raw) pems.push(derToPem(cert.raw));
          topIssuer = cnOf(cert.issuer);
          i++;
          const next = cert.issuerCertificate;
          if (next && next.fingerprint256 !== cert.fingerprint256) {
            cert = next;
          } else {
            break;
          }
        }
        console.log(
          `  → servidor enviou ${i} certificado(s). Emissor do topo (âncora necessária): "${topIssuer}"`,
        );
        socket.end();
        resolve({ pems, topIssuer });
      },
    );
    socket.on("error", (e) => {
      console.log("  Erro ao conectar (sem verificação):", (e as Error).message);
      resolve({ pems, topIssuer });
    });
    socket.setTimeout(15000, () => {
      console.log("  timeout ao inspecionar cadeia");
      socket.destroy();
      resolve({ pems, topIssuer });
    });
  });
}

function tryVerify(
  host: string,
  port: number,
  label: string,
  ca: string[] | undefined,
  client: { cert: string; key: string },
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ca,
        cert: client.cert,
        key: client.key,
      },
      () => {
        console.log(`  [OK]    ${label} → handshake AUTORIZADO`);
        socket.end();
        resolve(true);
      },
    );
    socket.on("error", (e) => {
      const err = e as NodeJS.ErrnoException;
      console.log(`  [FALHA] ${label} → ${err.code ?? ""} ${err.message}`);
      resolve(false);
    });
    socket.setTimeout(15000, () => {
      console.log(`  [TIMEOUT] ${label}`);
      socket.destroy();
      resolve(false);
    });
  });
}

async function resolveUserId(): Promise<string | null> {
  const direct = arg("user-id");
  if (direct) return direct;
  const email = arg("email");
  if (!email) return null;
  const user = await (prisma as any).user.findUnique({ where: { email } });
  if (!user) {
    console.error(`Usuário não encontrado para email=${email}`);
    return null;
  }
  // Mesmo cálculo do authMiddleware: dono real = pai (se colaborador) ou ele mesmo.
  return (user.parentUserId ?? user.id) as string;
}

async function main(): Promise<void> {
  const servico = (arg("servico") ?? "NFeAutorizacao4") as SefazServico;
  const userId = await resolveUserId();
  if (!userId) {
    console.error(
      "Uso: npx tsx scripts/fiscal/diagnose-sefaz-tls.ts --email=<email> | --user-id=<id> [--servico=NFeAutorizacao4]",
    );
    process.exit(2);
  }

  const config = await (prisma as any).companyFiscalConfig.findUnique({
    where: { userId },
  });
  if (!config) {
    console.error(`Nenhum CompanyFiscalConfig para userId=${userId}.`);
    process.exit(3);
  }
  if (!config.uf || !config.certificadoPath || !config.certificadoSenhaEnc) {
    console.error(
      `Config incompleta: uf=${config.uf} certificadoPath=${config.certificadoPath ? "ok" : "FALTA"} senhaEnc=${config.certificadoSenhaEnc ? "ok" : "FALTA"}`,
    );
    process.exit(4);
  }

  const ambiente: SefazAmbiente =
    config.ambiente === "PRODUCAO" ? "producao" : "homologacao";
  const uf = config.uf as UF;

  let endpoint: string;
  try {
    endpoint = getSefazEndpoint(uf, ambiente, servico);
  } catch (e) {
    console.error(`Falha ao resolver endpoint: ${(e as Error).message}`);
    process.exit(5);
  }

  const url = new URL(endpoint);
  const host = url.hostname;
  const port = url.port ? Number(url.port) : 443;

  console.log("═══ Diagnóstico TLS SEFAZ ═══");
  console.log(`  userId:    ${userId}`);
  console.log(`  UF:        ${uf}`);
  console.log(`  ambiente:  ${ambiente}`);
  console.log(`  serviço:   ${servico}`);
  console.log(`  endpoint:  ${endpoint}`);
  console.log(`  host:port: ${host}:${port}`);
  console.log(`  Node:      ${process.version}`);
  console.log(`  NODE_EXTRA_CA_CERTS: ${process.env.NODE_EXTRA_CA_CERTS ?? "(não setado)"}`);
  console.log(`  SEFAZ_CA_BUNDLE_PATH: ${process.env.SEFAZ_CA_BUNDLE_PATH ?? "(não setado)"}`);

  // 1. Cadeia que o servidor apresenta
  const server = await inspectServerChain(host, port);

  // 2. Cadeia do A1 do cliente
  const loader = new CertificateLoaderService();
  const cert = await loader.load(config.certificadoPath, config.certificadoSenhaEnc);
  console.log("\n── Cadeia do A1 do CLIENTE (caChainPem) ──");
  console.log(`  folha:  subject CN ≈ "${cert.subjectCN ?? "?"}"`);
  console.log(`  intermediários no .pfx: ${cert.caChainPem.length}`);
  const clientChainPem = [cert.certificatePem, ...cert.caChainPem]
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n");
  const client = { cert: clientChainPem, key: cert.privateKeyPem };

  // 3. Testa configurações de confiança (todas apresentando o A1 como cliente)
  console.log("\n── Teste de verificação do servidor (com mTLS) ──");
  const defaultRoots = [...tls.rootCertificates];

  const okDefault = await tryVerify(host, port, "store padrão do Node", undefined, client);
  const okPlusA1 = await tryVerify(
    host,
    port,
    "padrão + cadeia do A1",
    [...defaultRoots, ...cert.caChainPem],
    client,
  );
  const okServerSent =
    server.pems.length > 1
      ? await tryVerify(
          host,
          port,
          "padrão + intermediários que o servidor enviou",
          [...defaultRoots, ...server.pems.slice(1)],
          client,
        )
      : false;

  // 4. Veredito
  console.log("\n═══ Veredito ═══");
  if (okDefault) {
    console.log("  O store padrão já basta — o erro pode ser intermitente/rede. Reteste a emissão.");
  } else if (okPlusA1) {
    console.log("  ANEXAR a cadeia do A1 ao trust store resolve.");
    console.log("  Fix: incluir cert.caChainPem em `ca` (aditivo) no buildAgent — me avise que eu aplico.");
  } else if (okServerSent) {
    console.log("  O servidor ENVIA os intermediários, mas falta a RAIZ ICP-Brasil no trust store.");
    console.log("  Fix: instalar o bundle ICP-Brasil e apontar NODE_EXTRA_CA_CERTS (ou SEFAZ_CA_BUNDLE_PATH) para ele.");
  } else {
    console.log("  Nenhuma config testada autorizou. Provável: servidor NÃO envia intermediários E");
    console.log("  a raiz não está em lugar nenhum. Precisamos do bundle ICP-Brasil completo.");
    console.log(`  Âncora faltante (emissor do topo da cadeia do servidor): "${server.topIssuer}"`);
  }
  console.log(
    "\n  Cole TODA esta saída na conversa — com ela aplico o fix exato (provavelmente o bundle ICP-Brasil + NODE_EXTRA_CA_CERTS).",
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("Erro no diagnóstico:", e);
  try {
    await prisma.$disconnect();
  } catch {
    /* noop */
  }
  process.exit(1);
});
