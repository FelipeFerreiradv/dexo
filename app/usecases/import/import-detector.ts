/**
 * Detecção de sistema/entidade por ASSINATURA DE COLUNAS — nunca pelo nome do
 * arquivo (os exports reais chegam com nomes variados: "pecas-localizacao",
 * "Backup Pecas - 704", "RelatorioPecasEmp351"…). O operador escolhe
 * sistema+entidade no modal; o detector confirma que cada arquivo enviado
 * bate com o esperado e classifica o papel de cada um (importante no modo
 * PACOTE do WebDesmonte, que recebe vários CSVs numa request).
 */

import type {
  DetectedFile,
  DetectedKind,
  ImportEntity,
  ImportFile,
  ImportSystem,
} from "./import.types";
import { ImportValidationError } from "./import.types";
import { normKey } from "./lib/normalize";
import { readCsvBuffer } from "./parse/csv-reader";
import { readXlsxBuffer, sniffFileFormat } from "./parse/xlsx-reader";

const KIND_LABEL: Record<DetectedKind, string> = {
  VAAPT_PECAS: "Vaapt — peças/localização (arquivo-ponte)",
  VAAPT_CLIENTES: "Vaapt — clientes",
  VAAPT_VEICULOS: "Vaapt — veículos (sucatas)",
  VAAPT_NFE: "Vaapt — notas fiscais emitidas (resumo)",
  VAAPT_PECAS_IMAGENS:
    "Vaapt — fotos das peças (a importação de fotos ainda não está disponível)",
  WD_LOCATIONS: "WebDesmonte — locations.csv",
  WD_PURCHASE_WASTE: "WebDesmonte — purchase_waste.csv (sucatas)",
  WD_PRODUCTS: "WebDesmonte — products.csv (arquivo-ponte)",
  WD_CUSTOMERS: "WebDesmonte — customers.csv",
  DEXO_CONTAS: "Dexo — template de contas (CSV)",
  IBR_ESTOQUE: "IBR — estoque.csv (produtos + localização)",
  IBR_NFE: "IBR — nfe_emitidas.csv (notas fiscais)",
  IBRSOFT_PRODUTOS: "IBR Soft — produtos.csv",
  IBRSOFT_SUCATAS: "IBR Soft — sucatas.csv",
  IBRSOFT_LOCALIZACOES: "IBR Soft — localizacoes.csv",
  IBRSOFT_CLIENTES: "IBR Soft — clientes (costumers.csv)",
  IBRSOFT_NFE: "IBR Soft — nfe.csv",
  IBRSOFT_CONTAS_PAGAR: "IBR Soft — contas_a_pagar.csv",
  IBRSOFT_CONTAS_RECEBER: "IBR Soft — contas_a_receber.csv",
  DESCONHECIDO: "formato não reconhecido",
};

export function kindLabel(kind: DetectedKind): string {
  return KIND_LABEL[kind];
}

/**
 * Assinatura de um formato.
 *
 * - `requires`: colunas que identificam o formato — TODAS precisam existir.
 * - `anyOf` + `anyOfMin`: colunas ACESSÓRIAS das quais bastam `anyOfMin`.
 *
 * A separação existe porque um mesmo sistema legado exporta VARIANTES do mesmo
 * relatório, trocando ou omitindo colunas secundárias. Listar tudo como
 * obrigatório faz uma variante legítima cair em DESCONHECIDO (foi o que
 * aconteceu com o relatório de veículos do Vaapt); aceitar só uma coluna
 * abriria a porta para falso positivo. `requires` guarda a identidade,
 * `anyOf` absorve a variação.
 */
interface ColumnSignature {
  kind: DetectedKind;
  requires: string[];
  anyOf?: string[];
  anyOfMin?: number;
}

/** Assinaturas conhecidas, da MAIS específica para a mais genérica (o primeiro
 *  match vence — por isso a ordem importa). Chaves sempre em normKey. */
