import React, { useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";

export interface MentionUser {
  id: number;
  name: string;
}

// A textarea that inserts `@[Name](id)` mention tokens. Typing `@` followed by
// letters opens a picker of tenant users; selecting one inserts the token. The
// stored value carries the tokens; render it with <MentionText /> for display.
export function MentionInput({
  value,
  onChange,
  users,
  placeholder,
  rows = 3,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  users: MentionUser[];
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [anchor, setAnchor] = useState(0);

  const matches =
    query === null
      ? []
      : users.filter((u) => u.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6);

  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = before.match(/@([\p{L}\p{N}]{0,30})$/u);
    if (m) {
      setQuery(m[1]);
      setAnchor(caret - m[0].length);
    } else {
      setQuery(null);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    detect(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  const pick = (u: MentionUser) => {
    const caret = ref.current?.selectionStart ?? value.length;
    const token = `@[${u.name}](${u.id}) `;
    const next = value.slice(0, anchor) + token + value.slice(caret);
    onChange(next);
    setQuery(null);
    // Restore focus + caret after the inserted token.
    requestAnimationFrame(() => {
      const pos = anchor + token.length;
      if (ref.current) {
        ref.current.focus();
        ref.current.setSelectionRange(pos, pos);
      }
    });
  };

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        onKeyDown={(e) => {
          if (query !== null && matches.length > 0 && (e.key === "Enter" || e.key === "Tab")) {
            e.preventDefault();
            pick(matches[0]);
          } else if (e.key === "Escape") {
            setQuery(null);
          }
        }}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
      />
      {query !== null && matches.length > 0 && (
        <div className="absolute z-50 mt-1 w-64 rounded-md border bg-popover shadow-md">
          {matches.map((u) => (
            <button
              key={u.id}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
              onMouseDown={(e) => {
                e.preventDefault();
                pick(u);
              }}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                {u.name.charAt(0)}
              </span>
              {u.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
