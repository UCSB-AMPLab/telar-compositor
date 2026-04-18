-- Add order column to objects table for Y.Array position tracking
ALTER TABLE objects ADD COLUMN "order" integer NOT NULL DEFAULT 0;
