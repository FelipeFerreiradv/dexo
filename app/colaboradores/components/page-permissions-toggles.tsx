"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PAGE_DEFS } from "@/app/lib/page-access";

export type PagePerms = Record<string, boolean>;

/**
 * Deriva o estado dos toggles a partir do valor salvo. Regra: TUDO ligado por
 * padrão (zero regressão) — só `=== false` desliga. `dashboard` é omitido (é
 * sempre acessível, não pode ser bloqueado).
 */
export function pagePermsFromValue(
  value?: Record<string, boolean> | null,
): PagePerms {
  const out: PagePerms = {};
  for (const p of PAGE_DEFS) {
    if (p.id === "dashboard") continue;
    out[p.id] = value?.[p.id] !== false;
  }
  return out;
}

/**
 * Seção de toggles por página, reutilizada no modal de colaborador (admin) e na
 * área de Superadmin. `value[pageId] === true` → acesso liberado.
 */
export function PagePermissionsToggles({
  value,
  onChange,
  disabled,
}: {
  value: PagePerms;
  onChange: (next: PagePerms) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label>Acesso às páginas</Label>
      <p className="text-xs text-muted-foreground">
        Todas ligadas por padrão. Desligue as páginas que este colaborador não
        deve ver.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {PAGE_DEFS.filter((p) => p.id !== "dashboard").map((p) => (
          <label
            key={p.id}
            className="flex items-center justify-between rounded-md border p-2 text-sm"
          >
            <span>{p.label}</span>
            <Switch
              checked={value[p.id] ?? true}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange({ ...value, [p.id]: checked })
              }
            />
          </label>
        ))}
      </div>
    </div>
  );
}
