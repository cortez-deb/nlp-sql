import { Pool, PoolClient } from 'pg';


export interface MemoryContext {
  ownerId: string;
}

export interface Fact {
  key: string;
  value: any;
  source?: string;
  updated_at: Date;
}

export interface Preference {
  scope: string;
  value: any;
  updated_at: Date;
}

export interface Episode {
  id: number;
  ts: Date;
  question: string;
  sql_text: string;
  topic_summary: string;
}

export interface MemoryStore {
  initialise(): Promise<void>;
  close(): Promise<void>;
  
  getFact(ctx: MemoryContext, key: string): Promise<any>;
  setFact(ctx: MemoryContext, key: string, value: any, source?: string): Promise<void>;
  listFacts(ctx: MemoryContext): Promise<Fact[]>;
  deleteFact(ctx: MemoryContext, key: string): Promise<void>;
  
  getPreferences(ctx: MemoryContext, scope: string): Promise<any>;
  setPreferences(ctx: MemoryContext, scope: string, partialValue: any): Promise<void>;
  
  appendEpisode(ctx: MemoryContext, ts: Date, question: string, sqlText: string, topicSummary: string): Promise<void>;
  listEpisodes(ctx: MemoryContext): Promise<Episode[]>;
  
  deleteAllForOwner(ctx: MemoryContext): Promise<void>;
  
  resolveOwner(chatId: string): Promise<string | null>;
  ensureIdentity(ownerId: string, chatId: string): Promise<void>;
}

