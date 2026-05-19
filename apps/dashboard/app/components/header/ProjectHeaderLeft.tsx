"use client";

import { EnvironmentSelector } from "@/app/components/EnvironmentSelector";

/** Environment selector shown on the left side of the project header. */
export function ProjectHeaderLeft() {
    return (
        <>
            <div className="h-4 w-px bg-border" />
            <EnvironmentSelector />
        </>
    );
}
