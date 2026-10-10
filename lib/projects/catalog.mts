import { randomUUID } from 'node:crypto';
import type { LocalDatabase } from '../database.mts';

export interface ProjectEntry { id: string; name: string }

export async function ensureProject(db: LocalDatabase, owner: string, name: string): Promise<ProjectEntry> {
  await db.prepare('INSERT OR IGNORE INTO workspace_projects(id,owner,name,created_at) VALUES(?,?,?,?)')
    .bind(randomUUID(), owner, name, Date.now()).run();
  const row = await db.prepare('SELECT id,name FROM workspace_projects WHERE owner=? AND name=?')
    .bind(owner, name).first<ProjectEntry>();
  if (!row) throw Error('Project unavailable');
  return row;
}

export async function listProjects(db: LocalDatabase, owner: string): Promise<ProjectEntry[]> {
  // Reuse the existing stable identities, without changing business records.
  // History and manual Run snapshots must never create new project options.
  const names = await db.prepare("SELECT DISTINCT COALESCE(NULLIF(json_extract(body,'$.project'),''),'通用') AS name FROM records WHERE owner=? AND kind IN ('idea','plan','ticket') AND json_valid(body)")
    .bind(owner).all<{ name: unknown }>();
  for (const name of ['通用', ...names.results.map(row => row.name)]) {
    if (typeof name === 'string' && name.trim() && name.length <= 120 && !/[\u0000-\u001f\u007f]/.test(name)) {
      await ensureProject(db, owner, name);
    }
  }
  const projects = await db.prepare('SELECT id,name FROM workspace_projects WHERE owner=? ORDER BY name,id')
    .bind(owner).all<ProjectEntry>();
  return projects.results;
}
