"use client";

import { useCallback, useRef, useState } from "react";
import { Download, FileDown, Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getApiBaseUrl } from "@/lib/api";

type ToastFn = (
  message: string,
  type: "success" | "error" | "warning",
) => void;

interface ImportExportProductsProps {
  email?: string | null;
  onProductsImported: () => void;
  onToast: ToastFn;
}

const IMPORT_COLUMNS = [
  "SKU",
  "Nome",
  "Descrição",
  "Preço",
  "Custo",
  "Estoque",
  "Marca",
  "Modelo",
  "Ano",
  "Categoria",
  "Part Number",
  "Qualidade",
  "Altura (cm)",
  "Largura (cm)",
  "Comprimento (cm)",
  "Peso (kg)",
  "URL Imagem",
] as const;

const QUALITY_MAP: Record<string, string> = {
  novo: "NOVO",
  seminovo: "SEMINOVO",
  sucata: "SUCATA",
  recondicionado: "RECONDICIONADO",
};

const EXAMPLE_ROW = {
  SKU: "EX-001",
  Nome: "Exemplo: Amortecedor dianteiro Honda Civic 2015",
  Descrição: "Item em bom estado, testado e aprovado.",
  Preço: 249.9,
  Custo: 120,
  Estoque: 1,
  Marca: "Honda",
  Modelo: "Civic",
  Ano: "2015",
  Categoria: "Suspensão",
  "Part Number": "ABC-123",
  Qualidade: "SEMINOVO",
  "Altura (cm)": 40,
  "Largura (cm)": 15,
  "Comprimento (cm)": 15,
  "Peso (kg)": 2.5,
  "URL Imagem": "https://exemplo.com/foto.jpg",
};

type ImportRow = Record<string, unknown>;

type ParsedProduct = {
  sku: string;
  name: string;
  description?: string;
  price: number;
  costPrice?: number;
  stock: number;
  brand?: string;
  model?: string;
  year?: string;
  category?: string;
  partNumber?: string;
  quality?: string;
  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;
  imageUrl: string;
};

type ImportError = { row: number; sku?: string; error: string };

function normalizeKey(k: string): string {
  return k
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readCell(row: ImportRow, ...keys: string[]): unknown {
  const normalized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    normalized[normalizeKey(k)] = v;
  }
  for (const k of keys) {
    const nk = normalizeKey(k);
    if (normalized[nk] !== undefined) return normalized[nk];
  }
  return undefined;
}

