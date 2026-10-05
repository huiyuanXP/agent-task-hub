import { resolve } from 'node:path';
import { openDatabase, type LocalDatabase } from './database.mts';
// Native entrypoint and bundled route modules share the same owned handles.
const runtime=globalThis as typeof globalThis & { __localTaskHubStores?: Map<string,LocalDatabase> };
const stores=runtime.__localTaskHubStores ??= new Map<string,LocalDatabase>();
export function database():LocalDatabase {
  const file=resolve(/* turbopackIgnore: true */ process.env.APP_DB_PATH ?? '.local/data.sqlite');
  let db=stores.get(file);
  if(!db){db=openDatabase(file);stores.set(file,db);}
  return db;
}
export function closeDatabases(){for(const db of stores.values())db.close();stores.clear();}
