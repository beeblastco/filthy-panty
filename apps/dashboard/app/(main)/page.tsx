"use client";

/** Routes authenticated users to their most recent project, or the gallery when they have none. */
import { api } from "@/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** Home route that ensures the user's org exists, then redirects into a project or the gallery. */
export default function HomePage() {
    const router = useRouter();
    const getOrCreateOrg = useMutation(api.org.getOrCreate);
    const currentUser = useQuery(api.user.getCurrent);
    const projects = useQuery(api.project.list);
    const orgEnsured = useRef(false);
    const [error, setError] = useState<string | null>(null);

    // Ensure the caller has an org so project listing is correctly scoped.
    useEffect(() => {
        if (!currentUser || orgEnsured.current) return;

        orgEnsured.current = true;
        getOrCreateOrg({}).catch((err) => {
            console.error("Failed to prepare workspace:", err);
            setError(err instanceof Error ? err.message : "Failed to open workspace. Please refresh.");
            orgEnsured.current = false;
        });
    }, [currentUser, getOrCreateOrg]);

    // Open the most recent project, or the gallery when none exist (no auto-create).
    useEffect(() => {
        if (projects === undefined) return;

        router.replace(projects.length > 0 ? `/${projects[0]._id}` : "/projects");
    }, [projects, router]);

    return (
        <div className="flex h-full items-center justify-center">
            {error ? (
                <div className="text-center">
                    <p className="text-sm text-destructive">{error}</p>
                    <button
                        className="mt-2 text-xs text-muted-foreground underline cursor-pointer"
                        onClick={() => {
                            orgEnsured.current = false;
                            setError(null);
                        }}
                    >
                        Retry
                    </button>
                </div>
            ) : (
                <p className="text-sm text-muted-foreground">Opening workspace…</p>
            )}
        </div>
    );
}
