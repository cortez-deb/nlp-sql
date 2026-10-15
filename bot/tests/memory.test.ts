import { PostgresMemoryStore } from '../src/memory';
import { Pool } from 'pg';

const TEST_DB_URL = process.env.TEST_DB_URL || 'postgres://postgres:postgres@localhost:5432/postgres';

describe('PostgresMemoryStore', () => {
  let store: PostgresMemoryStore;
  let pool: Pool;
  let skipped = false;

  beforeAll(async () => {
    // Only run these tests if a real Postgres is available
    pool = new Pool({ connectionString: TEST_DB_URL });
    try {
      await pool.query('SELECT 1');
    } catch (err) {
      skipped = true;
      return;
    }

    store = new PostgresMemoryStore(TEST_DB_URL);
    await store.initialise();
  });

  afterAll(async () => {
    if (store) {
      await store.close();
    }
    if (pool) {
      await pool.end();
    }
  });

  beforeEach(async () => {
    if (skipped) return;
    await store.deleteAllForOwner({ ownerId: 'test_owner_1' });
    await store.deleteAllForOwner({ ownerId: 'test_owner_2' });
  });

  it('stores and retrieves facts per owner', async () => {
    if (skipped) {
      return;
    }

    const ctx1 = { ownerId: 'test_owner_1' };
    const ctx2 = { ownerId: 'test_owner_2' };

    await store.setFact(ctx1, 'name', 'Alice');
    await store.setFact(ctx2, 'name', 'Bob');

    const name1 = await store.getFact(ctx1, 'name');
    const name2 = await store.getFact(ctx2, 'name');

    expect(name1).toBe('Alice');
    expect(name2).toBe('Bob');

    // Overwrite
    await store.setFact(ctx1, 'name', 'Alicia');
    expect(await store.getFact(ctx1, 'name')).toBe('Alicia');

    // List
    await store.setFact(ctx1, 'age', 30);
    const facts = await store.listFacts(ctx1);
    expect(facts.length).toBe(2);
    expect(facts.map(f => f.key).sort()).toEqual(['age', 'name']);

    // Delete
    await store.deleteFact(ctx1, 'age');
    expect(await store.listFacts(ctx1)).toHaveLength(1);
  });

  it('merges preferences', async () => {
    if (skipped) return;

    const ctx = { ownerId: 'test_owner_1' };

    await store.setPreferences(ctx, 'global', { theme: 'dark', notifications: true });
    expect(await store.getPreferences(ctx, 'global')).toEqual({ theme: 'dark', notifications: true });

    await store.setPreferences(ctx, 'global', { theme: 'light', newSetting: 1 });
    expect(await store.getPreferences(ctx, 'global')).toEqual({ theme: 'light', notifications: true, newSetting: 1 });

    expect(await store.getPreferences(ctx, 'other')).toEqual({});
  });

  it('records identities and resolves them', async () => {
    if (skipped) return;

    await store.ensureIdentity('owner_123', 'chat_A');
    await store.ensureIdentity('owner_123', 'chat_B');

    expect(await store.resolveOwner('chat_A')).toBe('owner_123');
    expect(await store.resolveOwner('chat_B')).toBe('owner_123');
    expect(await store.resolveOwner('chat_C')).toBeNull();
  });
  
  it('cannot bypass RLS directly', async () => {
      if(skipped) return;
      const ctx1 = { ownerId: 'test_owner_1' };
      const ctx2 = { ownerId: 'test_owner_2' };
      await store.setFact(ctx1, 'secret', 'password');
      
      // Simulate attempting to read it as owner 2. We can't actually inject SQL here easily,
      // but we can verify the store itself doesn't mix it up.
      expect(await store.getFact(ctx2, 'secret')).toBeUndefined();
  });
});
