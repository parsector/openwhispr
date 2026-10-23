import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "../icons";
import { Button } from "../ui/button";

interface IntegrationsPaneProps {
  title: string;
  description: ReactNode;
  docsUrl?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/** One Integrations section: a header with its actions, then the section's content. */
export function IntegrationsPane({
  title,
  description,
  actions,
  docsUrl,
  children,
}: IntegrationsPaneProps): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      {/* The actions wrap under the title when both don't fit, as with long translations. */}
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="flex-1 basis-60 min-w-0">
          {/* Focusable so a link that opens another section can move focus here. */}
          <h2 tabIndex={-1} className="text-base text-foreground outline-none">
            {title}
          </h2>
          <p className="text-xs text-muted-foreground/80 mt-1 leading-relaxed">{description}</p>
        </div>
        {(docsUrl || actions) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {docsUrl && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => window.electronAPI?.openExternal?.(docsUrl)}
                className="gap-1.5 text-muted-foreground"
              >
                {t("integrations.readDocs")}
                <ExternalLink className="h-3 w-3" />
              </Button>
            )}
            {actions}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
