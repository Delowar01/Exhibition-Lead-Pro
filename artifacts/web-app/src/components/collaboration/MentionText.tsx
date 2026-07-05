import React from "react";

const MENTION_RE = /@\[([^\]]{1,120})\]\((\d+)\)/g;

// Renders a stored rich-text body as safe React nodes. NEVER uses
// dangerouslySetInnerHTML — text is escaped by React, mentions become styled
// chips, and a small markdown subset (**bold**, *italic*) is rendered inline.
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Split on **bold** and *italic* while keeping delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter((p) => p !== "");
  parts.forEach((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) {
      nodes.push(<strong key={`${keyPrefix}-b-${i}`}>{p.slice(2, -2)}</strong>);
    } else if (/^\*[^*]+\*$/.test(p)) {
      nodes.push(<em key={`${keyPrefix}-i-${i}`}>{p.slice(1, -1)}</em>);
    } else {
      nodes.push(<React.Fragment key={`${keyPrefix}-t-${i}`}>{p}</React.Fragment>);
    }
  });
  return nodes;
}

export function MentionText({ body, className }: { body: string; className?: string }) {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(body)) !== null) {
    if (m.index > last) nodes.push(...renderInline(body.slice(last, m.index), `pre-${idx}`));
    nodes.push(
      <span key={`mention-${idx}`} className="font-medium text-primary bg-primary/10 rounded px-1 py-0.5">
        @{m[1]}
      </span>,
    );
    last = m.index + m[0].length;
    idx++;
  }
  if (last < body.length) nodes.push(...renderInline(body.slice(last), `post-${idx}`));
  return <span className={`whitespace-pre-wrap ${className ?? ""}`}>{nodes}</span>;
}
