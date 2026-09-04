/** 开关（toggle switch）：与 prototype 同款 peer 样式 */
export function Toggle({ checked, onChange, title }: { checked: boolean; onChange: () => void; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onChange}
      className="relative inline-block h-5 w-9 shrink-0"
    >
      <span className={`absolute inset-0 rounded-full transition ${checked ? "bg-accent2" : "bg-ink3/40"}`} />
      <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${checked ? "translate-x-4" : ""}`} />
    </button>
  );
}
