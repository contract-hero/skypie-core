// The seam between this crate and whatever application hosts it.
//
// The remote stack owns identity, transport, the path gate and the wire
// protocol. It owns NO user interface: what a host signal should DO is the
// app's decision, and it crosses this file.

use crate::peers::PendingPair;

/// Something the host side needs the app shell to do. Keeps every UI toolkit
/// out of this crate: the app installs a sink that turns each signal into the
/// event (or log line) it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostSignal {
    /// A pairing reached the fingerprint step; the local user must confirm.
    PairPending(PendingPair),
}

/// Where host signals go. Implemented by the app.
///
/// A plain closure is a sink, so the app can pass `move |signal| …` and a test
/// can pass `|_| {}` — the trait exists so a host can hold state instead of a
/// closure.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, signal: HostSignal);
}

impl<F> EventSink for F
where
    F: Fn(HostSignal) + Send + Sync + 'static,
{
    fn emit(&self, signal: HostSignal) {
        self(signal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn pending() -> PendingPair {
        PendingPair {
            node_id: "nodeA".into(),
            device: "iPhone".into(),
            fingerprint: vec!["acid".into(); 6],
            role: "host".into(),
            created_at: 1,
        }
    }

    #[test]
    fn a_closure_is_an_event_sink() {
        let seen: Arc<Mutex<Vec<HostSignal>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = {
            let seen = seen.clone();
            move |signal: HostSignal| seen.lock().unwrap().push(signal)
        };
        let signal = HostSignal::PairPending(pending());
        EventSink::emit(&sink, signal.clone());
        assert_eq!(seen.lock().unwrap().as_slice(), &[signal]);
    }

    #[test]
    fn a_struct_sink_can_hold_state_instead_of_capturing_it() {
        struct Queue(Mutex<Vec<HostSignal>>);
        impl EventSink for Queue {
            fn emit(&self, signal: HostSignal) {
                self.0.lock().unwrap().push(signal);
            }
        }
        let q = Queue(Mutex::new(Vec::new()));
        q.emit(HostSignal::PairPending(pending()));
        assert_eq!(q.0.lock().unwrap().len(), 1);
    }
}
