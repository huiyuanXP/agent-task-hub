/** Pause at the actual D1 transaction boundary after every domain await. */
export function raceDatabase(db, match, mutation) {
    let fired = false;
    const wrapped = {
        prepare(sql) {
            const wrap = statement => ({ sql, statement, bind(...values) { return wrap(statement.bind(...values)); }, first: () => statement.first(), all: () => statement.all(), run: () => statement.run() });
            return wrap(db.prepare(sql));
        },
        async batch(statements) { if (!fired && statements.some(s => match(s.sql ?? ''))) {
            fired = true;
            await mutation();
        } return db.batch(statements.map(s => s.statement ?? s)); },
    };
    return { db: wrapped, get fired() { return fired; } };
}
