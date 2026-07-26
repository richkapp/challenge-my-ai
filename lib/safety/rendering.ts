export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function inertText(input: string): string {
  return escapeHtml(input).replace(/https?:\/\/\S+/g, "[link shown inertly]");
}
