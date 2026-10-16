//! A post into a bookmark (NP-131, plan §4.6–4.7): S, R, F and the Inbox,
//! through the journal, `source = 'feed'`.
//!
//! Empty until NP-131.

/// After a fetch stored new posts (NP-129 calls it, NP-131 fills it): for a
/// feed whose destination is `inbox`, save up to 20 of `new_ids` into the
/// Inbox (plan §4.7). Returns how many were saved. Until NP-131: none.
pub fn after_fetch(
    _db: &crate::db::DbState,
    _cache: &super::cache::FeedCache,
    _feed: &super::Feed,
    _new_ids: &[i64],
) -> Result<usize, crate::error::CommandError> {
    Ok(0)
}
