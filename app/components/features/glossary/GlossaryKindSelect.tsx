/**
 * The kind of a glossary entry, chosen from the kinds the site offers. A value
 * the list does not hold (written by hand in the sheet) stays selected under
 * what it was written as, with a note that the site reads it as the default
 * kind, until the author picks one.
 *
 * The Compositor names the four standard kinds in the interface language. The
 * site's language file labels them for readers, and the preview shows that
 * label, but an English interface on a Spanish site would otherwise list
 * "Palabra clave" among English controls. A site's own kinds have only the
 * label the config gives them, so they are shown as written.
 *
 * @version v1.5.1-beta
 */
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  NO_GLOSSARY_KINDS,
  kindOfValue,
  readKind,
  type GlossaryKindOption,
  type GlossaryKinds,
} from "~/lib/glossary-kinds";

const STANDARD_KIND_NAMES: Record<string, string> = {
  term: "kind_name_term",
  source: "kind_name_source",
  entity: "kind_name_entity",
  place: "kind_name_place",
};

/** A kind's name for the interface: a standard kind in the interface language, a site kind as its config labels it. */
export function useKindName(kinds: GlossaryKinds): (kind: GlossaryKindOption) => string {
  const { t } = useTranslation("glossary");
  return (kind) => {
    const key = STANDARD_KIND_NAMES[kind.id];
    return key && kinds.core.some((c) => c.id === kind.id) ? t(key) : kind.label;
  };
}

/** The site's kinds once the loader's promise settles; none until then, and none if it fails. */
export function useGlossaryKinds(source: GlossaryKinds | Promise<GlossaryKinds>): GlossaryKinds {
  const [kinds, setKinds] = useState<GlossaryKinds>(NO_GLOSSARY_KINDS);
  useEffect(() => {
    let current = true;
    Promise.resolve(source)
      .catch(() => NO_GLOSSARY_KINDS)
      .then((next) => current && setKinds(next));
    return () => {
      current = false;
    };
  }, [source]);
  return kinds;
}

/** The entry's kind under its title in the term list; nothing where the site offers none. */
export function KindCaption({ kinds, value }: { kinds: GlossaryKinds; value: string }) {
  const name = useKindName(kinds);
  const kind = kinds.available ? readKind(kinds, value) : undefined;
  if (!kind) return null;
  const label = name(kind);
  return <span className="block font-body text-xs font-normal text-fg-muted truncate">{label}</span>;
}

interface GlossaryKindSelectProps {
  kinds: GlossaryKinds;
  /** The kind as stored: an id, a value that names one, or text that names none. */
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** Shown beside the Kind label. */
  labelAction?: ReactNode;
}

export function GlossaryKindSelect({ kinds, value, onChange, disabled, labelAction }: GlossaryKindSelectProps) {
  const name = useKindName(kinds);
  const { t } = useTranslation("glossary");
  if (!kinds.available) return null;
  const known = kindOfValue(kinds, value);
  const readAs = readKind(kinds, value);
  return (
    <div className="mt-4">
      <div className="flex items-baseline gap-3 mb-2">
        <label
          htmlFor="glossary-kind"
          className="block font-heading text-xs font-semibold text-fg-muted uppercase tracking-wider"
        >
          {t("kind_label")}
        </label>
        {labelAction}
      </div>
      <select
        id="glossary-kind"
        value={known ? known.id : value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="font-body text-sm text-charcoal bg-surface rounded-md border border-gray-200 px-2.5 py-1.5 max-w-xs"
      >
        {!known && (
          <option value={value}>{t("kind_unknown", { value, kind: readAs?.label ?? "" })}</option>
        )}
        {kinds.options.map((o) => (
          <option key={o.id} value={o.id}>
            {name(o)}
          </option>
        ))}
      </select>
    </div>
  );
}
