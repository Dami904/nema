# What is enforced, and where

Each claim below names the tests that fail if it stops being true. Contract tests
are in [`contract/src/tests.rs`](../contract/src/tests.rs) (224),
enclave tests in [`aggregator/src/tests.rs`](../aggregator/src/tests.rs), and the
live checks in [`web/scripts/`](../web/scripts). Run them with `cd contract && cargo
test`, `cargo test -p nema-aggregator` and `pnpm --dir web test`.

Rows marked **v2** are about the council contract; **v2.1** rows are the rounded
result and the reader allowlist.

## Privacy

| Claim | Where it is checked |
| --- | --- |
| The chain never holds a mark, the mean or the spread | `a_valid_tally_publishes_a_listing_without_the_result` · enclave `tally_publishes_count_and_commitment_but_not_the_result` · live `smoke.ts` ("no mark is stored in the clear") |
| Only the buyer can open a delivered result, and it matches the commitment | enclave `only_the_buyer_can_open_the_delivery_and_it_matches_the_commitment` |
| Only the round's own contract can call the enclave | enclave `another_caller_is_refused_for_every_action`, `an_empty_predecessor_is_refused`, `audit_is_refused_to_anyone_but_the_contract` |
| Nothing is published below four funds | `a_count_below_the_minimum_is_not_published`, `too_few_submissions_fail_the_round_without_calling_the_enclave`, `minimum_below_four_is_refused` · enclave `tally_below_the_minimum_publishes_nothing` |
| **v2** A round can't open on a panel too small to ever publish | `a_round_cannot_open_on_a_panel_below_the_minimum` |
| A fund can't copy another fund's ciphertext and count twice | enclave `a_copied_ciphertext_is_rejected` |
| The enclave tallies exactly the set the contract committed to | `a_tally_of_a_different_set_is_refused_and_the_close_can_be_retried`, `set_hash_matches_the_enclaves_fixed_vector`, `set_hash_ignores_order_but_not_content` · enclave `tally_refuses_a_set_other_than_the_committed_one` |
| A delivery for another commitment or set is refused | `a_delivery_for_another_commitment_is_refunded`, `a_delivery_for_another_set_is_refunded` · enclave `deliver_refuses_a_commitment_that_does_not_match`, `deliver_refuses_a_different_set` |
| An auditor opens only its own fund's mark | `nobody_else_can_audit_a_fund`, `the_named_auditor_gets_the_funds_own_submission_sealed`, `a_cleared_auditor_loses_access` · enclave `audit_refuses_a_ciphertext_made_for_another_account` |
| **v2.1** Every new tally commits a trimmed mean rounded to an eighth and a spread rounded to a quarter, never the exact result | enclave `tally_commits_the_rounded_result_never_the_exact_one`, `spec_example_rounded`, `rounded_matches_floating_point_on_random_rounds` · `pnpm test` ("the rounded, trimmed consensus matches the enclave's vectors") |
| **v2.1** Two colluding funds in a four-fund round can't solve for the other two marks | enclave `two_colluders_cannot_solve_a_rounded_four_fund_round` (and `two_colluders_solve_an_exact_four_fund_round`, why exact was retired) |
| **v2.1** One wild mark can't drag the mean, from five funds up | enclave `one_wild_mark_cannot_drag_the_rounded_mean`, `trimming_drops_one_from_each_end_from_five_funds` |
| **v2.1** A round committed before rounding is still delivered as it was committed | enclave `a_round_committed_before_rounding_is_delivered_as_committed` |
| **v2.1** If the council limits reads, only approved readers can buy; counted funds and their auditors still read free | `a_limited_panel_refuses_an_unapproved_buyer`, `an_approved_reader_can_buy_on_a_limited_panel`, `a_removed_reader_can_no_longer_buy`, `a_contributing_fund_still_reads_free_on_a_limited_panel`, `reads_are_open_to_anyone_by_default` |
| **v2.1** Reader changes need a council majority, and stored proposals stay readable | `one_council_member_cannot_limit_reads_alone`, `a_stale_reader_proposal_fails_cleanly`, `reader_proposals_keep_older_proposals_readable` |
| A fund removed before the close doesn't count | `a_fund_removed_before_the_close_does_not_count`, `removing_enough_funds_fails_the_round_at_close` |

## Money

