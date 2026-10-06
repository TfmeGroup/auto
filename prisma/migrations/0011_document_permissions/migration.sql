-- Downloading used to be part of "view documents". It is now its own permission, so a custom role that could view
-- documents keeps being able to open them.
INSERT INTO role_permissions (role_id, permission)
SELECT role_id, 'document.download' FROM role_permissions WHERE permission = 'document.view'
ON CONFLICT DO NOTHING;
