/** `two-sum` → `Two Sum`, matching `title_from_slug` in the daemon's generator. */
export function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((word) => (word.length > 0 ? word[0].toUpperCase() + word.slice(1) : ""))
    .join(" ");
}
