"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useShooAuth } from "@shoojs/react";
import { SHOO_AUTH_OPTIONS } from "@/lib/shoo";

const AUTH_FREE_PATHS = new Set(["/login", "/auth/callback"]);

export function ShooSessionMonitor() {
    const router = useRouter();
    const pathname = usePathname();
    const { loading, sessionState } = useShooAuth({
        ...SHOO_AUTH_OPTIONS,
        autoSessionMonitor: true,
    });

    useEffect(() => {
        if (loading || sessionState !== "login_required") {
            return;
        }
        if (AUTH_FREE_PATHS.has(pathname)) {
            return;
        }
        router.replace("/login");
    }, [loading, pathname, router, sessionState]);

    return null;
}
