"use client";

/** Client-side providers for Convex, WorkOS AuthKit, and theming. */
import { AuthKitProvider, useAuth } from "@/lib/workos";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL as string);

/** Wraps the app with theme, auth, and Convex providers. */
export function ConvexClientProvider({ children }: { children: ReactNode }) {
    return (
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
            <AuthKitProvider>
                <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
                    {children}
                </ConvexProviderWithAuth>
            </AuthKitProvider>
        </ThemeProvider>
    );
}
