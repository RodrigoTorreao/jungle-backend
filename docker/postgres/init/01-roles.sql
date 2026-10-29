-- Cluster-level bootstrap. Runs once, on an empty data volume.
-- wallet_owner: owns the schema and runs migrations.
-- wallet_app:   runtime role, receives only the grants the migrations hand out.
CREATE ROLE wallet_owner LOGIN PASSWORD 'wallet_owner' CREATEDB;
CREATE ROLE wallet_app LOGIN PASSWORD 'wallet_app';

CREATE DATABASE wagering OWNER wallet_owner;
