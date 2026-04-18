import { AccountTabs } from "@/app/components/AccountTabs";

const PENDING_TASKS = [
    {
        title: "Polling-based resume for waiting subagent",
        when: "Next",
        note: "Resume assistant output automatically once the subagent finishes.",
    },
    {
        title: "Approval/disapproval flow in waiting states",
        when: "After polling resume",
        note: "Allow approve/deny actions while the parent task is paused.",
    },
    {
        title: "Durable background execution for subagents",
        when: "Planned",
        note: "Run long subagent work through a durable worker path.",
    },
    {
        title: "WebSocket service for durable streaming",
        when: "Planned",
        note: "Provide resumable streaming when clients reconnect.",
    },
] as const;

export default function RoadmapPage() {
    return (
        <div className="mx-auto w-full max-w-2xl px-6 py-10">
            <h1 className="mb-2 text-xl font-semibold text-foreground">Roadmap</h1>
            <p className="mb-8 text-sm text-muted-foreground">
                Temporary list of pending tasks for this project.
            </p>

            <AccountTabs />

            <section className="rounded-lg border border-border bg-card">
                <ul className="divide-y divide-border">
                    {PENDING_TASKS.map((task) => (
                        <li key={task.title} className="flex gap-3 px-4 py-3">
                            <span
                                aria-hidden
                                className="mt-1.5 block size-2 shrink-0 rounded-full bg-amber-500"
                            />
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-foreground">{task.title}</p>
                                <p className="text-xs text-muted-foreground">When: {task.when}</p>
                                <p className="text-xs text-muted-foreground">{task.note}</p>
                            </div>
                        </li>
                    ))}
                </ul>
            </section>
        </div>
    );
}
