import { openDatabase } from '../../lib/database.mts';
import { deliverDue } from '../../lib/planning-delivery.mts';
const db=openDatabase(process.argv[2]);
try { await deliverDue(db); } finally { db.close(); }
