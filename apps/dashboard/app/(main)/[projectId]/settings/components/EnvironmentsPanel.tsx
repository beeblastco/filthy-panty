"use client";

/** Environments panel: create, duplicate, and delete per-project environments, and manage each one's runtime variables and deploy keys. */
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/app/components/ui/select";
import { useEnvironment } from "@/app/hooks/useEnvironment";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

interface Props {
    /** Project this settings panel belongs to. */
    projectId: Id<"projects">;
}

export function EnvironmentsPanel({ projectId }: Props) {
    const environments = useQuery(api.environment.list, { projectId: projectId }) as
        | Doc<"environments">[]
        | undefined;
    const createEnvironment = useMutation(api.environment.create);
    const removeEnvironment = useMutation(api.environment.remove);
    const { environmentId, setEnvironmentId } = useEnvironment();

    const [showAddEnv, setShowAddEnv] = useState(false);
    const [newEnvName, setNewEnvName] = useState("");
    const [initFrom, setInitFrom] = useState<"empty" | Id<"environments">>("empty");
    const [busy, setBusy] = useState(false);
    const [expandedEnvs, setExpandedEnvs] = useState<Set<string>>(new Set());
    const [deleteTarget, setDeleteTarget] = useState<Doc<"environments"> | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    function toggleEnvExpand(id: string) {
        setExpandedEnvs((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);

            return next;
        });
    }

    async function handleAddEnvironment() {
        if (!newEnvName.trim() || busy) return;
        setBusy(true);
        try {
            await createEnvironment({
                projectId: projectId,
                name: newEnvName.trim(),
                duplicateFromId: initFrom === "empty" ? undefined : initFrom,
            });
            setNewEnvName("");
            setInitFrom("empty");
            setShowAddEnv(false);
        } finally {
            setBusy(false);
        }
    }

    async function handleDeleteEnvironment() {
        if (!deleteTarget) return;
        setIsDeleting(true);
        try {
            const wasActive = deleteTarget._id === environmentId;
            await removeEnvironment({ environmentId: deleteTarget._id });
            // Return to the default environment when the active one was deleted.
            if (wasActive) {
                const fallback = environments?.find((env) => env.isDefault) ?? null;
                setEnvironmentId(fallback ? fallback._id : null);
            }
            setDeleteTarget(null);
        } finally {
            setIsDeleting(false);
        }
    }

    if (environments === undefined) {
        return <p className="text-sm text-muted-foreground">Loading environments…</p>;
    }

    return (
        <div className="grid gap-4">
            {environments.map((env) => (
                <div key={env._id} className="rounded-lg border border-border bg-card">
                    <div className="flex items-center justify-between px-4 py-3">
                        <div className="flex items-center gap-3">
                            <span className="text-sm font-medium text-foreground">{env.name}</span>
                            {env.isDefault && <Badge variant="outline">Default</Badge>}
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="ghost"
                                size="icon-xs"
                                className="cursor-pointer text-muted-foreground hover:text-foreground"
                                onClick={() => toggleEnvExpand(env._id)}
                            >
                                {expandedEnvs.has(env._id) ? (
                                    <ChevronUp className="size-4" />
                                ) : (
                                    <ChevronDown className="size-4" />
                                )}
                            </Button>
                            {!env.isDefault && (
                                <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="cursor-pointer text-muted-foreground transition-colors hover:text-destructive"
                                    onClick={() => setDeleteTarget(env)}
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                            )}
                        </div>
                    </div>
                    {expandedEnvs.has(env._id) && (
                        <div className="grid gap-5 border-t border-border px-4 py-3">
                            <EnvironmentVariables projectId={projectId} environmentId={env._id} />
                        </div>
                    )}
                </div>
            ))}

            {showAddEnv ? (
                <div className="grid gap-2 rounded-lg border border-border bg-card p-3">
                    <Input
                        value={newEnvName}
                        onChange={(e) => setNewEnvName(e.target.value)}
                        placeholder="Environment name (e.g. staging)"
                        autoFocus
                    />
                    <Select value={initFrom} onValueChange={(v) => setInitFrom(v as typeof initFrom)}>
                        <SelectTrigger className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="empty">Empty environment</SelectItem>
                            {environments.map((env) => (
                                <SelectItem key={env._id} value={env._id}>
                                    Duplicate “{env.name}”
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <div className="flex items-center justify-end gap-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="cursor-pointer"
                            onClick={() => {
                                setShowAddEnv(false);
                                setNewEnvName("");
                                setInitFrom("empty");
                            }}
                        >
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            className="cursor-pointer disabled:cursor-not-allowed"
                            disabled={!newEnvName.trim() || busy}
                            onClick={handleAddEnvironment}
                        >
                            {busy ? "Creating…" : "Create"}
                        </Button>
                    </div>
                </div>
            ) : (
                <Button
                    variant="outline"
                    size="sm"
                    className="w-fit cursor-pointer"
                    onClick={() => setShowAddEnv(true)}
                >
                    <Plus className="mr-1 size-4" />
                    Add Environment
                </Button>
            )}

            <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Delete environment?</DialogTitle>
                        <DialogDescription>
                            {deleteTarget
                                ? `This permanently deletes "${deleteTarget.name}" and all of its agents, services, variables, and deploy keys. This cannot be undone.`
                                : ""}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            variant="ghost"
                            className="cursor-pointer"
                            onClick={() => setDeleteTarget(null)}
                            disabled={isDeleting}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            className="cursor-pointer disabled:cursor-not-allowed"
                            onClick={handleDeleteEnvironment}
                            disabled={isDeleting}
                        >
                            {isDeleting ? "Deleting…" : "Delete"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

/** Runtime variable list + add/remove controls for a single environment. */
function EnvironmentVariables({
    projectId,
    environmentId,
}: {
    projectId: Id<"projects">;
    environmentId: Id<"environments">;
}) {
    const variables = useQuery(api.environmentVariables.list, {
        projectId: projectId,
        environmentId: environmentId,
    }) as Doc<"environmentVariables">[] | undefined;
    const setVariable = useMutation(api.environmentVariables.set);
    const removeVariable = useMutation(api.environmentVariables.remove);

    const [adding, setAdding] = useState(false);
    const [key, setKey] = useState("");
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);

    async function handleAdd() {
        if (!key.trim() || busy) return;
        setBusy(true);
        try {
            await setVariable({
                projectId: projectId,
                environmentId: environmentId,
                name: key.trim(),
                value: value,
            });
            setKey("");
            setValue("");
            setAdding(false);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div>
            <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">Variables</p>
            {variables && variables.length === 0 && (
                <p className="mb-2 text-xs text-muted-foreground">No variables yet.</p>
            )}
            <div className="mb-3 grid gap-2">
                {variables?.map((v) => (
                    <div key={v._id} className="flex items-center gap-2">
                        <code className="flex-1 rounded bg-muted px-2 py-1 font-mono text-xs">{v.name}</code>
                        <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                            {v.value ? "••••••••" : <span className="text-muted-foreground">empty</span>}
                        </code>
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            className="cursor-pointer text-muted-foreground hover:text-destructive"
                            onClick={() => removeVariable({ variableId: v._id })}
                        >
                            <Trash2 className="size-3.5" />
                        </Button>
                    </div>
                ))}
            </div>
            {adding ? (
                <div className="flex items-center gap-2">
                    <Input
                        value={key}
                        onChange={(e) => setKey(e.target.value)}
                        placeholder="KEY_NAME"
                        className="flex-1 font-mono text-xs"
                    />
                    <Input
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder="value"
                        className="flex-1 font-mono text-xs"
                    />
                    <Button
                        size="sm"
                        className="cursor-pointer disabled:cursor-not-allowed"
                        disabled={!key.trim() || busy}
                        onClick={handleAdd}
                    >
                        Add
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="cursor-pointer"
                        onClick={() => {
                            setAdding(false);
                            setKey("");
                            setValue("");
                        }}
                    >
                        Cancel
                    </Button>
                </div>
            ) : (
                <Button
                    variant="outline"
                    size="sm"
                    className="cursor-pointer"
                    onClick={() => setAdding(true)}
                >
                    <Plus className="mr-1 size-3.5" />
                    Add Variable
                </Button>
            )}
        </div>
    );
}
