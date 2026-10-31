import { useEffect } from "react";
import { useToastStore, type ToastItem } from "./toast";
import { cx } from "./cx";
import { IconClose } from "./icons";

function ToastRow({ t }: { t: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  useEffect(() => {
    if (!t.duration) return;
    const id = window.setTimeout(() => dismiss(t.id), t.duration);
    return () => window.clearTimeout(id);
  }, [t.id, t.duration, dismiss]);
  return (
    <div className={cx("ui-toast", `ui-toast--${t.tone}`)} role={t.tone === "danger" ? "alert" : "status"}>
      <span className="ui-toast-msg">{t.message}</span>
      {t.action ? (
        <button
          type="button"
          className="ui-toast-action"
          onClick={() => {
            t.action!.onClick();
            dismiss(t.id);
          }}
        >
          {t.action.label}
        </button>
      ) : null}
      <button type="button" className="ui-toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
        <IconClose size={16} />
      </button>
    </div>
  );
}

/** Mounted once by App. Use toast() from ./toast to show messages. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className="ui-toaster" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <ToastRow key={t.id} t={t} />
      ))}
    </div>
  );
}