| Claim | Where it is checked |
| --- | --- |
| A read fee is paid out in full: nothing lost, nothing made | `every_read_price_splits_exactly_with_nothing_lost_or_made` · **v2** `the_council_share_never_loses_or_creates_a_yocto` |
| **v2** The site shows the split the contract pays | `a_read_split_matches_the_sites_vector` · `pnpm test` ("a read fee splits as the contract pays it") |
| A failed or refused delivery sends the price back | `the_enclave_declining_a_delivery_is_refunded`, `a_failed_enclave_call_on_delivery_is_refunded`, `a_refused_delivery_sends_the_price_back` |
| A read can't be paid out twice or after a refund | `a_late_duplicate_delivery_cannot_pay_twice`, `a_refunded_purchase_cannot_later_be_delivered`, `retrying_a_read_with_the_same_key_does_not_pay_twice` |
| A bounced withdrawal stays as earnings | `a_payment_that_bounces_is_kept_as_earnings`, `a_failed_withdrawal_restores_the_earnings`, `a_payment_that_lands_is_not_credited_again` |
| Every application bond comes back, whatever the outcome | `every_bond_is_paid_back` |
| A call the enclave never answers can be settled, not before | `a_tally_that_never_answers_can_be_settled_and_closed_again`, `a_read_that_never_answers_is_refunded_and_pays_nobody`, `an_audit_that_never_answers_can_be_settled`, `a_tally_cannot_be_settled_early` |
| A fund whose mark counted reads free, once, and nobody else does | `a_contributing_fund_reads_for_free_and_nobody_is_paid`, `a_fund_gets_one_free_copy_per_round`, `an_outsider_cannot_claim_a_free_copy` |
| An enclave answer too large to read can't trap a round | `an_answer_too_long_to_read_is_a_failure_not_a_panic`, `a_read_answer_too_long_to_read_returns_the_price_not_the_fee`, `a_round_key_too_long_to_read_fails_the_round_and_keeps_the_fee` |
| A full round fits in the callback's gas | `a_full_round_fits_in_the_callback_gas` |

## Governance (v2)

| Claim | Where it is checked |
| --- | --- |
| Only the council proposes and votes | `only_the_council_proposes`, `only_the_council_votes`, `only_the_council_rejects` |
| One member can't act alone; the threshold runs the decision | `one_council_member_cannot_change_the_price_alone`, `the_threshold_runs_the_proposal_and_clears_it` |
| No double votes; a proposal lapses after a week | `a_member_cannot_vote_twice`, `a_proposal_lapses_after_a_week`, `a_proposal_still_counts_on_the_last_day` |
| A departed member's vote or approval stops counting | `a_removed_council_members_old_vote_no_longer_counts`, `an_approval_from_a_departed_council_member_does_not_count` |
| The threshold stays a majority when seats are added or it is changed | `adding_a_seat_keeps_the_threshold_a_majority`, `a_threshold_below_a_majority_cannot_be_voted_in`, `the_council_can_raise_its_threshold_by_vote`, `a_shrunk_council_can_lower_its_threshold_back` |
| A lapsed proposal is hidden and cleared from storage, with an event | `a_lapsed_proposal_is_not_listed`, `a_lapsed_proposal_is_cleared_from_storage_by_the_next_one`, `a_live_proposal_is_kept_when_another_is_made`, `a_lapsed_proposal_leaves_an_event_when_cleared` |
| One seat holds at most 4 open proposals, so it can't fill storage | `one_council_member_holds_at_most_four_open_proposals`, `another_member_can_still_propose_when_one_is_at_the_limit` |
| A proposal overtaken by another fails cleanly on its last vote, with an event | `a_proposal_that_went_stale_fails_cleanly_on_its_last_vote` |
| A seat that leaves takes its votes and approvals with it | `a_seat_that_leaves_takes_its_votes_and_approvals_with_it` |
| The threshold must be a majority; the council has 3 to 7 members | `a_threshold_of_one_is_refused`, `a_threshold_below_a_majority_is_refused`, `a_council_of_two_is_refused`, `the_council_cannot_shrink_below_three` |
| A fund joins only after enough approvals and a veto window | `one_approval_does_not_admit`, `the_window_must_pass_before_admission`, `anyone_admits_once_the_window_has_passed` |
| Any council member can veto an admission inside the window | `a_veto_inside_the_window_stops_the_admission` |
| Rounds open only on registered loans, by panel funds or the council | `a_panel_fund_opens_a_round_on_a_registered_loan`, `a_stranger_cannot_open_a_round`, `an_applicant_cannot_open_a_round`, `a_round_needs_a_registered_loan` |
| One live round per loan, however many rounds came since; a round holds its loan at most 30 days | `one_round_at_a_time_per_loan`, `a_failed_round_frees_its_loan`, `an_old_running_round_still_holds_its_loan`, `a_round_cannot_hold_its_loan_for_more_than_30_days`, `a_round_can_run_for_exactly_30_days` |
| A loan is registered once | `the_same_loan_cannot_be_registered_twice`, `the_founding_registry_cannot_list_a_loan_twice` |
| The registry holds 64 loans at a time; removing one makes room, not while its round runs | `a_full_registry_refuses_a_new_loan`, `removing_a_loan_makes_room_in_a_full_registry`, `a_loan_with_a_running_round_cannot_be_removed`, `a_removed_loan_cannot_get_a_round`, `a_past_round_keeps_its_label_after_the_loan_is_removed` |
| If the council makes no decision for the set time, two thirds of the panel's funds can replace it, and not before | `a_takeover_needs_a_silent_council`, `a_takeover_can_start_once_the_council_has_been_silent_long_enough`, `two_thirds_of_the_panel_replace_the_council` |
| Only panel funds can start or vote on a takeover, once each | `only_a_panel_fund_can_propose_a_takeover`, `only_a_panel_fund_can_vote_on_a_takeover`, `a_fund_votes_on_a_takeover_once` |
| A council that decides anything stops a takeover; one member acting alone can't | `the_council_deciding_kills_a_takeover`, `a_heartbeat_restarts_the_clock`, `an_admission_reaching_its_threshold_counts_as_a_decision`, `one_member_acting_alone_does_not_count_as_a_decision` |
| A takeover lapses after two weeks, runs one at a time, and can't repeat at once | `a_takeover_lapses_after_two_weeks`, `a_takeover_still_counts_on_its_last_day`, `only_one_takeover_runs_at_a_time`, `a_new_council_is_not_replaceable_at_once` |
| A replacement council has the same shape as the original; departed funds' votes don't count | `a_replacement_council_needs_three_members`, `a_replacement_council_needs_a_majority_threshold`, `a_removed_funds_vote_does_not_count` |
| A takeover needs a panel at the minimum size, when it starts and when it passes | `a_takeover_needs_a_panel_at_the_minimum`, `a_takeover_does_not_pass_once_the_panel_falls_below_the_minimum` |
| A new council starts without the old one's proposals or approvals | `a_new_council_starts_without_the_old_ones_proposals_or_approvals` |
| The replaced council loses its powers; the new one has them | `the_replaced_council_loses_its_powers`, `the_new_council_can_act` |
| The council is paid a fixed share of each paid read, capped at 20%, and nothing from free reads | `a_paid_read_pays_the_council_its_share_and_the_funds_the_rest`, `the_council_share_is_capped`, `a_free_read_pays_the_council_nothing` |

