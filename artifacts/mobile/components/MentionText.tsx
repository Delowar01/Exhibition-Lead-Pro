import React from "react";
import { Text, TextStyle } from "react-native";

const MENTION_RE = /@\[([^\]]{1,120})\]\((\d+)\)/g;

// Renders a stored note/comment body, turning `@[Name](id)` tokens into styled
// mention spans. Plain text is rendered as-is (React Native escapes by default).
export function MentionText({
  body,
  color,
  mentionColor,
  style,
}: {
  body: string;
  color: string;
  mentionColor: string;
  style?: TextStyle | TextStyle[];
}) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(body)) !== null) {
    if (m.index > last) parts.push(body.slice(last, m.index));
    parts.push(
      <Text key={`m-${idx}`} style={{ color: mentionColor, fontWeight: "600" }}>
        @{m[1]}
      </Text>,
    );
    last = m.index + m[0].length;
    idx++;
  }
  if (last < body.length) parts.push(body.slice(last));

  return <Text style={[{ color }, style]}>{parts}</Text>;
}
