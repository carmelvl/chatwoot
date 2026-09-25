/**
 * Kita's old email domain maps to the current one (EMAIL_DOMAIN_ALIASES="usekita.com=kita.ai,…",
 * default usekita.com=kita.ai), so suraaj@usekita.com in Slack matches the desk's suraaj@kita.ai.
 * The desk applies the same rule (Kita::Bridge.normalize_email).
 */
export function normalizeEmail(email: string, aliases = process.env.EMAIL_DOMAIN_ALIASES ?? 'usekita.com=kita.ai'): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return e;
  const map = new Map(aliases.split(',').map((p) => p.trim().toLowerCase().split('=') as [string, string]));
  const domain = e.slice(at + 1);
  return `${e.slice(0, at)}@${map.get(domain) ?? domain}`;
}
