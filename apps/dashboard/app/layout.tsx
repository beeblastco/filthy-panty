import { ConvexClientProvider } from "@/app/components/ConvexClientProvider";
import { ThemeProvider } from "next-themes";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
    title: "pnzu-frontend",
    description: "Frontend UX/UI for pnzu, backed by pnzu cloud services.",
};

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
                    <ConvexClientProvider>{children}</ConvexClientProvider>
                </ThemeProvider>
            </body>
        </html>
    );
}
