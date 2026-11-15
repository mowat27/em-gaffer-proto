/**
 * The one Copy button: a fenced code block, a tool step's arguments or result, and an assistant answer. It copies the
 * whole `text`, which may be longer than what the block shows, says "Copied" for a moment, and reports a refusal as a
 * toast. Inside a `.tsf-copy-block` it sits in the corner and shows on hover or keyboard focus (common/copy.css).
 */
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, useToast } from "@pw/ui/react";
import { errorMessage } from "../api/client.ts";
import { copyText } from "../lib/clipboard.ts";

export interface CopyButtonProps {
  readonly text: string;
  /** Says what is copied: the accessible name and the tooltip. */
  readonly label: string;
  readonly testId?: string;
  readonly className?: string;
}

export function CopyButton({ text, label, testId = "copy-block", className }: CopyButtonProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <Button
      variant="ghost"
      size="sm"
      icon={copied ? Check : Copy}
      className={className ? `tsf-copy-btn ${className}` : "tsf-copy-btn"}
      aria-label={copied ? "Copied" : label}
      title={label}
      data-testid={testId}
      data-copied={copied ? "true" : "false"}
      onClick={() => {
        copyText(text).then(
          () => {
            setCopied(true);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1600);
          },
          (err: unknown) => toast({ tone: "error", title: "Could not copy", description: errorMessage(err) }),
        );
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
