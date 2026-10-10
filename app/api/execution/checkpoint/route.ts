import { database } from '../../../../lib/store';
import { handleCheckpoint } from '../../../../lib/execution/backend-http.mts';
export async function POST(request:Request){return handleCheckpoint(request,{...process.env,DB:database()});}
