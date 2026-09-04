/**
 * Shared name field for first Save and library-row / new-note naming.
 */

interface PadNameFieldProps {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  label?: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  onBlur?: () => void;
}

export function PadNameField({
  value,
  placeholder,
  disabled,
  autoFocus,
  label = "Name",
  onChange,
  onSubmit,
  onBlur,
}: PadNameFieldProps) {
  return (
    <label className="lc-md-new-title">
      <span className="lc-muted">{label}</span>
      <input
        type="text"
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || disabled) return;
          event.preventDefault();
          onSubmit?.();
        }}
      />
    </label>
  );
}