const SIGNATURES: ColumnSignature[] = [
  // IBR Soft completo (colunas PT snake_case, muito específicas).
  {
    kind: "IBRSOFT_PRODUTOS",
    requires: ["codigo", "valorvenda", "siglalocalizacao", "custocompra"],
  },
  {
    kind: "IBRSOFT_SUCATAS",
    requires: ["codigosequencial", "valorcompra", "certidaobaixa", "chassi"],
  },
  {
    kind: "IBRSOFT_LOCALIZACOES",
    requires: ["caminhosiglas", "idpai", "nivel", "aceitaestoque"],
  },
  {
    kind: "IBRSOFT_CLIENTES",
    requires: ["nomerazaosocial", "cpfcnpj", "nomefantasia", "tipo"],
  },
  {
    kind: "IBRSOFT_NFE",
    requires: ["numeronota", "chaveacesso", "destinatario", "naturezaoperacao"],
  },
  {
    kind: "IBRSOFT_CONTAS_PAGAR",
    requires: ["favorecido", "documentofavorecido", "valorinicial", "vencimento"],
  },
  {
    kind: "IBRSOFT_CONTAS_RECEBER",
    requires: ["valorrecebido", "documentocliente", "valorinicial", "vencimento"],
  },
  // IBR "tabular" (colunas próprias, distintas de tudo — checadas primeiro).
  {
    kind: "IBR_ESTOQUE",
    requires: ["sku", "quantidadeestoque", "valorvenda", "localizacaosiglas"],
  },
  {
    kind: "IBR_NFE",
    requires: ["numeronotafiscal", "chavedeacesso", "nomedestinatario"],
  },
  // Mais específicas primeiro (products.csv tem 111 colunas e engloba muita coisa).
  { kind: "WD_PRODUCTS", requires: ["code", "locationid", "purchasewasteid"] },
  { kind: "WD_LOCATIONS", requires: ["initialspath", "parentid", "level"] },
  {
    kind: "WD_PURCHASE_WASTE",
    requires: ["licenseplate", "chassis", "purchasevalue"],
  },
  { kind: "WD_CUSTOMERS", requires: ["name", "document", "type", "companyid"] },
  { kind: "VAAPT_PECAS", requires: ["codpeca", "localizacao"] },
  // Fotos das peças: "# idPeca" (≠ "# Cod Peca" da planilha de peças) + a
  // coluna de link. Reconhecido só para o operador receber uma mensagem
  // precisa em vez de "colunas não reconhecidas".
  {
    kind: "VAAPT_PECAS_IMAGENS",
    requires: ["idpeca"],
    anyOf: ["linkdasimagens", "linkdaimagem", "linkimagem", "linkdasimagem"],
    anyOfMin: 1,
  },
  { kind: "VAAPT_CLIENTES", requires: ["codcliente", "nomecliente"] },
  // "# Codigo Veiculo" identifica sozinho o relatório de veículos: a planilha
  // de peças traz "Cod Veiculo" e a de fotos "strCodigoVeiculo", que
  // normalizam para chaves DIFERENTES ("codveiculo"/"strcodigoveiculo"). As
  // demais colunas variam entre os exports — na variante com uma linha por
  // foto não há Marca nem Modelo —, então entram como acessórias (≥2 basta),
  // o que ainda barra um arquivo qualquer que só tenha essa coluna.
  {
    kind: "VAAPT_VEICULOS",
    requires: ["codigoveiculo"],
    anyOf: [
      "marca",
      "modelo",
      "chassi",
      "numerochassi",
      "chassis",
      "placa",
      "renavam",
      "numeromotor",
      "motor",
      "valordacompra",
      "valorcompra",
      "datacompra",
      "anomodelo",
      "ano",
      "apelido",
      "cor",
    ],
    anyOfMin: 2,
  },
  { kind: "VAAPT_NFE", requires: ["nnfe", "chavedeacesso", "statusdanfe"] },
  { kind: "DEXO_CONTAS", requires: ["tipo", "valor", "vencimento"] },
];

function matchesSignature(keys: Set<string>, sig: ColumnSignature): boolean {
  for (const r of sig.requires) if (!keys.has(r)) return false;
  if (!sig.anyOf || sig.anyOf.length === 0) return true;
  const min = sig.anyOfMin ?? 1;
  let hits = 0;
  for (const k of sig.anyOf) {
    if (keys.has(k) && ++hits >= min) return true;
  }
  return false;
}

function detectKind(header: string[]): DetectedKind {
  const keys = new Set(header.map((h) => normKey(h)));
  for (const sig of SIGNATURES) {
    if (matchesSignature(keys, sig)) return sig.kind;
  }
  return "DESCONHECIDO";
}

