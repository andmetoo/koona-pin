# Supabase: приёмник отзывов

NP-088, [Р-9](../doc/decisions.md#р-9-распространение-windows). Отзыв из приложения и форма на koona.app/pin пишут в один проект Supabase через Edge Function `feedback`. Разворачивает владелец; ключ `service_role` не попадает ни в приложение, ни в репозиторий.

| Что | Где |
| --- | --- |
| Таблицы `feedback`, `feedback_hits`, RLS, `feedback_submit` (лимит и запись одной транзакцией) | `migrations/20261006000000_feedback.sql` |
| Хранение 12 месяцев (`pg_cron`) | `migrations/20261006000001_feedback_retention.sql` |
| Edge Function: проверка, лимит 5 в час с адреса, запись, Telegram | `functions/feedback/` (`handler.ts` — логика, `index.ts` — Deno) |
| Вызов без ключа | `config.toml`, `verify_jwt = false` |
| Тесты | `functions/feedback/handler.test.ts` — функция, `feedback.sql.test.ts` — схема на PGlite; `bun run test` |

## Развернуть

Нужны Supabase CLI (`npm i -g supabase` или `scoop install supabase`) и вход: `supabase login`.

1. **Проект.** supabase.com → New project, регион **Central EU (Frankfurt)**, пароль базы — в менеджер паролей. Записать *Project ref* (`abcd1234…` в адресе панели).
2. **Связать и применить схему:**
   ```powershell
   supabase link --project-ref <ref>
   supabase db push
   ```
   Если `db push` откажет на `pg_cron`: Database → Extensions → включить `pg_cron`, повторить.
3. **Telegram-бот.** В Telegram у @BotFather: `/newbot`, сохранить токен. Написать боту любое сообщение и открыть `https://api.telegram.org/bot<токен>/getUpdates` — `chat.id` из ответа.
4. **Секреты функции** (соль — случайная строка, в менеджер паролей вместе с токеном):
   ```powershell
   supabase secrets set FEEDBACK_IP_SALT=<случайная строка> TELEGRAM_BOT_TOKEN=<токен> TELEGRAM_CHAT_ID=<chat id>
   ```
   `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` Supabase задаёт функции сам.
5. **Функция:**
   ```powershell
   supabase functions deploy feedback --no-verify-jwt
   ```
   Адрес: `https://<ref>.supabase.co/functions/v1/feedback`.
6. **Адрес в сборки.** Записать его в `.env` в корне репозитория (шаблон — `.env.example`, в Git файл не попадает):
   ```
   KOONAPIN_FEEDBACK_URL=https://<ref>.supabase.co/functions/v1/feedback
   ```
   Его читают сборки приложения (`src-tauri/build.rs`: `bun run tauri build`, `bun run tauri dev`, `cargo build`; установщик — `bun run build:installer`) и сборка сайта (`site/src/content.mjs`: `bun run site:check`, `scripts/deploy-site.ps1`). Переменная окружения с тем же именем важнее файла. Без адреса приложение отвечает «сервер не ответил», а сайт собирается без формы, и «Поддержка» ведёт на GitHub.

## Проверить

```powershell
$url = "https://<ref>.supabase.co/functions/v1/feedback"
# Запись: 200 {"ok":true}, сообщение в Telegram, строка в Table Editor → feedback.
Invoke-RestMethod $url -Method Post -ContentType "application/json" -Body '{"kind":"bug","message":"Проверка","language":"ru","source":"app","app_version":"0.1.0","os":"test"}'
# Чтение ключом anon (Settings → API): пустой список или отказ, но не отзывы.
Invoke-RestMethod "https://<ref>.supabase.co/rest/v1/feedback?select=*" -Headers @{ apikey = "<anon>"; Authorization = "Bearer <anon>" }
# Лимит: шестой запрос за час — 429 {"error":"rate_limited"}.
```

В Edge Functions → feedback → Logs у каждого запроса строка `feedback: app, address from <заголовок>` (адрес в лог не пишется). Ожидается `cf-connecting-ip`. Если вместо неё в логе ошибок `no CF-Connecting-IP — every sender shares one limit`, Supabase не передаёт функции адрес из Cloudflare: все отправители делят одни 5 отзывов в час. Тогда до выпуска поправить правило в `senderAddress` (`handler.ts`) по заголовкам, которые реально приходят. Проверка: лимит с двух разных сетей (телефон без Wi-Fi и компьютер) — у каждой своих 5 в час.

Если в логах функции `feedback: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set`, отзывы сохраняются, но уведомлений нет: проверить имена секретов (шаг 4).

Прокси у пользователей: приложение идёт через системный прокси Windows. Прокси со входом оно не проходит — пользователь видит, что дело в прокси сети. Сценарий настройки прокси (PAC) приложение не выполняет: при неудачном подключении на такой машине сказано «нет подключения или сети нужен её прокси». В обоих случаях текст можно скопировать и отправить через GitHub.

Удаление по просьбе: Table Editor → `feedback`, найти по времени и тексту, удалить строку.
