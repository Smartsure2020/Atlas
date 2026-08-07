-- Atlas RLS Validation Script
-- ---------------------------------------------------------------------------
-- Run this against a local or staging Supabase database to verify that RLS
-- policies enforce the expected access boundaries.
--
-- Prerequisites:
--   1. Apply all migrations (0001 through 0017).
--   2. Create test users via Supabase Admin API with the following roles
--      stamped in app_metadata.atlas_role:
--        - anonymous (no session / anon key)
--        - readonly  (atlas_role = 'readonly')
--        - consultant (atlas_role = 'consultant')
--        - manager   (atlas_role = 'manager')
--        - admin     (atlas_role = 'admin')
--   3. Create a test submission owned by the consultant user.
--   4. Run each block below as the indicated user (set role + auth.uid()).
--
-- Each test documents the expected outcome. Failures surface as result
-- mismatches, not as policy weakening.
-- ---------------------------------------------------------------------------

-- ==========================================================================
-- HELPER: set session context to simulate a specific user
-- ==========================================================================
-- Usage: SELECT set_test_user('<user_uuid>', '<atlas_role>');
-- Call set_test_anon() to simulate anonymous access.

CREATE OR REPLACE FUNCTION set_test_user(p_user_id uuid, p_role text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object(
    'sub', p_user_id::text,
    'role', 'authenticated',
    'app_metadata', json_build_object('atlas_role', p_role)
  )::text, true);
  PERFORM set_config('role', 'authenticated', true);
END;
$$;

CREATE OR REPLACE FUNCTION set_test_anon()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{}', true);
  PERFORM set_config('role', 'anon', true);
END;
$$;

-- ==========================================================================
-- TEST DATA SETUP
-- (Run as service_role / superuser)
-- ==========================================================================

-- Create test user UUIDs (use these consistently)
DO $$
DECLARE
  v_anon_id     uuid := '00000000-0000-0000-0000-000000000001';
  v_readonly_id uuid := '00000000-0000-0000-0000-000000000002';
  v_consultant_id uuid := '00000000-0000-0000-0000-000000000003';
  v_manager_id  uuid := '00000000-0000-0000-0000-000000000004';
  v_admin_id    uuid := '00000000-0000-0000-0000-000000000005';
  v_other_consultant_id uuid := '00000000-0000-0000-0000-000000000006';
  v_submission_id uuid;
  v_other_submission_id uuid;
BEGIN
  -- Insert test submissions
  INSERT INTO atlas_submissions (id, client_name, broker_name, status, created_by, assigned_to)
  VALUES (gen_random_uuid(), 'Test Client A', 'Test Broker', 'new', v_consultant_id, v_consultant_id)
  RETURNING id INTO v_submission_id;

  INSERT INTO atlas_submissions (id, client_name, broker_name, status, created_by, assigned_to)
  VALUES (gen_random_uuid(), 'Test Client B', 'Other Broker', 'new', v_other_consultant_id, v_other_consultant_id)
  RETURNING id INTO v_other_submission_id;

  RAISE NOTICE 'Test submission A: %', v_submission_id;
  RAISE NOTICE 'Test submission B: %', v_other_submission_id;
  RAISE NOTICE 'Consultant: %', v_consultant_id;
  RAISE NOTICE 'Other consultant: %', v_other_consultant_id;
  RAISE NOTICE 'Manager: %', v_manager_id;
END $$;

-- ==========================================================================
-- TEST 1: ANONYMOUS USER — should see NOTHING
-- ==========================================================================
-- Expected: 0 rows on all tables

SELECT set_test_anon();

-- Each of these should return 0 rows:
SELECT count(*) AS anon_submissions FROM atlas_submissions;
-- EXPECT: 0

SELECT count(*) AS anon_documents FROM atlas_documents;
-- EXPECT: 0

SELECT count(*) AS anon_jobs FROM atlas_jobs;
-- EXPECT: 0

