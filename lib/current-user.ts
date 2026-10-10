import { headers } from 'next/headers';
import { database } from './local-store.mts';
import { authenticateHeaders, type LocalSession, type LocalUser } from './local-auth.mts';
export type { LocalSession, LocalUser } from './local-auth.mts';
export async function getCurrentSession():Promise<LocalSession|null>{const requestHeaders=new Headers(await headers());return authenticateHeaders(database(),requestHeaders,'GET');}
export async function getCurrentUser():Promise<LocalUser|null>{return (await getCurrentSession())?.user??null;}