function toStr(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function toNum(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

function parseRow(row: ImportRow, index: number): ParsedProduct | ImportError {
  const sku = toStr(readCell(row, "SKU"));
  const name = toStr(readCell(row, "Nome", "Name"));
  const price = toNum(readCell(row, "Preço", "Preco", "Price"));
  const stock = toNum(readCell(row, "Estoque", "Stock"));
  const imageUrl = toStr(readCell(row, "URL Imagem", "Imagem", "Image"));

  if (!sku) return { row: index + 2, error: "SKU obrigatório" };
  if (!name) return { row: index + 2, sku, error: "Nome obrigatório" };
  if (price === undefined || price < 0)
    return { row: index + 2, sku, error: "Preço inválido" };
  if (stock === undefined || !Number.isInteger(stock) || stock < 0)
    return { row: index + 2, sku, error: "Estoque inválido" };
  if (!imageUrl)
    return { row: index + 2, sku, error: "URL Imagem obrigatória" };

  const qualityRaw = toStr(readCell(row, "Qualidade", "Quality"));
  const quality = qualityRaw
    ? QUALITY_MAP[qualityRaw.toLowerCase()] ??
      (["NOVO", "SEMINOVO", "SUCATA", "RECONDICIONADO"].includes(
        qualityRaw.toUpperCase(),
      )
        ? qualityRaw.toUpperCase()
        : undefined)
    : undefined;

  return {
    sku,
    name,
    description: toStr(readCell(row, "Descrição", "Descricao", "Description")),
    price,
    costPrice: toNum(readCell(row, "Custo", "Cost", "Preço de custo")),
    stock,
    brand: toStr(readCell(row, "Marca", "Brand")),
    model: toStr(readCell(row, "Modelo", "Model")),
    year: toStr(readCell(row, "Ano", "Year")),
    category: toStr(readCell(row, "Categoria", "Category")),
    partNumber: toStr(readCell(row, "Part Number", "PartNumber")),
    quality,
    heightCm: toNum(readCell(row, "Altura (cm)", "Altura", "Height")),
    widthCm: toNum(readCell(row, "Largura (cm)", "Largura", "Width")),
    lengthCm: toNum(readCell(row, "Comprimento (cm)", "Comprimento", "Length")),
    weightKg: toNum(readCell(row, "Peso (kg)", "Peso", "Weight")),
    imageUrl,
  };
}

async function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ImportExportProducts({
  email,
  onProductsImported,
  onToast,
}: ImportExportProductsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importProgress, setImportProgress] = useState({ done: 0, total: 0 });
  const [importErrors, setImportErrors] = useState<ImportError[]>([]);
  const [importDone, setImportDone] = useState(false);
  const [importSuccessCount, setImportSuccessCount] = useState(0);

  const handleDownloadTemplate = useCallback(async () => {
    try {
      const XLSX = await import("xlsx");
      const ws = XLSX.utils.json_to_sheet([EXAMPLE_ROW], {
        header: IMPORT_COLUMNS as unknown as string[],
      });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Produtos");
      const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      await triggerDownload(
        new Blob([buf], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        "modelo-produtos.xlsx",
      );
      onToast("Modelo baixado com sucesso", "success");
    } catch (err) {
      onToast(
        `Erro ao gerar modelo: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  }, [onToast]);

  const handleExport = useCallback(async () => {
    if (!email) {
      onToast("Sessão inválida — faça login novamente", "error");
      return;
    }
    setIsExporting(true);
    try {
      const XLSX = await import("xlsx");
      const all: any[] = [];
      let page = 1;
      const limit = 100;
      while (true) {
        const resp = await fetch(
          `${getApiBaseUrl()}/products?page=${page}&limit=${limit}`,
          { headers: { email } },
        );
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || `Falha ao buscar página ${page}`);
        }
        const data = await resp.json();
        all.push(...(data.products ?? []));
        const totalPages = data.pagination?.totalPages ?? 1;
        if (page >= totalPages) break;
        page++;
      }

      if (all.length === 0) {
        onToast("Nenhum produto para exportar", "warning");
        return;
      }

      const rows = all.map((p) => ({
        SKU: p.sku ?? "",
        Nome: p.name ?? "",
        Descrição: p.description ?? "",
        Preço: Number(p.price ?? 0),
        Custo: p.costPrice != null ? Number(p.costPrice) : "",
        Estoque: Number(p.stock ?? 0),
        Marca: p.brand ?? "",
        Modelo: p.model ?? "",
        Ano: p.year ?? "",
        Categoria: p.category ?? "",
        "Part Number": p.partNumber ?? "",
        Qualidade: p.quality ?? "",
        "Altura (cm)": p.heightCm != null ? Number(p.heightCm) : "",
        "Largura (cm)": p.widthCm != null ? Number(p.widthCm) : "",
        "Comprimento (cm)": p.lengthCm != null ? Number(p.lengthCm) : "",
        "Peso (kg)": p.weightKg != null ? Number(p.weightKg) : "",
        "URL Imagem": p.imageUrl ?? "",
      }));

      const ws = XLSX.utils.json_to_sheet(rows, {
        header: IMPORT_COLUMNS as unknown as string[],
      });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Produtos");
      const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const stamp = new Date().toISOString().slice(0, 10);
      await triggerDownload(
        new Blob([buf], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        `produtos-${stamp}.xlsx`,
      );
      onToast(`Exportados ${all.length} produtos`, "success");
    } catch (err) {
      onToast(
        `Erro ao exportar: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setIsExporting(false);
    }
  }, [email, onToast]);

  const handleFileChosen = useCallback(
    async (file: File) => {
      if (!email) {
        onToast("Sessão inválida — faça login novamente", "error");
        return;
      }
      setIsImporting(true);
      setImportErrors([]);
      setImportDone(false);
      setImportSuccessCount(0);
      setImportDialogOpen(true);

      try {
        const XLSX = await import("xlsx");
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const sheetName = wb.SheetNames[0];
        if (!sheetName) throw new Error("Planilha vazia");
        const sheet = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json<ImportRow>(sheet, { defval: "" });

        if (rows.length === 0) {
          onToast("Nenhuma linha encontrada na planilha", "warning");
          setImportDone(true);
          return;
        }

        const parsed: ParsedProduct[] = [];
        const errors: ImportError[] = [];
        rows.forEach((r, i) => {
          const result = parseRow(r, i);
          if ("error" in result) errors.push(result);
          else parsed.push(result);
        });

        setImportProgress({ done: 0, total: parsed.length });
        let success = 0;

        for (let i = 0; i < parsed.length; i++) {
          const p = parsed[i];
          try {
            const resp = await fetch(`${getApiBaseUrl()}/products`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                email,
              },
              body: JSON.stringify(p),
            });
            if (!resp.ok) {
              const data = await resp.json().catch(() => ({}));
              errors.push({
                row: i + 2,
                sku: p.sku,
                error: data.error || `HTTP ${resp.status}`,
              });
            } else {
              success++;
            }
          } catch (err) {
            errors.push({
              row: i + 2,
              sku: p.sku,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          setImportProgress({ done: i + 1, total: parsed.length });
        }

        setImportErrors(errors);
        setImportSuccessCount(success);
        setImportDone(true);

        if (success > 0) {
          onProductsImported();
          onToast(
            `${success} produto(s) importado(s)${
              errors.length > 0 ? `, ${errors.length} com erro` : ""
            }`,
            errors.length > 0 ? "warning" : "success",
          );
        } else if (errors.length > 0) {
          onToast(`Falha na importação: ${errors.length} erro(s)`, "error");
        }
      } catch (err) {
        onToast(
          `Erro ao importar: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        setImportDone(true);
      } finally {
        setIsImporting(false);
      }
    },
    [email, onProductsImported, onToast],
  );

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileChosen(file);
          e.target.value = "";
        }}
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" disabled={isExporting || isImporting}>
            {isExporting || isImporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileDown className="mr-2 h-4 w-4" />
            )}
            Importar / Exportar
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            onClick={() => fileInputRef.current?.click()}
            disabled={isImporting}
          >
            <Upload className="mr-2 h-4 w-4" />
            Importar planilha (.xlsx)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleExport} disabled={isExporting}>
            <Download className="mr-2 h-4 w-4" />
            Exportar todos os produtos
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleDownloadTemplate}>
            <FileDown className="mr-2 h-4 w-4" />
            Baixar modelo de planilha
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {importDone ? "Importação concluída" : "Importando produtos…"}
            </DialogTitle>
            <DialogDescription>
              {importDone
                ? `${importSuccessCount} produto(s) criados${
                    importErrors.length > 0
                      ? `, ${importErrors.length} linha(s) com erro`
                      : ""
                  }.`
                : `Progresso: ${importProgress.done} de ${importProgress.total}`}
            </DialogDescription>
          </DialogHeader>

          {!importDone && importProgress.total > 0 && (
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{
                  width: `${
                    (importProgress.done / importProgress.total) * 100
                  }%`,
                }}
              />
            </div>
          )}

          {importDone && importErrors.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded border border-border/60 bg-muted/40 p-3 text-xs">
              <div className="mb-2 font-medium">Linhas com erro:</div>
              <ul className="space-y-1">
                {importErrors.map((e, i) => (
                  <li key={i} className="font-mono">
                    Linha {e.row}
                    {e.sku ? ` (${e.sku})` : ""}: {e.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <DialogFooter>
            <Button
              onClick={() => setImportDialogOpen(false)}
              disabled={!importDone}
            >
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
