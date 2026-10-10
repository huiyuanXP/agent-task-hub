/** Used inside the same transaction as history + revision CAS. Includes physical holds after logical cancellation. */
export const ticketStatusWriteGuard=`NOT EXISTS(SELECT 1 FROM workspace_runs held WHERE held.owner=records.owner AND held.ticket_id=records.id
 AND (held.state IN ('pending','approved','running','review') OR (held.generation>0 AND held.physical_closed_at IS NULL)))
 AND NOT EXISTS(SELECT 1 FROM execution_runs held WHERE held.owner=records.owner AND held.ticket_id=records.id AND held.state IN ('queued','running','waiting'))
 AND NOT EXISTS(SELECT 1 FROM execution_permits held WHERE held.owner=records.owner AND held.ticket_id=records.id AND held.closed_at IS NULL)`;
