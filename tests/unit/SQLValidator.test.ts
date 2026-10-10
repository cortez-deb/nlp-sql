/**
 * tests/unit/SQLValidator.test.ts
 */

import { SQLValidator } from '../../src/validation/SQLValidator';

describe('SQLValidator', () => {
  let validator: SQLValidator;

  beforeEach(() => {
    validator = new SQLValidator();
  });

  describe('ACCEPT cases', () => {
    it('accepts plain select with join', () => {
      const res = validator.validate('SELECT orders.id, customers.name FROM orders JOIN customers ON orders.customer_id = customers.id');
      expect(res.isValid).toBe(true);
      expect(res.reason).toBeNull();
    });

    it('accepts CTE queries', () => {
      const res = validator.validate('WITH x AS (SELECT id, total FROM orders) SELECT id, total FROM x');
      expect(res.isValid).toBe(true);
    });

    it('accepts window functions', () => {
      const res = validator.validate('SELECT id, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY total DESC) AS rn FROM orders');
      expect(res.isValid).toBe(true);
    });

    it('accepts UNION ALL queries', () => {
      const res = validator.validate('SELECT id FROM orders UNION ALL SELECT id FROM archive_orders');
      expect(res.isValid).toBe(true);
    });

    it('accepts subquery with inner LIMIT', () => {
      const res = validator.validate('SELECT * FROM (SELECT id FROM orders LIMIT 5) AS sub');
      expect(res.isValid).toBe(true);
    });

    it('accepts SELECT REPLACE(name, "a", "b")', () => {
      const res = validator.validate('SELECT REPLACE(name, "a", "b") FROM customers');
      expect(res.isValid).toBe(true);
    });

    it('accepts WHERE status = "Delete"', () => {
      const res = validator.validate("SELECT * FROM items WHERE status = 'Delete'");
      expect(res.isValid).toBe(true);
    });

    it('accepts columns named update_count', () => {
      const res = validator.validate('SELECT update_count, insertion_date FROM audit_logs');
      expect(res.isValid).toBe(true);
    });

    it('accepts trailing semicolon', () => {
      const res = validator.validate('SELECT id FROM orders;');
      expect(res.isValid).toBe(true);
    });
  });

  describe('REJECT cases with kind assertions', () => {
    it('rejects multiple statements', () => {
      const res = validator.validate('SELECT 1; DROP TABLE t');
      expect(res.isValid).toBe(false);
      expect(res.kind).toBeDefined();
    });

    it('rejects version comments /*! ... */', () => {
      const res = validator.validate("SELECT * FROM t /*!50000 INTO OUTFILE '/tmp/x' */");
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('forbidden');
    });

    it('rejects SLEEP function', () => {
      const res = validator.validate('SELECT SLEEP(5)');
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('forbidden');
    });

    it('rejects BENCHMARK function', () => {
      const res = validator.validate("SELECT BENCHMARK(1e9, MD5('a'))");
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('forbidden');
    });

    it('rejects LOAD_FILE function', () => {
      const res = validator.validate("SELECT LOAD_FILE('/etc/passwd')");
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('forbidden');
    });

    it('rejects INTO OUTFILE', () => {
      const res = validator.validate("SELECT * FROM orders INTO OUTFILE '/tmp/out'");
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('forbidden');
    });

    it('rejects FOR UPDATE locking clause', () => {
      const res = validator.validate('SELECT * FROM orders FOR UPDATE');
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('forbidden');
    });

    it('rejects information_schema queries', () => {
      const res = validator.validate('SELECT * FROM information_schema.tables');
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('forbidden');
    });

    it('rejects mysql.user queries', () => {
      const res = validator.validate('SELECT * FROM mysql.user');
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('forbidden');
    });

    it('rejects internal nlsql tables', () => {
      const res = validator.validate('SELECT * FROM nlsql_enriched_schema');
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('forbidden');
    });

    it('rejects database schema mismatch', () => {
      const res = validator.validate('SELECT * FROM otherdb.t', { allowedDatabase: 'mydb' });
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('forbidden');
    });

    it('rejects tables not in allowedTables', () => {
      const res = validator.validate('SELECT * FROM secret_table', { allowedTables: ['orders', 'customers'] });
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('forbidden');
    });

    it('rejects variable assignment', () => {
      const res = validator.validate('SELECT @a := 1');
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('forbidden');
    });

    it('rejects SHOW TABLES', () => {
      const res = validator.validate('SHOW TABLES');
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('forbidden');
    });

    it('rejects UPDATE statements', () => {
      const res = validator.validate("UPDATE orders SET status = 'shipped'");
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('forbidden');
    });

    it('returns syntax kind for unparsable garbage', () => {
      const res = validator.validate('SELECT FROM WHERE !!!');
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('syntax');
    });

    it('returns unable kind for -- UNABLE_TO_ANSWER sentinel', () => {
      const res = validator.validate('-- UNABLE_TO_ANSWER: no such data');
      expect(res.isValid).toBe(false);
      expect(res.kind).toBe('unable');
      expect(res.reason).toBe('no such data');
    });
  });
});
