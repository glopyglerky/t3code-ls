/// The evidence a live shell supplies about a thread omitted from its listing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadFamilyRead {
    NotRequired,
    Pending,
    Failed,
    Settled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeliveryFacts {
    pub creates_thread: bool,
    pub thread_exists: bool,
    pub shell_is_live: bool,
    pub environment_connected: bool,
    pub family_read: ThreadFamilyRead,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryAction {
    Wait,
    Remove,
    Send,
}

/// Determine eligibility before the host checks permission and persisted identity.
pub const fn delivery_action(facts: DeliveryFacts) -> DeliveryAction {
    if facts.creates_thread {
        if facts.thread_exists {
            return DeliveryAction::Remove;
        }
        // A stale list can hide an already delivered thread creation.
        return send_when_connected(facts.environment_connected && facts.shell_is_live);
    }
    if facts.thread_exists {
        return send_when_connected(facts.environment_connected);
    }
    if facts.shell_is_live
        && matches!(
            facts.family_read,
            ThreadFamilyRead::NotRequired | ThreadFamilyRead::Settled
        )
    {
        return DeliveryAction::Remove;
    }
    DeliveryAction::Wait
}

const fn send_when_connected(connected: bool) -> DeliveryAction {
    if connected {
        DeliveryAction::Send
    } else {
        DeliveryAction::Wait
    }
}
