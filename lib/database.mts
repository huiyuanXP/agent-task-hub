import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, chmodSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export type SqlValue = string | number | null;
export interface LocalStatement {
  bind(...values: SqlValue[]): LocalStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface LocalDatabase {
  prepare(sql: string): LocalStatement;
  batch(statements: LocalStatement[]): Promise<{ meta: { changes: number } }[]>;
  close(): void;
}
class Statement implements LocalStatement {
  readonly sqlite: DatabaseSync; readonly sql: string; readonly values: SqlValue[];
  constructor(sqlite: DatabaseSync, sql: string, values: SqlValue[] = []) { this.sqlite=sqlite; this.sql=sql; this.values=values; }
  bind(...values: SqlValue[]): LocalStatement { return new Statement(this.sqlite,this.sql,values); }
  async first<T>(): Promise<T | null> { return (this.sqlite.prepare(this.sql).get(...this.values) as T | undefined) ?? null; }
  async all<T>(): Promise<{results:T[]}> { return {results:this.sqlite.prepare(this.sql).all(...this.values) as T[]}; }
  execute() { return {meta:{changes:Number(this.sqlite.prepare(this.sql).run(...this.values).changes)}}; }
  async run() { return this.execute(); }
}
export function openDatabase(file: string, options: {migrationsPath?:string} = {}): LocalDatabase {
  if (file !== ':memory:') {
    const directory=dirname(resolve(file));
    if(!existsSync(directory)) mkdirSync(directory,{recursive:true,mode:0o700});
  }
  const existed=file === ':memory:' || existsSync(file);
  const sqlite=new DatabaseSync(file);
  let closed=false;
  try {
    if(!existed)chmodSync(file,0o600);
    sqlite.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)');
      const directory=options.migrationsPath ?? resolve(process.cwd(),'migrations');
      const names=readdirSync(/* turbopackIgnore: true */ directory).filter(name=>name.endsWith('.sql')).sort();
      const applied=sqlite.prepare('SELECT name,checksum FROM schema_migrations').all() as {name:string;checksum:string}[];
      for(const row of applied)if(!names.includes(row.name))throw Error(`Missing applied schema: ${row.name}`);
      for(const name of names){
        const sql=readFileSync(/* turbopackIgnore: true */ resolve(directory,name),'utf8');
        const checksum=createHash('sha256').update(sql).digest('hex');
        const previous=applied.find(row=>row.name===name);
        if(previous){if(previous.checksum!==checksum)throw Error(`Schema checksum mismatch: ${name}`);continue;}
        sqlite.exec(sql);
        sqlite.prepare('INSERT INTO schema_migrations(name,checksum,applied_at) VALUES(?,?,?)').run(name,checksum,Date.now());
      }
      sqlite.exec('COMMIT');
    } catch(error){sqlite.exec('ROLLBACK');throw error;}
  } catch(error){sqlite.close();throw error;}
  return {
    prepare(sql){return new Statement(sqlite,sql);},
    async batch(statements){
      sqlite.exec('BEGIN IMMEDIATE');
      try{
        const results=statements.map(statement=>{
          if(!(statement instanceof Statement)||statement.sqlite!==sqlite)throw Error('Statement belongs to another database');
          return statement.execute();
        });
        sqlite.exec('COMMIT');return results;
      }catch(error){sqlite.exec('ROLLBACK');throw error;}
    },
    close(){if(!closed){closed=true;sqlite.close();}},
  };
}
