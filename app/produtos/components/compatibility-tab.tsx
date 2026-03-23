"use client";

import { useState, useMemo, useCallback } from "react";
import {
  Search,
  Plus,
  Trash2,
  AlertTriangle,
  Loader2,
  ListPlus,
  RotateCcw,
  Save,
  HelpCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { BRANDS } from "../../lib/product-parser";

// ---- Tipos locais ----

export interface CompatibilityEntry {
  /** ID temporário/local (uuid) para uso no form; o backend atribui o real */
  _localId: string;
  brand: string;
  model: string;
  yearFrom?: number | null;
  yearTo?: number | null;
  version?: string | null;
}

interface CompatibilityTabProps {
  value: CompatibilityEntry[];
  onChange: (entries: CompatibilityEntry[]) => void;
  /** Mensagem de loading enquanto carrega entradas existentes */
  isLoading?: boolean;
}

// Helper para gerar um id local simples
let _seq = 0;
function localId(): string {
  _seq += 1;
  return `compat-${Date.now()}-${_seq}`;
}

// ---- Componente ----

export function CompatibilityTab({
  value,
  onChange,
  isLoading,
}: CompatibilityTabProps) {
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);

  // Form state para adicionar um registro
  const [addBrand, setAddBrand] = useState("");
  const [addModel, setAddModel] = useState("");
  const [addYearFrom, setAddYearFrom] = useState("");
  const [addYearTo, setAddYearTo] = useState("");
  const [addVersion, setAddVersion] = useState("");

  // Form state para adição em massa
  const [batchText, setBatchText] = useState("");

  // Filtro de busca
  const filtered = useMemo(() => {
    if (!search.trim()) return value;
    const q = search.toLowerCase();
    return value.filter(
      (c) =>
        c.brand.toLowerCase().includes(q) ||
        c.model.toLowerCase().includes(q) ||
        (c.version && c.version.toLowerCase().includes(q)) ||
        String(c.yearFrom ?? "").includes(q) ||
        String(c.yearTo ?? "").includes(q),
    );
  }, [value, search]);

  // Toggle seleção individual
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Toggle selecionar todos visíveis
  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      const allFiltered = new Set(filtered.map((c) => c._localId));
      const allSelected = filtered.every((c) => prev.has(c._localId));
      if (allSelected) {
        // Desmarcar todos os filtrados
        const next = new Set(prev);
        allFiltered.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...prev, ...allFiltered]);
    });
  }, [filtered]);

  // Adicionar individual
  const handleAdd = useCallback(() => {
    if (!addBrand.trim() || !addModel.trim()) return;
    const entry: CompatibilityEntry = {
      _localId: localId(),
      brand: addBrand.trim(),
      model: addModel.trim(),
      yearFrom: addYearFrom ? parseInt(addYearFrom, 10) : null,
      yearTo: addYearTo ? parseInt(addYearTo, 10) : null,
      version: addVersion.trim() || null,
    };
    onChange([...value, entry]);
    setAddBrand("");
    setAddModel("");
    setAddYearFrom("");
    setAddYearTo("");
    setAddVersion("");
    setAddDialogOpen(false);
  }, [addBrand, addModel, addYearFrom, addYearTo, addVersion, onChange, value]);

  // Adicionar em massa (formato: Marca; Modelo; AnoInicio; AnoFim; Versão — uma por linha)
  const handleBatchAdd = useCallback(() => {
    const lines = batchText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const entries: CompatibilityEntry[] = [];
    for (const line of lines) {
      const parts = line.split(/[;\t]/).map((p) => p.trim());
      const brand = parts[0];
      const model = parts[1];
      if (!brand || !model) continue;
      entries.push({
        _localId: localId(),
        brand,
        model,
        yearFrom: parts[2] ? parseInt(parts[2], 10) || null : null,
        yearTo: parts[3] ? parseInt(parts[3], 10) || null : null,
        version: parts[4] || null,
      });
    }
    if (entries.length > 0) {
      onChange([...value, ...entries]);
    }
    setBatchText("");
    setBatchDialogOpen(false);
  }, [batchText, onChange, value]);

  // Remover selecionados
  const handleRemoveSelected = useCallback(() => {
    onChange(value.filter((c) => !selectedIds.has(c._localId)));
    setSelectedIds(new Set());
  }, [onChange, selectedIds, value]);

  // Limpar tudo
  const handleClear = useCallback(() => {
    onChange([]);
    setSelectedIds(new Set());
  }, [onChange]);

  const formatYear = (from?: number | null, to?: number | null): string => {
    if (from && to) return from === to ? String(from) : `${from}–${to}`;
    if (from) return `${from}+`;
    if (to) return `até ${to}`;
    return "—";
  };

  const allChecked =
    filtered.length > 0 && filtered.every((c) => selectedIds.has(c._localId));
  const someChecked = filtered.some((c) => selectedIds.has(c._localId));

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold">
            Com quais veículos seu produto é compatível?
          </h3>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="h-4 w-4 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <p>
                  Adicione os veículos com os quais esta peça é compatível.
                  Essas informações serão usadas para preencher automaticamente
                  marca, modelo e ano, e também serão enviadas nos anúncios do
                  Mercado Livre.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <p className="text-sm text-muted-foreground">
          Atualmente, você tem{" "}
          <span className="font-medium">{value.length}</span> veículo(s) salvos
          como compatíveis
        </p>
      </div>

      {/* Barra de busca e ações */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-50">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Pesquise aqui..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRemoveSelected}
          disabled={selectedIds.size === 0}
        >
          <Trash2 className="mr-1 h-4 w-4" />
          Remover selecionadas
        </Button>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setBatchDialogOpen(true)}
        >
          <ListPlus className="mr-1 h-4 w-4" />
          Adicionar em Massa
        </Button>

        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => setAddDialogOpen(true)}
        >
          <Plus className="mr-1 h-4 w-4" />
          Adicionar
        </Button>
      </div>

      {/* Tabela */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allChecked}
                  onCheckedChange={toggleAll}
                  aria-label="Selecionar todos"
                  {...(someChecked && !allChecked
                    ? { "data-state": "indeterminate" }
                    : {})}
                />
              </TableHead>
              <TableHead>Marca</TableHead>
              <TableHead>Modelo</TableHead>
              <TableHead>Ano</TableHead>
              <TableHead>Versão</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8">
                  <div className="flex items-center justify-center gap-2 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Carregando compatibilidades...</span>
                  </div>
                </TableCell>
              </TableRow>
            )}

            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8">
                  <div className="flex items-center justify-center gap-2 text-muted-foreground">
                    <AlertTriangle className="h-4 w-4" />
                    <span>
                      {value.length === 0
                        ? "Nenhuma compatibilidade adicionada."
                        : "Nenhum resultado encontrado para a busca."}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            )}

            {!isLoading &&
              filtered.map((entry) => (
                <TableRow key={entry._localId}>
                  <TableCell>
                    <Checkbox
                      checked={selectedIds.has(entry._localId)}
                      onCheckedChange={() => toggleSelect(entry._localId)}
                      aria-label={`Selecionar ${entry.brand} ${entry.model}`}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{entry.brand}</TableCell>
                  <TableCell>{entry.model}</TableCell>
                  <TableCell>
                    {formatYear(entry.yearFrom, entry.yearTo)}
                  </TableCell>
                  <TableCell>{entry.version || "—"}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        onChange(
                          value.filter((c) => c._localId !== entry._localId),
                        );
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          next.delete(entry._localId);
                          return next;
                        });
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>

      {/* Footer */}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleClear}
          disabled={value.length === 0}
        >
          <RotateCcw className="mr-1 h-4 w-4" />
          Limpar
        </Button>
      </div>

      {/* Dialog: Adicionar Individual */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Adicionar Compatibilidade</DialogTitle>
            <DialogDescription>
              Informe os dados do veículo compatível com esta peça.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="compat-brand">Marca *</Label>
              <Input
                id="compat-brand"
                placeholder="Ex: Honda, Fiat, Volkswagen"
                value={addBrand}
                onChange={(e) => setAddBrand(e.target.value)}
                list="compat-brands-list"
              />
              <datalist id="compat-brands-list">
                {BRANDS.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </div>

            <div className="space-y-2">
              <Label htmlFor="compat-model">Modelo *</Label>
              <Input
                id="compat-model"
                placeholder="Ex: Civic, Palio, Golf"
                value={addModel}
                onChange={(e) => setAddModel(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="compat-year-from">Ano Inicial</Label>
                <Input
                  id="compat-year-from"
                  type="number"
                  placeholder="2015"
                  min={1950}
                  max={2040}
                  value={addYearFrom}
                  onChange={(e) => setAddYearFrom(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="compat-year-to">Ano Final</Label>
                <Input
                  id="compat-year-to"
                  type="number"
                  placeholder="2023"
                  min={1950}
                  max={2040}
                  value={addYearTo}
                  onChange={(e) => setAddYearTo(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="compat-version">Versão</Label>
              <Input
                id="compat-version"
                placeholder="Ex: EXL, LX, Sport"
                value={addVersion}
                onChange={(e) => setAddVersion(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAddDialogOpen(false)}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={handleAdd}
              disabled={!addBrand.trim() || !addModel.trim()}
            >
              <Plus className="mr-1 h-4 w-4" />
              Adicionar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: Adicionar em Massa */}
      <Dialog open={batchDialogOpen} onOpenChange={setBatchDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Adicionar em Massa</DialogTitle>
            <DialogDescription>
              Cole os dados separados por ponto-e-vírgula ou tab, uma
              compatibilidade por linha.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground space-y-1">
              <p className="font-medium">Formato esperado:</p>
              <p>Marca; Modelo; AnoInicial; AnoFinal; Versão</p>
              <Separator className="my-2" />
              <p className="font-medium">Exemplo:</p>
              <pre className="whitespace-pre-wrap text-foreground/70">
                {`Honda; Civic; 2016; 2021; EXL
Honda; Civic; 2016; 2021; LX
Fiat; Palio; 2012; 2017;
Toyota; Corolla; 2020; 2024; XEi`}
              </pre>
            </div>

            <Textarea
              placeholder="Cole aqui os dados..."
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              className="min-h-32 font-mono text-sm"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setBatchDialogOpen(false)}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={handleBatchAdd}
              disabled={!batchText.trim()}
            >
              <ListPlus className="mr-1 h-4 w-4" />
              Adicionar Todos
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
