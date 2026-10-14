//! The sidebar's order as fractional keys (schema 10, Р-68): a collection's
//! place is a string that sorts between its neighbours', so a move writes
//! only the moved collection and two devices that move different collections
//! both keep their move. Keys are digits of base 62 in ASCII order
//! (`0-9A-Za-z`) read as a fraction: «V» is one half, «k» about two thirds.
//! A key never ends in `0`, so there is always room between two keys.

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn digit(c: u8) -> usize {
    DIGITS.iter().position(|&d| d == c).unwrap_or(0)
}

/// A key this module could have made. Another device may send anything; a
/// key that is not one is written anew on the next move.
pub fn valid(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric()) && !key.ends_with('0')
}

/// A key after `lo` and before `hi`; none is the start or the end. Both must
/// be [`valid`] and `lo < hi`.
pub fn between(lo: Option<&str>, hi: Option<&str>) -> String {
    let mut key = Vec::new();
    midpoint(lo.unwrap_or("").as_bytes(), hi.map(str::as_bytes), &mut key);
    String::from_utf8(key).expect("ASCII digits")
}

fn midpoint(a: &[u8], b: Option<&[u8]>, out: &mut Vec<u8>) {
    if let Some(b) = b {
        // The digits both share stay as they are.
        let n = b.iter().zip(a.iter().chain(std::iter::repeat(&b'0'))).take_while(|(x, y)| x == y).count();
        if n == b.len() {
            // Not `a < b`: a damaged pair; anything after `a` keeps the order of `a`.
            return midpoint(a, None, out);
        }
        if n > 0 {
            out.extend_from_slice(&b[..n]);
            return midpoint(a.get(n..).unwrap_or(&[]), Some(&b[n..]), out);
        }
    }
    let low = a.first().map_or(0, |&c| digit(c));
    let high = b.map_or(DIGITS.len(), |b| digit(b[0]));
    if high - low > 1 {
        out.push(DIGITS[(low + high).div_ceil(2)]);
    } else if let Some(b) = b.filter(|b| b.len() > 1) {
        out.push(b[0]);
    } else {
        out.push(DIGITS[low]);
        midpoint(a.get(1..).unwrap_or(&[]), None, out);
    }
}

/// `n` keys in order between `lo` and `hi`, spread so they stay short.
pub fn spread(lo: Option<&str>, hi: Option<&str>, n: usize) -> Vec<String> {
    if n == 0 {
        return Vec::new();
    }
    let half = n / 2;
    let mid = between(lo, hi);
    let mut keys = spread(lo, Some(&mid), half);
    let after = spread(Some(&mid), hi, n - half - 1);
    keys.push(mid);
    keys.extend(after);
    keys
}

/// The keys of collections in the order the person wants, as few written as
/// possible: `current` are their keys now (none, or not [`valid`]: written
/// anew). Returns the new key of each one that changes, by place in `current`.
/// The longest run of keys already in order stays; the others go between
/// their neighbours. One collection moved writes one key.
pub fn reorder(current: &[Option<&str>]) -> Vec<(usize, String)> {
    let keys: Vec<Option<&str>> = current.iter().map(|k| k.filter(|k| valid(k))).collect();
    // The longest strictly rising subsequence of the keys there are.
    let mut best: Vec<(usize, Option<usize>)> = Vec::with_capacity(keys.len());
    for (i, key) in keys.iter().enumerate() {
        let Some(key) = key else {
            best.push((0, None));
            continue;
        };
        let before = (0..i)
            .filter(|&j| keys[j].is_some_and(|k| k < *key))
            .max_by_key(|&j| (best[j].0, std::cmp::Reverse(j)));
        best.push(match before {
            Some(j) => (best[j].0 + 1, Some(j)),
            None => (1, None),
        });
    }
    let mut kept = vec![false; keys.len()];
    let mut at = (0..keys.len()).filter(|&i| keys[i].is_some()).max_by_key(|&i| (best[i].0, std::cmp::Reverse(i)));
    while let Some(i) = at {
        kept[i] = true;
        at = best[i].1;
    }
    let mut written = Vec::new();
    let mut start = 0;
    while start < keys.len() {
        if kept[start] {
            start += 1;
            continue;
        }
        let end = (start..keys.len()).find(|&i| kept[i]).unwrap_or(keys.len());
        let lo = start.checked_sub(1).and_then(|i| keys[i]);
        let hi = keys.get(end).copied().flatten();
        for (offset, key) in spread(lo, hi, end - start).into_iter().enumerate() {
            written.push((start + offset, key));
        }
        start = end;
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(current: &[Option<&str>]) -> Vec<String> {
        let mut keys: Vec<String> = current.iter().map(|k| k.unwrap_or("").to_string()).collect();
        for (i, key) in reorder(current) {
            keys[i] = key;
        }
        keys
    }

    #[test]
    fn a_key_goes_between_its_neighbours() {
        assert_eq!(between(None, None), "V");
        for (lo, hi) in [
            (None, Some("V")),
            (Some("V"), None),
            (Some("V"), Some("W")),
            (Some("V"), Some("V1")),
            (Some("z"), None),
            (Some("zzz"), None),
            (None, Some("1")),
            (None, Some("01")),
            (Some("a"), Some("a01")),
            (Some("Az"), Some("B")),
        ] {
            let key = between(lo, hi);
            assert!(valid(&key), "{key}");
            assert!(lo.is_none_or(|lo| lo < key.as_str()), "{lo:?} < {key}");
            assert!(hi.is_none_or(|hi| key.as_str() < hi), "{key} < {hi:?}");
        }
    }

    #[test]
    fn many_keys_stay_short_and_in_order() {
        let keys = spread(None, None, 1000);
        assert!(keys.windows(2).all(|w| w[0] < w[1]));
        assert!(keys.iter().all(|k| valid(k) && k.len() <= 3), "{:?}", keys.iter().map(String::len).max());
        // A collection moved to the top again and again.
        let mut first = keys[0].clone();
        for _ in 0..200 {
            let key = between(None, Some(&first));
            assert!(valid(&key) && key < first);
            first = key;
        }
    }

    #[test]
    fn one_move_writes_one_key() {
        // C moved between A and B.
        assert_eq!(reorder(&[Some("a"), Some("c"), Some("b")]).len(), 1);
        let keys = apply(&[Some("a"), Some("c"), Some("b")]);
        assert!(keys.windows(2).all(|w| w[0] < w[1]), "{keys:?}");
        // To the top, to the end.
        assert_eq!(reorder(&[Some("c"), Some("a"), Some("b")]), [(0, between(None, Some("a")))]);
        assert_eq!(reorder(&[Some("b"), Some("c"), Some("a")]), [(2, between(Some("c"), None))]);
        // Nothing moved: nothing written.
        assert!(reorder(&[Some("a"), Some("b"), Some("c")]).is_empty());
    }

    #[test]
    fn missing_equal_and_foreign_keys_are_written_anew() {
        let keys = apply(&[None, None, None]);
        assert!(keys.windows(2).all(|w| w[0] < w[1]), "{keys:?}");
        for current in [
            [Some("b"), None, Some("a")],
            [Some("a"), Some("a"), Some("b")],
            [Some("a"), Some("x-y"), Some("b")],
            [Some("a0"), Some("b"), Some("")],
        ] {
            let keys = apply(&current);
            assert!(keys.iter().all(|k| valid(k)) && keys.windows(2).all(|w| w[0] < w[1]), "{current:?}: {keys:?}");
        }
    }
}
