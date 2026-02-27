"use client";

/** Settings tab with danger zone for agent deletion. */
import { useState } from "react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/app/components/ui/dialog";
import type { Doc } from "@/convex/_generated/dataModel";

export function SettingsTab({
    agentConfig,
    onDelete,
}: {
    agentConfig: Doc<"agentConfigs"> | null | undefined;
    onDelete: () => Promise<void>;
}) {
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [confirmPhrase, setConfirmPhrase] = useState("");
    const [isDeleting, setIsDeleting] = useState(false);

    const deletePhrase = `delete ${agentConfig?.name ?? ""}`;

    async function handleDelete() {
        if (confirmPhrase !== deletePhrase) return;
        setIsDeleting(true);
        try {
            await onDelete();
            setDeleteOpen(false);
        } finally {
            setIsDeleting(false);
        }
    }

    return (
        <>
            <div className="flex flex-1 flex-col gap-5 p-4">
                {/* Danger zone */}
                <div className="rounded-lg border border-destructive/40 p-4">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <p className="text-xs font-semibold text-destructive">Danger Zone</p>
                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                                Permanently delete this agent and all its data.
                            </p>
                        </div>
                        <Button
                            variant="destructive"
                            size="sm"
                            className="shrink-0 text-xs"
                            onClick={() => {
                                setConfirmPhrase("");
                                setDeleteOpen(true);
                            }}
                        >
                            Delete
                        </Button>
                    </div>
                </div>
            </div>

            {/* Delete confirmation dialog */}
            <Dialog
                open={deleteOpen}
                onOpenChange={(open) => {
                    if (!open) {
                        setDeleteOpen(false);
                        setConfirmPhrase("");
                    }
                }}
            >
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Delete agent</DialogTitle>
                        <DialogDescription asChild>
                            <div className="grid gap-3 text-sm text-muted-foreground">
                                <p>
                                    This will permanently delete{" "}
                                    <span className="font-semibold text-foreground">
                                        {agentConfig?.name}
                                    </span>{" "}
                                    and cannot be undone.
                                </p>
                                <p>
                                    All sessions, messages, tasks, deployments, and connections
                                    for this agent will be deleted forever.
                                </p>
                            </div>
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3 py-2">
                        <Label htmlFor="confirm-delete-agent" className="grid gap-1">
                            <span>Type the following to confirm</span>
                            <span className="font-mono font-medium text-foreground break-all">
                                {deletePhrase}
                            </span>
                        </Label>
                        <Input
                            id="confirm-delete-agent"
                            value={confirmPhrase}
                            onChange={(e) => setConfirmPhrase(e.target.value)}
                            placeholder={deletePhrase}
                            autoFocus
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            variant="ghost"
                            onClick={() => {
                                setDeleteOpen(false);
                                setConfirmPhrase("");
                            }}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            disabled={confirmPhrase !== deletePhrase || isDeleting}
                            onClick={handleDelete}
                        >
                            {isDeleting ? "Deleting…" : "Delete"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
