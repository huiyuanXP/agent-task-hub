"use client";
import { useState } from "react";

const NEW = "__new_project__";
/** One project chooser for quick capture and record forms: pick any catalog project or name a new one. */
export function ProjectSelect({ value, projects, onChange, label = "项目" }: {
  value: string; projects: readonly string[]; onChange: (project: string) => void; label?: string;
}) {
  const known = projects.includes(value);
  // A value that is (or becomes) a catalog project always shows as selected, e.g. after saving or an outside reset.
  const [wantsNew, setCreating] = useState(!known && !!value);
  const creating = wantsNew && !known;
  const options = known || creating || !value ? projects : [value, ...projects];
  return <span className="project-select">
    <select aria-label={label} value={creating ? NEW : value} onChange={event => {
      if (event.target.value === NEW) { setCreating(true); onChange(""); }
      else { setCreating(false); onChange(event.target.value); }
    }}>
      {!value && !creating && <option value="" disabled>选择项目</option>}
      {options.map(project => <option key={project} value={project}>{project}</option>)}
      <option value={NEW}>+ 新建项目…</option>
    </select>
    {creating && <input aria-label={"新项目名称"} placeholder="输入新项目名称" maxLength={120} value={value} autoFocus onChange={event => onChange(event.target.value)} />}
  </span>;
}
