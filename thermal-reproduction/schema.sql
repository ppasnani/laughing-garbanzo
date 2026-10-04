PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS paper (
    id TEXT PRIMARY KEY,                 -- OpenAlex ID
    title TEXT NOT NULL,
    doi TEXT,
    pdf_path TEXT,
    pdf_sha256 TEXT,
    source_status TEXT NOT NULL CHECK (source_status IN ('downloaded', 'unavailable')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS experiment (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES paper(id),
    label TEXT NOT NULL,
    target_metric TEXT,
    target_value REAL,
    target_unit TEXT,
    target_page INTEGER,
    decision TEXT NOT NULL CHECK (decision IN
        ('exact_eligible', 'adapted_only', 'unsupported_current_backend', 'source_unavailable')),
    required_capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_capabilities_json)),
    feasibility_reason TEXT NOT NULL,
    UNIQUE (paper_id, label)
);

CREATE TABLE IF NOT EXISTS evidence (
    id INTEGER PRIMARY KEY,
    experiment_id TEXT NOT NULL REFERENCES experiment(id) ON DELETE CASCADE,
    field_name TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    pdf_page INTEGER,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('paper', 'backend_default', 'assumption')),
    note TEXT,
    CHECK (pdf_page IS NULL OR pdf_page > 0)
);

CREATE TABLE IF NOT EXISTS workflow_run (
    id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL REFERENCES experiment(id),
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'extracting', 'reviewing', 'simulating', 'assessing',
                                          'completed', 'skipped', 'failed')),
    graph_sha256 TEXT NOT NULL,
    code_version TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS workflow_run_experiment_started
    ON workflow_run(experiment_id, started_at DESC);

CREATE TABLE IF NOT EXISTS llm_call (
    id INTEGER PRIMARY KEY,
    workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
    step_name TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_sha256 TEXT NOT NULL,
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    input_tokens INTEGER,
    output_tokens INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS simulation (
    id TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
    studio_run_id TEXT UNIQUE,
    backend_version TEXT NOT NULL,
    config_text TEXT NOT NULL,
    config_sha256 TEXT NOT NULL,
    status TEXT NOT NULL,
    temperatures_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(temperatures_json)),
    solver_log TEXT,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS artifact (
    id INTEGER PRIMARY KEY,
    simulation_id TEXT NOT NULL REFERENCES simulation(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('gcc.steady', 'gcc.ttrace', 'config', 'result_json', 'run_log')),
    storage_path TEXT NOT NULL,          -- copied durable file; serve through the app
    sha256 TEXT NOT NULL,
    byte_count INTEGER NOT NULL CHECK (byte_count > 0),
    media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    UNIQUE (simulation_id, kind)
);

CREATE TABLE IF NOT EXISTS comparison (
    id INTEGER PRIMARY KEY,
    workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
    metric TEXT NOT NULL,
    paper_value REAL,
    simulation_value REAL,
    unit TEXT,
    paper_page INTEGER,
    comparison_valid INTEGER NOT NULL CHECK (comparison_valid IN (0, 1)),
    explanation TEXT NOT NULL
);

CREATE VIEW IF NOT EXISTS app_paper_summary AS
SELECT p.id AS paper_id, p.title, p.source_status, e.id AS experiment_id,
       e.label, e.decision, e.feasibility_reason,
       w.id AS latest_workflow_run_id, w.status AS latest_status,
       s.studio_run_id, s.status AS simulation_status
FROM paper p
LEFT JOIN experiment e ON e.paper_id = p.id
LEFT JOIN workflow_run w ON w.id = (
    SELECT wr.id FROM workflow_run wr WHERE wr.experiment_id = e.id
    ORDER BY wr.started_at DESC, wr.id DESC LIMIT 1
)
LEFT JOIN simulation s ON s.id = (
    SELECT sim.id FROM simulation sim WHERE sim.workflow_run_id = w.id
    ORDER BY sim.started_at DESC, sim.id DESC LIMIT 1
);

-- The 2D audit has a different decision vocabulary from the original bundled screen.
-- Keep its evidence and artifacts separately so existing pilot databases remain readable.
CREATE TABLE IF NOT EXISTS snapshot_screening_run (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES paper(id),
    decision TEXT NOT NULL CHECK (decision IN
        ('candidate_2d_snapshot', 'conditional_2d_snapshot', 'illustrative_2d_only',
         'not_2d_applicable', 'source_unavailable')),
    studio_run_id TEXT,
    status TEXT NOT NULL,
    pdf_sha256 TEXT NOT NULL,
    manifest_sha256 TEXT,
    graph_sha256 TEXT NOT NULL,
    evidence_sha256 TEXT,
    input_sha256 TEXT,
    independently_verified INTEGER NOT NULL CHECK (independently_verified IN (0, 1)),
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshot_screening_paper_time
    ON snapshot_screening_run(paper_id, created_at DESC);

CREATE TABLE IF NOT EXISTS snapshot_screening_artifact (
    screening_run_id TEXT NOT NULL REFERENCES snapshot_screening_run(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    byte_count INTEGER NOT NULL CHECK (byte_count > 0),
    PRIMARY KEY (screening_run_id, kind)
);

CREATE VIEW IF NOT EXISTS app_2d_screening_summary AS
SELECT p.id AS paper_id, p.title, r.decision, r.status, r.studio_run_id,
       r.independently_verified, r.input_sha256, r.created_at
FROM paper p
LEFT JOIN snapshot_screening_run r ON r.id = (
    SELECT x.id FROM snapshot_screening_run x WHERE x.paper_id = p.id
    ORDER BY x.created_at DESC, x.id DESC LIMIT 1
);
