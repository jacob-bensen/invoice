-- One-time bootstrap for a fresh environment. NOT a migration — do not run
-- against an existing database. Creates the `invoice` database and the
-- `invoice_app` role the application connects as.
--
-- Usage:
--   psql -U postgres -f db/init.sql
-- After this completes, run db/schema.sql against the `invoice` database to
-- create the tables.

-- run on postgres
create database invoice;

-- run on invoice database as superuser
create user invoice_app with password 'password'; --replace with actual password
alter user invoice_app with superuser;
grant all privileges on database invoice to invoice_app;
grant create, usage on schema public to invoice_app;
