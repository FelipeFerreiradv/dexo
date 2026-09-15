/**
 * RELATORIO MENSAL DE NF-e PARA O CONTADOR (somente leitura)
 * =========================================================
 *
 * Entrega o que o escritorio de contabilidade de fato consegue importar:
 * um .zip com UM arquivo `nfeProc` por nota + uma planilha de conferencia.
 *
 * POR QUE ESTE SCRIPT EXISTE
 * --------------------------
 * A tela "Notas emitidas" tem o botao "Relatorio mensal (XML)", mas ele baixa
 * um container PROPRIETARIO da Dexo (`<relatorioNFe versao="1.0">`, ver
 * app/fiscal/generators/relatorio-mensal-xml.ts) num UNICO arquivo. Nenhum
 * sistema contabil importa esse formato — o contador precisa dos `nfeProc`
 * individuais. Foi essa a causa do "a contadora disse que so tem R$ 150":
 * os dados no banco estavam corretos e completos o tempo todo (agosto/2026 do
 * Desmanche Tijuco Preto: 85 notas, R$ 33.371,75, 85 XML presentes no disco).
 *
 * ⚠️ O XML de cada nota NAO fica no banco. `NfeEmitida.xmlAutorizadoPath`
 * guarda um caminho ABSOLUTO no disco do servidor, e em producao esse disco e
 * a VPS. Por isso a coleta e feita por ssh; com --sem-ssh sai so a planilha.
 *
 * JANELA DE DATAS — identica a do produto (nfe-listing.usecase.ts:52-55):
 * [00:00 de Brasilia do dia 1, 00:00 de Brasilia do dia 1 do mes seguinte),
 * ou seja 03:00Z, e o campo e `dataEmissao` (NAO `createdAt`).
 *
 * CLI:
 *   npx tsx scripts/relatorio-nfe-mensal-cliente.ts --user-email=<email> --ano=2026 --mes=8
 *   npx tsx scripts/relatorio-nfe-mensal-cliente.ts --user-email=<email> --ano=2026 --mes=8 --sem-ssh
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import * as XLSX from "xlsx";
import prisma from "../app/lib/prisma";

const args = process.argv.slice(2);
const arg = (n: string) => {
  const p = `--${n}=`;
  const f = args.find((a) => a.startsWith(p));
  return f ? f.slice(p.length) : undefined;
};

const OUT_DIR = path.resolve(__dirname, "out");
const SSH_HOST = arg("ssh-host") ?? "vps-assuncao";
const SEM_SSH = args.includes("--sem-ssh");

const MESES = [
  "janeiro",
  "fevereiro",
  "marco",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

function assertBanco() {
  const host =
    (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1] ??
    "(desconhecido)";
  if (!args.includes("--allow-any-host") && !host.includes("sa-east-1")) {
    throw new Error(
      `DATABASE_URL aponta para "${host}" e nao para sa-east-1 (Sao Paulo). Use --allow-any-host se for proposital.`,
    );
  }
  return host;
}

type Nota = {
  id: string;
  numero: number;
  serie: number;
  modelo: string;
  chaveAcesso: string | null;
  status: string;
  dataEmissao: Date | null;
  protocoloAutorizacao: string | null;
  naturezaOperacao: string;
  destinatarioJson: Record<string, unknown> | null;
  totaisJson: Record<string, unknown> | null;
  xmlAutorizadoPath: string | null;
};

async function main() {
  const host = assertBanco();
  const email = arg("user-email");
  const userIdFlag = arg("user-id");
  const ano = Number(arg("ano"));
  const mes = Number(arg("mes"));

  if (!email && !userIdFlag)
    throw new Error("Informe --user-email= ou --user-id=");
  if (!Number.isInteger(ano) || ano < 2006 || ano > 2099)
    throw new Error("--ano invalido");
  if (!Number.isInteger(mes) || mes < 1 || mes > 12)
    throw new Error("--mes invalido (1-12)");

  const user = userIdFlag
    ? await prisma.user.findUniqueOrThrow({
        where: { id: userIdFlag },
        select: { id: true, email: true, name: true },
      })
    : await prisma.user.findFirstOrThrow({
        where: { email: { equals: email as string, mode: "insensitive" } },
        select: { id: true, email: true, name: true },
      });

  const inicio = new Date(Date.UTC(ano, mes - 1, 1, 3, 0, 0));
  const fim = new Date(Date.UTC(ano, mes, 1, 3, 0, 0));

  console.log(`[relatorio] banco ${host}`);
  console.log(
    `[relatorio] cliente ${user.name} <${user.email}> (${user.id})`,
  );
  console.log(
    `[relatorio] janela ${inicio.toISOString()} ate ${fim.toISOString()} (campo dataEmissao)`,
  );

  // AUTORIZADAS entram no zip. CANCELADAS aparecem so na planilha, sinalizadas:
  // o contador precisa saber que existiram, mas elas nao vao no pacote de XML.
  const notas = (await prisma.nfeEmitida.findMany({
    where: {
      userId: user.id,
      ambiente: "PRODUCAO",
      status: { in: ["AUTHORIZED", "CANCELLED"] },
      dataEmissao: { gte: inicio, lt: fim },
    },
    orderBy: [{ serie: "asc" }, { numero: "asc" }],
    select: {
      id: true,
      numero: true,
      serie: true,
      modelo: true,
      chaveAcesso: true,
      status: true,
      dataEmissao: true,
      protocoloAutorizacao: true,
      naturezaOperacao: true,
      destinatarioJson: true,
      totaisJson: true,
      xmlAutorizadoPath: true,
    },
  })) as unknown as Nota[];

  const autorizadas = notas.filter((n) => n.status === "AUTHORIZED");
  const canceladas = notas.filter((n) => n.status === "CANCELLED");
  const valor = (n: Nota) =>
    Number((n.totaisJson as Record<string, unknown>)?.["totalNota"] ?? 0);
  const total = autorizadas.reduce((a, n) => a + valor(n), 0);

  console.log(
    `[relatorio] ${autorizadas.length} autorizadas (R$ ${total.toFixed(2)}) · ${canceladas.length} canceladas`,
  );
  if (autorizadas.length === 0)
    console.log("[relatorio] ⚠️ nenhuma nota autorizada no periodo");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mes2 = String(mes).padStart(2, "0");
  const base = `nfe-${ano}-${mes2}-${(user.name ?? "cliente")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 28)}`;

  // ---- coleta dos XML na VPS ------------------------------------------------
  // Nome de arquivo pela CHAVE DE ACESSO: e o identificador que o contador e o
  // sistema dele reconhecem, e nao colide entre series.
  const comPath = autorizadas.filter(
    (n) => n.xmlAutorizadoPath && n.chaveAcesso,
  );
  const semPath = autorizadas.filter(
    (n) => !n.xmlAutorizadoPath || !n.chaveAcesso,
  );
  let zipLocal: string | null = null;
  const ausentes: string[] = [];

  if (!SEM_SSH && comPath.length > 0) {
    const stage = `/tmp/dexo-rel-${Date.now()}`;
    const zipRemoto = `${stage}.zip`;
    // Uma linha "origem<TAB>destino" por nota, entregue no stdin do ssh; o
    // shell remoto so copia e renomeia — nenhum caminho entra na linha de
    // comando, entao nome com espaco ou acento nao quebra nada.
    // ⚠️ O "\n" FINAL E OBRIGATORIO. `while read` devolve falso na ultima linha
    // quando ela nao termina em newline, e o corpo do laco NAO roda para ela —
    // some exatamente 1 nota, em silencio. Custou um pacote com 84 de 85 notas
    // na primeira execucao, com o contador de ausentes marcando zero.
    const mapa =
      comPath
        .map((n) => `${n.xmlAutorizadoPath}\t${n.chaveAcesso}-nfe.xml`)
        .join("\n") + "\n";
    const roteiro = [
      "set -e",
      `mkdir -p ${stage}`,
      // `|| [ -n "$origem" ]` e o cinto de seguranca do mesmo problema.
      "while IFS=$(printf '\\t') read -r origem destino || [ -n \"$origem\" ]; do",
      '  [ -z "$origem" ] && continue',
      `  if [ -f "$origem" ]; then cp "$origem" "${stage}/$destino"; else echo "AUSENTE:$destino"; fi`,
      "done",
      `cd ${stage} && zip -q -r ${zipRemoto} . && echo "ZIPOK:$(ls -1 ${stage}/*.xml 2>/dev/null | wc -l)"`,
    ].join("\n");

    console.log(
      `[relatorio] coletando ${comPath.length} XML na VPS (${SSH_HOST})...`,
    );
    const saida = execFileSync("ssh", [SSH_HOST, roteiro], {
      input: mapa,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    let noPacote = -1;
    for (const linha of saida.split("\n")) {
      if (linha.startsWith("AUSENTE:")) ausentes.push(linha.slice(8).trim());
      if (linha.startsWith("ZIPOK:")) noPacote = Number(linha.slice(6).trim());
    }

    // TRAVA DE CONTAGEM. Um pacote incompleto entregue a um contador e um erro
    // fiscal, entao a divergencia ABORTA em vez de virar aviso no meio do log.
    const esperado = comPath.length - ausentes.length;
    if (noPacote !== esperado) {
      throw new Error(
        `Pacote incompleto: o zip tem ${noPacote} XML e o esperado era ${esperado} ` +
          `(${comPath.length} notas com caminho, ${ausentes.length} ausentes). ` +
          `Nada foi entregue. Investigue antes de reenviar.`,
      );
    }
    console.log(`[relatorio] ${noPacote} XML no pacote (conferido)`);

    zipLocal = path.join(OUT_DIR, `${base}-xmls.zip`);
    execFileSync("scp", ["-q", `${SSH_HOST}:${zipRemoto}`, zipLocal]);
    execFileSync("ssh", [SSH_HOST, `rm -rf ${stage} ${zipRemoto}`]);
    const kb = (fs.statSync(zipLocal).size / 1024).toFixed(0);
    console.log(`[relatorio] zip gravado: ${zipLocal} (${kb} KB)`);
  } else if (SEM_SSH) {
    console.log("[relatorio] --sem-ssh: pulando a coleta, so a planilha sai");
  }

  // ---- planilha de conferencia ---------------------------------------------
  const linhas = notas.map((n) => {
    const d = (n.destinatarioJson ?? {}) as Record<string, string>;
    return {
      Numero: n.numero,
      Serie: n.serie,
      Modelo: n.modelo,
      Situacao: n.status === "AUTHORIZED" ? "Autorizada" : "Cancelada",
      "Data de emissao": n.dataEmissao
        ? n.dataEmissao.toISOString().slice(0, 10)
        : "",
      "Chave de acesso": n.chaveAcesso ?? "",
      Protocolo: n.protocoloAutorizacao ?? "",
      "Natureza da operacao": n.naturezaOperacao,
      Destinatario: d.nome ?? "",
      "CPF/CNPJ": String(d.cpfCnpj ?? ""),
      UF: d.uf ?? "",
      "Valor da nota (R$)": valor(n),
      "XML no pacote":
        n.status !== "AUTHORIZED"
          ? "nao (cancelada)"
          : !n.xmlAutorizadoPath || ausentes.includes(`${n.chaveAcesso}-nfe.xml`)
            ? "NAO - arquivo ausente"
            : "sim",
      Arquivo: n.chaveAcesso ? `${n.chaveAcesso}-nfe.xml` : "",
    };
  });

  const resumo = [
    { Campo: "Cliente", Valor: user.name ?? "" },
    { Campo: "Competencia", Valor: `${MESES[mes - 1]}/${ano}` },
    { Campo: "Notas autorizadas", Valor: autorizadas.length },
    { Campo: "Valor total autorizado (R$)", Valor: Number(total.toFixed(2)) },
    { Campo: "Notas canceladas", Valor: canceladas.length },
    { Campo: "XML no pacote", Valor: comPath.length - ausentes.length },
    {
      Campo: "XML ausentes no servidor",
      Valor: ausentes.length + semPath.length,
    },
    { Campo: "Ambiente", Valor: "PRODUCAO" },
    {
      Campo: "Gerado em",
      Valor: new Date().toISOString().slice(0, 19).replace("T", " "),
    },
  ];

  // ---- conferencia da numeracao --------------------------------------------
  // A SEFAZ espera numeracao continua por serie. Todo numero que nao virou nota
  // autorizada precisa de INUTILIZACAO declarada, senao fica como lacuna sem
  // justificativa na escrita fiscal — e a primeira coisa que o contador cobra.
  const numeracao: Record<string, string | number>[] = [];
  const series = [...new Set(notas.map((n) => n.serie))].sort((a, b) => a - b);
  for (const serie of series) {
    const daSerie = notas.filter((n) => n.serie === serie);
    const min = Math.min(...daSerie.map((n) => n.numero));
    const max = Math.max(...daSerie.map((n) => n.numero));
    // Busca a faixa inteira, inclusive numeros fora da janela do mes, para nao
    // acusar lacuna onde existe nota de outra competencia.
    const naFaixa = await prisma.nfeEmitida.findMany({
      where: {
        userId: user.id,
        ambiente: "PRODUCAO",
        serie,
        numero: { gte: min, lte: max },
      },
      select: { numero: true, status: true, dataEmissao: true },
    });
    const porNumero = new Map(naFaixa.map((x) => [x.numero, x]));
    for (let i = min; i <= max; i++) {
      const x = porNumero.get(i);
      if (x?.status === "AUTHORIZED") continue;
      numeracao.push({
        Serie: serie,
        Numero: i,
        Situacao: x ? x.status : "SEM REGISTRO",
        "Data do registro": x?.dataEmissao
          ? x.dataEmissao.toISOString().slice(0, 10)
          : "",
        "Acao necessaria": "Inutilizar a numeracao junto a SEFAZ",
      });
    }
  }

  resumo.push({
    Campo: "Lacunas de numeracao a inutilizar",
    Valor: numeracao.length,
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumo), "Resumo");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhas), "Notas");
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      numeracao.length
        ? numeracao
        : [{ Serie: "", Numero: "", Situacao: "Numeracao continua, sem lacuna" }],
    ),
    "Lacunas de numeracao",
  );
  const xlsxLocal = path.join(OUT_DIR, `${base}-conferencia.xlsx`);
  XLSX.writeFile(wb, xlsxLocal);

  console.log("\n===== RESUMO =====");
  console.log(`competencia            ${MESES[mes - 1]}/${ano}`);
  console.log(`notas autorizadas      ${autorizadas.length}`);
  console.log(`valor total            R$ ${total.toFixed(2)}`);
  console.log(`notas canceladas       ${canceladas.length}`);
  console.log(`XML ausentes           ${ausentes.length + semPath.length}`);
  if (semPath.length)
    console.log(`  (${semPath.length} sem caminho gravado no banco)`);
  if (ausentes.length)
    console.log(`  (${ausentes.length} com caminho mas sem arquivo no disco)`);
  console.log(`planilha               ${xlsxLocal}`);
  if (zipLocal) console.log(`pacote de XML          ${zipLocal}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[relatorio][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
