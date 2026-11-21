use super::*;

fn test_monitors() -> Vec<MonitorInfo> {
    vec![MonitorInfo {
        index: 0,
        name: "test".into(),
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        scale: 1.0,
        primary: true,
    }]
}

fn test_round() -> Round {
    let snapshot = mock_snapshot(&test_monitors());
    let mut round = Round::new(snapshot, "zh-CN".into(), true, true, false);
    round.begin();
    round
}

#[test]
fn draw_fills_slots_and_empties_pool() {
    let mut round = test_round();
    let total = round.total();
    for slot in 0..total {
        round.draw(slot as u32).unwrap();
    }
    assert_eq!(round.pool.len(), 0);
    assert!(round.placements.iter().all(|slot| slot.is_some()));
    assert_eq!(round.moves, total as u32);
    round.finish().unwrap();
    assert!(round.result.is_some());
}

#[test]
fn finish_before_all_drawn_is_rejected() {
    let mut round = test_round();
    round.draw(0).unwrap();
    assert_eq!(round.finish().unwrap_err().code, "not_all_drawn");
}

#[test]
fn time_limit_formula_centered() {
    assert_eq!(time_limit_ms(24), 150_000);
    assert_eq!(time_limit_ms(1), 35_000);
    assert_eq!(time_limit_ms(120), 630_000);
}

#[test]
fn study_duration_scales_and_clamps() {
    assert_eq!(study_duration_ms(2), 3_000);
    assert_eq!(study_duration_ms(24), 4_880);
    assert_eq!(study_duration_ms(120), 6_000);
}

#[test]
fn skip_study_starts_after_the_flip_settles() {
    let mut round = test_round();
    assert!(round.started_at_ms > now_ms(), "开局应先进入记忆阶段");
    round.skip_study().unwrap();
    let now = now_ms();
    assert!(round.started_at_ms > now, "跳过仍要留出卡面翻下的过渡");
    assert!(
        round.started_at_ms <= now + FLIP_MS,
        "过渡只占翻下时长，不再推迟"
    );
    assert_eq!(round.public_state().flip_ms, FLIP_MS);
}

#[test]
fn skip_study_before_begin_is_rejected() {
    let snapshot = mock_snapshot(&test_monitors());
    let mut round = Round::new(snapshot, "zh-CN".into(), true, true, false);
    assert_eq!(round.skip_study().unwrap_err().code, "no_round");
}

#[test]
fn timeout_finish_scores_placed_only_and_marks_timeout() {
    let snapshot = mock_snapshot(&test_monitors());
    let mut round = Round::new(snapshot, "zh-CN".into(), true, true, true);
    round.begin();
    round.draw(0).unwrap();
    round.placements[0] = Some(0);
    // 池未清空、槽位未填满——超时结算绕过两个拒绝条件，只计已放好的。
    let result = round.finish_timed_out().unwrap();
    assert!(result.timed_out);
    assert_eq!(result.correct, 1);
    assert_eq!(result.total, round.total());
    assert_eq!(result.elapsed_ms, time_limit_ms(round.total()));
}

#[test]
fn normal_finish_still_rejects_and_reports_no_timeout() {
    let mut round = test_round();
    round.draw(0).unwrap();
    assert_eq!(round.finish().unwrap_err().code, "not_all_drawn");
    let mut round = test_round();
    let total = round.total();
    for slot in 0..total {
        round.draw(slot as u32).unwrap();
    }
    let result = round.finish().unwrap();
    assert!(!result.timed_out);
}

#[test]
fn identity_placement_scores_100() {
    let mut round = test_round();
    round.placements = (0..round.total()).map(|i| Some(i as u32)).collect();
    round.pool.clear();
    let result = round.finish().unwrap();
    assert_eq!(result.correct, round.total());
    assert_eq!(result.accuracy, 100);
}

#[test]
fn moving_a_card_changes_accuracy() {
    let mut round = test_round();
    round.placements = (0..round.total()).map(|i| Some(i as u32)).collect();
    round.pool.clear();
    round.move_card(0, 1).unwrap();
    let result = round.finish().unwrap();
    assert_eq!(result.correct, round.total() - 2);
}

#[test]
fn move_requires_a_card() {
    let mut round = test_round();
    assert_eq!(round.move_card(0, 1).unwrap_err().code, "empty_slot");
}

#[test]
fn replay_clears_state() {
    let mut round = test_round();
    round.placements = (0..round.total()).map(|i| Some(i as u32)).collect();
    round.pool.clear();
    round.finish().unwrap();
    round.replay().unwrap();
    assert!(round.placements.iter().all(|slot| slot.is_none()));
    assert_eq!(round.pool.len(), round.total());
    assert_eq!(round.moves, 0);
    assert!(round.result.is_none());
    assert!(round.started_at_ms > 0);
}

#[test]
fn replay_before_finish_is_rejected() {
    let mut round = test_round();
    round.draw(0).unwrap();
    assert_eq!(round.replay().unwrap_err().code, "round_not_finished");
    // 进度未被清空。
    assert_eq!(round.pool.len(), round.total() - 1);
    assert!(round.placements[0].is_some());
}

#[test]
fn new_layout_uses_slot_positions() {
    let mut round = test_round();
    round.placements = (0..round.total()).map(|i| Some(i as u32)).collect();
    round.pool.clear();
    round.move_card(0, 1).unwrap();
    round.finish().unwrap();
    let positions = round.new_layout_positions().unwrap();
    let slot1 = round.snapshot.icons[1].cell;
    let icon0 = positions
        .iter()
        .find(|write| write.name == round.snapshot.icons[0].name)
        .unwrap();
    assert_eq!((icon0.x, icon0.y), (slot1.x, slot1.y));
}

#[test]
fn positions_carry_icon_names() {
    let round = test_round();
    let original = round.original_positions();
    let icon0 = &round.snapshot.icons[0];
    assert_eq!(original[0].name, icon0.name);
    assert_eq!((original[0].x, original[0].y), (icon0.cell.x, icon0.cell.y));
}

#[test]
fn move_to_same_slot_does_not_count() {
    let mut round = test_round();
    round.placements = (0..round.total()).map(|i| Some(i as u32)).collect();
    round.pool.clear();
    round.move_card(2, 2).unwrap();
    assert_eq!(round.moves, 0);
}
