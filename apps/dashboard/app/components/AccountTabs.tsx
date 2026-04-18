"use client";

/** Account-area navigation tabs for profile and roadmap pages. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const ACCOUNT_TABS = [
    { href: "/account", label: "Account" },
    { href: "/roadmap", label: "Roadmap" },
] as const;

export function AccountTabs() {
    const pathname = usePathname();

    return (
        <nav className="mb-6 inline-flex items-center gap-1 rounded-md border border-border bg-card p-1">
            {ACCOUNT_TABS.map((tab) => {
                const isActive =
                    pathname === tab.href || pathname.startsWith(`${tab.href}/`);

                return (
                    <Link
                        key={tab.href}
                        href={tab.href}
                        className={cn(
                            "rounded-sm px-3 py-1.5 text-xs font-medium transition-colors",
                            isActive
                                ? "bg-accent text-foreground"
                                : "text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                    >
                        {tab.label}
                    </Link>
                );
            })}
        </nav>
    );
}
