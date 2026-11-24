#![deny(unsafe_code)]

use t3_code_ls_client_text::outbox::{
    DeliveryAction, DeliveryFacts, ThreadFamilyRead, delivery_action,
};

/// Version 1 packs creation, presence, live shell and connected as low bits.
/// Bits 4 and 5 represent unfiltered, pending, failed and settled family reads.
/// Return 0 for wait, 1 for remove, 2 for send, and -1 for invalid inputs.
#[allow(unsafe_code)]
#[unsafe(no_mangle)] // Public C ABI symbol owned by this library.
pub extern "C" fn t3_outbox_delivery_v1(input: i32) -> i32 {
    if !(0..=63).contains(&input) {
        return -1;
    }
    let family = match input >> 4 {
        0 => ThreadFamilyRead::NotRequired,
        1 => ThreadFamilyRead::Pending,
        2 => ThreadFamilyRead::Failed,
        _ => ThreadFamilyRead::Settled,
    };
    match delivery_action(DeliveryFacts {
        creates_thread: input & 1 != 0,
        thread_exists: input & 2 != 0,
        shell_is_live: input & 4 != 0,
        environment_connected: input & 8 != 0,
        family_read: family,
    }) {
        DeliveryAction::Wait => 0,
        DeliveryAction::Remove => 1,
        DeliveryAction::Send => 2,
    }
}

#[cfg(target_os = "android")]
#[allow(unsafe_code)]
#[unsafe(no_mangle)] // JNI method on the package's private Kotlin adapter.
pub extern "system" fn Java_expo_modules_t3nativecontrols_T3OutboxDelivery_resolveV1(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    input: i32,
) -> i32 {
    // The JVM handles are intentionally opaque. This operation exchanges integers only.
    t3_outbox_delivery_v1(input)
}

#[cfg(test)]
mod tests {
    use super::t3_outbox_delivery_v1;

    #[test]
    fn version_one_distinguishes_replay_from_deletion() {
        assert_eq!(t3_outbox_delivery_v1(-1), -1);
        assert_eq!(t3_outbox_delivery_v1(64), -1);
        assert_eq!(t3_outbox_delivery_v1(13), 2); // Missing creation with a live connection.
        assert_eq!(t3_outbox_delivery_v1(9), 0); // Missing creation with a stale shell.
        assert_eq!(t3_outbox_delivery_v1(3), 1); // Already delivered creation.
        assert_eq!(t3_outbox_delivery_v1(28), 0); // Live filtered shell, family pending.
        assert_eq!(t3_outbox_delivery_v1(44), 0); // Live filtered shell, family failed.
        assert_eq!(t3_outbox_delivery_v1(60), 1); // Live filtered shell, family settled absent.
        assert_eq!(t3_outbox_delivery_v1(62), 2); // The settled family contains the thread.
    }
}