export class PostgresMemoryStore implements MemoryStore {
  private pool: Pool;
  private isInitialised = false;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      // Minimal defaults. Could add min/max pool size from config later.
    });
    this.pool.on('error', (err) => {
      console.error('Unexpected error on idle pg client', err.message);
    });
  }

  async initialise(): Promise<void> {
    if (this.isInitialised) return;
    
    // We do NOT use RLS for migrations, we use a normal client
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS bot_memory_schema_version (
          version INTEGER PRIMARY KEY
        );
      `);
      
      const { rows } = await client.query('SELECT MAX(version) as v FROM bot_memory_schema_version');
      let currentVersion = rows[0]?.v || 0;
      
      if (currentVersion < 1) {
        await client.query(`
          CREATE TABLE bot_memory_identities (
            chat_id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL
          );
          
          CREATE TABLE bot_memory_facts (
            owner_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value_jsonb JSONB NOT NULL,
            source TEXT,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (owner_id, key)
          );

          CREATE TABLE bot_memory_preferences (
            owner_id TEXT NOT NULL,
            scope TEXT NOT NULL,
            value_jsonb JSONB NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (owner_id, scope)
          );

          CREATE TABLE bot_memory_episodes (
            id SERIAL PRIMARY KEY,
            owner_id TEXT NOT NULL,
            ts TIMESTAMP WITH TIME ZONE NOT NULL,
            question TEXT NOT NULL,
            sql_text TEXT NOT NULL,
            topic_summary TEXT NOT NULL,
            search_tsv TSVECTOR
          );
          
          CREATE INDEX bot_memory_episodes_search_idx ON bot_memory_episodes USING GIN (search_tsv);
        `);

        // Enable RLS on data tables
        const tables = ['bot_memory_facts', 'bot_memory_preferences', 'bot_memory_episodes'];
        for (const t of tables) {
          await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
          await client.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`);
          // The policy checks the session variable 'app.owner_id'
          await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_policies
                    WHERE tablename = '${t}' AND policyname = '${t}_owner_policy'
                ) THEN
                    CREATE POLICY ${t}_owner_policy ON ${t}
                    FOR ALL
                    USING (owner_id = current_setting('app.owner_id', true))
                    WITH CHECK (owner_id = current_setting('app.owner_id', true));
                END IF;
            END
            $$;
          `);
        }
        
        await client.query('INSERT INTO bot_memory_schema_version (version) VALUES (1)');
      }
      
      await client.query('COMMIT');
      this.isInitialised = true;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Executes a block of DB operations inside a transaction with RLS set to the ownerId
   */
  private async withOwner<T>(ctx: MemoryContext, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.isInitialised) throw new Error('Memory store not initialised');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Set the session variable for RLS, local to this transaction
      await client.query('SELECT set_config($1, $2, true)', ['app.owner_id', ctx.ownerId]);
      
      const result = await fn(client);
      
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getFact(ctx: MemoryContext, key: string): Promise<any> {
    return this.withOwner(ctx, async (client) => {
      const res = await client.query('SELECT value_jsonb FROM bot_memory_facts WHERE key = $1', [key]);
      if (res.rows.length === 0) return undefined;
      return res.rows[0].value_jsonb;
    });
  }

  async setFact(ctx: MemoryContext, key: string, value: any, source?: string): Promise<void> {
    await this.withOwner(ctx, async (client) => {
      await client.query(`
        INSERT INTO bot_memory_facts (owner_id, key, value_jsonb, source, updated_at) 
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT (owner_id, key) DO UPDATE SET 
          value_jsonb = EXCLUDED.value_jsonb,
          source = EXCLUDED.source,
          updated_at = CURRENT_TIMESTAMP
      `, [ctx.ownerId, key, JSON.stringify(value), source || null]);
    });
  }

  async listFacts(ctx: MemoryContext): Promise<Fact[]> {
    return this.withOwner(ctx, async (client) => {
      const res = await client.query('SELECT key, value_jsonb, source, updated_at FROM bot_memory_facts ORDER BY updated_at DESC');
      return res.rows.map(r => ({
        key: r.key,
        value: r.value_jsonb,
        source: r.source,
        updated_at: r.updated_at
      }));
    });
  }

  async deleteFact(ctx: MemoryContext, key: string): Promise<void> {
    await this.withOwner(ctx, async (client) => {
      await client.query('DELETE FROM bot_memory_facts WHERE key = $1', [key]);
    });
  }

  async getPreferences(ctx: MemoryContext, scope: string): Promise<any> {
    return this.withOwner(ctx, async (client) => {
      const res = await client.query('SELECT value_jsonb FROM bot_memory_preferences WHERE scope = $1', [scope]);
      if (res.rows.length === 0) return {};
      return res.rows[0].value_jsonb;
    });
  }

  async setPreferences(ctx: MemoryContext, scope: string, partialValue: any): Promise<void> {
    await this.withOwner(ctx, async (client) => {
      // Postgres JSONB concatenation operator (||) merges objects at the top level
      await client.query(`
        INSERT INTO bot_memory_preferences (owner_id, scope, value_jsonb, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (owner_id, scope) DO UPDATE SET
          value_jsonb = bot_memory_preferences.value_jsonb || EXCLUDED.value_jsonb,
          updated_at = CURRENT_TIMESTAMP
      `, [ctx.ownerId, scope, JSON.stringify(partialValue)]);
    });
  }

  async appendEpisode(ctx: MemoryContext, ts: Date, question: string, sqlText: string, topicSummary: string): Promise<void> {
    await this.withOwner(ctx, async (client) => {
      await client.query(`
        INSERT INTO bot_memory_episodes (owner_id, ts, question, sql_text, topic_summary)
        VALUES ($1, $2, $3, $4, $5)
      `, [ctx.ownerId, ts, question, sqlText, topicSummary]);
    });
  }

  async listEpisodes(ctx: MemoryContext): Promise<Episode[]> {
    return this.withOwner(ctx, async (client) => {
      const res = await client.query('SELECT id, ts, question, sql_text, topic_summary FROM bot_memory_episodes ORDER BY ts DESC');
      return res.rows;
    });
  }

  async deleteAllForOwner(ctx: MemoryContext): Promise<void> {
    await this.withOwner(ctx, async (client) => {
      await client.query('DELETE FROM bot_memory_facts');
      await client.query('DELETE FROM bot_memory_preferences');
      await client.query('DELETE FROM bot_memory_episodes');
    });
  }

  async resolveOwner(chatId: string): Promise<string | null> {
    // No RLS here, just looking up global identity mappings
    const client = await this.pool.connect();
    try {
      const res = await client.query('SELECT owner_id FROM bot_memory_identities WHERE chat_id = $1', [chatId]);
      return res.rows.length > 0 ? res.rows[0].owner_id : null;
    } finally {
      client.release();
    }
  }

  async ensureIdentity(ownerId: string, chatId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        INSERT INTO bot_memory_identities (chat_id, owner_id)
        VALUES ($1, $2)
        ON CONFLICT (chat_id) DO NOTHING
      `, [chatId, ownerId]);
    } finally {
      client.release();
    }
  }
}

export class NoopMemoryStore implements MemoryStore {
  async initialise(): Promise<void> {}
  async close(): Promise<void> {}
  
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getFact(ctx: MemoryContext, key: string): Promise<any> { return undefined; }
  
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async setFact(ctx: MemoryContext, key: string, value: any, source?: string): Promise<void> {}
  
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async listFacts(ctx: MemoryContext): Promise<Fact[]> { return []; }
  
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async deleteFact(ctx: MemoryContext, key: string): Promise<void> {}
  
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getPreferences(ctx: MemoryContext, scope: string): Promise<any> { return {}; }
  
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async setPreferences(ctx: MemoryContext, scope: string, partialValue: any): Promise<void> {}
  
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async appendEpisode(ctx: MemoryContext, ts: Date, question: string, sqlText: string, topicSummary: string): Promise<void> {}
  
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async listEpisodes(ctx: MemoryContext): Promise<Episode[]> { return []; }
  
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async deleteAllForOwner(ctx: MemoryContext): Promise<void> {}
  
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async resolveOwner(chatId: string): Promise<string | null> { return null; }
  
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async ensureIdentity(ownerId: string, chatId: string): Promise<void> {}
}
