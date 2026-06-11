/**
 * Diagnóstico de TLS/mTLS contra o web service da SEFAZ de uma empresa.
 *
 * Por que existe: o erro "unable to get local issuer certificate" na emissão
 * acontece quando o Node não consegue validar a cadeia do certificado do
 * SERVIDOR SEFAZ. Isso varia por UF/autorizador (SEFAZ próprio, SVRS, SVAN) e
 * por quais CAs estão no trust store. Este script mostra, com dados reais:
 *   1. a cadeia que o servidor APRESENTA no handshake (apresentando o A1 como
 *      cliente — alguns autorizadores, ex. SVRS, derrubam a conexão sem mTLS);
 *   2. a composição da cadeia do A1 do cliente;
 *   3. qual configuração de confiança AUTORIZA o handshake;
 *   4. se a cadeia ICP-Brasil que o servidor envia resolve, salva-a num arquivo
 *      e imprime o comando para confiar nela via SEFAZ_CA_BUNDLE_PATH.
 *
 * NÃO emite nada. Apenas abre conexões TLS e relata. Seguro para produção.
 *
 * Uso (no servidor, com o .env do projeto):
 *   npx tsx scripts/fiscal/diagnose-sefaz-tls.ts --email=<email-do-cliente>
 *   npx tsx scripts/fiscal/diagnose-sefaz-tls.ts --user-id=<id>
 *   npx tsx scripts/fiscal/diagnose-sefaz-tls.ts --email=<email> --servico=NfeStatusServico4
 */

import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
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

interface ClientCred {
  cert: string;
  key: string;
}

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
  /** PEM de cada cert apresentado, do leaf (0) ao topo. */
  pems: string[];
  /** "subject ⇐ issuer" por cert, para inspeção humana. */
  descs: string[];
}

/**
 * Apresenta o A1 como cliente (SVRS derruba sem mTLS) e captura a cadeia que o
 * servidor envia, sem verificar (rejectUnauthorized:false) — só para ler.
 */
function inspectServerChain(
  host: string,
  port: number,
  client: ClientCred,
): Promise<ServerChain> {
  return new Promise((resolve) => {
    const pems: string[] = [];
    const descs: string[] = [];
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
        cert: client.cert,
        key: client.key,
      },
      () => {
        let cert = socket.getPeerCertificate(true) as tls.DetailedPeerCertificate | null;
        const seen = new Set<string>();
        let i = 0;
        while (cert && cert.subject && !seen.has(cert.fingerprint256)) {
          seen.add(cert.fingerprint256);
          descs.push(`[${i}] subject="${cnOf(cert.subject)}"  ⇐ emissor="${cnOf(cert.issuer)}"`);
          if (cert.raw) pems.push(derToPem(cert.raw));
          i++;
          const next = cert.issuerCertificate;
          if (next && next.fingerprint256 !== cert.fingerprint256) cert = next;
          else break;
        }
        socket.end();
        resolve({ pems, descs });
      },
    );
    socket.on("error", (e) => {
      console.log("  Erro ao inspecionar a cadeia:", (e as Error).message);
      resolve({ pems, descs });
    });
    socket.setTimeout(15000, () => {
      console.log("  timeout ao inspecionar a cadeia");
      socket.destroy();
      resolve({ pems, descs });
    });
  });
}

function tryVerify(
  host: string,
  port: number,
  label: string,
  ca: string[] | undefined,
  client: ClientCred,
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
  console.log(`  SEFAZ_CA_BUNDLE_PATH: ${process.env.SEFAZ_CA_BUNDLE_PATH ?? "(não setado)"}`);

  // Carrega o A1 (precisamos apresentá-lo até para inspecionar a SVRS).
  const loader = new CertificateLoaderService();
  const cert = await loader.load(config.certificadoPath, config.certificadoSenhaEnc);
  const clientChainPem = [cert.certificatePem, ...cert.caChainPem]
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n");
  const client: ClientCred = { cert: clientChainPem, key: cert.privateKeyPem };

  console.log("\n── Cadeia do A1 do CLIENTE ──");
  console.log(`  folha:  "${cert.subjectCN ?? "?"}"  | intermediários no .pfx: ${cert.caChainPem.length}`);

  // 1. Cadeia que o servidor apresenta (com mTLS)
  const server = await inspectServerChain(host, port, client);
  console.log("\n── Cadeia que o SERVIDOR apresenta (com mTLS) ──");
  if (server.descs.length) server.descs.forEach((d) => console.log(`  ${d}`));
  else console.log("  (servidor não apresentou cadeia legível)");

  const aboveLeaf = server.pems.slice(1); // intermediários + raiz que o servidor mandou
  const defaultRoots = [...tls.rootCertificates];

  // 2. Testes de verificação
  console.log("\n── Teste de verificação do servidor (com mTLS) ──");
  const okDefault = await tryVerify(host, port, "store padrão do Node", undefined, client);
  const okPlusA1 = await tryVerify(
    host,
    port,
    "padrão + cadeia do A1",
    [...defaultRoots, ...cert.caChainPem],
    client,
  );
  const okCaptured =
    aboveLeaf.length > 0
      ? await tryVerify(
          host,
          port,
          "padrão + cadeia ICP-Brasil que o servidor enviou",
          [...defaultRoots, ...aboveLeaf],
          client,
        )
      : false;

  // 3. Se a cadeia capturada resolve, salva o bundle e dá o comando do fix.
  console.log("\n═══ Veredito ═══");
  if (okDefault) {
    console.log("  O store padrão já basta — pode ter sido intermitência de rede. Reteste a emissão.");
  } else if (okCaptured) {
    const storageBase =
      process.env.FISCAL_STORAGE_PATH || path.join(process.cwd(), ".fiscal-storage");
    fs.mkdirSync(storageBase, { recursive: true });
    const bundlePath = path.join(storageBase, "sefaz-icp-trust.pem");
    fs.writeFileSync(bundlePath, aboveLeaf.join("\n") + "\n", { mode: 0o644 });
    console.log("  ✅ FIX: confiar na cadeia ICP-Brasil que o servidor envia resolve.");
    console.log(`  Bundle salvo em: ${bundlePath}`);
    console.log("  Aplique (sem deploy de código):");
    console.log(`    1) Adicione ao .env:  SEFAZ_CA_BUNDLE_PATH=${bundlePath}`);
    console.log("    2) pm2 restart all --update-env && pm2 save");
    console.log("    3) Reemita a nota.");
    console.log("\n  ↓↓↓ Cole também os PEMs abaixo na conversa p/ eu embutir o fix permanente ↓↓↓");
    console.log("\n----- BEGIN CADEIA CAPTURADA (intermediários + raiz) -----");
    console.log(aboveLeaf.join("\n"));
    console.log("----- END CADEIA CAPTURADA -----");
  } else if (okPlusA1) {
    console.log("  ANEXAR a cadeia do A1 ao trust store resolve — me avise que aplico no código.");
  } else {
    console.log("  Nenhuma config autorizou e o servidor não forneceu cadeia utilizável.");
    console.log("  Cole a saída inteira — vamos obter o bundle ICP-Brasil por outro caminho.");
  }

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
