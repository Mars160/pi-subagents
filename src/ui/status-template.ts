/**
 * status-template.ts — Literal `${placeholder}` substitution for the widget's
 * custom status line (`widgetStatusTemplate`).
 *
 * Deliberately not a template engine: no expressions, no conditionals, no
 * escaping rules, and replacement values are never re-scanned, so a value that
 * happens to contain `${...}` is printed as written. Unknown placeholders are
 * left in the output verbatim, which makes a typo visible on the row instead of
 * silently blanking a field.
 */

/** Every placeholder the template understands. */
export const WIDGET_STATUS_VARS = [
  "task_title",
  "model",
  "model_id",
  "effort",
  "round",
  "tool_uses_count",
  "total_token",
  "tps",
  "time",
  "cost",
  "status",
] as const;

export type WidgetStatusVar = (typeof WIDGET_STATUS_VARS)[number];

/** Values for every placeholder; a missing measurement is the empty string. */
export type WidgetStatusVars = Record<WidgetStatusVar, string>;

const KNOWN_VARS: ReadonlySet<string> = new Set(WIDGET_STATUS_VARS);

/**
 * Whether a configured template should replace the default row body. Unset,
 * empty and whitespace-only templates all fall back to the built-in rendering —
 * which is also what a project writes to clear a globally configured template.
 */
export function hasStatusTemplate(template: string | undefined): template is string {
  return typeof template === "string" && template.trim() !== "";
}

/**
 * Substitute `${name}` placeholders. Unknown placeholders keep their `${...}`
 * text. A single pass — the replacement strings are not examined for further
 * placeholders — and newlines/tabs collapse to spaces *after* it, so the
 * normalization covers a value's own line breaks (a task title, an error
 * string) and not just the template text.
 */
export function renderWidgetStatusTemplate(template: string, vars: WidgetStatusVars): string {
  const substituted = template.replace(/\$\{([^{}]*)\}/g, (match, name: string) =>
    KNOWN_VARS.has(name) ? vars[name as WidgetStatusVar] : match,
  );
  return substituted.replace(/[\r\n\t]+/g, " ");
}
