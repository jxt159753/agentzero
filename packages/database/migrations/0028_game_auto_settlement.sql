ALTER TABLE public.arcade_games
  ADD COLUMN settlement_rule text NOT NULL DEFAULT 'manual',
  ADD CONSTRAINT arcade_games_settlement_rule_check
    CHECK (settlement_rule IN ('manual','starlight_slots_v1')
      AND (settlement_rule='manual' OR (entry_fee=1 AND max_reward=3)));

-- Existing sessions keep their original manual settlement contract. New sessions
-- copy the selected rule, so later publication edits cannot alter a paid round.
ALTER TABLE public.arcade_game_sessions
  ADD COLUMN settlement_rule text NOT NULL DEFAULT 'manual',
  ADD CONSTRAINT arcade_sessions_settlement_rule_check
    CHECK (settlement_rule IN ('manual','starlight_slots_v1')
      AND (settlement_rule='manual' OR (entry_fee=1 AND max_reward=3)));
