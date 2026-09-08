//! Read-only full-corpus benchmark. Prints aggregate statistics, never prompts, IDs or paths.
use session_parser::Engine;
use std::{
    collections::HashSet,
    fs,
    io::{BufReader, Read},
    path::{Path, PathBuf},
    time::Instant,
};

fn discover(path: &Path, paths: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            discover(&entry.path(), paths)?;
        } else if ty.is_file() && entry.path().extension().is_some_and(|v| v == "jsonl") {
            paths.push(entry.path());
        }
    }
    Ok(())
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("Usage: cargo run --release -p session-parser --bin benchmark -- <sessions-directory> [archived-directory] [--trace]");
        std::process::exit(2);
    }
    let trace = args.iter().any(|s| s == "--trace");
    let mut paths = Vec::new();
    for arg in args.iter().filter(|s| !s.starts_with("--")) {
        let path = Path::new(arg);
        if path.join("sessions").is_dir() {
            discover(&path.join("sessions"), &mut paths)?;
            if path.join("archived_sessions").is_dir() {
                discover(&path.join("archived_sessions"), &mut paths)?;
            }
        } else {
            discover(path, &mut paths)?;
        }
    }
    paths.sort();
    let start = Instant::now();
    let mut bytes = 0u64;
    let (
        mut records,
        mut malformed,
        mut turns,
        mut children,
        mut spans,
        mut warnings,
        mut oversized_lines,
        mut oversized_bytes,
    ) = (0, 0, 0, 0, 0, 0, 0, 0);
    let mut latencies = Vec::new();
    let (
        mut elided_strings,
        mut elided_bytes,
        mut identity_mismatches,
        mut collisions,
        mut invalid_spans,
    ) = (0, 0, 0, 0, 0);
    let mut identities = HashSet::new();
    let mut buffer = vec![0u8; 256 * 1024];
    for path in &paths {
        let tick = Instant::now();
        let mut reader = BufReader::new(fs::File::open(path)?);
        let mut parser = Engine::new(!trace);
        let mut pending = Vec::new();
        loop {
            let n = reader.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            bytes += n as u64;
            pending.extend_from_slice(&buffer[..n]);
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) => e.valid_up_to(),
            };
            if valid > 0 {
                parser.push(std::str::from_utf8(&pending[..valid])?);
                pending.drain(..valid);
            }
            // Bad UTF-8 is not allowed to grow the incremental decoder unboundedly.
            if pending.len() > 4 {
                parser.push(&String::from_utf8_lossy(&pending));
                pending.clear();
            }
        }
        if !pending.is_empty() {
            parser.push(&String::from_utf8_lossy(&pending));
        }
        let parsed = parser.finish();
        records += parsed.metadata.record_count;
        malformed += parsed.metadata.malformed_lines;
        turns += parsed.metadata.turn_count;
        children += parsed.metadata.child_ids.len();
        spans += parsed.spans.len();
        warnings += parsed.warnings.len();
        oversized_lines += parsed.metadata.oversized_lines;
        oversized_bytes += parsed.metadata.oversized_bytes;
        elided_strings += parsed.metadata.elided_strings;
        elided_bytes += parsed.metadata.elided_bytes;
        if !identities.insert(parsed.metadata.id.clone()) {
            collisions += 1;
        }
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if stem.len() >= 36 && stem[stem.len() - 36..] != parsed.metadata.id {
            identity_mismatches += 1;
        }
        invalid_spans += parsed
            .spans
            .iter()
            .filter(|span| {
                span.session_id != parsed.metadata.id
                    || span.end_time < span.start_time
                    || !span.start_time.is_finite()
                    || !span.end_time.is_finite()
            })
            .count();
        latencies.push(tick.elapsed().as_secs_f64() * 1000.0);
    }
    latencies.sort_by(f64::total_cmp);
    let elapsed = start.elapsed().as_secs_f64();
    let percentile = |p: f64| -> f64 {
        if latencies.is_empty() {
            0.0
        } else {
            latencies[((latencies.len() - 1) as f64 * p) as usize]
        }
    };
    println!(
        "{}",
        serde_json::json!({"mode":if trace{"trace"}else{"metadata"},"files":paths.len(),"bytes":bytes,"records":records,"malformedLines":malformed,"oversizedLines":oversized_lines,"oversizedBytes":oversized_bytes,"elidedStrings":elided_strings,"elidedBytes":elided_bytes,"retainedJsonBytes":bytes.saturating_sub(oversized_bytes).saturating_sub(elided_bytes),"uniqueSessionIds":identities.len(),"identityMismatches":identity_mismatches,"identityCollisions":collisions,"invalidSpans":invalid_spans,"turns":turns,"childReferences":children,"spans":spans,"warnings":warnings,"elapsedMs":elapsed*1000.0,"readMegabytesPerSecond":bytes as f64/1e6/elapsed,"fileP50Ms":percentile(0.50),"fileP95Ms":percentile(0.95),"fileMaxMs":percentile(1.0)})
    );
    if identity_mismatches + collisions + invalid_spans > 0 {
        return Err("Corpus identity or span invariant failed; see aggregate counts.".into());
    }
    Ok(())
}
