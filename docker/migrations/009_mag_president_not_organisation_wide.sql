-- 009: the Mesa da Assembleia Geral president is no longer organisation-wide admin (#189).
--
-- `_ADMIN` is deliberately organisation-wide: `canForTeam` short-circuits on it for EVERY team,
-- which is what "board members have full access" means. Seeding `Mesa da Assembleia Geral /
-- Presidente` as `admin` therefore handed that body blanket read access to every team's
-- workspace, including Direção's.
--
-- Decided 2026-08-22: the Presidente and Vice-Presidente **of Direção** have access to
-- everything. The Mesa da Assembleia Geral gets only what it is explicitly given. So its
-- president becomes `coordinator` — full power inside the MAG, none outside it — which also puts
-- them level with their own vice-president, already `coordinator`.
--
-- `Dev-Team / Coordenador` stays `admin` on purpose. That was the other half of #189 and it was
-- decided the other way: the Dev-Team coordinator (and only the coordinator — the team's other
-- roles are `member`/`shop_manager`) keeps organisation-wide access for now.
--
-- Idempotent twice over: it goes through `update_valid_department_role`, and it fires only while
-- the row still holds the seeded `admin`. A deliberate later change through the roles screen is
-- therefore never overwritten by a re-run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM neiist.valid_department_roles
    WHERE department_name = 'Mesa da Assembleia Geral'
      AND role_name = 'Presidente'
      AND access = 'admin'
      AND active
  ) THEN
    -- Through the function, not a bare UPDATE, so the last-admin guard (NEI07) still applies.
    -- Four admin-granting roles remain afterwards, so it cannot trip; going through it anyway
    -- means this migration cannot become the one path that bypasses the invariant.
    PERFORM neiist.update_valid_department_role(
      'Mesa da Assembleia Geral', 'Presidente', 'coordinator'
    );
  END IF;
END
$$;
