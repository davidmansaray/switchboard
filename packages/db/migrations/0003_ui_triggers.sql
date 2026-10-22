-- Live UI: NOTIFY for the tables added in 0002, and for signal updates
-- (merged_into is set after the row is written).
CREATE TRIGGER desk_steps_notify AFTER INSERT ON app.desk_steps FOR EACH ROW EXECUTE FUNCTION app.notify_change();
--> statement-breakpoint
CREATE TRIGGER desk_runs_notify AFTER INSERT OR UPDATE ON app.desk_runs FOR EACH ROW EXECUTE FUNCTION app.notify_change();
--> statement-breakpoint
CREATE TRIGGER scenario_beats_notify AFTER INSERT OR UPDATE OR DELETE ON app.scenario_beats FOR EACH ROW EXECUTE FUNCTION app.notify_change();
--> statement-breakpoint
CREATE TRIGGER ops_log_notify AFTER INSERT ON app.ops_log FOR EACH ROW EXECUTE FUNCTION app.notify_change();
--> statement-breakpoint
CREATE TRIGGER signals_log_update_notify AFTER UPDATE ON app.signals_log FOR EACH ROW EXECUTE FUNCTION app.notify_change();
--> statement-breakpoint
CREATE TRIGGER credit_notes_notify AFTER INSERT ON app.credit_notes FOR EACH ROW EXECUTE FUNCTION app.notify_change();
--> statement-breakpoint
-- DELETE rows have no NEW: fall back to OLD so a scenario reset is announced too.
CREATE OR REPLACE FUNCTION app.notify_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r jsonb := to_jsonb(COALESCE(NEW, OLD));
BEGIN
  PERFORM pg_notify('switchboard', json_build_object(
    'table', TG_TABLE_NAME, 'op', TG_OP, 'id', r ->> 'id',
    'hireId', CASE WHEN TG_TABLE_NAME = 'hires' THEN r ->> 'id' ELSE r ->> 'hire_id' END)::text);
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Fleet register facts for databases seeded before 0002 (seed.ts inserts the same rows, idempotently).
INSERT INTO app.fleet (fleet_no, kind, ipaf_category, loler_due, loler_interval_months) VALUES
  ('AB19-07', 'boom', '3b', '2027-03-18', 6),
  ('TH14-22', 'telehandler', NULL, '2027-06-02', 12),
  ('TH17-05', 'telehandler', NULL, '2027-01-26', 12),
  ('SC10-03/04', 'scissor', '3a', '2027-02-09', 6),
  ('DP03-11', 'dumper', NULL, NULL, NULL),
  ('MX15-04', 'excavator', NULL, '2027-05-11', 12),
  ('TL09-21..24', 'lighting', NULL, NULL, NULL),
  ('GN100-02', 'generator', NULL, NULL, NULL),
  ('SP17-01', 'spider', '3b', '2026-12-14', 6),
  ('AB26-02', 'boom', '3b', '2027-04-01', 6)
ON CONFLICT (fleet_no) DO NOTHING;