## Guards that were removed once, to check the tests notice

For each v2 guard (43 in all), the line was deleted locally and the suite run: at least one
test failed every time, and the line was put back.

| Guard removed | Result |
| --- | --- |
| Council-only check on `propose` | 1 test failed |
| Vote threshold | 9 tests failed |
| Veto window | 1 test failed |
| Panel/council check on `open_round` | 2 tests failed |
| One live round per loan | 1 test failed |
| Double-vote check | 1 test failed |
| Proposal expiry | 1 test failed |
| Counting only current council members' votes | 1 test failed |
| Council-only check on `reject` | 1 test failed |
| Panel-size check on `open_round` | 1 test failed |
| The council's cut of a read | 1 test failed |
| The 20% cap | 1 test failed |
| Dormancy check on a takeover | 4 tests failed |
| Two-thirds threshold on a takeover | 12 tests failed |
| Counting only current funds' takeover votes | 1 test failed |
| A council decision killing a takeover | 1 test failed |
| Panel-fund-only check on a takeover | 1 test failed |
| The takeover time limit | 2 tests failed |
| One takeover at a time | 1 test failed |
| A passed proposal counting as a decision | 2 tests failed |
| An admission reaching its threshold counting as a decision | 1 test failed |
| Validating the replacement council | 2 tests failed |
| Double takeover vote | 1 test failed |
| A new council being safe from an immediate takeover | 1 test failed |
| Raising the threshold when a seat is added | 4 tests failed |
| Counting only current members' admission approvals | 1 test failed |
| Validating a threshold change | 1 test failed |
| Hiding lapsed proposals | 1 test failed |
| Clearing lapsed proposals from storage | 1 test failed |
| The registry's 64-loan limit | 1 test failed |
| No loan removal while its round runs | 1 test failed |
| Loan removal taking effect | 3 tests failed |
| The 30-day limit on a round | 1 test failed |
| Tracking each loan's latest round (no scan window) | 3 tests failed |
| At most 4 open proposals per seat | 1 test failed |
| A stale proposal failing cleanly instead of reverting the vote | 1 test failed |
| The event for a lapsed proposal | 1 test failed |
| No duplicate loan labels | 1 test failed |
| Minimum panel to start a takeover | 1 test failed |
| Minimum panel for a takeover to pass | 1 test failed |
| A takeover clearing the old proposals | 1 test failed |
| A takeover clearing the old approvals | 1 test failed |
| A leaving seat's votes and approvals dropped | 1 test failed |

The same was done for v2.1's 12 guards:

| Guard removed (v2.1) | Result |
| --- | --- |
| Trimming (enclave) | tests failed |
| Rounding the mean to an eighth (enclave) | tests failed |
| Rounding the spread to a quarter (enclave) | tests failed |
| Tally committing the rounded result, not the exact one (enclave) | tests failed |
| Delivering a pre-rounding round exactly (enclave) | tests failed |
| Delivery checking the commitment (enclave) | tests failed |
| `buy_read` checking the allowlist | tests failed |
| No duplicate readers | tests failed |
| The 128-reader cap | tests failed |
| Turning the limit on | tests failed |
| Turning the limit off | tests failed |
| Removing a reader | tests failed |

## What no test here can show

These are in [LIMITATIONS.md](LIMITATIONS.md) and [THREAT_MODEL.md](THREAT_MODEL.md):
the enclave's hardware attestation holds (tests use the quote verifier, not Intel's
live revocation list), the council members really are independent of each other, and
the OutLayer project keeps serving the enclave.
