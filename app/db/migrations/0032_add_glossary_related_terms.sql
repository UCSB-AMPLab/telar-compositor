-- Schema-fidelity H18: preserve framework glossary related_terms.
-- related_terms: pipe-separated (|) list of related term_ids, rendered by the
-- framework as cross-reference links. Stored verbatim as the CSV cell value; NULL when none.
ALTER TABLE glossary_terms ADD COLUMN related_terms text;
