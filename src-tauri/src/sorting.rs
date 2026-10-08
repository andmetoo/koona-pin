//! The order of the list and of the collections (NP-114, Р-59).
//!
//! «Title A–Z» and «Site A–Z» compare as the interface's language does: case
//! aside, «Ä» next to «A», numbers by value, Chinese by pinyin. Every bookmark
//! keeps the ICU4X sort keys of its title and of its site (schema 7); the keys
//! are indexed, so a page of those orders is read by an index like the
//! newest-first one, never by sorting the whole library. The triggers of
//! schema 7 write them through `np_sort_key` and `np_site_key` with the
//! collator of the connection, which follows the language the stored keys
//! were made in (`sort_language` in `app_settings`). [`set_language`] swaps
//! the collator and writes every key anew when the interface's language
//! changes, or the collation data does (`sort_keys`): new CLDR data may
//! order some strings otherwise, and keys of two versions must not mix.

use icu_collator::{
    options::{CollatorOptions, Strength},
    preferences::CollationNumericOrdering,
    CollatorBorrowed, CollatorPreferences,
};
use rusqlite::{functions::FunctionFlags, Connection, Result};

/// The keys of a library the interface has not told its language yet.
pub const DEFAULT_LANGUAGE: &str = "en";
const SETTING: &str = "sort_language";
/// The version of `icu_collator_data` the stored keys were made with; `build.rs`
/// reads it from Cargo.lock.
const DATA: &str = env!("KOONAPIN_COLLATION_DATA");
const DATA_SETTING: &str = "sort_keys";

/// The collator of `language`, a BCP 47 tag such as `ru`, `sr-Latn` or
/// `zh-CN`; English for a tag it does not understand.
pub fn collator(language: &str) -> CollatorBorrowed<'static> {
    let locale = language
        .parse::<icu_locale_core::Locale>()
        .unwrap_or(icu_locale_core::locale!("en"));
    let mut preferences = CollatorPreferences::from(&locale);
    preferences.numeric_ordering = Some(CollationNumericOrdering::True);
    let mut options = CollatorOptions::default();
    // Case aside; accents only tell otherwise equal words apart.
    options.strength = Some(Strength::Secondary);
    CollatorBorrowed::try_new(preferences, options)
        .or_else(|_| CollatorBorrowed::try_new(CollatorPreferences::default(), options))
        .expect("the root collation is compiled in")
}

/// Bytes that compare as the collator compares the texts.
pub fn key(collator: &CollatorBorrowed, text: &str) -> Vec<u8> {
    let mut key = Vec::with_capacity(text.len() * 2);
    let _ = collator.write_sort_key_to(text, &mut key);
    key
}

/// What «Site A–Z» compares: the domain without `www.`.
pub fn site(domain: &str) -> &str {
    match domain.get(..4) {
        Some(prefix) if prefix.eq_ignore_ascii_case("www.") => &domain[4..],
        _ => domain,
    }
}

/// `np_sort_key(title)` and `np_site_key(domain)` with the collator of
/// `language`. Registering again replaces the functions on this connection.
pub fn register(conn: &Connection, language: &str) -> Result<()> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_INNOCUOUS;
    let titles = collator(language);
    conn.create_scalar_function("np_sort_key", 1, flags, move |ctx| {
        Ok(key(&titles, &ctx.get::<String>(0)?))
    })?;
    let sites = collator(language);
    conn.create_scalar_function("np_site_key", 1, flags, move |ctx| {
        Ok(key(&sites, site(&ctx.get::<String>(0)?)))
    })
}

/// The language the stored keys were made in; none before the first
/// [`set_language`].
pub fn stored_language(conn: &Connection) -> Option<String> {
    crate::db::setting(conn, SETTING).ok()
}

/// On opening a library: new keys are made in the language of the stored ones.
pub fn apply_stored_language(conn: &Connection) -> Result<()> {
    register(conn, stored_language(conn).as_deref().unwrap_or(DEFAULT_LANGUAGE))
}

