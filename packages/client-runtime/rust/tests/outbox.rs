use t3_code_ls_client_text::outbox::{
    DeliveryAction, DeliveryFacts, ThreadFamilyRead, delivery_action,
};

#[test]
fn delivery_matches_the_retained_mobile_contract_for_all_fact_combinations() {
    use DeliveryAction::{Remove, Send, Wait};
    use ThreadFamilyRead::{Failed, NotRequired, Pending, Settled};

    // Indexed by [live shell][connected][present thread] for an ordinary message.
    // Each entry lists the outcomes for [unfiltered, pending, failed, settled].
    let message = [
        [[[Wait; 4], [Wait; 4]], [[Wait; 4], [Send; 4]]],
        [
            [[Remove, Wait, Wait, Remove], [Wait; 4]],
            [[Remove, Wait, Wait, Remove], [Send; 4]],
        ],
    ];
    // A matching creation already delivered to the thread is removed even offline.
    let creation = [
        [[Wait, Remove], [Wait, Remove]],
        [[Wait, Remove], [Send, Remove]],
    ];

    for (live, connected) in (0..2).flat_map(|live| (0..2).map(move |connected| (live, connected)))
    {
        for thread in 0..2 {
            for (family, family_read) in [NotRequired, Pending, Failed, Settled]
                .into_iter()
                .enumerate()
            {
                let facts = DeliveryFacts {
                    creates_thread: false,
                    thread_exists: thread == 1,
                    shell_is_live: live == 1,
                    environment_connected: connected == 1,
                    family_read,
                };
                assert_eq!(
                    delivery_action(facts),
                    message[live][connected][thread][family],
                    "{facts:?}"
                );
                let facts = DeliveryFacts {
                    creates_thread: true,
                    ..facts
                };
                assert_eq!(
                    delivery_action(facts),
                    creation[live][connected][thread],
                    "{facts:?}"
                );
            }
        }
    }
}
