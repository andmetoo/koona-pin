use crate::db::{self, DbState};
use crate::metadata;
use serde::Deserialize;
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Method, Response, Server, StatusCode};
use url::Url;

#[derive(Deserialize, Debug)]
struct AddRequestPayload {
    url: String,
    title: Option<String>,
    tags: Option<Vec<String>>,
    collection_id: Option<i64>,
}

pub fn start_server(app_handle: AppHandle, db_state: Arc<DbState>) {
    thread::spawn(move || {
        let addr = "127.0.0.1:28765";
        let server = match Server::http(addr) {
            Ok(s) => {
                println!("OddClicks Local Webhook server listening on http://{}", addr);
                s
            }
            Err(e) => {
                eprintln!("Failed to bind local server to {}: {}", addr, e);
                return;
            }
        };

        for mut request in server.incoming_requests() {
            let app = app_handle.clone();
            let db = db_state.clone();

            let method = request.method().clone();
            let raw_url = request.url().to_string();

            // Handle CORS Preflight
            if method == Method::Options {
                let mut response = Response::empty(StatusCode(204));
                add_cors_headers(&mut response);
                let _ = request.respond(response);
                continue;
            }

            // Parse URL path and query
            let parsed_url = match Url::parse(&format!("http://127.0.0.1:28765{}", raw_url)) {
                Ok(u) => u,
                Err(_) => {
                    let mut res = Response::from_string("Invalid URL").with_status_code(StatusCode(400));
                    add_cors_headers(&mut res);
                    let _ = request.respond(res);
                    continue;
                }
            };

            let path = parsed_url.path();

            if path == "/api/health" {
                let mut res = Response::from_string(r#"{"status":"ok","app":"OddClicks"}"#);
                add_cors_headers(&mut res);
                add_json_header(&mut res);
                let _ = request.respond(res);
                continue;
            }

            if path == "/api/add" {
                let mut target_url = String::new();
                let mut target_title = String::new();
                let mut tags: Vec<String> = Vec::new();
                let mut collection_id: Option<i64> = None;

                // Extract query params
                for (key, val) in parsed_url.query_pairs() {
                    match key.as_ref() {
                        "url" => target_url = val.to_string(),
                        "title" => target_title = val.to_string(),
                        "collection_id" => collection_id = val.parse().ok(),
                        "tags" => {
                            for t in val.split(',') {
                                let trim = t.trim().to_string();
                                if !trim.is_empty() {
                                    tags.push(trim);
                                }
                            }
                        }
                        _ => {}
                    }
                }

                // If URL was not in query and it's POST, check body
                if target_url.is_empty() && method == Method::Post {
                    let mut content = String::new();
                    let mut reader = request.as_reader();
                    if std::io::Read::read_to_string(&mut reader, &mut content).is_ok() {
                        if let Ok(payload) = serde_json::from_str::<AddRequestPayload>(&content) {
                            target_url = payload.url;
                            if let Some(t) = payload.title {
                                target_title = t;
                            }
                            if let Some(t_list) = payload.tags {
                                tags = t_list;
                            }
                            collection_id = payload.collection_id;
                        }
                    }
                }

                if target_url.is_empty() {
                    let mut res = Response::from_string(r#"{"error":"url is required"}"#).with_status_code(StatusCode(400));
                    add_cors_headers(&mut res);
                    add_json_header(&mut res);
                    let _ = request.respond(res);
                    continue;
                }

                let domain = metadata::extract_domain(&target_url);
                let display_title = if target_title.is_empty() {
                    target_url.clone()
                } else {
                    target_title.clone()
                };

                // Save immediately into SQLite with default info
                let conn = db.conn.lock().unwrap();
                let initial_bookmark = db::insert_or_update_bookmark(
                    &conn,
                    &target_url,
                    &display_title,
                    None,
                    None,
                    Some(&format!("https://www.google.com/s2/favicons?domain={}&sz=128", domain)),
                    &domain,
                    collection_id,
                    if tags.is_empty() { None } else { Some(&tags) },
                );
                drop(conn);

                // Immediately respond to caller
                let mut res = Response::from_string(r#"{"success":true,"message":"Bookmark queued"}"#);
                add_cors_headers(&mut res);
                add_json_header(&mut res);
                let _ = request.respond(res);

                // Emit initial bookmark event
                if let Ok(ref b) = initial_bookmark {
                    let _ = app.emit("bookmark-added", b);
                }

                // Asynchronously fetch rich metadata (OG Image, description, accurate title)
                let bg_url = target_url.clone();
                let bg_app = app.clone();
                let bg_db = db.clone();

                tokio::spawn(async move {
                    let meta = metadata::fetch_metadata(&bg_url).await;
                    let conn = bg_db.conn.lock().unwrap();
                    let updated = db::insert_or_update_bookmark(
                        &conn,
                        &bg_url,
                        meta.title.as_deref().unwrap_or(&display_title),
                        meta.description.as_deref(),
                        meta.image_url.as_deref(),
                        meta.favicon_url.as_deref(),
                        &meta.domain,
                        collection_id,
                        if tags.is_empty() { None } else { Some(&tags) },
                    );
                    drop(conn);

                    if let Ok(b) = updated {
                        let _ = bg_app.emit("bookmark-added", &b);
                    }
                });

                continue;
            }

            // 404 fallback
            let mut res = Response::from_string("Not Found").with_status_code(StatusCode(404));
            add_cors_headers(&mut res);
            let _ = request.respond(res);
        }
    });
}

fn add_cors_headers<R: std::io::Read>(res: &mut Response<R>) {
    res.add_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
    res.add_header(Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, POST, OPTIONS"[..]).unwrap());
    res.add_header(Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type"[..]).unwrap());
}

fn add_json_header<R: std::io::Read>(res: &mut Response<R>) {
    res.add_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
}
