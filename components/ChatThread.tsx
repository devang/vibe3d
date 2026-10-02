"use client";

import { useEffect, useRef } from "react";
import { referenceLabel, type ChatMessage } from "@/lib/client";

export default function ChatThread({ messages, pending }: { messages: ChatMessage[]; pending?: string | null }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pending]);

  return (
    <div className="space-y-4">
      {messages.map((m) =>
        m.role === "user" ? (
          <div key={m.id} className="flex flex-col items-end gap-1.5">
            {!!m.images?.length && (
              <div className="flex flex-wrap justify-end gap-1.5">
                {m.images.map((src, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} src={src} alt={`Photo ${i + 1}`} className="h-20 w-20 rounded-lg border border-slate-700 object-cover" />
                ))}
              </div>
            )}
            {m.text && (
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-slate-800 px-4 py-2.5 text-sm text-slate-100">
                {m.text}
              </div>
            )}
            {!!m.images?.length && m.reference && (
              <span className="text-[11px] text-slate-500">Scale reference: {referenceLabel(m.reference)}</span>
            )}
          </div>
        ) : (
          <div key={m.id} className="flex gap-2.5">
            <Avatar />
            <div className="min-w-0 flex-1 pt-0.5">
              <p className={`whitespace-pre-wrap text-sm ${m.error ? "text-red-300" : "text-slate-200"}`}>{m.text}</p>
              {!!m.warnings?.length && (
                <ul className="mt-2 space-y-1 rounded-lg border border-red-900/70 bg-red-950/40 px-3 py-2 text-xs text-red-200">
                  {m.warnings.map((w, i) => (
                    <li key={i}>⚠ {w}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ),
      )}
      {pending && (
        <div className="flex gap-2.5" aria-live="polite">
          <Avatar spinning />
          <p className="pt-0.5 text-sm text-slate-400">{pending}</p>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function Avatar({ spinning }: { spinning?: boolean }) {
  return (
    <div
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-full bg-amber-500/15 text-amber-400 ${spinning ? "animate-pulse" : ""}`}
      aria-hidden
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
        <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" />
        <path d="m3 7 9 5 9-5M12 12v10" />
      </svg>
    </div>
  );
}
