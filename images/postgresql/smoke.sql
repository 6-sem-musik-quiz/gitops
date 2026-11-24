-- Run ONLY against a fresh, isolated test database; never the shared PVC.
\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS vector;
SELECT extversion FROM pg_extension WHERE extname = 'vector';

CREATE TABLE smoke_test (
    id integer PRIMARY KEY,
    embedding vector(768)
);
CREATE INDEX smoke_test_hnsw ON smoke_test USING hnsw (embedding vector_cosine_ops);

-- Exercise the same JSONB recordset -> vector -> upsert path used by Knowledge.
WITH payload AS (
    SELECT jsonb_agg(jsonb_build_object(
        'id', g,
        'embedding', ARRAY(SELECT (random() + g * 0.00001)::real FROM generate_series(1, 768))::vector::text
    )) AS body
    FROM generate_series(1, 219) AS g
)
INSERT INTO smoke_test (id, embedding)
SELECT r.id, r.embedding::vector
FROM payload CROSS JOIN LATERAL jsonb_to_recordset(payload.body) AS r(id integer, embedding text)
ON CONFLICT (id) DO UPDATE SET embedding = excluded.embedding;

INSERT INTO smoke_test (id, embedding)
SELECT id, embedding FROM smoke_test WHERE id = 1
ON CONFLICT (id) DO UPDATE SET embedding = excluded.embedding;

DO $$
BEGIN
    IF (SELECT count(*) FROM smoke_test) <> 219 THEN
        RAISE EXCEPTION 'Expected 219 embeddings';
    END IF;
    IF (SELECT extversion FROM pg_extension WHERE extname = 'vector') <> '0.8.7' THEN
        RAISE EXCEPTION 'Unexpected pgvector version';
    END IF;
END $$;

SELECT count(*) FROM smoke_test;
SET enable_seqscan = off;
SELECT id FROM smoke_test
ORDER BY embedding <=> (SELECT embedding FROM smoke_test WHERE id = 1)
LIMIT 5;
