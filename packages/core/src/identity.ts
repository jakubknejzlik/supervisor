import { emailAddress, requestedFrom, type Identity } from './schema';

// Presentation only. Authorization capabilities are enforced separately.
export function waitingOnYou(data: Record<string, unknown>, viewer?: Identity): boolean {
  if (!viewer || !viewer.issuer || !viewer.sub || ['done', 'paused', 'deferred', 'backlog'].includes(String(data.state))) return false;
  const parsed = requestedFrom.safeParse(data.requestedFrom);
  if (!parsed.success) return false;
  const email = emailAddress.safeParse(viewer.email);
  return parsed.data.some(principal => 'sub' in principal
    ? principal.issuer === viewer.issuer && principal.sub === viewer.sub
    : email.success && principal.email === email.data);
}
