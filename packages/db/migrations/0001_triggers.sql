-- Version triggers, staleness, snapshots/diffs and LISTEN/NOTIFY.
-- The database is the source of truth for "what version is this hire at" and
-- "is this draft stale"; tools and the UI read these, they never compute them.

-- Deep diff of two jsonb documents as [{path, from, to}] (objects recurse, arrays compare whole).
CREATE OR REPLACE FUNCTION app.jsonb_diff(a jsonb, b jsonb, prefix text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  k text;
  out jsonb := '[]'::jsonb;
  p text;
BEGIN
  IF jsonb_typeof(a) = 'object' AND jsonb_typeof(b) = 'object' THEN
    FOR k IN SELECT DISTINCT key FROM (SELECT jsonb_object_keys(a) AS key UNION SELECT jsonb_object_keys(b)) ks ORDER BY 1 LOOP
      p := CASE WHEN prefix = '' THEN k ELSE prefix || '.' || k END;
      out := out || app.jsonb_diff(COALESCE(a -> k, 'null'::jsonb), COALESCE(b -> k, 'null'::jsonb), p);
    END LOOP;
    RETURN out;
  END IF;
  IF a IS DISTINCT FROM b THEN
    RETURN jsonb_build_array(jsonb_build_object('path', prefix, 'from', a, 'to', b));
  END IF;
  RETURN '[]'::jsonb;
END $$;
--> statement-breakpoint

-- Business snapshot of a hire (camelCase keys match @switchboard/core tiers).
CREATE OR REPLACE FUNCTION app.hire_snapshot(h_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'ref', h.ref,
    'site', h.site,
    'siteArea', h.site_area,
    'deliveryDate', h.delivery_date,
    'deliverySlot', h.delivery_slot,
    'durationDays', h.duration_days,
    'status', h.status,
    'poNumber', h.po_number,
    'invoiceAddress', h.invoice_address,
    'siteContactId', h.site_contact_id,
    'discountPct', h.discount_pct,
    'damageWaiver', h.damage_waiver,
    'waiverRatePct', h.waiver_rate_pct,
    'transportPence', h.transport_pence,
    'totalPence', h.total_pence,
    'lines', COALESCE((
      SELECT jsonb_object_agg(l.line_no::text, jsonb_build_object(
        'kind', l.kind, 'model', l.model, 'description', l.description, 'spec', l.spec, 'fleetNo', l.fleet_no, 'status', l.status,
        'weeklyRatePence', l.weekly_rate_pence, 'quantity', l.quantity))
      FROM app.hire_lines l WHERE l.hire_id = h.id), '{}'::jsonb)
  )
  FROM app.hires h WHERE h.id = h_id
$$;
--> statement-breakpoint

-- BEFORE UPDATE: bump version once per transaction when business columns change
-- (or when a line trigger asks for a bump by touching version).
CREATE OR REPLACE FUNCTION app.hires_bump_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  strip text[] := ARRAY['version', 'version_txid', 'updated_at', 'updated_by'];
  changed boolean;
BEGIN
  changed := (to_jsonb(NEW) - strip) IS DISTINCT FROM (to_jsonb(OLD) - strip) OR NEW.version <> OLD.version;
  IF NOT changed THEN
    NEW.version := OLD.version;
    RETURN NEW;
  END IF;
  IF OLD.version_txid = txid_current()::text THEN
    NEW.version := OLD.version;            -- same transaction: same version
  ELSE
    NEW.version := OLD.version + 1;
    NEW.version_txid := txid_current()::text;
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := COALESCE(NULLIF(current_setting('app.actor', true), ''), NEW.updated_by, 'system');
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER hires_bump_version BEFORE UPDATE ON app.hires
FOR EACH ROW EXECUTE FUNCTION app.hires_bump_version();
--> statement-breakpoint

-- AFTER INSERT/UPDATE: write the version snapshot + diff, and mark drafts stale
-- when a non-routine field moved past their based_on_version.
CREATE OR REPLACE FUNCTION app.hires_record_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snap jsonb := app.hire_snapshot(NEW.id);
  prev jsonb;
  d jsonb;
  material boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version AND OLD.version_txid IS DISTINCT FROM txid_current()::text THEN
    RETURN NULL;  -- no business change
  END IF;
  SELECT snapshot INTO prev FROM app.hire_versions WHERE hire_id = NEW.id AND version = NEW.version - 1;
  d := CASE WHEN prev IS NULL THEN '[]'::jsonb ELSE app.jsonb_diff(prev, snap) END;
  INSERT INTO app.hire_versions (hire_id, version, snapshot, diff, changed_by, changed_at)
  VALUES (NEW.id, NEW.version, snap, d, COALESCE(NULLIF(current_setting('app.actor', true), ''), NEW.updated_by, 'system'), now())
  ON CONFLICT (hire_id, version) DO UPDATE SET snapshot = EXCLUDED.snapshot, diff = EXCLUDED.diff, changed_at = now();

  -- Routine-tier fields (PO, invoice address, site contact) don't invalidate drafts.
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(d) e
    WHERE split_part(e ->> 'path', '.', 1) NOT IN (SELECT field FROM app.approval_tiers WHERE tier = 'auto')
  ) INTO material;
  IF material THEN
    UPDATE app.drafts
       SET status = 'stale',
           stale_reason = format('hire moved v%s → v%s', based_on_version, NEW.version)
     WHERE hire_id = NEW.id AND status = 'pending' AND based_on_version < NEW.version;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER hires_record_version AFTER INSERT OR UPDATE ON app.hires
