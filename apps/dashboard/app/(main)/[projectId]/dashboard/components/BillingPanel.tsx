"use client";

/** Billing panel showing current plan, rate limits, and usage. */
import { AlertTriangle } from "lucide-react";
import { Section } from "@/app/components/Section";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";

const RATE_LIMITS = [
    { label: "Requests per minute", current: 42, limit: 100, unit: "rpm" },
    { label: "Tokens per minute", current: 24500, limit: 50000, unit: "tpm" },
    { label: "Concurrent agents", current: 8, limit: 20, unit: "agents" },
    { label: "Webhook deliveries per hour", current: 180, limit: 500, unit: "/hr" },
];

export function BillingPanel() {
    return (
        <div className="grid gap-8">
            <Section title="Current Plan" description="Your active subscription and included resources.">
                <div className="rounded-lg border border-border bg-card">
                    <div className="flex items-center justify-between border-b border-border px-4 py-3">
                        <div>
                            <p className="text-sm font-medium text-foreground">Professional Tier</p>
                            <p className="text-xs text-muted-foreground">Monthly billing</p>
                        </div>
                        <Badge variant="success">Active</Badge>
                    </div>
                    <div className="flex items-center justify-between border-b border-border px-4 py-3">
                        <span className="text-xs text-muted-foreground">Monthly cost</span>
                        <span className="text-sm font-semibold text-foreground">$49</span>
                    </div>
                    <div className="flex items-center justify-between border-b border-border px-4 py-3">
                        <span className="text-xs text-muted-foreground">Active agents</span>
                        <span className="text-sm text-foreground">12 / 20</span>
                    </div>
                    <div className="flex items-center justify-between px-4 py-3">
                        <span className="text-xs text-muted-foreground">Monthly tokens</span>
                        <span className="text-sm text-foreground">1.2M included</span>
                    </div>
                </div>
                <div className="flex justify-end">
                    <Button size="sm" className="cursor-pointer">
                        Upgrade Plan
                    </Button>
                </div>
            </Section>

            <Section title="Rate Limits" description="Current usage against your plan limits.">
                <div className="grid gap-3">
                    {RATE_LIMITS.map((limit) => {
                        const percentage = (limit.current / limit.limit) * 100;
                        const isWarning = percentage >= 80;
                        return (
                            <div key={limit.label} className="rounded-lg border border-border bg-card px-4 py-3">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-sm text-foreground">{limit.label}</span>
                                    <span className="text-sm font-mono text-muted-foreground">
                                        {limit.current.toLocaleString()} / {limit.limit.toLocaleString()} {limit.unit}
                                    </span>
                                </div>
                                <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                                    <div
                                        className={`h-full rounded-full ${isWarning ? "bg-amber-500" : "bg-primary"}`}
                                        style={{ width: `${percentage}%` }}
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>
            </Section>

            <Section title="Usage Alerts" description="Notifications about your usage thresholds.">
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                    <div className="flex items-start gap-3">
                        <AlertTriangle className="size-4 text-amber-500 mt-0.5 shrink-0" />
                        <div>
                            <p className="text-sm font-medium text-foreground">Approaching token limit</p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                Your token usage is at 49% of the monthly limit. Consider upgrading if you expect increased usage.
                            </p>
                        </div>
                    </div>
                </div>
            </Section>
        </div>
    );
}
