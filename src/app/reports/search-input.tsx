"use client";

/** P5.4 (LBL brief): the shared free-text search box every Reporting module's filter bar uses — same markup every module already hand-rolled individually before this. */
export function SearchInput({
  value,
  onChange,
  placeholder,
  label = "Search",
  className = "w-56 rounded-lg border border-slate-300 px-3 py-2",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label?: string;
  className?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={className} />
    </label>
  );
}
