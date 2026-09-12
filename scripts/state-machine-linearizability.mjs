#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = { seed: 0x5eedc0de, receipt: null };
  for (const arg of argv) {
    if (arg.startsWith('--seed=')) out.seed = Number(arg.slice(7));
    else if (arg.startsWith('--receipt=')) out.receipt = arg.slice(10);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isSafeInteger(out.seed) || out.seed < 0) throw new Error('seed must be a non-negative safe integer');
  return out;
}

function rng(seed) {
  let x = (seed >>> 0) || 0x9e3779b9;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

function shuffle(xs, random) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildRegisterHistory(seed, count = 24) {
  const random = rng(seed);
  let state = 0;
  let t = 0;
  const sequential = [];
  for (let i = 0; i < count; i++) {
    const isWrite = random() < 0.45;
    if (isWrite) {
      const value = 1 + Math.floor(random() * 9);
      sequential.push({ id: `op-${i}`, kind: 'write', value, result: 'ok' });
      state = value;
    } else {
      sequential.push({ id: `op-${i}`, kind: 'read', result: state });
    }
  }

  // Produce overlapping intervals while preserving the chosen sequential order as
  // one valid linearization. Every operation's invocation occurs before its
  // response; the response order is monotonic with the reference sequence.
  const history = [];
  for (let i = 0; i < sequential.length; i++) {
    const op = sequential[i];
    const invoke = Math.max(0, t - Math.floor(random() * 3));
    t += 1 + Math.floor(random() * 3);
    const response = t;
    history.push({ ...op, invoke, response });
  }
  return shuffle(history, random);
}

function linearizableRegister(history) {
  const ops = history.map((op, idx) => ({ ...op, _idx: idx }));
  for (const op of ops) {
    if (!Number.isFinite(op.invoke) || !Number.isFinite(op.response) || op.invoke > op.response) {
      return { ok: false, reason: `invalid interval for ${op.id}` };
    }
  }

  // a -> b means a must precede b because a completed before b began.
  const mustBefore = new Map(ops.map(op => [op.id, new Set()]));
  for (const a of ops) {
    for (const b of ops) {
      if (a.id !== b.id && a.response < b.invoke) mustBefore.get(b.id).add(a.id);
    }
  }

  const pending = new Map(ops.map(op => [op.id, op]));
  const chosen = [];
  const memo = new Set();

  function search(register) {
    if (pending.size === 0) return true;
    const key = `${register}|${[...pending.keys()].sort().join(',')}`;
    if (memo.has(key)) return false;
    memo.add(key);

    const candidates = [...pending.values()]
      .filter(op => [...mustBefore.get(op.id)].every(id => !pending.has(id)))
      .sort((a, b) => a.response - b.response || a.invoke - b.invoke || a.id.localeCompare(b.id));

    for (const op of candidates) {
      let next = register;
      if (op.kind === 'write') {
        if (op.result !== 'ok') continue;
        next = op.value;
      } else if (op.kind === 'read') {
        if (op.result !== register) continue;
      } else {
        continue;
      }
      pending.delete(op.id);
      chosen.push(op.id);
      if (search(next)) return true;
      chosen.pop();
      pending.set(op.id, op);
    }
    return false;
  }

  const ok = search(0);
  return ok ? { ok: true, order: [...chosen] } : { ok: false, reason: 'no sequential register history satisfies responses and real-time precedence' };
}

function exerciseLeaseStateMachine(seed, steps = 80) {
  const random = rng(seed ^ 0xa5a5a5a5);
  let owner = null;
  let token = 0;
  let expiry = 0;
  let now = 0;
  const acceptedTokens = [];
  const violations = [];
  const events = [];

  const isValid = who => owner === who && now < expiry;
  for (let i = 0; i < steps; i++) {
    now += Math.floor(random() * 3);
    const actor = `c${1 + Math.floor(random() * 3)}`;
    const choice = Math.floor(random() * 5);
    if (choice === 0) {
      if (owner === null || now >= expiry) {
        token += 1;
        owner = actor;
        expiry = now + 2 + Math.floor(random() * 5);
        acceptedTokens.push(token);
        events.push({ at: now, op: 'acquire', actor, token, accepted: true, expiry });
      } else events.push({ at: now, op: 'acquire', actor, accepted: false });
    } else if (choice === 1) {
      const accepted = isValid(actor);
      if (accepted) expiry = now + 2 + Math.floor(random() * 5);
      events.push({ at: now, op: 'renew', actor, token, accepted, expiry });
    } else if (choice === 2) {
      const presented = random() < 0.75 ? token : Math.max(0, token - 1);
      const accepted = isValid(actor) && presented === token;
      events.push({ at: now, op: 'write', actor, presented, current: token, accepted });
      if (accepted && presented !== token) violations.push('accepted stale fencing token');
      if (accepted && owner !== actor) violations.push('accepted non-owner write');
    } else if (choice === 3) {
      const accepted = isValid(actor);
      if (accepted) { owner = null; expiry = 0; }
      events.push({ at: now, op: 'release', actor, token, accepted });
    } else {
      now += 1 + Math.floor(random() * 4);
      events.push({ at: now, op: 'tick' });
      if (owner !== null && now >= expiry) owner = null;
    }
  }

  for (let i = 1; i < acceptedTokens.length; i++) {
    if (acceptedTokens[i] <= acceptedTokens[i - 1]) violations.push('fencing token did not increase monotonically');
  }
  return { ok: violations.length === 0, violations, events, final: { owner, token, expiry, now } };
}

function classifyEvidence(trace) {
  const safetyReasons = [];
  const livenessReasons = [];
  const availabilityReasons = [];
  if (trace.divergentCommittedState) safetyReasons.push('divergent-committed-state');
  if (trace.staleWriterAccepted) safetyReasons.push('stale-writer-accepted');
  if (trace.doubleOwnership) safetyReasons.push('double-ownership');
  if (trace.duplicateNonIdempotentEffect) safetyReasons.push('duplicate-non-idempotent-effect');
  if (trace.invalidTransition) safetyReasons.push('invalid-state-transition');
  if (trace.faultRemoved && trace.horizonExhausted && !trace.recovered) livenessReasons.push('did-not-recover-after-fault-removed');
  if (trace.unavailableIntervals > 0) availabilityReasons.push(`unavailable-intervals:${trace.unavailableIntervals}`);
  return {
    safety: { ok: safetyReasons.length === 0, reasons: safetyReasons },
    liveness: { ok: livenessReasons.length === 0, reasons: livenessReasons },
    availability: { degraded: availabilityReasons.length > 0, reasons: availabilityReasons },
  };
}

const args = parseArgs(process.argv.slice(2));
const history = buildRegisterHistory(args.seed);
const positive = linearizableRegister(history);
if (!positive.ok) throw new Error(`seed ${args.seed} generated non-linearizable positive history: ${positive.reason}`);

const negativeFixturePath = path.resolve('fixtures/state-machine/known-nonlinearizable.json');
const negativeFixture = JSON.parse(fs.readFileSync(negativeFixturePath, 'utf8'));
if (negativeFixture.spec !== 'single-register/v1' || negativeFixture.expected !== 'reject' || !Array.isArray(negativeFixture.operations)) {
  throw new Error('known counterexample fixture has an invalid contract');
}
const negativeResult = linearizableRegister(negativeFixture.operations);
if (negativeResult.ok) throw new Error('known impossible history was incorrectly accepted');

const lease = exerciseLeaseStateMachine(args.seed);
if (!lease.ok) throw new Error(`lease model invariant failure: ${lease.violations.join('; ')}`);

const classes = {
  safety: classifyEvidence({ divergentCommittedState: true, recovered: true, faultRemoved: true, horizonExhausted: false, unavailableIntervals: 1 }),
  liveness: classifyEvidence({ recovered: false, faultRemoved: true, horizonExhausted: true, unavailableIntervals: 5 }),
  availabilityOnly: classifyEvidence({ recovered: true, faultRemoved: true, horizonExhausted: false, unavailableIntervals: 4 }),
};
if (classes.safety.safety.ok) throw new Error('safety classifier failed to flag divergent state');
if (classes.liveness.liveness.ok) throw new Error('liveness classifier failed to flag permanent non-recovery');
if (!classes.availabilityOnly.safety.ok || !classes.availabilityOnly.liveness.ok || !classes.availabilityOnly.availability.degraded) {
  throw new Error('availability-only degradation was misclassified');
}

const receipt = {
  schema: 'fiducia.state-machine-evidence/v1',
  seed: args.seed,
  generatedHistoryOperations: history.length,
  linearizability: {
    positiveAccepted: positive.ok,
    positiveOrder: positive.order,
    knownImpossibleRejected: !negativeResult.ok,
    negativeReason: negativeResult.reason,
  },
  leaseStateMachine: {
    ok: lease.ok,
    eventCount: lease.events.length,
    finalToken: lease.final.token,
  },
  evidenceClassification: classes,
  scope: 'deterministic harness self-test only; not certification of fiducia-node runtime linearizability',
};

const text = JSON.stringify(receipt, null, 2) + '\n';
if (args.receipt) {
  fs.mkdirSync(path.dirname(args.receipt), { recursive: true });
  fs.writeFileSync(args.receipt, text);
}
process.stdout.write(text);
