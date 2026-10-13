//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! The replica's hybrid logical clock (Р-22): the wall clock when it moves forward, one tick
//! past the last clock otherwise, and always past every clock received, so a local write is
//! later than anything this replica has seen whatever the wall clock says.

use crate::model::Hlc;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Default, Clone, Copy)]
pub struct HlcClock {
    last: u64,
}

impl HlcClock {
    /// The next clock at wall time `wall_ms`.
    pub fn tick(&mut self, wall_ms: u64) -> Hlc {
        let wall = Hlc::new(wall_ms, 0).0;
        self.last = if wall > self.last { wall } else { self.last + 1 };
        Hlc(self.last)
    }

    /// A clock seen in the library or from another replica: the next tick is later.
    pub fn observe(&mut self, seen: u64) {
        self.last = self.last.max(seen);
    }

    pub fn last(&self) -> u64 {
        self.last
    }
}

pub fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_runs_backwards() {
        let mut clock = HlcClock::default();
        let a = clock.tick(1_000);
        let b = clock.tick(1_000);
        let c = clock.tick(900);
        assert!(a < b && b < c);
        assert_eq!(c.ms(), 1_000);
        assert_eq!(c.logical(), 2);
        assert_eq!(clock.tick(2_000), Hlc::new(2_000, 0));
    }

    #[test]
    fn moves_past_what_it_received() {
        let mut clock = HlcClock::default();
        clock.tick(1_000);
        clock.observe(Hlc::new(5_000, 3).0);
        assert_eq!(clock.tick(1_001), Hlc::new(5_000, 4));
    }
}
