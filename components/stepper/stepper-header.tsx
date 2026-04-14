"use client";

import type { LucideIcon } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export interface StepperStep {
  id: number;
  title: string;
  description: string;
  icon: LucideIcon;
}

interface StepperHeaderProps {
  steps: StepperStep[];
  currentStep: number;
  onGoToStep?: (step: number) => void;
}

export function StepperHeader({
  steps,
  currentStep,
  onGoToStep,
}: StepperHeaderProps) {
  const totalSteps = steps.length;
  const progressPercentage = (currentStep / totalSteps) * 100;

  return (
    <div className="space-y-4">
      <Progress value={progressPercentage} className="h-2" />

      <div className="flex justify-between gap-1">
        {steps.map((step) => {
          const Icon = step.icon;
          const isActive = step.id === currentStep;
          const isCompleted = step.id < currentStep;
          const clickable = !!onGoToStep && step.id < currentStep;

          return (
            <button
              type="button"
              key={step.id}
              onClick={() => clickable && onGoToStep?.(step.id)}
              disabled={!clickable}
              className={cn(
                "flex flex-1 flex-col items-center gap-1 rounded-lg px-2 py-2 text-[11px] transition-all",
                isActive && "bg-primary text-primary-foreground shadow",
                isCompleted &&
                  "text-primary hover:bg-primary/10 cursor-pointer",
                !isActive && !isCompleted && "text-muted-foreground",
              )}
              aria-current={isActive ? "step" : undefined}
            >
              <Icon className="h-4 w-4" />
              <span className="font-medium truncate max-w-full">
                {step.title}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
