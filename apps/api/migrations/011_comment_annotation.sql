-- Annotation drawing on comments. JSONB of {strokes: [{tool, color, points: [[x,y],...]}]} normalized 0..1
ALTER TABLE comments
  ADD COLUMN IF NOT EXISTS annotation JSONB;
