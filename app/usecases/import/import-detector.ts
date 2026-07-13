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

/**
 * Detecta todos os arquivos e valida a coerência com sistema+entidade.
 * Arquivo com papel desconhecido ou fora do esperado ⇒ erro claro (nunca
 * "chuta" o que importar).
 */
export function detectAndValidate(
  system: ImportSystem,
  entity: ImportEntity,
  files: ImportFile[],
): DetectedFile[] {
  if (files.length === 0) {
    throw new ImportValidationError("Envie ao menos um arquivo.");
  }
  const detected = files.map(detectFile);
  const { required, optional } = expectedKinds(system, entity);
  const allAccepted = new Set<DetectedKind>([...required.flat(), ...optional]);

  for (const f of detected) {
    if (f.kind === "DESCONHECIDO") {
      const origem =
        system === "VAAPT"
          ? "Vaapt"
          : system === "WEBDESMONTE"
            ? "WebDesmonte (IBR clássico)"
            : system === "IBR"
              ? "IBR — export tabular (estoque/NF-e)"
              : "contas (template Dexo)";
      throw new ImportValidationError(
        `"${f.filename}": não reconheci as colunas deste arquivo. Confira se é o export correto de ${origem}.`,
      );
    }
    if (!allAccepted.has(f.kind)) {
      throw new ImportValidationError(
        `"${f.filename}" parece ser "${kindLabel(f.kind)}", que não é usado na importação de ${entity} (${system}).`,
      );
    }
  }

  for (const slot of required) {
    const ok = detected.some((f) => slot.includes(f.kind));
    if (!ok) {
      const names = slot.map((k) => kindLabel(k)).join(" ou ");
      throw new ImportValidationError(
        `Falta o arquivo: ${names}. Envie-o junto para importar ${entity}.`,
      );
    }
  }

  // Papéis repetidos (2 arquivos com a mesma assinatura) = ambiguidade.
  const byKind = new Map<DetectedKind, number>();
  for (const f of detected) {
    byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  }
  for (const [kind, count] of byKind) {
    if (count > 1) {
      throw new ImportValidationError(
        `Recebi ${count} arquivos do tipo "${kindLabel(kind)}". Envie apenas um de cada.`,
      );
    }
  }

  return detected;
}

/** Acha o arquivo de um papel específico (após detectAndValidate). */
export function fileOfKind(
  files: DetectedFile[],
  kind: DetectedKind,
): DetectedFile | null {
  return files.find((f) => f.kind === kind) ?? null;
}
