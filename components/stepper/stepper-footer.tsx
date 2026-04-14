"use client";

import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface StepperFooterProps {
  currentStep: number;
  totalSteps: number;
  isSubmitting?: boolean;
  onBack: () => void;
  onNext: () => void;
  onSubmit: () => void;
  submitLabel?: string;
}

export function StepperFooter({
  currentStep,
  totalSteps,
  isSubmitting,
  onBack,
  onNext,
  onSubmit,
  submitLabel = "Salvar",
}: StepperFooterProps) {
  const isLast = currentStep === totalSteps;

  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
      <Button
        type="button"
        variant="outline"
        onClick={onBack}
        disabled={currentStep === 1 || isSubmitting}
      >
        <ChevronLeft className="h-4 w-4" />
        Voltar
      </Button>

      {!isLast && (
        <Button type="button" onClick={onNext} disabled={isSubmitting}>
          Próximo
          <ChevronRight className="h-4 w-4" />
        </Button>
      )}

      {isLast && (
        <Button type="button" onClick={onSubmit} disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitLabel}
        </Button>
      )}
    </div>
  );
}
