import { z } from 'zod';

const id = z.string().min(1).max(200);
const expectedRev = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const limit = z.number().int().min(1).max(500).optional();
export const emailAddress = z.string().email().transform(value => value.toLowerCase());
export const requestedPrincipal = z.union([
  z.object({ issuer: z.string().url(), sub: z.string().min(1), email: emailAddress.optional() }).strict(),
  z.object({ email: emailAddress }).strict(),
]);
export const requestedFrom = z.array(requestedPrincipal).max(100);
export type RequestedPrincipal = z.infer<typeof requestedPrincipal>;
// Other record fields remain extensible; identity requests are validated on writes.
export const recordPatch = z.object({ requestedFrom: requestedFrom.optional(), waitingOnYou: z.never().optional() }).catchall(z.unknown());
export const schemas = {
  list_records: z.object({ prefix: z.string().max(200).optional(), limit }).strict(),
  get_record: z.object({ id }).strict(),
  upsert_record: z.object({ id, expectedRev, patch: recordPatch }).strict(),
  check_record: z.object({
    id, expectedRev, result: z.string().min(1).max(4000),
    source: z.enum(['slack', 'github', 'api', 'manual']),
    sourceRef: z.string().min(1).max(2000).optional(),
    claimedAt: z.string().datetime({ offset: true }).optional(),
    evidence: z.array(z.string().max(2000)).max(50).optional(),
  }).strict(),
  get_audit: z.object({ recordId: id.optional(), limit }).strict(),
};
export type Tool = keyof typeof schemas;
export type Capability = 'supervisor:read' | 'supervisor:write';
export type Identity = { issuer: string; sub: string; email: string; clientId: string | null; capabilities: Capability[] };
export const isWrite = (tool: Tool) => tool === 'upsert_record' || tool === 'check_record';
export class StoreError extends Error {
  constructor(public code: string, public currentRev?: number) { super(code); }
}
export type RecordValue = { id: string; data: Record<string, unknown>; rev: number; checkedAt: string | null; updatedAt: string };
