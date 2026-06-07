-- Schema-fidelity H17: first-class dimensions + passthrough for unknown objects.csv columns.
-- dimensions: framework-rendered object dimension string (e.g. "24 x 30 cm").
-- extra_columns: JSON object of custom objects.csv columns the Compositor has no
-- first-class column for; NULL when none.
ALTER TABLE objects ADD COLUMN dimensions text;
ALTER TABLE objects ADD COLUMN extra_columns text;
