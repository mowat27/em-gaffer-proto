import { useId } from 'react';
import { Field, FilterChip, Input } from '@pw/ui/react';
import { KIND_LABEL, STANDARD_TAGS, parseTags, type ModelIndex } from '../state/modelIndex.ts';

/** Searchable element select: type a name or id; matching elements are offered by the browser's list. */
export function ElementPicker({
  label,
  idx,
  value,
  onChange,
  error,
  onBlur,
}: {
  label: string;
  idx: ModelIndex;
  value: string;
  onChange: (id: string) => void;
  error?: string;
  onBlur?: () => void;
}) {
  const listId = useId();
  const known = idx.byId.get(value);
  return (
    <>
      <Field label={label} required error={error} help={known ? `${known.name} (${KIND_LABEL[known.kind]})` : 'Type to search by name or id.'}>
        <Input list={listId} value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} autoComplete="off" spellCheck={false} />
      </Field>
      <datalist id={listId}>
        {idx.ws.elements.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name} ({KIND_LABEL[e.kind]})
          </option>
        ))}
      </datalist>
    </>
  );
}

/** Comma-separated tags with the standard tags as toggle chips. */
export function TagsField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const current = parseTags(value);
  const toggle = (tag: string) => {
    const has = current.some((t) => t.toLowerCase() === tag.toLowerCase());
    onChange((has ? current.filter((t) => t.toLowerCase() !== tag.toLowerCase()) : [...current, tag]).join(', '));
  };
  return (
    <div className="c4-tags-field">
      <Field label="Tags" optional help="Comma separated. Pick a standard tag below or type your own.">
        <Input value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" />
      </Field>
      <div className="c4-chip-row" role="group" aria-label="Standard tags">
        {STANDARD_TAGS.map((t) => (
          <FilterChip key={t} pressed={current.some((c) => c.toLowerCase() === t.toLowerCase())} onPressedChange={() => toggle(t)}>
            {t}
          </FilterChip>
        ))}
      </div>
    </div>
  );
}
