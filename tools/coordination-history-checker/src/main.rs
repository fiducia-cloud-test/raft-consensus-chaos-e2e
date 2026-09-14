use serde::{Deserialize, Serialize};
use std::{collections::HashMap, env, fs, path::PathBuf};

#[derive(Debug, Deserialize)]
struct History {
    schema: String,
    source: Source,
    seed: u64,
    initial: RegisterState,
    operations: Vec<Operation>,
}

#[derive(Debug, Deserialize, Serialize)]
struct Source {
    repository: String,
    revision: String,
    contract: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Hash)]
struct RegisterState {
    generation: u64,
    value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct Operation {
    id: String,
    invoke: u64,
    response: u64,
    kind: String,
    #[serde(default)]
    expected_generation: Option<u64>,
    #[serde(default)]
    value: Option<String>,
    result: ResultValue,
}

#[derive(Debug, Clone, Deserialize)]
struct ResultValue {
    status: String,
    generation: u64,
    #[serde(default)]
    value: Option<String>,
}

#[derive(Debug, Serialize)]
struct Receipt {
    schema: &'static str,
    source: Source,
    seed: u64,
    operation_count: usize,
    accepted: bool,
    linearization: Vec<String>,
    reason: Option<String>,
    scope: &'static str,
}

fn apply(state: &RegisterState, op: &Operation) -> Option<RegisterState> {
    match op.kind.as_str() {
        "cas" => {
            let expected = op.expected_generation?;
            if expected == state.generation {
                if op.result.status != "applied" || op.result.generation != state.generation + 1 {
                    return None;
                }
                Some(RegisterState {
                    generation: state.generation + 1,
                    value: op.value.clone(),
                })
            } else {
                if op.result.status != "generation_mismatch"
                    || op.result.generation != state.generation
                {
                    return None;
                }
                Some(state.clone())
            }
        }
        "read" => {
            if op.result.status != "read"
                || op.result.generation != state.generation
                || op.result.value != state.value
            {
                return None;
            }
            Some(state.clone())
        }
        _ => None,
    }
}

fn check(history: &History) -> Result<Vec<String>, String> {
    if history.schema != "fiducia.coordination-history/v1" {
        return Err(format!("unsupported schema: {}", history.schema));
    }
    if history.operations.len() > 63 {
        return Err("history exceeds 63-operation bounded checker limit".into());
    }
    let mut ids = HashMap::new();
    for (idx, op) in history.operations.iter().enumerate() {
        if op.invoke > op.response {
            return Err(format!("invalid interval for {}", op.id));
        }
        if ids.insert(op.id.as_str(), idx).is_some() {
            return Err(format!("duplicate operation id: {}", op.id));
        }
    }

    let mut predecessors = vec![0u64; history.operations.len()];
    for (b_idx, b) in history.operations.iter().enumerate() {
        for (a_idx, a) in history.operations.iter().enumerate() {
            if a_idx != b_idx && a.response < b.invoke {
                predecessors[b_idx] |= 1u64 << a_idx;
            }
        }
    }

    let full = if history.operations.is_empty() {
        0
    } else {
        (1u64 << history.operations.len()) - 1
    };
    let mut memo = HashMap::<(u64, RegisterState), bool>::new();
    let mut order = Vec::new();

    fn search(
        history: &History,
        predecessors: &[u64],
        remaining: u64,
        state: RegisterState,
        memo: &mut HashMap<(u64, RegisterState), bool>,
        order: &mut Vec<String>,
    ) -> bool {
        if remaining == 0 {
            return true;
        }
        if memo.contains_key(&(remaining, state.clone())) {
            return false;
        }

        let mut candidates: Vec<usize> = (0..history.operations.len())
            .filter(|idx| remaining & (1u64 << idx) != 0)
            .filter(|idx| predecessors[*idx] & remaining == 0)
            .collect();
        candidates.sort_by_key(|idx| {
            let op = &history.operations[*idx];
            (op.response, op.invoke, op.id.clone())
        });

        for idx in candidates {
            let op = &history.operations[idx];
            let Some(next) = apply(&state, op) else {
                continue;
            };
            order.push(op.id.clone());
            if search(
                history,
                predecessors,
                remaining & !(1u64 << idx),
                next,
                memo,
                order,
            ) {
                return true;
            }
            order.pop();
        }
        memo.insert((remaining, state), false);
        false
    }

    if search(
        history,
        &predecessors,
        full,
        history.initial.clone(),
        &mut memo,
        &mut order,
    ) {
        Ok(order)
    } else {
        Err(
            "no sequential generation-register history satisfies responses and real-time precedence"
                .into(),
        )
    }
}

fn parse_args() -> Result<(PathBuf, bool, Option<PathBuf>), String> {
    let mut history = None;
    let mut expected_accept = true;
    let mut receipt = None;
    for arg in env::args().skip(1) {
        if let Some(value) = arg.strip_prefix("--history=") {
            history = Some(PathBuf::from(value));
        } else if let Some(value) = arg.strip_prefix("--expected=") {
            expected_accept = match value {
                "accept" => true,
                "reject" => false,
                _ => return Err("--expected must be accept or reject".into()),
            };
        } else if let Some(value) = arg.strip_prefix("--receipt=") {
            receipt = Some(PathBuf::from(value));
        } else {
            return Err(format!("unknown argument: {arg}"));
        }
    }
    Ok((
        history.ok_or("--history is required")?,
        expected_accept,
        receipt,
    ))
}

fn run() -> Result<(), String> {
    let (path, expected_accept, receipt_path) = parse_args()?;
    let input = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let history: History =
        serde_json::from_str(&input).map_err(|e| format!("parse {}: {e}", path.display()))?;
    let result = check(&history);
    let accepted = result.is_ok();
    if accepted != expected_accept {
        return Err(match result {
            Ok(order) => format!("history unexpectedly accepted with order {order:?}"),
            Err(reason) => format!("history unexpectedly rejected: {reason}"),
        });
    }
    let (linearization, reason) = match result {
        Ok(order) => (order, None),
        Err(reason) => (Vec::new(), Some(reason)),
    };
    let receipt = Receipt {
        schema: "fiducia.coordination-history-receipt/v1",
        source: history.source,
        seed: history.seed,
        operation_count: history.operations.len(),
        accepted,
        linearization,
        reason,
        scope: "bounded external-history checker; acceptance is evidence about the supplied history only, not unbounded proof of fiducia-node linearizability",
    };
    let text = serde_json::to_string_pretty(&receipt).map_err(|e| e.to_string())? + "\n";
    if let Some(path) = receipt_path {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(path, &text).map_err(|e| e.to_string())?;
    }
    print!("{text}");
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("coordination-history-checker: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history(operations: Vec<Operation>) -> History {
        History {
            schema: "fiducia.coordination-history/v1".into(),
            source: Source {
                repository: "fixture".into(),
                revision: "fixture".into(),
                contract: "Coordination::compare_and_set/read".into(),
            },
            seed: 42,
            initial: RegisterState {
                generation: 0,
                value: None,
            },
            operations,
        }
    }

    #[test]
    fn rejects_read_that_regresses_after_completed_write() {
        let ops = vec![
            Operation {
                id: "write".into(),
                invoke: 0,
                response: 1,
                kind: "cas".into(),
                expected_generation: Some(0),
                value: Some("a".into()),
                result: ResultValue {
                    status: "applied".into(),
                    generation: 1,
                    value: None,
                },
            },
            Operation {
                id: "read".into(),
                invoke: 2,
                response: 3,
                kind: "read".into(),
                expected_generation: None,
                value: None,
                result: ResultValue {
                    status: "read".into(),
                    generation: 0,
                    value: None,
                },
            },
        ];
        assert!(check(&history(ops)).is_err());
    }

    #[test]
    fn accepts_overlapping_competing_cas() {
        let ops = vec![
            Operation {
                id: "a".into(),
                invoke: 0,
                response: 3,
                kind: "cas".into(),
                expected_generation: Some(0),
                value: Some("a".into()),
                result: ResultValue {
                    status: "applied".into(),
                    generation: 1,
                    value: None,
                },
            },
            Operation {
                id: "b".into(),
                invoke: 1,
                response: 4,
                kind: "cas".into(),
                expected_generation: Some(0),
                value: Some("b".into()),
                result: ResultValue {
                    status: "generation_mismatch".into(),
                    generation: 1,
                    value: None,
                },
            },
        ];
        assert_eq!(check(&history(ops)).unwrap(), vec!["a", "b"]);
    }
}
