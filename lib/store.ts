import { env } from 'cloudflare:workers';
export function database(){if(!env.DB) throw new Error('Storage unavailable');return env.DB;}