/** Parseia + classifica um arquivo enviado. */
export function detectFile(file: ImportFile): DetectedFile {
  const format = sniffFileFormat(file.buffer);
  if (format === "xml") {
    throw new ImportValidationError(
      `"${file.filename}": XML ainda não é suportado nesta importação (a fase de NF-e por XML virá depois). Envie CSV/XLSX/XLS.`,
    );
  }
  const table =
    format === "csv" ? readCsvBuffer(file.buffer) : readXlsxBuffer(file.buffer);
  const kind = detectKind(table.header);
  return {
    ...file,
    kind,
    header: table.header,
    rows: table.rows,
    get: table.get,
  };
}

/**
 * Colunas lidas, resumidas para caber numa mensagem de erro. É o que permite
 * diagnosticar um export novo sem pedir o arquivo ao cliente.
 */
const MAX_HEADER_IN_MESSAGE = 12;

export function describeHeader(header: string[]): string {
  const cols = header.filter((h) => h && !h.startsWith("__EMPTY"));
  if (cols.length === 0) return "nenhuma coluna";
  const shown = cols.slice(0, MAX_HEADER_IN_MESSAGE).join(", ");
  return cols.length > MAX_HEADER_IN_MESSAGE
    ? `${shown} … (+${cols.length - MAX_HEADER_IN_MESSAGE})`
    : shown;
}

/** Papéis aceitos por sistema+entidade: [obrigatórios…] + [opcionais…]. */
export function expectedKinds(
  system: ImportSystem,
  entity: ImportEntity,
): { required: DetectedKind[][]; optional: DetectedKind[] } {
  // `required` é lista de "slots": cada slot lista os kinds que o satisfazem.
  const table: Partial<
    Record<
      ImportSystem,
      Partial<
        Record<
          ImportEntity,
          { required: DetectedKind[][]; optional: DetectedKind[] }
        >
      >
    >
  > = {
    VAAPT: {
      CLIENTES: { required: [["VAAPT_CLIENTES"]], optional: [] },
      LOCALIZACOES: { required: [["VAAPT_PECAS"]], optional: [] },
      SUCATAS: { required: [["VAAPT_VEICULOS"]], optional: [] },
      // O vínculo cria as localizações faltantes do próprio arquivo-ponte
      // (idempotente) e aceita o arquivo de veículos junto p/ criar sucatas.
      VINCULOS: { required: [["VAAPT_PECAS"]], optional: ["VAAPT_VEICULOS"] },
      NFE: { required: [["VAAPT_NFE"]], optional: [] },
      PACOTE: {
        // No pacote, qualquer combinação ≥1 das planilhas do export.
        required: [
          ["VAAPT_PECAS", "VAAPT_CLIENTES", "VAAPT_VEICULOS", "VAAPT_NFE"],
        ],
        optional: [
          "VAAPT_PECAS",
          "VAAPT_CLIENTES",
          "VAAPT_VEICULOS",
          "VAAPT_NFE",
        ],
      },
    },
    WEBDESMONTE: {
      LOCALIZACOES: { required: [["WD_LOCATIONS"]], optional: [] },
      SUCATAS: {
        required: [["WD_PURCHASE_WASTE"]],
        optional: ["WD_LOCATIONS"],
      },
      CLIENTES: { required: [["WD_CUSTOMERS"]], optional: [] },
      VINCULOS: {
        required: [["WD_PRODUCTS"], ["WD_LOCATIONS"]],
        optional: ["WD_PURCHASE_WASTE"],
      },
      PACOTE: {
        // No pacote, qualquer combinação ≥1 dos CSVs do export.
        required: [
          ["WD_LOCATIONS", "WD_PURCHASE_WASTE", "WD_PRODUCTS", "WD_CUSTOMERS"],
        ],
        optional: [
          "WD_LOCATIONS",
          "WD_PURCHASE_WASTE",
          "WD_PRODUCTS",
          "WD_CUSTOMERS",
        ],
      },
    },
    DEXO: {
      CONTAS: { required: [["DEXO_CONTAS"]], optional: [] },
    },
    IBR: {
      // estoque.csv sozinho: cria localizações (árvore do texto), vincula por
      // SKU e cria os produtos faltantes.
      ESTOQUE: { required: [["IBR_ESTOQUE"]], optional: [] },
      NFE: { required: [["IBR_NFE"]], optional: [] },
      // Pacote do export tabular: qualquer combinação ≥1 de estoque.csv e/ou
      // nfe_emitidas.csv. As fases rodam na ordem certa; o que não vier é
      // pulado e os arquivos extras (vendas*, empresa…) são ignorados.
      PACOTE: {
        required: [["IBR_ESTOQUE", "IBR_NFE"]],
        optional: ["IBR_ESTOQUE", "IBR_NFE"],
      },
    },
    IBRSOFT: {
      // Pacote completo: qualquer combinação ≥1 dos CSVs do export IBR Soft. As
      // fases rodam na ordem certa; arquivos ausentes são pulados.
      PACOTE: {
        required: [
          [
            "IBRSOFT_CLIENTES",
            "IBRSOFT_LOCALIZACOES",
            "IBRSOFT_SUCATAS",
            "IBRSOFT_PRODUTOS",
            "IBRSOFT_NFE",
            "IBRSOFT_CONTAS_PAGAR",
            "IBRSOFT_CONTAS_RECEBER",
          ],
        ],
        optional: [
          "IBRSOFT_CLIENTES",
          "IBRSOFT_LOCALIZACOES",
          "IBRSOFT_SUCATAS",
          "IBRSOFT_PRODUTOS",
          "IBRSOFT_NFE",
          "IBRSOFT_CONTAS_PAGAR",
          "IBRSOFT_CONTAS_RECEBER",
        ],
      },
    },
  };

  const found = table[system]?.[entity];
  if (!found) {
    throw new ImportValidationError(
      `Entidade "${entity}" não está disponível para o sistema "${system}".`,
    );
  }
  return found;
}

