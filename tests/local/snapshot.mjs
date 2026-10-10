import { DatabaseSync } from 'node:sqlite';
// Preserve even deliberately corrupt wide integer storage in readonly comparisons.
export function snapshotTables(file){
 const sqlite=new DatabaseSync(file,{readOnly:true});
 try{
  const result={};
  for(const {name} of sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
   const statement=sqlite.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`);statement.setReadBigInts(true);result[name]=statement.all();
  }
  return result;
 }finally{sqlite.close();}
}
