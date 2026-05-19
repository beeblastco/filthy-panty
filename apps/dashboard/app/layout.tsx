import { AuthKitProvider, useAuth } from "@/lib/workos";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";
import "./globals.css";

export const metadata: Metadata = {
    title: "pnzu-frontend",
    description: "Frontend UX/UI for pnzu, backed by pnzu cloud services.",
};

const convex = new ConvexReactClient(
    process.env.NEXT_PUBLIC_CONVEX_URL as string,
);

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" suppressHydrationWarning>
            <body className="antialiased">
                <ThemeProvider
                    attribute="class"
                    defaultTheme="dark"
                    enableSystem={false}
                >
                    <AuthKitProvider>
                        <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
                            {children}
                        </ConvexProviderWithAuth>
                    </AuthKitProvider>
                </ThemeProvider>
            </body>
        </html>
    );
}
