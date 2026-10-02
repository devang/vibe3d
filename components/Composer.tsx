"use client";

import { useEffect, useRef, useState } from "react";
import { resizeImage } from "@/lib/image";
import { MAX_IMAGES, REFERENCES } from "@/lib/client";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  size?: "lg" | "sm";
  /** Pass to enable image attachments. */
  images?: string[];
  onImagesChange?: (imgs: string[]) => void;
  /** Pass to show the measuring-reference picker. */
  reference?: string;
  onReferenceChange?: (key: string) => void;
  /** Allow sending with images and no text. */
  allowImageOnly?: boolean;
  autoFocus?: boolean;
};

export default function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  size = "lg",
  images,
  onImagesChange,
  reference,
  onReferenceChange,
  allowImageOnly,
  autoFocus,
}: Props) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const canAttach = !!onImagesChange;
  const imgs = images ?? [];
  const canSend = !disabled && (value.trim().length > 0 || (allowImageOnly && imgs.length > 0));
  const lg = size === "lg";

  // Auto-grow the textarea.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, lg ? 240 : 160) + "px";
  }, [value, lg]);

  async function addFiles(files: File[]) {
    if (!onImagesChange) return;
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const room = MAX_IMAGES - imgs.length;
    if (room <= 0) {
      setNote(`You can attach up to ${MAX_IMAGES} photos.`);
      return;
    }
    if (imageFiles.length > room) setNote(`Only the first ${room} photo${room > 1 ? "s were" : " was"} added (max ${MAX_IMAGES}).`);
    else setNote(null);
    const resized = await Promise.all(imageFiles.slice(0, room).map((f) => resizeImage(f)));
    onImagesChange([...imgs, ...resized].slice(0, MAX_IMAGES));
  }

  function submit() {
    if (!canSend) return;
    setNote(null);
    onSubmit();
  }

  return (
    <div
      className={`relative rounded-2xl border bg-slate-900/80 shadow-xl shadow-black/30 transition-colors ${
        dragging ? "border-amber-400" : "border-slate-700 focus-within:border-slate-500"
      }`}
      onDragOver={(e) => {
        if (!canAttach) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!canAttach) return;
        e.preventDefault();
        setDragging(false);
        addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {imgs.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {imgs.map((src, i) => (
            <div key={i} className="group relative h-16 w-16 overflow-hidden rounded-lg border border-slate-700">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`Attached photo ${i + 1}`} className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => {
                  setNote(null);
                  onImagesChange?.(imgs.filter((_, j) => j !== i));
                }}
                className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-full bg-black/75 text-[10px] text-white"
                aria-label={`Remove photo ${i + 1}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textRef}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        onPaste={(e) => {
          if (!canAttach) return;
          const files = Array.from(e.clipboardData.files);
          if (files.some((f) => f.type.startsWith("image/"))) {
            e.preventDefault();
            addFiles(files);
          }
        }}
        rows={1}
        placeholder={placeholder}
        className={`block w-full resize-none bg-transparent px-4 text-slate-100 placeholder:text-slate-500 focus:outline-none ${
          lg ? "min-h-[64px] pt-4 text-base" : "min-h-[44px] pt-3 text-sm"
        }`}
      />

      <div className={`flex items-center gap-2 px-2 ${lg ? "pb-2 pt-1" : "pb-1.5"}`}>
        {canAttach && (
          <>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={imgs.length >= MAX_IMAGES}
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
              title={`Attach photos (${imgs.length}/${MAX_IMAGES})`}
            >
              <PaperclipIcon />
              <span>
                Photos <span className="text-slate-500">{imgs.length}/{MAX_IMAGES}</span>
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </>
        )}

        {onReferenceChange && (
          <label className="relative flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
            <RulerIcon />
            <span className="pointer-events-none">
              Scale: <span className="text-slate-100">{REFERENCES.find((r) => r.key === reference)?.label}</span>
            </span>
            <ChevronIcon />
            <select
              value={reference}
              onChange={(e) => onReferenceChange(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Measuring reference in photo"
            >
              {REFERENCES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                  {r.detail ? ` (${r.detail})` : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="flex-1" />
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label="Send"
          className={`grid place-items-center rounded-full bg-amber-500 text-slate-950 transition hover:bg-amber-400 disabled:bg-slate-700 disabled:text-slate-500 ${
            lg ? "h-9 w-9" : "h-8 w-8"
          }`}
        >
          <ArrowUpIcon />
        </button>
      </div>

      {note && <p className="px-4 pb-2 text-xs text-amber-300">{note}</p>}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-2xl bg-slate-900/90 text-sm text-amber-300">
          Drop photos to attach
        </div>
      )}
    </div>
  );
}

function PaperclipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
function RulerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z" />
      <path d="m14.5 12.5 2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2" />
    </svg>
  );
}
function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-slate-500">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
function ArrowUpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}
