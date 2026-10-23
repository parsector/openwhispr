import type { ComponentType } from "react";
import { Calendar, Code2, Key, Link2, Network, Terminal } from "../icons";

export type IntegrationsSection = "connectors" | "calendars" | "api" | "mcp" | "cli" | "agents";

export const DEFAULT_INTEGRATIONS_SECTION: IntegrationsSection = "calendars";

export const INTEGRATIONS_SECTION_GROUPS: ReadonlyArray<{
  id: "assistant" | "meetings" | "developer";
  sections: readonly IntegrationsSection[];
}> = [
  { id: "meetings", sections: ["calendars"] },
  { id: "assistant", sections: ["connectors"] },
  { id: "developer", sections: ["api", "mcp", "cli", "agents"] },
];

export const INTEGRATIONS_SECTION_ICONS: Record<
  IntegrationsSection,
  ComponentType<{ size?: number; className?: string }>
> = {
  connectors: Link2,
  calendars: Calendar,
  api: Key,
  mcp: Network,
  cli: Terminal,
  agents: Code2,
};

export type SectionMeta = { kind: "count"; value: number };

export interface SectionMetaInput {
  isPaid: boolean;
  /** Connectors decide their plan and org policy as the Connectors pane does. */
  connectors: { isPaid: boolean; blockedByOrg: boolean; ready: number };
  connectedCalendars: number;
}

/** The connected count shown beside a section in the nav. */
export function sectionMeta(
  section: IntegrationsSection,
  { connectors, connectedCalendars }: SectionMetaInput
): SectionMeta | null {
  switch (section) {
    case "connectors":
      // Turned off by the organization: no plan would change that, and no login can act.
      if (connectors.blockedByOrg) return null;
      if (!connectors.isPaid) return null;
      return connectors.ready > 0 ? { kind: "count", value: connectors.ready } : null;
    case "calendars":
      return connectedCalendars > 0 ? { kind: "count", value: connectedCalendars } : null;
    case "api":
      return null;
    case "mcp":
      return null;
    case "cli":
    case "agents":
      return null;
  }
}

export const INTEGRATIONS_SECTIONS: readonly IntegrationsSection[] =
  INTEGRATIONS_SECTION_GROUPS.flatMap((group) => group.sections);
