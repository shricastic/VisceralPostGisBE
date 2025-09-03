set -e

SERVICE_NAME="postgis-db"
CONTAINER_NAME="postgis-db"
DB_HOST="postgis-db"
DB_PORT="5432"
DB_NAME="test_gis"
DB_USER="postgres"
DB_PASSWORD="postgres"
DUMP_FILE="backup-db/compressed_dump.pgdump"
COMPOSE_FILE="compose.yaml"

cat > $COMPOSE_FILE <<EOF
services:
  $SERVICE_NAME:
    image: postgis/postgis:latest
    container_name: $CONTAINER_NAME
    ports:
      - "5433:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./backup:/backup
    environment:
      POSTGRES_DB: $DB_NAME
      POSTGRES_USER: $DB_USER
      POSTGRES_PASSWORD: $DB_PASSWORD
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $DB_USER"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  postgres_data:
EOF

echo "Docker Compose file created."

docker compose -f $COMPOSE_FILE up -d

echo "Waiting for PostgreSQL to be ready..."
until docker exec "$CONTAINER_NAME" pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER"; do
  echo "Waiting for PostgreSQL to start on $DB_HOST:$DB_PORT..."
  sleep 2
done

echo "PostgreSQL is ready."

docker cp "$DUMP_FILE" "$CONTAINER_NAME":/tmp/compressed_dump.pgdump

echo "Restoring database from $DUMP_FILE into $DB_NAME..."
docker exec -i "$CONTAINER_NAME" pg_restore -U "$DB_USER" -d "$DB_NAME" /tmp/compressed_dump.pgdump

echo "Database restored successfully!"
