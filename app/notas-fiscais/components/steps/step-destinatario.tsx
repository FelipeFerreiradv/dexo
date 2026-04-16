"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Control,
  Controller,
  FieldErrors,
  UseFormSetValue,
} from "react-hook-form";
import { Search, User, Building2, Globe, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { getApiBaseUrl } from "@/lib/api";
import type { NfeDraftFormData } from "../../lib/nfe-form-schema";
import type { CustomerLookup } from "@/app/interfaces/nfe.interface";

interface Props {
  control: Control<NfeDraftFormData>;
  errors: FieldErrors<NfeDraftFormData>;
  setValue: UseFormSetValue<NfeDraftFormData>;
  email: string;
}

const UF_OPTIONS = [
  "AC","AL","AM","AP","BA","CE","DF","ES","GO","MA",
  "MG","MS","MT","PA","PB","PE","PI","PR","RJ","RN",
  "RO","RR","RS","SC","SE","SP","TO",
];

export function StepDestinatario({ control, errors, setValue, email }: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<CustomerLookup[]>([]);
  const [showResults, setShowResults] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const searchCustomers = useCallback(
    async (q: string) => {
      if (q.trim().length < 2) {
        setResults([]);
        return;
      }
      setSearching(true);
      try {
        const res = await fetch(
          `${getApiBaseUrl()}/fiscal/lookup/customers?q=${encodeURIComponent(q)}`,
          { headers: { email } },
        );
        if (res.ok) {
          const data = await res.json();
          setResults(data.results ?? []);
        }
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    },
    [email],
  );

  const handleSearchInput = (val: string) => {
    setSearchQuery(val);
    setShowResults(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => searchCustomers(val), 400);
  };

  const selectCustomer = (c: CustomerLookup) => {
    const isPj = !!c.deliveryCnpj;
    setValue("customerId", c.id);
    setValue("destinatario.tipoPessoa", isPj ? "PJ" : "PF");
    setValue("destinatario.cpfCnpj", isPj ? c.deliveryCnpj! : c.cpf ?? "");
    setValue(
      "destinatario.nome",
      isPj ? (c.deliveryCorporateName ?? c.name) : c.name,
    );
    setValue("destinatario.email", c.email);
    setValue("destinatario.telefone", c.phone ?? c.mobile);
    setValue("destinatario.cep", c.cep);
    setValue("destinatario.logradouro", c.street);
    setValue("destinatario.numero", c.number);
    setValue("destinatario.complemento", c.complement);
    setValue("destinatario.bairro", c.neighborhood);
    setValue("destinatario.municipio", c.city);
    setValue("destinatario.codMunicipio", c.ibge);
    setValue("destinatario.uf", c.state);
    setShowResults(false);
    setSearchQuery(c.name);
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setShowResults(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const destErrors = errors.destinatario as any;

  return (
    <div className="space-y-6">
      {/* Customer search */}
      <div ref={wrapperRef} className="relative">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Buscar cliente existente
        </h3>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => handleSearchInput(e.target.value)}
            onFocus={() => results.length > 0 && setShowResults(true)}
            placeholder="Buscar por nome, CPF ou CNPJ..."
            className="pl-9"
          />
          {searching && (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>

        {showResults && results.length > 0 && (
          <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-popover shadow-lg max-h-60 overflow-auto">
            {results.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => selectCustomer(c)}
                className="w-full px-3 py-2 text-left text-sm hover:bg-accent/50 flex items-center gap-2"
              >
                {c.deliveryCnpj ? (
                  <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <User className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <span className="font-medium truncate">{c.name}</span>
                <span className="text-muted-foreground text-xs ml-auto shrink-0">
                  {c.deliveryCnpj ?? c.cpf ?? ""}
                </span>
              </button>
            ))}
          </div>
        )}

        {showResults && searchQuery.length >= 2 && !searching && results.length === 0 && (
          <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-popover shadow-lg px-3 py-3 text-sm text-muted-foreground">
            Nenhum cliente encontrado
          </div>
        )}
      </div>

      <div className="border-t border-border/60 pt-4">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Dados do destinatário
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">Tipo *</label>
            <Controller
              control={control}
              name="destinatario.tipoPessoa"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PF">Pessoa Física</SelectItem>
                    <SelectItem value="PJ">Pessoa Jurídica</SelectItem>
                    <SelectItem value="EXTERIOR">Exterior</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">CPF/CNPJ *</label>
            <Controller
              control={control}
              name="destinatario.cpfCnpj"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  placeholder="Documento do destinatário"
                />
              )}
            />
            {destErrors?.cpfCnpj && (
              <p className="text-xs text-destructive">
                {destErrors.cpfCnpj.message}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">IE</label>
            <Controller
              control={control}
              name="destinatario.inscricaoEstadual"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  placeholder="Inscrição estadual ou ISENTO"
                />
              )}
            />
          </div>

          <div className="md:col-span-2 lg:col-span-3 space-y-1">
            <label className="text-sm font-medium">
              Nome / Razão social *
            </label>
            <Controller
              control={control}
              name="destinatario.nome"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  placeholder="Nome completo ou razão social"
                />
              )}
            />
            {destErrors?.nome && (
              <p className="text-xs text-destructive">
                {destErrors.nome.message}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">E-mail</label>
            <Controller
              control={control}
              name="destinatario.email"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  type="email"
                />
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Telefone</label>
            <Controller
              control={control}
              name="destinatario.telefone"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                />
              )}
            />
          </div>
        </div>
      </div>

      {/* Endereço do destinatário */}
      <div className="border-t border-border/60 pt-4">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Endereço do destinatário
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">CEP</label>
            <Controller
              control={control}
              name="destinatario.cep"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  placeholder="00000-000"
                />
              )}
            />
          </div>

          <div className="md:col-span-2 space-y-1">
            <label className="text-sm font-medium">Logradouro</label>
            <Controller
              control={control}
              name="destinatario.logradouro"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                />
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Número</label>
            <Controller
              control={control}
              name="destinatario.numero"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                />
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Complemento</label>
            <Controller
              control={control}
              name="destinatario.complemento"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                />
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Bairro</label>
            <Controller
              control={control}
              name="destinatario.bairro"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                />
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Município</label>
            <Controller
              control={control}
              name="destinatario.municipio"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                />
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Cód. Município (IBGE)</label>
            <Controller
              control={control}
              name="destinatario.codMunicipio"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  placeholder="7 dígitos"
                />
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">UF</label>
            <Controller
              control={control}
              name="destinatario.uf"
              render={({ field }) => (
                <Select
                  value={field.value ?? ""}
                  onValueChange={(v) => field.onChange(v || null)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="UF" />
                  </SelectTrigger>
                  <SelectContent>
                    {UF_OPTIONS.map((uf) => (
                      <SelectItem key={uf} value={uf}>
                        {uf}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
