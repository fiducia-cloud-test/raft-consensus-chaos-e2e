#!/usr/bin/env python3
from itertools import combinations

NODES = (0, 1, 2)
QUORUM = 2

def can_lead(voters: frozenset[int]) -> bool:
    return len(voters) >= QUORUM

def main() -> None:
    explored = 0
    for size in range(4):
        for combo in combinations(NODES, size):
            explored += 1
            voters = frozenset(combo)
            assert can_lead(voters) == (len(voters) >= QUORUM)
    assert not can_lead(frozenset({0}))
    assert can_lead(frozenset({0, 1}))
    print(f'quorum leadership model: {explored} voter sets')

if __name__ == '__main__':
    main()