export interface IgnoredFile {
  filename: string;
  motivo: string;
}

export interface DetectResult {
  files: DetectedFile[];
  /** Arquivos enviados que não pertencem a esta entidade — ignorados (não é
   *  erro). O operador pode arrastar o pacote inteiro; o motor usa só os que
   *  precisa. */
  ignored: IgnoredFile[];
}

/**
 * Detecta todos os arquivos e valida a coerência com sistema+entidade.
 *
 * TOLERANTE A EXTRAS: arquivos que não pertencem à entidade (formato
 * desconhecido OU papel de outra entidade) são IGNORADOS com aviso, não
 * derrubam a importação — assim o operador pode anexar o pacote inteiro do
 * cliente e o motor usa só o que precisa. O que continua sendo ERRO: faltar o
 * arquivo OBRIGATÓRIO da entidade, ou receber 2 arquivos do mesmo papel.
 */
export function detectAndValidate(
  system: ImportSystem,
  entity: ImportEntity,
  files: ImportFile[],
): DetectResult {
  if (files.length === 0) {
    throw new ImportValidationError("Envie ao menos um arquivo.");
  }
  const detected = files.map(detectFile);
  const { required, optional } = expectedKinds(system, entity);
  const allAccepted = new Set<DetectedKind>([...required.flat(), ...optional]);

  const accepted: DetectedFile[] = [];
  const ignored: IgnoredFile[] = [];
  for (const f of detected) {
    if (allAccepted.has(f.kind)) {
      accepted.push(f);
    } else {
      ignored.push({
        filename: f.filename,
        motivo:
          f.kind === "DESCONHECIDO"
            ? `colunas não reconhecidas (li: ${describeHeader(f.header)})`
            : `parece ser "${kindLabel(f.kind)}"`,
      });
    }
  }

  // Papéis repetidos ENTRE OS ACEITOS = ambiguidade (erro).
  const byKind = new Map<DetectedKind, number>();
  for (const f of accepted) {
    byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  }
  for (const [kind, count] of byKind) {
    if (count > 1) {
      throw new ImportValidationError(
        `Recebi ${count} arquivos do tipo "${kindLabel(kind)}". Envie apenas um de cada.`,
      );
    }
  }

  // Obrigatórios: cada slot precisa de um arquivo aceito. Se falta, erro claro
  // — mencionando o que foi ignorado (ajuda a diagnosticar sistema errado).
  for (const slot of required) {
    const ok = accepted.some((f) => slot.includes(f.kind));
    if (!ok) {
      const names = slot.map((k) => kindLabel(k)).join(" ou ");
      // O MOTIVO de cada arquivo ignorado vai junto: é o que diz se o arquivo
      // era de outra entidade ou se o formato não foi reconhecido (e, nesse
      // caso, quais colunas o motor leu). Sem isso a mensagem culpa a escolha
      // do sistema mesmo quando o problema é o arquivo.
      const extra = ignored.length
        ? ` Ignorei ${ignored.length} arquivo(s): ${ignored
            .map((i) => `${i.filename} — ${i.motivo}`)
            .join("; ")}.`
        : "";
      // A dica de "conferir o sistema" só faz sentido quando NADA foi
      // aproveitado; se parte dos arquivos entrou, o sistema está certo e o
      // que falta é a planilha em si.
      const dica = accepted.length
        ? `Envie-a junto para importar ${entity}.`
        : `Confira se você escolheu o SISTEMA certo e envie-a para importar ${entity}.`;
      throw new ImportValidationError(
        `Falta o arquivo obrigatório: ${names}. ${dica}${extra}`,
      );
    }
  }

  return { files: accepted, ignored };
}

