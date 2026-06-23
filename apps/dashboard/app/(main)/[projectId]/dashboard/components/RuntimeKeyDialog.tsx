"use client";

/** Reveals an environment's runtime API key (fp_agent_…) with copy controls, a .env snippet, and a WebSocket streaming example. */
import { Button } from "@/app/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Check, Copy, Eye, EyeOff, KeyRound } from "lucide-react";
import { useState } from "react";

interface DialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The plaintext runtime key (fp_agent_…) for the active environment. */
    apiKey: string;
    /** Whether the key was just minted (changes the framing copy). */
    justCreated?: boolean;
}

/** WebSocket streaming example — recommended for the best, lowest-latency experience. */
const WS_SNIPPET = [
    `import { WebsocketClient } from "broods";`,
    `import { api } from "./broods/_generated/api";`,
    ``,
    `// Reads BROODS_API_KEY from your .env automatically.`,
    `const client = new WebsocketClient();`,
    ``,
    `// Stream tokens live — lowest latency, fully bidirectional.`,
    `for await (const message of client.stream({`,
    `  agent: api.agents.yourAgent,`,
    `  input: "Hello from the SDK!",`,
    `})) {`,
    `  if (message.type === "text-delta") process.stdout.write(message.text);`,
    `}`,
].join("\n");

/** Small copy-to-clipboard button that flips to a check for a moment after copying. */
function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
    const [copied, setCopied] = useState(false);

    function copy() {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    return (
        <Button variant="outline" size="sm" className={`shrink-0 cursor-pointer ${className ?? ""}`} onClick={copy}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {label ? <span className="ml-1">{copied ? "Copied" : label}</span> : null}
        </Button>
    );
}

/** The reusable runtime-key body: the secret, its .env line, and the WebSocket SDK example. */
export function RuntimeKeyView({ apiKey }: { apiKey: string }) {
    const [showKey, setShowKey] = useState(false);
    const envLine = `BROODS_API_KEY="${apiKey}"`;

    return (
        <div className="grid gap-5">
            {/* The key itself */}
            <div className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">API key</Label>
                <div className="flex items-center gap-2">
                    <Input
                        readOnly
                        value={showKey ? apiKey : "•".repeat(Math.min(apiKey.length, 44))}
                        className="h-9 font-mono text-xs"
                    />
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-9 shrink-0 cursor-pointer"
                        onClick={() => setShowKey((v) => !v)}
                        title={showKey ? "Hide key" : "Reveal key"}
                    >
                        {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </Button>
                    <CopyButton text={apiKey} label="Copy" className="h-9" />
                </div>
                <p className="text-xs text-muted-foreground">
                    Stored encrypted at rest — treat it like a password. Reopen it here anytime, or rotate it to
                    invalidate the old one.
                </p>
            </div>

            {/* Drop it into the environment */}
            <div className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">Add it to your environment</Label>
                <p className="text-xs text-muted-foreground">
                    The SDK reads <code className="font-mono">BROODS_API_KEY</code> by default — copy this into your{" "}
                    <code className="font-mono">.env.local</code> or <code className="font-mono">.env</code> file.
                </p>
                <div className="flex items-center gap-2">
                    <code className="flex-1 truncate rounded-md border bg-muted/50 px-3 py-2 font-mono text-[11px]">
                        {envLine}
                    </code>
                    <CopyButton text={envLine} className="h-9" />
                </div>
            </div>

            {/* Stream over WebSocket */}
            <div className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">Stream over WebSocket</Label>
                <p className="text-xs text-muted-foreground">
                    WebSocket streaming gives the lowest latency and a bidirectional connection — the best experience
                    for live agent runs.
                </p>
                <div className="relative">
                    <pre className="overflow-x-auto rounded-md border bg-muted/50 px-3 py-3 font-mono text-[11px] leading-relaxed text-foreground">
                        {WS_SNIPPET}
                    </pre>
                    <CopyButton text={WS_SNIPPET} className="absolute right-2 top-2 h-7" />
                </div>
                <p className="text-xs text-muted-foreground">
                    Calls go to <code className="font-mono">gateway.broods.app</code> by default; override with{" "}
                    <code className="font-mono">BROODS_BASE_URL</code> for a self-hosted core.
                </p>
            </div>
        </div>
    );
}

/** Dialog that surfaces the runtime API key right after it is minted. */
export function RuntimeKeyDialog({ open, onOpenChange, apiKey, justCreated = false }: DialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <KeyRound className="size-4 text-foreground" />
                        {justCreated ? "Your runtime API key is ready" : "Runtime API key"}
                    </DialogTitle>
                    <DialogDescription>
                        This key authenticates runtime calls for this environment — agent runs, streaming, and the
                        observability views. Treat it like a password.
                    </DialogDescription>
                </DialogHeader>

                <RuntimeKeyView apiKey={apiKey} />
            </DialogContent>
        </Dialog>
    );
}
