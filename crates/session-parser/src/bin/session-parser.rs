//! Pipe synthetic JSONL or trace JSON to the native engine for reproducible validation.
use session_parser::{analyze_sessions, parse_session, scan_metadata};
use std::io::Read;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    match args.first().map(String::as_str) {
        Some("--details") => {
            let selector = args
                .get(1)
                .ok_or("Usage: session-parser --details SELECTOR_JSON")?;
            let mut parser = session_parser::details::DetailParser::new(selector)?;
            parser.push(&input);
            println!("{}", parser.finish());
        }
        Some("--metadata") => println!("{}", scan_metadata(&input)),
        Some("--analyze") => {
            if args.len() != 4 {
                return Err("Usage: session-parser --analyze ROOT_ID START_MS END_MS".into());
            }
            let start: f64 = args[2].parse()?;
            let end: f64 = args[3].parse()?;
            println!("{}", analyze_sessions(&input, &args[1], start, end)?);
        }
        _ => println!("{}", parse_session(&input)),
    }
    Ok(())
}
