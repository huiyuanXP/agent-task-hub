const text = { type: 'string' };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const planningSchema = object({
  plan: object({ title: text, goal: text, scope: text, acceptance: text, assumptions: text }),
  tickets: { type: 'array', minItems: 1, maxItems: 30, items: object({ key: text, title: text, goal: text, scope: text, acceptance: text, dependencies: text, assumptions: text }) },
});
export const developmentSchema = object({ summary: text });
export function validatePlanning(value) {
  if (!value?.plan || !Array.isArray(value.tickets) || value.tickets.length < 1 || value.tickets.length > 30) throw Error('Model returned an invalid plan/ticket collection');
  const keys = new Set();
  for (const field of ['title', 'goal', 'scope', 'acceptance']) {
    if (typeof value.plan[field] !== 'string' || !value.plan[field].trim() || value.plan[field].length > 12000) throw Error(`Model plan has an invalid ${field}`);
  }
  for (const ticket of value.tickets) {
    for (const field of ['key', 'title', 'goal', 'scope', 'acceptance']) {
      if (typeof ticket[field] !== 'string' || !ticket[field].trim() || ticket[field].length > 12000) throw Error(`Model ticket has an invalid ${field}`);
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(ticket.key) || keys.has(ticket.key)) throw Error('Model returned duplicate or invalid ticket keys');
    keys.add(ticket.key);
  }
  if (JSON.stringify(value).length > 175000) throw Error('Model planning result exceeds the limit');
  return value;
}
