#!/bin/bash
set -e

echo "Starting containers..."
docker-compose up -d

echo "Waiting for database to be ready..."
sleep 20  #wait for resource process

echo "Ensuring PostGIS is enabled in the test_gis database..."
docker-compose exec postgis-db psql -U postgres -d test_gis -c "CREATE EXTENSION IF NOT EXISTS postgis;"

echo "Testing PostGIS version..."
docker-compose exec postgis-db psql -U postgres -d test_gis -c "SELECT postgis_version();"

echo "Checking database size..."
docker-compose exec postgis-db psql -U postgres -d test_gis -c "SELECT pg_size_pretty(pg_database_size('test_gis'));"

echo "Checking table count..."
docker-compose exec postgis-db psql -U postgres -d test_gis -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"

echo "Testing a spatial query (adjust table name as needed)..."
docker-compose exec postgis-db psql -U postgres -d test_gis -c "SELECT COUNT(*) FROM spatial_ref_sys;"


echo "Getting Table Names"
docker-compose exec postgis-db psql -U postgres -d test_gis -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public';"



echo "All tests completed successfully!"
