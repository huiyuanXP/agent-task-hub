import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import type { LocalDatabase } from './database.mts';
export interface LocalUser {userId:string;username:string;displayName:string}
export interface LocalSession {user:LocalUser;mode:'local';expiresAt:number}
export class AuthError extends Error {status:number;constructor(status:number,message:string){super(message);this.status=status;}}
const reject=(status=400,message='Invalid account input'):never=>{throw new AuthError(status,message);};
function username(value:unknown){if(typeof value!=='string'||!/^[A-Za-z0-9_.-]{1,64}$/.test(value))reject();return (value as string).toLowerCase();}
function password(value:unknown):asserts value is string {if(typeof value!=='string'||value.length<12||value.length>256)reject();}
const hashToken=(token:string)=>createHash('sha256').update(token).digest('hex');
const derive=(value:string,salt:string)=>new Promise<Buffer>((resolve,reject)=>scrypt(value,salt,64,{N:16384,r:8,p:1},(error,key)=>error?reject(error):resolve(key)));
async function hashPassword(value:string){const salt=randomBytes(24).toString('hex');return `scrypt$${salt}$${(await derive(value,salt)).toString('hex')}`;}
async function verifyPassword(value:string,encoded:string){const [,salt,digest]=encoded.split('$');const actual=await derive(value,salt);const expected=Buffer.from(digest,'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected);}
function exact(value:unknown,keys:string[]):asserts value is Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))reject();}
type UserRow={id:string;username:string;display_name:string;password_hash:string};
const safeUser=(row:UserRow):LocalUser=>({userId:row.id,username:row.username,displayName:row.display_name});
export async function createAccount(db:LocalDatabase,input:unknown):Promise<LocalUser>{
 exact(input,['username','displayName','password']);const name=username(input.username);password(input.password);
 if(typeof input.displayName!=='string'||input.displayName.trim().length<1||input.displayName.length>120)reject();
 const row={id:randomUUID(),username:name,display_name:input.displayName as string,password_hash:await hashPassword(input.password)};
 await db.prepare('INSERT INTO local_users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)').bind(row.id,name,row.display_name,row.password_hash,Date.now()).run();return safeUser(row);
}
export async function resetPassword(db:LocalDatabase,name:unknown,value:unknown){
 const normalized=username(name);password(value);const row=await db.prepare('SELECT id FROM local_users WHERE username=?').bind(normalized).first<{id:string}>();if(!row)reject(404,'Account not found');
 await db.batch([db.prepare('UPDATE local_users SET password_hash=? WHERE id=?').bind(await hashPassword(value),row!.id),db.prepare('DELETE FROM local_tokens WHERE owner=?').bind(row!.id),db.prepare('DELETE FROM login_throttle WHERE username=?').bind(normalized)]);
}
export async function issueToken(db:LocalDatabase,owner:string,options:{kind:'browser'|'api';ttlSeconds?:number;now?:number}){
 exact(options,['kind','ttlSeconds','now']);if(options.kind!=='browser'&&options.kind!=='api')reject();
 const ttl=options.ttlSeconds===undefined?(options.kind==='browser'?43200:2592000):options.ttlSeconds;if(typeof ttl!=='number'||!Number.isSafeInteger(ttl)||ttl<60||ttl>(options.kind==='browser'?604800:7776000))reject();
 const now=options.now===undefined?Date.now():options.now;if(!Number.isSafeInteger(now)||now<0)reject();
 const user=await db.prepare('SELECT * FROM local_users WHERE id=?').bind(owner).first<UserRow>();if(!user)reject(404,'Account not found');
 const token=randomBytes(32).toString('base64url'),expiresAt=now+ttl*1000;
 await db.prepare('INSERT INTO local_tokens(token_hash,owner,kind,expires_at,created_at) VALUES(?,?,?,?,?)').bind(hashToken(token),owner,options.kind,expiresAt,now).run();
 return {token,user:safeUser(user!),mode:'local' as const,expiresAt};
}
export async function validateToken(db:LocalDatabase,token:string,now=Date.now()):Promise<(LocalSession&{kind:'browser'|'api'})|null>{
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
 const row=await db.prepare('SELECT u.*,t.kind,t.expires_at FROM local_tokens t JOIN local_users u ON u.id=t.owner WHERE t.token_hash=? AND t.expires_at>?').bind(hashToken(token),now).first<UserRow&{kind:'browser'|'api';expires_at:number}>();
 return row?{user:safeUser(row),mode:'local',expiresAt:row.expires_at,kind:row.kind}:null;
}
export async function revokeToken(db:LocalDatabase,token:string){await db.prepare('DELETE FROM local_tokens WHERE token_hash=?').bind(hashToken(token)).run();}
export async function login(db:LocalDatabase,input:unknown){
 exact(input,['username','password']);const name=username(input.username);if(typeof input.password!=='string'||input.password.length>256)reject(401,'Invalid username or password');
 const now=Date.now(),window=900000;
 const limit=await db.prepare('SELECT failures,window_start FROM login_throttle WHERE username=?').bind(name).first<{failures:number;window_start:number}>();
 if(limit&&limit.window_start>now-window&&limit.failures>=5)reject(429,'Login temporarily limited');
 const user=await db.prepare('SELECT * FROM local_users WHERE username=?').bind(name).first<UserRow>();
 const valid=await verifyPassword(input.password as string,user?.password_hash??`scrypt$${'0'.repeat(48)}$${'0'.repeat(128)}`);
 if(!valid||!user){await db.prepare(`INSERT INTO login_throttle(username,failures,window_start) VALUES(?,1,?) ON CONFLICT(username) DO UPDATE SET failures=CASE WHEN window_start<=? THEN 1 ELSE failures+1 END,window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END`).bind(name,now,now-window,now-window).run();reject(401,'Invalid username or password');}
 await db.prepare('DELETE FROM login_throttle WHERE username=?').bind(name).run();return issueToken(db,user!.id,{kind:'browser'});
}
export function configuredOrigin(){const raw=process.env.APP_ORIGIN??'http://127.0.0.1:5173';const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.origin!==raw||url.username||url.password)throw Error('APP_ORIGIN must be an HTTP origin');return raw;}
export function checkRequestOrigin(headers:Headers,method:string,origin:string,transport:'cookie'|'bearer'|'none'){
 const url=new URL(origin);if(headers.get('host')!==url.host)reject(403,'Request origin rejected');
 const supplied=headers.get('origin');if(supplied!==null&&supplied!==origin)reject(403,'Request origin rejected');
 if(!['GET','HEAD','OPTIONS'].includes(method)&&transport!=='bearer'&&supplied!==origin)reject(403,'Request origin rejected');
}
export function readCredential(headers:Headers):{token:string;transport:'cookie'|'bearer'}|null {
 const authorization=headers.get('authorization');const cookies=(headers.get('cookie')??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('hub_session='));
 if(cookies.length>1||(authorization&&cookies.length))reject(401,'Conflicting credentials');
 if(authorization){const match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);if(!match)reject(401,'Authentication required');return {token:match![1],transport:'bearer'};}
 if(cookies.length)return {token:cookies[0].slice('hub_session='.length),transport:'cookie'};return null;
}
export async function authenticateHeaders(db:LocalDatabase,headers:Headers,method:string,origin=configuredOrigin()):Promise<LocalSession|null>{
 const credential=readCredential(headers);checkRequestOrigin(headers,method,origin,credential?.transport??'none');if(!credential)return null;
 const session=await validateToken(db,credential.token);if(!session||(credential.transport==='cookie'&&session.kind!=='browser')||(credential.transport==='bearer'&&session.kind!=='api'))reject(401,'Authentication required');
 return {user:session!.user,mode:'local',expiresAt:session!.expiresAt};
}
export function sessionCookie(token:string,expiresAt:number,origin=configuredOrigin()){return `hub_session=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}${origin.startsWith('https:')?'; Secure':''}`;}
export function safeReturnPath(value:unknown){if(typeof value!=='string'||value.length>2048||!value.startsWith('/')||value.startsWith('//')||/[\\\x00-\x20]/.test(value))return '/';try{const url=new URL(value,'http://local.invalid');return url.origin==='http://local.invalid'&&!/^\/(signin|api\/auth)(\/|$)/.test(url.pathname)?url.pathname+url.search+url.hash:'/';}catch{return '/';}}
