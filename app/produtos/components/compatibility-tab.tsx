"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import {
  Search,
  Plus,
  Trash2,
  AlertTriangle,
  Loader2,
  ListPlus,
  RotateCcw,
  HelpCircle,
  ChevronsUpDown,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  getVehicleBrands,
  getModelsForBrand,
  getYearsForModel,
  getVersionsForModel,
} from "../../lib/vehicle-catalog";

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

// ---- Helpers para chave composta marca+modelo ----

function makeModelKey(brand: string, model: string): string {
  return `${brand}|||${model}`;
}

function parseModelKey(key: string): { brand: string; model: string } {
  const idx = key.indexOf("|||");
  if (idx === -1) return { brand: "", model: key };
  return { brand: key.slice(0, idx), model: key.slice(idx + 3) };
}

// Chave composta para ano+versão vinculado a marca+modelo
function makeYearVersionKey(
  brand: string,
  model: string,
  year: number,
  version: string,
): string {
  return `${brand}|||${model}|||${year}|||${version}`;
}

function parseYearVersionKey(key: string): {
  brand: string;
  model: string;
  year: number | null;
  version: string;
} {
  const parts = key.split("|||");
  return {
    brand: parts[0] || "",
    model: parts[1] || "",
    year: parts[2] ? parseInt(parts[2], 10) : null,
    version: parts[3] || "",
  };
}

// ---- Multi-select reutilizável (pesquisável, com checkmarks) ----

interface MultiSelectOption {
  value: string;
  label: string;
  group?: string;
}

interface MultiSearchableSelectProps {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  showSelectAll?: boolean;
}

