"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PAGE_DEFS } from "@/app/lib/page-access";
import { ACTION_DEFS, actionPermissionKey } from "@/app/lib/action-access";

export type PagePerms = Record<string, boolean>;

// Bloco E — permissões de AÇÃO. Flag OFF ⇒ a seção não renderiza E as chaves
// `action:*` não entram no payload: o modal salva exatamente o que salva hoje.
// (Convenção da casa: leitura literal de process.env para o Next inlinar.)
const SALE_CANCEL_ENABLED =
  process.env.NEXT_PUBLIC_SALE_CANCEL_ENABLED === "true";

/**
 * Deriva o estado dos toggles a partir do valor salvo. Regra: TUDO ligado por
 * padrão (zero regressão) — só `=== false` desliga.
 *
 * `dashboard` era omitido aqui e na renderização porque a página não podia ser
 * bloqueada (o redirect das páginas bloqueadas apontava para "/"). Com o
 * redirect indo para a primeira página liberada, ela entra na lista — é o que
 * permite esconder faturamento de colaborador. Colaboradores já cadastrados
 * não mudam de acesso: a chave só passa a existir quando o admin desligar o
 * toggle, e ausente continua significando liberado.
 */
export function pagePermsFromValue(
  value?: Record<string, boolean> | null,
): PagePerms {
  // Preserva o que já está gravado ANTES de aplicar os defaults. Sem isto, o
  // modal (que faz PATCH do objeto inteiro) apagaria silenciosamente qualquer
  // chave que ele não conheça — inclusive as `action:*` — a cada edição de
  // colaborador. Para as chaves de página o resultado é idêntico ao de antes,
  // porque o laço abaixo sobrescreve todas elas.
  const out: PagePerms = { ...(value ?? {}) };
  for (const p of PAGE_DEFS) {
    out[p.id] = value?.[p.id] !== false;
  }
  if (SALE_CANCEL_ENABLED) {
    for (const a of ACTION_DEFS) {
      const key = actionPermissionKey(a.id);
      out[key] = value?.[key] !== false;
    }
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
        deve ver. Ao desligar o Dashboard, ele passa a entrar direto na primeira
        página liberada.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {PAGE_DEFS.map((p) => (
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

      {SALE_CANCEL_ENABLED && (
        <div className="space-y-2 pt-2">
          <Label>Ações permitidas</Label>
          <p className="text-xs text-muted-foreground">
            Ligadas por padrão. Desligue as ações que este colaborador não deve
            executar — o bloqueio vale na API, não só na tela.
          </p>
          <div className="grid grid-cols-1 gap-2">
            {ACTION_DEFS.map((a) => {
              const key = actionPermissionKey(a.id);
              return (
                <label
                  key={a.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm"
                >
                  <span className="flex flex-col">
                    <span>{a.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {a.hint}
                    </span>
                  </span>
                  <Switch
                    checked={value[key] ?? true}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      onChange({ ...value, [key]: checked })
                    }
                  />
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
