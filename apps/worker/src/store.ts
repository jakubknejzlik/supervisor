import { DurableObject } from 'cloudflare:workers';
import { effectiveCategory } from '@supervisor/core/category';
import { schemas, isWrite, StoreError, type Tool, type Identity, type RecordValue } from '@supervisor/core/schema';

type Row = { id: string; data: string; rev: number; checkedAt: string | null; updatedAt: string };
type Audit = { seq: number; at: string; actor: string; clientId: string | null; source: string | null; tool: string; recordId: string; fromRev: number; toRev: number; changedFields: string; note: string | null };
const decode = ({ id, data, rev, checkedAt, updatedAt }: Row): RecordValue => ({ id, data: JSON.parse(data), rev, checkedAt, updatedAt });

export type StoreEnv = {};
export class SupervisorStore extends DurableObject<StoreEnv> {
  constructor(ctx: DurableObjectState, env: StoreEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, data JSON NOT NULL, rev INTEGER NOT NULL,
      checkedAt TEXT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL, actor TEXT NOT NULL, tool TEXT NOT NULL, recordId TEXT NOT NULL,
      fromRev INTEGER NOT NULL, toRev INTEGER NOT NULL, changedFields JSON NOT NULL, note TEXT);`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS store_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
      INSERT OR IGNORE INTO store_state(singleton,version) VALUES(1,0);`);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // Preserve historical audit attribution when adding optional columns.
    const columns = ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(audit)').toArray();
    for (const name of ['source', 'clientId']) {
      if (!columns.some(column => column.name === name)) ctx.storage.sql.exec(`ALTER TABLE audit ADD COLUMN ${name} TEXT`);
    }
  }
  private state() {
    return this.ctx.storage.sql.exec<{ version: number }>('SELECT version FROM store_state WHERE singleton=1').one();
  }
  private bump() {
    this.ctx.storage.sql.exec('UPDATE store_state SET version=version+1 WHERE singleton=1');
    return this.state().version;
  }
  private async broadcast(version: number, ids: string[]) {
    // Failed writes never reach this path. Bound invalidation hints; all clients
    // refetch the full snapshot, including when ids is empty.
    await this.ctx.storage.sync();
    const event = JSON.stringify({ type: 'changed', version, ids: ids.length <= 100 ? ids : [] });
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(event); } catch { try { socket.close(1011, 'Reconnect'); } catch { /* already closed */ } }
    }
  }
  async fetch(request: Request) {
    if (new URL(request.url).pathname !== '/api/ws') return new Response(null, { status: 404 });
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    // Closes the snapshot -> subscribe race, including after reconnect.
    server.send(JSON.stringify({ type: 'changed', version: this.state().version, ids: [] }));
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer) { socket.close(1008, 'Only ping is supported'); }
  webSocketClose(socket: WebSocket, code: number, reason: string) {
    if (code !== 1006) socket.close(code === 1005 ? undefined : code, reason);
  }
  webSocketError(socket: WebSocket) { socket.close(1011, 'Reconnect'); }
  private row(id: string) {
    return this.ctx.storage.sql.exec<Row>('SELECT * FROM records WHERE id = ?', id).toArray()[0];
  }
  async call(tool: Tool, raw: unknown, identity: Identity): Promise<string> {
    try { return JSON.stringify({ value: await this.execute(tool, raw, identity) }); }
    catch (error) {
      if (error instanceof StoreError) return JSON.stringify({ error: { error: error.code, ...(error.currentRev !== undefined ? { currentRev: error.currentRev } : {}) } });
      if (error instanceof Error && error.name === 'ZodError') return JSON.stringify({ error: { error: 'invalid_arguments' } });
      throw error;
    }
  }
  // Only the authenticated Worker can invoke RPC or forward a WS upgrade.
  async execute(tool: Tool, raw: unknown, identity: Identity) {
    if (!Object.hasOwn(schemas, tool)) throw new StoreError('unknown_tool');
    const capability = isWrite(tool) ? 'supervisor:write' : 'supervisor:read';
    if (!identity.capabilities.includes(capability)) throw new StoreError('insufficient_scope');
    const args = schemas[tool].parse(raw);
    const sql = this.ctx.storage.sql;
    if (tool === 'list_records') {
      const { prefix = '', category, limit = 100 } = args as { prefix?: string; category?: string; limit?: number };
      // instr treats %/_ literally and handles Unicode prefixes without JS length.
      if (category !== undefined) {
        return sql.exec<Row>('SELECT * FROM records WHERE instr(id, ?) = 1 ORDER BY id', prefix).toArray()
          .map(decode).filter(record => effectiveCategory(record.data) === category).slice(0, limit);
      }
      return sql.exec<Row>('SELECT * FROM records WHERE instr(id, ?) = 1 ORDER BY id LIMIT ?', prefix, limit).toArray().map(decode);
    }
    if (tool === 'get_record') {
      const row = this.row((args as { id: string }).id);
      if (!row) throw new StoreError('record_not_found');
      return decode(row);
    }
    if (tool === 'get_audit') {
      const { recordId, limit = 100 } = args as { recordId?: string; limit?: number };
      return sql.exec<Audit>('SELECT * FROM audit WHERE (? IS NULL OR recordId = ?) ORDER BY seq DESC LIMIT ?', recordId ?? null, recordId ?? null, limit).toArray().map(row => ({ ...row, changedFields: JSON.parse(row.changedFields) }));
    }
    const { id, expectedRev } = args as { id: string; expectedRev: number };
    if (tool === 'upsert_record') {
      const patch = (args as { patch: object }).patch;
      if (Object.hasOwn(patch, 'checkedAt') || Object.hasOwn(patch, 'lastCheck')) throw new StoreError('checkedAt_requires_check_tool');
    }
    // Synchronous SQLite transaction: revision test, record and audit commit together.
    const result = this.ctx.storage.transactionSync(() => {
      const old = this.row(id);
      const currentRev = old?.rev ?? 0;
      if (expectedRev !== currentRev) throw new StoreError('rev_conflict', currentRev);
      if (tool === 'check_record' && !old) throw new StoreError('record_not_found');
      const at = new Date().toISOString();
      const data = old ? JSON.parse(old.data) : {};
      const check = args as import('zod').z.infer<typeof schemas.check_record>;
      const patch = tool === 'upsert_record' ? (args as { patch: Record<string, unknown> }).patch : {
        lastCheck: {
          result: check.result, source: check.source,
          ...(check.sourceRef !== undefined ? { sourceRef: check.sourceRef } : {}),
          ...(check.claimedAt !== undefined ? { claimedAt: check.claimedAt } : {}),
          evidence: check.evidence ?? [], recordedAt: at, actor: identity.email, clientId: identity.clientId,
        },
      };
      const merged = { ...data, ...patch };
      const checkedAt = tool === 'check_record' ? at : old?.checkedAt ?? null;
      const changedFields = Object.keys(patch).filter(key => JSON.stringify(data[key]) !== JSON.stringify(merged[key])).map(key => `data.${key}`).sort();
      if (tool === 'check_record') changedFields.push('checkedAt');
      changedFields.push('rev', 'updatedAt');
      sql.exec('INSERT INTO records (id, data, rev, checkedAt, updatedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, rev=excluded.rev, checkedAt=excluded.checkedAt, updatedAt=excluded.updatedAt', id, JSON.stringify(merged), currentRev + 1, checkedAt, at);
      sql.exec('INSERT INTO audit (at, actor, clientId, source, tool, recordId, fromRev, toRev, changedFields, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', at, identity.email, identity.clientId, tool === 'check_record' ? check.source : null, tool, id, currentRev, currentRev + 1, JSON.stringify(changedFields), tool === 'check_record' ? check.result : null);
      return { record: { id, data: merged, rev: currentRev + 1, checkedAt, updatedAt: at }, version: this.bump() };
    });
    await this.broadcast(result.version, [id]);
    return result.record;
  }
  async dashboard() {
    // This snapshot is one synchronous read, not the paginated MCP list default.
    return { ...this.state(), records: this.ctx.storage.sql.exec<Row>('SELECT * FROM records ORDER BY id').toArray().map(decode) };
  }
}
