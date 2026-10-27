import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlignLeft, ChevronDown } from "../icons";
import { Button } from "../ui/button";
import TemplatePicker from "./TemplatePicker";
import { getActionName, resolveTemplate } from "../../stores/actionStore";
import type { ActionItem } from "../../types/electron";

interface Props {
  visible: boolean;
  noteId: number;
  savedTemplateId: string | null;
  templates: ActionItem[];
  disabled: boolean;
  onRun: (template: ActionItem) => void;
  onManage: () => void;
}

export default function PreSummaryTemplateCallout({
  visible,
  noteId,
  savedTemplateId,
  templates,
  disabled,
  onRun,
  onManage,
}: Props) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => setSelectedId(null), [noteId, savedTemplateId]);
  const current = resolveTemplate(templates, selectedId ?? savedTemplateId);
  if (!visible || !current) return null;
  return (
    <div className="flex flex-col items-center gap-1">
      <Button className="h-9 gap-2 px-4 text-sm" onClick={() => onRun(current)}>
        <AlignLeft size={16} />
        {t("notes.editor.generateSummary")}
      </Button>
      <TemplatePicker
        templates={templates}
        current={current}
        onRun={(template) => setSelectedId(template.client_id)}
        onManage={onManage}
        disabled={disabled}
        selectionMode
      >
        <button
          type="button"
          aria-label={t("notes.templates.select")}
          className="inline-flex max-w-56 items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span dir="auto" className="truncate">
            {getActionName(current, t)}
          </span>
          <ChevronDown size={11} className="shrink-0" />
        </button>
      </TemplatePicker>
    </div>
  );
}
