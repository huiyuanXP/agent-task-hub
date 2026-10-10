import assert from 'node:assert/strict';
import { openDatabase } from '../../lib/database.mts';
import { createAccount, login, resetPassword, validateToken } from '../../lib/local-auth.mts';
const [scenario, file = ':memory:'] = process.argv.slice(2);
const db = openDatabase(file);
const attempt = password => login(db, { username: 'alice', password }).then(() => 200, error => error.status);
try {
  if (scenario !== 'process-admission') {
    await createAccount(db, { username: 'alice', displayName: 'Alice', password: 'synthetic-password' });
  }
  let result;
  if (scenario === 'reset') {
    // One native crypto thread puts the reset hash before the old-password
    // verification, without replacing SQLite or pausing production code.
    const reset = resetPassword(db, 'alice', 'replacement-password');
    const stale = login(db, { username: 'alice', password: 'synthetic-password' });
    const outcomes = await Promise.allSettled([reset, stale]);
    const oldTokenValid = outcomes[1].status === 'fulfilled' &&
      await validateToken(db, outcomes[1].value.token) !== null;
    result = { reset: outcomes[0].status, login: outcomes[1].status,
      status: outcomes[1].reason?.status, oldTokenValid,
      replacement: await attempt('replacement-password') };
  } else if (scenario === 'admission') {
    result = await Promise.all(Array.from({ length: 12 }, () => attempt('wrong-password')));
  } else if (scenario === 'newer-reservations') {
    const successful = attempt('synthetic-password');
    const pending = Array.from({ length: 4 }, () => attempt('wrong-password'));
    assert.equal(await successful, 200);
    const newer = await Promise.all(Array.from({ length: 8 }, () => attempt('wrong-password')));
    result = { pending: await Promise.all(pending), newer };
  } else if (scenario === 'reset-reservations') {
    const reset = resetPassword(db, 'alice', 'replacement-password');
    const pending = Array.from({ length: 5 }, () => attempt('wrong-password'));
    await reset;
    await Promise.all(pending);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push(await attempt('wrong-password'));
    result = statuses;
  } else if (scenario === 'expired-window') {
    const pending = attempt('synthetic-password');
    // Observe the real reservation, then age its persisted window while its
    // real scrypt check is running. No clock or database implementation is faked.
    let reserved;
    for (let i = 0; i < 100 && !reserved; i++) {
      reserved = await db.prepare('SELECT username FROM login_throttle WHERE username=?')
        .bind('alice').first();
      if (!reserved) await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.ok(reserved);
    await db.prepare('UPDATE login_throttle SET window_start=0 WHERE username=?').bind('alice').run();
    const replacement = Array.from({ length: 5 }, () => attempt('wrong-password'));
    assert.equal(await pending, 200);
    result = { replacement: await Promise.all(replacement), following: await attempt('wrong-password') };
  } else if (scenario === 'process-admission') {
    process.send({ ready: true });
    await new Promise(resolve => process.once('message', resolve));
    result = await Promise.all(Array.from({ length: 4 }, () => attempt('wrong-password')));
  } else {
    throw Error('Unknown race scenario');
  }
  if (process.send) process.send({ result });
  else process.stdout.write(JSON.stringify(result));
} finally {
  db.close();
  if (process.connected) process.disconnect();
}
