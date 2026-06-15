"use client";

/** Agent runtime environment variables editor: add/edit masked key-value pairs with per-row show/copy controls and a one-click provider API-key suggestion. */

import { SectionHeader } from "@/app/components/side-panel/SectionHeader";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import type { RuntimeVariable } from "@/app/lib/runtimeVariables";
import { Check, Copy, Eye, EyeOff, KeyRound, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Suggested API-key env var per provider, surfaced as a one-click add. */
const PROVIDER_API_KEY_HINTS: Record<string, { envVar: string; label: string }> = {
  openai: { envVar: "OPENAI_API_KEY", label: "OpenAI" },
  google: { envVar: "GOOGLE_GENERATIVE_AI_API_KEY", label: "Google" },
  anthropic: { envVar: "ANTHROPIC_API_KEY", label: "Anthropic" },
  bedrock: { envVar: "AWS_BEDROCK_API_KEY", label: "Bedrock" },
  minimax: { envVar: "MINIMAX_API_KEY", label: "MiniMax" },
};

/** Drop empty keys and collapse duplicates (last value wins), preserving order. */
function normalizeVariables(entries: RuntimeVariable[]): RuntimeVariable[] {
  const deduped = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) {
      continue;
    }
    deduped.set(key, entry.value);
  }

  return Array.from(deduped, ([key, value]) => ({ key: key, value: value }));
}

export function VariablesTab({
  runtimeVariables,
  isSaving,
  onSave,
  provider,
}: {
  runtimeVariables: RuntimeVariable[];
  isSaving: boolean;
  onSave: (next: RuntimeVariable[]) => Promise<void>;
  provider?: string;
}) {
  const providerHint = provider ? PROVIDER_API_KEY_HINTS[provider] : undefined;
  const [variables, setVariables] = useState<RuntimeVariable[]>(runtimeVariables);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [visibleRows, setVisibleRows] = useState<Set<number>>(new Set());
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Count occurrences of each key (upper-cased) so duplicates highlight per row.
  const keyCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const variable of variables) {
      const key = variable.key.trim().toUpperCase();
      if (!key) {
        continue;
      }
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return counts;
  }, [variables]);

  const hasChanges = useMemo(
    () =>
      JSON.stringify(normalizeVariables(variables)) !==
      JSON.stringify(normalizeVariables(runtimeVariables)),
    [variables, runtimeVariables],
  );

  const providerKeyPresent = providerHint
    ? variables.some((variable) => variable.key.trim() === providerHint.envVar)
    : false;

  /** Validation message for a single key, or null when the row is fine. */
  function rowError(key: string): string | null {
    const trimmed = key.trim();
    if (!trimmed) {
      return null;
    }
    if (!KEY_PATTERN.test(trimmed)) {
      return "Use letters, numbers, and underscores; cannot start with a number.";
    }
    if ((keyCounts.get(trimmed.toUpperCase()) ?? 0) > 1) {
      return "Duplicate key.";
    }

    return null;
  }

  const hasValidationError = variables.some(
    (variable) => rowError(variable.key) !== null,
  );

  function markDirty() {
    setSaveError(null);
    setSaved(false);
  }

  function updateRow(index: number, patch: Partial<RuntimeVariable>) {
    setVariables((prev) =>
      prev.map((variable, i) => (i === index ? { ...variable, ...patch } : variable)),
    );
    markDirty();
  }

  function addRow(key: string = "", value: string = "") {
    setVariables((prev) => [...prev, { key: key, value: value }]);
    markDirty();
  }

  function removeRow(index: number) {
    setVariables((prev) => prev.filter((_, i) => i !== index));
    setVisibleRows((prev) => {
      const next = new Set<number>();
      for (const row of prev) {
        if (row < index) {
          next.add(row);
        } else if (row > index) {
          next.add(row - 1);
        }
      }

      return next;
    });
    markDirty();
  }

  function toggleVisible(index: number) {
    setVisibleRows((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }

      return next;
    });
  }

  function handleCopy(value: string, field: string) {
    if (!value) {
      return;
    }

    navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }

  async function handleSave() {
    if (hasValidationError) {
      setSaveError("Fix the highlighted keys before saving.");

      return;
    }

    setSaveError(null);
    await onSave(normalizeVariables(variables));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-hidden p-4">
      <p className="text-xs text-muted-foreground">
        Runtime environment variables for this agent. Saved values are hidden
        after reload — leave a value blank to keep it unchanged.
      </p>

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between">
          <SectionHeader>Variables</SectionHeader>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 cursor-pointer text-[11px]"
            onClick={() => addRow()}
          >
            <Plus className="size-3.5" />
            Add
          </Button>
        </div>

        {/* One-click add for the selected provider's API key when it is missing. */}
        {providerHint && !providerKeyPresent && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-fit cursor-pointer gap-1.5 text-[11px] text-muted-foreground"
            onClick={() => addRow(providerHint.envVar)}
          >
            <KeyRound className="size-3.5" />
            Add {providerHint.label} key&nbsp;
            <span className="font-mono">{providerHint.envVar}</span>
          </Button>
        )}

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {variables.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              No runtime variables set. The service still loads values from{" "}
              <span className="font-mono">.env</span>.
            </p>
          ) : (
            variables.map((variable, index) => {
              const error = rowError(variable.key);
              const visible = visibleRows.has(index);
              const copyField = `value-${index}`;

              return (
                <div
                  key={index}
                  className="rounded-md border border-border/60 bg-card/40 p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <Input
                      value={variable.key}
                      placeholder="KEY_NAME"
                      aria-invalid={error !== null}
                      onChange={(event) =>
                        updateRow(index, { key: event.target.value })
                      }
                      className="h-8 flex-1 font-mono text-xs aria-invalid:border-destructive"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0 cursor-pointer text-muted-foreground"
                      onClick={() => removeRow(index)}
                      aria-label="Remove variable"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>

                  <div className="mt-1.5 flex items-center gap-1">
                    <Input
                      type={visible ? "text" : "password"}
                      value={variable.value}
                      placeholder="value"
                      onChange={(event) =>
                        updateRow(index, { value: event.target.value })
                      }
                      className="h-8 flex-1 text-xs"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0 cursor-pointer text-muted-foreground"
                      onClick={() => toggleVisible(index)}
                      aria-label={visible ? "Hide value" : "Show value"}
                    >
                      {visible ? (
                        <EyeOff className="size-3.5" />
                      ) : (
                        <Eye className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className={
                        variable.value
                          ? "shrink-0 cursor-pointer text-muted-foreground"
                          : "shrink-0 cursor-not-allowed text-muted-foreground"
                      }
                      onClick={() => handleCopy(variable.value, copyField)}
                      disabled={!variable.value}
                      aria-label="Copy value"
                    >
                      {copiedField === copyField ? (
                        <Check className="size-3.5" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                    </Button>
                  </div>

                  {error && (
                    <p className="mt-1 text-[11px] text-destructive">{error}</p>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {saveError && <p className="text-xs text-destructive">{saveError}</p>}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={
            !hasChanges || isSaving || hasValidationError
              ? "h-8 cursor-not-allowed text-xs"
              : "h-8 cursor-pointer text-xs"
          }
          disabled={!hasChanges || isSaving || hasValidationError}
          onClick={handleSave}
        >
          {isSaving ? "Saving…" : "Save Variables"}
        </Button>
        {saved && (
          <span className="flex items-center gap-1 text-xs text-emerald-500">
            <Check className="size-3" /> Saved
          </span>
        )}
      </div>
    </div>
  );
}
