#!/usr/bin/env node
import fs from 'node:fs';

const files = process.argv.slice(2);
if (files.length !== 3) {
  console.error('usage: node scripts/verify-three-node-status.mjs aws.json gcp.json azure.json');
  process.exit(2);
}

function fail(message) {
  console.error(`DEN-3008 Raft verification failure: ${message}`);
  process.exit(1);
}

const providers = ['aws', 'gcp', 'azure'];
const snapshots = files.map((file, index) => {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${providers[index]} status is not valid JSON: ${error.message}`);
  }
  if (parsed?.service !== 'fiducia-node') fail(`${providers[index]} did not report service=fiducia-node`);
  if (!parsed?.consensus || typeof parsed.consensus !== 'object') fail(`${providers[index]} is missing consensus status`);
  return { provider: providers[index], file, status: parsed.consensus };
});

const nodeIds = snapshots.map(({ status }) => status.node_id);
if (nodeIds.some((id) => typeof id !== 'string' || id.length === 0)) fail('every node must expose a stable node_id');
if (new Set(nodeIds).size !== 3) fail('three physical clusters must expose three distinct Fiducia node IDs');

const shardCounts = snapshots.map(({ status }) => status.shard_count);
if (!shardCounts.every((count) => Number.isInteger(count) && count > 0 && count === shardCounts[0])) {
  fail(`nodes disagree on shard_count: ${shardCounts.join(', ')}`);
}

for (const { provider, status } of snapshots) {
  if (!Array.isArray(status.peers) || status.peers.length !== 2) fail(`${provider} must configure exactly two Raft peers`);
  if (!Array.isArray(status.hosted_shards) || status.hosted_shards.length !== status.shard_count) {
    fail(`${provider} must host every configured shard in the current fixed-membership model`);
  }
  if (!Array.isArray(status.unresponsive_shards) || status.unresponsive_shards.length !== 0) {
    fail(`${provider} has unresponsive shard actors`);
  }
  if (!Array.isArray(status.shards) || status.shards.length !== status.shard_count) {
    fail(`${provider} must return one status row for every shard`);
  }
  if (status.timing?.check_quorum !== true) fail(`${provider} must run with Raft check_quorum=true`);
}

const shardIds = [...snapshots[0].status.hosted_shards].sort((a, b) => Number(a) - Number(b));
const summary = [];

for (const shardId of shardIds) {
  const rows = snapshots.map(({ provider, status }) => {
    const row = status.shards.find((candidate) => String(candidate.shard_id) === String(shardId));
    if (!row) fail(`${provider} is missing shard ${shardId}`);
    return { provider, ...row };
  });

  const leaders = rows.filter((row) => row.role === 'leader');
  if (leaders.length !== 1) fail(`shard ${shardId} must have exactly one leader; found ${leaders.length}`);

  const terms = rows.map((row) => row.term);
  if (!terms.every((term) => Number.isInteger(term) && term === terms[0])) {
    fail(`shard ${shardId} is not term-converged: ${terms.join(', ')}`);
  }

  const leaderId = leaders[0].leader_id || nodeIds[providers.indexOf(leaders[0].provider)];
  for (const row of rows) {
    if (row.leader_id !== null && row.leader_id !== undefined && row.leader_id !== leaderId) {
      fail(`shard ${shardId} has inconsistent leader_id observations`);
    }
    if (row.storage_healthy !== true) fail(`shard ${shardId} on ${row.provider} reports unhealthy durable storage`);
    if (!Number.isInteger(row.commit_index) || !Number.isInteger(row.last_applied)) {
      fail(`shard ${shardId} on ${row.provider} has invalid commit/apply indexes`);
    }
    if (row.last_applied > row.commit_index) fail(`shard ${shardId} on ${row.provider} applied beyond commit index`);
  }

  const commitIndexes = rows.map((row) => row.commit_index);
  if (!commitIndexes.every((index) => index === commitIndexes[0])) {
    fail(`shard ${shardId} has not converged its commit index: ${commitIndexes.join(', ')}`);
  }
  const appliedIndexes = rows.map((row) => row.last_applied);
  if (!appliedIndexes.every((index) => index === commitIndexes[0])) {
    fail(`shard ${shardId} has apply lag after quiescence: ${appliedIndexes.join(', ')}`);
  }

  summary.push({
    shardId,
    term: terms[0],
    leaderId,
    commitIndex: commitIndexes[0],
  });
}

console.log(JSON.stringify({
  linearIssue: 'DEN-3008',
  result: 'PASS',
  nodeIds,
  shardCount: shardCounts[0],
  shards: summary,
}, null, 2));
