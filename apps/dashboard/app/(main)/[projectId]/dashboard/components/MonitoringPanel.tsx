"use client";

/** Monitoring panel showing system-wide metrics and status. */
import { Activity, Server, Clock, AlertCircle, CheckCircle } from "lucide-react";
import { Section } from "@/app/components/Section";
import { Badge } from "@/app/components/ui/badge";

const SYSTEM_METRICS = [
    { label: "System Status", value: "Operational", icon: CheckCircle, color: "text-emerald-500" },
    { label: "Active Agents", value: "12", icon: Activity, color: "text-blue-500" },
    { label: "Avg Response Time", value: "340ms", icon: Clock, color: "text-amber-500" },
    { label: "Server Load", value: "67%", icon: Server, color: "text-purple-500" },
];

const RECENT_EVENTS = [
    { time: "2 min ago", event: "Agent 'Data Processor' completed task", status: "success" as const },
    { time: "5 min ago", event: "Webhook delivery failed (retry 2/3)", status: "warning" as const },
    { time: "12 min ago", event: "New environment 'staging' deployed", status: "info" as const },
    { time: "18 min ago", event: "Rate limit threshold reached (80%)", status: "warning" as const },
    { time: "25 min ago", event: "Agent 'Email Handler' started execution", status: "info" as const },
    { time: "32 min ago", event: "System health check passed", status: "success" as const },
];

export function MonitoringPanel() {
    return (
        <div className="grid gap-8">
            <Section title="System Overview" description="Current health and performance metrics.">
                <div className="grid grid-cols-2 gap-3">
                    {SYSTEM_METRICS.map((metric) => (
                        <div key={metric.label} className="rounded-lg border border-border bg-card px-4 py-3">
                            <div className="flex items-center gap-2">
                                <metric.icon className={`size-4 ${metric.color}`} />
                                <span className="text-xs text-muted-foreground">{metric.label}</span>
                            </div>
                            <p className="mt-2 text-2xl font-semibold text-foreground">{metric.value}</p>
                        </div>
                    ))}
                </div>
            </Section>

            <Section title="Recent Events" description="Latest system activity and notifications.">
                <div className="rounded-lg border border-border bg-card divide-y divide-border">
                    {RECENT_EVENTS.map((event, i) => (
                        <div key={i} className="flex items-start gap-3 px-4 py-3">
                            {event.status === "success" ? (
                                <CheckCircle className="size-4 text-emerald-500 mt-0.5 shrink-0" />
                            ) : event.status === "warning" ? (
                                <AlertCircle className="size-4 text-amber-500 mt-0.5 shrink-0" />
                            ) : (
                                <Activity className="size-4 text-blue-500 mt-0.5 shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                                <p className="text-sm text-foreground">{event.event}</p>
                                <p className="text-xs text-muted-foreground mt-0.5">{event.time}</p>
                            </div>
                            <Badge
                                variant={event.status === "success" ? "success" : event.status === "warning" ? "warning" : "secondary"}
                                className="text-xs"
                            >
                                {event.status}
                            </Badge>
                        </div>
                    ))}
                </div>
            </Section>
        </div>
    );
}
