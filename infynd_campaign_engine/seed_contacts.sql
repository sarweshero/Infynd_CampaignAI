-- Seed sample contacts for testing
INSERT INTO contacts (id, email, name, role, company, location, category, emailclickrate, linkedinclickrate, callanswerrate, preferredtime, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'alice.johnson@techcorp.com',   'Alice Johnson',   'Senior Developer',       'TechCorp',       'San Francisco', 'Technology',    0.72, 0.45, 0.30, 'Morning',   NOW(), NOW()),
  (gen_random_uuid(), 'bob.smith@cloudbase.io',       'Bob Smith',       'CTO',                    'CloudBase',      'New York',      'Technology',    0.55, 0.60, 0.40, 'Afternoon', NOW(), NOW()),
  (gen_random_uuid(), 'carol.white@devstudio.com',    'Carol White',     'Lead Developer',         'DevStudio',      'Austin',        'Technology',    0.80, 0.50, 0.25, 'Morning',   NOW(), NOW()),
  (gen_random_uuid(), 'david.lee@startupxyz.com',     'David Lee',       'Software Engineer',      'StartupXYZ',     'Seattle',       'Technology',    0.65, 0.40, 0.35, 'Evening',   NOW(), NOW()),
  (gen_random_uuid(), 'emma.davis@enterprise.com',    'Emma Davis',      'VP Engineering',         'Enterprise Co',  'Boston',        'Technology',    0.70, 0.55, 0.45, 'Afternoon', NOW(), NOW()),
  (gen_random_uuid(), 'frank.miller@saasplatform.io', 'Frank Miller',    'Platform Engineer',      'SaaS Platform',  'Chicago',       'Technology',    0.60, 0.35, 0.20, 'Morning',   NOW(), NOW()),
  (gen_random_uuid(), 'grace.chen@fintech.com',       'Grace Chen',      'Technical Director',     'FinTech Ltd',    'London',        'Finance',       0.50, 0.65, 0.50, 'Morning',   NOW(), NOW()),
  (gen_random_uuid(), 'henry.brown@healthapp.com',    'Henry Brown',     'Developer',              'HealthApp',      'Toronto',       'Healthcare',    0.45, 0.30, 0.60, 'Afternoon', NOW(), NOW()),
  (gen_random_uuid(), 'isabella.jones@retailtech.com','Isabella Jones',  'Backend Developer',      'RetailTech',     'Los Angeles',   'Retail',        0.75, 0.55, 0.30, 'Morning',   NOW(), NOW()),
  (gen_random_uuid(), 'james.wilson@aicompany.com',   'James Wilson',    'ML Engineer',            'AI Company',     'San Jose',      'Technology',    0.85, 0.70, 0.40, 'Evening',   NOW(), NOW()),
  (gen_random_uuid(), 'sarweshero@gmail.com',          'Sarwesh Hero',    'Developer',              'InFynd',         'Chennai',       'Technology',    0.78, 0.55, 0.35, 'Morning',   NOW(), NOW()),
  (gen_random_uuid(), 'sarweshwardeivasihamani@gmail.com', 'Sarweshwar Deivasihamani', 'CTO',        'InFynd',         'Chennai',       'Technology',    0.82, 0.70, 0.50, 'Morning',   NOW(), NOW())
ON CONFLICT (email) DO NOTHING;