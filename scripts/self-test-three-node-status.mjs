#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'den-3008-'));
const verifier = path.resolve('scripts/verify-three-node-status.mjs');

const nodes = [
  { id: 'node.aws.internal:9090', peers: ['node.gcp.internal:9090', 'node.azure.internal:9090'] },
  { id: 'node.gcp.internal:9090', peers: ['node.aws.internal:9090', 'node.azure.internal:9090'] },
  { id: 'node.azure.internal:9090', peers: ['node.aws.internal:9090', 'node.gcp.internal:9090'] },
];
const leaders = [nodes[0].id, nodes[1].id];

function snapshot(nodeIndex) {
  return {
    service: 'fiducia-node',
    consensus: {
      node_id: nodes[nodeIndex].id,
      peers: nodes[nodeIndex].peers,
      shard_count: 2,
      timing: { check_quorum: true },
      hosted_shards: [0, 1],
      unresponsive_shards: [],
      shards: [0, 1].map((shardId) => ({
        shard_id: shardId,
        role: nodes[nodeIndex].id === leaders[shardId] ? 'leader' : 'follower',
        term: 17 + shardId,
        leader_id: leaders[shardId],
        commit_index: 100 + shardId,
        last_applied: 100 + shardId,
        last_log_index: 100 + shardId,
        storage_healthy: true,
      })),
    },
  };
}

const files = nodes.map((_, index) => {
  const file = path.join(tmp, `${index}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot(index)));
  return file;
});

let result = spawnSync(process.execPath, [verifier, ...files], { encoding: 'utf8' });
if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  throw new Error('known-good three-node status was rejected');
}

const broken = snapshot(2);
broken.consensus.shards[0].role = 'leader';
broken.consensus.shards[0].leader_id = broken.consensus.node_id;
fs.writeFileSync(files[2], JSON.stringify(broken));
result = spawnSync(process.execPath, [verifier, ...files], { encoding: 'utf8' });
if (result.status === 0) throw new Error('split-brain fixture was incorrectly accepted');
if (!result.stderr.includes('exactly one leader')) throw new Error(`unexpected rejection: ${result.stderr}`);

console.log('DEN-3008 verifier self-test PASS: healthy convergence accepted; split brain rejected');
fs.rmSync(tmp, { recursive: true, force: true });
