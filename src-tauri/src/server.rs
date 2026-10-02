use crate::{
    capture::{self, CaptureRequest},
    db::DbState,
};
use serde::Serialize;
use std::{
    io::Read,
    sync::{Arc, Mutex},
    thread,
};
use tauri::AppHandle;
use tiny_http::{Header, Method, Response, Server, StatusCode};
use url::Url;

#[derive(Clone, Serialize)]
pub struct ServerStatus {
    pub running: bool,
    pub address: String,
    pub error: Option<String>,
}
pub struct ServerState(pub Mutex<ServerStatus>);
impl Default for ServerState {
    fn default() -> Self {
        Self(Mutex::new(ServerStatus {
            running: false,
            address: "127.0.0.1:28765".into(),
            error: None,
        }))
    }
}
fn response(status: u16, body: impl Serialize) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut r = Response::from_string(serde_json::to_string(&body).unwrap_or_default())
        .with_status_code(StatusCode(status));
    for (key, value) in [
        ("Content-Type", "application/json"),
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        (
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization",
        ),
    ] {
        r.add_header(Header::from_bytes(key, value).unwrap());
    }
    r
}
fn error(status: u16, code: &str, message: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    response(status, serde_json::json!({"code":code,"message":message}))
}
pub fn start_server(app: AppHandle, db: Arc<DbState>, status: Arc<ServerState>) {
    thread::spawn(move || {
        let server = match Server::http("127.0.0.1:28765") {
            Ok(server) => {
                status.0.lock().unwrap().running = true;
                server
            }
            Err(e) => {
                status.0.lock().unwrap().error = Some(e.to_string());
                return;
            }
        };
        for mut req in server.incoming_requests() {
            let method = req.method().clone();
            if method == Method::Options {
                let _ = req.respond(response(204, serde_json::json!(null)));
                continue;
            }
            let Ok(parsed) = Url::parse(&format!("http://127.0.0.1:28765{}", req.url())) else {
                let _ = req.respond(error(400, "invalid_request", "Некорректный путь"));
                continue;
            };
            let path = parsed.path();
            if path == "/api/health" && method == Method::Get {
                if let Some(auth) = req
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Authorization"))
                {
                    let token = db
                        .conn
                        .lock()
                        .ok()
                        .and_then(|c| crate::db::setting(&c, "capture_token").ok());
                    if !token.is_some_and(|token| auth.value.as_str() == format!("Bearer {token}"))
                    {
                        let _ = req.respond(error(
                            401,
                            "unauthorized",
                            "Токен подключения не подходит",
                        ));
                        continue;
                    }
                }
                let _ = req.respond(response(
                    200,
                    serde_json::json!({"status":"ok","app":"OddClicks","protocol":1}),
                ));
                continue;
            }
            let versioned = path == "/api/v1/capture";
            if !versioned && path != "/api/add" {
                let _ = req.respond(error(404, "not_found", "Нет такого метода"));
                continue;
            }
            if versioned && method != Method::Post
                || !versioned && !matches!(method, Method::Get | Method::Post)
            {
                let _ = req.respond(error(
                    405,
                    "method_not_allowed",
                    "Неподдерживаемый HTTP-метод",
                ));
                continue;
            }
            if versioned {
                let token = db
                    .conn
                    .lock()
                    .ok()
                    .and_then(|conn| crate::db::setting(&conn, "capture_token").ok());
                let authorized = req
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Authorization"))
                    .is_some_and(|h| {
                        token
                            .as_ref()
                            .is_some_and(|t| h.value.as_str() == format!("Bearer {t}"))
                    });
                if !authorized {
                    let _ = req.respond(error(
                        401,
                        "unauthorized",
                        "Подключите расширение локальным токеном",
                    ));
                    continue;
                }
            }
            let has_legacy_query = !versioned && parsed.query_pairs().any(|(key, _)| key == "url");
            let payload = if method == Method::Post && !has_legacy_query {
                let mut body = String::new();
                match req.as_reader().take(65537).read_to_string(&mut body) {
                    Ok(_) if body.len() <= 65536 => serde_json::from_str::<CaptureRequest>(&body)
                        .map_err(|_| "Некорректный JSON"),
                    _ => Err("Тело запроса слишком велико или недоступно"),
                }
            } else {
                let query = parsed
                    .query_pairs()
                    .into_owned()
                    .collect::<std::collections::HashMap<_, _>>();
                Ok(CaptureRequest {
                    request_id: None,
                    url: query.get("url").cloned().unwrap_or_default(),
                    title: query.get("title").cloned(),
                    collection_id: query.get("collection_id").and_then(|x| x.parse().ok()),
                    tags: query
                        .get("tags")
                        .map(|x| x.split(',').map(str::to_owned).collect()),
                })
            };
            let payload = match payload {
                Ok(p) => p,
                Err(message) => {
                    let _ = req.respond(error(400, "invalid_request", message));
                    continue;
                }
            };
            if versioned && payload.request_id.is_none() {
                let _ = req.respond(error(400, "invalid_request", "request_id обязателен"));
                continue;
            }
            let result = match db.conn.lock() {
                Ok(conn) => capture::save(&conn, &payload),
                Err(_) => {
                    let _ = req.respond(error(500, "database_error", "База данных недоступна"));
                    continue;
                }
            };
            match result {
                Ok(saved) => {
                    let _ = req.respond(response(200, &saved));
                    capture::after_save(&app, db.clone(), &saved);
                }
                Err(e) => {
                    let _ = req.respond(response(e.status, &e));
                }
            }
        }
        status.0.lock().unwrap().running = false;
    });
}
