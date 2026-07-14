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
  WD_LOCATIONS: "WebDesmonte — locations.csv",
  WD_PURCHASE_WASTE: "WebDesmonte — purchase_waste.csv (sucatas)",
  WD_PRODUCTS: "WebDesmonte — products.csv (arquivo-ponte)",
  WD_CUSTOMERS: "WebDesmonte — customers.csv",
  DEXO_CONTAS: "Dexo — template de contas (CSV)",
  IBR_ESTOQUE: "IBR — estoque.csv (produtos + localização)",
  IBR_NFE: "IBR — nfe_emitidas.csv (notas fiscais)",
  DESCONHECIDO: "formato não reconhecido",
};

export function kindLabel(kind: DetectedKind): string {
  return KIND_LABEL[kind];
}

/** Assinaturas: todas as chaves (normKey) precisam estar no header. */
const SIGNATURES: Array<{ kind: DetectedKind; requires: string[] }> = [
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
  { kind: "VAAPT_CLIENTES", requires: ["codcliente", "nomecliente"] },
  { kind: "VAAPT_VEICULOS", requires: ["codigoveiculo", "marca", "modelo"] },
  { kind: "VAAPT_NFE", requires: ["nnfe", "chavedeacesso", "statusdanfe"] },
  { kind: "DEXO_CONTAS", requires: ["tipo", "valor", "vencimento"] },
];

function detectKind(header: string[]): DetectedKind {
  const keys = new Set(header.map((h) => normKey(h)));
  for (const sig of SIGNATURES) {
    if (sig.requires.every((r) => keys.has(r))) return sig.kind;
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
    rows: table.rows,
    get: table.get,
  };
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
            ? "colunas não reconhecidas"
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
      const extra = ignored.length
        ? ` (ignorei ${ignored.length} arquivo(s) que não são desta importação: ${ignored.map((i) => i.filename).join(", ")})`
        : "";
      throw new ImportValidationError(
        `Falta o arquivo obrigatório: ${names}. Confira se você escolheu o SISTEMA certo e envie-o para importar ${entity}.${extra}`,
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
