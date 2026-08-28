/** One labeled line in a Settings diagnose dump. */
export type SettingsFact = {
  label?: string;
  value: string;
  tone?: "ok" | "warn" | "name";
};
