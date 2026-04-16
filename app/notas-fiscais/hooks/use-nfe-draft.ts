"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getApiBaseUrl } from "@/lib/api";
import type { NfeDraftFormData } from "../lib/nfe-form-schema";

interface UseNfeDraftOptions {
  email: string;
  draftId: string | null;
  onSaved?: () => void;
}

export function useNfeDraft({ email, draftId, onSaved }: UseNfeDraftOptions) {
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const headers = useCallback(
    () => ({
      "Content-Type": "application/json",
      email,
    }),
    [email],
  );

  const createDraft = useCallback(
    async (orderId?: string | null): Promise<string | null> => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/fiscal/nfe/draft`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ orderId: orderId ?? null }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.draft?.id ?? null;
      } catch {
        return null;
      }
    },
    [headers],
  );

  const loadDraft = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/fiscal/nfe/draft/${id}`, {
          headers: headers(),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.draft ?? null;
      } catch {
        return null;
      }
    },
    [headers],
  );

  const saveDraft = useCallback(
    async (id: string, payload: Partial<NfeDraftFormData>) => {
      if (!id) return;
      setSaving(true);
      try {
        // Map form data to API shape
        const body: Record<string, any> = { ...payload };

        // Map destinatario → destinatarioJson
        if (payload.destinatario) {
          body.destinatarioJson = payload.destinatario;
          delete body.destinatario;
        }

        const res = await fetch(`${getApiBaseUrl()}/fiscal/nfe/draft/${id}`, {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify(body),
        });
        if (res.ok) {
          setLastSavedAt(new Date());
          onSaved?.();
        }
      } catch {
        // silent fail — draft save is best-effort
      } finally {
        setSaving(false);
      }
    },
    [headers, onSaved],
  );

  const debouncedSave = useCallback(
    (id: string, payload: Partial<NfeDraftFormData>) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        saveDraft(id, payload);
      }, 1500);
    },
    [saveDraft],
  );

  const deleteDraft = useCallback(
    async (id: string) => {
      try {
        await fetch(`${getApiBaseUrl()}/fiscal/nfe/draft/${id}`, {
          method: "DELETE",
          headers: headers(),
        });
      } catch {
        // silent
      }
    },
    [headers],
  );

  // Cleanup pending timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return {
    saving,
    lastSavedAt,
    createDraft,
    loadDraft,
    saveDraft,
    debouncedSave,
    deleteDraft,
  };
}