FOR EACH ROW EXECUTE FUNCTION app.hires_record_version();
--> statement-breakpoint

-- Line changes bump the parent hire's version (v4 → v5 when Jo swaps the telehandler).
CREATE OR REPLACE FUNCTION app.hire_lines_touch_hire()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD)) THEN
    RETURN NULL;
  END IF;
  UPDATE app.hires SET version = version + 1 WHERE id = COALESCE(NEW.hire_id, OLD.hire_id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER hire_lines_touch_hire AFTER UPDATE OR DELETE ON app.hire_lines
FOR EACH ROW EXECUTE FUNCTION app.hire_lines_touch_hire();
--> statement-breakpoint

-- LISTEN/NOTIFY for the live UI: one channel, small payloads (clients refetch).
CREATE OR REPLACE FUNCTION app.notify_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r jsonb := to_jsonb(NEW);
BEGIN
  PERFORM pg_notify('switchboard', json_build_object(
    'table', TG_TABLE_NAME, 'op', TG_OP, 'id', r ->> 'id',
    'hireId', CASE WHEN TG_TABLE_NAME = 'hires' THEN r ->> 'id' ELSE r ->> 'hire_id' END)::text);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER events_notify AFTER INSERT OR UPDATE ON app.events FOR EACH ROW EXECUTE FUNCTION app.notify_change();
--> statement-breakpoint
CREATE TRIGGER drafts_notify AFTER INSERT OR UPDATE ON app.drafts FOR EACH ROW EXECUTE FUNCTION app.notify_change();
--> statement-breakpoint
CREATE TRIGGER desks_notify AFTER INSERT OR UPDATE ON app.desks FOR EACH ROW EXECUTE FUNCTION app.notify_change();
--> statement-breakpoint
CREATE TRIGGER signals_log_notify AFTER INSERT ON app.signals_log FOR EACH ROW EXECUTE FUNCTION app.notify_change();
--> statement-breakpoint
CREATE TRIGGER hires_notify AFTER UPDATE ON app.hires FOR EACH ROW EXECUTE FUNCTION app.notify_change();
--> statement-breakpoint
CREATE TRIGGER outbox_notify AFTER INSERT ON app.outbox FOR EACH ROW EXECUTE FUNCTION app.notify_change();
--> statement-breakpoint
CREATE TRIGGER approvals_notify AFTER INSERT ON app.approvals FOR EACH ROW EXECUTE FUNCTION app.notify_change();
--> statement-breakpoint
CREATE TRIGGER action_attempts_notify AFTER INSERT ON app.action_attempts FOR EACH ROW EXECUTE FUNCTION app.notify_change();
