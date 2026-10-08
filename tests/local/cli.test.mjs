import {fixtureEnvironment} from './fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../../lib/database.mts';
import { login,validateToken } from '../../lib/local-auth.mts';
test('account CLI uses stdin secrets and rejects password arguments',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'hub-cli-'));const file=join(dir,'data.sqlite');let db;
 const cli=(args,input='')=>spawnSync(process.execPath,['--experimental-strip-types','scripts/accounts.mjs',...args],{input,encoding:'utf8',env:{...fixtureEnvironment(),APP_DB_PATH:file}});
 try{
 const created=cli(['create','alice','Alice'],'synthetic-password\n');assert.equal(created.status,0,created.stderr);assert.ok(!created.stdout.includes('synthetic-password'));
 assert.notEqual(cli(['create','bob','Bob','--password','secret']).status,0);
 db=openDatabase(file);assert.equal((await login(db,{username:'alice',password:'synthetic-password'})).user.username,'alice');
 const issued=cli(['token','alice']);assert.equal(issued.status,0,issued.stderr);assert.ok(await validateToken(db,issued.stdout.trim()));
 assert.equal(cli(['revoke'],issued.stdout).status,0);assert.equal(await validateToken(db,issued.stdout.trim()),null);
 assert.equal(cli(['reset','alice'],'replacement-password\n').status,0);assert.equal((await login(db,{username:'alice',password:'replacement-password'})).user.username,'alice');
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