SELECT count(*) AS anon_pilot_issues FROM atlas_pilot_issues;
-- EXPECT: 0

SELECT count(*) AS anon_audit_logs FROM atlas_audit_logs;
-- EXPECT: 0

SELECT count(*) AS anon_operational_alerts FROM atlas_operational_alerts;
-- EXPECT: 0

-- ==========================================================================
-- TEST 2: READONLY USER — can read scoped submissions, nothing else
-- ==========================================================================

-- set_test_user('00000000-0000-0000-0000-000000000002', 'readonly');
-- readonly/auditor sees all submissions via atlas_can_access_submission

-- Can SELECT submissions: YES (readonly is in manager/admin/readonly/auditor list)
-- Can INSERT submissions: NO (atlas_can_write() returns false for readonly)
-- Can UPDATE submissions: NO

-- ==========================================================================
-- TEST 3: CONSULTANT — can read/write own submissions only
-- ==========================================================================

-- set_test_user('00000000-0000-0000-0000-000000000003', 'consultant');

-- Can SELECT own submission: YES
-- Can SELECT other consultant's submission: NO (not created_by, not assigned_to)
-- Can INSERT submission (with created_by = self): YES
-- Can INSERT submission (with created_by = someone else): NO
-- Can UPDATE own submission: YES
-- Can UPDATE other's submission: NO

-- ==========================================================================
-- TEST 4: MANAGER — can read all, write all, manage jobs and alerts
-- ==========================================================================

-- set_test_user('00000000-0000-0000-0000-000000000004', 'manager');

-- Can SELECT all submissions: YES
-- Can SELECT atlas_jobs: YES (manager-only policy)
-- Can SELECT atlas_operational_alerts: YES
-- Can SELECT atlas_cleanup_candidates: YES
-- Can INSERT/UPDATE jobs: YES
-- Can INSERT/UPDATE alerts: YES

-- ==========================================================================
-- TEST 5: ADMIN — same as manager
-- ==========================================================================

-- set_test_user('00000000-0000-0000-0000-000000000005', 'admin');
-- Same expectations as manager for all tables.

-- ==========================================================================
-- TABLE-BY-TABLE VERIFICATION CHECKLIST
-- ==========================================================================
--
-- For each table, verify:
--   [anon]       SELECT → 0 rows, INSERT → denied, UPDATE → denied, DELETE → denied
--   [readonly]   SELECT → scoped, INSERT → denied, UPDATE → denied
--   [consultant] SELECT → own only, INSERT → own only, UPDATE → own only
--   [manager]    SELECT → all, INSERT → yes, UPDATE → yes
--   [admin]      SELECT → all, INSERT → yes, UPDATE → yes
--
-- Tables to cover:
--   atlas_submissions
--   atlas_documents
--   atlas_extractions
--   atlas_recommendations
--   atlas_decisions
--   atlas_quote_reviews
--   atlas_quote_review_sections
--   atlas_missing_info_items
--   atlas_communications
--   atlas_jobs                    (manager-only)
--   atlas_operational_alerts      (manager-only)
--   atlas_cleanup_candidates      (manager-only)
--   atlas_audit_logs              (staff-select only)
--   atlas_insurers                (staff-select, manager-write)
--   atlas_insurer_documents       (staff-select, manager-write)
--   atlas_insurer_appetite        (staff-select, manager-write)
--   atlas_appetite_history        (staff-select)
--   atlas_pilot_issues            (staff-select/insert, manager-update)
--
-- DELETE policies: No table has an explicit DELETE policy for authenticated
-- users. Deletion is handled by the service-role background worker, not by
-- user-facing RLS. This is intentional — verified by confirming DELETE fails
-- for all authenticated roles.

-- ==========================================================================
-- CLEANUP
-- After running, delete test data:
--   DELETE FROM atlas_submissions WHERE client_name LIKE 'Test Client%';
-- ==========================================================================
