'use strict';

const crypto = require('crypto');

const KEY_PREFIX_LEN = 8;
const KEY_TOKEN_LEN = 32; // 256-bit random secret

function rowToApiKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    enabled: Boolean(row.enabled),
    created_at: row.created_at,
    last_used_at: row.last_used_at || null,
  };
}

function generateKeyPair() {
  const raw = crypto.randomBytes(KEY_TOKEN_LEN).toString('base64url');
  const key = `${raw}`;
  const prefix = raw.slice(0, KEY_PREFIX_LEN);
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return { key, prefix, hash };
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function createApiKeysRepo(db) {
  const statements = {
    all: db.prepare('SELECT * FROM api_keys ORDER BY id ASC'),
    byId: db.prepare('SELECT * FROM api_keys WHERE id = ?'),
    byHash: db.prepare('SELECT * FROM api_keys WHERE key_hash = ?'),
    insert: db.prepare(
      `INSERT INTO api_keys (name, key_prefix, key_hash, enabled, created_at, last_used_at)
       VALUES (@name, @key_prefix, @key_hash, @enabled, @created_at, @last_used_at)`
    ),
    updateEnabled: db.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?'),
    touch: db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM api_keys WHERE id = ?'),
  };

  return {
    list() {
      return statements.all.all().map(rowToApiKey);
    },
    get(id) {
      return rowToApiKey(statements.byId.get(id));
    },
    create({ name }) {
      const { key, prefix, hash } = generateKeyPair();
      const now = Date.now();
      const info = statements.insert.run({
        name,
        key_prefix: prefix,
        key_hash: hash,
        enabled: 1,
        created_at: now,
        last_used_at: null,
      });
      const record = this.get(info.lastInsertRowid);
      return { ...record, key };
    },
    validate(input) {
      const errors = [];
      if (!input || typeof input.name !== 'string' || input.name.trim().length === 0) {
        errors.push('name is required');
      } else if (input.name.length > 200) {
        errors.push('name must be at most 200 characters');
      }
      return { errors };
    },
    disable(id, enabled) {
      return statements.updateEnabled.run(enabled ? 1 : 0, id).changes > 0;
    },
    enable(id) {
      return this.disable(id, true);
    },
    remove(id) {
      return statements.remove.run(id).changes > 0;
    },
    findByKey(key) {
      if (!key || typeof key !== 'string') return null;
      const hash = hashKey(key);
      const row = statements.byHash.get(hash);
      if (!row) return null;
      return rowToApiKey(row);
    },
    touch(id) {
      statements.touch.run(Date.now(), id);
    },
    hashKey,
  };
}

module.exports = { createApiKeysRepo, generateKeyPair };
