import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Zap, X } from "../icons";
import { cn } from "../lib/utils";

export default function RealtimeTranscriptionBanner() {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem("realtimeProBannerDismissed") === "true"
  );

  if (dismissed) return null;

  const handleDismiss = () => {
    localStorage.setItem("realtimeProBannerDismissed", "true");
    setDismissed(true);
  };

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 h-8 shrink-0",
        "backdrop-blur-xl bg-primary/[0.03] dark:bg-primary/[0.06]",
        "border-b border-primary/10 dark:border-primary/15",
        "animate-in slide-in-from-top-2 duration-300"
      )}
    >
      <Zap size={11} className="text-primary/40 shrink-0" />
      <p className="text-xs text-primary/40 flex-1 truncate">{t("common.unavailableInBuild")}</p>
      <button
        onClick={handleDismiss}
        className="p-0.5 rounded text-primary/25 hover:text-primary/50 transition-colors shrink-0"
        aria-label={t("common.dismiss")}
      >
        <X size={11} />
      </button>
    </div>
  );
}
