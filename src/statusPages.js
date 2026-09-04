'use strict';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_MONITORS_PER_PAGE = 200;

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function rowToStatusPage(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    branding: parseJson(row.branding_json, {}),
    is_public: Boolean(row.is_public),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createStatusPagesRepo(db) {
  const statements = {
    all: db.prepare('SELECT * FROM status_pages ORDER BY id ASC'),
    bySlug: db.prepare('SELECT * FROM status_pages WHERE slug = ?'),
    byId: db.prepare('SELECT * FROM status_pages WHERE id = ?'),
    insert: db.prepare(
      `INSERT INTO status_pages (slug, title, description, branding_json, is_public, created_at, updated_at)
       VALUES (@slug, @title, @description, @branding_json, @is_public, @created_at, @updated_at)`
    ),
    update: db.prepare(
      `UPDATE status_pages SET slug = @slug, title = @title, description = @description,
         branding_json = @branding_json, is_public = @is_public, updated_at = @updated_at
       WHERE id = @id`
    ),
    remove: db.prepare('DELETE FROM status_pages WHERE id = ?'),
    monitorsForPage: db.prepare(
      'SELECT service_id FROM status_page_monitors WHERE status_page_id = ? ORDER BY service_id ASC'
    ),
    clearMonitors: db.prepare('DELETE FROM status_page_monitors WHERE status_page_id = ?'),
    addMonitor: db.prepare(
      'INSERT OR IGNORE INTO status_page_monitors (status_page_id, service_id) VALUES (?, ?)'
    ),
    pagesForService: db.prepare(
      'SELECT status_page_id FROM status_page_monitors WHERE service_id = ?'
    ),
  };

  function getMonitorIds(pageId) {
    return statements.monitorsForPage.all(pageId).map((r) => r.service_id);
  }

  return {
    list() {
      return statements.all.all().map(rowToStatusPage);
    },
    get(id) {
      return rowToStatusPage(statements.byId.get(id));
    },
    getBySlug(slug) {
      return rowToStatusPage(statements.bySlug.get(slug));
    },
    validate(input, opts = {}) {
      const errors = [];
      const value = {};
      if (input.slug !== undefined) {
        if (typeof input.slug !== 'string' || !SLUG_RE.test(input.slug)) {
          errors.push('slug must be 1-64 chars, lowercase letters, digits, hyphens, starting with a letter or digit');
        } else {
          value.slug = input.slug;
        }
      } else if (opts.requireCore) {
        errors.push('slug is required');
      }
      if (input.title !== undefined) {
        if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.length > 200) {
          errors.push('title must be 1-200 characters');
        } else {
          value.title = input.title.trim();
        }
      } else if (opts.requireCore) {
        errors.push('title is required');
      }
      if (input.description !== undefined) {
        if (input.description !== null && typeof input.description !== 'string') {
          errors.push('description must be a string or null');
        } else if (input.description !== null && input.description.length > 2000) {
          errors.push('description must be at most 2000 characters');
        } else {
          value.description = input.description || null;
        }
      }
      if (input.branding !== undefined) {
        if (typeof input.branding !== 'object' || input.branding === null || Array.isArray(input.branding)) {
          errors.push('branding must be an object');
        } else {
          const allowedKeys = ['title', 'logo_url', 'background_color', 'text_color', 'accent_color'];
          const branding = {};
          for (const key of allowedKeys) {
            if (input.branding[key] !== undefined) {
              if (typeof input.branding[key] !== 'string') {
                errors.push(`branding.${key} must be a string`);
              } else {
                branding[key] = String(input.branding[key]).slice(0, 500);
              }
            }
          }
          value.branding = branding;
        }
      }
      if (input.is_public !== undefined) {
        if (typeof input.is_public !== 'boolean') {
          errors.push('is_public must be a boolean');
        } else {
          value.is_public = input.is_public;
        }
      }
      if (input.monitor_ids !== undefined) {
        if (!Array.isArray(input.monitor_ids)) {
          errors.push('monitor_ids must be an array of service ids');
        } else if (input.monitor_ids.length > MAX_MONITORS_PER_PAGE) {
          errors.push(`monitor_ids must contain at most ${MAX_MONITORS_PER_PAGE} monitors`);
        } else if (input.monitor_ids.some((id) => !Number.isInteger(Number(id)) || Number(id) <= 0)) {
          errors.push('monitor_ids must contain positive integer ids');
        } else {
          value.monitor_ids = input.monitor_ids.map((id) => Number(id));
        }
      }
      return { errors, value };
    },
    create(data) {
      const now = Date.now();
      const info = statements.insert.run({
        slug: data.slug,
        title: data.title,
        description: data.description || null,
        branding_json: JSON.stringify(data.branding || {}),
        is_public: data.is_public === false ? 0 : 1,
        created_at: now,
        updated_at: now,
      });
      const page = this.get(info.lastInsertRowid);
      if (data.monitor_ids && data.monitor_ids.length > 0) {
        const insert = db.prepare('INSERT OR IGNORE INTO status_page_monitors (status_page_id, service_id) VALUES (?, ?)');
        const tx = db.transaction((ids) => {
          for (const id of ids) insert.run(page.id, id);
        });
        tx(data.monitor_ids);
      }
      return this.get(page.id);
    },
    update(id, patch) {
      const existing = this.get(id);
      if (!existing) return null;
      const merged = {
        slug: patch.slug !== undefined ? patch.slug : existing.slug,
        title: patch.title !== undefined ? patch.title : existing.title,
        description: patch.description !== undefined ? patch.description : existing.description,
        branding: patch.branding !== undefined ? patch.branding : existing.branding,
        is_public: patch.is_public !== undefined ? patch.is_public : existing.is_public,
      };
      statements.update.run({
        id,
        slug: merged.slug,
        title: merged.title,
        description: merged.description,
        branding_json: JSON.stringify(merged.branding || {}),
        is_public: merged.is_public === false ? 0 : 1,
        updated_at: Date.now(),
      });
      if (patch.monitor_ids !== undefined) {
        const tx = db.transaction((ids) => {
          statements.clearMonitors.run(id);
          for (const sid of ids) statements.addMonitor.run(id, sid);
        });
        tx(patch.monitor_ids);
      }
      return this.get(id);
    },
    remove(id) {
      const changes = statements.remove.run(id).changes;
      if (changes > 0) statements.clearMonitors.run(id);
      return changes > 0;
    },
    getMonitorIds,
    setMonitors(pageId, serviceIds) {
      const tx = db.transaction((ids) => {
        statements.clearMonitors.run(pageId);
        for (const sid of ids) statements.addMonitor.run(pageId, sid);
      });
      tx([...new Set(serviceIds)]);
    },
    pagesForService(serviceId) {
      return statements.pagesForService.all(serviceId).map((r) => r.status_page_id);
    },
  };
}

module.exports = { createStatusPagesRepo, SLUG_RE };
