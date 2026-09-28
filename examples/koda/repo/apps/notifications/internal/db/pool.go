package db

import (
	"database/sql"

	_ "github.com/lib/pq"
)

// Pool owns the connection to the notifications logical database.
func Pool(dsn string) (*sql.DB, error) { return sql.Open("postgres", dsn) }
