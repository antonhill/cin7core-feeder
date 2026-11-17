"use client";

import { useRef } from "react";

/** A captioned screenshot that enlarges in a native dialog (Esc or the Close button dismiss it; focus is trapped by the browser). */
export function GuideImage({ src, alt, caption, width, height }: { src: string; alt: string; caption: string; width: number; height: number }) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <figure className="my-4 overflow-hidden rounded-lg border border-slate-200 bg-white">
      <button type="button" onClick={() => ref.current?.showModal()} className="block w-full cursor-zoom-in bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" aria-label={`Enlarge screenshot: ${alt}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} width={width} height={height} loading="lazy" className="mx-auto h-auto max-h-[28rem] w-auto max-w-full object-contain" />
      </button>
      <figcaption className="border-t border-slate-200 px-3 py-2 text-sm text-slate-700">{caption} <span className="text-slate-600">(select the image to enlarge)</span></figcaption>
      <dialog ref={ref} className="m-auto max-h-[95vh] max-w-[95vw] rounded-lg p-2 backdrop:bg-slate-900/70" aria-label={alt}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} loading="lazy" className="max-h-[85vh] max-w-full object-contain" />
        <div className="flex items-center justify-between gap-4 pt-2 text-sm text-slate-700">
          <span>{caption}</span>
          <button type="button" onClick={() => ref.current?.close()} className="min-h-11 rounded-md border border-slate-300 px-3 font-medium hover:bg-slate-100">Close</button>
        </div>
      </dialog>
    </figure>
  );
}
