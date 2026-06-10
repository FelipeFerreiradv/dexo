"use client";

/**
 * Importação de produtos a partir do XML de uma NF-e de compra.
 *
 * Fluxo: escolhe o XML → backend (`POST /products/nfe/parse`) devolve os itens
 * normalizados → 1 produto abre o modal direto; vários abrem uma lista para
 * cadastrar um de cada vez. Reaproveita o MESMO `CreateProductDialog` (instância
 * controlada e pré-preenchida), então o fluxo de criação/anúncio é o de sempre.
 *
 * Fica ATRÁS da flag `NEXT_PUBLIC_NFE_IMPORT_ENABLED` (ver products-list.tsx).
 */

import { useRef, useState } from "react";
import { Check, FileText, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getApiBaseUrl } from "@/lib/api";
import { CreateProductDialog } from "./create-product-dialog";
import {
  DEFAULT_NFE_MARKUP,
  computeSuggestedPrice,
  nfeItemToInitialValues,
} from "../lib/nfe-import-mapping";
import type {
  NfeParsedItem,
  NfeParsedResult,
} from "../../fiscal/nfe-import/nfe-import.types";

type ToastFn = (
  message: string,
  type: "success" | "error" | "warning",
) => void;

interface ImportNfeXmlProps {
  email?: string | null;
  onProductCreated: () => void;
  onToast: ToastFn;
}

const formatBRL = (value: number): string =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);

export function ImportNfeXml({
  email,
  onProductCreated,
  onToast,
}: ImportNfeXmlProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<NfeParsedItem[]>([]);
  const [meta, setMeta] = useState<NfeParsedResult["meta"] | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [activeItem, setActiveItem] = useState<NfeParsedItem | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [createdKeys, setCreatedKeys] = useState<Set<string>>(new Set());

  const resetInput = () => {
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file, file.name);
      const resp = await fetch(`${getApiBaseUrl()}/products/nfe/parse`, {
        method: "POST",
        headers: { email: email || "" },
        body: formData,
      });
      const json = await resp.json();
      if (!resp.ok) {
        throw new Error(
          json?.error || json?.message || "Não foi possível ler o XML da NF-e",
        );
      }
      const result = json as NfeParsedResult;
      if (!result.items || result.items.length === 0) {
        throw new Error("A NF-e não contém itens para importar.");
      }
      setItems(result.items);
      setMeta(result.meta);
      setCreatedKeys(new Set());
      if (result.items.length === 1) {
        // Caso comum: 1 produto → abre o modal direto, sem fricção.
        setActiveItem(result.items[0]);
        setListOpen(false);
        setModalOpen(true);
      } else {
        setListOpen(true);
      }
    } catch (err) {
      onToast(
        err instanceof Error ? err.message : "Erro ao importar a NF-e",
        "error",
      );
    } finally {
      setLoading(false);
      resetInput();
    }
  };

  const openItem = (item: NfeParsedItem) => {
    setActiveItem(item);
    setModalOpen(true);
  };

  const handleModalOpenChange = (open: boolean) => {
    setModalOpen(open);
    if (!open) {
      setActiveItem(null);
      // 1 produto: ao fechar, encerra o fluxo. Vários: volta para a lista.
      if (items.length <= 1) {
        setItems([]);
        setMeta(null);
      }
    }
  };

  const handleProductCreated = () => {
    onProductCreated();
    if (activeItem) {
      const key = activeItem.groupKey;
      setCreatedKeys((prev) => new Set(prev).add(key));
    }
    // O modal se fecha sozinho (handleClose → onOpenChange(false)).
  };

  const allCreated =
    items.length > 0 && items.every((i) => createdKeys.has(i.groupKey));

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".xml,text/xml,application/xml"
        className="hidden"
        onChange={handleFile}
      />
      <Button
        variant="outline"
        onClick={() => fileInputRef.current?.click()}
        disabled={loading}
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <FileText className="size-4" />
        )}
        Importar XML da NFe
      </Button>

      {/* Lista de itens (vários produtos): cadastrar um de cada vez. */}
      <Dialog open={listOpen} onOpenChange={setListOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Itens da NF-e{meta?.numero ? ` nº ${meta.numero}` : ""}
            </DialogTitle>
            <DialogDescription>
              {meta?.emitName ? `${meta.emitName} · ` : ""}
              {items.length} produto(s) distinto(s). Cadastre um de cada vez —
              cada item abre o modal pré-preenchido. Não esqueça de adicionar a
              imagem.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {items.map((item) => {
              const created = createdKeys.has(item.groupKey);
              const suggested = computeSuggestedPrice(
                item.costPrice,
                DEFAULT_NFE_MARKUP,
              );
              return (
                <div
                  key={item.groupKey}
                  className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {item.fullName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {item.quantity} {item.unit || "un"} · custo{" "}
                      {formatBRL(item.costPrice)} · sugerido{" "}
                      {formatBRL(suggested)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={created ? "ghost" : "default"}
                    onClick={() => openItem(item)}
                    disabled={created}
                  >
                    {created ? (
                      <>
                        <Check className="size-4" /> Cadastrado
                      </>
                    ) : (
                      "Cadastrar"
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setListOpen(false)}>
              {allCreated ? "Concluir" : "Fechar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal de criação reaproveitado, pré-preenchido pela NF-e. */}
      <CreateProductDialog
        open={modalOpen}
        onOpenChange={handleModalOpenChange}
        initialValues={activeItem ? nfeItemToInitialValues(activeItem) : undefined}
        source="nfe"
        hideTrigger
        onProductCreated={handleProductCreated}
        onToast={onToast}
      />
    </>
  );
}