function MultiSearchableSelect({
  options,
  selected,
  onChange,
  placeholder,
  searchPlaceholder = "Pesquisar...",
  emptyMessage = "Nenhuma opção encontrada.",
  disabled = false,
  showSelectAll = false,
}: MultiSearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState("");

  useEffect(() => {
    if (!open) setInputValue("");
  }, [open]);

  // Set para lookups O(1) em vez de O(n) com .includes()
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Map para resolução O(1) de value→label em vez de O(n) com .find()
  const optionLabelMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of options) m.set(o.value, o.label);
    return m;
  }, [options]);

  const filteredOptions = useMemo(() => {
    if (!inputValue.trim()) return options;
    const q = inputValue.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, inputValue]);

  // Agrupar opções por grupo quando existir
  const grouped = useMemo(() => {
    const hasGroups = filteredOptions.some((o) => o.group);
    if (!hasGroups) return null;
    const groups = new Map<string, MultiSelectOption[]>();
    for (const opt of filteredOptions) {
      const g = opt.group || "";
      const arr = groups.get(g) || [];
      arr.push(opt);
      groups.set(g, arr);
    }
    return groups;
  }, [filteredOptions]);

  const toggle = useCallback(
    (val: string) => {
      onChange(
        selectedSet.has(val)
          ? selected.filter((v) => v !== val)
          : [...selected, val],
      );
    },
    [selected, selectedSet, onChange],
  );

  const allFilteredValues = useMemo(
    () => filteredOptions.map((o) => o.value),
    [filteredOptions],
  );
  const allSelected =
    filteredOptions.length > 0 &&
    filteredOptions.every((o) => selectedSet.has(o.value));

  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      const removeSet = new Set(allFilteredValues);
      onChange(selected.filter((v) => !removeSet.has(v)));
    } else {
      const merged = new Set([...selected, ...allFilteredValues]);
      onChange([...merged]);
    }
  }, [allSelected, selected, allFilteredValues, onChange]);

  const selectedLabels = useMemo(() => {
    return selected.map((v) => optionLabelMap.get(v) || v);
  }, [selected, optionLabelMap]);

  const renderOption = (opt: MultiSelectOption) => (
    <CommandItem
      key={opt.value}
      value={opt.value}
      onSelect={() => toggle(opt.value)}
    >
      <Check
        className={cn(
          "mr-2 h-4 w-4",
          selectedSet.has(opt.value) ? "opacity-100" : "opacity-0",
        )}
      />
      {opt.label}
    </CommandItem>
  );

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal min-h-9 h-auto"
          disabled={disabled}
          type="button"
        >
          {selected.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {selectedLabels.slice(0, 3).map((label, i) => (
                <span
                  key={selected[i]}
                  className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium"
                >
                  {label}
                </span>
              ))}
              {selectedLabels.length > 3 && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  +{selectedLabels.length - 3}
                </span>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={searchPlaceholder}
            value={inputValue}
            onValueChange={setInputValue}
          />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {showSelectAll && filteredOptions.length > 0 && (
              <CommandGroup>
                <CommandItem onSelect={handleSelectAll}>
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      allSelected ? "opacity-100" : "opacity-0",
                    )}
                  />
                  Selecionar Todos
                </CommandItem>
              </CommandGroup>
            )}
            {grouped ? (
              Array.from(grouped.entries()).map(([group, opts]) => (
                <CommandGroup key={group} heading={group}>
                  {opts.map(renderOption)}
                </CommandGroup>
              ))
            ) : (
              <CommandGroup>{filteredOptions.map(renderOption)}</CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ---- Componente principal ----

export function CompatibilityTab({
  value,
  onChange,
  isLoading,
}: CompatibilityTabProps) {
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);

  // Form state para adicionar (multi-select cascata)
  const [addBrands, setAddBrands] = useState<string[]>([]);
  const [addModels, setAddModels] = useState<string[]>([]); // chave "brand|||model"
  const [addYearVersions, setAddYearVersions] = useState<string[]>([]); // chave "brand|||model|||year|||version"

  // Form state para adição em massa
  const [batchText, setBatchText] = useState("");

  // Opções cascata baseadas no catálogo (multi-select)
  const brandOptions = useMemo(
    () => getVehicleBrands().map((b) => ({ value: b, label: b })),
    [],
  );

  const modelGroupedOptions = useMemo(() => {
    const result: MultiSelectOption[] = [];
    for (const brand of addBrands) {
      for (const model of getModelsForBrand(brand)) {
        result.push({
          value: makeModelKey(brand, model),
          label: model,
          group: brand,
        });
      }
    }
    return result;
  }, [addBrands]);

  // Gera opções "ano versão" agrupadas por marca + modelo
  const yearVersionOptions = useMemo(() => {
    const result: MultiSelectOption[] = [];
    for (const key of addModels) {
      const { brand, model } = parseModelKey(key);
      const years = getYearsForModel(brand, model);
      const versions = getVersionsForModel(brand, model);
      const groupLabel = addModels.length > 1 ? `${brand} - ${model}` : model;
      if (versions.length > 0) {
        for (const year of years) {
          for (const ver of versions) {
            result.push({
              value: makeYearVersionKey(brand, model, year, ver),
              label: `${year} ${ver}`,
              group: groupLabel,
            });
          }
        }
      } else {
        for (const year of years) {
          result.push({
            value: makeYearVersionKey(brand, model, year, ""),
            label: String(year),
            group: groupLabel,
          });
        }
      }
    }
    return result;
  }, [addModels]);

  // Resetar campos dependentes quando mudam as marcas
  const handleBrandsChange = useCallback((newBrands: string[]) => {
    setAddBrands(newBrands);
    setAddModels((prev) =>
      prev.filter((key) => {
        const { brand } = parseModelKey(key);
        return newBrands.some((b) => b.toLowerCase() === brand.toLowerCase());
      }),
    );
    setAddYearVersions([]);
  }, []);

  // Resetar campos dependentes quando mudam os modelos
  const handleModelsChange = useCallback((newModels: string[]) => {
    setAddModels(newModels);
    // Remover year+versions de modelos que não estão mais selecionados
    const modelKeys = new Set(newModels);
    setAddYearVersions((prev) =>
      prev.filter((key) => {
        const { brand, model } = parseYearVersionKey(key);
        return modelKeys.has(makeModelKey(brand, model));
      }),
    );
  }, []);

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

  // Adicionar: cada seleção em yearVersions gera uma entrada
  const handleAdd = useCallback(() => {
    if (addBrands.length === 0 || addModels.length === 0) return;
    const entries: CompatibilityEntry[] = [];

    if (addYearVersions.length > 0) {
      for (const key of addYearVersions) {
        const { brand, model, year, version } = parseYearVersionKey(key);
        entries.push({
          _localId: localId(),
          brand,
          model,
          yearFrom: year || null,
          yearTo: year || null,
          version: version || null,
        });
      }
    } else {
      // Sem versão selecionada → uma entrada por modelo (sem ano/versão)
      for (const key of addModels) {
        const { brand, model } = parseModelKey(key);
        entries.push({
          _localId: localId(),
          brand,
          model,
          yearFrom: null,
          yearTo: null,
          version: null,
        });
      }
    }

    onChange([...value, ...entries]);
    setAddBrands([]);
    setAddModels([]);
    setAddYearVersions([]);
    setAddDialogOpen(false);
  }, [addBrands, addModels, addYearVersions, onChange, value]);

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

      {/* Dialog: Adicionar (multi-select cascata) */}
      <Dialog
        open={addDialogOpen}
        onOpenChange={(open) => {
          setAddDialogOpen(open);
          if (!open) {
            setAddBrands([]);
            setAddModels([]);
            setAddYearVersions([]);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Adicionar Compatibilidade</DialogTitle>
            <DialogDescription>
              Selecione marcas, modelos e versões. Cada combinação será
              adicionada como uma entrada separada.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Marcas (multi-select pesquisável) */}
            <div className="space-y-2">
              <Label>Marcas *</Label>
              <MultiSearchableSelect
                options={brandOptions}
                selected={addBrands}
                onChange={handleBrandsChange}
                placeholder="Selecione as marcas..."
                searchPlaceholder="Buscar marca..."
                emptyMessage="Marca não encontrada."
              />
            </div>

            {/* Modelos (multi-select pesquisável, agrupado por marca) */}
            <div className="space-y-2">
              <Label>Modelos *</Label>
              <MultiSearchableSelect
                options={modelGroupedOptions}
                selected={addModels}
                onChange={handleModelsChange}
                placeholder={
                  addBrands.length > 0
                    ? "Selecione os modelos..."
                    : "Selecione as marcas primeiro"
                }
                searchPlaceholder="Buscar modelo..."
                emptyMessage="Nenhum modelo encontrado."
                disabled={addBrands.length === 0}
              />
            </div>

            {/* Versão (ano + versão combinados, com Selecionar Todos) */}
            <div className="space-y-2">
              <Label>Versão *</Label>
              <MultiSearchableSelect
                options={yearVersionOptions}
                selected={addYearVersions}
                onChange={setAddYearVersions}
                placeholder={
                  addModels.length > 0
                    ? "Selecione as versões..."
                    : "Selecione os modelos primeiro"
                }
                searchPlaceholder="Buscar versão..."
                emptyMessage="Nenhuma versão encontrada."
                disabled={addModels.length === 0}
                showSelectAll
              />
            </div>

            {/* Preview: quantas entradas serão criadas */}
            {(addYearVersions.length > 0 || addModels.length > 0) && (
              <div className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                Serão adicionadas{" "}
                <span className="font-medium text-foreground">
                  {addYearVersions.length > 0
                    ? addYearVersions.length
                    : addModels.length}
                </span>{" "}
                compatibilidade(s)
              </div>
            )}
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
              disabled={addBrands.length === 0 || addModels.length === 0}
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
