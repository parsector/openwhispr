import type { ReactNode } from "react";
import { parseMentionEmail } from "../../utils/mentionMarkdown";
import PersonAvatar from "../ui/PersonAvatar";

const MENTION = /\[@([^\]\n]+)\]\((mention:[^)\s]+)\)/g;

export function plainTodoText(text: string): string {
  return text.replace(MENTION, (_all, name: string) => `@${name}`);
}

export function renderTodoText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let start = 0;
  for (const match of text.matchAll(MENTION)) {
    const index = match.index;
    if (index > start) nodes.push(text.slice(start, index));
    const name = match[1];
    nodes.push(<span key={index} data-todo-mention className="inline-flex items-center gap-1 rounded-full bg-input px-1.5 py-0.5 align-middle text-foreground">
      <PersonAvatar email={parseMentionEmail(match[2])} displayName={name} size={16} />@{name}
    </span>);
    start = index + match[0].length;
  }
  if (start < text.length) nodes.push(text.slice(start));
  return nodes;
}
