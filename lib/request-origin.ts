import { configuredOrigin } from './local-auth.mts';
/** Next's internal URL is not the operator's canonical browser origin. */
export function canonicalRequest(request:Request):Request {
 const url=new URL(request.url);
 return new Request(new URL(url.pathname+url.search,configuredOrigin()),request);
}
