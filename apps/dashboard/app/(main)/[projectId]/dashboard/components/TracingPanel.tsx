"use client";

/** Tracing panel showing request and task execution traces. */
import { useState } from "react";
import { ChevronRight, ChevronDown, GitBranch, Clock, ArrowRight } from "lucide-react";
import { Section } from "@/app/components/Section";
import { Badge } from "@/app/components/ui/badge";

interface TraceSpan {
    id: string;
    name: string;
    duration: string;
    status: "success" | "error" | "pending";
    children?: TraceSpan[];
}

const SAMPLE_TRACES: TraceSpan[] = [
    {
        id: "1",
        name: "POST /api/agents/run",
        duration: "1.2s",
        status: "success",
        children: [
            {
                id: "1-1",
                name: "Agent: DataProcessor",
                duration: "800ms",
                status: "success",
                children: [
                    { id: "1-1-1", name: "Tool: fetch_data", duration: "320ms", status: "success" },
                    { id: "1-1-2", name: "Subagent: DataValidator", duration: "280ms", status: "success" },
                    { id: "1-1-3", name: "Tool: transform_output", duration: "120ms", status: "success" },
                ],
            },
            {
                id: "1-2",
                name: "Agent: EmailHandler",
                duration: "400ms",
                status: "success",
                children: [
                    { id: "1-2-1", name: "Tool: send_email", duration: "350ms", status: "success" },
                ],
            },
        ],
    },
    {
        id: "2",
        name: "POST /api/webhooks/delivery",
        duration: "2.1s",
        status: "error",
        children: [
            { id: "2-1", name: "Webhook: payment.completed", duration: "2.1s", status: "error" },
        ],
    },
    {
        id: "3",
        name: "GET /api/agents/status",
        duration: "45ms",
        status: "success",
        children: [],
    },
];

function TraceSpanRow({ span, depth = 0 }: { span: TraceSpan; depth?: number }) {
    const [expanded, setExpanded] = useState(true);
    const hasChildren = span.children && span.children.length > 0;

    const badgeVariant =
        span.status === "success"
            ? "success" as const
            : span.status === "error"
            ? "destructive" as const
            : "secondary" as const;

    return (
        <>
            <div
                className="flex items-center gap-2 px-4 py-2.5 hover:bg-accent/50 cursor-pointer"
                style={{ paddingLeft: `${depth * 20 + 16}px` }}
                onClick={() => hasChildren && setExpanded(!expanded)}
            >
                {hasChildren ? (
                    expanded ? (
                        <ChevronDown className="size-4 text-muted-foreground shrink-0" />
                    ) : (
                        <ChevronRight className="size-4 text-muted-foreground shrink-0" />
                    )
                ) : (
                    <ArrowRight className="size-3 text-muted-foreground shrink-0" />
                )}
                <GitBranch className="size-3.5 text-muted-foreground shrink-0" />
                <span className="flex-1 text-sm text-foreground truncate">{span.name}</span>
                <div className="flex items-center gap-1.5">
                    <Badge variant={badgeVariant} className="text-xs">
                        {span.status}
                    </Badge>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="size-3" />
                        {span.duration}
                    </div>
                </div>
            </div>
            {expanded && hasChildren && (
                span.children!.map((child) => (
                    <TraceSpanRow key={child.id} span={child} depth={depth + 1} />
                ))
            )}
        </>
    );
}

export function TracingPanel() {
    return (
        <div className="grid gap-8">
            <Section title="Execution Traces" description="Hierarchical view of request and task execution spans.">
                <div className="rounded-lg border border-border bg-card">
                    {SAMPLE_TRACES.map((trace) => (
                        <TraceSpanRow key={trace.id} span={trace} />
                    ))}
                </div>
            </Section>
        </div>
    );
}
