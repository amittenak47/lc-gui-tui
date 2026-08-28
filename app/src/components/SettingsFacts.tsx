import type { SettingsFact } from "../util/settingsFacts";

export function SettingsFacts({
  facts,
  error = false,
}: {
  facts: SettingsFact[];
  error?: boolean;
}) {
  if (facts.length === 0) return null;
  return (
    <dl className={error ? "lc-settings-facts is-error" : "lc-settings-facts"}>
      {facts.map((fact, index) => (
        <div
          key={`${fact.label ?? ""}:${index}`}
          className={fact.tone === "name" ? "is-name" : undefined}
          data-tone={fact.tone}
        >
          {fact.label ? <dt>{fact.label}</dt> : null}
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function factsFromMessage(message: string): SettingsFact[] {
  return message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((value) => ({ value }));
}
