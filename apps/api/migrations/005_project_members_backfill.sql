INSERT INTO project_members (project_id, user_id, role, position)
SELECT
  t.project_id,
  t.user_id,
  CASE
    WHEN t.position = 0 THEN 'owner'
    WHEN u.role = 'client' THEN 'client'
    ELSE 'editor'
  END,
  t.position
FROM project_team t
JOIN users u ON u.id = t.user_id
ON CONFLICT (project_id, user_id) DO NOTHING;