/// The interface's language: the collator follows it, and when the stored
/// keys were made in another one, with other collation data, or never (a
/// library migrated to schema 7, a new one), every key is written anew in one
/// transaction. Returns whether the keys were written. On a failure the keys
/// and the collator stay as they were.
pub fn set_language(conn: &Connection, language: &str) -> Result<bool> {
    let stored = stored_language(conn);
    let data = crate::db::setting(conn, DATA_SETTING).ok();
    register(conn, language)?;
    if stored.as_deref() == Some(language) && data.as_deref() == Some(DATA) {
        return Ok(false);
    }
    let write = || -> Result<()> {
        let tx = conn.unchecked_transaction()?;
        // Building the two key indexes once after the update is faster than
        // changing them row by row. Their definitions come from the schema.
        let indexes = tx
            .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN ('idx_bookmarks_title', 'idx_bookmarks_site')")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>>>()?;
        for (name, _) in &indexes {
            tx.execute(&format!("DROP INDEX {name}"), [])?;
        }
        tx.execute(
            "UPDATE bookmarks SET title_key = np_sort_key(title), site_key = np_site_key(domain)",
            [],
        )?;
        for (_, sql) in &indexes {
            tx.execute(sql, [])?;
        }
        crate::db::set_setting(&tx, SETTING, language)?;
        crate::db::set_setting(&tx, DATA_SETTING, DATA)?;
        tx.commit()
    };
    write().map(|()| true).inspect_err(|_| {
        let _ = register(conn, stored.as_deref().unwrap_or(DEFAULT_LANGUAGE));
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    fn order<'a>(language: &str, words: &[&'a str]) -> Vec<&'a str> {
        let collator = collator(language);
        let mut sorted = words.to_vec();
        sorted.sort_by_key(|w| key(&collator, w));
        sorted
    }

    #[test]
    fn keys_compare_as_the_language_does() {
        // Case aside, accents next to their letter, numbers by value.
        assert_eq!(
            order("de", &["Zebra", "Äpfel", "apfel", "Chapter 10", "Chapter 9", "Bär"]),
            ["apfel", "Äpfel", "Bär", "Chapter 9", "Chapter 10", "Zebra"]
        );
        // In Serbian Latin «č» is a letter after «c»; the root order keeps it with «c».
        assert_eq!(order("en", &["čaj", "cvet"]), ["čaj", "cvet"]);
        assert_eq!(order("sr-Latn", &["čaj", "cvet"]), ["cvet", "čaj"]);
        // «ё» is «е» with a mark in Russian, not a letter after «я»; Chinese goes by pinyin.
        assert_eq!(order("ru", &["ель", "яма", "ёж", "есть"]), ["ёж", "ель", "есть", "яма"]);
        assert_eq!(order("zh-CN", &["中国", "北京", "上海"]), ["北京", "上海", "中国"]);
        let en = collator("en");
        assert_eq!(key(&en, "Rust").cmp(&key(&en, "rust")), Ordering::Equal, "case aside");
    }

    #[test]
    fn the_keys_know_their_collation_data() {
        // build.rs found icu_collator_data in Cargo.lock.
        assert!(DATA.split('.').count() == 3 && DATA.split('.').all(|n| n.parse::<u32>().is_ok()), "{DATA}");
    }

    #[test]
    fn an_unknown_tag_sorts_as_english() {
        assert_eq!(key(&collator("not a tag!"), "Äpfel"), key(&collator("en"), "Äpfel"));
    }

    #[test]
    fn the_site_is_the_domain_without_www() {
        assert_eq!(site("www.example.com"), "example.com");
        assert_eq!(site("WWW.Example.com"), "Example.com");
        assert_eq!(site("wwwexample.com"), "wwwexample.com");
        assert_eq!(site("пример.рф"), "пример.рф");
        assert_eq!(site("www"), "www");
    }
}
