import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../lib/database.mts';

test('persistent SQLite batches rollback atomically and owner compare-and-swap never crosses owners', async () => {
  const dir=mkdtempSync(join(tmpdir(),'hub-db-')); const file=join(dir,'private','data.sqlite'); let db;
  try {
    db=openDatabase(file);
    const insert=db.prepare("INSERT INTO records(id,owner,kind,body,revision,created,updated) VALUES (?,?, 'idea','{}',1,'now','now')");
    await db.batch([insert.bind('one','alice'),insert.bind('two','bob')]);
    await assert.rejects(db.batch([insert.bind('three','alice'),insert.bind('one','alice')]));
    assert.equal(await db.prepare("SELECT id FROM records WHERE id='three'").first(),null);
    assert.equal((await db.prepare("UPDATE records SET revision=2 WHERE id='one' AND owner='bob' AND revision=1").run()).meta.changes,0);
    assert.equal((await db.prepare("UPDATE records SET revision=2 WHERE id='one' AND owner='alice' AND revision=1").run()).meta.changes,1);
    db.close(); db=openDatabase(file);
    assert.equal((await db.prepare("SELECT revision FROM records WHERE id='one'").first()).revision,2);
    assert.equal(statSync(file).mode & 0o077,0);
  } finally { db?.close(); rmSync(dir,{recursive:true,force:true}); }
});
test('schema checksum changes and failed migrations abort without partial schema', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'hub-schema-'));const schema=join(dir,'sql');mkdirSync(schema);const file=join(dir,'db.sqlite');let db;
 try{writeFileSync(join(schema,'001.sql'),'CREATE TABLE sample(id TEXT PRIMARY KEY);');db=openDatabase(file,{migrationsPath:schema});db.close();
 writeFileSync(join(schema,'001.sql'),'CREATE TABLE changed(id TEXT);');assert.throws(()=>openDatabase(file,{migrationsPath:schema}),/checksum/i);
 writeFileSync(join(schema,'001.sql'),'CREATE TABLE sample(id TEXT PRIMARY KEY);');writeFileSync(join(schema,'002.sql'),'CREATE TABLE partial(id TEXT); INVALID SQL;');assert.throws(()=>openDatabase(file,{migrationsPath:schema}));
 rmSync(join(schema,'002.sql'));db=openDatabase(file,{migrationsPath:schema});assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").first(),null);
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
