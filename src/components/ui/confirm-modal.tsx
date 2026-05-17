"use client";

import { useState } from "react";
import { Modal } from "./modal";
import { cn } from "@/lib/utils";

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** If true, applies destructive (red) styling to the confirm button. */
  destructive?: boolean;
  /** Async confirm handler; modal stays open + shows loading state until it resolves. */
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

/**
 * Two-step confirmation modal. Click "Delete" → loading state → onConfirm
 * runs → modal closes (or stays open on error if onConfirm throws and the
 * caller manages error display separately).
 */
export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const [running, setRunning] = useState(false);

  const handleConfirm = async () => {
    setRunning(true);
    try {
      await onConfirm();
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal open={open} onClose={running ? () => {} : onCancel} title={title} maxWidth="max-w-md">
      <div className="text-[14px] leading-relaxed text-text-secondary">{message}</div>
      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={running}
          className="rounded-md border border-border px-4 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:opacity-60"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={running}
          className={cn(
            "rounded-md px-4 py-2 text-[13px] font-medium transition-all",
            destructive
              ? "bg-[color:var(--status-error)] text-white hover:bg-[color:var(--status-error)]/90"
              : "bg-accent text-text-inverted hover:bg-accent-hover",
            running && "opacity-60"
          )}
        >
          {running ? "Working…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
