// The native side of the tools: the same nanoda type checker as the kernel contract, run on this machine.
//   proof-courier-native <export.ndjson>           type-check an export (an environment, or an environment plus a proof)
//   proof-courier-native --lz4 <chunk> <out>       pack one upload chunk the way the contract unpacks it
// Built by `cargo build --release` in tools/native; used by tools/pack_base.py, the exports and ./verify.sh --nearai.
use std::{fs::File,io::BufReader,time::Instant};
fn main() {
    let args:Vec<_>=std::env::args().collect();
    if args[1]=="--lz4" {
        let bytes=std::fs::read(&args[2]).unwrap();
        let nl=bytes.iter().position(|b| *b==b'\n').unwrap();
        let head=std::str::from_utf8(&bytes[..nl]).unwrap().split_whitespace().next().unwrap();
        let mut out=format!("{head} lz4\n").into_bytes();
        out.extend(lz4_flex::compress_prepend_size(&bytes[nl+1..]));
        std::fs::write(&args[3],out).unwrap();return;
    }
    let config=serde_json::from_value(serde_json::json!({
        "use_stdin":true,"num_threads":1,"permitted_axioms":["propext","Classical.choice","Quot.sound"],
        "unpermitted_axiom_hard_error":true,"nat_extension":true,"string_extension":true,
        "print_success_message":false,"print_axioms":false
    })).unwrap();
    let start=Instant::now();
    let (ef,skipped)=nanoda_lib::parser::parse_export_file(BufReader::new(File::open(&args[1]).unwrap()),config).unwrap();
    assert!(skipped.is_empty());
    let parse_ms=start.elapsed().as_secs_f64()*1000.;
    let mut checks=vec![];
    let names=ef.analyze(0,"",false).new_decls;
    for (i,(_,d)) in ef.declars.iter().enumerate() {
        let t=Instant::now();ef.check_declar(d);
        checks.push(serde_json::json!({"index":i,"kind":names[i].0,"name":names[i].1,"ms":t.elapsed().as_secs_f64()*1000.}));
    }
    println!("{}",serde_json::json!({"ok":true,"decls":ef.declars.len(),"name_indices":ef.declaration_name_indices(),"parse_ms":parse_ms,"total_ms":start.elapsed().as_secs_f64()*1000.,"checks":checks}));
}
