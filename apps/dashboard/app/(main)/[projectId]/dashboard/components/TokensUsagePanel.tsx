"use client";

/** Tokens usage panel showing token consumption and activity analysis. */
import { BarChart3, Hash, TrendingUp } from "lucide-react";
import { Section } from "@/app/components/Section";

const USAGE_STATS = [
    { label: "Total Tokens (Today)", value: "48,293", icon: Hash, change: "+12%", up: true },
    { label: "Input Tokens", value: "32,104", icon: BarChart3, change: "+8%", up: true },
    { label: "Output Tokens", value: "16,189", icon: BarChart3, change: "-3%", up: false },
    { label: "Avg per Request", value: "1,207", icon: TrendingUp, change: "+5%", up: true },
];

const HOURLY_USAGE = [
    { hour: "00:00", tokens: 1200 },
    { hour: "02:00", tokens: 800 },
    { hour: "04:00", tokens: 400 },
    { hour: "06:00", tokens: 2100 },
    { hour: "08:00", tokens: 4500 },
    { hour: "10:00", tokens: 6200 },
    { hour: "12:00", tokens: 5800 },
    { hour: "14:00", tokens: 7100 },
    { hour: "16:00", tokens: 5400 },
    { hour: "18:00", tokens: 3200 },
    { hour: "20:00", tokens: 2800 },
    { hour: "22:00", tokens: 1500 },
];

const TOP_AGENTS = [
    { name: "DataProcessor", tokens: "18,432", percentage: 38 },
    { name: "EmailHandler", tokens: "12,891", percentage: 27 },
    { name: "CodeReviewer", tokens: "8,234", percentage: 17 },
    { name: "DataValidator", tokens: "5,102", percentage: 11 },
    { name: "Other", tokens: "3,634", percentage: 7 },
];

export function TokensUsagePanel() {
    const maxTokens = Math.max(...HOURLY_USAGE.map((h) => h.tokens));

    return (
        <div className="grid gap-8">
            <Section title="Usage Overview" description="Token consumption metrics for the current period.">
                <div className="grid grid-cols-2 gap-3">
                    {USAGE_STATS.map((stat) => (
                        <div key={stat.label} className="rounded-lg border border-border bg-card px-4 py-3">
                            <div className="flex items-center gap-2">
                                <stat.icon className="size-4 text-muted-foreground" />
                                <span className="text-xs text-muted-foreground">{stat.label}</span>
                            </div>
                            <div className="mt-2 flex items-end justify-between">
                                <p className="text-2xl font-semibold text-foreground">{stat.value}</p>
                                <span className={`text-xs font-medium ${stat.up ? "text-emerald-500" : "text-red-500"}`}>
                                    {stat.change}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            </Section>

            <Section title="Hourly Usage" description="Token consumption distribution over the last 24 hours.">
                <div className="rounded-lg border border-border bg-card px-4 py-4">
                    <div className="flex items-end gap-1 h-32">
                        {HOURLY_USAGE.map((h) => (
                            <div key={h.hour} className="flex-1 flex flex-col items-center gap-1">
                                <div
                                    className="w-full bg-primary/20 rounded-sm"
                                    style={{ height: `${(h.tokens / maxTokens) * 100}%` }}
                                />
                                <span className="text-[10px] text-muted-foreground">{h.hour.split(":")[0]}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </Section>

            <Section title="Top Agents by Usage" description="Token consumption breakdown by agent.">
                <div className="rounded-lg border border-border bg-card divide-y divide-border">
                    {TOP_AGENTS.map((agent) => (
                        <div key={agent.name} className="flex items-center gap-3 px-4 py-3">
                            <span className="flex-1 text-sm text-foreground">{agent.name}</span>
                            <div className="w-32 h-2 bg-muted rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-primary rounded-full"
                                    style={{ width: `${agent.percentage}%` }}
                                />
                            </div>
                            <span className="text-sm font-mono text-muted-foreground w-16 text-right">{agent.tokens}</span>
                        </div>
                    ))}
                </div>
            </Section>
        </div>
    );
}
