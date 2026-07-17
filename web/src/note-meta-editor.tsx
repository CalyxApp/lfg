// NoteMetaEditor — a reusable, controlled editor for a note's title + tags +
// arbitrary frontmatter properties. Built for the Converse save-review step, but
// deliberately generic ("like creating a note") so it can back note creation too.
// Self-contained dark styling so it reads inside the Converse overlay.

import { useState } from "react";

export type PropRow = { key: string; value: string };

export function NoteMetaEditor({
  title,
  onTitle,
  tags,
  onTags,
  properties,
  onProperties,
}: {
  title: string;
  onTitle: (v: string) => void;
  tags: string[];
  onTags: (v: string[]) => void;
  properties: PropRow[];
  onProperties: (v: PropRow[]) => void;
}) {
  const [tagDraft, setTagDraft] = useState("");

  const addTag = () => {
    const t = tagDraft.trim().replace(/,$/, "");
    if (t && !tags.includes(t)) onTags([...tags, t]);
    setTagDraft("");
  };
  const removeTag = (t: string) => onTags(tags.filter((x) => x !== t));

  const setRow = (i: number, patch: Partial<PropRow>) =>
    onProperties(properties.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => onProperties(properties.filter((_, j) => j !== i));
  const addRow = () => onProperties([...properties, { key: "", value: "" }]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Title */}
      <div>
        <label style={label}>Title</label>
        <input style={input} value={title} onChange={(e) => onTitle(e.target.value)} placeholder="Untitled conversation" />
      </div>

      {/* Tags */}
      <div>
        <label style={label}>Tags</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
          {tags.map((t) => (
            <span key={t} style={chip}>
              {t}
              <button style={chipX} onClick={() => removeTag(t)} aria-label={`remove ${t}`}>
                ×
              </button>
            </span>
          ))}
        </div>
        <input
          style={input}
          value={tagDraft}
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addTag();
            }
          }}
          onBlur={addTag}
          placeholder="Add a tag, press Enter"
        />
      </div>

      {/* Properties */}
      <div>
        <label style={label}>Properties</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {properties.map((row, i) => (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                style={{ ...input, flex: "0 0 38%" }}
                value={row.key}
                onChange={(e) => setRow(i, { key: e.target.value })}
                placeholder="key"
              />
              <input
                style={{ ...input, flex: 1 }}
                value={row.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
                placeholder="value"
              />
              <button style={rowX} onClick={() => removeRow(i)} aria-label="remove property">
                ×
              </button>
            </div>
          ))}
        </div>
        <button style={addBtn} onClick={addRow}>
          + Add property
        </button>
      </div>
    </div>
  );
}

const label: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  opacity: 0.6,
  marginBottom: 6,
};
const input: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "#2c2c2e",
  color: "#f2f2f7",
  border: "1px solid #3a3a3c",
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 14,
  outline: "none",
};
const chip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  background: "#2c2c2e",
  borderRadius: 999,
  padding: "3px 6px 3px 10px",
  fontSize: 13,
};
const chipX: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#f2f2f7",
  cursor: "pointer",
  fontSize: 15,
  lineHeight: 1,
  opacity: 0.7,
};
const rowX: React.CSSProperties = {
  flex: "0 0 auto",
  border: "none",
  background: "transparent",
  color: "#f2f2f7",
  cursor: "pointer",
  fontSize: 18,
  opacity: 0.5,
  padding: "0 4px",
};
const addBtn: React.CSSProperties = {
  marginTop: 8,
  background: "transparent",
  border: "1px dashed #3a3a3c",
  color: "#f2f2f7",
  borderRadius: 8,
  padding: "6px 10px",
  fontSize: 13,
  cursor: "pointer",
  opacity: 0.8,
};
