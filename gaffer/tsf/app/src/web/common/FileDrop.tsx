/**
 * File upload controls. pw-ui has no file input or drop zone, so these compose its Button and IconButton with tokens
 * (common/filedrop.css): the browser's own file input stays hidden, so nothing unthemed shows.
 *
 * - `UploadButton`: opens the file chooser, and is a drop target itself.
 * - `DropZone`: wraps an area that takes dropped files and shows a dashed brand outline with words while files hover.
 * - `useUploader`: sends files one at a time to POST /api/uploads, toasts each failure with its reason, and returns the
 *   files that were saved.
 */
import { useCallback, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { Button, IconButton, useToast } from "@pw/ui/react";
import type { UploadResult } from "../../core/uploads.ts";
import { api, errorMessage } from "../api/client.ts";

/** True for a drag that carries files (not text or a link dragged from the page). */
function carriesFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Drag handlers for a drop target, and whether files hover over it. Nested children do not make it flicker, and a
 * target inside another (the Pages pane's Upload button is portaled from inside the pane's zone, and React events
 * bubble through portals) keeps the drag to itself.
 */
function useDropTarget(onFiles: (files: File[]) => void, disabled: boolean) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (disabled || !carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (disabled || !carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (disabled || !carriesFiles(e)) return;
      e.stopPropagation();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (disabled || !carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current = 0;
      setOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) onFiles(files);
    },
  };
  return { over, handlers };
}

export function DropZone({
  onFiles,
  label,
  disabled = false,
  className,
  children,
  testId,
  ...data
}: {
  /** `data-*` attributes go on the zone's element (a literal `data-cap` for the parity check). */
  [attr: `data-${string}`]: string;
  onFiles: (files: File[]) => void;
  /** What a drop does, shown while files hover ("Drop files to upload them to tsf/uploads"). */
  label: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  const { over, handlers } = useDropTarget(onFiles, disabled);
  return (
    <div className={`tsf-drop${className ? ` ${className}` : ""}`} {...data} data-dragging={over} data-testid={testId} {...handlers}>
      {children}
      {over && (
        <div className="tsf-drop-overlay" aria-hidden="true">
          <Upload className="tsf-drop-icon" />
          <span>{label}</span>
        </div>
      )}
    </div>
  );
}

export function UploadButton({
  onFiles,
  label,
  iconOnly = false,
  multiple = true,
  accept,
  loading = false,
  testId,
}: {
  onFiles: (files: File[]) => void;
  /** The button's words, or its accessible name when `iconOnly`. */
  label: string;
  iconOnly?: boolean;
  multiple?: boolean;
  /** The file chooser's filter (".tgz,.gz"); a drop takes any file. */
  accept?: string;
  loading?: boolean;
  testId?: string;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const { over, handlers } = useDropTarget(onFiles, loading);
  const choose = (): void => input.current?.click();
  return (
    <span className="tsf-upload" data-dragging={over} {...handlers}>
      {iconOnly ? (
        <IconButton size="sm" label={label} icon={Upload} loading={loading} data-testid={testId} onClick={choose} />
      ) : (
        <Button variant="secondary" size="sm" icon={Upload} loading={loading} data-testid={testId} onClick={choose}>
          {label}
        </Button>
      )}
      <input
        ref={input}
        type="file"
        hidden
        multiple={multiple}
        {...(accept !== undefined ? { accept } : {})}
        data-testid={testId ? `${testId}-input` : undefined}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Cleared, so choosing the same file again fires a change.
          e.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </span>
  );
}

/** Uploads files one at a time; `uploading` names the work in progress for a spinner line, null when idle. */
export function useUploader(): { uploading: string | null; upload: (files: readonly File[]) => Promise<UploadResult[]> } {
  const { toast } = useToast();
  const [uploading, setUploading] = useState<string | null>(null);
  const upload = useCallback(
    async (files: readonly File[]): Promise<UploadResult[]> => {
      const saved: UploadResult[] = [];
      for (const [i, file] of files.entries()) {
        setUploading(files.length === 1 ? `Uploading ${file.name}` : `Uploading ${file.name} (${i + 1} of ${files.length})`);
        try {
          saved.push(await api.uploads.upload(file));
        } catch (err) {
          toast({ tone: "error", title: `${file.name} was not uploaded`, description: errorMessage(err) });
        }
      }
      setUploading(null);
      return saved;
    },
    [toast],
  );
  return { uploading, upload };
}
