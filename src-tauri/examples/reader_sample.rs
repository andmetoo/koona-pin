//! Fetches a list of links the way reading mode does (NP-120), for a sample run.
//!
//! cargo run --example reader_sample --manifest-path src-tauri/Cargo.toml -- <urls.txt> <out dir>
//!
//! Writes `NN.json` per link: the address asked, the time taken and the
//! answer of `fetch_reader_page` (the page itself included). The extraction
//! step is `bun run scripts/reader-sample.ts <out dir>`.

use koonapin_lib::reader;
use std::{fs, path::PathBuf, time::Instant};

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(urls), Some(out)) = (args.next(), args.next()) else {
        eprintln!("usage: reader_sample <urls.txt> <out dir>");
        std::process::exit(2);
    };
    let out = PathBuf::from(out);
    fs::create_dir_all(&out).unwrap();
    let urls = fs::read_to_string(urls).unwrap();
    let urls: Vec<&str> = urls.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    for (i, url) in urls.iter().enumerate() {
        let started = Instant::now();
        let page = reader::fetch_article_page(url).await;
        let ms = started.elapsed().as_millis();
        let record = serde_json::json!({ "n": i + 1, "url": url, "ms": ms, "page": page });
        fs::write(out.join(format!("{:02}.json", i + 1)), serde_json::to_vec_pretty(&record).unwrap()).unwrap();
        let summary = match &page {
            reader::ReaderPage::Page { status, charset, html, .. } => format!("{status} {charset} {} KB", html.len() / 1024),
            other => format!("{other:?}"),
        };
        println!("{:02} {url} {summary} {ms} ms", i + 1);
    }
}