/** Acha o arquivo de um papel específico (após detectAndValidate). */
export function fileOfKind(
  files: DetectedFile[],
  kind: DetectedKind,
): DetectedFile | null {
  return files.find((f) => f.kind === kind) ?? null;
}

/**
 * (sistema, entidade) → kinds que aquele "pacote" reconhece. Usado para
 * INFERIR a origem só pelos arquivos, quando o operador escolheu o sistema
 * errado no seletor (os 3 rótulos "IBR…" são fáceis de confundir). Vaapt fica
 * de fora de propósito: um mesmo arquivo Vaapt serve a várias entidades
 * (VÍNCULOS vs SUCATAS), então não há inferência única — o operador escolhe.
 */
const INFERENCE_CANDIDATES: Array<{
  system: ImportSystem;
  entity: ImportEntity;
  kinds: DetectedKind[];
}> = [
  {
    system: "IBRSOFT",
    entity: "PACOTE",
    kinds: [
      "IBRSOFT_CLIENTES",
      "IBRSOFT_LOCALIZACOES",
      "IBRSOFT_SUCATAS",
      "IBRSOFT_PRODUTOS",
      "IBRSOFT_NFE",
      "IBRSOFT_CONTAS_PAGAR",
      "IBRSOFT_CONTAS_RECEBER",
    ],
  },
  {
    system: "WEBDESMONTE",
    entity: "PACOTE",
    kinds: ["WD_LOCATIONS", "WD_PURCHASE_WASTE", "WD_PRODUCTS", "WD_CUSTOMERS"],
  },
  // IBR tabular: um ÚNICO candidato dono de estoque + nfe. Antes havia dois
  // (ESTOQUE e NFE separados), o que tornava {estoque, nfe} ambíguo (2 matches
  // → null) e impedia a auto-detecção de resgatar o operador que arrastava o
  // export inteiro. Como o PACOTE roda as mesmas fases individuais quando só um
  // arquivo vem, inferir p/ PACOTE é equivalente e desambigua o caso completo.
  { system: "IBR", entity: "PACOTE", kinds: ["IBR_ESTOQUE", "IBR_NFE"] },
  { system: "DEXO", entity: "CONTAS", kinds: ["DEXO_CONTAS"] },
];

/**
 * Infere (sistema, entidade) SÓ pelos arquivos, para resgatar o operador que
 * escolheu o sistema errado. Confiante apenas quando TODOS os arquivos
 * reconhecidos pertencem a UM único candidato; se abrangerem mais de um
 * (ex.: IBR Soft + WebDesmonte juntos) ou nada for reconhecido, devolve null
 * (nunca chuta). Determinístico. Não escreve nada.
 */
export function inferSystemEntity(
  files: ImportFile[],
): { system: ImportSystem; entity: ImportEntity } | null {
  const kinds = new Set<DetectedKind>();
  for (const f of files) {
    const k = detectFile(f).kind;
    if (k !== "DESCONHECIDO") kinds.add(k);
  }
  if (kinds.size === 0) return null;

  const matches = INFERENCE_CANDIDATES.filter((c) =>
    c.kinds.some((k) => kinds.has(k)),
  );
  if (matches.length !== 1) return null; // 0 = nada bate; >1 = ambíguo
  const cand = matches[0];
  const belongs = new Set(cand.kinds);
  // Coerência: nenhum arquivo reconhecido pode ser de OUTRO pacote.
  for (const k of kinds) if (!belongs.has(k)) return null;
  return { system: cand.system, entity: cand.entity };
}
