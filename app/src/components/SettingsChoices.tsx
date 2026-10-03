import { Children, cloneElement, isValidElement, type ButtonHTMLAttributes, type HTMLAttributes, type ReactElement, type ReactNode } from "react";

type Choice = ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;

function label(child: ReactNode): string {
  if (typeof child === "string") return child;
  if (!isValidElement<{ children?: ReactNode }>(child)) return "";
  return Children.toArray(child.props.children).map(label).join("");
}

/** One presentation per job, preserving each control's existing draft handlers. */
export function SettingsChoices({ children, className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  const choices = Children.toArray(children).filter((child): child is Choice => isValidElement(child));
  const labels = choices.map(child => {
    const heading = Children.toArray(child.props.children).find(c => isValidElement(c) && c.type === "strong");
    return label(heading);
  });
  const boolean = choices.length === 2 && labels.includes("Off") && labels.includes("On");
  if (boolean) {
    const on = choices[labels.indexOf("On")]!;
    const off = choices[labels.indexOf("Off")]!;
    const checked = on.props["aria-checked"] === true;
    return <div className="lc-settings-switch-row">
      <button type="button" role="switch" aria-label={props["aria-label"]} aria-checked={checked}
        className="lc-settings-switch" disabled={on.props.disabled || off.props.disabled}
        onClick={checked ? off.props.onClick : on.props.onClick}><span aria-hidden="true" /></button>
    </div>;
  }
  const radio = props.role === "radiogroup";
  const segmented = radio && choices.length === 2;
  const pills = radio && !segmented && className.includes("compact");
  const switches = choices.some(choice => choice.props.role === "switch");
  const presentation = radio ? segmented ? "is-segmented" : pills ? "is-pills" : "is-radio-list" : switches ? "is-switch-list" : "is-palette-tags";
  const selected = choices.findIndex(choice => choice.props["aria-checked"] === true);
  const focusable = selected >= 0 ? selected : choices.findIndex(choice => !choice.props.disabled);
  let caption: ReactNode = null;
  const rendered = choices.map((choice, index) => {
    if (!radio) return choice;
    const contents = Children.toArray(choice.props.children);
    const description = contents.find(child => isValidElement<{ className?: string }>(child) && child.props.className?.includes("lc-muted"));
    const checked = choice.props["aria-checked"] === true;
    if (segmented && checked) caption = description;
    return cloneElement(choice, {
      tabIndex: index === focusable ? 0 : -1,
      ...(segmented ? { children: contents.filter(child => child !== description) } : {}),
    });
  });
  return <div className="lc-settings-choice-block">
    <div {...props} className={`${className} ${presentation}`} onKeyDown={event => {
      props.onKeyDown?.(event);
      if (!radio || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      buttons[index]?.focus(); buttons[index]?.click();
    }}>{rendered}</div>
    {caption && <div className="lc-settings-choice-caption">{caption}</div>}
  </div>;
}
